import { t } from "./i18n.js";
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Вызовы OpenPGP: операции выполняет рабочий поток (pgp.worker.js). */

const WORKER_URL = typeof __PGP_WORKER__ === "string" ? __PGP_WORKER__ : "";

let worker = null;
let seq = 0;
const waiting = new Map();
let direct = null;

function start() {
  worker = new Worker(WORKER_URL);
  worker.onmessage = e => {
    const { id, ok, value, error } = e.data || {};
    const w = waiting.get(id);
    if (!w) {
      return;
    }
    waiting.delete(id);
    if (ok) {
      w.resolve(value);
    } else {
      w.reject(Object.assign(new Error(error || t`Ошибка шифрования`), { code: "pgp" }));
    }
  };
  worker.onerror = e => {
    // поток упал: все ожидающие получают отказ, следующий вызов запустит новый
    for (const w of waiting.values()) {
      w.reject(Object.assign(new Error(e.message || t`Модуль шифрования не запустился`), { code: "pgp" }));
    }
    waiting.clear();
    worker = null;
  };
}

/** Проверки под Node передают операции напрямую (там нет рабочих потоков браузера). В сборку
 * приложения библиотека попадает один раз — в файл рабочего потока. */
export function setPgpEngine(api) {
  direct = api;
}

export async function pgpCall(method, args = {}) {
  if (direct) {
    try {
      return await direct[method](args);
    } catch (e) {
      throw Object.assign(new Error(String(e?.message || e).slice(0, 400)), { code: "pgp" });
    }
  }
  if (!WORKER_URL || typeof Worker !== "function") {
    throw Object.assign(new Error(t`Этот браузер не умеет запускать модуль шифрования. Обновите браузер`), { code: "pgp" });
  }
  if (!worker) {
    start();
  }
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    worker.postMessage({ id, method, args });
  });
}

/** Тело брони без заголовков и контрольной суммы: в таком виде сервер хранит открытый ключ. */
export function armorBody(armored) {
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

export function formatFingerprint(fp) {
  return String(fp || "").toUpperCase().replace(/(.{4})/g, "$1 ").trim();
}
