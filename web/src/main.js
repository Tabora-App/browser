/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Веб-версия Tabora: почта аккаунта в любом браузере. Запуск: поднять сохранённую сессию,
 * показать вход или почту и переключать их по событиям аккаунта. */

import { Account } from "./core/account.js";
import { Api } from "./core/api.js";
import { BrowserStore } from "./core/store.js";
import { clear } from "./lib/dom.js";
import { toast } from "./lib/ui.js";
import { mountAuth } from "./views/auth.js";
import { mountShell } from "./views/shell.js";
import { language, t } from "./core/i18n.js";

const root = document.getElementById("app");
const api = new Api("");
const account = new Account({ api, store: new BrowserStore() });
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
  current = want === "app" ? mountShell(root, { account, api }) : mountAuth(root, { account });
}

// Страница на языке интерфейса: атрибут lang, заголовок и описание для установки на экран
document.documentElement.lang = language();
document.title = t`Почта Tabora`;
document.querySelector('meta[name="apple-mobile-web-app-title"]')?.setAttribute("content", t`Почта Tabora`);
if (language() !== "en") {
  document.querySelector('link[rel="manifest"]')?.setAttribute("href", `/manifest-${language()}.webmanifest`);
}

account.subscribe(what => {
  if (what === "expired") {
    toast(t`Вход на этом устройстве завершён: из аккаунта вышли с другого устройства или сменили пароль. Войдите заново`, { ms: 7000 });
  }
  if (what === "signed-in" || what === "signed-out" || what === "expired") {
    render();
  }
});

// другая вкладка вышла из аккаунта или вошла: эта вкладка не должна жить со старой сессией
window.addEventListener("storage", e => {
  if (e.key === "tabora.session" && e.storageArea === localStorage && !e.newValue && account.signedIn) {
    account._drop("signed-out");
  }
});

(async () => {
  if (window.__taboraUnsupported) {
    return; // браузер не подходит: объяснение уже на странице (static/compat.js)
  }
  try {
    await account.restore();
  } catch (e) {
    console.error(e);
  }
  render();
})();

if (typeof __DEV__ !== "undefined" && __DEV__) {
  window.__tabora = { account, api };
}
