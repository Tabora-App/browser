/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Пароли сайтов в приложении для телефона. Сами пароли лежат в хранилище паролей приложения (оно
 * же подставляет их на сайтах и в других приложениях); здесь — их слияние с набором logins
 * синхронизации: пароли с компьютера появляются на телефоне, сохранённые на телефоне уходят на
 * компьютер. Правила слияния — merge.js, поведение источника повторяет sync/SyncSources.sys.mjs.
 *
 * У хранилища телефона свои номера паролей, поэтому ведётся таблица «номер записи ↔ номер в
 * хранилище». Одинаковый пароль (тот же сайт и то же имя), сохранённый и там и здесь до
 * синхронизации, остаётся один: с номером записи сервера и более свежим паролем. */

import { uuid } from "../core/bytes.js";
import { loginValid } from "../core/logins.js";
import { mergeCollection } from "./merge.js";
import { pageSetting } from "./tabs.js";

const SETTING = "tabora.sync.passwords";
const STATE = "logins";
const ROUNDS = 4;

const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");

export class Logins {
  /**
   * @param {{ account: import("../core/account.js").Account, sync: import("../core/sync.js").SyncClient,
   *   bridge: import("./bridge.js").Bridge, store: import("./store.js").NativeStore,
   *   settings?: { get(): boolean, set(on: boolean): void } }} deps
   */
  constructor({ account, sync, bridge, store, settings = pageSetting(SETTING) }) {
    this.account = account;
    this.sync = sync;
    this.bridge = bridge;
    this.store = store;
    this.settings = settings;
    this.state = null; // { v, email, gen, shadow, map: { номер записи: номер в хранилище }, hold, allow }
    this.count = 0;
    this.error = "";
  }

  get enabled() {
    return this.settings.get();
  }

  set enabled(on) {
    this.settings.set(!!on);
  }

  /** Пропало разом много паролей: { missing, of } — удаления не отправлены, ждут решения человека. */
  get hold() {
    return this.state?.hold || null;
  }

  /* ---- состояние слияния (лежит у приложения в защищённом хранилище) ---- */

  async _load() {
    if (this.state && this.state.email === this.account.email) {
      return this.state;
    }
    const saved = await this.store.loadData(STATE);
    const ok = saved && saved.v === 1 && saved.email === this.account.email && saved.shadow && typeof saved.shadow === "object" && saved.map && typeof saved.map === "object";
    this.state = ok ? saved : { v: 1, email: this.account.email, gen: null, shadow: {}, map: {}, hold: null, allow: false };
    return this.state;
  }

  async _save() {
    if (this.state) {
      await this.store.saveData(STATE, this.state);
    }
  }

  /** Забыть слияние (выход из аккаунта, выключение): пароли в хранилище телефона остаются. */
  async forget() {
    this.state = null;
    this.count = 0;
    this.error = "";
    try {
      await this.store.clearData(STATE);
    } catch (e) {}
  }

  /* ---- хранилище паролей приложения ---- */

  async _native(type, extra = {}) {
    const r = await this.bridge.call({ type, ...extra }, 30000);
    if (!r || r.error || r.ok === false) {
      throw Object.assign(new Error(r?.error || "хранилище паролей не ответило"), { code: "logins-storage" });
    }
    return r;
  }

  async _all() {
    const r = await this._native("logins-list");
    return Array.isArray(r.logins) ? r.logins.filter(l => l && typeof l.guid === "string" && typeof l.origin === "string" && typeof l.password === "string" && l.password) : [];
  }

