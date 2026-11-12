/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Общее начало экранов модуля: найти службу аккаунта в фоновой странице и дождаться её готовности.
 * Экраны ничего своего не хранят — аккаунт и данные живут там. */

import { clear, h } from "../lib/dom.js";
import { language, t } from "../core/i18n.js";

/** Служба аккаунта из фоновой страницы модуля. */
export async function findService() {
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
  return service;
}

/** Запустить экран: title — заголовок страницы, start(root, service) — отрисовка. */
export function boot(title, start) {
  const root = document.getElementById("app");
  document.documentElement.lang = language();
  document.title = title;
  findService().then(service => start(root, service)).catch(e => {
    console.error("Tabora: экран не открылся", e);
    clear(root, h("div", { class: "empty" }, h("h3", {}, t`Экран не открылся`), h("p", {}, t`Закройте приложение и откройте его снова.`),
      // в сборке для разработки причина видна на экране: журнал страницы в выпускном приложении не читается
      typeof __DEV__ !== "undefined" && __DEV__ && h("p", { class: "mono small-text" }, `${e}\n${e?.stack || ""}`)));
  });
}
