/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* The support site of Tabora. Three screens (views.js): nobody is signed in, signed in, and a
 * request without an account that is opened by the link from a letter ("#t=<number>.<secret>").
 * The secret of such a link lives after "#": a browser does not send that part to a server. */

import { Api } from "../core/api.js";
import { language, t } from "../core/i18n.js";
import { BrowserStore } from "../core/store.js";
import { clear } from "../lib/dom.js";
import { toast } from "../lib/ui.js";
import { DeskSession } from "./session.js";
import { mountDesk, mountGuest, mountHome } from "./views.js";

const root = document.getElementById("app");
const api = new Api("");
const session = new DeskSession({ api, store: new BrowserStore() });
let current = null;
let shown = "";

const guestKey = () => (/^#t=(\d{1,15}\.[A-Za-z0-9_-]{16,64})$/.exec(location.hash) || [])[1] || "";

function render() {
  const key = guestKey();
  const want = key ? `guest:${key}` : session.signedIn ? "desk" : "home";
  if (want === shown) {
    return;
  }
  shown = want;
  current?.destroy?.();
  clear(root);
  const home = () => {
    location.hash = "#/";
  };
  current = key ? mountGuest(root, { api, session, home }, key) : session.signedIn ? mountDesk(root, { session, api }) : mountHome(root, { session, api });
}

document.documentElement.lang = language();
document.title = t`Поддержка Tabora`;

session.subscribe(what => {
  if (what === "expired") {
    toast(t`Вход на этом устройстве завершён: из аккаунта вышли с другого устройства или сменили пароль. Войдите заново`, { ms: 7000 });
  }
  render();
});
window.addEventListener("hashchange", render);
// another tab signed out: this one must not live on with the old session
window.addEventListener("storage", e => {
  if (e.key === "tabora.session" && e.storageArea === localStorage && !e.newValue && session.signedIn) {
    session._drop("signed-out");
  }
});

(async () => {
  if (window.__taboraUnsupported) {
    return; // the browser does not fit: the explanation is already on the page (static/compat.js)
  }
  try {
    await session.restore();
  } catch (e) {
    console.error(e);
  }
  render();
})();

if (typeof __DEV__ !== "undefined" && __DEV__) {
  window.__tabora = { session, api };
}
