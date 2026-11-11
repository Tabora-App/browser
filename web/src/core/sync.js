/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Данные аккаунта, которые синхронизируются между устройствами: пароли сайтов, коды входа,
 * закладки, списки открытых вкладок. Формат записей и шифрование — те же, что в браузере Tabora
 * (sync/Sync.sys.mjs, sync/SyncSources.sys.mjs): запись, сделанная здесь, откроется там.
 *
 * Сервер хранит непрозрачные блоки. Каждая запись шифруется здесь (AES-256-GCM) ключом, который
 * выводится из ключа данных аккаунта; блок привязан к набору и номеру записи, длина открытого
 * текста выровнена до 64 байт.
 *
 * В отличие от браузера, у веб-версии нет своей копии данных на диске: она работает прямо с
 * записями сервера. Чтение — всё новее последнего виденного номера версии; запись — только если
 * запись на сервере не менялась с тех пор, как её видели здесь (base), иначе пользователь
 * получает свежую версию и решает сам. Потерять чужое изменение так нельзя. */

import { b64, fromB64, hex, hkdf, random, sha256, text, utf8, wipe } from "./bytes.js";

const MAX_PLAIN = 60 * 1024;
const PULL_LIMIT = 500;
const PUSH_ITEMS = 150;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const COLL_RE = /^[a-z]{1,16}$/;

