/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Одноразовые коды (TOTP, RFC 6238). Записи лежат в tabora-otp.json: издатель, аккаунт,
 * параметры и сайты (точный хост, поддомены только по явному выбору) открыто, секрет —
 * зашифрован производным ключом сейфа (Vault.subkey("otp")). Метаданные каждой записи
 * вместе с зашифрованным секретом подписаны HMAC подключом сейфа ("otp-meta"): подменить
 * сайт или издателя в файле, не зная ключа, нельзя. Расшифрованные секреты живут в памяти,
 * пока сейф разблокирован, и обнуляются при блокировке. Код считается в родительском
 * процессе; страница получает только сам код после действия пользователя. */

const { Vault } = ChromeUtils.importESModule("chrome://tabora/content/vault/Vault.sys.mjs");
const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
const C = ChromeUtils.importESModule("chrome://tabora/content/wallet/vendor/crypto.sys.mjs");

const FILE = () => PathUtils.join(PathUtils.profileDir, "tabora-otp.json");
const BACKUP = () => PathUtils.join(PathUtils.profileDir, "tabora-otp.json.bak");
const MAC_INFO = "otp-meta";
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const ALG = { SHA1: "SHA-1", SHA256: "SHA-256", SHA512: "SHA-512" };
const MAX_ENTRIES = 500;

function wipe(a) {
  if (a && a.fill) {
    a.fill(0);
  }
}

/** Текст из ссылки или страницы: без управляющих и невидимых символов, с лимитом. */
function cleanText(text, max = 64) {
  return String(text ?? "").replace(/[\p{Cf}\p{Cc}\u2028\u2029]/gu, "").normalize("NFKC").trim().slice(0, max);
}

export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s-]/g, "").replace(/=+$/, "");
  if (!clean || /[^A-Z2-7]/.test(clean)) {
    throw new Error("Секрет должен быть в кодировке Base32 (буквы A–Z и цифры 2–7)");
  }
  const out = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    value = ((value << 5) | B32.indexOf(ch)) >>> 0;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }
  return Uint8Array.from(out);
}

export function base32Encode(bytes) {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = ((value << 8) | b) >>> 0;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
      value &= (1 << bits) - 1;
    }
  }
  if (bits > 0) {
    out += B32[(value << (5 - bits)) & 31];
  }
  return out;
}

async function hmac(algorithm, key, message) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: { name: ALG[algorithm] || "SHA-1" } }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, message));
}

