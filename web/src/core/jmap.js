/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Доступ к почтовому ящику по JMAP (RFC 8620, 8621). Браузеру Tabora для этого служат IMAP и SMTP,
 * но веб-страница умеет только HTTPS — тот же почтовый сервер отвечает и по нему.
 *
 * Запросы идут на сервер аккаунтов (/v1/mail/jmap…) с токеном сессии, а он пересылает их почтовому
 * серверу от имени владельца ящика: почтового пароля у страницы нет вовсе, выход из аккаунта сразу
 * закрывает и почту, а из методов доступны только почтовые (server/src/webmail.rs).
 *
 * Сервер аккаунтов прежней версии так не умеет и при входе выдаёт устройству пароль приложения;
 * тогда запросы идут прямо на почтовый сервер (/jmap…) с этим паролем — как раньше. */

import { b64, utf8 } from "./bytes.js";
import { t } from "./i18n.js";

const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"];

function fail(message, code, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

export class Jmap {
  /**
   * @param {import("./account.js").Account} account
   * @param {{ proxy?: string, direct?: string }} bases адреса для проверок под Node: сервер аккаунтов
   *   и почтовый сервер; в браузере оба пусты — то же имя, что у страницы
   */
  constructor(account, { proxy = "", direct = "" } = {}) {
    this.account = account;
    this.proxy = proxy.replace(/\/+$/, "");
    this.direct = direct.replace(/\/+$/, "");
    this.accountId = "";
    this._session = null;
  }

  get bySession() {
    return this.account.mailBySession;
  }

  _url(kind, ...parts) {
    const seg = parts.map(encodeURIComponent);
    if (this.bySession) {
      return this.proxy + { session: "/v1/mail/jmap/session", api: "/v1/mail/jmap", upload: `/v1/mail/jmap/upload/${seg[0]}`, download: `/v1/mail/jmap/download/${seg.join("/")}` }[kind];
    }
    return this.direct + { session: "/jmap/session", api: "/jmap/", upload: `/jmap/upload/${seg[0]}/`, download: `/jmap/download/${seg.join("/")}` }[kind];
  }

  async _auth(refresh = false) {
    if (this.bySession) {
      return `Bearer ${this.account.token}`;
    }
    const m = await this.account.mailAccess({ refresh });
    return `Basic ${b64(utf8(`${m.login}:${m.password}`))}`;
  }

  /** Запрос с входом. По паролю приложения: если он отозван (вход с этого устройства заново) — берём новый. */
  async _fetch(url, init = {}, { timeout = 30000 } = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      const bySession = this.bySession;
      let token = "";
      let res;
      try {
        const auth = await this._auth(attempt > 0);
        token = bySession ? this.account.token : "";
        res = await fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: auth }, credentials: "omit", redirect: "error", cache: "no-store", signal: ctrl.signal });
      } catch (e) {
        if (e.code) {
          throw e;
        }
        throw fail(t`Почтовый сервер не отвечает. Проверьте соединение и повторите`, "offline");
      } finally {
        clearTimeout(timer);
      }
      if (res.status === 401 && bySession) {
        // сессия аккаунта завершена (выход с другого устройства, истёк срок): как для любого запроса
        try {
          this.account.api.onExpired?.(token);
        } catch (e) {}
        throw fail(t`Сессия истекла: войдите в аккаунт заново`, "session-expired");
      }
      if (res.status === 401 && attempt === 0) {
        continue;
      }
      if (res.status === 401) {
        throw fail(t`Почтовый сервер не принял вход. Выйдите из аккаунта и войдите снова`, "mail-auth");
      }
      if (res.status === 429) {
        throw fail(t`Слишком много запросов к почте. Повторите через минуту`, "rate-limited");
      }
      if (res.status === 503 || res.status === 502) {
        throw fail(t`Почтовый сервер сейчас недоступен. Повторите позже`, "mail-unavailable", { status: res.status });
      }
      return res;
    }
    throw fail(t`Почтовый сервер не отвечает`, "offline");
  }

  async session() {
    if (this._session) {
      return this._session;
    }
    const res = await this._fetch(this._url("session"));
    if (!res.ok) {
      throw fail(t`Почтовый сервер сейчас недоступен. Повторите позже`, "mail-unavailable", { status: res.status });
    }
    const s = await res.json();
    const id = s.primaryAccounts?.["urn:ietf:params:jmap:mail"];
    if (!id) {
      throw fail(t`Почтовый сервер не назвал ящик`, "mail-unavailable");
    }
    this.accountId = id;
    this.limits = { maxAttachments: s.accounts?.[id]?.accountCapabilities?.["urn:ietf:params:jmap:mail"]?.maxSizeAttachmentsPerEmail || 25_000_000, maxUpload: s.capabilities?.["urn:ietf:params:jmap:core"]?.maxSizeUpload || 50_000_000 };
    this._session = s;
    return s;
  }

  /**
   * Несколько вызовов одним запросом: calls — [[метод, аргументы], …]; accountId подставляется.
   * Возвращает ответы по порядку. Ошибка любого метода — исключение с кодом JMAP.
   */
  async call(calls, { timeout = 30000 } = {}) {
    await this.session();
    const methodCalls = calls.map(([name, args], i) => [name, { accountId: this.accountId, ...args }, `c${i}`]);
    const res = await this._fetch(this._url("api"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ using: USING, methodCalls }) }, { timeout });
    let json;
    try {
      json = await res.json();
    } catch (e) {
      throw fail(t`Почтовый сервер ответил непонятно. Повторите позже`, "bad-response", { status: res.status });
    }
    if (!res.ok || !Array.isArray(json.methodResponses)) {
      throw fail(json.detail || t`Почтовый сервер отклонил запрос`, json.type || "mail-error", { status: res.status });
    }
    const out = new Array(calls.length).fill(null);
    for (const [name, args, tag] of json.methodResponses) {
      const i = Number(String(tag).slice(1));
      if (name === "error") {
        throw fail(args.description || t`Почтовый сервер: ${args.type}`, args.type || "mail-error", { method: calls[i]?.[0] });
      }
      // метод может ответить дважды (EmailSubmission/set + неявный Email/set): берём первый ответ
      if (out[i] === null) {
        out[i] = args;
      }
    }
    return out;
  }

  /** Содержимое блока (вложение, исходник письма): Uint8Array. */
  async download(blobId, { name = "file", type = "application/octet-stream", timeout = 120000 } = {}) {
    await this.session();
    const res = await this._fetch(`${this._url("download", this.accountId, blobId, name)}?accept=${encodeURIComponent(type)}`, {}, { timeout });
    if (!res.ok) {
      throw fail(res.status === 404 ? t`Файл не найден на сервере` : t`Не удалось скачать файл`, "download", { status: res.status });
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Загрузить байты на сервер: { blobId, type, size }. */
  async upload(bytes, type = "application/octet-stream", { timeout = 300000 } = {}) {
    await this.session();
    const res = await this._fetch(this._url("upload", this.accountId), { method: "POST", headers: { "Content-Type": type }, body: bytes }, { timeout });
    if (!res.ok) {
      throw fail(res.status === 413 ? t`Файл слишком большой` : t`Не удалось загрузить файл на сервер`, "upload", { status: res.status });
    }
    return res.json();
  }
}
