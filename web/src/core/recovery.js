/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Ключ восстановления: 20 случайных байт, 8 групп по 4 символа Base32. Формат и производные ключи
 * те же, что в браузере Tabora (vault/Vault.sys.mjs): ключ, выданный здесь, подходит там, и наоборот.
 *   пара Ed25519 для подписи сброса пароля — HMAC(ключ, "tabora-account-recovery-ed25519-v1")
 *   ключ обёртки копии ключей почты      — HMAC(ключ, "tabora-mail-keys-recovery-v1")
 * Серверу достаётся только открытая половина пары. */

import { ed25519 } from "@noble/curves/ed25519";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import { hex, random, utf8, wipe } from "./bytes.js";
import { t } from "./i18n.js";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const SIGN_INFO = "tabora-account-recovery-ed25519-v1";
const MAIL_KEYS_INFO = "tabora-mail-keys-recovery-v1";

export function rkFormat(bytes) {
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
  return out.match(/.{1,4}/g).join("-");
}

export function rkParse(input) {
  const clean = String(input || "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/0/g, "O").replace(/1/g, "L").replace(/8/g, "B");
  if (clean.length !== 32 || /[^A-Z2-7]/.test(clean)) {
    throw new Error(t`Ключ восстановления: 32 символа в 8 группах по 4`);
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

export function rkNew() {
  const rk = random(20);
  try {
    return rkFormat(rk);
  } finally {
    wipe(rk);
  }
}

/** Ключ проверки для сервера: `ed25519:<открытый ключ>`. */
export function rkVerifier(rkText) {
  const rk = rkParse(rkText);
  const seed = hmac(sha256, rk, utf8(SIGN_INFO));
  try {
    return `ed25519:${hex(ed25519.getPublicKey(seed))}`;
  } finally {
    wipe(rk, seed);
  }
}

/** Подпись запроса сброса пароля: её сервер проверяет открытым ключом. */
export function rkSignReset(rkText, email, newLoginHash, nonce) {
  const rk = rkParse(rkText);
  const seed = hmac(sha256, rk, utf8(SIGN_INFO));
  try {
    return hex(ed25519.sign(utf8(`tabora-reset-v2|${email}|${newLoginHash}|${nonce}`), seed));
  } finally {
    wipe(rk, seed);
  }
}

/** Ключ, которым завёрнут ключ данных аккаунта в копии на сервере. Затереть после использования. */
export function rkWrapKey(rkText) {
  const rk = rkParse(rkText);
  try {
    return hmac(sha256, rk, utf8(MAIL_KEYS_INFO));
  } finally {
    wipe(rk);
  }
}
