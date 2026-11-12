/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Экран «Коды входа» в приложении для телефона. */

import { t } from "../core/i18n.js";
import { boot } from "./boot.js";
import { mountCodes } from "./codes-view.js";

boot(t`Коды входа`, (root, service) => {
  const view = mountCodes(root, { service });
  // экран закрывают — фоновая страница живёт дальше и не должна звать функции закрытого экрана
  window.addEventListener("pagehide", () => view.destroy());
});
