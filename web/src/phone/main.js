/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Экран «Аккаунт Tabora» в приложении для телефона: вход или сведения об аккаунте. Сам экран
 * ничего не хранит: аккаунт и синхронизация живут в фоновой странице модуля (background.js),
 * отсюда берётся тот же объект. */

import { clear, h } from "../lib/dom.js";
import { toast } from "../lib/ui.js";
import { mountAuth } from "../views/auth.js";
import { language, t } from "../core/i18n.js";
import { mountPhoneAccount } from "./view.js";

const root = document.getElementById("app");
document.documentElement.lang = language();
document.title = t`Аккаунт Tabora`;

function broken(e) {
  console.error("Tabora: экран аккаунта не открылся", e);
  clear(root, h("div", { class: "empty" }, h("h3", {}, t`Аккаунт не открылся`), h("p", {}, t`Закройте приложение и откройте его снова.`),
    // в сборке для разработки причина видна на экране: журнал страницы в выпускном приложении не читается
    typeof __DEV__ !== "undefined" && __DEV__ && h("p", { class: "mono small-text" }, `${e}\n${e?.stack || ""}`)));
}

(async () => {
  const background = await globalThis.browser.runtime.getBackgroundPage();
  // фоновая страница может ещё запускаться: её объект появляется, когда выполнится её скрипт
  for (let i = 0; i < 200 && background && !background.tabora; i++) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const service = background?.tabora;
  if (!service) {
    throw new Error("фоновая страница модуля недоступна");
  }
  await service.ready;
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
      : mountAuth(root, { account, embedded: true, intro: { title: t`Вход`, text: t`Войдите, чтобы вкладки этого телефона и других ваших устройств были видны друг другу.` } });
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
})().catch(broken);
