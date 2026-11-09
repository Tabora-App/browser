/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Argon2id вне главного потока. Вывод ключа занимает около секунды (64 МБ, 3 прохода),
 * и в главном потоке он замораживал интерфейс: кнопка не успевала показать загрузку.
 * Рабочий поток создаётся на один вызов и завершается, чтобы не держать 64 МБ. */

const C = ChromeUtils.importESModule("chrome://tabora/content/wallet/vendor/crypto.sys.mjs");
const WORKER_URL = "chrome://tabora/content/vault/kdf.worker.mjs";

/**
 * @param {Uint8Array} password байты пароля (после вызова затираются)
 * @param {Uint8Array} salt
 * @param {{t:number,m:number,p:number,dkLen:number}} opts
 * @returns {Promise<Uint8Array>}
 */
export function argon2idAsync(password, salt, opts) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new ChromeWorker(WORKER_URL, { type: "module" });
    } catch (e) {
      // рабочий поток недоступен: считаем в главном
      try {
        resolve(C.argon2id(password, salt, opts));
      } catch (err) {
        reject(err);
      } finally {
        password.fill(0);
      }
      return;
    }
    const done = () => {
      worker.terminate();
      password.fill(0);
    };
    worker.onmessage = e => {
      done();
      if (e.data?.ok) {
        resolve(new Uint8Array(e.data.out));
      } else {
        reject(new Error(e.data?.error || "KDF: ошибка рабочего потока"));
      }
    };
    worker.onerror = e => {
      done();
      reject(new Error(`KDF: ${e.message || "ошибка рабочего потока"}`));
    };
    // копии: исходные байты остаются у вызывающего и затираются в done()
    const pw = password.slice();
    const s = salt.slice();
    worker.postMessage({ password: pw, salt: s, opts: { t: opts.t, m: opts.m, p: opts.p, dkLen: opts.dkLen } }, [pw.buffer, s.buffer]);
  });
}
