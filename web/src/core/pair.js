/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Вход на новом устройстве по QR-коду: шифрование обмена. Код перенесён из
 * src/browser/base/content/tabora/account/Pair.sys.mjs без изменений (там же описание);
 * tools/web/test/parity.test.mjs сверяет оба файла. Правки — сначала там. */

const PAIR_VERSION = 1;
const PAIR_LINK = /^tabora:\/\/pair\?v=1&i=([0-9a-f]{32})&k=([A-Za-z0-9_-]{43})$/;
const PAIR_SALT = "tabora-pair/v1";

const pairUtf8 = text => new TextEncoder().encode(text);

function pairB64(bytes) {
  let bin = "";
  for (const b of bytes) {
    bin += String.fromCharCode(b);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pairBytes(b64) {
  const bin = atob(String(b64).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function pairHex(bytes) {
  let out = "";
  for (const b of bytes) {
    out += b.toString(16).padStart(2, "0");
  }
  return out;
}

/** Одноразовая пара ключей устройства: закрытый не покидает память, открытый уходит другому устройству. */
export async function pairKeys() {
  const pair = await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
  return { privateKey: pair.privateKey, public: pairB64(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))) };
}

/** Текст QR-кода: номер обмена и открытый ключ устройства, которое его показывает. */
export function pairLink(id, publicKey) {
  return `tabora://pair?v=${PAIR_VERSION}&i=${id}&k=${publicKey}`;
}

/** Разобрать считанный QR-код; null — это не код входа Tabora. */
export function pairParse(text) {
  const m = PAIR_LINK.exec(String(text ?? "").trim());
  return m ? { id: m[1], public: m[2] } : null;
}

/** Секрет, которым новое устройство забирает результат, и его отпечаток для сервера. */
export async function pairClaim() {
  const secret = pairHex(crypto.getRandomValues(new Uint8Array(32)));
  return { secret, claim: pairHex(new Uint8Array(await crypto.subtle.digest("SHA-256", pairUtf8(secret)))) };
}

/**
 * Общий секрет двух устройств: ключ шифрования и код сверки. starter — открытый ключ устройства,
 * показавшего QR-код, joiner — считавшего; порядок одинаков на обеих сторонах.
 */
export async function pairSecrets(privateKey, peerPublic, { id, starter, joiner }) {
  const peer = await crypto.subtle.importKey("raw", pairBytes(peerPublic), { name: "X25519" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: peer }, privateKey, 256));
  if (!shared.some(b => b)) {
    throw new Error("pair: непригодный ключ устройства");
  }
  const base = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  shared.fill(0);
  const derive = async what =>
    new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: pairUtf8(PAIR_SALT), info: pairUtf8(`${what}|${id}|${starter}|${joiner}`) }, base, 256));
  const key = await derive("key");
  const digits = await derive("code");
  const n = ((digits[0] << 24) | (digits[1] << 16) | (digits[2] << 8) | digits[3]) >>> 0;
  return { key, code: String(n % 1000000).padStart(6, "0") };
}

/** Зашифровать то, что первое устройство передаёт новому (ключ данных аккаунта). */
export async function pairSeal(key, id, data) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const k = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: pairUtf8(`${PAIR_SALT}|payload|${id}`) }, k, pairUtf8(JSON.stringify({ v: PAIR_VERSION, ...data }))));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return pairB64(out);
}

/** Расшифровать переданное; null — прислано не тем устройством или испорчено в пути. */
export async function pairOpen(key, id, payload) {
  try {
    const blob = pairBytes(payload);
    const k = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: blob.subarray(0, 12), additionalData: pairUtf8(`${PAIR_SALT}|payload|${id}`) }, k, blob.subarray(12));
    const data = JSON.parse(new TextDecoder().decode(plain));
    return data && data.v === PAIR_VERSION ? data : null;
  } catch (e) {
    return null;
  }
}
