/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Предложение установить браузер Tabora: в нём эта же почта живёт рядом с паролями, кодами входа
 * и блокировкой рекламы. Показывается в почте, закрывается одним нажатием и после этого месяц
 * не появляется. В самом браузере Tabora не показывается. */

import { h, icon, mark } from "../lib/dom.js";
import { t } from "../core/i18n.js";

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
  // сам браузер Tabora на компьютере или почта внутри приложения Tabora на телефоне (страница модуля)
  return /\bTabora\//.test(navigator.userAgent) || location.protocol === "moz-extension:";
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
  mac: { title: t`Установите браузер Tabora`, text: t`Почта, пароли и коды входа в одном окне, а страницы открываются без рекламы.`, action: t`Скачать для Mac` },
  other: { title: t`Браузер Tabora`, text: t`Почта, пароли и коды входа в одном окне, страницы без рекламы. Сейчас есть версия для Mac.`, action: t`Подробнее` },
  phone: { title: t`Браузер Tabora для компьютера`, text: t`Почта, пароли и коды входа в одном окне, страницы без рекламы.`, action: t`Подробнее` },
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
  const copy = TEXT[platform()];
  const el = h("aside", { class: `promo promo-${kind}`, "aria-label": t`Браузер Tabora` },
    mark(kind === "banner" ? 30 : 36),
    h("div", { class: "promo-text" }, h("b", {}, copy.title), h("span", {}, copy.text)),
    h("a", { class: `btn small${kind === "inline" ? " primary" : ""} promo-action`, href: SITE, target: "_blank", rel: "noopener" }, copy.action),
    kind === "inline" ? null : h("button", { class: "icon-btn tiny promo-close", "aria-label": t`Скрыть предложение`, onclick: () => {
      try {
        localStorage.setItem(KEY, String(Date.now()));
      } catch (e) {}
      document.querySelectorAll(".promo-card, .promo-banner").forEach(n => n.remove());
    } }, icon("close", 13)));
  return el;
}
