/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Одноразовые коды (TOTP, RFC 6238): расчёт кода, разбор ссылок otpauth://, переноса из Google
 * Authenticator и файлов экспорта. Код перенесён из src/browser/base/content/tabora/vault/Otp.sys.mjs
 * без изменений, кроме имени метки перевода (tt → t); tools/web/test/parity.test.mjs сверяет оба
 * файла: один и тот же секрет даёт один и тот же код в браузере и здесь. Правки — сначала там. */

import { t } from "./i18n.js";

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
    throw new Error(t`Секрет должен быть в кодировке Base32 (буквы A–Z и цифры 2–7)`);
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
    throw new Error(t`Алгоритм ${algorithm} не поддерживается`);
  }
  if (![6, 7, 8].includes(digits)) {
    throw new Error(t`Длина кода: 6, 7 или 8 цифр`);
  }
  if (!(period >= 15 && period <= 120)) {
    throw new Error(t`Период от 15 до 120 секунд`);
  }
}

/** Разбор otpauth://totp/Label?secret=…&issuer=…&algorithm=…&digits=…&period=… */
export function parseOtpauth(input) {
  const text = String(input || "").trim();
  if (!/^otpauth:\/\//i.test(text)) {
    throw new Error(t`Это не ссылка otpauth://`);
  }
  let url;
  try {
    url = new URL(text);
  } catch (e) {
    throw new Error(t`Ссылка otpauth:// повреждена`);
  }
  const type = (url.host || url.pathname.split("/")[0] || "").toLowerCase();
  if (type !== "totp") {
    throw new Error(type === "hotp" ? t`Коды со счётчиком (HOTP) пока не поддерживаются` : t`Неизвестный тип кода`);
  }
  let label = url.pathname.replace(/^\/+/, "");
  try {
    label = decodeURIComponent(label);
  } catch (e) {}
  const p = url.searchParams;
  const secret = p.get("secret") || "";
  if (!secret) {
    throw new Error(t`В ссылке нет секрета`);
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
        throw new Error(t`protobuf: обрыв`);
      }
      const b = bytes[i++];
      v |= BigInt(b & 0x7f) << shift;
      shift += 7n;
      if (!(b & 0x80)) {
        return v;
      }
      if (shift > 70n) {
        throw new Error(t`protobuf: varint слишком длинный`);
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
        throw new Error(t`protobuf: длина вне данных`);
      }
      out.push({ field, wire, value: bytes.slice(i, i + len) });
      i += len;
    } else if (wire === 1) {
      i += 8;
    } else if (wire === 5) {
      i += 4;
    } else {
      throw new Error(t`protobuf: неизвестный тип поля`);
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
    throw new Error(t`Это не ссылка экспорта Google Authenticator`);
  }
  let data;
  try {
    data = new URL(text).searchParams.get("data");
  } catch (e) {
    throw new Error(t`Ссылка экспорта повреждена`);
  }
  if (!data) {
    throw new Error(t`В ссылке экспорта нет данных`);
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
    const label = issuer || name || t`запись`;
    if (type !== 2) {
      skipped.push(t`${label}: коды со счётчиком (HOTP) не поддерживаются`);
      continue;
    }
    if (!algorithm) {
      skipped.push(t`${label}: алгоритм не поддерживается`);
      continue;
    }
    if (!secret || !secret.length) {
      skipped.push(t`${label}: нет секрета`);
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
    throw new Error(t`Файл пустой`);
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
      throw new Error(t`Файл не разбирается как JSON`);
    }
    if (json?.header?.slots || json?.db === undefined && json?.header?.params) {
      throw new Error(t`Это зашифрованный экспорт Aegis: экспортируйте без шифрования`);
    }
    if (json?.servicesEncrypted) {
      throw new Error(t`Это зашифрованный экспорт 2FAS: экспортируйте без пароля`);
    }
    const aegis = json?.db?.entries;
    const twofas = json?.services;
    if (Array.isArray(aegis)) {
      for (const e of aegis) {
        const label = e.issuer || e.name || t`запись`;
        if ((e.type || "totp").toLowerCase() !== "totp") {
          skipped.push(t`${label}: тип ${e.type} не поддерживается`);
          continue;
        }
        push({ issuer: cleanText(e.issuer, 48), account: cleanText(e.name, 96), secret: String(e.info?.secret || ""), algorithm: String(e.info?.algo || "SHA1").toUpperCase().replace("-", ""), digits: Number(e.info?.digits || 6), period: Number(e.info?.period || 30) }, label);
      }
    } else if (Array.isArray(twofas)) {
      for (const sv of twofas) {
        const label = sv.name || sv.otp?.issuer || t`запись`;
        if ((sv.otp?.tokenType || "TOTP").toUpperCase() !== "TOTP") {
          skipped.push(t`${label}: тип ${sv.otp?.tokenType} не поддерживается`);
          continue;
        }
        push({ issuer: cleanText(sv.otp?.issuer || sv.name, 48), account: cleanText(sv.otp?.account || sv.otp?.label || "", 96), secret: String(sv.secret || ""), algorithm: String(sv.otp?.algorithm || "SHA1").toUpperCase().replace("-", ""), digits: Number(sv.otp?.digits || 6), period: Number(sv.otp?.period || 30) }, label);
      }
    } else {
      throw new Error(t`Формат файла не распознан (поддерживаются Aegis и 2FAS без шифрования)`);
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
        skipped.push(t`${l.slice(0, 40)}: не ссылка otpauth://`);
      }
    }
  }
  if (!out.length && !skipped.length) {
    throw new Error(t`В файле нет записей`);
  }
  return { entries: out, skipped };
}
