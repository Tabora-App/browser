import { tt } from "chrome://tabora/content/i18n/I18n.sys.mjs";
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Синхронизация между компьютерами одного аккаунта Tabora: пароли сайтов, коды входа, закладки,
 * пространства, ярлыки стартовой страницы и список открытых вкладок.
 *
 * Что видит сервер. Каждая запись шифруется здесь (AES-256-GCM) ключом, которого у сервера нет:
 * он выводится из ключа данных аккаунта — того же, которым защищена копия ключа почты и который
 * попадает на новый компьютер только после входа с паролем (mail/Pgp.sys.mjs). Сервер хранит
 * непрозрачные блоки и видит лишь название набора («logins», «marks»), случайный номер записи,
 * её размер (выровненный до 64 байт) и время изменения. Прочитать или подделать запись он не
 * может: блок привязан к набору и номеру.
 *
 * Как сливаются изменения. У каждой записи на сервере есть номер версии. Клиент помнит, какую
 * версию и какое содержимое (HMAC) он видел последним («тень»), и по тени отличает своё
 * изменение от чужого. Запись, изменённую только на сервере, он принимает; изменённую только
 * здесь — отправляет; изменённую с обеих сторон разрешает источник (обычно побеждает более
 * поздняя). Правила выбраны так, чтобы ошибка не стоила данных:
 *  - удаление применяется, только если здесь запись с последней сверки не менялась;
 *  - запись, которой нет на сервере, никогда не считается удалённой: первая сверка нового
 *    компьютера — объединение;
 *  - если с этого компьютера разом пропала заметная часть записей набора, удаления не
 *    отправляются, пока пользователь не решит: удалить везде или вернуть с сервера.
 *
 * Состояние (tabora-sync.json) секретов не содержит: номера версий и HMAC содержимого под
 * подключом ключа синхронизации (по ним содержимое не подобрать). Список вкладок других
 * компьютеров лежит там же зашифрованным. */

const { setTimeout, clearTimeout, setInterval } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Account: "chrome://tabora/content/account/Account.sys.mjs",
  Vault: "chrome://tabora/content/vault/Vault.sys.mjs",
  Pgp: "chrome://tabora/content/mail/Pgp.sys.mjs",
  SOURCES: "chrome://tabora/content/sync/SyncSources.sys.mjs",
});

const FILE = () => PathUtils.join(PathUtils.profileDir, "tabora-sync.json");
const FORMAT = 1;
const PREF = "tabora.sync.";
const PULL_LIMIT = 500;
const PUSH_ITEMS = 150;
const PUSH_BYTES = 2 * 1024 * 1024;
const MAX_PLAIN = 60 * 1024; // запись крупнее на сервер не уходит (предел сервера — 96 КиБ блока)
const QUIET_MS = 5000; // пауза после локального изменения перед сверкой
const PERIOD_MS = 10 * 60 * 1000;
const RETRY_MS = [30_000, 120_000, 600_000];
const MASS_MIN = 20; // столько пропавших записей набора разом уже подозрительно…
const MASS_SHARE = 0.3; // …если это больше такой доли набора
const ROUNDS = 4;

/** Что включает пользователь (настройки → Синхронизация) и какие наборы за этим стоят. */
export const GROUPS = {
  passwords: ["logins"],
  codes: ["otp"],
  bookmarks: ["marks"],
  tabs: ["spaces", "start", "tabs", "sent"],
};

const te = new TextEncoder();
const td = new TextDecoder();

function fail(text, code) {
  return Object.assign(new Error(text), { code });
}

/** JSON с ключами по алфавиту: одно и то же содержимое даёт одну и ту же строку. */
function stable(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stable).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

async function hkdf(key, salt, info) {
  const k = await crypto.subtle.importKey("raw", key, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: te.encode(salt), info: te.encode(info) }, k, 256));
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const COLL_RE = /^[a-z]{1,16}$/;

