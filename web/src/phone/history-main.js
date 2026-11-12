/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* The "History of other devices" screen in the phone app. */

import { t } from "../core/i18n.js";
import { boot } from "./boot.js";
import { mountHistory } from "./history-view.js";

boot(t`История других устройств`, (root, service) => {
  const view = mountHistory(root, { service });
  // the screen is closed, the background page lives on and must not call the closed screen
  window.addEventListener("pagehide", () => view.destroy());
});
