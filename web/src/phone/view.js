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
    if (!s.tabsOn && !s.codesOn && !s.loginsOn && !s.marksOn && !s.spacesOn) {
      return s.erased
        ? { tone: "warn", text: t`Выключена: данные синхронизации стёрли с сервера с другого устройства. Данные на самом телефоне на месте.` }
        : { text: t`Выключена: на этом телефоне ничего не синхронизируется.` };
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
      h("div", { class: "kv tall" },
        h("div", { class: "kv-text" },
          h("span", {}, t`Пароли сайтов`),
          h("small", { class: "wrap" }, t`Пароли из Tabora на компьютере появляются в паролях этого телефона и подставляются на сайтах, а сохранённые здесь — на компьютере.`)),
        h("div", { class: "kv-actions" }, toggle(s.loginsOn, on => service.setLogins(on), t`Пароли сайтов`))),
      s.loginsOn && s.loginsHold && h("div", { class: "kv tall sync-status warn" },
        h("div", { class: "kv-text" }, h("small", { class: "wrap" }, t`С телефона разом пропало много паролей: ${s.loginsHold.missing} из ${s.loginsHold.of}. На других устройствах они пока не удалены.`)),
        h("div", { class: "kv-actions buttons" },
          h("button", { class: "btn small", onclick: () => service.resolveLoginsHold("restore").catch(e => toast(errorText(e), { tone: "bad" })) }, t`Вернуть на телефон`),
          h("button", { class: "btn small", onclick: forgetLogins }, t`Удалить везде`))),
      s.loginsOn && !s.loginsHold && h("div", { class: "kv" },
        h("div", { class: "kv-text" }, h("small", { class: "wrap" }, s.loginsError ? t`Пароли не сверены: ${s.loginsError}` : s.loaded ? (s.logins ? plural(s.logins, t`пароль|пароля|паролей`) : t`Паролей пока нет`) : t`Идёт сверка…`))),
      h("div", { class: "kv tall" },
        h("div", { class: "kv-text" },
          h("span", {}, t`Закладки`),
          h("small", { class: "wrap" }, t`Закладки с компьютера появляются в закладках этого телефона, а сделанные здесь — на компьютере в папке «С телефона».`)),
        h("div", { class: "kv-actions" }, toggle(s.marksOn, on => service.setMarks(on), t`Закладки`))),
      s.marksOn && s.marksHold && h("div", { class: "kv tall sync-status warn" },
        h("div", { class: "kv-text" }, h("small", { class: "wrap" }, t`С телефона разом пропало много закладок: ${s.marksHold.missing} из ${s.marksHold.of}. На других устройствах они пока не удалены.`)),
        h("div", { class: "kv-actions buttons" },
          h("button", { class: "btn small", onclick: () => service.resolveMarksHold("restore").catch(e => toast(errorText(e), { tone: "bad" })) }, t`Вернуть на телефон`),
          h("button", { class: "btn small", onclick: forgetMarks }, t`Удалить везде`))),
      s.marksOn && !s.marksHold && h("div", { class: "kv" },
        h("div", { class: "kv-text" }, h("small", { class: "wrap" }, s.marksError ? t`Закладки не сверены: ${s.marksError}` : s.loaded ? (s.marks ? plural(s.marks, t`закладка|закладки|закладок`) : t`Закладок пока нет`) : t`Идёт сверка…`))),
      ...autofillRows(s, "addresses", t`Адреса`, t`Адреса, телефоны и почта, которые телефон подставляет в формы, — те же, что в Tabora на компьютере.`, t`адрес|адреса|адресов`, t`Адресов пока нет`),
      ...autofillRows(s, "cards", t`Банковские карты`, t`Номер, срок действия и имя владельца — те же, что в Tabora на компьютере. Код безопасности карты не хранится и никуда не передаётся.`, t`карта|карты|карт`, t`Карт пока нет`),
      h("div", { class: "kv tall" },
        h("div", { class: "kv-text" },
          h("span", {}, t`История`),
          h("small", { class: "wrap" }, t`Страницы, открытые на этом телефоне за последние два месяца, видны на других ваших устройствах, а их история — здесь. Приватные вкладки в историю не попадают.`)),
        h("div", { class: "kv-actions" }, toggle(s.historyOn, on => service.setHistory(on).catch(e => toast(errorText(e), { tone: "bad" })), t`История`))),
      s.historyOn && h("div", { class: "kv" },
        h("div", { class: "kv-text" }, h("small", { class: "wrap" }, s.historyError ? t`История не сверена: приложение не ответило` : t`Страницы с компьютера и других устройств`)),
        h("div", { class: "kv-actions buttons" }, h("button", { class: "btn small", onclick: () => service.open("history") }, t`Открыть историю`))),
      h("div", { class: "kv tall" },
        h("div", { class: "kv-text" },
          h("span", {}, t`Пространства`),
          h("small", { class: "wrap" }, t`Список пространств общий с компьютером: названия, цвета и порядок. Вкладки и входы на сайтах внутри пространства остаются на этом телефоне.`)),
        h("div", { class: "kv-actions" }, toggle(s.spacesOn, on => service.setSpaces(on), t`Пространства`))),
      s.spacesOn && h("div", { class: "kv" },
        h("div", { class: "kv-text" }, h("small", { class: "wrap" }, s.spacesError ? t`Пространства не сверены: ${s.spacesError}` : s.loaded ? (s.spaces ? plural(s.spaces, t`пространство|пространства|пространств`) : t`Пока только «Личное»`) : t`Идёт сверка…`))),
      h("div", { class: `kv tall sync-status${st.tone ? ` ${st.tone}` : ""}` },
        h("div", { class: "kv-text" }, h("small", { class: "wrap" }, st.text)),
        h("div", { class: "kv-actions buttons" }, st.action || ((s.tabsOn || s.codesOn || s.loginsOn || s.marksOn || s.spacesOn || s.historyOn || s.addressesOn || s.cardsOn) && now))),
      h("p", { class: "card-note" }, t`Данные шифруются на телефоне ключом вашего аккаунта. Сервер хранит их зашифрованными и прочитать не может.`));
  }

  /** Rows of a group of autofill records ("addresses" or "cards"): the switch, then either the
   * question about records that disappeared at once or the number of records. */
  function autofillRows(s, name, label, text, words, none) {
    const on = s[`${name}On`];
    const hold = s[`${name}Hold`];
    const error = s[`${name}Error`];
    const count = s[name];
    const fail = e => toast(errorText(e), { tone: "bad" });
    const forget = () => confirmDialog({
      title: t`Удалить записи везде?`,
      text: t`Записи, пропавшие с этого телефона, будут удалены из аккаунта и с остальных ваших устройств.`,
      confirm: t`Удалить везде`,
      danger: true,
    }).then(yes => yes && service.resolveAutofillHold(name, "delete").catch(fail));
    return [
      h("div", { class: "kv tall" },
        h("div", { class: "kv-text" }, h("span", {}, label), h("small", { class: "wrap" }, text)),
        h("div", { class: "kv-actions" }, toggle(on, value => service.setAutofill(name, value).catch(fail), label))),
      on && hold && h("div", { class: "kv tall sync-status warn" },
        h("div", { class: "kv-text" }, h("small", { class: "wrap" }, t`С телефона разом пропало много записей: ${hold.missing} из ${hold.of}. На других устройствах они пока не удалены.`)),
        h("div", { class: "kv-actions buttons" },
          h("button", { class: "btn small", onclick: () => service.resolveAutofillHold(name, "restore").catch(fail) }, t`Вернуть на телефон`),
          h("button", { class: "btn small", onclick: forget }, t`Удалить везде`))),
      on && !hold && h("div", { class: "kv" },
        h("div", { class: "kv-text" }, h("small", { class: "wrap" }, error ? t`Не сверено: приложение не ответило` : s.loaded ? (count ? plural(count, words) : none) : t`Идёт сверка…`))),
    ];
  }

  function forgetLogins() {
    confirmDialog({
      title: t`Удалить пароли везде?`,
      text: t`Пароли, пропавшие с этого телефона, будут удалены из аккаунта и с остальных ваших устройств.`,
      confirm: t`Удалить везде`,
      danger: true,
    }).then(yes => yes && service.resolveLoginsHold("delete").catch(e => toast(errorText(e), { tone: "bad" })));
  }

  function forgetMarks() {
    confirmDialog({
      title: t`Удалить закладки везде?`,
      text: t`Закладки, пропавшие с этого телефона, будут удалены из аккаунта и с остальных ваших устройств.`,
      confirm: t`Удалить везде`,
      danger: true,
    }).then(yes => yes && service.resolveMarksHold("delete").catch(e => toast(errorText(e), { tone: "bad" })));
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
      rows.length ? rows : h("p", { class: "card-note" }, t`Пока пусто. Вкладки появятся, когда вы откроете Tabora на другом устройстве и войдёте там в этот аккаунт.`),
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
