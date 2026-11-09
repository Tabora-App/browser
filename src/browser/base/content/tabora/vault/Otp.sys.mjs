/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Одноразовые коды (TOTP, RFC 6238). Записи лежат в tabora-otp.json: издатель, аккаунт,
 * параметры и привязанные домены открыто (как origin в хранилище паролей), секрет —
 * зашифрован производным ключом сейфа (Vault.subkey("otp")). Расшифрованные секреты
 * живут в памяти, пока сейф разблокирован, и обнуляются при блокировке. Код считается
 * в родительском процессе; страница получает только сам код после действия пользователя. */

const { Vault } = ChromeUtils.importESModule("chrome://browser/content/tabora/vault/Vault.sys.mjs");

const FILE = () => PathUtils.join(PathUtils.profileDir, "tabora-otp.json");
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

export const Otp = {
  TOPIC: "tabora-otp-changed",
  data: null,
  _loaded: false,
  _secrets: new Map(), // id → Uint8Array, пока сейф разблокирован
  _observing: false,

  async ready() {
    if (this._loaded) {
      return this.data;
    }
    try {
      this.data = await IOUtils.readJSON(FILE());
      if (!this.data || this.data.version !== 1 || !Array.isArray(this.data.entries)) {
        throw new Error("Неизвестный формат файла кодов");
      }
    } catch (e) {
      if (e.name !== "NotFoundError") {
        console.error("Tabora otp", e);
      }
      this.data = { version: 1, entries: [] };
    }
    this._loaded = true;
    if (!this._observing) {
      this._observing = true;
      Services.obs.addObserver((s, t, what) => {
        if (what === "locked") {
          this.forget();
        }
      }, Vault.TOPIC);
    }
    return this.data;
  },

  get entries() {
    return this.data?.entries || [];
  },

  notify(what = "changed") {
    Services.obs.notifyObservers(null, this.TOPIC, what);
  },

  async save() {
    this.data.updatedAt = new Date().toISOString();
    await IOUtils.writeJSON(FILE(), this.data, { tmpPath: FILE() + ".tmp" });
    try {
      await IOUtils.setPermissions(FILE(), 0o600);
    } catch (e) {}
    this.notify();
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

  /** Домены записи из произвольного ввода: «github.com, www.github.com» → ["github.com"]. */
  normalizeDomains(list) {
    const out = new Set();
    for (const raw of Array.isArray(list) ? list : String(list || "").split(/[\s,;]+/)) {
      let host = String(raw || "").trim().toLowerCase();
      if (!host) {
        continue;
      }
      try {
        host = new URL(host.includes("://") ? host : `https://${host}`).hostname;
      } catch (e) {
        continue;
      }
      const base = this.baseDomain(host);
      if (base && /^[a-z0-9.-]+\.[a-z0-9-]{2,}$/i.test(base)) {
        out.add(base);
      }
    }
    return [...out].slice(0, 8);
  },

  /** Домен по издателю, если издатель сам похож на домен (github.com) или есть запись-подсказка. */
  guessDomain(issuer) {
    const s = String(issuer || "").trim().toLowerCase();
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s)) {
      return this.normalizeDomains([s]);
    }
    return [];
  },

  async add(fields) {
    await this.ready();
    Vault.requireUnlocked();
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
    const id = `o${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const entry = {
      id,
      issuer,
      account,
      algorithm,
      digits,
      period,
      domains: this.normalizeDomains(fields.domains || []),
      createdAt: new Date().toISOString(),
      secret: await Vault.encrypt("otp", secret),
    };
    this.data.entries.push(entry);
    this._secrets.set(id, secret);
    await this.save();
    return this.meta(entry);
  },

  async update(id, fields) {
    await this.ready();
    const entry = this.entries.find(e => e.id === id);
    if (!entry) {
      throw new Error("Запись не найдена");
    }
    if ("issuer" in fields) {
      entry.issuer = cleanText(fields.issuer, 48);
    }
    if ("account" in fields) {
      entry.account = cleanText(fields.account, 96);
    }
    if ("domains" in fields) {
      entry.domains = this.normalizeDomains(fields.domains);
    }
    if (!entry.issuer && !entry.account) {
      throw new Error("Укажите сервис или аккаунт");
    }
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
    const { secret, ...rest } = entry;
    return rest;
  },

  list() {
    return this.entries.map(e => this.meta(e));
  },

  /** Записи для сайта: по базовому домену (поддомены считаются тем же сайтом). */
  forHost(host) {
    const base = this.baseDomain(host);
    if (!base) {
      return [];
    }
    return this.entries.filter(e => (e.domains || []).includes(base)).map(e => this.meta(e));
  },

  async secretOf(id) {
    Vault.requireUnlocked();
    let s = this._secrets.get(id);
    if (!s) {
      const entry = this.entries.find(e => e.id === id);
      if (!entry) {
        throw new Error("Запись не найдена");
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
