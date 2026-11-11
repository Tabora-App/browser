/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Доступ к почтовому ящику по JMAP (RFC 8620, 8621). Браузеру Tabora для этого служат IMAP и SMTP,
 * но веб-страница умеет только HTTPS — тот же почтовый сервер отвечает и по нему.
 *
 * Вход — пароль приложения, который сервер аккаунтов выдаёт каждому устройству при входе и
 * отзывает при выходе: основной пароль ящика страница не получает. Запросы идут на то же имя,
 * что и сама страница (/jmap/…): чужим сайтам ящик недоступен. */

import { b64, utf8 } from "./bytes.js";

const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"];

function fail(message, code, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

export class Jmap {
  /**
   * @param {{ mailAccess(opts?: { refresh?: boolean }): Promise<{ login: string, password: string }> }} account
   * @param {string} base пусто — тот же сайт; в проверках — адрес почтового сервера
   */
  constructor(account, base = "") {
    this.account = account;
    this.base = base.replace(/\/+$/, "");
    this.accountId = "";
    this._session = null;
  }

  async _auth(refresh = false) {
    const m = await this.account.mailAccess({ refresh });
    return `Basic ${b64(utf8(`${m.login}:${m.password}`))}`;
  }

  /** Запрос с входом; если пароль приложения отозван (вход с этого устройства заново) — берём новый. */
  async _fetch(path, init = {}, { timeout = 30000 } = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      let res;
      try {
        res = await fetch(this.base + path, { ...init, headers: { ...(init.headers || {}), Authorization: await this._auth(attempt > 0) }, credentials: "omit", redirect: "error", cache: "no-store", signal: ctrl.signal });
      } catch (e) {
        if (e.code) {
          throw e;
        }
        throw fail("Почтовый сервер не отвечает. Проверьте соединение и повторите", "offline");
      } finally {
        clearTimeout(timer);
      }
      if (res.status === 401 && attempt === 0) {
        continue;
      }
      if (res.status === 401) {
        throw fail("Почтовый сервер не принял вход. Выйдите из аккаунта и войдите снова", "mail-auth");
      }
      if (res.status === 429) {
        throw fail("Слишком много запросов к почте. Повторите через минуту", "rate-limited");
      }
      return res;
    }
    throw fail("Почтовый сервер не отвечает", "offline");
  }

  async session() {
    if (this._session) {
      return this._session;
    }
    const res = await this._fetch("/jmap/session");
    if (!res.ok) {
      throw fail("Почтовый сервер сейчас недоступен. Повторите позже", "mail-unavailable", { status: res.status });
    }
    const s = await res.json();
    const id = s.primaryAccounts?.["urn:ietf:params:jmap:mail"];
    if (!id) {
      throw fail("Почтовый сервер не назвал ящик", "mail-unavailable");
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
    const res = await this._fetch("/jmap/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ using: USING, methodCalls }) }, { timeout });
    let json;
    try {
      json = await res.json();
    } catch (e) {
      throw fail("Почтовый сервер ответил непонятно. Повторите позже", "bad-response", { status: res.status });
    }
    if (!res.ok || !Array.isArray(json.methodResponses)) {
      throw fail(json.detail || "Почтовый сервер отклонил запрос", json.type || "mail-error", { status: res.status });
    }
    const out = new Array(calls.length).fill(null);
    for (const [name, args, tag] of json.methodResponses) {
      const i = Number(String(tag).slice(1));
      if (name === "error") {
        throw fail(args.description || `Почтовый сервер: ${args.type}`, args.type || "mail-error", { method: calls[i]?.[0] });
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
    const res = await this._fetch(`/jmap/download/${encodeURIComponent(this.accountId)}/${encodeURIComponent(blobId)}/${encodeURIComponent(name)}?accept=${encodeURIComponent(type)}`, {}, { timeout });
    if (!res.ok) {
      throw fail(res.status === 404 ? "Файл не найден на сервере" : "Не удалось скачать файл", "download", { status: res.status });
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Загрузить байты на сервер: { blobId, type, size }. */
  async upload(bytes, type = "application/octet-stream", { timeout = 300000 } = {}) {
    await this.session();
    const res = await this._fetch(`/jmap/upload/${encodeURIComponent(this.accountId)}/`, { method: "POST", headers: { "Content-Type": type }, body: bytes }, { timeout });
    if (!res.ok) {
      throw fail(res.status === 413 ? "Файл слишком большой" : "Не удалось загрузить файл на сервер", "upload", { status: res.status });
    }
    return res.json();
  }
}