/** HOTP (RFC 4226): код по секрету и счётчику. */
export async function hotp(secret, counter, { algorithm = "SHA1", digits = 6 } = {}) {
  const msg = new Uint8Array(8);
  let c = BigInt(counter);
  for (let i = 7; i >= 0; i--) {
    msg[i] = Number(c & 0xffn);
    c >>= 8n;
  }
  const h = await hmac(algorithm, secret, msg);
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/** TOTP: код для момента времени (мс) с периодом в секундах. */
export async function totp(secret, { algorithm = "SHA1", digits = 6, period = 30, now = Date.now(), offset = 0 } = {}) {
  const counter = Math.floor((now + offset) / 1000 / period);
  return hotp(secret, counter, { algorithm, digits });
}

function checkParams({ algorithm, digits, period }) {
  if (!ALG[algorithm]) {
    throw new Error(`Алгоритм ${algorithm} не поддерживается`);
  }
  if (![6, 7, 8].includes(digits)) {
    throw new Error("Длина кода: 6, 7 или 8 цифр");
  }
  if (!(period >= 15 && period <= 120)) {
    throw new Error("Период от 15 до 120 секунд");
  }
}

/** Разбор otpauth://totp/Label?secret=…&issuer=…&algorithm=…&digits=…&period=… */
export function parseOtpauth(input) {
  const text = String(input || "").trim();
  if (!/^otpauth:\/\//i.test(text)) {
    throw new Error("Это не ссылка otpauth://");
  }
  let url;
  try {
    url = new URL(text);
  } catch (e) {
    throw new Error("Ссылка otpauth:// повреждена");
  }
  const type = (url.host || url.pathname.split("/")[0] || "").toLowerCase();
  if (type !== "totp") {
    throw new Error(type === "hotp" ? "Коды со счётчиком (HOTP) пока не поддерживаются" : "Неизвестный тип кода");
  }
  let label = url.pathname.replace(/^\/+/, "");
  try {
    label = decodeURIComponent(label);
  } catch (e) {}
  const p = url.searchParams;
  const secret = p.get("secret") || "";
  if (!secret) {
    throw new Error("В ссылке нет секрета");
  }
  let issuer = p.get("issuer") || "";
  let account = label;
  const colon = label.indexOf(":");
  if (colon >= 0) {
    if (!issuer) {
      issuer = label.slice(0, colon);
    }
    account = label.slice(colon + 1);
  }
  const out = {
    issuer: cleanText(issuer, 48),
    account: cleanText(account, 96),
    secret: secret.replace(/[\s-]/g, ""),
    algorithm: (p.get("algorithm") || "SHA1").toUpperCase().replace("-", ""),
    digits: Number(p.get("digits") || 6),
    period: Number(p.get("period") || 30),
  };
  checkParams(out);
  base32Decode(out.secret); // валидность секрета
  return out;
}

/* ---------- импорт: Google Authenticator, Aegis, 2FAS, списки ссылок ---------- */

/** Минимальный protobuf-декодер: поля как список { field, wire, value } (varint → BigInt, bytes → Uint8Array). */
function pbDecode(bytes) {
  const out = [];
  let i = 0;
  const varint = () => {
    let v = 0n;
    let shift = 0n;
    for (;;) {
      if (i >= bytes.length) {
        throw new Error("protobuf: обрыв");
      }
      const b = bytes[i++];
      v |= BigInt(b & 0x7f) << shift;
      shift += 7n;
      if (!(b & 0x80)) {
        return v;
      }
      if (shift > 70n) {
        throw new Error("protobuf: varint слишком длинный");
      }
    }
  };
  while (i < bytes.length) {
    const tag = varint();
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (wire === 0) {
      out.push({ field, wire, value: varint() });
    } else if (wire === 2) {
      const len = Number(varint());
      if (len < 0 || i + len > bytes.length) {
        throw new Error("protobuf: длина вне данных");
      }
      out.push({ field, wire, value: bytes.slice(i, i + len) });
      i += len;
    } else if (wire === 1) {
      i += 8;
    } else if (wire === 5) {
      i += 4;
    } else {
      throw new Error("protobuf: неизвестный тип поля");
    }
  }
  return out;
}

function b64ToBytes(str) {
  const clean = String(str).replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, "");
  const bin = atob(clean + "=".repeat((4 - (clean.length % 4)) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

/** otpauth-migration://offline?data=… (экспорт Google Authenticator) → список записей. */
export function parseMigration(input) {
  const text = String(input || "").trim();
  if (!/^otpauth-migration:\/\//i.test(text)) {
    throw new Error("Это не ссылка экспорта Google Authenticator");
  }
  let data;
  try {
    data = new URL(text).searchParams.get("data");
  } catch (e) {
    throw new Error("Ссылка экспорта повреждена");
  }
  if (!data) {
    throw new Error("В ссылке экспорта нет данных");
  }
  const payload = pbDecode(b64ToBytes(decodeURIComponent(data)));
  const dec = new TextDecoder();
  const out = [];
  const skipped = [];
  for (const f of payload) {
    if (f.field !== 1 || f.wire !== 2) {
      continue;
    }
    const p = pbDecode(f.value);
    const get = n => p.find(x => x.field === n)?.value;
    const secret = get(1);
    const name = get(2) ? dec.decode(get(2)) : "";
    const issuer = get(3) ? dec.decode(get(3)) : "";
    const algorithm = { 1: "SHA1", 2: "SHA256", 3: "SHA512" }[Number(get(4) ?? 1n)] || null;
    const digits = { 1: 6, 2: 8 }[Number(get(5) ?? 1n)] || 6;
    const type = Number(get(6) ?? 2n);
    const label = issuer || name || "запись";
    if (type !== 2) {
      skipped.push(`${label}: коды со счётчиком (HOTP) не поддерживаются`);
      continue;
    }
    if (!algorithm) {
      skipped.push(`${label}: алгоритм не поддерживается`);
      continue;
    }
    if (!secret || !secret.length) {
      skipped.push(`${label}: нет секрета`);
      continue;
    }
    let account = cleanText(name, 96);
    let iss = cleanText(issuer, 48);
    const colon = account.indexOf(":");
    if (!iss && colon > 0) {
      iss = account.slice(0, colon).trim();
      account = account.slice(colon + 1).trim();
    }
    out.push({ issuer: iss, account, secret: base32Encode(secret), algorithm, digits, period: 30 });
  }
  return { entries: out, skipped };
}

/** Файл экспорта: Aegis (JSON, без шифрования), 2FAS (JSON), либо список ссылок otpauth:// построчно. */
export function parseImportText(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    throw new Error("Файл пустой");
  }
  const out = [];
  const skipped = [];
  const push = (fields, label) => {
    try {
      checkParams({ algorithm: fields.algorithm, digits: fields.digits, period: fields.period });
      base32Decode(fields.secret);
      out.push(fields);
    } catch (e) {
      skipped.push(`${label}: ${e.message}`);
    }
  };
  if (raw.startsWith("{") || raw.startsWith("[")) {
    let json;
    try {
      json = JSON.parse(raw);
    } catch (e) {
      throw new Error("Файл не разбирается как JSON");
    }
    if (json?.header?.slots || json?.db === undefined && json?.header?.params) {
      throw new Error("Это зашифрованный экспорт Aegis: экспортируйте без шифрования");
    }
    if (json?.servicesEncrypted) {
      throw new Error("Это зашифрованный экспорт 2FAS: экспортируйте без пароля");
    }
    const aegis = json?.db?.entries;
    const twofas = json?.services;
    if (Array.isArray(aegis)) {
      for (const e of aegis) {
        const label = e.issuer || e.name || "запись";
        if ((e.type || "totp").toLowerCase() !== "totp") {
          skipped.push(`${label}: тип ${e.type} не поддерживается`);
          continue;
        }
        push({ issuer: cleanText(e.issuer, 48), account: cleanText(e.name, 96), secret: String(e.info?.secret || ""), algorithm: String(e.info?.algo || "SHA1").toUpperCase().replace("-", ""), digits: Number(e.info?.digits || 6), period: Number(e.info?.period || 30) }, label);
      }
    } else if (Array.isArray(twofas)) {
      for (const sv of twofas) {
        const label = sv.name || sv.otp?.issuer || "запись";
        if ((sv.otp?.tokenType || "TOTP").toUpperCase() !== "TOTP") {
          skipped.push(`${label}: тип ${sv.otp?.tokenType} не поддерживается`);
          continue;
        }
        push({ issuer: cleanText(sv.otp?.issuer || sv.name, 48), account: cleanText(sv.otp?.account || sv.otp?.label || "", 96), secret: String(sv.secret || ""), algorithm: String(sv.otp?.algorithm || "SHA1").toUpperCase().replace("-", ""), digits: Number(sv.otp?.digits || 6), period: Number(sv.otp?.period || 30) }, label);
      }
    } else {
      throw new Error("Формат файла не распознан (поддерживаются Aegis и 2FAS без шифрования)");
    }
  } else {
    for (const line of raw.split(/\r?\n/)) {
      const l = line.trim();
      if (!l) {
        continue;
      }
      if (/^otpauth-migration:/i.test(l)) {
        const m = parseMigration(l);
        out.push(...m.entries);
        skipped.push(...m.skipped);
      } else if (/^otpauth:/i.test(l)) {
        try {
          out.push(parseOtpauth(l));
        } catch (e) {
          skipped.push(`${l.slice(0, 40)}…: ${e.message}`);
        }
      } else {
        skipped.push(`${l.slice(0, 40)}: не ссылка otpauth://`);
      }
    }
  }
  if (!out.length && !skipped.length) {
    throw new Error("В файле нет записей");
  }
  return { entries: out, skipped };
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Каноническая строка метаданных записи для подписи: всё, что влияет на то, где и какой код
 * выдаётся. Счётчики использования не входят: они меняются при каждом коде. */
function canonical(e) {
  return JSON.stringify(["tabora-otp-meta-v1", e.id, e.issuer || "", e.account || "", e.algorithm, e.digits, e.period, (e.sites || []).map(s => [s.host, !!s.sub]), e.createdAt || "", e.secret?.iv || "", e.secret?.ct || ""]);
}

function macWith(key, entry) {
  return C.base64.encode(C.hmac(C.sha256, key, C.utf8ToBytes(canonical(entry))));
}

function validEntries(data) {
  return !!data && typeof data === "object" && data.version === 1 && Array.isArray(data.entries);
}

export const Otp = {
  TOPIC: "tabora-otp-changed",
  data: null,
  loadError: null, // { reason, movedTo, backup, unreadable } для повреждённого файла
  _loaded: false,
  _loading: null,
  _secrets: new Map(), // id → Uint8Array, пока сейф разблокирован
  _observing: false,

  async ready() {
    if (this._loaded) {
      return this.data;
    }
    if (!this._loading) {
      this._loading = this._load().finally(() => {
        this._loading = null;
      });
    }
    await this._loading;
    return this.data;
  },

  async _load() {
    if (!this._observing) {
      this._observing = true;
      Services.obs.addObserver((s, t, what) => {
        if (what === "locked") {
          this.forget();
        } else if (what === "unlocked") {
          this._ensureSigned().catch(e => console.error("Tabora otp", e));
        } else if (what === "reset") {
          // сейф создан заново: прежний файл кодов перенесён в сторону
          this.forget();
          this._loaded = false;
          this.data = null;
          this.loadError = null;
          this.notify("reset");
        }
      }, Vault.TOPIC);
    }
    this.loadError = null;
    let raw;
    try {
      raw = await IOUtils.readUTF8(FILE());
    } catch (e) {
      this.data = { version: 1, macs: 1, entries: [] };
      if (e.name !== "NotFoundError") {
        // файл есть, но не читается: не перезаписываем его пустым
        console.error("Tabora otp: файл кодов не читается", e);
        this.loadError = { reason: `файл не читается (${e.message})`, unreadable: true, movedTo: null, backup: await this._readBackup() };
      }
      this._loaded = true;
      return;
    }
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch (e) {}
    if (validEntries(data)) {
      this.data = data;
      this._migrate();
      this._loaded = true;
      await this._ensureSigned().catch(e => console.error("Tabora otp", e));
      return;
    }
    // повреждён: переносим в сторону, пустой список поверх не пишем, пока пользователь не решит
    let movedTo = `${FILE()}.corrupt-${stamp()}`;
    try {
      await IOUtils.move(FILE(), movedTo, { noOverwrite: true });
      await IOUtils.setPermissions(movedTo, 0o600).catch(() => {});
    } catch (e) {
      console.error("Tabora otp: повреждённый файл не перенесён", e);
      movedTo = null;
    }
    console.error("Tabora otp: файл кодов повреждён");
    this.data = { version: 1, macs: 1, entries: [] };
    this.loadError = { reason: data ? "неизвестный формат файла" : "файл не разбирается как JSON", unreadable: false, movedTo, backup: await this._readBackup() };
    this._loaded = true;
  },

  async _readBackup() {
    try {
      const b = await IOUtils.readJSON(BACKUP());
      return validEntries(b) ? b : null;
    } catch (e) {
      return null;
    }
  },

  /** Старые записи: базовые домены (eTLD+1) без пометки поддоменов. Совпадение по eTLD+1
   * для них сохраняется (sub: true), но подсказка показывает, какой именно сайт просит код. */
  _migrate() {
    for (const e of this.data.entries) {
      if (!Array.isArray(e.sites)) {
        e.sites = (Array.isArray(e.domains) ? e.domains : []).map(d => ({ host: String(d).toLowerCase(), sub: true, legacy: true })).filter(s => s.host);
        delete e.domains;
      }
    }
  },

  /** Подписи записей. Файл прежнего формата (без подписей) подписывается при первой
   * разблокировке как есть; после этого запись без верной подписи не выдаёт код. */
  async _ensureSigned() {
    if (!this.data || this.data.macs || this.loadError || !Vault.unlocked) {
      return;
    }
    const key = Vault.subkey(MAC_INFO);
    try {
      for (const e of this.data.entries) {
        e.mac = macWith(key, e);
      }
    } finally {
      wipe(key);
    }
    this.data.macs = 1;
    await this.save();
  },

  /** Подпись записи верна (null — сейф заблокирован и проверить нельзя). */
  isAuthentic(entry) {
    if (!Vault.unlocked) {
      return null;
    }
    if (!this.data?.macs) {
      return true; // подпишется при разблокировке (_ensureSigned)
    }
    if (typeof entry?.mac !== "string") {
      return false;
    }
    const key = Vault.subkey(MAC_INFO);
    try {
      if (macWith(key, entry) === entry.mac) {
        return true;
      }
    } finally {
      wipe(key);
    }
    // смена ключа сейфа не завершена: запись могла остаться подписанной прежним ключом
    const prev = Vault.prevSubkey(MAC_INFO);
    try {
      return !!prev && macWith(prev, entry) === entry.mac;
    } finally {
      wipe(prev);
    }
  },

  _sign(entry) {
    const key = Vault.subkey(MAC_INFO);
    try {
      entry.mac = macWith(key, entry);
    } finally {
      wipe(key);
    }
  },

  get entries() {
    return this.data?.entries || [];
  },

  notify(what = "changed") {
    Services.obs.notifyObservers(null, this.TOPIC, what);
  },

  async _write(data) {
    await IOUtils.writeJSON(FILE(), data, { tmpPath: FILE() + ".tmp" });
    try {
      await IOUtils.setPermissions(FILE(), 0o600);
    } catch (e) {}
    try {
      await IOUtils.writeJSON(BACKUP(), data, { tmpPath: BACKUP() + ".tmp" });
      await IOUtils.setPermissions(BACKUP(), 0o600);
    } catch (e) {
      console.error("Tabora otp: запасная копия не записана", e);
    }
  },

  async save() {
    if (this.loadError) {
      throw new Error("Файл кодов повреждён: сначала восстановите его из копии или начните список заново");
    }
    this.data.updatedAt = new Date().toISOString();
    await this._write(this.data);
    this.notify();
  },

  /** Повреждённый файл: восстановить из запасной копии. */
  async restoreBackup() {
    const b = this.loadError?.backup;
    if (!b) {
      throw new Error("Запасной копии кодов нет");
    }
    this.forget();
    this.data = b;
    this.loadError = null;
    this._migrate();
    await this.save();
    await this._ensureSigned();
  },

  /** Повреждённый файл: осознанно начать список заново (повреждённый остаётся рядом). */
  async startFresh() {
    this.forget();
    this.data = { version: 1, macs: 1, entries: [] };
    this.loadError = null;
    await this.save();
  },

  forget() {
    for (const s of this._secrets.values()) {
      wipe(s);
    }
    this._secrets.clear();
  },

  baseDomain(host) {
    const h = String(host || "").toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
    if (!h) {
      return "";
    }
    try {
      return Services.eTLD.getBaseDomainFromHost(h);
    } catch (e) {
      return h;
    }
  },

  /** Хост из произвольного ввода: «https://GitHub.com/login» → «github.com». */
  normalizeHost(raw) {
    let host = String(raw || "").trim().toLowerCase();
    if (!host) {
      return "";
    }
    try {
      host = new URL(host.includes("://") ? host : `https://${host}`).hostname;
    } catch (e) {
      return "";
    }
    host = host.replace(/\.$/, "");
    return /^[a-z0-9.-]+\.[a-z0-9-]{2,}$/i.test(host) || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? host : "";
  },

  /** Сайты записи: «github.com, gitlab.com» → [{ host, sub }]. sub — код выдаётся и на поддоменах
   * (только по явному выбору пользователя). */
  normalizeSites(list, { sub = false } = {}) {
    const out = new Map();
    for (const raw of Array.isArray(list) ? list : String(list || "").split(/[\s,;]+/)) {
      const item = raw && typeof raw === "object" ? raw : { host: raw, sub };
      const host = this.normalizeHost(item.host);
      if (host) {
        out.set(host, { host, sub: !!item.sub || !!out.get(host)?.sub });
      }
    }
    return [...out.values()].slice(0, 8);
  },

  /** Сайт по издателю, если издатель сам похож на домен (github.com). Точный хост, без поддоменов. */
  guessSites(issuer) {
    const s = String(issuer || "").trim().toLowerCase();
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s)) {
      return this.normalizeSites([s]);
    }
    return [];
  },

  /** Как совпадает хост с записью: "exact", "sub" (по разрешённым поддоменам) или null. */
  matchHost(entry, host) {
    const h = String(host || "").toLowerCase();
    let best = null;
    for (const s of entry.sites || []) {
      if (s.host === h) {
        return "exact";
      }
      if (s.sub && h.endsWith(`.${s.host}`)) {
        best = "sub";
      }
    }
    return best;
  },

  async add(fields) {
    await this.ready();
    Vault.requireUnlocked();
    if (this.loadError) {
      throw new Error("Файл кодов повреждён: сначала восстановите его из копии или начните список заново");
    }
    if (this.entries.length >= MAX_ENTRIES) {
      throw new Error("Слишком много записей");
    }
    const algorithm = String(fields.algorithm || "SHA1").toUpperCase();
    const digits = Number(fields.digits || 6);
    const period = Number(fields.period || 30);
    checkParams({ algorithm, digits, period });
    const secret = base32Decode(fields.secret);
    if (secret.length < 8) {
      throw new Error("Секрет слишком короткий");
    }
    await hotp(secret, 0, { algorithm, digits }); // проверка, что секрет и алгоритм рабочие
    const issuer = cleanText(fields.issuer, 48);
    const account = cleanText(fields.account, 96);
    if (!issuer && !account) {
      throw new Error("Укажите сервис или аккаунт");
    }
    const id = `o${Date.now().toString(36)}${Array.from(crypto.getRandomValues(new Uint8Array(5)), b => (b % 36).toString(36)).join("")}`;
    const entry = {
      id,
      issuer,
      account,
      algorithm,
      digits,
      period,
      sites: this.normalizeSites(fields.sites || []),
      createdAt: new Date().toISOString(),
      secret: await Vault.encrypt("otp", secret),
    };
    this._sign(entry);
    this.data.entries.push(entry);
    this._secrets.set(id, secret);
    await this.save();
    return this.meta(entry);
  },

  /** Несколько записей разом; повторы (тот же издатель, аккаунт и секрет) пропускаются. */
  async addMany(list, { sitesFor = null } = {}) {
    await this.ready();
    Vault.requireUnlocked();
    const seen = new Set();
    for (const e of this.entries) {
      const s = await this.secretOf(e.id).catch(() => null);
      seen.add(`${e.issuer}\u0000${e.account}\u0000${s ? base32Encode(s) : ""}`);
    }
    let added = 0;
    let skipped = 0;
    const errors = [];
    for (const f of list) {
      const key = `${cleanText(f.issuer, 48)}\u0000${cleanText(f.account, 96)}\u0000${String(f.secret || "").toUpperCase().replace(/[\s-=]/g, "")}`;
      if (seen.has(key)) {
        skipped++;
        continue;
      }
      try {
        await this.add({ ...f, sites: f.sites || (sitesFor ? sitesFor(f) : this.guessSites(f.issuer)) });
        seen.add(key);
        added++;
      } catch (e) {
        errors.push(`${f.issuer || f.account}: ${e.message}`);
      }
    }
    return { added, skipped, errors };
  },

  /** Изменение названия и сайтов: подпись пересчитывается, поэтому нужен разблокированный сейф.
   * Запись с неверной подписью не правится: её нужно удалить и добавить заново. */
  async update(id, fields) {
    await this.ready();
    Vault.requireUnlocked();
    const entry = this.entries.find(e => e.id === id);
    if (!entry) {
      throw new Error("Запись не найдена");
    }
    if (!this.isAuthentic(entry)) {
      throw new Error("Запись изменена вне браузера: удалите её и добавьте код заново");
    }
    const next = { ...entry };
    if ("issuer" in fields) {
      next.issuer = cleanText(fields.issuer, 48);
    }
    if ("account" in fields) {
      next.account = cleanText(fields.account, 96);
    }
    if ("sites" in fields) {
      next.sites = this.normalizeSites(fields.sites);
    }
    if (!next.issuer && !next.account) {
      throw new Error("Укажите сервис или аккаунт");
    }
    this._sign(next);
    Object.assign(entry, next);
    await this.save();
    return this.meta(entry);
  },

  async remove(id) {
    await this.ready();
    const i = this.entries.findIndex(e => e.id === id);
    if (i < 0) {
      return;
    }
    this.data.entries.splice(i, 1);
    wipe(this._secrets.get(id));
    this._secrets.delete(id);
    await this.save();
  },

  async touch(id) {
    const entry = this.entries.find(e => e.id === id);
    if (entry) {
      entry.usedAt = Date.now();
      entry.uses = (entry.uses || 0) + 1;
      await this.save();
    }
  },

  meta(entry) {
    const { secret, mac, ...rest } = entry;
    rest.sites = (entry.sites || []).map(s => ({ ...s }));
    rest.valid = this.isAuthentic(entry);
    return rest;
  },

  list() {
    return this.entries.map(e => this.meta(e));
  },

  /** Записи для хоста страницы (https проверяет вызывающий: актор берёт хост из принципала
   * документа в родительском процессе). При разблокированном сейфе — только записи с верной
   * подписью; при заблокированном — кандидаты без проверки, только чтобы предложить разблокировку. */
  forHost(host) {
    const out = [];
    for (const e of this.entries) {
      const match = this.matchHost(e, host);
      if (!match) {
        continue;
      }
      const m = this.meta(e);
      if (m.valid === false) {
        continue;
      }
      m.match = match;
      out.push(m);
    }
    return out;
  },

  async secretOf(id) {
    Vault.requireUnlocked();
    let s = this._secrets.get(id);
    if (!s) {
      const entry = this.entries.find(e => e.id === id);
      if (!entry) {
        throw new Error("Запись не найдена");
      }
      if (!this.isAuthentic(entry)) {
        throw new Error("Запись изменена вне браузера: код не выдаётся");
      }
      s = await Vault.decrypt("otp", entry.secret);
      this._secrets.set(id, s);
    }
    return s;
  },

  /** Текущий и следующий код, остаток периода в секундах. */
  async code(id, now = Date.now()) {
    const entry = this.entries.find(e => e.id === id);
    if (!entry) {
      throw new Error("Запись не найдена");
    }
    const secret = await this.secretOf(id);
    const offset = Services.prefs.getIntPref("tabora.otp.clockOffsetMs", 0);
    const t = now + offset;
    const periodMs = entry.period * 1000;
    const remaining = Math.ceil((periodMs - (t % periodMs)) / 1000);
    const [code, next] = await Promise.all([
      totp(secret, { algorithm: entry.algorithm, digits: entry.digits, period: entry.period, now: t }),
      totp(secret, { algorithm: entry.algorithm, digits: entry.digits, period: entry.period, now: t + periodMs }),
    ]);
    return { code, next, remaining, period: entry.period, digits: entry.digits };
  },

  /* ---------- сверка времени ---------- */

  CLOCK_OFFSET_PREF: "tabora.otp.clockOffsetMs",
  CLOCK_CHECKED_PREF: "tabora.otp.clockCheckedAt",
  CLOCK_HOSTS: ["https://www.cloudflare.com/cdn-cgi/trace", "https://www.google.com/generate_204", "https://www.apple.com/library/test/success.html"],

  get clockOffset() {
    return Services.prefs.getIntPref(this.CLOCK_OFFSET_PREF, 0);
  },

  get clockCheckedAt() {
    return Number(Services.prefs.getStringPref(this.CLOCK_CHECKED_PREF, "0")) || 0;
  },

  /** Сверка часов по заголовку Date известных серверов: коды зависят от времени, системные часы не трогаем.
   * Поправка применяется, если расхождение больше 5 с (точность заголовка — секунда). */
  async checkClock() {
    let lastError = null;
    for (const url of this.CLOCK_HOSTS) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      try {
        const t0 = Date.now();
        const res = await fetch(url, { method: "HEAD", cache: "no-store", redirect: "manual", credentials: "omit", signal: ctrl.signal });
        const rtt = Date.now() - t0;
        const server = Date.parse(res.headers.get("date") || "");
        if (!server || rtt > 5000) {
          throw new Error("нет заголовка Date");
        }
        const offset = Math.round(server + rtt / 2 - Date.now());
        if (Math.abs(offset) > 86400000) {
          throw new Error("неправдоподобное время сервера");
        }
        const applied = Math.abs(offset) > 5000 ? offset : 0;
        Services.prefs.setIntPref(this.CLOCK_OFFSET_PREF, applied);
        Services.prefs.setStringPref(this.CLOCK_CHECKED_PREF, String(Date.now()));
        this.notify("clock");
        return { offset, applied, host: new URL(url).host, rtt };
      } catch (e) {
        lastError = e;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(`Не удалось сверить время: ${lastError?.message || "сеть недоступна"}`);
  },

  /** Ссылка otpauth:// для переноса записи в другое приложение (только по явному действию). */
  async otpauthUrl(id) {
    const entry = this.entries.find(e => e.id === id);
    if (!entry) {
      throw new Error("Запись не найдена");
    }
    const secret = base32Encode(await this.secretOf(id));
    const label = encodeURIComponent(entry.issuer ? `${entry.issuer}:${entry.account}` : entry.account);
    const p = new URLSearchParams({ secret, algorithm: entry.algorithm, digits: String(entry.digits), period: String(entry.period) });
    if (entry.issuer) {
      p.set("issuer", entry.issuer);
    }
    return `otpauth://totp/${label}?${p}`;
  },
};

/* Смена ключа сейфа: секреты перешифровываются новым подключом, подписи пересчитываются.
 * Запись с неверной подписью перешифровывается, но подпись не получает: подменённое
 * в файле не узаконивается. Файл пишется атомарно, повторный вызов безопасен. */
Vault.registerRekey("otp", async ctx => {
  await Otp.ready();
  if (Otp.loadError) {
    throw new Error("файл кодов повреждён");
  }
  if (!Otp.entries.length) {
    return;
  }
  const oldMac = ctx.subkeyOld(MAC_INFO);
  const newMac = ctx.subkeyNew(MAC_INFO);
  try {
    const entries = [];
    for (const e of Otp.entries) {
      const authentic = !Otp.data.macs || (typeof e.mac === "string" && (macWith(oldMac, e) === e.mac || macWith(newMac, e) === e.mac));
      const secret = await ctx.decryptOld("otp", e.secret);
      const next = { ...e, secret: await ctx.encryptNew("otp", secret) };
      wipe(secret);
      next.mac = authentic ? macWith(newMac, next) : null;
      entries.push(next);
    }
    const data = { ...Otp.data, macs: 1, entries, updatedAt: new Date().toISOString() };
    await Otp._write(data);
    Otp.data = data;
    Otp.forget();
    Otp.notify();
  } finally {
    wipe(oldMac);
    wipe(newMac);
  }
}, { required: true });
