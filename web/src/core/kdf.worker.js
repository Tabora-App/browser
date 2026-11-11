/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Рабочий поток Argon2id: 64 МБ и три прохода в главном потоке заморозили бы страницу. */

import { argon2id } from "./kdf-core.js";

self.onmessage = async e => {
  const { password, salt, opts } = e.data;
  try {
    const { out, engine } = await argon2id(password, salt, opts);
    password.fill(0);
    postMessage({ ok: true, out, engine }, [out.buffer]);
  } catch (err) {
    password.fill(0);
    postMessage({ ok: false, error: String((err && err.message) || err) });
  }
};
