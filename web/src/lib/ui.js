/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Общие части интерфейса: уведомления, окна, меню, поля, копирование, даты. */

import { h, icon } from "./dom.js";
import { LANGS, chooseLanguage, language, locale, t, tr } from "../core/i18n.js";

/* ---- уведомления ---- */

let toastHost = null;

export function toast(message, { tone = "", action = null, ms = 3200 } = {}) {
  if (!toastHost) {
    toastHost = h("div", { class: "toasts", role: "status", "aria-live": "polite" });
    document.body.append(toastHost);
  }
  const el = h("div", { class: `toast${tone ? ` ${tone}` : ""}` }, h("span", {}, message));
  let timer = null;
  const close = () => {
    clearTimeout(timer);
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 180);
  };
  if (action) {
    el.append(h("button", { class: "toast-action", onclick: () => { close(); action.run(); } }, action.label));
  }
  toastHost.append(el);
  timer = setTimeout(close, ms);
  return close;
}

/** Текст ошибки для человека: сообщения сервера уже на русском и показываются как есть. */
export function errorText(e) {
  if (e?.code === "offline") {
    return t`Нет связи с сервером. Проверьте интернет и повторите`;
  }
  // сообщение сервера или рабочего потока приходит готовым текстом: переводится по словарю
  return tr(e?.message) || String(e);
}

/** Выбор языка интерфейса: выбор запоминается, страница перезагружается на новом языке. */
export function languagePicker() {
  const select = h("select", { class: "lang-select", "aria-label": t`Язык` }, ...LANGS.map(([code, name]) => h("option", { value: code }, name)));
  select.value = language();
  select.addEventListener("change", () => {
    if (chooseLanguage(select.value)) {
      location.reload();
    }
  });
  return select;
}

/* ---- окна ---- */

const stack = [];