  _source(state) {
    const idOf = guid => Object.keys(state.map).find(id => state.map[id] === guid) || "";
    const dataOf = (id, l) => ({
      g: `{${id}}`, o: l.origin, f: l.formActionOrigin ?? null, r: l.httpRealm ?? null, u: l.username || "", p: l.password,
      uf: l.usernameField || "", pf: l.passwordField || "", c: Number(l.created) || 0, t: Number(l.changed) || 0,
    });
    // у пароля формы область входа пуста, у HTTP-входа пуст адрес формы: ровно одно из двух
    const usable = l => (l.formActionOrigin ?? null) === null !== ((l.httpRealm ?? null) === null);
    // тот же пароль: сайт, имя и вид входа (адрес формы у компьютера и телефона может записываться по-разному)
    const same = (l, d) => l.origin === d.o && (l.username || "") === d.u && ((l.httpRealm ?? null) === null) === (d.r === null) && (d.r === null || l.httpRealm === d.r);
    const entry = d => ({ origin: d.o, formActionOrigin: d.f, httpRealm: d.r, username: d.u, password: d.p, usernameField: str(d.uf, 200), passwordField: str(d.pf, 200) });
    return {
      hashable: d => ({ o: d.o, r: d.r, u: d.u, p: d.p, form: d.f !== null }),
      newer: (a, b) => (a.t || 0) > (b.t || 0),

      list: async () => {
        const out = new Map();
        for (const l of await this._all()) {
          if (!usable(l)) {
            continue;
          }
          let id = idOf(l.guid);
          if (!id) {
            id = uuid(); // пароль сохранён на телефоне: записи даётся новый номер
            state.map[id] = l.guid;
          }
          out.set(id, dataOf(id, l));
        }
        return out;
      },

      apply: async changes => {
        const byGuid = new Map((await this._all()).map(l => [l.guid, l]));
        const dirty = [];
        for (const { id, data } of changes) {
          try {
            const guid = state.map[id];
            const cur = guid ? byGuid.get(guid) : null;
            if (!data) {
              if (cur) {
                await this._native("logins-delete", { guid });
                byGuid.delete(guid);
              }
              delete state.map[id];
              continue;
            }
            if (!loginValid(id, data)) {
              continue;
            }
            if (cur && same(cur, data)) {
              if (cur.password !== data.p) {
                await this._native("logins-update", { guid, entry: entry(data) });
              }
              continue;
            }
            if (cur) {
              // тот же номер, другой сайт или имя: запись заменяется
              await this._native("logins-delete", { guid });
              byGuid.delete(guid);
              delete state.map[id];
            }
            // тот же сайт и то же имя, сохранённые и там и здесь до синхронизации: остаётся одна запись
            // с номером сервера и более свежим паролем
            const twin = [...byGuid.values()].find(l => usable(l) && same(l, data));
            if (twin) {
              const old = idOf(twin.guid);
              if (old) {
                delete state.map[old]; // прежний номер этой записи исчезнет и с сервера
              }
              state.map[id] = twin.guid;
              if (twin.password !== data.p) {
                if ((Number(twin.changed) || 0) > (Number(data.t) || 0)) {
                  dirty.push(id); // здешний пароль свежее: он уйдёт на сервер под номером записи
                } else {
                  await this._native("logins-update", { guid: twin.guid, entry: entry(data) });
                }
              }
              continue;
            }
            const added = await this._native("logins-add", { entry: entry(data) });
            if (typeof added.guid === "string" && added.guid) {
              state.map[id] = added.guid;
              byGuid.set(added.guid, { guid: added.guid, origin: data.o, formActionOrigin: data.f, httpRealm: data.r, username: data.u, password: data.p });
            }
          } catch (e) {
            console.error(`Tabora: пароль ${id} не применён`, e);
          }
        }
        return { dirty };
      },
    };
  }

  /* ---- слияние ---- */

  /** Слить пароли телефона с сервером. Клиент синхронизации уже должен быть сверен (sync.refresh). */
  async merge() {
    if (!this.enabled || !this.account.signedIn || !this.sync.loaded) {
      return false;
    }
    const state = await this._load();
    if (state.gen !== this.sync.gen) {
      // данные на сервере начаты заново: прежняя тень к ним не относится, сливаем как в первый раз
      state.shadow = {};
      state.hold = null;
      state.allow = false;
      state.gen = this.sync.gen;
    }
    const src = this._source(state);
    try {
      for (let round = 0; round < ROUNDS; round++) {
        const result = await mergeCollection({ sync: this.sync, name: "logins", src, state });
        await this._save();
        if (result.clean) {
          break;
        }
        await this.sync.refresh();
      }
      this.count = (await src.list()).size;
      this.error = "";
      return true;
    } catch (e) {
      await this._save().catch(() => {});
      this.error = e.message || String(e);
      throw e;
    }
  }

  /**
   * Что делать с паролями, пропавшими с телефона разом: "delete" — удалить их и на остальных
   * устройствах, "restore" — вернуть их на телефон с сервера.
   */
  async resolveHold(what) {
    const state = await this._load();
    if (!state.hold) {
      return;
    }
    if (what === "delete") {
      state.allow = true;
    } else {
      const local = await this._source(state).list();
      for (const id of Object.keys(state.shadow)) {
        if (state.shadow[id][1] && state.shadow[id][1] !== "!" && !local.has(id)) {
          delete state.shadow[id]; // запись придёт с сервера как новая
          delete state.map[id];
        }
      }
    }
    state.hold = null;
    await this._save();
  }
}
