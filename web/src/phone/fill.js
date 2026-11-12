/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Автоввод кода входа на странице сайта (приложение для телефона). Скрипт работает на каждой
 * странице https: замечает поле для кода второго шага, спрашивает у модуля аккаунта, есть ли код,
 * привязанный к этому сайту, и показывает под полем кнопку «Вставить код». Сам код приходит только
 * после нажатия на кнопку и подтверждения владельца телефона.
 *
 * Правила — те же, что в браузере на компьютере (actors/TaboraVaultChild.sys.mjs; распознавание
 * поля и способы вставки перенесены оттуда):
 *  - только https и только документ того же сайта, что и вкладка (поле в рамке чужого сайта
 *    подсказку не получает);
 *  - сайт определяет модуль по адресу документа, а не по словам страницы;
 *  - вставка — только по настоящему нажатию человека, форма не отправляется.
 * Кнопка живёт в закрытом теневом дереве: страница не видит её содержимого и не может нажать её
 * скриптом. Секрет кода в страницу не попадает никогда. */

const OTP_NAME = /(^|[^a-z])(otp|totp|2fa|mfa|one.?time|verif|auth(enticat(or|ion))?.?code|security.?code|passcode|token|код)([^a-z]|$)/i;
const NOT_OTP = /zip|postal|phone|tel\b|cvv|cvc|card|ccn|expir|captcha|search|price|amount|qty|quantity|year|month|day|age/i;
const TEST_ORIGIN = typeof __FILL_TEST_ORIGIN__ === "string" ? __FILL_TEST_ORIGIN__ : "";
const runtime = globalThis.browser?.runtime;

let target = null; // поле (или первая ячейка группы), для которого показана кнопка
let group = null;
let chip = null; // { host, close }
let filling = false;
let hideTimer = 0;

/* ---- где можно ---- */

/** Коды только для https и только в документе того же сайта, что и вкладка. */
function allowed() {
  try {
    if (location.protocol !== "https:" && location.origin !== TEST_ORIGIN) {
      return false;
    }
    return window === window.top || window.top.location.host === location.host;
  } catch (e) {
    return false; // рамка чужого сайта: к адресу вкладки доступа нет
  }
}

/* ---- поле кода (как в TaboraVaultChild) ---- */

function labelText(el) {
  const doc = el.ownerDocument;
  const parts = [el.name, el.id, el.getAttribute("autocomplete"), el.getAttribute("aria-label"), el.placeholder, el.getAttribute("data-testid")];
  if (el.id) {
    try {
      parts.push(doc.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent);
    } catch (e) {}
  }
  parts.push(el.closest("label")?.textContent);
  if (el.getAttribute("aria-labelledby")) {
    for (const id of el.getAttribute("aria-labelledby").split(/\s+/)) {
      parts.push(doc.getElementById(id)?.textContent);
    }
  }
  return parts.filter(Boolean).join(" ").slice(0, 400);
}

function isTextInput(el) {
  return el instanceof HTMLInputElement && ["", "text", "tel", "number", "password"].includes(el.type) && !el.disabled && !el.readOnly;
}

/** Группа однознаковых полей (4–8), в которую входит el. Ячейка — поле с maxlength=1 либо узкое
 * (примерно квадрат) поле того же размера, что el. Поля шире (части номера карты) не ячейки. */
function digitGroup(el) {
  if (!isTextInput(el) || !el.offsetWidth || !el.offsetHeight) {
    return null;
  }
  let narrowOnly = false; // в группе есть ячейки, принятые только по размеру
  const cell = i => {
    if (!isTextInput(i) || !i.offsetWidth || !i.offsetHeight) {
      return false;
    }
    if (i.maxLength === 1) {
      return true;
    }
    const same = Math.abs(i.offsetWidth - el.offsetWidth) <= 4 && Math.abs(i.offsetHeight - el.offsetHeight) <= 4;
    if (same && i.offsetWidth <= 80 && i.offsetWidth <= i.offsetHeight * 1.35) {
      narrowOnly = true;
      return true;
    }
    return false;
  };
  let node = el.parentElement;
  for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
    const all = node.querySelectorAll("input");
    if (all.length > 16) {
      break;
    }
    narrowOnly = false;
    const cells = [...all].filter(cell);
    if (cells.length >= 4 && cells.length <= 8 && cells.includes(el)) {
      if (narrowOnly) {
        const text = labelText(el);
        if (NOT_OTP.test(text) && !/otp|one.?time|2fa|mfa/i.test(text)) {
          return null;
        }
      }
      return cells;
    }
  }
  return null;
}

