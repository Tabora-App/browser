/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Предложение установить браузер Tabora: в нём эта же почта живёт рядом с паролями, кодами входа
 * и блокировкой рекламы. Показывается в почте, закрывается одним нажатием и после этого месяц
 * не появляется. В самом браузере Tabora не показывается. */

import { h, icon, mark } from "../lib/dom.js";

const KEY = "tabora.promo.closed";
const QUIET_MS = 30 * 86400000;
const SITE = "https://tabora.app/#download";

function closedRecently() {
  try {
    return Date.now() - Number(localStorage.getItem(KEY) || 0) < QUIET_MS;
  } catch (e) {
    return false;
  }
}

function inTabora() {
  return /\bTabora\//.test(navigator.userAgent);
}

/** Есть ли уже сборка браузера для устройства, с которого смотрят почту. */
function platform() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod|Android/.test(ua)) {
    return "phone";
  }
  return /Mac OS X|Macintosh/.test(ua) ? "mac" : "other";
}

const TEXT = {
  mac: { title: "Установите браузер Tabora", text: "Почта, пароли и коды входа в одном окне, а страницы открываются без рекламы.", action: "Скачать для Mac" },
  other: { title: "Браузер Tabora", text: "Почта, пароли и коды входа в одном окне, страницы без рекламы. Сейчас есть версия для Mac.", action: "Подробнее" },
  phone: { title: "Браузер Tabora для компьютера", text: "Почта, пароли и коды входа в одном окне, страницы без рекламы.", action: "Подробнее" },
};

/**
 * Карточка с предложением или null (закрыта недавно, либо почта открыта в самом браузере Tabora).
 * @param {"card" | "banner" | "inline"} kind card — в колонке папок, banner — полоска над списком на
 *   телефоне, inline — под надписью «Выберите письмо» (без кнопки закрытия: место всё равно пустое)
 */
export function promo(kind = "card") {
  if (inTabora() || (kind !== "inline" && closedRecently())) {
    return null;
  }
  const t = TEXT[platform()];
  const el = h("aside", { class: `promo promo-${kind}`, "aria-label": "Браузер Tabora" },
    mark(kind === "banner" ? 30 : 36),
    h("div", { class: "promo-text" }, h("b", {}, t.title), h("span", {}, t.text)),
    h("a", { class: `btn small${kind === "inline" ? " primary" : ""} promo-action`, href: SITE, target: "_blank", rel: "noopener" }, t.action),
    kind === "inline" ? null : h("button", { class: "icon-btn tiny promo-close", "aria-label": "Скрыть предложение", onclick: () => {
      try {
        localStorage.setItem(KEY, String(Date.now()));
      } catch (e) {}
      document.querySelectorAll(".promo-card, .promo-banner").forEach(n => n.remove());
    } }, icon("close", 13)));
  return el;
}
