/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Где веб-версия хранит сессию. В сессии лежат токен, доступ к ящику и ключ данных аккаунта,
 * поэтому открытым текстом на диск она не пишется: запись шифруется ключом AES-GCM, который
 * браузер хранит в IndexedDB без права вывоза (extractable: false) — прочитать его значение не
 * может даже скрипт страницы.
 *
 * Запись лежит в localStorage и переживает закрытие вкладки и браузера: войдя один раз, человек
 * остаётся в аккаунте, пока сам не нажмёт «Выйти». Сама страница сессию не стирает ни по времени,
 * ни при сбое хранилища — только когда запись уже нельзя открыть (ключ утрачен безвозвратно).
 *
 * Если IndexedDB недоступна (некоторые приватные окна), сессия живёт только в памяти страницы. */

import { b64, fromB64, random, randomId, text, utf8 } from "./bytes.js";

const DB = "tabora-web";
const STORE = "keys";
const KEY_ID = "session-key";
const ITEM = "tabora.session";
const DEVICE = "tabora.device";

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("хранилище занято"));
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = t.onabort = () => reject(t.error || new Error("хранилище недоступно"));
  });
}

export class BrowserStore {
  constructor() {
    this._memory = null;
  }

  /** Номер этого браузера для сервера: случайный, постоянный, без сведений об устройстве. */
  deviceId() {
    let id = "";
    try {
      id = localStorage.getItem(DEVICE) || "";
    } catch (e) {}
    if (!/^web-[A-Za-z0-9]{16,40}$/.test(id)) {
      id = `web-${randomId(18).replace(/[^A-Za-z0-9]/g, "x")}`;
      try {
        localStorage.setItem(DEVICE, id);
      } catch (e) {
        this._device ||= id; // хранилище закрыто: номер живёт до перезагрузки
        return this._device;
      }
    }
    return id;
  }

  async _key(create) {
    const db = await idb();
    try {
      let key = await tx(db, "readonly", s => s.get(KEY_ID));
      if (!key && create) {
        key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
        await tx(db, "readwrite", s => s.put(key, KEY_ID));
      }
      return key || null;
    } finally {
      db.close();
    }
  }

  async load() {
    if (this._memory) {
      return this._memory;
    }
    let raw = "";
    try {
      raw = localStorage.getItem(ITEM) || "";
      if (!raw) {
        // прежние версии держали вход без «не выходить» в sessionStorage: переносим его в постоянное место
        raw = sessionStorage.getItem(ITEM) || "";
        if (raw) {
          localStorage.setItem(ITEM, raw);
        }
      }
      sessionStorage.removeItem(ITEM);
    } catch (e) {}
    if (!raw) {
      return null;
    }
    // Ключ читается из IndexedDB. Сбой чтения (хранилище занято, браузер только запускается) —
    // не повод стирать вход: пробуем ещё, а если не вышло, запись остаётся до следующего раза.
    let key = null;
    for (let attempt = 0; ; attempt++) {
      try {
        key = await this._key(false);
        break;
      } catch (e) {
        if (attempt >= 3) {
          return null;
        }
        await new Promise(r => setTimeout(r, 150 * (attempt + 1)));
      }
    }
    try {
      if (!key) {
        throw new Error("ключ сессии утрачен");
      }
      const bytes = fromB64(raw);
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, 12), additionalData: utf8("tabora-web/session/v1") }, key, bytes.subarray(12));
      return JSON.parse(text(new Uint8Array(plain)));
    } catch (e) {
      await this.clear(); // запись не открылась (ключ утрачен): вход заново
      return null;
    }
  }

  async save(data) {
    this._memory = data;
    try {
      const key = await this._key(true);
      const iv = random(12);
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8("tabora-web/session/v1") }, key, utf8(JSON.stringify(data))));
      const out = new Uint8Array(12 + ct.length);
      out.set(iv);
      out.set(ct, 12);
      localStorage.setItem(ITEM, b64(out));
      sessionStorage.removeItem(ITEM);
      this._keepStorage();
    } catch (e) {
      // хранилище недоступно: сессия остаётся в памяти до перезагрузки страницы
    }
  }

  /** Просим браузер не вычищать данные сайта при нехватке места: вместе с ними пропал бы вход.
   * Chrome и Safari решают это сами, без вопросов; Firefox показал бы запрос — там не просим
   * (он вычищает данные только при почти полном диске). */
  _keepStorage() {
    try {
      if (!navigator.storage?.persist || /Gecko\/\d/.test(navigator.userAgent)) {
        return;
      }
      navigator.storage.persisted().then(kept => kept || navigator.storage.persist()).catch(() => {});
    } catch (e) {}
  }

  async clear() {
    this._memory = null;
    try {
      sessionStorage.removeItem(ITEM);
      localStorage.removeItem(ITEM);
    } catch (e) {}
    try {
      const db = await idb();
      try {
        await tx(db, "readwrite", s => s.delete(KEY_ID));
      } finally {
        db.close();
      }
    } catch (e) {}
  }
}

/** Хранилище в памяти: для проверок. */
export class MemoryStore {
  constructor(deviceId = `web-${randomId(18).replace(/[^A-Za-z0-9]/g, "x")}`) {
    this._device = deviceId;
    this._data = null;
  }

  deviceId() {
    return this._device;
  }

  async load() {
    return this._data ? JSON.parse(JSON.stringify(this._data)) : null;
  }

  async save(data) {
    this._data = JSON.parse(JSON.stringify(data));
  }

  async clear() {
    this._data = null;
  }
}
