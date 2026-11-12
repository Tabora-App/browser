/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Экран «Почта» в приложении для телефона: та же почта, что в веб-версии (views/shell.js), с тем же
 * входом, что у синхронизации. Отдельного входа нет: сессию хранит приложение, страница только
 * читает её.
 *
 * Почта работает со своим объектом аккаунта, созданным в этой странице (ключ почты, разбор и
 * шифрование писем живут здесь же), а не с объектом фоновой страницы: так данные не ходят между
 * двумя страницами. Сохранённый вход она не меняет и не стирает — этим ведает фоновая служба. */

import { Account } from "../core/account.js";
import { Api } from "../core/api.js";
import { clear, h } from "../lib/dom.js";
import { emptyState } from "../lib/ui.js";
import { mountShell } from "../views/shell.js";
import { t } from "../core/i18n.js";
import { boot } from "./boot.js";

boot(t`Почта Tabora`, (root, service) => {
  const shared = service.store;
  // вход только читается: запись и стирание — дело фоновой службы
  const store = { deviceId: () => shared.deviceId(), load: () => shared.load(), save: async () => {}, clear: async () => {} };
  const api = new Api(service.api.base);
  const account = new Account({ api, store, deviceName: () => shared.deviceName() });
  // «Выйти» в меню почты — выход из аккаунта на телефоне целиком
  account.signOut = () => service.signOut();
  let current = null;
  let shown = "";

  async function render() {
    const signedIn = service.account.signedIn && !service.account._held;
    if (signedIn && !account.signedIn) {
      await account.restore();
    }
    const want = signedIn && account.signedIn ? "mail" : "auth";
    if (want === shown) {
      return;
    }
    shown = want;
    current?.destroy?.();
    current = null;
    clear(root);
    if (want === "mail") {
      current = mountShell(root, { account, api });
    } else {
      clear(root, h("div", { class: "phone-page codes-page" }, h("div", { class: "codes-body" },
        emptyState({ iconName: "mail", title: t`Войдите в аккаунт Tabora`, text: t`Почта открывается тем же входом, что и синхронизация.`, action: h("button", { class: "btn primary", onclick: () => service.open("account") }, t`Войти`) }))));
    }
  }

  // вышли из аккаунта (здесь или с другого устройства) — почта закрывается
  const off = service.account.subscribe(what => {
    if (what === "signed-out" || what === "expired") {
      account._drop("signed-out").then(render);
    } else if (what === "signed-in") {
      render();
    }
  });
  account.subscribe(what => {
    if (what === "expired") {
      service.run().catch(() => {}); // сервер не признал сессию: фоновая служба проверит и завершит вход
      render();
    }
  });
  window.addEventListener("pagehide", () => {
    off();
    current?.destroy?.();
  });
  render();
});
