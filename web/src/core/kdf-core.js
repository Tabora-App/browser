/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Argon2id: основной путь — WebAssembly (hash-wasm), запасной — чистый JS (noble). Перед первым
 * расчётом быстрая реализация сверяется с эталонной на малых параметрах: при расхождении или
 * ошибке (старый браузер, WebAssembly выключен) считает эталонная, медленнее примерно в 20 раз.
 * Так же устроен рабочий поток KDF в браузере Tabora (vault/kdf.worker.mjs). */

import { argon2id as nobleArgon2id } from "@noble/hashes/argon2";
import { argon2id as wasmArgon2id } from "hash-wasm";

let wasmOk = null;

function wasmHash(password, salt, { t, m, p, dkLen }) {
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

/** @returns {Promise<{ out: Uint8Array, engine: "wasm" | "js" }>} */
export async function argon2id(password, salt, opts) {
  if (await wasmUsable()) {
    try {
      return { out: await wasmHash(password, salt, opts), engine: "wasm" };
    } catch (e) {}
  }
  return { out: nobleArgon2id(password, salt, opts), engine: "js" };
}
