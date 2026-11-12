/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Ключи из пароля аккаунта. Схема та же, что в браузере Tabora (account/Account.sys.mjs):
 *   k         = Argon2id(NFKC(пароль), соль = SHA-256("tabora-auth-v2|" + адрес)[0..16])
 *   хеш входа = HMAC-SHA-256(k, "login")                — уходит на сервер вместо пароля
 *   ключ копии = HMAC-SHA-256(k, "mail-keys-backup-v1") — им завёрнут ключ данных аккаунта;
 *                                                         сервер его не получает
 * Сам пароль и k страницу не покидают. */

import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import { hex, utf8, wipe } from "./bytes.js";
import { argon2id } from "./kdf-core.js";
import { t } from "./i18n.js";

export const AUTH_KDF = { 1: { t: 2, m: 16384, p: 1, dkLen: 32 }, 2: { t: 3, m: 65536, p: 1, dkLen: 32 } };
const AUTH_SALT = { 1: "tabora-auth|", 2: "tabora-auth-v2|" };
export const KDF_CURRENT = 2;

/* Адрес рабочего потока подставляет сборка (tools/web/build.mjs); в проверках под Node его нет,
 * и расчёт идёт прямо здесь. */
const WORKER_URL = typeof __KDF_WORKER__ === "string" ? __KDF_WORKER__ : "";

function inWorker(password, salt, opts) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(WORKER_URL);
    } catch (e) {
      reject(e);
      return;
    }
    const done = () => worker.terminate();
    worker.onmessage = e => {
      done();
      if (e.data?.ok) {
        resolve(new Uint8Array(e.data.out));
      } else {
        reject(new Error(e.data?.error || t`Не удалось вычислить ключ`));
      }
    };
    worker.onerror = e => {
      done();
      reject(new Error(e.message || t`Не удалось вычислить ключ`));
    };
    const pw = password.slice();
    const s = salt.slice();
    worker.postMessage({ password: pw, salt: s, opts }, [pw.buffer, s.buffer]);
  });
}

async function derive(password, salt, opts) {
  if (WORKER_URL && typeof Worker === "function") {
    try {
      return await inWorker(password, salt, opts);
    } catch (e) {
      // рабочий поток недоступен (редкие встроенные браузеры): считаем здесь
    }
  }
  return (await argon2id(password.slice(), salt, opts)).out;
}

/**
 * @param {string} email адрес аккаунта в нижнем регистре
 * @param {string} password
 * @param {number} kdf версия схемы (от сервера, /v1/account/prelogin)
 * @returns {Promise<{ loginHash: string, wrapKey: Uint8Array }>} wrapKey затереть после использования
 */
export async function passwordKeys(email, password, kdf = KDF_CURRENT) {
  const opts = AUTH_KDF[kdf];
  if (!opts) {
    throw new Error(t`Неизвестная версия защиты пароля. Обновите страницу`);
  }
  const salt = sha256(utf8(`${AUTH_SALT[kdf]}${email}`)).slice(0, 16);
  const pw = utf8(String(password).normalize("NFKC"));
  let k = null;
  try {
    k = await derive(pw, salt, opts);
    return { loginHash: hex(hmac(sha256, k, utf8("login"))), wrapKey: hmac(sha256, k, utf8("mail-keys-backup-v1")) };
  } finally {
    wipe(pw, k);
  }
}