function trapFocus(e, box) {
  if (e.key !== "Tab") {
    return;
  }
  const items = [...box.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")].filter(n => !n.disabled && n.offsetParent !== null);
  if (!items.length) {
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

/**
 * Окно поверх страницы (на телефоне выезжает снизу). Возвращает { el, body, close, closed }.
 * content — узлы тела; actions — узлы нижней строки. dismiss: false — закрыть можно только кнопкой.
 */
export function modal({ title = "", content = [], actions = [], wide = false, dismiss = true, onclose = null, className = "" } = {}) {
  const prev = document.activeElement;
  let resolveClosed;
  const closed = new Promise(r => (resolveClosed = r));
  const body = h("div", { class: "modal-body" }, content);
  const foot = actions.length ? h("div", { class: "modal-actions" }, actions) : null;
  const box = h("div", { class: `modal${wide ? " wide" : ""}${className ? ` ${className}` : ""}`, role: "dialog", "aria-modal": "true", "aria-label": title || t`Окно` },
    h("div", { class: "modal-head" }, h("h2", {}, title), dismiss && h("button", { class: "icon-btn", "aria-label": t`Закрыть`, onclick: () => close() }, icon("close", 18))),
    body, foot);
  const backdrop = h("div", { class: "modal-backdrop" }, box);
  let done = false;
  function close(value) {
    if (done) {
      return;
    }
    done = true;
    stack.splice(stack.indexOf(api), 1);
    backdrop.classList.add("leaving");
    setTimeout(() => backdrop.remove(), 160);
    document.removeEventListener("keydown", onKey, true);
    try {
      onclose?.(value);
    } catch (e) {}
    resolveClosed(value);
    if (prev && document.contains(prev)) {
      prev.focus({ preventScroll: true });
    }
  }
  function onKey(e) {
    if (stack[stack.length - 1] !== api) {
      return;
    }
    if (e.key === "Escape" && dismiss) {
      e.preventDefault();
      close();
    } else {
      trapFocus(e, box);
    }
  }
  backdrop.addEventListener("mousedown", e => {
    if (e.target === backdrop && dismiss) {
      close();
    }
  });
  document.addEventListener("keydown", onKey, true);
  document.body.append(backdrop);
  const api = { el: box, body, close, closed };
  stack.push(api);
  queueMicrotask(() => {
    const focus = box.querySelector("[autofocus]") || box.querySelector("input, textarea, select") || box.querySelector(".modal-actions .btn.primary") || box.querySelector("button");
    focus?.focus({ preventScroll: true });
  });
  return api;
}

/** Подтверждение действия. Возвращает true, если человек согласился. */
export function confirmDialog({ title, text, confirm = t`Продолжить`, cancel = t`Отмена`, danger = false }) {
  return new Promise(resolve => {
    let answer = false;
    const m = modal({
      title,
      content: [h("p", { class: "modal-text" }, text)],
      actions: [
        h("button", { class: "btn", onclick: () => m.close() }, cancel),
        h("button", { class: `btn ${danger ? "danger" : "primary"}`, onclick: () => { answer = true; m.close(); } }, confirm),
      ],
      onclose: () => resolve(answer),
    });
  });
}

/* ---- кнопки и поля ---- */

/** Кнопка занята, пока идёт fn: показывает ход и не нажимается повторно. Ошибку отдаёт вызывающему. */
export async function busy(button, fn, label = "") {
  if (button.dataset.busy) {
    return undefined;
  }
  const original = [...button.childNodes];
  button.dataset.busy = "1";
  button.disabled = true;
  const text = h("span", {}, label || button.textContent);
  button.replaceChildren(h("span", { class: "spinner", "aria-hidden": "true" }), text);
  button._setBusyText = value => (text.textContent = value);
  try {
    return await fn(value => (text.textContent = value));
  } finally {
    delete button.dataset.busy;
    delete button._setBusyText;
    button.disabled = false;
    button.replaceChildren(...original);
  }
}

/** Поле с подписью, подсказкой и местом для ошибки. opts.type: text | password | email | textarea … */
export function field(label, opts = {}) {
  const { type = "text", hint = "", value = "", placeholder = "", autocomplete = "off", name = "", inputmode = "", maxlength = null, rows = 4, mono = false, autofocus = false, required = false, spellcheck = false, oninput = null, suffix = null } = opts;
  const id = `f${Math.random().toString(36).slice(2, 9)}`;
  const input = type === "textarea"
    ? h("textarea", { id, class: `input${mono ? " mono" : ""}`, rows, placeholder, name, maxlength, spellcheck: String(spellcheck), autofocus, required, oninput })
    : h("input", { id, class: `input${mono ? " mono" : ""}`, type: type === "password" ? "password" : type, placeholder, autocomplete, name, inputmode: inputmode || null, maxlength, autocapitalize: "off", autocorrect: "off", spellcheck: String(spellcheck), autofocus, required, oninput });
  input.value = value;
  const error = h("div", { class: "field-error", role: "alert", hidden: true });
  const wrap = h("div", { class: "input-wrap" }, input);
  if (type === "password") {
    const toggle = h("button", { class: "icon-btn input-eye", type: "button", "aria-label": t`Показать пароль`, "aria-pressed": "false" }, icon("eye", 17));
    toggle.addEventListener("click", () => {
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      toggle.setAttribute("aria-pressed", String(show));
      toggle.setAttribute("aria-label", show ? t`Скрыть пароль` : t`Показать пароль`);
      toggle.replaceChildren(icon(show ? "eyeOff" : "eye", 17));
    });
    wrap.append(toggle);
    wrap.classList.add("has-suffix");
  } else if (suffix) {
    wrap.append(suffix);
    wrap.classList.add("has-suffix");
  }
  const el = h("div", { class: "field" }, label && h("label", { for: id }, label), wrap, hint && h("div", { class: "field-hint" }, hint), error);
  return {
    el, input,
    get value() { return input.value; },
    set value(v) { input.value = v; },
    setError(text) {
      error.textContent = text || "";
      error.hidden = !text;
      input.classList.toggle("invalid", !!text);
      if (text) {
        input.setAttribute("aria-invalid", "true");
      } else {
        input.removeAttribute("aria-invalid");
      }
    },
  };
}

/** Строка ошибки формы. */
export function formError() {
  const el = h("div", { class: "form-error", role: "alert", hidden: true });
  return { el, set(text) { el.textContent = text || ""; el.hidden = !text; } };
}

/** Переключатель. */
export function toggle(checked, onchange, label = "") {
  const el = h("button", { class: "toggle", type: "button", role: "switch", "aria-checked": String(!!checked), "aria-label": label || null });
  el.addEventListener("click", async () => {
    const next = el.getAttribute("aria-checked") !== "true";
    el.setAttribute("aria-checked", String(next));
    try {
      await onchange(next);
    } catch (e) {
      el.setAttribute("aria-checked", String(!next));
      toast(errorText(e), { tone: "bad" });
    }
  });
  return el;
}

/* ---- меню ---- */

let openMenu = null;

/** Выпадающее меню у кнопки: items — [{ label, icon, run, danger, disabled } | null (черта)]. */
export function menu(anchor, items) {
  openMenu?.();
  const list = h("div", { class: "menu", role: "menu" });
  for (const it of items) {
    if (!it) {
      list.append(h("div", { class: "menu-sep" }));
      continue;
    }
    list.append(h("button", { class: `menu-item${it.danger ? " danger" : ""}`, role: "menuitem", disabled: !!it.disabled, onclick: () => { close(); it.run(); } }, it.icon && icon(it.icon, 16), h("span", {}, it.label)));
  }
  document.body.append(list);
  const r = anchor.getBoundingClientRect();
  const w = list.offsetWidth;
  const hh = list.offsetHeight;
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w));
  const top = r.bottom + 6 + hh > window.innerHeight - 8 ? Math.max(8, r.top - hh - 6) : r.bottom + 6;
  list.style.left = `${left}px`;
  list.style.top = `${top}px`;
  const onDown = e => {
    if (!list.contains(e.target)) {
      close();
    }
  };
  const onKey = e => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      anchor.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const all = [...list.querySelectorAll(".menu-item:not(:disabled)")];
      const i = all.indexOf(document.activeElement);
      all[(i + (e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length]?.focus();
    }
  };
  function close() {
    list.remove();
    document.removeEventListener("mousedown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", close);
    if (openMenu === close) {
      openMenu = null;
    }
  }
  openMenu = close;
  setTimeout(() => {
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", close);
    list.querySelector(".menu-item:not(:disabled)")?.focus();
  }, 0);
  return close;
}

/* ---- копирование ---- */

export async function copyText(value, message = t`Скопировано`) {
  try {
    await navigator.clipboard.writeText(value);
  } catch (e) {
    // запасной путь для браузеров без доступа к буферу: выделить и скопировать
    const ta = h("textarea", { class: "offscreen", readOnly: true });
    ta.value = value;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (err) {}
    ta.remove();
    if (!ok) {
      toast(t`Не удалось скопировать: выделите текст и скопируйте вручную`, { tone: "bad" });
      return false;
    }
  }
  if (message) {
    toast(message);
  }
  return true;
}

/* ---- даты, размеры, прочее ---- */

const MONTHS = [t`янв`, t`фев`, t`мар`, t`апр`, t`мая`, t`июн`, t`июл`, t`авг`, t`сен`, t`окт`, t`ноя`, t`дек`];

/** Коротко для списков: «14:05», «вчера», «3 ноя», «3 ноя 2025». */
export function shortDate(value, now = new Date()) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    return "";
  }
  const day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff === 0) {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  if (diff === 1) {
    return t`вчера`;
  }
  return d.getFullYear() === now.getFullYear() ? `${d.getDate()} ${MONTHS[d.getMonth()]}` : `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** Подробно: «3 ноября 2026, 14:05». */
export function longDate(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat(locale(), { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(d);
}

export function fileSize(n) {
  if (!(n >= 0)) {
    return "";
  }
  if (n < 1024) {
    return t`${n} Б`;
  }
  // десятичный знак — по правилам языка: «1,5 МБ» и «1.5 MB»
  const num = (x, digits) => new Intl.NumberFormat(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false }).format(x);
  if (n < 1024 * 1024) {
    return t`${num(n / 1024, n < 10240 ? 1 : 0)} КБ`;
  }
  return t`${num(n / 1024 / 1024, 1)} МБ`;
}

export { plural } from "../core/i18n.js";

export function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/** Буква и тон для круглого значка адресата или сайта: один и тот же текст даёт один и тот же тон. */
export function avatar(textValue, size = "") {
  const s = String(textValue || "?").trim();
  let hash = 0;
  for (const ch of s) {
    hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  }
  const letter = (s.replace(/^(https?:\/\/)?(www\.)?/i, "").match(/[\p{L}\p{N}]/u) || ["?"])[0].toUpperCase();
  return h("span", { class: `avatar tone-${hash % 6}${size ? ` ${size}` : ""}`, "aria-hidden": "true" }, letter);
}

/** Пустое состояние раздела: что здесь будет и что сделать. */
export function emptyState({ iconName, title, text, action = null }) {
  return h("div", { class: "empty" }, h("div", { class: "empty-icon" }, icon(iconName, 26, 1.6)), h("h3", {}, title), text && h("p", {}, text), action);
}

export const isPhone = () => window.matchMedia("(max-width: 820px)").matches;
