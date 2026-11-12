import { tt } from "chrome://tabora/content/i18n/I18n.sys.mjs";
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* OpenPGP для почты Tabora: свой ключ аккаунта, ключи собеседников, шифрование, расшифровка
 * и подписи писем.
 *
 * Сама криптография — библиотека OpenPGP.js в отдельном документе без прав браузера и без сети
 * (mail/pgp/host.html): этот модуль передаёт туда ключи и данные на время одной операции.
 * Закрытый ключ аккаунта и ключи собеседников лежат в tabora-pgp.json целиком зашифрованными
 * подключом сейфа («pgp»): без входа в аккаунт и открытого сейфа их нет ни на чтение, ни на
 * подмену. Ключи собеседников приходят из заголовка Autocrypt их писем и из ручного импорта;
 * доверие к ним — по первому появлению, отпечаток можно сверить в настройках шифрования.
 *
 * Письмо шифруется всем получателям и себе (иначе не прочитать собственную копию в
 * «Отправленных») и всегда подписывается. Тема письма остаётся открытой: шифруется только
 * содержимое.
 *
 * Копия на сервере (sync). Чтобы ключ не пропал вместе с компьютером и появился на другом после
 * входа, сервер аккаунтов хранит его копию: закрытый ключ зашифрован случайным ключом данных,
 * ключ данных — ключом из пароля аккаунта (Account.loginHash выводит его тем же тяжёлым KDF,
 * что и хеш входа, но с другой меткой) и, отдельно, ключом из ключа восстановления. Сервер не
 * знает ни пароля, ни ключа восстановления и прочитать копию не может. Открытый ключ сервер
 * публикует в каталоге (WKD): по нему письма между адресами Tabora шифруются с первого письма. */

const { Vault, writeJsonVerified } = ChromeUtils.importESModule("chrome://tabora/content/vault/Vault.sys.mjs");
const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Account: "chrome://tabora/content/account/Account.sys.mjs",
});

const FILE = () => PathUtils.join(PathUtils.profileDir, "tabora-pgp.json");
const INFO = "pgp"; // подключ сейфа, которым зашифрован файл ключей
const FORMAT = 1;
const HOST = "resource://tabora-pgp/host.html";
const HOST_ORIGIN = "resource://tabora-pgp";
const HOST_IDLE_MS = 5 * 60000;
const MAX_KEY_CHARS = 64 * 1024;
const MAX_PEERS = 2000;
const ARMOR_RE = /-----BEGIN PGP PUBLIC KEY BLOCK-----[\s\S]+?-----END PGP PUBLIC KEY BLOCK-----/;
const DIRECTORY_FRESH_MS = 24 * 3600000; // как часто ключ адреса Tabora сверяется с каталогом
const DIRECTORY_MISS_MS = 10 * 60000; // сколько помнить, что ключа в каталоге нет
const MAX_RETIRED = 8;
const ADDRESS_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

function fail(text, code = "pgp") {
  return Object.assign(new Error(text), { code });
}

function clean(address) {
  return String(address || "").trim().toLowerCase();
}

function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function base64ToBytes(text) {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

/** Тело брони без заголовков и контрольной суммы: это и есть Base64 двоичного ключа. */
function armorBody(armored) {
  const lines = String(armored).replace(/\r/g, "").split("\n");
  const start = lines.findIndex(l => l.startsWith("-----BEGIN "));
  const end = lines.findIndex(l => l.startsWith("-----END "));
  if (start < 0 || end < start) {
    return "";
  }
  const body = lines.slice(start + 1, end);
  const blank = body.indexOf("");
  return body
    .slice(blank >= 0 ? blank + 1 : 0)
    .filter(l => l && !l.startsWith("="))
    .join("");
}

function armorKey(base64) {
  return `-----BEGIN PGP PUBLIC KEY BLOCK-----\n\n${base64.replace(/(.{64})/g, "$1\n").trim()}\n-----END PGP PUBLIC KEY BLOCK-----\n`;
}

/** z-base-32 от SHA-1 имени ящика: имя записи в каталоге ключей (WKD). */
async function directoryHash(local) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(local)));
  const abc = "ybndrfg8ejkmcpqxot1uwisza345h769";
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const b of digest) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += abc[(acc >> bits) & 31];
    }
    acc &= (1 << bits) - 1;
  }
  return bits ? out + abc[(acc << (5 - bits)) & 31] : out;
}

/** AES-256-GCM: nonce (12 байт) и шифртекст с меткой. label привязывает блок к назначению и
 * адресу: блок, подставленный не на своё место, не расшифруется. */
async function sealBytes(key, label, plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const k = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(label) }, k, plain));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return out;
}

async function openBytes(key, label, blob) {
  if (!key || !blob || blob.length < 28) {
    return null;
  }
  try {
    const k = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: blob.subarray(0, 12), additionalData: new TextEncoder().encode(label) }, k, blob.subarray(12)));
  } catch (e) {
    return null;
  }
}

function fromBase64(text) {
  try {
    return typeof text === "string" && text ? base64ToBytes(text) : null;
  } catch (e) {
    return null;
  }
}

function sameBytes(a, b) {
  return !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);
}

