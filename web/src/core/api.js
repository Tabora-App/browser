import { language, t } from "./i18n.js";
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Сервер аккаунтов Tabora. Контракт — server/README.md и account/Account.sys.mjs браузера.
 * Адреса относительные: веб-версия и сервер живут на одном имени, чужим сайтам запросы недоступны. */

function fail(message, code, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

export class Api {
  /** @param {string} base пусто — тот же сайт; в проверках — адрес сервера */
  constructor(base = "") {
    this.base = base.replace(/\/+$/, "");
    this.onExpired = null; // (token) => void: сервер больше не признаёт сессию
  }

  async call(method, path, body, token, { timeout = 20000, raw = false } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(this.base + path, {
        method,
        headers: { "Accept-Language": language(), ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        signal: ctrl.signal,
      });
      if (raw && res.ok) {
        return res;
      }
      const text = await res.text();
      let json;
      try {
        json = text ? JSON.parse(text) : {};
      } catch (e) {
        throw fail(t`Сервер Tabora ответил непонятно. Повторите позже`, "bad-response", { status: res.status });
      }
      if (!res.ok) {
        const error = fail(json.message || t`Сервер: HTTP ${res.status}`, json.code || (res.status === 401 ? "bad-credentials" : `http-${res.status}`), { status: res.status, details: json });
        if (error.code === "session-expired" && token) {
          try {
            this.onExpired?.(token);
          } catch (e) {}
        }
        throw error;
      }
      return json;
    } catch (e) {
      if (e.name === "AbortError" || e.name === "TypeError") {
        throw fail(t`Сервер Tabora не отвечает. Проверьте соединение и повторите`, "offline");
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---- аккаунт ---- */

  async available(email) {
    return (await this.call("GET", `/v1/account/available?email=${encodeURIComponent(email)}`)).available !== false;
  }

  async prelogin(email) {
    try {
      const r = await this.call("GET", `/v1/account/prelogin?email=${encodeURIComponent(email)}`);
      return Number(r.kdf) === 1 ? 1 : 2;
    } catch (e) {
      if (e.status === 404) {
        return 2;
      }
      throw e;
    }
  }

  register(data) {
    return this.call("POST", "/v1/account/register", data, null, { timeout: 40000 });
  }

  login(data) {
    return this.call("POST", "/v1/account/login", data, null, { timeout: 40000 });
  }

  logout(token) {
    return this.call("POST", "/v1/account/logout", {}, token);
  }

  devices(token) {
    return this.call("GET", "/v1/account/devices", null, token);
  }

  deviceRevoke(token, id, loginHash) {
    return this.call("POST", `/v1/account/devices/${encodeURIComponent(id)}/revoke`, { loginHash }, token);
  }

  changePassword(token, { oldLoginHash, newLoginHash, kdf }) {
    return this.call("POST", "/v1/account/password", { oldLoginHash, newLoginHash, kdf }, token);
  }

  setRecovery(token, recoveryVerifier) {
    return this.call("POST", "/v1/account/recovery", { recoveryVerifier }, token);
  }

  resetChallenge(email) {
    return this.call("POST", "/v1/account/reset/challenge", { email });
  }

  reset(data) {
    return this.call("POST", "/v1/account/reset", data, null, { timeout: 40000 });
  }

  resetEmailStart(email) {
    return this.call("POST", "/v1/account/reset/email", { email });
  }

  resetEmailConfirm(data) {
    return this.call("POST", "/v1/account/reset/email/confirm", data, null, { timeout: 40000 });
  }

  security(token) {
    return this.call("GET", "/v1/account/security", null, token);
  }

  twoFactorSetup(token, loginHash) {
    return this.call("POST", "/v1/account/2fa/setup", { loginHash }, token);
  }

  twoFactorEnable(token, code) {
    return this.call("POST", "/v1/account/2fa/enable", { code }, token);
  }

  twoFactorDisable(token, loginHash, code) {
    return this.call("POST", "/v1/account/2fa/disable", { loginHash, code }, token);
  }

  twoFactorCodes(token, loginHash, code) {
    return this.call("POST", "/v1/account/2fa/codes", { loginHash, code }, token);
  }

  backupEmailSet(token, { loginHash, code, address }) {
    return this.call("POST", "/v1/account/backup-email", { loginHash, code, address }, token);
  }

  backupEmailVerify(token, code) {
    return this.call("POST", "/v1/account/backup-email/verify", { code }, token);
  }

  backupEmailRemove(token, { loginHash, code }) {
    return this.call("POST", "/v1/account/backup-email/remove", { loginHash, code }, token);
  }

  /* ---- почта: доступ, алиасы, ключи ---- */

  mailPassword(token) {
    return this.call("POST", "/v1/mail/password", {}, token);
  }

  aliases(token) {
    return this.call("GET", "/v1/mail/aliases", null, token);
  }

  aliasCreate(token, { site = "", space = "" } = {}) {
    return this.call("POST", "/v1/mail/aliases", { site, space, by: "user" }, token);
  }

  aliasUpdate(token, id, patch) {
    return this.call("PATCH", `/v1/mail/aliases/${encodeURIComponent(id)}`, patch, token);
  }

  aliasDelete(token, id) {
    return this.call("DELETE", `/v1/mail/aliases/${encodeURIComponent(id)}`, null, token);
  }

  mailKeys(token) {
    return this.call("GET", "/v1/mail/pgp", null, token);
  }

  mailKeysSave(token, body) {
    return this.call("PUT", "/v1/mail/pgp", body, token);
  }

  /** Открытый ключ адреса Tabora из каталога (Web Key Directory) или null. */
  async directoryKey(local, hash) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const res = await fetch(`${this.base}/.well-known/openpgpkey/hu/${encodeURIComponent(hash)}?l=${encodeURIComponent(local)}`, { credentials: "omit", redirect: "error", signal: ctrl.signal });
      if (res.status === 404) {
        return null;
      }
      if (!res.ok) {
        throw fail(t`Каталог ключей не отвечает`, "offline");
      }
      return new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      if (e.name === "AbortError" || e.name === "TypeError") {
        throw fail(t`Каталог ключей не отвечает`, "offline");
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---- синхронизация ---- */

  syncPull(token, since = 0, limit = 500) {
    return this.call("GET", `/v1/sync?since=${Number(since) || 0}&limit=${limit}`, null, token, { timeout: 30000 });
  }

  syncPush(token, { gen, keyId, items }) {
    return this.call("POST", "/v1/sync", { gen, keyId, items }, token, { timeout: 30000 });
  }

  /* ---- обращения в поддержку ---- */

  supportTickets(token, { scope = "mine", status = "" } = {}) {
    return this.call("GET", `/v1/support/tickets?scope=${scope}${status ? `&status=${status}` : ""}`, null, token);
  }

  supportCreate(token, { subject, text, meta, files }) {
    return this.call("POST", "/v1/support/tickets", { subject, text, meta, files }, token, { timeout: 60000 });
  }

  supportTicket(token, id) {
    return this.call("GET", `/v1/support/tickets/${Number(id)}`, null, token);
  }

  supportReply(token, id, { text, files }) {
    return this.call("POST", `/v1/support/tickets/${Number(id)}/messages`, { text, files }, token, { timeout: 60000 });
  }

  supportStatus(token, id, status) {
    return this.call("POST", `/v1/support/tickets/${Number(id)}/status`, { status }, token);
  }

  supportUnread(token) {
    return this.call("GET", "/v1/support/unread", null, token);
  }

  async supportFile(token, id) {
    const res = await this.call("GET", `/v1/support/files/${Number(id)}`, null, token, { raw: true, timeout: 60000 });
    return res.blob();
  }

  health() {
    return this.call("GET", "/v1/health");
  }
}
