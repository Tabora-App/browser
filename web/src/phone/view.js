/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Экран «Аккаунт Tabora» в приложении для телефона после входа: кто вошёл, что синхронизируется
 * и вкладки каких устройств видны. Сами вкладки других устройств открываются из списка вкладок
 * приложения — здесь только сведения о них. */

import { clear, h, icon } from "../lib/dom.js";
import { avatar, busy, confirmDialog, errorText, plural, shortDate, toast, toggle } from "../lib/ui.js";
import { unlockKeysDialog } from "../views/account.js";
import { t } from "../core/i18n.js";

/**
 * @param {HTMLElement} root
 * @param {{ service: import("./service.js").Service }} ctx
 */
export function mountPhoneAccount(root, { service }) {
  const { account } = service;
  const body = h("div", { class: "settings" });
  clear(root, h("div", { class: "phone-page" }, body));
  let alive = true;
  const off = service.subscribe(() => alive && draw());

  function status(s) {
    if (!s.tabsOn && !s.codesOn) {
      return { text: t`Выключена: на этом телефоне ничего не синхронизируется.` };
    }
    if (s.keys === "locked" || s.status === "locked") {
      return {
        tone: "warn",
        text: t`Ключ аккаунта на этом телефоне не открыт: его копия на сервере привязана к прежнему паролю.`,
        action: h("button", { class: "btn small", onclick: () => unlockKeysDialog({ account }) }, t`Открыть ключ`),
      };
    }
    if (s.status === "ok") {
      return { text: t`Данные сверены ${shortDate(s.at)}.` };
    }
    if (s.status === "offline") {
      return { tone: "warn", text: t`Сервер не отвечает. Сверка повторится сама, когда соединение вернётся.` };
    }
    if (s.status === "key" || s.status === "error") {
      return { tone: "bad", text: t`Сверка не удалась: ${s.error || t`неизвестная ошибка`}` };
    }
    return { text: t`Идёт сверка…` };
  }

  function syncCard(s) {
    const st = status(s);
    const now = h("button", { class: "btn small", onclick: async () => {
      try {
        await busy(now, () => service.run(), t`Сверяем`);
      } catch (e) {
        toast(errorText(e), { tone: "bad" });
      }
    } }, t`Сверить сейчас`);
    return h("section", { class: "card" },
      h("h2", { class: "card-title" }, t`Синхронизация`),
      h("div", { class: "kv tall" },
        h("div", { class: "kv-text" },
          h("span", {}, t`Вкладки`),
          h("small", { class: "wrap" }, t`Открытые вкладки этого телефона видны на других ваших устройствах, а их вкладки — в списке вкладок здесь. Приватные вкладки не передаются.`)),
        h("div", { class: "kv-actions" }, toggle(s.tabsOn, on => service.setTabs(on), t`Вкладки`))),
      h("div", { class: "kv tall" },
        h("div", { class: "kv-text" },
          h("span", {}, t`Коды входа`),
          h("small", { class: "wrap" }, t`Коды второго шага для сайтов — те же, что в Tabora на компьютере. На привязанных сайтах Tabora сам предложит вставить код.`)),
        h("div", { class: "kv-actions" }, toggle(s.codesOn, on => service.setCodes(on), t`Коды входа`))),
      s.codesOn && h("div", { class: "kv" },
        h("div", { class: "kv-text" }, h("small", { class: "wrap" }, s.loaded ? (s.codes ? plural(s.codes, t`код|кода|кодов`) : t`Кодов пока нет`) : t`Идёт сверка…`)),
        h("div", { class: "kv-actions buttons" }, h("button", { class: "btn small", onclick: () => service.open("codes") }, t`Открыть коды`))),
      h("div", { class: `kv tall sync-status${st.tone ? ` ${st.tone}` : ""}` },
        h("div", { class: "kv-text" }, h("small", { class: "wrap" }, st.text)),
        h("div", { class: "kv-actions buttons" }, st.action || ((s.tabsOn || s.codesOn) && now))),
      h("p", { class: "card-note" }, t`Данные шифруются на телефоне ключом вашего аккаунта. Сервер хранит их зашифрованными и прочитать не может.`));
  }

  function devicesCard(s) {
    if (!s.tabsOn) {
      return null;
    }
    const rows = s.devices.map(d => h("div", { class: "kv" },
      h("span", { class: "kv-icon" }, icon("devices", 20)),
      h("div", { class: "kv-text" },
        h("span", {}, d.name || t`Другое устройство`),
        h("small", {}, t`${plural(d.tabs.length, t`вкладка|вкладки|вкладок`)}, обновлено ${shortDate(d.at)}`))));
    return h("section", { class: "card" },
      h("h2", { class: "card-title" }, t`Вкладки на других устройствах`),
      rows.length ? rows : h("p", { class: "card-note" }, t`Пока пусто. На компьютере включите синхронизацию: «Настройки → Аккаунт → Синхронизация».`),
      rows.length ? h("p", { class: "card-note" }, t`Открыть их можно в списке вкладок: значок с двумя экранами.`) : null);
  }

  function signOut() {
    confirmDialog({
      title: t`Выйти из аккаунта?`,
      text: t`Синхронизация на этом телефоне остановится: список его вкладок исчезнет с других устройств, а коды входа сотрутся с телефона (в аккаунте и на других устройствах они останутся). Вкладки, закладки и пароли на самом телефоне останутся.`,
      confirm: t`Выйти`,
      danger: true,
    }).then(async yes => {
      if (!yes) {
        return;
      }
      try {
        await service.signOut();
      } catch (e) {
        toast(errorText(e), { tone: "bad" });
      }
    });
  }

  function draw() {
    const s = service.state();
    clear(body,
      h("section", { class: "card phone-profile" },
        avatar(s.email, "large"),
        h("div", { class: "kv-text" }, h("span", {}, s.email), h("small", {}, t`Вы вошли на этом телефоне`))),
      syncCard(s),
      devicesCard(s),
      h("button", { class: "btn danger block large", onclick: signOut }, icon("logout", 18), t`Выйти из аккаунта`));
  }

  draw();
  return {
    destroy() {
      alive = false;
      off();
      clear(root);
    },
  };
}
