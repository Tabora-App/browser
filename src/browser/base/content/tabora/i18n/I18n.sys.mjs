/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Языки интерфейса Tabora. Исходный язык — русский: надписи пишутся в коде по-русски и помечаются
 * тегом tt`…` (в веб-версии — t`…`). Для остальных языков есть словарь «русская надпись → перевод» (i18n/<язык>.json
 * рядом с этим файлом; собирается из i18n/*.json в корне репозитория — tools/i18n/desktop.mjs).
 *
 *   t`Отмена`                         простая надпись
 *   t`Письмо от ${name}`              с подстановкой: в словаре «Письмо от {0}» → «Letter from {0}»
 *   form(n, t`письмо|письма|писем`)   форма слова для числа: у каждого языка столько форм, сколько ему нужно
 *   tr(text)                          надпись, пришедшая готовым текстом (сервер, общий с веб-версией код)
 *   translateDocument(document)       надписи, записанные прямо в разметке страницы
 *
 * Надпись без перевода показывается по-русски. Язык — язык интерфейса браузера (русский,
 * английский, украинский, испанский; любой другой — английский). Настройка tabora.lang задаёт
 * язык надписей Tabora явно (для проверки). Смена языка вступает в силу после перезапуска.
 * Тот же механизм у веб-версии: web/src/core/i18n.js. */

export const LANGS = ["ru", "en", "uk", "es"];
// порядок форм числа в надписи для каждого языка (названия категорий — как в Intl.PluralRules)
const FORMS = { ru: ["one", "few", "many"], uk: ["one", "few", "many"], en: ["one", "other"], es: ["one", "other"] };

function detect() {
  try {
    const forced = Services.prefs.getStringPref("tabora.lang", "");
    if (LANGS.includes(forced)) {
      return forced;
    }
  } catch (e) {}
  const base = String(Services.locale.appLocaleAsBCP47 || "en").toLowerCase().split("-")[0];
  return LANGS.includes(base) ? base : "en";
}

function load(code) {
  if (code === "ru") {
    return null;
  }
  try {
    return JSON.parse(Cu.readUTF8URI(Services.io.newURI(`chrome://tabora/content/i18n/${code}.json`)));
  } catch (e) {
    console.error("Tabora: словарь языка не загружен", code, e);
    return null;
  }
}

const lang = detect();
const dict = load(lang);
const rules = new Intl.PluralRules(lang);
const keys = new WeakMap();
let patterns = null;

/** Код языка надписей Tabora: ru, en, uk, es. */
export function language() {
  return lang;
}

/** Язык для дат и чисел: вариант страны берётся у браузера, если язык тот же (en-GB, es-MX). */
export function locale() {
  const app = String(Services.locale.appLocaleAsBCP47 || "");
  return app.toLowerCase().split("-")[0] === lang ? app : lang;
}

/** Одно русское слово бывает двумя разными на другом языке («Открыть» — Open и Unlock). Такое
 *  место помечается смыслом в конце надписи: t`Открыть@@сейф`. Пометка — часть ключа словаря, на экран
 *  не попадает; нет перевода с пометкой — берётся перевод слова без неё. */
const CONTEXT = /@@[\p{L}\p{N}-]+$/u;

function plain(key, dict) {
  if (!key.includes("@@")) {
    return key;
  }
  const bare = key.replace(CONTEXT, "");
  return dict?.[bare] ?? bare;
}

export function t(strings, ...values) {
  let key = keys.get(strings);
  if (key === undefined) {
    key = strings.length === 1 ? strings[0] : strings.reduce((all, part, i) => `${all}{${i - 1}}${part}`);
    keys.set(strings, key);
  }
  const text = dict ? dict[key] ?? plain(key, dict) : plain(key);
  return values.length ? text.replace(/\{(\d+)\}/g, (m, i) => (i < values.length ? String(values[i]) : m)) : text;
}

/** То же под именем tt: в коде оболочки имя t занято местными переменными (токены, вкладки). */
export const tt = t;

/** Перевод надписи, пришедшей готовым текстом: целиком или по образцу с подстановками
 *  («Пароль: слабый. Добавьте…» подходит под «Пароль: {0}. Добавьте…»). Незнакомый текст
 *  возвращается как есть. */
export function tr(text) {
  if (!dict || typeof text !== "string" || !text) {
    return text;
  }
  if (dict[text] !== undefined) {
    return dict[text];
  }
  if (!patterns) {
    patterns = [];
    for (const [key, value] of Object.entries(dict)) {
      if (/\{\d+\}/.test(key)) {
        const source = key.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{(\d+)\}/g, "(.+?)");
        const order = [...key.matchAll(/\{(\d+)\}/g)].map(m => Number(m[1]));
        patterns.push([new RegExp(`^${source}$`, "s"), value, order]);
      }
    }
  }
  for (const [re, value, order] of patterns) {
    const m = re.exec(text);
    if (m) {
      const parts = [];
      order.forEach((slot, i) => {
        const part = m[i + 1];
        parts[slot] = dict[part] ?? (part.length < text.length ? tr(part) : part);
      });
      return value.replace(/\{(\d+)\}/g, (all, i) => parts[i] ?? all);
    }
  }
  return text;
}

/** Форма слова для числа: forms — «письмо|письма|писем» (уже на языке интерфейса). */
export function form(n, forms) {
  const list = String(forms).split("|");
  const i = FORMS[lang].indexOf(rules.select(Math.abs(Number(n)) || 0));
  return list[i >= 0 && i < list.length ? i : list.length - 1];
}

/** «1 письмо», «2 письма», «5 писем». */
export function plural(n, forms) {
  return `${n} ${form(n, forms)}`;
}

const ATTRS = ["title", "placeholder", "aria-label", "alt", "label", "tooltiptext", "value"];

/** Перевести надписи, записанные в разметке страницы: текст и подписи элементов. Для русского
 *  ничего не делает. Вызывается один раз при загрузке страницы, до показа. */
export function translateDocument(doc) {
  if (!dict || !doc?.documentElement) {
    return;
  }
  doc.documentElement.setAttribute("lang", lang);
  const cyr = /[А-Яа-яЁё]/;
  const walker = doc.createTreeWalker(doc.documentElement, 5 /* элементы и текст */);
  for (let node = walker.currentNode; node; node = walker.nextNode()) {
    if (node.nodeType === 3) {
      const raw = node.nodeValue;
      if (cyr.test(raw) && !["SCRIPT", "STYLE"].includes(node.parentNode?.nodeName?.toUpperCase())) {
        const core = raw.trim().replace(/\s+/g, " ");
        const out = tr(core);
        if (out !== core) {
          node.nodeValue = raw.replace(raw.trim(), out);
        }
      }
    } else if (node.nodeType === 1) {
      for (const name of ATTRS) {
        const value = node.getAttribute(name);
        if (value && cyr.test(value)) {
          node.setAttribute(name, tr(value));
        }
      }
    }
  }
  if (cyr.test(doc.title)) {
    doc.title = tr(doc.title);
  }
}