function otpKind(el) {
  if (!isTextInput(el)) {
    return null;
  }
  // группа проверяется первой: autocomplete="one-time-code" часто стоит и на каждой ячейке,
  // и тогда весь код ушёл бы в одно поле
  if (digitGroup(el)) {
    return "group";
  }
  const auto = (el.getAttribute("autocomplete") || "").toLowerCase();
  if (auto.includes("one-time-code")) {
    return "explicit";
  }
  const text = labelText(el);
  if (NOT_OTP.test(text) && !/otp|one.?time|2fa|mfa/i.test(text)) {
    return null;
  }
  if (OTP_NAME.test(text)) {
    return "named";
  }
  const numeric = ["numeric", "tel"].includes((el.getAttribute("inputmode") || "").toLowerCase()) || el.type === "tel" || el.type === "number" || /^\[?0-9/.test(el.getAttribute("pattern") || "");
  if (numeric && el.maxLength >= 6 && el.maxLength <= 8) {
    return "numeric";
  }
  return null;
}

function deepActive() {
  let el = document.activeElement;
  while (el?.shadowRoot?.activeElement) {
    el = el.shadowRoot.activeElement;
  }
  return el;
}

/* ---- вставка (как в TaboraVaultChild) ---- */

function setValue(el, value) {
  el.value = value; // из скрипта расширения это запись мимо обёрток страницы: поля с состоянием замечают перемену
  el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: value ? "insertText" : "deleteContentBackward", data: value || null }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/** В первых n ячейках по одной своей цифре. */
function groupHolds(cells, code) {
  const n = Math.min(code.length, cells.length);
  for (let i = 0; i < n; i++) {
    if (!cells[i].isConnected || cells[i].value.replace(/\D/g, "") !== code[i]) {
      return false;
    }
  }
  return true;
}

/** По цифре в каждую ячейку: обычные поля и поля с состоянием (React, Vue). */
function fillCells(cells, code) {
  const n = Math.min(code.length, cells.length);
  for (let i = 0; i < n; i++) {
    cells[i].focus();
    setValue(cells[i], code[i]);
  }
}

/** Как вставка из буфера в первую ячейку: виджеты с обработчиком paste раскладывают цифры сами. */
function pasteCells(cells, code) {
  cells[0].focus();
  try {
    cells[0].dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, dataType: "text/plain", data: code }));
  } catch (e) {}
}

/** Как набор с клавиатуры: цифра уходит в ячейку, куда виджет сам перевёл фокус. */
function typeCells(cells, code) {
  const n = Math.min(code.length, cells.length);
  cells[0].focus();
  for (let i = 0; i < n; i++) {
    let cur = deepActive();
    if (!cells.includes(cur)) {
      cur = cells[i];
      cur.focus();
    }
    const key = { key: code[i], code: `Digit${code[i]}`, keyCode: 48 + Number(code[i]), which: 48 + Number(code[i]), bubbles: true, cancelable: true };
    if (cur.dispatchEvent(new KeyboardEvent("keydown", key))) {
      setValue(cur, code[i]);
    }
    cur.dispatchEvent(new KeyboardEvent("keyup", key));
    if (deepActive() === cur) {
      cells[cells.indexOf(cur) + 1]?.focus();
    }
  }
}

function clearCells(cells) {
  for (const input of cells) {
    if (input.isConnected && input.value) {
      setValue(input, "");
    }
  }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 60));

/** Вставка кода: в одно поле или по символу в группу. Форму не отправляем. */
async function fillOtp(code) {
  const field = target;
  if (!field || !field.isConnected) {
    return false;
  }
  code = String(code || "").replace(/\D/g, "");
  const cells = group || (field.maxLength === 1 ? digitGroup(field) : null);
  if (!cells) {
    field.focus();
    setValue(field, code);
    try {
      field.setSelectionRange(code.length, code.length);
    } catch (e) {}
    return true;
  }
  filling = true;
  try {
    for (const way of [fillCells, pasteCells, typeCells, fillCells]) {
      clearCells(cells);
      way(cells, code);
      await settle();
      if (!cells[0].isConnected) {
        return true; // форма ушла дальше (сайт принял код и сменил страницу)
      }
      // ячейки заблокированы: сайт уже проверяет код, повторная вставка отправила бы его дважды
      if (groupHolds(cells, code) || cells.some(i => i.disabled || i.readOnly)) {
        break;
      }
    }
  } finally {
    filling = false;
  }
  return true;
}

/* ---- кнопка под полем ---- */

function fieldRect() {
  const first = group ? group[0] : target;
  const last = group ? group[group.length - 1] : target;
  const a = first.getBoundingClientRect();
  const b = last.getBoundingClientRect();
  return { left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) };
}

function hideChip() {
  clearTimeout(hideTimer);
  chip?.close();
  chip = null;
}

function reset() {
  hideChip();
  target = null;
  group = null;
}

