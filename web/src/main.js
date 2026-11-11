/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Веб-версия Tabora: вход в аккаунт и его разделы в любом браузере. Запуск: поднять сохранённую
 * сессию, показать вход или приложение и переключать их по событиям аккаунта. */

import { Account } from "./core/account.js";
import { Api } from "./core/api.js";
import { BrowserStore } from "./core/store.js";
import { SyncClient } from "./core/sync.js";
import { clear } from "./lib/dom.js";
import { toast } from "./lib/ui.js";
import { mountAuth } from "./views/auth.js";
import { mountShell } from "./views/shell.js";

const root = document.getElementById("app");
const api = new Api("");
const account = new Account({ api, store: new BrowserStore() });
const sync = new SyncClient(account);
let current = null;
let shown = "";

function render() {
  const want = account.signedIn && !account._held ? "app" : "auth";
  if (want === shown) {
    return;
  }
  shown = want;
  current?.destroy?.();
  clear(root);
  current = want === "app" ? mountShell(root, { account, sync, api }) : mountAuth(root, { account });
}

account.subscribe(what => {
  if (what === "expired") {
    sync.reset();
    toast("Сессия завершена: войдите заново", { ms: 5000 });
  }
  if (what === "signed-out") {
    sync.reset();
  }
  if (what === "signed-in" || what === "signed-out" || what === "expired") {
    render();
  }
});

// другая вкладка вышла из аккаунта или вошла: эта вкладка не должна жить со старой сессией
window.addEventListener("storage", e => {
  if (e.key === "tabora.session" && e.storageArea === localStorage && !e.newValue && account.signedIn && account.session.remember) {
    account._drop("signed-out");
  }
});

(async () => {
  try {
    await account.restore();
  } catch (e) {
    console.error(e);
  }
  render();
})();

if (typeof __DEV__ !== "undefined" && __DEV__) {
  window.__tabora = { account, sync, api };
}