export const Sync = {
  TOPIC: "tabora-sync-changed",
  state: null,
  _keys: null,
  _running: null,
  _again: false,
  _timer: null,
  _started: false,
  _failures: 0,
  _busy: false,
  _note: null, // последнее состояние для экрана настроек: { state, error }

  notify(what = "changed") {
    Services.obs.notifyObservers(null, this.TOPIC, what);
  },

  /* ---- настройки ----------------------------------------------------------------------------- */

  /** Синхронизация включена, пока человек не выключит её сам: вошёл в аккаунт — данные общие для
   * его устройств (всё шифруется здесь ключом аккаунта). Выключение, в том числе после стирания
   * данных с сервера, записывается в настройку и сохраняется. */
  get enabled() {
    return Services.prefs.getBoolPref(`${PREF}enabled`, true);
  },

  groupOn(group) {
    return Services.prefs.getBoolPref(PREF + group, true);
  },

  /** Включить или выключить синхронизацию целиком. Данные на сервере при выключении остаются:
   * их стирает erase(). */
  setEnabled(on) {
    Services.prefs.setBoolPref(`${PREF}enabled`, !!on);
    Services.prefs.clearUserPref(`${PREF}erasedElsewhere`);
    this._failures = 0;
    this.notify("settings");
    if (on) {
      this.soon(0);
    }
  },

  setGroup(group, on) {
    if (!GROUPS[group]) {
      return;
    }
    Services.prefs.setBoolPref(PREF + group, !!on);
    this.notify("settings");
    if (!on && group === "tabs") {
      // список вкладок этого компьютера другим больше не нужен
      this._retire("tabs", lazy.Account.deviceId()).catch(() => {});
    }
    this.soon(0);
  },

  /** Наборы, которые сейчас сверяются: включены и их источник готов (сейф открыт и т. п.). */
  async _active() {
    const out = [];
    for (const [group, names] of Object.entries(GROUPS)) {
      if (!this.groupOn(group)) {
        continue;
      }
      for (const name of names) {
        const src = lazy.SOURCES[name];
        try {
          if (src && (!src.available || (await src.available()))) {
            out.push(name);
          }
        } catch (e) {}
      }
    }
    return out;
  },

  /* ---- состояние на диске ---------------------------------------------------------------------- */

  _blank() {
    return { v: FORMAT, account: lazy.Account.email || "", gen: 0, keyId: "", cur: {}, items: {}, hold: {}, cache: {}, fail: {}, at: 0 };
  },

  async _load() {
    if (this.state && this.state.account === (lazy.Account.email || "")) {
      return this.state;
    }
    let s = null;
    try {
      s = await IOUtils.readJSON(FILE());
    } catch (e) {}
    if (!s || s.v !== FORMAT || s.account !== (lazy.Account.email || "") || typeof s.items !== "object") {
      s = this._blank(); // другой аккаунт или первый запуск: сверка начнётся с объединения
    }
    for (const k of ["cur", "items", "hold", "cache", "fail"]) {
      s[k] = s[k] && typeof s[k] === "object" ? s[k] : {};
    }
    this.state = s;
    return s;
  },

  async _save() {
    if (this.state) {
      await IOUtils.writeJSON(FILE(), this.state, { tmpPath: `${FILE()}.tmp` });
      try {
        await IOUtils.setPermissions(FILE(), 0o600);
      } catch (e) {}
    }
  },

  /** Сервер начал новое поколение данных (сброс) или сменился ключ: тени больше ничему не
   * соответствуют. Локальные данные остаются, следующая сверка объединит их с сервером. */
  _forget(state, gen = 0) {
    state.gen = gen;
    state.cur = {};
    state.items = {};
    state.hold = {};
    state.fail = {};
  },

  /* ---- ключ ---------------------------------------------------------------------------------- */

  /** { id, aes, mac } или null, если ключа данных аккаунта на этом компьютере (пока) нет. */
  async _key() {
    if (this._keys) {
      return this._keys;
    }
    let data = null;
    try {
      data = await lazy.Pgp.accountDataKey();
    } catch (e) {}
    if (!data) {
      return null;
    }
    const raw = await hkdf(data, "tabora-sync/v1", `key|${lazy.Account.email.toLowerCase()}`);
    data.fill(0);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array([...te.encode("tabora-sync/key-id|"), ...raw])));
    const macRaw = await hkdf(raw, "tabora-sync/v1", "content-hash");
    const keys = {
      id: Array.from(digest.subarray(0, 8), b => b.toString(16).padStart(2, "0")).join(""),
      aes: await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]),
      mac: await crypto.subtle.importKey("raw", macRaw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
    };
    raw.fill(0);
    macRaw.fill(0);
    this._keys = keys;
    return keys;
  },

  /** Блок записи: версия формата, nonce, шифртекст. Привязан к набору и номеру записи; длина
   * открытого текста выровнена пробелами до 64 байт (JSON их не замечает). */
  async _seal(keys, coll, id, data) {
    let plain = te.encode(JSON.stringify(data));
    if (plain.length > MAX_PLAIN) {
      throw fail(tt`Запись слишком велика для синхронизации`, "too-large");
    }
    const padded = new Uint8Array(Math.ceil((plain.length + 1) / 64) * 64).fill(0x20);
    padded.set(plain);
    plain = padded;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode(`${coll}|${id}`) }, keys.aes, plain));
    const out = new Uint8Array(13 + ct.length);
    out[0] = 1;
    out.set(iv, 1);
    out.set(ct, 13);
    return out.toBase64();
  },

  async _open(keys, coll, id, blob) {
    try {
      const bytes = Uint8Array.fromBase64(blob);
      if (bytes[0] !== 1 || bytes.length < 13 + 16) {
        return null;
      }
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(1, 13), additionalData: te.encode(`${coll}|${id}`) }, keys.aes, bytes.subarray(13));
      const data = JSON.parse(td.decode(plain));
      return data && typeof data === "object" ? data : null;
    } catch (e) {
      return null;
    }
  },

  async _hash(keys, coll, src, data) {
    const text = `${coll}|${stable(src.hashable ? src.hashable(data) : data)}`;
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", keys.mac, te.encode(text)));
    return sig.subarray(0, 12).toBase64();
  },

  async _hashes(keys, coll, src, local) {
    const out = new Map();
    for (const [id, data] of local) {
      out.set(id, await this._hash(keys, coll, src, data));
    }
    return out;
  },

  /* ---- сверка --------------------------------------------------------------------------------- */

  /** Почему синхронизация сейчас не идёт, или "" (всё готово). */
  async _blocker() {
    const a = lazy.Account;
    await a.ready();
    if (!this.enabled) {
      return "off";
    }
    if (!a.signedIn) {
      return "signed-out";
    }
    if (a.isLocalMode || a.needsServerLink) {
      return "local";
    }
    await lazy.Vault.ready();
    if (!lazy.Vault.unlocked) {
      return "locked";
    }
    return (await this._key()) ? "" : "key";
  },

  /** Сверить сейчас. Одновременных сверок не бывает: вызов во время сверки ставит следующую. */
  syncNow() {
    if (this._running) {
      this._again = true;
      return this._running;
    }
    this._running = this._run().finally(() => {
      this._running = null;
      if (this._again) {
        this._again = false;
        this.soon(1000);
      }
    });
    return this._running;
  },

  async _run() {
    const blocker = await this._blocker();
    if (blocker) {
      this._set(blocker, "");
      return this.status();
    }
    this._busy = true;
    this.notify("busy");
    try {
      const state = await this._load();
      let done = false;
      for (let i = 0; i < ROUNDS && !done; i++) {
        const keys = await this._key();
        if (!keys) {
          throw fail(tt`Ключ аккаунта недоступен: введите пароль аккаунта на этом компьютере`, "sync-key");
        }
        done = await this._round(keys, state);
      }
      state.at = Date.now();
      await this._save();
      this._failures = 0;
      this._set("ok", "");
    } catch (e) {
      await this._save().catch(() => {});
      this._failed(e);
    } finally {
      this._busy = false;
      this.notify("done");
    }
    return this.status();
  },

  _failed(e) {
    if (e.code === "sync-erased") {
      Services.prefs.setBoolPref(`${PREF}enabled`, false);
      Services.prefs.setBoolPref(`${PREF}erasedElsewhere`, true);
      if (this.state) {
        this._forget(this.state, 0);
        this.state.keyId = "";
        this.state.cache = {};
        this.state.at = 0;
        this._save().catch(() => {});
      }
      this._set("off", "");
      this.notify("settings");
      return;
    }
    const offline = e.code === "offline";
    const unsupported = e.status === 404 || e.code === "no-server";
    const state = unsupported ? "unsupported" : offline ? "offline" : e.code === "sync-key" ? "key" : e.code === "session-expired" || e.code === "signed-out" ? "signed-out" : "error";
    this._set(state, state === "error" ? e.message || String(e) : "");
    if (state === "error") {
      console.error("Tabora sync", e);
    }
    if (state === "offline" || state === "error") {
      // повтор с растущей паузой; постоянная ошибка не должна стучаться на сервер каждые секунды
      this.soon(RETRY_MS[Math.min(this._failures, RETRY_MS.length - 1)]);
      this._failures++;
    }
  },

  _set(state, error) {
    const changed = !this._note || this._note.state !== state || this._note.error !== error;
    this._note = { state, error };
    if (changed) {
      this.notify("status");
    }
  },

  /** Ключ на сервере другой. Если ключ этого компьютера действующий (сверяем с копией ключа
   * аккаунта), серверные данные зашифрованы прежним ключом и никому уже не откроются:
   * начинаем новое поколение. Иначе ключа здесь пока нет: нужен пароль. */
  async _keyMismatch(state) {
    this._keys = null;
    const before = (await this._key())?.id;
    try {
      await lazy.Pgp.sync({});
    } catch (e) {}
    this._keys = null;
    const keys = await this._key();
    const backup = await lazy.Pgp.backup().catch(() => null);
    if (backup?.state === "offline") {
      throw fail(tt`Сервер Tabora не отвечает. Проверьте соединение и повторите`, "offline");
    }
    if (!keys || !backup || !["ok", "no-password"].includes(backup.state)) {
      throw fail(tt`Ключ аккаунта сменился: введите пароль аккаунта на этом компьютере`, "sync-key");
    }
    if (keys.id !== before) {
      return; // ключ только что обновился: следующий проход сверит его с сервером заново
    }
    const a = lazy.Account;
    const res = await a.backend.syncReset({ session: a._session(), keyId: keys.id });
    this._forget(state, res.gen);
    state.keyId = keys.id;
    await this._save();
  },

  /** Один проход: получить изменения, применить, отправить свои. true — сверка закончена,
   * false — нужен ещё проход (сервер успел измениться, пока мы отправляли). */
  async _round(keys, state) {
    const a = lazy.Account;
    const session = a._session();
    const active = await this._active();
    if (!active.length) {
      return true;
    }
    for (const c of active) {
      state.cur[c] ??= 0;
    }

    // 1. изменения с сервера, начиная с самой отставшей из сверяемых коллекций
    const incoming = new Map(active.map(c => [c, new Map()]));
    let since = Math.min(...active.map(c => state.cur[c]));
    let serverRev = since;
    for (;;) {
      const res = await a.backend.syncPull({ session, since, limit: PULL_LIMIT });
      if (!res || !Number.isInteger(res.rev) || !Number.isInteger(res.gen) || !Array.isArray(res.items)) {
        throw fail(tt`Сервер Tabora ответил непонятно. Повторите позже`, "bad-response");
      }
      if (res.keyId && res.keyId !== keys.id) {
        await this._keyMismatch(state);
        return false;
      }
      if (res.gen !== state.gen) {
        if (state.gen && state.keyId && !res.keyId) {
          // данные стёрты с сервера с другого компьютера («Стереть с сервера»): заливать их обратно
          // нельзя, синхронизация выключается и здесь
          throw fail(tt`Данные синхронизации стёрты с сервера с другого компьютера`, "sync-erased");
        }
        const first = !state.gen && !Object.keys(state.items).length;
        this._forget(state, res.gen);
        active.forEach(c => (state.cur[c] = 0));
        if (!first || since) {
          return false; // данные на сервере начаты заново: проход с начала
        }
      }
      for (const it of res.items) {
        if (!COLL_RE.test(it.c || "") || !ID_RE.test(it.id || "") || !Number.isInteger(it.rev)) {
          continue;
        }
        since = Math.max(since, it.rev);
        const bucket = incoming.get(it.c);
        if (!bucket || it.rev <= state.cur[it.c]) {
          continue; // набор выключен или запись уже применена
        }
        if (it.deleted) {
          bucket.set(it.id, { rev: it.rev, deleted: true });
          continue;
        }
        const data = await this._open(keys, it.c, it.id, it.blob);
        if (data) {
          bucket.set(it.id, { rev: it.rev, data });
        }
        // блок не открылся (повреждён): запись пропускается, локальная копия не трогается
      }
      serverRev = res.rev;
      if (!res.more || !res.items.length) {
        break;
      }
    }
    state.keyId = keys.id;

    // 2. по наборам: применить чужое, отправить своё
    let clean = true;
    let pushed = 0;
    let lastRev = serverRev;
    // nothing has been read from the server here yet (sync has just been turned on, or the server
    // data was started anew): what arrives in this pass was there before this computer joined
    const first = !Object.values(state.cur).some(rev => rev > 0);
    for (const c of active) {
      const result = await this._collection(keys, state, c, incoming.get(c), { first });
      clean &&= result.clean;
      pushed += result.saved;
      lastRev = Math.max(lastRev, result.rev);
      // всё, что пришло в этом проходе, применено
      state.cur[c] = serverRev;
      await this._save();
    }
    if (clean && lastRev === serverRev + pushed) {
      // между получением и отправкой на сервере ничего чужого не появилось: свои записи заново не читаем
      for (const c of active) {
        state.cur[c] = lastRev;
      }
    }
    return clean;
  },

  async _collection(keys, state, c, incoming, { first = false } = {}) {
    const src = lazy.SOURCES[c];
    const a = lazy.Account;
    const shadow = (state.items[c] ||= {});
    const owns = id => !src.owns || src.owns(id);
    if (src.restore && !src._restored) {
      src._restored = true;
      const saved = state.cache[c] ? await this._open(keys, "cache", c, state.cache[c]) : null;
      if (saved) {
        src.restore(saved);
      }
    }

    // --- применить чужое ---
    let local = await src.list();
    if (src.unsaved && src.dump) {
      // the source changed what it keeps in its copy by itself (sent tabs: the outbox, what was opened)
      src.unsaved = false;
      state.cache[c] = await this._seal(keys, "cache", c, src.dump());
    }
    let hashes = await this._hashes(keys, c, src, local);
    const apply = [];
    const applied = new Map(); // id → { rev, hash } пришедшей записи
    for (const [id, r] of incoming) {
      const s = shadow[id];
      const has = local.has(id);
      const hL = hashes.get(id);
      if (!owns(id)) {
        apply.push({ id, data: r.deleted ? null : r.data });
        shadow[id] = [r.rev, r.deleted ? "" : "-"];
        continue;
      }
      if (r.deleted) {
        if (has && s && s[1] && s[1] === hL) {
          apply.push({ id, data: null });
          applied.set(id, { rev: r.rev, hash: "" });
        } else {
          // здесь записи нет — или она изменена после последней сверки и остаётся (уйдёт на сервер заново)
          shadow[id] = [r.rev, ""];
        }
        continue;
      }
      const hR = await this._hash(keys, c, src, r.data);
      if (has && hL === hR) {
        shadow[id] = [r.rev, hR];
        continue;
      }
      const changedHere = has && (!s || s[1] !== hL);
      if (changedHere && src.newer?.(local.get(id), r.data)) {
        shadow[id] = [r.rev, hR]; // побеждает здешняя: её хеш отличается от тени, она уйдёт на сервер
        continue;
      }
      apply.push({ id, data: r.data });
      applied.set(id, { rev: r.rev, hash: hR });
    }
    if (apply.length) {
      const fresh = new Set(Object.keys(shadow).filter(id => shadow[id][1]));
      const out = (await src.apply(apply, { synced: id => fresh.has(id), first })) || {};
      const dirty = new Set(out.dirty || []);
      local = await src.list();
      hashes = await this._hashes(keys, c, src, local);
      const failed = (state.fail[c] ||= {});
      for (const [id, r] of applied) {
        if (!r.hash) {
          // удаление: если источник запись оставил (в пространстве открыты вкладки), она уйдёт на
          // сервер заново и вернётся на остальные компьютеры
          shadow[id] = [r.rev, ""];
        } else if (!local.has(id)) {
          // запись не легла (источник отказал): не считаем её удалённой здесь и повторим позже
          shadow[id] = [r.rev, "!"];
          failed[id] = (failed[id] || 0) + 1;
        } else {
          // в тень идёт то, что получилось здесь: мелкая нормализация источника не должна вернуться
          // на сервер как «изменение»; исключение — источник сам просит отправить свою версию
          shadow[id] = [r.rev, dirty.has(id) ? r.hash : hashes.get(id)];
          delete failed[id];
        }
      }
      if (src.dump) {
        state.cache[c] = await this._seal(keys, "cache", c, src.dump());
      }
      Services.obs.notifyObservers(null, "tabora-sync-applied", c);
    }

    // --- отправить своё ---
    const push = [];
    for (const [id, data] of local) {
      if (!owns(id)) {
        continue;
      }
      const s = shadow[id];
      const h = hashes.get(id);
      if (!s || s[1] !== h) {
        push.push({ id, base: s ? s[0] : 0, data, h });
      }
    }
    const live = Object.keys(shadow).filter(id => owns(id) && shadow[id][1] && shadow[id][1] !== "!");
    const gone = live.filter(id => !local.has(id));
    if (gone.length >= MASS_MIN && gone.length > live.length * MASS_SHARE && state.hold[c]?.allow !== true) {
      state.hold[c] = { missing: gone.length, of: live.length, at: Date.now() };
    } else {
      delete state.hold[c];
      gone.forEach(id => push.push({ id, base: shadow[id][0], deleted: true }));
    }

    let clean = true;
    let saved = 0;
    let rev = 0;
    while (push.length) {
      const batch = [];
      let bytes = 0;
      while (push.length && batch.length < PUSH_ITEMS && bytes < PUSH_BYTES) {
        const p = push.shift();
        let blob = null;
        if (!p.deleted) {
          try {
            blob = await this._seal(keys, c, p.id, p.data);
          } catch (e) {
            shadow[p.id] = [p.base, p.h]; // слишком велика: не пытаться отправлять её каждый раз
            continue;
          }
          bytes += blob.length;
        }
        batch.push({ c, id: p.id, base: p.base, ...(p.deleted ? { deleted: true } : { blob }), _h: p.h });
      }
      if (!batch.length) {
        break;
      }
      let res;
      try {
        res = await a.backend.syncPush({ session: a._session(), gen: state.gen, keyId: keys.id, items: batch.map(({ _h, ...it }) => it) });
      } catch (e) {
        if (e.code === "sync-reset") {
          this._forget(state, 0);
          return { clean: false, saved, rev };
        }
        if (e.code === "sync-key") {
          await this._keyMismatch(state);
          return { clean: false, saved, rev };
        }
        throw e;
      }
      const byId = new Map(batch.map(it => [it.id, it]));
      for (const s of res.saved || []) {
        const it = byId.get(s.id);
        if (it && Number.isInteger(s.rev)) {
          shadow[s.id] = [s.rev, it.deleted ? "" : it._h];
          saved++;
        }
      }
      for (const conflict of res.conflicts || []) {
        clean = false; // запись изменили на сервере, пока мы шли: следующий проход прочитает её
        if (conflict?.rev === 0 && shadow[conflict.id]) {
          delete shadow[conflict.id]; // на сервере записи нет вовсе: в следующем проходе она уйдёт как новая
        }
      }
      rev = Math.max(rev, res.rev || 0);
    }
    return { clean, saved, rev };
  },

  /** Убрать с сервера одну свою запись (список вкладок этого компьютера, когда набор выключен). */
  async _retire(c, id) {
    if (await this._blocker()) {
      return;
    }
    const a = lazy.Account;
    const state = await this._load();
    const s = state.items[c]?.[id];
    if (!s || !s[1]) {
      return;
    }
    const keys = await this._key();
    const res = await a.backend.syncPush({ session: a._session(), gen: state.gen, keyId: keys.id, items: [{ c, id, base: s[0], deleted: true }] });
    const saved = (res.saved || [])[0];
    if (saved) {
      state.items[c][id] = [saved.rev, ""];
      await this._save();
    }
  },

  /* ---- для экрана настроек -------------------------------------------------------------------- */

  /** { enabled, state, error, at, busy, groups: { passwords: { on, count, hold }, … } }.
   * state: off, ok, signed-out, local, locked (сейф закрыт), key (нужен пароль аккаунта),
   * unsupported (сервер ещё не умеет), offline, error, unknown (ещё не сверялись). */
  status() {
    const s = this.state;
    const groups = {};
    for (const [group, names] of Object.entries(GROUPS)) {
      let count = 0;
      let hold = null;
      for (const name of names) {
        const src = lazy.SOURCES[name];
        const items = s?.items?.[name] || {};
        count += Object.keys(items).filter(id => items[id][1] && items[id][1] !== "!" && (name !== "tabs" || !src?.owns || src.owns(id))).length;
        if (s?.hold?.[name] && s.hold[name].allow !== true) {
          hold = { name, ...s.hold[name] };
        }
      }
      groups[group] = { on: this.groupOn(group), count, hold };
    }
    return {
      enabled: this.enabled,
      state: !this.enabled ? "off" : this._note?.state || "unknown",
      error: this._note?.error || "",
      at: s?.at || 0,
      busy: this._busy,
      // синхронизацию выключило стирание данных с другого компьютера
      erased: !this.enabled && Services.prefs.getBoolPref(`${PREF}erasedElsewhere`, false),
      groups,
    };
  },

  /** status() с состоянием, прочитанным с диска (первый показ настроек до первой сверки). */
  async overview() {
    try {
      await lazy.Account.ready();
      if (lazy.Account.signedIn) {
        await this._load();
      }
    } catch (e) {}
    return this.status();
  },

  /** Решение пользователя о массово пропавших записях набора: удалить их везде ("delete") или
   * вернуть с сервера ("restore"). */
  async resolveHold(name, what) {
    const state = await this._load();
    const src = lazy.SOURCES[name];
    if (!state.hold[name] || !src) {
      return;
    }
    if (what === "delete") {
      state.hold[name] = { ...state.hold[name], allow: true };
    } else {
      const shadow = state.items[name] || {};
      const local = await src.list();
      for (const id of Object.keys(shadow)) {
        if (shadow[id][1] && !local.has(id)) {
          delete shadow[id]; // записи с сервера придут заново как новые
        }
      }
      state.cur[name] = 0;
      delete state.hold[name];
    }
    await this._save();
    this.notify("status");
    await this.syncNow();
  },

  /** Выключить синхронизацию и стереть её данные с сервера. Данные на компьютерах остаются. */
  async erase() {
    const a = lazy.Account;
    await a.ready();
    await a.backend.syncErase({ session: a._session() });
    Services.prefs.setBoolPref(`${PREF}enabled`, false);
    const state = await this._load();
    this._forget(state, 0);
    state.cache = {};
    state.at = 0;
    await this._save();
    this._set("off", "");
    this.notify("settings");
  },

  /** Вкладки других компьютеров аккаунта: [{ id, name, at, tabs: [{ t, u, p }] }]. */
  devicesTabs() {
    return this.groupOn("tabs") && this.enabled ? lazy.SOURCES.tabs.others() : [];
  },

  /** Other devices of the account that a page can be sent to: [{ id, name, at }]. */
  devices() {
    return this.groupOn("tabs") && this.enabled ? lazy.SOURCES.tabs.devices() : [];
  },

  /** Send a page to another device of the account: it opens there on that device's next sync.
   * Resolves to "" once the page is on the server, otherwise to the reason it is not: a sync
   * state ("locked", "offline", "error", …) or "off". A page that did not get there is not kept. */
  async sendTab(to, { url, title = "" } = {}) {
    const src = lazy.SOURCES.sent;
    const id = this.groupOn("tabs") && this.enabled ? src.send(to, url, title) : "";
    if (!id) {
      return "off";
    }
    const me = lazy.Account.deviceId();
    const pushed = async () => {
      const keys = await this._key();
      const data = (await src.list()).get(me);
      const shadow = (await this._load()).items.sent?.[me];
      return !!(keys && data && shadow && shadow[1] === (await this._hash(keys, "sent", src, data)));
    };
    try {
      // a pass that was already running may have gone past this collection: one more then
      for (let i = 0; i < 2; i++) {
        await this.syncNow();
        if (await pushed()) {
          return "";
        }
      }
    } catch (e) {
      console.error("Tabora sync: send tab", e);
    }
    src.unsend(id);
    return this._note?.state && this._note.state !== "ok" ? this._note.state : "error";
  },

  /* ---- расписание ---------------------------------------------------------------------------- */

  soon(delay = QUIET_MS) {
    if (!this._started) {
      return;
    }
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      if (this.enabled) {
        this.syncNow().catch(e => console.error("Tabora sync", e));
      } else {
        this._set("off", "");
      }
    }, delay);
  },

  /** Один раз на процесс: подписки на изменения и периодическая сверка. */
  start() {
    if (this._started) {
      return;
    }
    this._started = true;
    const forgetKey = () => {
      this._keys = null;
    };
    const observer = {
      observe: (subject, topic, data) => {
        if (topic === lazy.Vault.TOPIC) {
          if (["locked", "reset", "rekeying"].includes(data)) {
            forgetKey();
          }
          if (data === "unlocked" || data === "locked") {
            this.soon(1500);
          }
        } else if (topic === lazy.Account.TOPIC) {
          // важны только вход, выход и смена аккаунта; прочие перемены в аккаунте сверку не будят
          const who = `${lazy.Account.signedIn ? "in" : "out"}|${lazy.Account.email || ""}`;
          if (who !== this._who) {
            this._who = who;
            forgetKey();
            this.state = null;
            this._failures = 0;
            this.soon(2000);
          }
        } else if (topic === lazy.Pgp.TOPIC) {
          if (data === "backup") {
            forgetKey(); // ключ данных мог появиться или смениться
            if (this._note?.state === "key") {
              this.soon(500);
            }
          }
        }
      },
    };
    for (const topic of [lazy.Vault.TOPIC, lazy.Account.TOPIC, lazy.Pgp.TOPIC]) {
      Services.obs.addObserver(observer, topic);
    }
    for (const src of Object.values(lazy.SOURCES)) {
      try {
        src.watch?.(() => this.enabled && this.soon());
      } catch (e) {
        console.error("Tabora sync: источник не наблюдается", src.name, e);
      }
    }
    setInterval(() => this.enabled && this.soon(0), PERIOD_MS);
    this.soon(8000);
  },
};