function showChip(entries, text) {
  hideChip();
  const host = document.createElement("div");
  host.style.cssText = "all: initial; position: fixed; z-index: 2147483647; left: 0; top: 0;";
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    .box { display: flex; flex-direction: column; gap: 6px; max-width: min(340px, calc(100vw - 16px)); font: 600 14px/1.25 system-ui, -apple-system, Roboto, sans-serif; }
    button { all: unset; box-sizing: border-box; display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 8px 14px 8px 10px; border-radius: 14px; background: #16171a; color: #ecedef; box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(255, 255, 255, 0.08); cursor: pointer; -webkit-tap-highlight-color: transparent; }
    button:active { background: #23262c; }
    .mark { flex: none; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 9px; background: #c8f25a; color: #0b0c0e; font-weight: 800; font-size: 15px; }
    .text { display: flex; flex-direction: column; min-width: 0; }
    .text b { font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .text span { font-weight: 500; font-size: 12px; opacity: 0.72; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .note { padding: 8px 12px; border-radius: 12px; background: #16171a; color: #ff9c8a; font-weight: 600; font-size: 13px; box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35); }
    @media (prefers-color-scheme: light) {
      button, .note { background: #ffffff; color: #16171a; box-shadow: 0 8px 28px rgba(0, 0, 0, 0.18), 0 0 0 1px rgba(0, 0, 0, 0.08); }
      button:active { background: #ebe8e1; }
      .note { color: #a3311f; }
    }`;
  const box = document.createElement("div");
  box.className = "box";
  for (const entry of entries.slice(0, 3)) {
    const button = document.createElement("button");
    button.type = "button";
    const mark = document.createElement("span");
    mark.className = "mark";
    mark.textContent = "T";
    const label = document.createElement("span");
    label.className = "text";
    const title = document.createElement("b");
    title.textContent = text.fill;
    const sub = document.createElement("span");
    sub.textContent = entry.label;
    label.append(title, sub);
    button.append(mark, label);
    // нажатие не должно уводить фокус из поля: иначе кнопка исчезнет раньше, чем сработает
    button.addEventListener("pointerdown", e => e.preventDefault());
    button.addEventListener("mousedown", e => e.preventDefault());
    button.addEventListener("click", e => {
      if (e.isTrusted) {
        pick(entry.id, box, text);
      }
    });
    box.append(button);
  }
  shadow.append(style, box);
  document.documentElement.append(host);
  const place = () => {
    if (!target?.isConnected) {
      reset();
      return;
    }
    const r = fieldRect();
    const view = window.visualViewport;
    const width = view?.width || window.innerWidth;
    const height = view?.height || window.innerHeight;
    const boxHeight = box.offsetHeight || 52;
    const below = r.bottom + 6;
    const top = below + boxHeight <= height ? below : Math.max(4, r.top - boxHeight - 6);
    const left = Math.max(8, Math.min(r.left, width - (box.offsetWidth || 240) - 8));
    host.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  };
  place();
  window.addEventListener("scroll", place, { capture: true, passive: true });
  window.addEventListener("resize", place, { passive: true });
  window.visualViewport?.addEventListener("resize", place);
  chip = {
    host,
    close() {
      window.removeEventListener("scroll", place, { capture: true });
      window.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("resize", place);
      host.remove();
    },
  };
}

async function pick(id, box, text) {
  let answer = null;
  try {
    answer = await runtime.sendMessage({ type: "otp-fill", id });
  } catch (e) {}
  if (answer?.code) {
    const done = await fillOtp(answer.code);
    reset();
    return done;
  }
  // не подтверждено или кода больше нет: коротко сказать и убрать
  const note = document.createElement("div");
  note.className = "note";
  note.textContent = answer?.error || text.failed;
  box.replaceChildren(note);
  hideTimer = setTimeout(reset, 2600);
  return false;
}

/* ---- события страницы ---- */

async function onFocusIn(event) {
  const el = event.composedPath?.()[0] || event.target;
  if (!event.isTrusted || filling || !el || el === target || (group && group.includes(el))) {
    return;
  }
  const kind = otpKind(el);
  if (!kind) {
    return;
  }
  const cells = kind === "group" ? digitGroup(el) : null;
  // заполненное поле подсказку не получает: человек уже ввёл код сам
  if (cells ? cells.every(c => c.value) : el.value) {
    return;
  }
  target = cells ? cells[0] : el;
  group = cells;
  const asked = target;
  let answer = null;
  try {
    answer = await runtime.sendMessage({ type: "otp-field" });
  } catch (e) {}
  if (asked !== target || !answer?.entries?.length) {
    if (asked === target) {
      reset();
    }
    return;
  }
  showChip(answer.entries, answer.text || { fill: "Tabora", failed: "" });
}

function onFocusOut() {
  if (!target) {
    return;
  }
  clearTimeout(hideTimer);
  // фокус мог перейти в соседнюю ячейку той же группы — тогда кнопка остаётся
  hideTimer = setTimeout(() => {
    const active = deepActive();
    const still = group ? group.includes(active) : active === target;
    if (!still && !filling) {
      reset();
    }
  }, 200);
}

if (runtime && allowed()) {
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("focusout", onFocusOut, true);
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      reset();
    }
  }, true);
  window.addEventListener("pagehide", reset);
}
