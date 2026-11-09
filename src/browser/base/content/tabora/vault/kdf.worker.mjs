/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Рабочий поток Argon2id (см. Kdf.sys.mjs). */

import { argon2id } from "chrome://tabora/content/wallet/vendor/crypto.sys.mjs";

self.onmessage = e => {
  const { password, salt, opts } = e.data;
  try {
    const out = argon2id(password, salt, opts);
    password.fill(0);
    postMessage({ ok: true, out }, [out.buffer]);
  } catch (err) {
    postMessage({ ok: false, error: String((err && err.message) || err) });
  }
};