export function formatFingerprint(fp) {
  return String(fp || "").toUpperCase().replace(/(.{4})/g, "$1 ").trim();
}

export const Pgp = {
  TOPIC: "tabora-pgp-changed",
  data: null,
  _loading: null,
  _host: null,
  _starting: null,
  _writing: Promise.resolve(),

  notify(what = "changed") {
    Services.obs.notifyObservers(null, this.TOPIC, what);
  },

  /* ---- исполнитель: отдельный документ без прав и без сети -------------------------------- */

  async _window() {
    if (this._host) {
      this._touch();
      return this._host.win;
    }
    this._starting ||= (async () => {
      const res = Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler);
      if (!res.hasSubstitution("tabora-pgp")) {
        const dir = Cc["@mozilla.org/chrome/chrome-registry;1"].getService(Ci.nsIChromeRegistry).convertChromeURL(Services.io.newURI("chrome://tabora/content/mail/pgp/"));
        res.setSubstitutionWithFlags("tabora-pgp", dir, 0); // сайтам этот адрес недоступен
      }
      const wb = Services.appShell.createWindowlessBrowser(false);
      try {
        wb.browsingContext.forceOffline = true;
        wb.browsingContext.loadURI(Services.io.newURI(HOST), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
        const win = await new Promise((resolve, reject) => {
          const started = Date.now();
          const poll = () => {
            let w = null;
            try {
              w = wb.document?.documentURI === HOST ? wb.document.defaultView : null;
            } catch (e) {}
            if (w?.wrappedJSObject?.pgpReady === true) {
              resolve(w);
            } else if (Date.now() - started > 15000) {
              reject(fail(tt`Модуль шифрования не запустился`));
            } else {
              setTimeout(poll, 40);
            }
          };
          poll();
        });
        // исполнитель обязан остаться обычной страницей со своим адресом: без прав оболочки
        const p = wb.document.nodePrincipal;
        if (p.isSystemPrincipal || p.isNullPrincipal || p.origin !== HOST_ORIGIN || !win.isSecureContext) {
          throw fail(tt`Модуль шифрования запущен не в изолированном документе`);
        }
        this._host = { wb, win, timer: null };
        this._touch();
        return win;
      } catch (e) {
        wb.close();
        throw e;
      }
    })().finally(() => {
      this._starting = null;
    });
    return this._starting;
  },

  _touch() {
    clearTimeout(this._host.timer);
    this._host.timer = setTimeout(() => this._closeHost(), HOST_IDLE_MS);
  },

  _closeHost() {
    const h = this._host;
    this._host = null;
    if (h) {
      clearTimeout(h.timer);
      try {
        h.wb.close();
      } catch (e) {}
    }
  },

  /** Вызов исполнителя. Ответ — недоверенная строка: разбирается как JSON, поля проверяет вызывающий. */
  async _call(method, args = {}, timeoutMs = 120000) {
    const win = await this._window();
    const text = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(fail(tt`Шифрование не ответило вовремя`)), timeoutMs);
      try {
        win.wrappedJSObject.pgpCall(
          JSON.stringify({ method, args }),
          Cu.exportFunction(s => {
            clearTimeout(timer);
            resolve(String(s));
          }, win)
        );
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
    let r = null;
    try {
      r = JSON.parse(text);
    } catch (e) {}
    if (!r || r.ok !== true || typeof r.value !== "object" || !r.value) {
      throw Object.assign(fail(tt`Операция шифрования не выполнена`), { detail: String(r?.error || "").slice(0, 300) });
    }
    return r.value;
  },

  /* ---- хранилище ключей -------------------------------------------------------------------- */

  _require() {
    if (!lazy.Account.signedIn) {
      throw fail(tt`Шифрование писем доступно после входа в аккаунт Tabora`, "signed-out");
    }
    Vault.requireUnlocked();
  },

  async ready() {
    await lazy.Account.ready();
    this._require();
    if (this.data) {
      return this.data;
    }
    this._loading ||= this._load().finally(() => {
      this._loading = null;
    });
    return this._loading;
  },

  async _load() {
    let data = null;
    try {
      const file = await IOUtils.readJSON(FILE());
      if (file?.v === FORMAT && file.enc) {
        const bytes = await Vault.decrypt(INFO, file.enc);
        data = JSON.parse(new TextDecoder().decode(bytes));
        bytes.fill(0);
      }
    } catch (e) {
      if (!(DOMException.isInstance(e) && e.name === "NotFoundError")) {
        // файл есть, но не читается этим ключом сейфа: не затираем его молча новым
        const kept = `${FILE()}.unreadable-${Date.now()}`;
        await IOUtils.move(FILE(), kept).catch(() => {});
        console.error("Tabora pgp: файл ключей не читается и отложен", e);
      }
    }
    if (!data || typeof data !== "object" || typeof data.own !== "object" || typeof data.peers !== "object") {
      data = { own: {}, peers: {} };
    }
    this.data = data;
    if (!this._observing) {
      this._observing = true;
      const forget = (s, t, what) => {
        if (what === "locked" || what === "reset" || what === "signed-out") {
          this.forget();
        }
      };
      Services.obs.addObserver(forget, Vault.TOPIC);
      Services.obs.addObserver(forget, lazy.Account.TOPIC);
    }
    return data;
  },

  /** Выход из аккаунта или блокировка сейфа: ключей в памяти не остаётся. */
  forget() {
    this.data = null;
    this._recoveryStash?.fill(0);
    this._recoveryStash = null;
    this._closeHost();
  },

  _save() {
    this._writing = this._writing
      .then(async () => {
        if (!this.data || !Vault.unlocked) {
          return;
        }
        const bytes = new TextEncoder().encode(JSON.stringify(this.data));
        const enc = await Vault.encrypt(INFO, bytes);
        bytes.fill(0);
        await writeJsonVerified(FILE(), { v: FORMAT, enc });
      })
      .catch(e => console.error("Tabora pgp: ключи не сохранены", e));
    return this._writing;
  },

  /* ---- свой ключ --------------------------------------------------------------------------- */

  /** Сведения о своём ключе для адреса (по умолчанию — адрес аккаунта) или null. */
  async own(address = lazy.Account.email) {
    const d = await this.ready();
    const k = d.own[clean(address)];
    return k ? { address: clean(address), fingerprint: k.fingerprint, created: k.created, publicKey: k.publicKey } : null;
  },

  /** Ключ аккаунта: создаётся при первом обращении. Возвращает сведения о нём. */
  async ensureKey() {
    const d = await this.ready();
    const address = clean(lazy.Account.email);
    if (!d.own[address]) {
      this._creating ||= (async () => {
        const r = await this._call("generate", { email: address });
        const info = this._usable(r.info, address);
        if (typeof r.privateKey !== "string" || !r.privateKey.includes("PRIVATE KEY BLOCK")) {
          throw fail(tt`Ключ не создан`);
        }
        d.own[address] = { fingerprint: info.fingerprint, keyId: info.keyId, subkeyIds: info.subkeyIds, created: info.created, publicKey: info.armored, privateKey: r.privateKey };
        await this._save();
        this.notify("own");
      })().finally(() => {
        this._creating = null;
      });
      await this._creating;
    }
    return this.own(address);
  },

  /** Ключ аккаунта для работы с почтой: сначала сверка с сервером (у аккаунта уже может быть
   * ключ, созданный на другом компьютере), и только если ключа нет нигде — новый. Возвращает
   * сведения о ключе или null, когда ключ аккаунта есть на сервере, а открыть его здесь нечем. */
  async accountKey() {
    const d = await this.ready();
    const address = clean(lazy.Account.email);
    const b = d.backup || {};
    const state = b.state || "unknown";
    const age = Date.now() - (b.at || 0);
    // не чаще раза в минуту: сервер может быть недоступен, а спрашивают ключ на каждое письмо.
    // Сервер, который копий ещё не хранит, спрашиваем раз в час: после его обновления открытый
    // ключ попадёт в каталог сам.
    if (((!d.own[address] || ["unknown", "offline", "locked"].includes(state)) && age > 60000) || (state === "unsupported" && age > 3600000)) {
      await this.sync().catch(() => null);
    }
    if (d.backup?.state === "locked") {
      return null;
    }
    if (!d.own[address]) {
      await this.ensureKey(); // сервер недоступен или не хранит копии: ключ живёт здесь
    }
    return this.own(address);
  },

  /** Заменить свой ключ готовым (перенос с другого компьютера): броня закрытого ключа. */
  async importOwn(privateArmored) {
    const d = await this.ready();
    const address = clean(lazy.Account.email);
    const text = String(privateArmored || "");
    if (text.length > MAX_KEY_CHARS || !text.includes("PRIVATE KEY BLOCK")) {
      throw fail(tt`Это не закрытый ключ OpenPGP`);
    }
    const { keys } = await this._call("info", { armored: text });
    const info = this._usable(keys?.[0], address);
    if (!info.private) {
      throw fail(tt`Это не закрытый ключ OpenPGP`);
    }
    d.own[address] = { fingerprint: info.fingerprint, keyId: info.keyId, subkeyIds: info.subkeyIds, created: info.created, publicKey: info.armored, privateKey: text };
    await this._save();
    this.notify("own");
    return this.own(address);
  },

  /** Броня закрытого ключа: для резервной копии и переноса. Вызывающий отвечает за то, где она окажется. */
  async exportOwn(address = lazy.Account.email) {
    const d = await this.ready();
    const k = d.own[clean(address)];
    if (!k) {
      throw fail(tt`У этого адреса нет ключа`);
    }
    return k.privateKey;
  },

  /** Сведения исполнителя о ключе годятся, только если ключ действует и им можно шифровать. */
  _usable(info, address = "") {
    const ok =
      info &&
      typeof info === "object" &&
      /^[0-9a-f]{40,64}$/.test(info.fingerprint || "") &&
      /^[0-9a-f]{16}$/.test(info.keyId || "") &&
      Array.isArray(info.subkeyIds) &&
      Array.isArray(info.emails) &&
      typeof info.armored === "string" &&
      ARMOR_RE.test(info.armored);
    if (!ok) {
      throw fail(tt`Ключ не разобран`);
    }
    if (info.revoked) {
      throw fail(tt`Ключ отозван владельцем`);
    }
    if (info.expired) {
      throw fail(tt`Срок действия ключа истёк`);
    }
    if (!info.canEncrypt) {
      throw fail(tt`Этим ключом нельзя шифровать`);
    }
    if (address && info.emails.length && !info.emails.includes(clean(address))) {
      throw fail(tt`Ключ выпущен для другого адреса: ${info.emails.slice(0, 3).join(", ")}`);
    }
    return { ...info, subkeyIds: info.subkeyIds.filter(x => /^[0-9a-f]{16}$/.test(x)).slice(0, 16), created: String(info.created || "").slice(0, 30) };
  },

  /* ---- ключи собеседников ------------------------------------------------------------------ */

  /** Ключ собеседника или null: { address, fingerprint, source, prefer, seen, publicKey }. */
  async peer(address) {
    const d = await this.ready();
    const k = d.peers[clean(address)];
    return k ? { address: clean(address), ...k } : null;
  },

  async peers() {
    const d = await this.ready();
    return Object.entries(d.peers)
      .map(([address, k]) => ({ address, fingerprint: k.fingerprint, source: k.source, prefer: k.prefer, seen: k.seen }))
      .sort((a, b) => a.address.localeCompare(b.address));
  },

  /** Запомнить ключ собеседника. source: "autocrypt" | "manual"; prefer: "mutual" — собеседник
   * просит шифровать ему по умолчанию. Ключ, внесённый вручную, письма не заменяют. */
  async setPeer(address, armored, { source = "manual", prefer = "", seen = Date.now() } = {}) {
    const d = await this.ready();
    const a = clean(address);
    const text = String(armored || "");
    if (!ADDRESS_RE.test(a) || a.length > 254) {
      throw fail(tt`Некорректный адрес`);
    }
    if (text.length > MAX_KEY_CHARS || !ARMOR_RE.test(text)) {
      throw fail(tt`Это не открытый ключ OpenPGP`);
    }
    const { keys } = await this._call("info", { armored: text.match(ARMOR_RE)[0] });
    const info = this._usable(keys?.[0], source === "autocrypt" ? "" : a);
    const prior = d.peers[a];
    if (source !== "manual" && prior?.source === "manual" && prior.fingerprint !== info.fingerprint) {
      return { ...prior, address: a, kept: true }; // ключ, сверенный человеком, письмо не подменит
    }
    if (source === "autocrypt" && prior?.source === "directory" && prior.fingerprint !== info.fingerprint) {
      return { ...prior, address: a, kept: true }; // для адресов Tabora верен каталог: письмо его не подменит
    }
    if (!prior && Object.keys(d.peers).length >= MAX_PEERS) {
      throw fail(tt`Ключей собеседников слишком много: удалите ненужные`);
    }
    d.peers[a] = { fingerprint: info.fingerprint, keyId: info.keyId, subkeyIds: info.subkeyIds, publicKey: info.armored, source, prefer: prefer === "mutual" ? "mutual" : "", seen, changed: prior && prior.fingerprint !== info.fingerprint ? Date.now() : prior?.changed || 0 };
    if (source === "directory") {
      d.peers[a].checked = Date.now();
    }
    await this._save();
    this.notify("peers");
    return { ...d.peers[a], address: a };
  },

  async removePeer(address) {
    const d = await this.ready();
    if (delete d.peers[clean(address)]) {
      await this._save();
      this.notify("peers");
    }
  },

  /* ---- каталог ключей: адреса своего домена --------------------------------------------------- */

  _misses: new Map(),

  /** Ключи адресов Tabora берутся из каталога сервера: письмо шифруется с первого раза, без
   * обмена письмами. Спрашиваются адреса без ключа и те, чей ключ давно не сверяли; ключ,
   * внесённый вручную, каталог не трогает. Ошибки сети не мешают: письмо уйдёт как раньше. */
  async lookupMissing(addresses) {
    const d = await this.ready();
    const domain = lazy.Account.domain;
    const own = clean(lazy.Account.email);
    const now = Date.now();
    const todo = [...new Set((addresses || []).map(clean))].filter(a => {
      const [local, host, extra] = a.split("@");
      const k = d.peers[a];
      return local && host === domain && extra === undefined && a !== own && k?.source !== "manual" && now - (k?.checked || 0) > DIRECTORY_FRESH_MS && now - (this._misses.get(a) || 0) > DIRECTORY_MISS_MS;
    });
    await Promise.all(todo.slice(0, 20).map(async a => {
      try {
        const local = a.split("@")[0];
        const bytes = await lazy.Account.backend.directoryKey({ local, hash: await directoryHash(local) });
        if (!bytes) {
          this._misses.set(a, now);
          return;
        }
        await this.setPeer(a, armorKey(bytesToBase64(bytes)), { source: "directory", prefer: "mutual" });
      } catch (e) {
        this._misses.set(a, now); // сервер недоступен или ключ негоден: не спрашивать на каждое нажатие
      }
    }));
  },

  /* ---- копия ключа на сервере ------------------------------------------------------------------ */

  _syncing: Promise.resolve(),

  /** Состояние копии для экрана ключей: { state, at, canPassword, canRecovery }.
   * state: "ok" — копия на сервере, новый компьютер получит ключ после входа; "no-password" —
   * копия есть, но не привязана к паролю (пароль в этом профиле ещё не вводили); "locked" — у
   * аккаунта на сервере другой ключ, а открыть его копию здесь нечем; "unsupported" — сервер ещё
   * не умеет; "offline" — сервер недоступен; "local" — аккаунт не подключён к серверу. */
  async backup() {
    const d = await this.ready();
    const b = d.backup || {};
    return { state: b.state || "unknown", at: b.at || 0, canPassword: !!b.canPassword, canRecovery: !!b.canRecovery };
  },

  /** Ключ данных аккаунта (32 байта, копия): один на все компьютеры аккаунта, на новый приходит
   * после входа с паролем (см. sync). Из него выводится ключ синхронизации (sync/Sync.sys.mjs).
   * null, пока копия ключа не сохранена на сервере или открыть её на этом компьютере нечем. */
  async accountDataKey() {
    const d = await this.ready();
    const b = d.backup || {};
    if (!b.dataKey || !(b.rev > 0) || ["locked", "local", "unknown"].includes(b.state || "unknown")) {
      return null;
    }
    return fromBase64(b.dataKey);
  },

  /** Сверить ключ аккаунта с сервером: забрать копию (новый компьютер), сохранить её (ключ создан
   * здесь), обновить обёртки ключа данных. passwordKey и loginHash — ключ из пароля и хеш входа,
   * когда пароль только что подтверждён; recoveryKey — ключ из ключа восстановления; recoveryGone —
   * ключ восстановления отозван; strict — пароль ввёл пользователь, непригодность пароля должна
   * стать ошибкой; replace — заменить ключ на сервере (прежний потерян). Возвращает backup(). */
  sync(opts = {}) {
    const run = this._syncing.then(() => this._sync(opts));
    this._syncing = run.catch(() => {});
    return run;
  },

  async _sync({ passwordKey = null, loginHash = "", recoveryKey = null, recoveryGone = false, strict = false, replace = false } = {}) {
    const d = await this.ready();
    const account = lazy.Account;
    const address = clean(account.email);
    const b = (d.backup ||= {});
    const done = async state => {
      b.state = state;
      b.at = Date.now();
      await this._save();
      this.notify("backup");
      return this.backup();
    };
    if (account.needsServerLink || account.isLocalMode) {
      return done("local");
    }
    const session = account._session();
    const labelPw = `tabora-mail-keys/wrap-password/v1|${address}`;
    const labelRk = `tabora-mail-keys/wrap-recovery/v1|${address}`;
    const labelBlob = fp => `tabora-mail-keys/blob/v1|${address}|${fp}`;
    const scratch = []; // ключи, побывавшие в памяти за время сверки: стираются в конце
    const keep = key => {
      if (key) {
        scratch.push(key);
      }
      return key;
    };
    try {
      return await this._syncRounds({ d, b, done, account, address, session, labelPw, labelRk, labelBlob, keep, passwordKey, loginHash, recoveryKey, recoveryGone, strict, replace });
    } finally {
      scratch.forEach(key => key.fill(0));
    }
  },

  async _syncRounds({ d, b, done, account, address, session, labelPw, labelRk, labelBlob, keep, passwordKey, loginHash, recoveryKey, recoveryGone, strict, replace }) {
    for (let attempt = 0; attempt < 4; attempt++) {
      let remote;
      try {
        remote = await account.backend.mailKeys({ session });
      } catch (e) {
        const state = e.status === 404 || e.code === "no-server" ? "unsupported" : "offline";
        if (strict) {
          throw fail(state === "unsupported" ? tt`Сервер Tabora пока не хранит копии ключей: это появится после его обновления` : e.message, state);
        }
        return done(state);
      }
      if (!remote || typeof remote !== "object" || !Number.isInteger(remote.rev)) {
        return done("offline");
      }
      const wrapPw = fromBase64(remote.wrapPassword);
      const wrapRk = fromBase64(remote.wrapRecovery);
      const blob = fromBase64(remote.blob);
      const remoteFp = /^[0-9a-f]{40,64}$/.test(remote.fingerprint || "") ? remote.fingerprint : "";
      // ключ данных: свой, из обёртки паролем или из обёртки ключом восстановления
      const fromPw = keep(await openBytes(passwordKey, labelPw, wrapPw));
      const fromRk = keep(await openBytes(recoveryKey, labelRk, wrapRk));
      const local = keep(fromBase64(b.dataKey));
      let own = d.own[address] || null;
      let dataKey = null;
      let via = "";
      const put = { rev: remote.rev };

      if (remoteFp && blob && !replace) {
        // у аккаунта на сервере есть ключ
        let secret = null;
        for (const [how, key] of [["password", fromPw], ["recovery", fromRk], ["local", local]]) {
          secret = await openBytes(key, labelBlob(remoteFp), blob);
          if (secret) {
            dataKey = key;
            via = how;
            break;
          }
        }
        if (secret && own?.fingerprint !== remoteFp) {
          // ключ создан на другом компьютере: берём его, прежний здешний остаётся для старых писем
          const armored = new TextDecoder().decode(secret);
          const { keys } = await this._call("info", { armored });
          const info = this._usable(keys?.[0], address);
          if (!info.private || info.fingerprint !== remoteFp) {
            throw fail(tt`Копия ключа на сервере повреждена`);
          }
          if (own) {
            d.retired = [own, ...(d.retired || [])].slice(0, MAX_RETIRED);
          }
          own = d.own[address] = { fingerprint: info.fingerprint, keyId: info.keyId, subkeyIds: info.subkeyIds, created: info.created, publicKey: info.armored, privateKey: armored };
          await this._save();
          this.notify("own");
        }
        secret?.fill(0);
        if (!secret && own?.fingerprint === remoteFp && passwordKey) {
          // ключ тот же, но копия завёрнута ключом данных, которого здесь нет: пересобираем её
          dataKey = local || keep(crypto.getRandomValues(new Uint8Array(32)));
          put.fingerprint = own.fingerprint;
          put.publicKey = armorBody(own.publicKey);
          put.blob = bytesToBase64(await sealBytes(dataKey, labelBlob(own.fingerprint), new TextEncoder().encode(own.privateKey)));
        } else if (!secret && own?.fingerprint !== remoteFp) {
          // открыть копию нечем, а ключ на сервере другой (или здесь ключа нет вовсе)
          if (strict && passwordKey) {
            if (!wrapPw) {
              throw fail(tt`Копия ключа на сервере ещё не привязана к паролю. Откройте Tabora на том компьютере, где ключ создан, и сохраните копию там`, "no-wrap");
            }
            // пароль неверен или копия сохранена с прежним паролем: верен ли пароль, скажет сервер
            await account.backend.mailKeysSave({ session, rev: remote.rev, wrapPassword: remote.wrapPassword, loginHash });
            throw fail(tt`Копия ключа сохранена с прежним паролем аккаунта: нынешним её не открыть`, "wrong-wrap");
          }
          if (strict && recoveryKey) {
            throw fail(tt`Этот ключ восстановления к копии ключа не подходит`, "wrong-wrap");
          }
          if (recoveryKey) {
            // ключ восстановления этого компьютера создан, пока ключа почты здесь нет: обёртка им
            // появится, как только ключ вернётся (в этом же сеансе)
            this._recoveryStash?.fill(0);
            this._recoveryStash = recoveryKey.slice();
          }
          b.canPassword = !!wrapPw;
          b.canRecovery = !!wrapRk;
          return done("locked");
        }
      } else {
        // ключа на сервере нет (или его велено заменить): сохраняем свой, при надобности создав
        if (replace && !(passwordKey && loginHash)) {
          throw fail(tt`Чтобы заменить ключ аккаунта, нужен пароль`);
        }
        if (!own) {
          await this.ensureKey();
          own = d.own[address];
        }
        dataKey = (!replace && (fromPw || fromRk || local)) || keep(crypto.getRandomValues(new Uint8Array(32)));
        put.fingerprint = own.fingerprint;
        put.publicKey = armorBody(own.publicKey);
        put.blob = bytesToBase64(await sealBytes(dataKey, labelBlob(own.fingerprint), new TextEncoder().encode(own.privateKey)));
        if (replace) {
          put.replace = true;
          put.wrapRecovery = ""; // прежняя обёртка относится к прежнему ключу данных
        }
      }

      // обёртки ключа данных
      if (dataKey && passwordKey && !sameBytes(fromPw, dataKey)) {
        put.wrapPassword = bytesToBase64(await sealBytes(passwordKey, labelPw, dataKey));
      }
      const stash = this._recoveryStash;
      if (dataKey && stash && !sameBytes(stash, recoveryKey)) {
        put.wrapRecovery = bytesToBase64(await sealBytes(stash, labelRk, dataKey));
      } else if (dataKey && recoveryKey && !sameBytes(fromRk, dataKey)) {
        put.wrapRecovery = bytesToBase64(await sealBytes(recoveryKey, labelRk, dataKey));
      } else if (recoveryGone && wrapRk) {
        put.wrapRecovery = "";
      }
      if (put.wrapPassword || put.replace) {
        put.loginHash = loginHash;
      }
      let saved = remote;
      if (Object.keys(put).length > 1) {
        try {
          saved = await account.backend.mailKeysSave({ session, ...put });
        } catch (e) {
          if (e.code === "pgp-conflict") {
            continue; // запись изменили с другого устройства: читаем заново
          }
          if (strict || e.code === "bad-credentials") {
            throw e;
          }
          return done("offline");
        }
      }
      if (dataKey) {
        b.dataKey = bytesToBase64(dataKey);
      }
      b.rev = saved.rev;
      b.fingerprint = saved.fingerprint || "";
      b.canPassword = !!saved.wrapPassword;
      b.canRecovery = !!saved.wrapRecovery;
      if (dataKey) {
        this._recoveryStash?.fill(0);
        this._recoveryStash = null;
      }
      // привязана ли копия к нынешнему паролю, точно известно только после сверки с паролем; ключ,
      // возвращённый ключом восстановления, значит, что обёртка паролем устарела
      if (dataKey && passwordKey) {
        b.stalePassword = false;
      } else if (via === "recovery") {
        b.stalePassword = true;
      }
      return done(saved.wrapPassword && !b.stalePassword ? "ok" : "no-password");
    }
    return done("offline");
  },

  /** Можно ли зашифровать письмо этим получателям: { possible, missing, suggested }.
   * suggested — шифровать по умолчанию: все получатели сами об этом просят (Autocrypt mutual)
   * или их ключи внесены вручную. */
  async plan(addresses) {
    const d = await this.ready();
    const list = [...new Set((addresses || []).map(clean).filter(Boolean))];
    const own = clean(lazy.Account.email);
    const missing = list.filter(a => a !== own && !d.own[a] && !d.peers[a]);
    const others = list.filter(a => a !== own && !d.own[a]);
    const possible = !!list.length && !missing.length && !!d.own[own];
    return { possible, missing, suggested: possible && others.every(a => d.peers[a].source === "manual" || d.peers[a].prefer === "mutual") };
  },

  /* ---- операции над письмом ----------------------------------------------------------------- */

  /** Зашифровать и подписать байты части письма для получателей и для себя. Возвращает броню. */
  async encrypt(bytes, addresses) {
    const d = await this.ready();
    const own = d.own[clean(lazy.Account.email)];
    if (!own) {
      throw fail(tt`У аккаунта ещё нет ключа шифрования`);
    }
    const keys = [own.publicKey];
    for (const a of [...new Set((addresses || []).map(clean).filter(Boolean))]) {
      const k = d.own[a] || d.peers[a];
      if (!k) {
        throw fail(tt`Нет ключа получателя ${a}: письмо нельзя зашифровать`, "no-key");
      }
      keys.push(k.publicKey);
    }
    const r = await this._call("encrypt", { data: bytesToBase64(bytes), recipients: keys, signer: own.privateKey });
    if (typeof r.armored !== "string" || !r.armored.startsWith("-----BEGIN PGP MESSAGE-----")) {
      throw fail(tt`Письмо не зашифровано`);
    }
    return r.armored;
  },

  /** Чей это ключ: адрес по номеру ключа подписи (свой или собеседника). */
  _signer(keyId) {
    const d = this.data;
    const has = k => k.keyId === keyId || (k.subkeyIds || []).includes(keyId);
    for (const [address, k] of Object.entries(d.own)) {
      if (has(k)) {
        return { address, fingerprint: k.fingerprint };
      }
    }
    for (const [address, k] of Object.entries(d.peers)) {
      if (has(k)) {
        return { address, fingerprint: k.fingerprint };
      }
    }
    return null;
  },

  /** Итог проверки подписи для письма от from: { state, address, fingerprint }.
   * state: "valid" — верна и сделана ключом отправителя; "other" — верна, но ключом другого
   * адреса; "invalid" — неверна; "unknown" — ключа подписавшего у нас нет; "none" — не подписано. */
  _verdict(signatures, from) {
    const list = Array.isArray(signatures) ? signatures.filter(s => s && typeof s === "object") : [];
    if (!list.length) {
      return { state: "none" };
    }
    const sender = clean(from);
    let best = { state: "unknown" };
    for (const s of list) {
      const who = /^[0-9a-f]{16}$/.test(s.keyId || "") ? this._signer(s.keyId) : null;
      if (s.valid === false && who) {
        return { state: "invalid", ...who };
      }
      if (s.valid === true && who) {
        const verdict = { state: !sender || who.address === sender ? "valid" : "other", ...who };
        if (verdict.state === "valid") {
          return verdict;
        }
        best = verdict;
      }
    }
    return best;
  },

  _verifiers(from) {
    const d = this.data;
    const a = clean(from);
    const keys = Object.values(d.own).map(k => k.publicKey);
    if (d.peers[a]) {
      keys.push(d.peers[a].publicKey);
    }
    return keys;
  },

  /** Подпись сделана ключом, которого не было среди проверочных, но он нам известен (ключ
   * другого собеседника): его открытый ключ для повторной проверки, иначе null. */
  _otherSigner(signatures) {
    for (const s of Array.isArray(signatures) ? signatures : []) {
      if (s?.valid === null && /^[0-9a-f]{16}$/.test(s.keyId || "")) {
        const who = this._signer(s.keyId);
        const key = who && (this.data.peers[who.address] || this.data.own[who.address]);
        if (key) {
          return key.publicKey;
        }
      }
    }
    return null;
  },

  /** Расшифровать броню письма от from. Возвращает { bytes, signature } либо бросает ошибку с
   * кодом "no-key" (зашифровано не нам) или "pgp". */
  async decrypt(armored, { from = "" } = {}) {
    const d = await this.ready();
    // прежние ключи аккаунта остаются для писем, зашифрованных до замены ключа
    const keys = [...Object.values(d.own), ...(d.retired || [])].map(k => k.privateKey);
    if (!keys.length) {
      throw fail(tt`В этом профиле нет ключа, которым зашифровано письмо`, "no-key");
    }
    let r;
    try {
      r = await this._call("decrypt", { armored: String(armored), keys, verifiers: this._verifiers(from) });
    } catch (e) {
      const noKey = /no decryption key|session key decryption failed/i.test(e.detail || "");
      throw fail(noKey ? tt`Письмо зашифровано не для этого аккаунта: в профиле нет подходящего ключа` : tt`Письмо не расшифровано: оно повреждено или зашифровано неизвестным способом`, noKey ? "no-key" : "pgp");
    }
    if (typeof r.data !== "string") {
      throw fail(tt`Письмо не расшифровано`);
    }
    const other = this._otherSigner(r.signatures);
    if (other) {
      // подписано ключом другого известного адреса: проверяем им, итог скажет, чья это подпись
      const again = await this._call("decrypt", { armored: String(armored), keys, verifiers: [other] }).catch(() => null);
      if (again) {
        r.signatures = again.signatures;
      }
    }
    return { bytes: base64ToBytes(r.data), signature: this._verdict(r.signatures, from) };
  },

  /** Отсоединённая подпись части письма: { signature, micalg }. */
  async sign(bytes) {
    const d = await this.ready();
    const own = d.own[clean(lazy.Account.email)];
    if (!own) {
      throw fail(tt`У аккаунта ещё нет ключа`);
    }
    const r = await this._call("sign", { data: bytesToBase64(bytes), signer: own.privateKey });
    if (typeof r.signature !== "string" || !r.signature.includes("BEGIN PGP SIGNATURE") || !/^sha[0-9-]+$/.test(r.hash || "")) {
      throw fail(tt`Письмо не подписано`);
    }
    return { signature: r.signature, micalg: `pgp-${r.hash}` };
  },

  /** Проверить отсоединённую подпись части письма от from. */
  async verify(bytes, signature, from) {
    await this.ready();
    try {
      const args = { data: bytesToBase64(bytes), signature: String(signature) };
      let r = await this._call("verify", { ...args, verifiers: this._verifiers(from) });
      const other = this._otherSigner(r.signatures);
      if (other) {
        r = await this._call("verify", { ...args, verifiers: [other] });
      }
      return this._verdict(r.signatures, from);
    } catch (e) {
      return { state: "invalid" };
    }
  },

  /* ---- Autocrypt: обмен ключами в заголовке письма ------------------------------------------ */

  /** Значение заголовка Autocrypt для своих писем или "" (ключа ещё нет). */
  async autocryptHeader(address = lazy.Account.email) {
    const d = await this.ready();
    const k = d.own[clean(address)];
    const body = k ? armorBody(k.publicKey) : "";
    return body ? `addr=${clean(address)}; prefer-encrypt=mutual; keydata=${body}` : "";
  },

  /** Заголовок Autocrypt входящего письма: ключ запоминается, если он для адреса отправителя
   * и письмо не старее уже учтённого. Ошибки разбора не мешают показу письма. */
  async noteAutocrypt(from, value, date) {
    try {
      const sender = clean(from);
      const attrs = {};
      for (const part of String(value || "").split(";")) {
        const i = part.indexOf("=");
        if (i > 0) {
          attrs[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
        }
      }
      // неизвестный обязательный атрибут делает заголовок недействительным (так требует Autocrypt)
      const critical = Object.keys(attrs).some(k => !["addr", "prefer-encrypt", "keydata"].includes(k) && !k.startsWith("_"));
      const keydata = (attrs.keydata || "").replace(/\s+/g, "");
      if (critical || !sender || clean(attrs.addr) !== sender || !/^[A-Za-z0-9+/=]{100,}$/.test(keydata) || keydata.length > MAX_KEY_CHARS) {
        return null;
      }
      const seen = Math.min(Date.parse(date) || Date.now(), Date.now());
      const d = await this.ready();
      if (d.own[sender]) {
        return null;
      }
      const prior = d.peers[sender];
      if (prior && prior.seen >= seen) {
        return null; // более свежее письмо этого человека уже учтено
      }
      if (prior && prior.source !== "manual" && armorBody(prior.publicKey) === keydata) {
        prior.seen = seen;
        prior.prefer = attrs["prefer-encrypt"] === "mutual" ? "mutual" : "";
        this._save();
        return prior;
      }
      return await this.setPeer(sender, armorKey(keydata), { source: "autocrypt", prefer: attrs["prefer-encrypt"], seen });
    } catch (e) {
      return null;
    }
  },
};

/* Смена ключа сейфа: файл ключей перешифровывается новым подключом. Без этого закрытый ключ
 * почты остался бы под прежним ключом сейфа и пропал. */
Vault.registerRekey(
  "mail-pgp",
  async ({ decryptOld, encryptNew }) => {
    let file;
    try {
      file = await IOUtils.readJSON(FILE());
    } catch (e) {
      return; // ключей почты ещё нет
    }
    if (file?.v !== FORMAT || !file.enc) {
      return;
    }
    let bytes;
    try {
      bytes = await decryptOld(INFO, file.enc);
    } catch (e) {
      // файл не читается и прежним ключом: смену ключа сейфа он не должен держать вечно
      await IOUtils.move(FILE(), `${FILE()}.unreadable-${Date.now()}`).catch(() => {});
      console.error("Tabora pgp: файл ключей не читается и отложен", e);
      return;
    }
    try {
      await writeJsonVerified(FILE(), { v: FORMAT, enc: await encryptNew(INFO, bytes) });
    } finally {
      bytes.fill(0);
    }
    Pgp.data = null;
  },
  { required: true }
);
