/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Рабочий поток Argon2id (см. Kdf.sys.mjs). Основной путь — WebAssembly (hash-wasm), он
 * примерно в 20 раз быстрее чистого JS. Перед первым расчётом сверяется с эталоном на малых
 * параметрах; при любом расхождении или ошибке расчёт идёт прежней реализацией. */

import { argon2id as nobleArgon2id } from "chrome://tabora/content/wallet/vendor/crypto.sys.mjs";
import { argon2id as wasmArgon2id } from "chrome://tabora/content/vault/vendor/argon2.sys.mjs";

let wasmOk = null;

async function wasmHash(password, salt, { t, m, p, dkLen }) {
  return wasmArgon2id({ password, salt, iterations: t, memorySize: m, parallelism: p, hashLength: dkLen, outputType: "binary" });
}

async function wasmUsable() {
  if (wasmOk === null) {
    try {
      const pw = new TextEncoder().encode("tabora-kdf-selftest");
      const salt = new Uint8Array(16).fill(7);
      const opts = { t: 2, m: 64, p: 1, dkLen: 32 };
      const a = await wasmHash(pw, salt, opts);
      const b = nobleArgon2id(pw, salt, opts);
      wasmOk = a.length === b.length && a.every((x, i) => x === b[i]);
    } catch (e) {
      wasmOk = false;
    }
  }
  return wasmOk;
}

self.onmessage = async e => {
  const { password, salt, opts } = e.data;
  try {
    let out = null;
    if (await wasmUsable()) {
      try {
        out = await wasmHash(password, salt, opts);
      } catch (err) {
        out = null;
      }
    }
    if (!out) {
      out = nobleArgon2id(password, salt, opts);
    }
    password.fill(0);
    postMessage({ ok: true, out }, [out.buffer]);
  } catch (err) {
    password.fill(0);
    postMessage({ ok: false, error: String((err && err.message) || err) });
  }
};
