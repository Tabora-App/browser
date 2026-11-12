/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Аккаунт Tabora в веб-версии: вход, сессия и ключи.
 *
 * Что где живёт. Пароль не покидает страницу: из него выводятся хеш входа (уходит на сервер) и
 * ключ обёртки (остаётся здесь). Ключом обёртки открывается ключ данных аккаунта — 32 байта,
 * одни на все устройства; его копия лежит на сервере завёрнутой, и сервер прочитать её не может.
 * Ключом данных открываются закрытый ключ почты (OpenPGP) и всё, что синхронизируется: пароли
 * сайтов, коды входа, закладки. Формат обёрток — тот же, что в браузере (mail/Pgp.sys.mjs).
 *
 * Состояние ключей (keys.state):
 *   "ok"      — ключ данных открыт: работает всё;
 *   "locked"  — у аккаунта есть ключ, но открыть его здесь нечем (копия не привязана к нынешнему
 *               паролю): почта читается, зашифрованные письма и пароли — нет, пока пользователь
 *               не введёт ключ восстановления или прежний пароль;
 *   "offline" — сервер не ответил, повторим позже. */

import { b64, open, random, randomId, same, seal, text, tryB64, utf8, wipe } from "./bytes.js";
import { KDF_CURRENT, passwordKeys } from "./kdf.js";
import { pairClaim, pairKeys, pairLink, pairOpen, pairParse, pairSeal, pairSecrets } from "./pair.js";
import { checkNewPassword } from "./password.js";
import { armorBody, pgpCall } from "./pgp.js";
import { rkNew, rkSignReset, rkVerifier, rkWrapKey } from "./recovery.js";
import { t } from "./i18n.js";

const PENDING_TTL = 3 * 60 * 1000;
const PAIR_POLL = 1500;
const PAIR_LIFE = 200000; // обмен на сервере живёт три минуты; небольшой запас на дорогу
const pause = ms => new Promise(done => setTimeout(done, ms));
const ARMOR_RE = /-----BEGIN PGP PUBLIC KEY BLOCK-----[\s\S]+-----END PGP PUBLIC KEY BLOCK-----/;

