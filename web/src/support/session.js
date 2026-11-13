/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* The sign-in of the support site. It asks the account server for a session of the scope
 * "support": such a session reaches the account's support requests and nothing else — not the
 * mail, not the keys, not the settings (the server repository, src/api.rs: auth_for).
 *
 * The page has no code for the account's keys at all. From the password it derives the login
 * hash, which goes to the server, and throws the rest away; what is stored in the browser is the
 * address and the token of that narrow session, encrypted as in the web app (core/store.js).
 * The sign-in does not end on its own: only "Sign out" here, or ending this sign-in from the
 * list of devices in the account, closes it. */

import { wipe } from "../core/bytes.js";
import { t } from "../core/i18n.js";
import { passwordKeys } from "../core/kdf.js";

const PENDING_TTL = 3 * 60 * 1000;

function fail(message, code) {
  return Object.assign(new Error(message), { code });
}

/** How this sign-in is named in the account's list of devices. */
export function deskLabel(ua = typeof navigator === "object" ? navigator.userAgent : "") {
  const os = /iPhone|iPod/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  const app = /Tabora\//.test(ua) ? "Tabora" : /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /Firefox\/|FxiOS/.test(ua) ? "Firefox" : /Chrome\/|CriOS/.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  return [t`Сайт поддержки`, [app, os].filter(Boolean).join(", ")].filter(Boolean).join(": ").slice(0, 64);
}

export class DeskSession {
  /**
   * @param {{ api: import("../core/api.js").Api, store: { load(): Promise<object|null>, save(data: object): Promise<void>, clear(): Promise<void>, deviceId(): string }, domain?: string }} deps
   */
  constructor({ api, store, domain = "tabora.app" }) {
    this.api = api;
    this.store = store;
    this.domain = domain;
    this.session = null; // { email, token }
    this._pending = null; // the login hash while the sign-in waits for the second step
    this._listeners = new Set();
    this.onStep = null;
    api.onExpired = token => {
      if (this.session?.token === token) {
        this._drop("expired");
      }
    };
  }

  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit(what) {
    for (const fn of this._listeners) {
      try {
        fn(what);
      } catch (e) {
        console.error(e);
      }
    }
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

  async restore() {
    let saved = null;
    try {
      saved = await this.store.load();
    } catch (e) {}
    if (!saved?.token || !saved.email) {
      return false;
    }
    this.session = { email: saved.email, token: saved.token };
    this._emit("signed-in");
    return true;
  }

  async _drop(why) {
    this.session = null;
    this._pending = null;
    try {
      await this.store.clear();
    } catch (e) {}
    this._emit(why === "expired" ? "expired" : "signed-out");
  }

  /**
   * Sign in. With two-step protection on, the first call ends with the error "2fa-required": the
   * page asks for the code and calls signIn again with the same address and `totp`; the password
   * is not needed again (the login hash waits in memory for three minutes).
   */
  async signIn(nameOrEmail, password, { totp = "" } = {}) {
    const email = this.normalizeEmail(nameOrEmail);
    let p = this._pending;
    if (!p || p.email !== email || Date.now() - p.at > PENDING_TTL || password) {
      if (!password) {
        throw fail(t`Введите пароль`, "bad-credentials");
      }
      this._pending = null;
      const kdf = await this.api.prelogin(email);
      this.onStep?.(t`Проверяем пароль`);
      const k = await passwordKeys(email, password, kdf);
      wipe(k.wrapKey); // the key that opens the account's data is of no use here
      p = this._pending = { email, loginHash: k.loginHash, at: Date.now() };
    }
    this.onStep?.(t`Входим`);
    let r;
    try {
      r = await this.api.login({ email, loginHash: p.loginHash, deviceId: this.store.deviceId(), deviceName: deskLabel(), scope: "support", ...(totp ? { totp: String(totp).replace(/\s+/g, "") } : {}) });
    } catch (e) {
      if (e.code !== "2fa-required" && e.code !== "bad-2fa") {
        this._pending = null;
      }
      throw e;
    }
    this._pending = null;
    if (!r?.session?.token) {
      throw fail(t`Сервер Tabora ответил непонятно. Повторите позже`, "bad-response");
    }
    this.session = { email, token: r.session.token };
    try {
      await this.store.save({ email, token: r.session.token });
    } catch (e) {
      console.error("Tabora: the sign-in is not saved", e);
    }
    this._emit("signed-in");
    return { email };
  }

  async signOut() {
    const token = this.session?.token;
    if (token) {
      try {
        await this.api.logout(token);
      } catch (e) {}
    }
    await this._drop("signed-out");
  }
}
