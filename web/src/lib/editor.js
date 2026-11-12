/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Редактор письма с оформлением: полужирный, курсив, подчёркивание, списки, цитата, ссылка.
 * Оформление делается тегами (не стилями): политика содержимого страницы запрещает встроенные
 * стили, а письму они и не нужны. Всё вставленное из буфера проходит очистку (core/sanitize.js):
 * в письмо не попадают чужие картинки, стили и скрипты. */

import { cleanRich, richToText } from "../core/sanitize.js";
import { h, icon } from "./dom.js";
import { field, formError, modal } from "./ui.js";

const TOOLS = [
  ["bold", "bold", "Полужирный"],
  ["italic", "italic", "Курсив"],
  ["underline", "underline", "Подчёркнутый"],
  null,
  ["insertUnorderedList", "list", "Список"],
  ["insertOrderedList", "numbered", "Нумерованный список"],
  ["quote", "quote", "Цитата"],
  ["link", "link", "Ссылка"],
  null,
  ["removeFormat", "clearFormat", "Убрать оформление"],
];

export function createEditor({ html = "", placeholder = "Текст письма", onchange = null } = {}) {
  const area = h("div", { class: "editor-area", contenteditable: "true", role: "textbox", "aria-multiline": "true", "aria-label": placeholder, "data-placeholder": placeholder, spellcheck: "true" });
  const bar = h("div", { class: "editor-bar", role: "toolbar", "aria-label": "Оформление" });
  const buttons = new Map();
  let savedRange = null;

  const exec = (cmd, value = null) => {
    area.focus();
    try {
      document.execCommand("styleWithCSS", false, false);
    } catch (e) {}
    document.execCommand(cmd, false, value);
    changed();
  };

  /** Вставить очищенную разметку на место выделения. Не через execCommand("insertHTML"): браузер
   * при такой вставке сам дописывает элементам встроенные стили, а политика страницы их запрещает. */
  const insert = html => {
    area.focus();
    const sel = window.getSelection();
    if (!sel.rangeCount || !area.contains(sel.anchorNode)) {
      const end = document.createRange();
      end.selectNodeContents(area);
      end.collapse(false);
      sel.removeAllRanges();
      sel.addRange(end);
    }
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const frag = range.createContextualFragment(html);
    const last = frag.lastChild;
    range.insertNode(frag);
    if (last) {
      range.setStartAfter(last);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    changed();
  };

  const state = () => {
    // состояние кнопок считается только по выделению внутри редактора: иначе «полужирный» загорался
    // от жирной надписи на кнопке, с которой пришёл фокус
    const sel = window.getSelection();
    const inside = !!sel && sel.rangeCount > 0 && area.contains(sel.anchorNode);
    for (const [cmd, btn] of buttons) {
      let on = false;
      try {
        on = inside && ["bold", "italic", "underline", "insertUnorderedList", "insertOrderedList"].includes(cmd) && document.queryCommandState(cmd);
      } catch (e) {}
      btn.setAttribute("aria-pressed", String(!!on));
    }
    area.classList.toggle("empty", !area.textContent.trim() && !area.querySelector("li, blockquote"));
  };

  const changed = () => {
    state();
    onchange?.();
  };

  const inQuote = () => {
    let n = window.getSelection()?.anchorNode;
    while (n && n !== area) {
      if (n.nodeName === "BLOCKQUOTE") {
        return true;
      }
      n = n.parentNode;
    }
    return false;
  };

  function link() {
    const sel = window.getSelection();
    savedRange = sel.rangeCount && area.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
    const selected = savedRange ? savedRange.toString() : "";
    const url = field("Адрес", { placeholder: "https://", inputmode: "url", autofocus: true });
    const text = field("Текст ссылки", { value: selected });
    const error = formError();
    const submit = h("button", { class: "btn primary" }, "Вставить");
    const m = modal({ title: "Ссылка", content: [h("form", { class: "modal-form", novalidate: true, onsubmit: e => { e.preventDefault(); submit.click(); } }, url.el, selected ? null : text.el, error.el)], actions: [h("button", { class: "btn", onclick: () => m.close() }, "Отмена"), submit] });
    submit.addEventListener("click", () => {
      let href = url.value.trim();
      if (href && !/^[a-z][a-z0-9+.-]*:/i.test(href)) {
        href = `https://${href}`;
      }
      if (!/^(https?:|mailto:)/i.test(href)) {
        error.set("Нужен адрес сайта или почты");
        return;
      }
      m.close();
      area.focus();
      if (savedRange) {
        const s = window.getSelection();
        s.removeAllRanges();
        s.addRange(savedRange);
      }
      if (selected) {
        exec("createLink", href);
      } else {
        const label = (text.value.trim() || href).replace(/&/g, "&amp;").replace(/</g, "&lt;");
        insert(`<a href="${href.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">${label}</a>&nbsp;`);
      }
    });
  }

  for (const t of TOOLS) {
    if (!t) {
      bar.append(h("span", { class: "editor-sep" }));
      continue;
    }
    const [cmd, ic, label] = t;
    const btn = h("button", { class: "icon-btn editor-btn", type: "button", "aria-label": label, title: label, "aria-pressed": "false" }, icon(ic, 17));
    // mousedown, а не click: выделение в тексте не должно сброситься до применения команды
    btn.addEventListener("mousedown", e => e.preventDefault());
    btn.addEventListener("click", () => {
      if (cmd === "quote") {
        exec("formatBlock", inQuote() ? "div" : "blockquote");
      } else if (cmd === "link") {
        link();
      } else {
        exec(cmd);
      }
    });
    buttons.set(cmd, btn);
    bar.append(btn);
  }

  area.addEventListener("input", changed);
  area.addEventListener("keyup", state);
  area.addEventListener("mouseup", state);
  area.addEventListener("paste", e => {
    e.preventDefault();
    const data = e.clipboardData;
    const rich = data?.getData("text/html");
    if (rich) {
      insert(cleanRich(rich));
    } else {
      exec("insertText", data?.getData("text/plain") || "");
    }
  });
  area.addEventListener("drop", e => {
    // перетаскивание разметки с чужой страницы: только текстом
    if (e.dataTransfer?.types.includes("text/html") && !e.dataTransfer.files.length) {
      e.preventDefault();
      exec("insertText", e.dataTransfer.getData("text/plain") || "");
    }
  });
  area.addEventListener("keydown", e => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey) {
      const cmd = { KeyB: "bold", KeyI: "italic", KeyU: "underline" }[e.code];
      if (cmd) {
        e.preventDefault();
        exec(cmd);
      }
    }
  });

  if (html) {
    area.append(document.createRange().createContextualFragment(cleanRich(html)));
  }
  state();

  return {
    el: h("div", { class: "editor" }, bar, area),
    area,
    focus(atStart = false) {
      area.focus();
      if (atStart) {
        const r = document.createRange();
        r.setStart(area, 0);
        r.collapse(true);
        const s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
      }
    },
    /** Содержимое для письма: { html, text }. html пуст, если оформления нет (письмо уйдёт одним текстом). */
    value() {
      const clean = cleanRich(area.innerHTML, { mail: true }).replace(/(<br>\s*)+$/, "");
      const text = richToText(clean);
      const formatted = /<(b|strong|i|em|u|s|a|ul|ol|li|blockquote|h[1-3]|pre|code)\b/.test(clean);
      return { html: formatted ? clean : "", text };
    },
    isEmpty() {
      return !area.textContent.trim();
    },
  };
}
