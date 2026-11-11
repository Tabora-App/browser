/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Рабочий поток OpenPGP: операции из pgp-ops.js отдельно от страницы. */

import { API } from "./pgp-ops.js";

self.onmessage = e => {
  const { id, method, args } = e.data || {};
  (async () => {
    if (!Object.hasOwn(API, method)) {
      throw new Error(`нет операции ${method}`);
    }
    return API[method](args || {});
  })().then(
    value => postMessage({ id, ok: true, value }),
    err => postMessage({ id, ok: false, error: String(err?.message || err).slice(0, 400) })
  );
};
