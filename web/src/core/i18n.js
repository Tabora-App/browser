/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Языки интерфейса. Исходный язык — русский: надписи пишутся в коде по-русски и помечаются тегом
 * t`…`. Для остальных языков есть словарь «русская надпись → перевод» (i18n/<язык>.json в корне
 * репозитория); сборка кладёт в приложение только те надписи, которые в нём встречаются.
 *
 *   t`Отмена`                         простая надпись
 *   t`Письмо от ${name}`              с подстановкой: в словаре «Письмо от {0}» → «Letter from {0}»
 *   plural(n, t`письмо|письма|писем`) «5 писем»: формы через |, у каждого языка их столько, сколько ему нужно
 *   tr(text)                          надпись, пришедшая не из этого кода (сообщение сервера, рабочего потока)
 *
 * Надпись без перевода показывается по-русски — пустого места не будет; полноту словарей
 * проверяет tools/i18n/extract.mjs. Язык выбирается по языку браузера, выбор человека сохраняется. */

export const LANGS = [
  ["ru", "Русский"],
  ["en", "English"],
  ["uk", "Українська"],
  ["es", "Español"],
];
const KNOWN = new Set(LANGS.map(l => l[0]));
const STORE = "tabora.lang";
// порядок форм числа в надписи для каждого языка (названия категорий — как в Intl.PluralRules)
const FORMS = { ru: ["one", "few", "many"], uk: ["one", "few", "many"], en: ["one", "other"], es: ["one", "other"] };

function detect() {
  if (typeof document === "undefined") {
    return globalThis.TABORA_LANG && KNOWN.has(globalThis.TABORA_LANG) ? globalThis.TABORA_LANG : "ru"; // проверки под Node
  }
  try {
    const saved = localStorage.getItem(STORE);
    if (KNOWN.has(saved)) {
      return saved;
    }
  } catch (e) {}
  for (const tag of navigator.languages?.length ? navigator.languages : [navigator.language || ""]) {
    const base = String(tag).toLowerCase().split("-")[0];
    if (KNOWN.has(base)) {
      return base;
    }
  }
  return "en";
}

/** Словарь языка лежит отдельным файлом: загружается только нужный. Не загрузился (нет сети) —
 *  интерфейс останется русским, но откроется. */
async function load(code) {
  try {
    switch (code) {
      case "en":
        return (await import("tabora-i18n-catalog/en")).default;
      case "uk":
        return (await import("tabora-i18n-catalog/uk")).default;
      case "es":
        return (await import("tabora-i18n-catalog/es")).default;
    }
  } catch (e) {
    console.error("Tabora: словарь языка не загружен", e);
  }
  return null;
}

const lang = detect();
const dict = lang === "ru" ? null : await load(lang);
const rules = new Intl.PluralRules(lang);
const keys = new WeakMap();

/** Код выбранного языка: ru, en, uk, es. */
export function language() {
  return lang;
}

/** Язык для дат и чисел: вариант страны берётся у браузера, если язык тот же (en-GB, es-MX). */
export function locale() {
  const own = typeof navigator !== "undefined" ? String(navigator.language || "") : "";
  return own.toLowerCase().split("-")[0] === lang ? own : lang;
}

/** Запомнить выбор языка. Вступает в силу после перезагрузки страницы — её делает вызывающий. */
export function chooseLanguage(code) {
  if (!KNOWN.has(code)) {
    return false;
  }
  try {
    localStorage.setItem(STORE, code);
  } catch (e) {}
  return code !== lang;
}

export function t(strings, ...values) {
  let key = keys.get(strings);
  if (key === undefined) {
    key = strings.length === 1 ? strings[0] : strings.reduce((all, part, i) => `${all}{${i - 1}}${part}`);
    keys.set(strings, key);
  }
  const text = dict ? dict[key] ?? key : key;
  return values.length ? text.replace(/\{(\d+)\}/g, (m, i) => (i < values.length ? String(values[i]) : m)) : text;
}

let patterns = null; // [[RegExp, перевод]] для надписей с подстановками — собирается при первой надобности

/** Перевод надписи, которая пришла готовым текстом (сообщение сервера, рабочего потока, общего с
 *  браузером кода). Сначала ищется целиком; если не нашлась — среди надписей с подстановками:
 *  «Пароль: слабый. Добавьте…» подходит под «Пароль: {0}. Добавьте…», а «слабый» переводится
 *  отдельно. Незнакомый текст возвращается как есть. */
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
        parts[slot] = dict[m[i + 1]] ?? m[i + 1];
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
