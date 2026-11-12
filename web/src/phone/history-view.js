/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* The "History of other devices" screen in the phone app: pages opened on the computer and on
 * other devices of the account, by day, with a search. A tap opens the page in a new tab of the
 * app (an ordinary tab: the visit lands in the phone's own history like any other). The
 * pages are only shown here: they are not in the phone's own history and cannot be deleted from
 * the phone; a device removes a page from everywhere when it is deleted from that device's history. */

import { locale, t } from "../core/i18n.js";
import { clear, h, icon } from "../lib/dom.js";
import { emptyState } from "../lib/ui.js";

const LIMIT = 300;
const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

function dayLabel(at, now = new Date()) {
  const d = new Date(at);
  const diff = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (diff === 0) {
    return t`Сегодня`;
  }
  if (diff === 1) {
    return t`Вчера`;
  }
  return new Intl.DateTimeFormat(locale(), { day: "numeric", month: "long", ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) }).format(d);
}

const clock = at => new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit" }).format(new Date(at));

function host(url) {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch (e) {
    return url;
  }
}

/**
 * @param {HTMLElement} root
 * @param {{ service: import("./service.js").Service }} ctx
 */
export function mountHistory(root, { service }) {
  let query = "";
  let shown = ""; // what is drawn: the list is redrawn only when it changes
  const body = h("div", { class: "history-body" });
  const search = h("input", { type: "search", placeholder: t`Поиск по названию или адресу`, "aria-label": t`Поиск`, autocomplete: "off", spellcheck: "false" });
  search.addEventListener("input", () => {
    query = search.value.trim();
    draw();
  });
  const tools = h("div", { class: "pane-tools", hidden: true }, h("label", { class: "search" }, icon("search", 17), search));
  clear(root, h("div", { class: "phone-page history-page" }, tools, body));

  function gate(s) {
    if (!s.signedIn) {
      return emptyState({ iconName: "user", title: t`Войдите в аккаунт Tabora`, text: t`После входа здесь появятся страницы, которые вы открывали на других устройствах.`, action: h("button", { class: "btn primary", onclick: () => service.open("account") }, t`Открыть аккаунт`) });
    }
    if (!s.historyOn) {
      return emptyState({ iconName: "devices", title: t`История на этом телефоне выключена`, text: t`Включить её можно в аккаунте Tabora.`, action: h("button", { class: "btn primary", onclick: () => service.open("account") }, t`Открыть аккаунт`) });
    }
    if (s.keys === "locked" || s.status === "locked") {
      return emptyState({ iconName: "lock", title: t`Ключ аккаунта не открыт`, text: t`Его копия на сервере привязана к прежнему паролю. Откройте ключ в аккаунте Tabora.`, action: h("button", { class: "btn primary", onclick: () => service.open("account") }, t`Открыть аккаунт`) });
    }
    if (!s.loaded) {
      return h("div", { class: "loading" }, h("span", { class: "spinner" }));
    }
    return null;
  }

  function row(p) {
    const where = host(p.url);
    return h("button", { class: "history-row", type: "button", onclick: () => service.openUrl(p.url) },
      h("span", { class: "history-text" },
        h("span", { class: "history-title" }, p.title || where),
        h("span", { class: "history-where" }, p.device ? `${where}, ${p.device}` : where)),
      h("span", { class: "history-time" }, clock(p.at)));
  }

  function draw() {
    const s = service.state();
    const blocked = gate(s);
    const any = !blocked && service.history.others({ limit: 1 }).length > 0;
    const list = blocked ? [] : service.history.others({ query, limit: LIMIT });
    const mark = JSON.stringify([s.signedIn, s.historyOn, s.keys, s.status === "locked", s.loaded, query, list]);
    if (mark === shown) {
      return;
    }
    shown = mark;
    tools.hidden = !any;
    if (blocked) {
      clear(body, blocked);
      return;
    }
    if (!list.length) {
      clear(body, query
        ? emptyState({ iconName: "search", title: t`Ничего не найдено`, text: t`Попробуйте другое слово из названия или адреса страницы.` })
        : emptyState({ iconName: "devices", title: t`Пока пусто`, text: t`Здесь появятся страницы, открытые в Tabora на компьютере и на других ваших устройствах, где включена история.` }));
      return;
    }
    const nodes = [];
    let last = "";
    const now = new Date();
    for (const p of list) {
      const label = dayLabel(p.at, now);
      if (label !== last) {
        nodes.push(h("h2", { class: "history-day" }, label));
        last = label;
      }
      nodes.push(row(p));
    }
    clear(body, ...nodes);
  }

  const off = service.subscribe(() => draw());
  draw();

  return {
    destroy() {
      off();
      clear(root);
    },
  };
}