function fail(message, code, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

export class SyncClient {
  /** @param {import("./account.js").Account} account */
  constructor(account) {
    this.account = account;
    this._keys = null;
    this._keyFor = "";
    this._listeners = new Set();
    this._busy = null;
    this.reset();
  }

  reset() {
    this.rev = 0;
    this.gen = null;
    this.items = new Map(); // набор → Map(номер → { rev, data })
    this.loaded = false;
    this.unreadable = 0; // записи, которые не открылись нашим ключом
    this.status = "idle"; // idle | ok | locked | key | offline | error
    this.error = "";
    this.at = 0;
  }

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

  /* ---- ключ ---- */

  async keys() {
    const data = this.account.keys?.dataKey;
    if (!data) {
      return null;
    }
    const mark = `${this.account.email}|${hex(await sha256(data)).slice(0, 16)}`;
    if (this._keys && this._keyFor === mark) {
      return this._keys;
    }
    const raw = await hkdf(data, "tabora-sync/v1", `key|${this.account.email.toLowerCase()}`);
    const digest = await sha256(new Uint8Array([...utf8("tabora-sync/key-id|"), ...raw]));
    this._keys = { id: hex(digest.subarray(0, 8)), aes: await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]) };
    wipe(raw);
    this._keyFor = mark;
    return this._keys;
  }

  async _seal(keys, coll, id, data) {
    const plain = utf8(JSON.stringify(data));
    if (plain.length > MAX_PLAIN) {
      throw fail("Запись слишком велика", "too-large");
    }
    const padded = new Uint8Array(Math.ceil((plain.length + 1) / 64) * 64).fill(0x20);
    padded.set(plain);
    const iv = random(12);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(`${coll}|${id}`) }, keys.aes, padded));
    const out = new Uint8Array(13 + ct.length);
    out[0] = 1;
    out.set(iv, 1);
    out.set(ct, 13);
    return b64(out);
  }

  async _open(keys, coll, id, blob) {
    try {
      const bytes = fromB64(blob);
      if (bytes[0] !== 1 || bytes.length < 13 + 16) {
        return null;
      }
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(1, 13), additionalData: utf8(`${coll}|${id}`) }, keys.aes, bytes.subarray(13));
      const data = JSON.parse(text(new Uint8Array(plain)));
      return data && typeof data === "object" ? data : null;
    } catch (e) {
      return null;
    }
  }

  /* ---- чтение ---- */

  coll(name) {
    let m = this.items.get(name);
    if (!m) {
      m = new Map();
      this.items.set(name, m);
    }
    return m;
  }

  /** Записи набора: [{ id, rev, data }]. */
  list(name) {
    return [...this.coll(name)].map(([id, v]) => ({ id, rev: v.rev, data: v.data }));
  }

  get(name, id) {
    return this.coll(name).get(id)?.data || null;
  }

  _set(state, error = "") {
    const changed = this.status !== state || this.error !== error;
    this.status = state;
    this.error = error;
    if (changed) {
      this._emit("status");
    }
  }

  /** Забрать с сервера всё новое. Одновременных чтений не бывает. */
  refresh() {
    this._busy ||= this._refresh().finally(() => {
      this._busy = null;
    });
    return this._busy;
  }

  async _refresh() {
    const keys = await this.keys();
    if (!keys) {
      this._set(this.account.keys?.state === "offline" ? "offline" : "locked");
      return false;
    }
    try {
      const token = this.account.token;
      let changed = false;
      for (let page = 0; page < 200; page++) {
        const res = await this.account.api.syncPull(token, this.rev, PULL_LIMIT);
        if (!res || !Number.isInteger(res.rev) || !Number.isInteger(res.gen) || !Array.isArray(res.items)) {
          throw fail("Сервер Tabora ответил непонятно. Повторите позже", "bad-response");
        }
        if (res.keyId && res.keyId !== keys.id) {
          throw fail("Данные на сервере зашифрованы другим ключом аккаунта", "sync-key");
        }
        if (this.gen !== null && res.gen !== this.gen) {
          // данные на сервере начаты заново (сброс или стирание): читаем с начала
          const keep = { status: this.status };
          this.reset();
          this.status = keep.status;
          this.gen = res.gen;
          changed = true;
          continue;
        }
        this.gen = res.gen;
        this.keyId = res.keyId || "";
        let last = this.rev;
        for (const it of res.items) {
          if (!COLL_RE.test(it.c || "") || !ID_RE.test(it.id || "") || !Number.isInteger(it.rev)) {
            continue;
          }
          last = Math.max(last, it.rev);
          const bucket = this.coll(it.c);
          if (it.deleted) {
            changed = bucket.delete(it.id) || changed;
            continue;
          }
          const data = await this._open(keys, it.c, it.id, it.blob);
          if (data) {
            bucket.set(it.id, { rev: it.rev, data });
            changed = true;
          } else {
            this.unreadable++;
          }
        }
        if (!res.more || !res.items.length) {
          this.rev = Math.max(last, res.rev);
          break;
        }
        this.rev = last;
      }
      this.loaded = true;
      this.at = Date.now();
      this._set("ok");
      if (changed) {
        this._emit("data");
      }
      return changed;
    } catch (e) {
      if (e.code === "sync-key") {
        this._set("key", e.message);
      } else if (e.code === "offline") {
        this._set("offline");
      } else if (e.code !== "session-expired" && e.code !== "signed-out") {
        this._set("error", e.message || String(e));
      }
      throw e;
    }
  }

  /* ---- запись ---- */

  /**
   * Сохранить изменения одним запросом: [{ c, id, data }] (data: null — удалить запись).
   * Если запись успели изменить на другом устройстве, ничего из набора изменений не теряется на
   * сервере: отказ с кодом "conflict", а здесь уже лежит свежая версия.
   */
  async write(changes) {
    const keys = await this.keys();
    if (!keys) {
      throw fail("Ключ аккаунта не открыт", "locked");
    }
    if (!this.loaded) {
      await this.refresh();
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const items = [];
      for (const ch of changes) {
        if (!COLL_RE.test(ch.c) || !ID_RE.test(ch.id)) {
          throw fail("Неверный номер записи", "sync-invalid");
        }
        const base = this.coll(ch.c).get(ch.id)?.rev || 0;
        if (ch.data === null) {
          if (base) {
            items.push({ c: ch.c, id: ch.id, base, deleted: true });
          }
        } else {
          items.push({ c: ch.c, id: ch.id, base, blob: await this._seal(keys, ch.c, ch.id, ch.data) });
        }
      }
      if (!items.length) {
        return;
      }
      if (items.length > PUSH_ITEMS) {
        throw fail("Слишком много изменений за один раз", "too-large");
      }
      let res;
      try {
        res = await this.account.api.syncPush(this.account.token, { gen: this.gen ?? 0, keyId: keys.id, items });
      } catch (e) {
        if (e.code === "sync-reset" && attempt === 0) {
          await this.refresh(); // данные на сервере начаты заново: читаем и пробуем ещё раз
          continue;
        }
        if (e.code === "sync-key") {
          this._set("key", e.message);
        }
        throw e;
      }
      const byKey = new Map(changes.map(ch => [`${ch.c}|${ch.id}`, ch]));
      for (const s of res.saved || []) {
        const ch = byKey.get(`${s.c}|${s.id}`);
        if (!ch) {
          continue;
        }
        if (ch.data === null) {
          this.coll(s.c).delete(s.id);
        } else {
          this.coll(s.c).set(s.id, { rev: s.rev, data: ch.data });
        }
      }
      this.gen = res.gen;
      this.keyId = res.keyId || keys.id;
      const conflicts = res.conflicts || [];
      for (const it of conflicts) {
        const bucket = this.coll(it.c);
        const data = it.deleted ? null : await this._open(keys, it.c, it.id, it.blob);
        if (data) {
          bucket.set(it.id, { rev: it.rev, data });
        } else {
          bucket.delete(it.id);
        }
      }
      this._emit("data");
      if (conflicts.length) {
        throw fail("Эту запись только что изменили на другом устройстве. Проверьте её и повторите", "conflict", { conflicts: conflicts.map(c => ({ c: c.c, id: c.id })) });
      }
      // свои записи получили номера подряд за последним виденным: чужого между ними нет
      const top = Math.max(0, ...(res.saved || []).map(s => s.rev));
      if (top === this.rev + (res.saved || []).length) {
        this.rev = top;
      }
      return;
    }
  }

  put(c, id, data) {
    return this.write([{ c, id, data }]);
  }

  remove(c, id) {
    return this.write([{ c, id, data: null }]);
  }
}
