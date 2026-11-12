/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Экран «Аккаунт Tabora» в приложении для телефона: вход или сведения об аккаунте. Сам экран
 * ничего не хранит: аккаунт и синхронизация живут в фоновой странице модуля (background.js),
 * отсюда берётся тот же объект. */

import { clear } from "../lib/dom.js";
import { toast } from "../lib/ui.js";
import { mountAuth } from "../views/auth.js";
import { t } from "../core/i18n.js";
import { boot } from "./boot.js";
import { mountPhoneAccount } from "./view.js";

boot(t`Аккаунт Tabora`, (root, service) => {
  const { account } = service;
  let current = null;
  let shown = "";

  function render() {
    const want = account.signedIn && !account._held ? "account" : "auth";
    if (want === shown) {
      return;
    }
    shown = want;
    current?.destroy?.();
    clear(root);
    current = want === "account"
      ? mountPhoneAccount(root, { service })
      : mountAuth(root, { account, embedded: true, intro: { title: t`Вход`, text: t`Войдите, чтобы вкладки и коды входа были общими для этого телефона и других ваших устройств.` } });
  }

  const off = account.subscribe(what => {
    if (what === "expired") {
      toast(t`Вход на этом устройстве завершён: из аккаунта вышли с другого устройства или сменили пароль. Войдите заново`, { ms: 7000 });
    }
    if (what === "signed-in" || what === "signed-out" || what === "expired") {
      render();
    }
  });
  // экран закрывают — фоновая страница живёт дальше и не должна звать функции закрытого экрана
  window.addEventListener("pagehide", () => {
    off();
    current?.destroy?.();
    account.onStep = null;
  });
  render();
});
