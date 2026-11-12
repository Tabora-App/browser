import { t } from "./i18n.js";
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Байты, кодировки и случайность. Только то, что есть во всех браузерах: без Uint8Array.fromBase64
 * и прочих новых методов, которых нет на телефонах постарше. */

const te = new TextEncoder();
const td = new TextDecoder();

export const utf8 = text => te.encode(String(text));
export const text = bytes => td.decode(bytes);

export function hex(bytes) {
  let out = "";
  for (const b of bytes) {
    out += b.toString(16).padStart(2, "0");
  }
  return out;
}

export function fromHex(s) {
  if (typeof s !== "string" || s.length % 2 || /[^0-9a-f]/i.test(s)) {
    throw new Error(t`Неверная шестнадцатеричная строка`);
  }
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.substr(i * 2, 2), 16);
  }
  return out;
}

export function b64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function fromB64(s) {
  const bin = atob(String(s).replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

/** Base64 или null: для полей сервера, которых может не быть. */
export function tryB64(s) {
  try {
    return typeof s === "string" && s ? fromB64(s) : null;
  } catch (e) {
    return null;
  }
}

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function same(a, b) {
  if (!a || !b || a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

export function random(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function wipe(...arrays) {
  for (const a of arrays) {
    if (a && a.fill) {
      a.fill(0);
    }
  }
}

/** Номер из букв и цифр для устройства и записей: n байт случайности. */
export function randomId(n = 12) {
  return b64(random(n)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function uuid() {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }
  const b = random(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** AES-256-GCM: nonce (12 байт) и шифртекст с меткой. label привязывает блок к назначению. Формат
 * тот же, что в браузере Tabora (mail/Pgp.sys.mjs, sealBytes/openBytes). */
export async function seal(key, label, plain) {
  const iv = random(12);
  const k = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(label) }, k, plain));
  return concat(iv, ct);
}

export async function open(key, label, blob) {
  if (!key || !blob || blob.length < 28) {
    return null;
  }
  try {
    const k = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: blob.subarray(0, 12), additionalData: utf8(label) }, k, blob.subarray(12)));
  } catch (e) {
    return null;
  }
}

export async function hkdf(key, salt, info) {
  const k = await crypto.subtle.importKey("raw", key, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: utf8(salt), info: utf8(info) }, k, 256));
}

export async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}
