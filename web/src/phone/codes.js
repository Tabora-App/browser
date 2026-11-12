/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Коды входа (второй шаг на сайтах) в приложении для телефона. Записи — набор otp синхронизации:
 * те же, что в сейфе браузера на компьютере. Код считается здесь из секрета записи; секрет наружу
 * (экрану, странице сайта) не отдаётся — только готовый код. */

import { matchHost, newOtp, normalizeSites, otpValid } from "../core/codes.js";
import { base32Decode, totp } from "../core/otp.js";
import { t } from "../core/i18n.js";
import { pageSetting } from "./tabs.js";

const SETTING = "tabora.sync.codes";

function fail(message, code) {
  return Object.assign(new Error(message), { code });
}

export class Codes {
  /**
   * @param {{ account: import("../core/account.js").Account, sync: import("../core/sync.js").SyncClient,
   *   settings?: { get(): boolean, set(on: boolean): void } }} deps
   */
  constructor({ account, sync, settings = pageSetting(SETTING) }) {
    this.account = account;
    this.sync = sync;
    this.settings = settings;
    this._secrets = new Map(); // номер записи → { s: строка секрета, bytes }
  }

  get enabled() {
    return this.settings.get();
  }

  set enabled(on) {
    this.settings.set(!!on);
    if (!on) {
      this.forget();
    }
  }

  /** Стереть разобранные секреты из памяти (выход, выключение). */
  forget() {
    for (const v of this._secrets.values()) {
      v.bytes.fill(0);
    }
    this._secrets.clear();
  }

  _records() {
    return this.enabled && this.account.signedIn ? this.sync.list("otp").filter(o => otpValid(o.data)) : [];
  }

  /** Записи для экрана, без секретов: [{ id, issuer, account, period, digits, sites }]. */
  list() {
    return this._records()
      .map(({ id, data }) => ({ id, issuer: String(data.i || ""), account: String(data.a || ""), period: data.p, digits: data.d, sites: (data.w || []).map(w => ({ host: w.host, sub: !!w.sub })) }))
      .sort((a, b) => (a.issuer || a.account).localeCompare(b.issuer || b.account) || a.account.localeCompare(b.account));
  }

  /** Записи, привязанные к хосту страницы: сначала точные совпадения. */
  forHost(host) {
    const out = [];
    for (const { id, data } of this._records()) {
      const match = matchHost(data, host);
      if (match) {
        out.push({ id, issuer: String(data.i || ""), account: String(data.a || ""), match });
      }
    }
    return out.sort((a, b) => (a.match === b.match ? 0 : a.match === "exact" ? -1 : 1) || (a.issuer || a.account).localeCompare(b.issuer || b.account));
  }

  /** Код записи на сейчас: { code, left } — left: сколько секунд он ещё действует. */
  async code(id, now = Date.now()) {
    const data = this._records().find(o => o.id === id)?.data;
    if (!data) {
      throw fail(t`Кода больше нет в списке`, "no-code");
    }
    let secret = this._secrets.get(id);
    if (!secret || secret.s !== data.s) {
      secret = { s: data.s, bytes: base32Decode(data.s) };
      this._secrets.set(id, secret);
    }
    const code = await totp(secret.bytes, { algorithm: data.al, digits: data.d, period: data.p, now });
    return { code, left: data.p - ((now / 1000) % data.p) };
  }

  /** Добавить записи (из формы, ссылки, файла). Уже имеющиеся пропускаются. Возвращает число добавленных. */
  async add(entries) {
    const existing = new Set(this.sync.list("otp").map(o => `${o.data.i}|${o.data.a}|${o.data.s}`));
    const changes = [];
    for (const e of entries) {
      const made = await newOtp(e);
      const key = `${made.data.i}|${made.data.a}|${made.data.s}`;
      if (!existing.has(key)) {
        existing.add(key);
        // номера записей строятся от времени: разносим, чтобы не совпали
        changes.push({ c: "otp", id: `${made.id}${changes.length.toString(36)}`.slice(0, 40), data: made.data });
      }
    }
    if (changes.length) {
      await this.sync.write(changes);
    }
    return changes.length;
  }

  /** Изменить название, аккаунт и сайты записи. Секрет и параметры кода не меняются. */
  async edit(id, { issuer, account, sites }) {
    const old = this.sync.get("otp", id);
    if (!old) {
      throw fail(t`Кода больше нет в списке`, "no-code");
    }
    const i = String(issuer || "").trim().slice(0, 48);
    const a = String(account || "").trim().slice(0, 96);
    if (!i && !a) {
      throw fail(t`Укажите сервис или аккаунт`, "bad-code");
    }
    // разрешение на поддомены сохраняется за теми сайтами, у которых оно было
    const sub = new Map((old.w || []).map(w => [w.host, !!w.sub]));
    const w = normalizeSites(sites).map(x => ({ host: x.host, sub: !!sub.get(x.host) }));
    await this.sync.put("otp", id, { ...old, i, a, w });
  }

  async remove(id) {
    await this.sync.remove("otp", id);
    this._secrets.get(id)?.bytes.fill(0);
    this._secrets.delete(id);
  }
}