function fail(message, code, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

const labels = address => ({
  pw: `tabora-mail-keys/wrap-password/v1|${address}`,
  rk: `tabora-mail-keys/wrap-recovery/v1|${address}`,
  blob: fp => `tabora-mail-keys/blob/v1|${address}|${fp}`,
});

/** Название устройства для списка «Устройства»: что за браузер и на чём. */
export function deviceLabel(ua = typeof navigator === "object" ? navigator.userAgent : "") {
  const os = /iPhone|iPod/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  const app = /Tabora\//.test(ua) ? "Tabora" : /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /YaBrowser/.test(ua) ? t`Яндекс Браузер` : /Firefox\/|FxiOS/.test(ua) ? "Firefox" : /Chrome\/|CriOS/.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  return [t`Веб-версия`, [app, os].filter(Boolean).join(", ")].filter(Boolean).join(": ").slice(0, 64);
}

export class Account {
  /**
   * @param {{ api: import("./api.js").Api, store: { load(): Promise<object|null>, save(data: object): Promise<void>, clear(): Promise<void>, deviceId(): string }, domain?: string, deviceName?: () => string }} deps
   *   deviceName — как устройство называется в списке «Устройства» и в письмах о входе; у веб-версии
   *   это название браузера, приложение для телефона подставляет имя телефона.
   */
  constructor({ api, store, domain = "tabora.app", deviceName = deviceLabel }) {
    this.api = api;
    this.store = store;
    this.domain = domain;
    this.deviceName = () => String(deviceName() || "").slice(0, 64);
    this.session = null; // { email, userId, token, expiresAt, kdf, mail }
    this.keys = { state: "none" }; // { state, fingerprint, publicKey, privateKey, dataKey, canPassword, canRecovery, reason }
    this._pending = null; // ключи из пароля, пока вход ждёт кода второго фактора
    this._listeners = new Set();
    this.onStep = null; // (текст) => void: что сейчас происходит, для кнопки
    api.onExpired = token => {
      if (this.session?.token === token) {
        this._drop("expired");
      }
    };
  }

  /* ---- подписка ---- */

  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit(what) {
    for (const fn of [...this._listeners]) {
      try {
        fn(what);
      } catch (e) {
        console.error(e);
      }
    }
  }

  _step(textLine) {
    try {
      this.onStep?.(textLine);
    } catch (e) {}
  }

  get signedIn() {
    return !!this.session?.token;
  }

  get email() {
    return this.session?.email || "";
  }

  get token() {
    if (!this.session?.token) {
      throw fail(t`Войдите в аккаунт`, "signed-out");
    }
    return this.session.token;
  }

  normalizeEmail(input) {
    let s = String(input || "").trim().toLowerCase();
    if (s.includes("@")) {
      const [name, dom] = s.split("@");
      if (dom !== this.domain) {
        throw fail(t`Адрес должен быть в домене ${this.domain}`, "bad-email");
      }
      s = name;
    }
    if (!/^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])?$/.test(s) || /[._-]{2}/.test(s)) {
      throw fail(t`Имя: 3–32 символа, латиница, цифры, точка, дефис или подчёркивание`, "bad-email");
    }
    return `${s}@${this.domain}`;
  }

  /* ---- запуск: вернуть сохранённую сессию ---- */

  async restore() {
    let saved = null;
    try {
      saved = await this.store.load();
    } catch (e) {}
    if (!saved?.token || !saved.email) {
      return false;
    }
    this.session = { email: saved.email, userId: saved.userId, token: saved.token, expiresAt: saved.expiresAt, kdf: saved.kdf, mail: saved.mail || null };
    const dataKey = tryB64(saved.dataKey);
    this.keys = { state: dataKey ? "offline" : "locked", dataKey };
    this._emit("signed-in");
    // закрытый ключ почты не хранится: он заново открывается копией с сервера
    this.refreshKeys().catch(() => {});
    return true;
  }

  async _persist() {
    if (!this.session) {
      return;
    }
    const s = this.session;
    try {
      await this.store.save({ email: s.email, userId: s.userId, token: s.token, expiresAt: s.expiresAt, kdf: s.kdf, mail: s.mail, dataKey: this.keys.dataKey ? b64(this.keys.dataKey) : null });
    } catch (e) {
      console.error("Tabora: сессия не сохранена", e);
    }
  }

  async _drop(why) {
    wipe(this.keys?.dataKey);
    this.session = null;
    this.keys = { state: "none" };
    this._pending = null;
    this._held = false;
    try {
      await this.store.clear();
    } catch (e) {}
    this._emit(why === "expired" ? "expired" : "signed-out");
  }

  /* ---- вход ---- */

  async _derive(email, password, kdf) {
    this._step(t`Проверяем пароль`);
    return passwordKeys(email, password, kdf);
  }

  /**
   * Вход. Если у аккаунта включена двухфакторная защита, первый вызов закончится ошибкой с кодом
   * "2fa-required": интерфейс спрашивает код и вызывает signIn ещё раз с тем же адресом и totp —
   * пароль повторно не нужен (ключи из него ждут в памяти три минуты).
   */
  async signIn(nameOrEmail, password, { totp = "", hold = false } = {}) {
    const email = this.normalizeEmail(nameOrEmail);
    let p = this._pending;
    if (!p || p.email !== email || Date.now() - p.at > PENDING_TTL || password) {
      if (!password) {
        throw fail(t`Введите пароль`, "bad-credentials");
      }
      this._forgetPending();
      const kdf = await this.api.prelogin(email);
      const k = await this._derive(email, password, kdf);
      p = this._pending = { email, kdf, loginHash: k.loginHash, wrapKey: k.wrapKey, at: Date.now() };
    }
    this._step(t`Входим`);
    let r;
    try {
      r = await this.api.login({ email, loginHash: p.loginHash, deviceId: this.store.deviceId(), deviceName: this.deviceName(), mailAccess: "session", ...(totp ? { totp: String(totp).replace(/\s+/g, "") } : {}) });
    } catch (e) {
      if (e.code !== "2fa-required" && e.code !== "bad-2fa") {
        this._forgetPending();
      }
      throw e;
    }
    await this._enter(email, r, p, hold);
    return { email };
  }

  _forgetPending() {
    if (this._pending) {
      wipe(this._pending.wrapKey);
      this._pending = null;
    }
  }

  /** Интерфейс узнаёт о входе событием "signed-in". hold откладывает его до release(): экрану
   * входа ещё есть что показать (ключ восстановления), а приложение уже открылось бы поверх. */
  release() {
    if (this._held) {
      this._held = false;
      this._emit("signed-in");
    }
  }

  _entered(hold) {
    if (hold) {
      this._held = true;
    } else {
      this._emit("signed-in");
    }
  }

  async _enter(email, r, p, hold = false) {
    if (!r?.session?.token) {
      throw fail(t`Сервер Tabora ответил непонятно. Повторите позже`, "bad-response");
    }
    this.session = { email, userId: r.userId, token: r.session.token, expiresAt: r.session.expiresAt, kdf: r.kdf || p.kdf, mail: r.mail || null };
    this.keys = { state: "offline" };
    this._step(t`Открываем ключи`);
    try {
      await this._openKeys({ wrapKey: p.wrapKey, loginHash: p.loginHash, create: true });
    } catch (e) {
      console.error("Tabora: ключи аккаунта не открыты", e);
      if (this.keys.state !== "locked") {
        this.keys = { state: "offline" };
      }
    } finally {
      this._forgetPending();
    }
    await this._persist();
    this._entered(hold);
  }

  /* ---- вход по QR-коду (порядок обмена — server/src/pair.rs, шифрование — pair.js) ---- */

  /**
   * Новое устройство считало QR-код с устройства, где человек уже вошёл. Возвращает код сверки
   * (тот же показан там) и wait(): она ждёт, пока вход разрешат, и отдаёт адрес аккаунта с двумя
   * действиями — enter() входит, decline() отказывается, и выданная сессия тут же завершается.
   * Адрес показывают человеку до входа: подсунутый чужой код ввёл бы его в чужой аккаунт.
   */
  async pairJoin(qrText) {
    const offer = pairParse(qrText);
    if (!offer) {
      throw fail(t`Это не код входа Tabora. Код для входа показывает Tabora на компьютере: «Настройки → Аккаунт → Синхронизация → Войти на телефоне»`, "pair-invalid");
    }
    const mine = await pairKeys();
    const { secret, claim } = await pairClaim();
    const secrets = await pairSecrets(mine.privateKey, offer.public, { id: offer.id, starter: offer.public, joiner: mine.public });
    try {
      await this.api.pairJoin({ id: offer.id, public: mine.public, claim, deviceId: this.store.deviceId(), deviceName: this.deviceName() });
    } catch (e) {
      if (e.status === 404 && e.code !== "pair-gone") {
        // сервер старше приложения: адреса входа по коду на нём ещё нет
        throw fail(t`Сервер Tabora пока не умеет вход по коду: это появится после его обновления. Повторите позже.`, "unsupported");
      }
      throw e;
    }
    let stopped = false;
    const wait = async () => {
      const until = Date.now() + PAIR_LIFE;
      for (;;) {
        if (stopped) {
          throw fail(t`Вход отменён`, "pair-cancelled");
        }
        let r = null;
        try {
          r = await this.api.pairPoll({ id: offer.id, secret });
        } catch (e) {
          if (e.code !== "offline" || Date.now() > until) {
            throw e;
          }
        }
        if (r?.state === "approved") {
          return this._paired(offer.id, secrets.key, r);
        }
        if (Date.now() > until) {
          throw fail(t`Код для входа устарел. Покажите новый на устройстве, где вы уже вошли`, "pair-gone");
        }
        await pause(PAIR_POLL);
      }
    };
    return { code: secrets.code, wait, cancel: () => (stopped = true) };
  }

  async _paired(id, key, r) {
    const token = r.session?.token;
    const email = typeof r.email === "string" ? r.email : "";
    const data = token && email.endsWith(`@${this.domain}`) ? await pairOpen(key, id, r.payload) : null;
    wipe(key);
    const decline = async () => {
      if (token) {
        await this.api.logout(token).catch(() => {});
      }
    };
    if (!data) {
      // ответ зашифрован не тем устройством, чей код считан: входить по нему нельзя
      await decline();
      throw fail(t`Не удалось проверить устройство, которое разрешило вход. Покажите код заново и повторите`, "pair-broken");
    }
    const dataKey = tryB64(data.dataKey);
    return {
      email,
      decline: async () => {
        wipe(dataKey);
        await decline();
      },
      enter: async () => {
        this.session = { email, userId: r.userId, token, expiresAt: r.session.expiresAt, kdf: r.kdf || KDF_CURRENT, mail: r.mail || null };
        this.keys = { state: "offline" };
        this._step(t`Открываем ключи`);
        try {
          await this._openKeys({ dataKey: dataKey?.length === 32 ? dataKey : null });
        } catch (e) {
          console.error("Tabora: ключи аккаунта не открыты", e);
          if (this.keys.state !== "locked") {
            this.keys = { state: "offline" };
          }
        }
        await this._persist();
        this._entered(false);
        return { email };
      },
    };
  }

  /**
   * Устройство, где человек уже вошёл, показывает QR-код: link — его текст. joined() ждёт, пока
   * новое устройство считает код, и отдаёт его имя, код сверки и два действия: approve() разрешает
   * вход и передаёт ключ данных аккаунта, deny() отклоняет.
   */
  async pairOffer() {
    const token = this.token;
    const mine = await pairKeys();
    const { id, expiresAt } = await this.api.pairStart(token);
    let stopped = false;
    const joined = async () => {
      for (;;) {
        if (stopped) {
          throw fail(t`Вход отменён`, "pair-cancelled");
        }
        let r = null;
        try {
          r = await this.api.pairStatus(token, id);
        } catch (e) {
          if (e.code !== "offline") {
            throw e;
          }
        }
        if (r?.state === "joined" && typeof r.public === "string") {
          const secrets = await pairSecrets(mine.privateKey, r.public, { id, starter: mine.public, joiner: r.public });
          return {
            deviceName: String(r.deviceName || "").slice(0, 64),
            code: secrets.code,
            approve: async () => {
              const dataKey = this.keys.state === "ok" && this.keys.dataKey ? b64(this.keys.dataKey) : null;
              await this.api.pairApprove(token, id, await pairSeal(secrets.key, id, { dataKey }));
              wipe(secrets.key);
            },
            deny: async () => {
              wipe(secrets.key);
              await this.api.pairDeny(token, id).catch(() => {});
            },
          };
        }
        await pause(PAIR_POLL);
      }
    };
    const cancel = () => {
      stopped = true;
      this.api.pairDeny(token, id).catch(() => {});
    };
    return { link: pairLink(id, mine.public), expiresAt, joined, cancel };
  }

  async signOut() {
    const token = this.session?.token;
    if (token) {
      try {
        await this.api.logout(token);
      } catch (e) {
        // сервер недоступен: сессия на нём доживёт до срока, но с этого устройства она стирается
      }
    }
    await this._drop("signed-out");
  }

  /* ---- ключи ---- */

  _usable(info, address) {
    const ok = info && /^[0-9a-f]{40,64}$/.test(info.fingerprint || "") && Array.isArray(info.emails) && typeof info.armored === "string" && ARMOR_RE.test(info.armored);
    if (!ok) {
      throw fail(t`Ключ не разобран`, "pgp");
    }
    if (info.revoked || info.expired || !info.canEncrypt) {
      throw fail(t`Ключ аккаунта непригоден: отозван, просрочен или не для шифрования`, "pgp");
    }
    if (address && info.emails.length && !info.emails.includes(address)) {
      throw fail(t`Ключ выпущен для другого адреса`, "pgp");
    }
    return info;
  }

  /**
   * Сверить ключи с сервером. wrapKey и loginHash — ключ обёртки и хеш входа, когда пароль только
   * что подтверждён; recoveryKey — ключ из ключа восстановления; dataKey — уже известный ключ
   * данных (сохранённая сессия); create — если у аккаунта ключа ещё нет, создать его.
   */
  async _openKeys({ wrapKey = null, loginHash = "", recoveryKey = null, dataKey = null, create = false } = {}) {
    const address = this.email;
    const L = labels(address);
    const token = this.token;
    for (let attempt = 0; attempt < 4; attempt++) {
      const remote = await this.api.mailKeys(token);
      if (!remote || !Number.isInteger(remote.rev)) {
        throw fail(t`Сервер Tabora ответил непонятно. Повторите позже`, "bad-response");
      }
      const wrapPw = tryB64(remote.wrapPassword);
      const wrapRk = tryB64(remote.wrapRecovery);
      const blob = tryB64(remote.blob);
      const fp = /^[0-9a-f]{40,64}$/.test(remote.fingerprint || "") ? remote.fingerprint : "";
      const put = { rev: remote.rev };
      let key = null;
      let privateKey = "";
      let publicKey = "";
      let fromPw = null;
      let fromRk = null;

      if (fp && blob) {
        fromPw = await open(wrapKey, L.pw, wrapPw);
        fromRk = await open(recoveryKey, L.rk, wrapRk);
        for (const candidate of [fromPw, fromRk, dataKey]) {
          const secret = candidate && (await open(candidate, L.blob(fp), blob));
          if (secret) {
            key = candidate;
            privateKey = text(secret);
            wipe(secret);
            break;
          }
        }
        if (!key) {
          wipe(fromPw, fromRk);
          this.keys = { state: "locked", fingerprint: fp, canPassword: !!wrapPw, canRecovery: !!wrapRk, reason: wrapPw ? "wrong-wrap" : "no-wrap" };
          this._emit("keys");
          return this.keys;
        }
        const { keys } = await pgpCall("info", { armored: privateKey });
        const info = this._usable(keys?.[0], address);
        if (!info.private || info.fingerprint !== fp) {
          throw fail(t`Копия ключа на сервере повреждена`, "pgp");
        }
        publicKey = info.armored;
        // обёртка паролем: ставится заново, если ключ вернули ключом восстановления или её не было
        if (wrapKey && loginHash && !same(fromPw, key)) {
          put.wrapPassword = b64(await seal(wrapKey, L.pw, key));
          put.loginHash = loginHash;
        }
        if (recoveryKey && !same(fromRk, key)) {
          put.wrapRecovery = b64(await seal(recoveryKey, L.rk, key));
        }
      } else {
        if (!create || !wrapKey || !loginHash) {
          this.keys = { state: "locked", fingerprint: "", canPassword: false, canRecovery: false, reason: "no-key" };
          this._emit("keys");
          return this.keys;
        }
        // у аккаунта ключа ещё нет: создаём здесь
        this._step(t`Создаём ключ шифрования`);
        const made = await pgpCall("generate", { email: address });
        const info = this._usable(made.info, address);
        if (typeof made.privateKey !== "string" || !made.privateKey.includes("PRIVATE KEY BLOCK")) {
          throw fail(t`Ключ не создан`, "pgp");
        }
        key = dataKey || random(32);
        privateKey = made.privateKey;
        publicKey = info.armored;
        put.fingerprint = info.fingerprint;
        put.publicKey = armorBody(info.armored);
        put.blob = b64(await seal(key, L.blob(info.fingerprint), utf8(privateKey)));
        put.wrapPassword = b64(await seal(wrapKey, L.pw, key));
        put.loginHash = loginHash;
        if (recoveryKey) {
          put.wrapRecovery = b64(await seal(recoveryKey, L.rk, key));
        }
      }

      let saved = remote;
      if (Object.keys(put).length > 1) {
        try {
          saved = await this.api.mailKeysSave(token, put);
        } catch (e) {
          if (e.code === "pgp-conflict") {
            continue; // запись изменили с другого устройства: читаем заново
          }
          if (!(fp && blob)) {
            throw e; // новый ключ не сохранён: пользоваться им нельзя
          }
          // обёртку обновить не удалось: ключ всё равно открыт, обёртка обновится при следующем входе
        }
      }
      const own = key.slice();
      wipe(fromPw, fromRk); // key мог быть одним из них: копия снята строкой выше
      this.keys = {
        state: "ok", fingerprint: saved.fingerprint || fp, publicKey, privateKey, dataKey: own,
        canPassword: !!saved.wrapPassword, canRecovery: !!saved.wrapRecovery,
      };
      this._emit("keys");
      return this.keys;
    }
    throw fail(t`Ключи аккаунта сейчас меняются на другом устройстве. Повторите через минуту`, "pgp-conflict");
  }

  /** После перезагрузки страницы: ключ данных есть, закрытый ключ почты берём с сервера заново. */
  async refreshKeys() {
    if (!this.signedIn) {
      return this.keys;
    }
    const dataKey = this.keys.dataKey || null;
    try {
      const k = await this._openKeys({ dataKey });
      await this._persist();
      return k;
    } catch (e) {
      if (e.code === "session-expired" || e.code === "signed-out") {
        return this.keys;
      }
      if (this.keys.state !== "locked") {
        this.keys = { ...this.keys, state: "offline", dataKey };
      }
      this._emit("keys");
      return this.keys;
    }
  }

  /** Открыть ключи ключом восстановления; с паролем копия заодно привязывается к нему. */
  async unlockWithRecovery(recoveryText, password = "") {
    const rk = rkWrapKey(recoveryText);
    let k = null;
    try {
      if (password) {
        k = await this._derive(this.email, password, this.session.kdf || KDF_CURRENT);
      }
      const keys = await this._openKeys({ recoveryKey: rk, wrapKey: k?.wrapKey || null, loginHash: k?.loginHash || "" });
      if (keys.state !== "ok") {
        throw fail(t`Этот ключ восстановления к аккаунту не подходит`, "wrong-wrap");
      }
      await this._persist();
      return keys;
    } finally {
      wipe(rk, k?.wrapKey);
    }
  }

  /** Открыть ключи прежним паролем (пароль сменили сбросом по письму) и привязать их к нынешнему. */
  async unlockWithOldPassword(oldPassword, password) {
    const kdf = this.session.kdf || KDF_CURRENT;
    const old = await this._derive(this.email, oldPassword, kdf);
    let now = null;
    try {
      const remote = await this.api.mailKeys(this.token);
      const L = labels(this.email);
      const dataKey = await open(old.wrapKey, L.pw, tryB64(remote.wrapPassword));
      if (!dataKey) {
        throw fail(t`Прежний пароль не подходит к копии ключа`, "wrong-wrap");
      }
      now = await this._derive(this.email, password, kdf);
      const keys = await this._openKeys({ dataKey, wrapKey: now.wrapKey, loginHash: now.loginHash });
      if (keys.state !== "ok") {
        throw fail(t`Прежний пароль не подходит к копии ключа`, "wrong-wrap");
      }
      // _openKeys сам ставит обёртку нынешним паролем: ключ открыт не ею
      wipe(dataKey);
      await this._persist();
      return this.keys;
    } finally {
      wipe(old.wrapKey, now?.wrapKey);
    }
  }

  /** Повторная проверка пароля для чувствительных настроек: хеш входа (пароль не сохраняется). */
  async loginHashFor(password) {
    if (!password) {
      throw fail(t`Введите пароль`, "bad-credentials");
    }
    const k = await this._derive(this.email, password, this.session.kdf || KDF_CURRENT);
    wipe(k.wrapKey);
    return k.loginHash;
  }

  /* ---- регистрация ---- */

  async register(name, password, { hold = false } = {}) {
    const email = this.normalizeEmail(name);
    checkNewPassword(password);
    if (!(await this.api.available(email))) {
      throw fail(t`Это имя уже занято`, "taken");
    }
    const k = await this._derive(email, password, KDF_CURRENT);
    try {
      this._step(t`Создаём аккаунт`);
      const r = await this.api.register({ email, loginHash: k.loginHash, kdf: KDF_CURRENT, deviceId: this.store.deviceId(), deviceName: this.deviceName(), mailAccess: "session" });
      this.session = { email, userId: r.userId, token: r.session.token, expiresAt: r.session.expiresAt, kdf: KDF_CURRENT, mail: r.mail || null };
      this.keys = { state: "offline" };
      // ключ восстановления: единственный способ вернуть данные, если пароль забыт
      const recoveryKey = rkNew();
      const rkKey = rkWrapKey(recoveryKey);
      try {
        await this._openKeys({ wrapKey: k.wrapKey, loginHash: k.loginHash, recoveryKey: rkKey, create: true });
        this._step(t`Создаём ключ восстановления`);
        await this.api.setRecovery(this.token, rkVerifier(recoveryKey));
      } finally {
        wipe(rkKey);
      }
      await this._persist();
      this._entered(hold);
      return { email, recoveryKey };
    } finally {
      wipe(k.wrapKey);
    }
  }

  /** Новый ключ восстановления взамен прежнего (прежний перестаёт действовать). */
  async newRecoveryKey() {
    if (this.keys.state !== "ok") {
      throw fail(t`Сначала откройте ключи аккаунта`, "locked");
    }
    const recoveryKey = rkNew();
    const rkKey = rkWrapKey(recoveryKey);
    try {
      const L = labels(this.email);
      for (let attempt = 0; attempt < 3; attempt++) {
        const remote = await this.api.mailKeys(this.token);
        try {
          await this.api.mailKeysSave(this.token, { rev: remote.rev, wrapRecovery: b64(await seal(rkKey, L.rk, this.keys.dataKey)) });
          break;
        } catch (e) {
          if (e.code !== "pgp-conflict" || attempt === 2) {
            throw e;
          }
        }
      }
      await this.api.setRecovery(this.token, rkVerifier(recoveryKey));
      this.keys.canRecovery = true;
      this._emit("keys");
      return recoveryKey;
    } finally {
      wipe(rkKey);
    }
  }

  /* ---- смена и сброс пароля ---- */

  async changePassword(oldPassword, newPassword) {
    checkNewPassword(newPassword);
    const kdf = this.session.kdf || KDF_CURRENT;
    const old = await this._derive(this.email, oldPassword, kdf);
    let now = null;
    try {
      now = await this._derive(this.email, newPassword, KDF_CURRENT);
      this._step(t`Меняем пароль`);
      await this.api.changePassword(this.token, { oldLoginHash: old.loginHash, newLoginHash: now.loginHash, kdf: KDF_CURRENT });
      this.session.kdf = KDF_CURRENT;
      // копия ключа данных привязывается к новому паролю; если ключ здесь закрыт, прежний пароль его откроет
      let dataKey = this.keys.dataKey || null;
      const L = labels(this.email);
      for (let attempt = 0; attempt < 3; attempt++) {
        const remote = await this.api.mailKeys(this.token);
        dataKey ||= await open(old.wrapKey, L.pw, tryB64(remote.wrapPassword));
        if (!dataKey) {
          break;
        }
        try {
          await this.api.mailKeysSave(this.token, { rev: remote.rev, wrapPassword: b64(await seal(now.wrapKey, L.pw, dataKey)), loginHash: now.loginHash });
          break;
        } catch (e) {
          if (e.code !== "pgp-conflict" || attempt === 2) {
            throw e;
          }
        }
      }
      if (dataKey && this.keys.state !== "ok") {
        await this._openKeys({ dataKey });
      }
      await this._persist();
      this._emit("keys");
    } finally {
      wipe(old.wrapKey, now?.wrapKey);
    }
  }

  /** Сброс пароля ключом восстановления: возвращает и аккаунт, и данные. После него — обычный вход. */
  async resetWithRecovery(nameOrEmail, recoveryText, newPassword) {
    const email = this.normalizeEmail(nameOrEmail);
    checkNewPassword(newPassword);
    rkVerifier(recoveryText); // проверка формата до тяжёлых расчётов
    const k = await this._derive(email, newPassword, KDF_CURRENT);
    try {
      this._step(t`Меняем пароль`);
      const { nonce } = await this.api.resetChallenge(email);
      const r = await this.api.reset({ email, nonce, recoveryProof: rkSignReset(recoveryText, email, k.loginHash, nonce), newLoginHash: k.loginHash, kdf: KDF_CURRENT });
      return { email, twoFactorDisabled: !!r?.twoFactorDisabled };
    } finally {
      wipe(k.wrapKey);
    }
  }

  /** Сброс по письму на резервный адрес, шаг 2: код из письма и новый пароль. Сразу входит. */
  async resetWithEmailCode(nameOrEmail, code, newPassword, { totp = "" } = {}) {
    const email = this.normalizeEmail(nameOrEmail);
    checkNewPassword(newPassword);
    let p = this._pending;
    if (!p || p.email !== email || p.purpose !== "reset" || Date.now() - p.at > PENDING_TTL) {
      this._forgetPending();
      const k = await this._derive(email, newPassword, KDF_CURRENT);
      p = this._pending = { email, kdf: KDF_CURRENT, loginHash: k.loginHash, wrapKey: k.wrapKey, at: Date.now(), purpose: "reset" };
    }
    this._step(t`Меняем пароль`);
    let r;
    try {
      r = await this.api.resetEmailConfirm({ email, code: String(code).replace(/\s+/g, ""), newLoginHash: p.loginHash, kdf: KDF_CURRENT, deviceId: this.store.deviceId(), deviceName: this.deviceName(), mailAccess: "session", ...(totp ? { totp: String(totp).replace(/\s+/g, "") } : {}) });
    } catch (e) {
      if (e.code !== "2fa-required" && e.code !== "bad-2fa") {
        this._forgetPending();
      }
      throw e;
    }
    // пароль новый: копия ключа данных привязана к прежнему и откроется ключом восстановления
    const pending = { ...p };
    this._pending = null;
    this.session = { email, userId: r.userId, token: r.session.token, expiresAt: r.session.expiresAt, kdf: KDF_CURRENT, mail: r.mail || null };
    this.keys = { state: "offline" };
    try {
      await this._openKeys({ wrapKey: pending.wrapKey, loginHash: pending.loginHash, create: true });
    } catch (e) {
      console.error("Tabora: ключи аккаунта не открыты", e);
    } finally {
      wipe(pending.wrapKey);
    }
    await this._persist();
    this._emit("signed-in");
    return { email };
  }

  /* ---- доступ к ящику ---- */

  /** Веб-версия ходит к ящику по сессии аккаунта (core/jmap.js): почтового пароля у страницы нет.
   * Сервер аккаунтов прежней версии этого не умеет и выдаёт пароль приложения — тогда он здесь. */
  get mailBySession() {
    return !this.session?.mail?.password;
  }

  /** Логин и пароль приложения для почтового сервера (только с сервером аккаунтов прежней версии). */
  async mailAccess({ refresh = false } = {}) {
    if (!refresh && this.session?.mail?.password) {
      return this.session.mail;
    }
    const r = await this.api.mailPassword(this.token);
    if (!r?.mail?.password) {
      throw fail(t`Почтовый сервер сейчас недоступен. Повторите позже`, "mail-unavailable");
    }
    this.session.mail = r.mail;
    await this._persist();
    return r.mail;
  }
}

export { randomId };
