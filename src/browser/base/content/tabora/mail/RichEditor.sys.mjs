/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Редактор письма с оформлением: окно письма в оболочке и быстрый ответ на странице почты.
 *
 * И оболочка, и страница почты — документы с правами браузера, поэтому сам текст письма в них
 * не редактируется. Редактор — рамка (iframe type="content") с пустым документом about:blank:
 * у него пустой принципал, скрипты в нём выключены, политика содержимого запрещает любые
 * загрузки. Что бы ни оказалось в таком документе, прав браузера у него нет. Панель оформления
 * стоит снаружи и управляет рамкой командами редактора Firefox (document.execCommand).
 *
 * Разметка в рамку попадает и выходит из неё только через RichText.clean(): вставка из буфера
 * обмена и перетаскивание перехватываются, и вставляется уже построенная заново разметка из
 * разрешённого списка; на отправку и в черновик идёт она же. См. RichText.sys.mjs и раздел
 * «Редактор письма» в SECURITY.md.
 *
 *   const editor = new RichEditor(document, { placeholder, label, grow, menu, onInput, … });
 *   куда-нибудь.append(editor.el);        // рамка с текстом
 *   куда-нибудь.append(editor.bar);       // панель оформления
 *   куда-нибудь.append(editor.toggle);    // кнопка «Аа»: показать или спрятать панель
 *
 * Рамку нельзя переставлять в документе: вынутая из него, она теряет набранное. */

import { clean, fromText, parseInert, escapeHtml, FONTS, SIZES, COLORS, NO_COLOR } from "chrome://tabora/content/mail/RichText.sys.mjs";
import { tt } from "chrome://tabora/content/i18n/I18n.sys.mjs";

const XHTML = "http://www.w3.org/1999/xhtml";
const SVG = "http://www.w3.org/2000/svg";
const SHOWN_PREF = "tabora.mail.format.shown";
const FRAME_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

const ICONS = {
  undo: ["M9 14 4 9l5-5", "M4 9h10.5a5.5 5.5 0 0 1 0 11H11"],
  redo: ["m15 14 5-5-5-5", "M20 9H9.5a5.5 5.5 0 0 0 0 11H13"],
  bold: ["M7 5h6a3.5 3.5 0 0 1 0 7H7z", "M7 12h7a3.5 3.5 0 0 1 0 7H7z"],
  italic: ["M19 5h-8", "M13 19H5", "M15 5 9 19"],
  underline: ["M7 4v6a5 5 0 0 0 10 0V4", "M5 20h14"],
  strike: ["M16.5 6.5A4 4 0 0 0 13 5h-2a3.5 3.5 0 0 0-3 5.3", "M4 12h16", "M15.6 14.5A3.5 3.5 0 0 1 13 19h-2.5a4 4 0 0 1-3.4-2"],
  color: ["M8 15 12 4l4 11", "M9.4 11.5h5.2"],
  size: ["M3 7V5h11v2", "M8.5 5v14", "M6.5 19h4", "M14 13v-1.5h7V13", "M17.5 11.5V19", "M16 19h3"],
  left: ["M4 6h16", "M4 12h10", "M4 18h13"],
  center: ["M4 6h16", "M7 12h10", "M5.5 18h13"],
  right: ["M4 6h16", "M10 12h10", "M7 18h13"],
  ordered: ["M10 6h10", "M10 12h10", "M10 18h10", "M4 5h1.2v4", "M4 15h2.2l-2.2 3h2.4"],
  bullets: ["M9 6h11", "M9 12h11", "M9 18h11", "M4.5 6h.01", "M4.5 12h.01", "M4.5 18h.01"],
  outdent: ["M20 6H4", "M20 12h-9", "M20 18H4", "m7 9-3 3 3 3"],
  indent: ["M20 6H4", "M20 12h-9", "M20 18H4", "m4 9 3 3-3 3"],
  quote: ["M5 7h5v5.5L8 17H5.5l1.5-4.5H5z", "M14 7h5v5.5L17 17h-2.5l1.5-4.5h-2z"],
  clear: ["M5 7V5h12v2", "M11 5 8.5 19", "M6.5 19h4.5", "m15 14 5 5", "m20 14-5 5"],
  link: ["M10 13.5a4.5 4.5 0 0 0 6.5.4l2.4-2.4a4.5 4.5 0 0 0-6.4-6.4L11.2 6.4", "M14 10.5a4.5 4.5 0 0 0-6.5-.4l-2.4 2.4a4.5 4.5 0 0 0 6.4 6.4l1.3-1.3"],
  more: ["M5 12h.01", "M12 12h.01", "M19 12h.01"],
  caret: ["m7 10 5 5 5-5"],
};

function h(doc, tag, attrs = {}, children = []) {
  const el = doc.createElementNS(XHTML, tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (name === "style") {
      el.style.cssText = value; // атрибутом стиль на странице почты не поставить: запрещает её политика
    } else if (value !== null && value !== undefined && value !== false) {
      el.setAttribute(name, value === true ? "true" : String(value));
    }
  }
  for (const child of [].concat(children)) {
    el.append(child);
  }
  return el;
}

function svg(doc, paths, size = 16) {
  const el = doc.createElementNS(SVG, "svg");
  for (const [name, value] of Object.entries({ viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", "stroke-width": "1.9", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) {
    el.setAttribute(name, value);
  }
  for (const d of paths) {
    const path = doc.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    el.append(path);
  }
  return el;
}

const frameStyle = (c, grow) => `
html { ${grow ? "" : "height: 100%;"} overflow: ${grow ? "hidden" : "auto"}; scrollbar-width: thin; scrollbar-color: ${c.line} transparent; background: ${c.bg}; }
html[data-scroll] { overflow-y: auto; }
body { box-sizing: border-box; margin: 0; padding: ${grow ? "11px 14px 6px" : "10px 2px 12px"}; min-height: ${grow ? `${grow.min}px` : "100%"}; color: ${c.text}; caret-color: ${c.text}; font: 14px/1.55 ${FRAME_FONT}; overflow-wrap: anywhere; outline: none; cursor: text; }
body[data-empty]::before { content: attr(data-placeholder); position: absolute; color: ${c.placeholder}; pointer-events: none; }
body[data-readonly] { color: ${c.text2}; }
a { color: ${c.link}; }
ul, ol { margin: 0; padding-inline-start: 28px; }
blockquote { margin: 0 0 0 0.8ex; padding-left: 1ex; border-left: 2px solid ${c.line}; color: ${c.text2}; }
font[size="1"], font[size="2"] { font-size: 11px; }
font[size="3"] { font-size: inherit; }
font[size="4"], font[size="5"] { font-size: 18px; }
font[size="6"], font[size="7"] { font-size: 26px; }
font[color="${NO_COLOR}"] { color: ${c.text}; }
::selection { background: ${c.selection}; }
`;

export class RichEditor {
  /**
   * doc — документ, в котором стоит редактор. opts:
   *   label, placeholder — подпись для средств доступности и текст в пустом поле;
   *   grow: { min, max } — рамка растёт по тексту в этих пределах (иначе занимает отведённое место);
   *   menu(items, rect) — показать выпадающий список у прямоугольника rect (координаты документа doc);
   *   onInput(), onSubmit() (⌘⏎), onEscape(), onFocus(есть ли фокус).
   */
  constructor(doc, opts = {}) {
    this.host = doc;
    this.win = doc.defaultView;
    this.opts = opts;
    this.doc = null;
    this._pending = "";
    this._snapshot = "";
    this._readOnly = false;
    this.frame = h(doc, "iframe", { class: "tb-editor-frame", type: "content", sandbox: "allow-same-origin", title: opts.label || tt`Текст письма` });
    this.el = h(doc, "div", { class: "tb-editor" }, [this.frame]);
    this.bar = this.#buildBar();
    this.toggle = h(doc, "button", { class: "tb-editor-toggle", type: "button", title: tt`Оформление`, "aria-label": tt`Панель оформления`, "aria-pressed": "false" }, tt`Аа`);
    this.toggle.addEventListener("mousedown", e => e.preventDefault());
    this.toggle.addEventListener("click", () => {
      Services.prefs.setBoolPref(SHOWN_PREF, this.bar.hidden);
      this.setBarShown(this.bar.hidden);
    });
    this.setBarShown(Services.prefs.getBoolPref(SHOWN_PREF, true));
    this.frame.addEventListener("load", () => this.#setup());
    // оформление рамки следует за темой окна
    const theme = () => this.#theme();
    this._themeWatch = new this.win.MutationObserver(theme);
    this._themeWatch.observe(doc.documentElement, { attributes: true, attributeFilter: ["tabora-theme"] });
    this._scheme = this.win.matchMedia("(prefers-color-scheme: dark)");
    this._scheme.addEventListener("change", theme);
    this._onTheme = theme;
  }

  destroy() {
    this._themeWatch.disconnect();
    this._scheme.removeEventListener("change", this._onTheme);
    this._overflowWatch?.disconnect();
    this.doc = null;
  }

  /* ---- рамка ---- */

  /** Готовит документ рамки. Вызывается, когда рамка встала в документ и когда её документ
   * сменился (так быть не должно: тогда он возвращается к пустому и текст восстанавливается). */
  #setup() {
    const frame = this.frame;
    const doc = frame.contentDocument;
    if (!doc || !frame.isConnected || doc === this.doc) {
      return !!this.doc;
    }
    if (doc.documentURI !== "about:blank") {
      frame.contentWindow.location.replace("about:blank");
      return false;
    }
    const restore = this.doc ? this._snapshot : this._pending;
    this.doc = doc;
    this._css = "";
    try {
      frame.browsingContext.allowJavascript = false;
    } catch (e) {
      console.error("Tabora editor: скрипты в рамке не выключены", e);
    }
    // Политика рамки запрещает всё, включая встроенные стили: на странице почты их и так
    // запрещает унаследованная политика, и редактор в обоих местах ведёт себя одинаково.
    // Оформление самой рамки — таблица стилей, созданная кодом (ей политика не указ).
    const head = doc.head || doc.documentElement.appendChild(doc.createElement("head"));
    const csp = doc.createElement("meta");
    csp.setAttribute("http-equiv", "Content-Security-Policy");
    csp.setAttribute("content", "default-src 'none'");
    head.append(csp);
    this._sheet = new frame.contentWindow.CSSStyleSheet();
    doc.adoptedStyleSheets.push(this._sheet);
    const body = doc.body;
    body.contentEditable = "true";
    body.spellcheck = true;
    body.setAttribute("role", "textbox");
    body.setAttribute("aria-multiline", "true");
    body.setAttribute("aria-label", this.opts.label || tt`Текст письма`);
    body.setAttribute("data-placeholder", this.opts.placeholder || "");
    body.dir = "auto";
    this.#theme();
    for (const [command, value] of [["styleWithCSS", false], ["defaultParagraphSeparator", "div"], ["enableObjectResizing", false], ["enableInlineTableEditing", false]]) {
      try {
        doc.execCommand(command, false, value);
      } catch (e) {}
    }

    const win = frame.contentWindow;
    doc.addEventListener("input", () => this.#changed());
    doc.addEventListener("selectionchange", () => this.#barSoon());
    doc.addEventListener("keydown", e => {
      const mod = (e.metaKey || e.ctrlKey) && !e.altKey;
      // Своих сочетаний для начертания у редактора Firefox нет (⌘B без этого открыл бы боковую
      // панель закладок). Клавиша берётся по месту на клавиатуре: раскладка может быть русской.
      const command = !mod ? null : e.shiftKey ? { KeyX: "strikeThrough" }[e.code] : { KeyB: "bold", KeyI: "italic", KeyU: "underline" }[e.code];
      if (command) {
        e.preventDefault();
        e.stopPropagation();
        this.exec(command);
      } else if (e.key === "Enter" && mod) {
        e.preventDefault();
        e.stopPropagation();
        this.opts.onSubmit?.();
      } else if (e.key === "Escape") {
        e.stopPropagation();
        this.opts.onEscape?.();
      }
    });
    win.addEventListener("focus", () => this.#focused(true), true);
    win.addEventListener("blur", () => this.#focused(false), true);
    // Чужая разметка в рамку не вставляется: вместо неё вставляется построенная заново.
    doc.addEventListener("paste", e => {
      e.preventDefault();
      e.stopPropagation();
      this.insertData(e.clipboardData);
    }, true);
    doc.addEventListener("dragover", e => {
      if (!this.#ownDrag(e)) {
        e.preventDefault();
      }
    }, true);
    doc.addEventListener("drop", e => {
      if (this.#ownDrag(e)) {
        this._ownDrop = true; // перенос выделенного внутри редактора: разметка своя
        this.win.setTimeout(() => (this._ownDrop = false), 0);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const at = doc.caretPositionFromPoint?.(e.clientX, e.clientY);
      if (at) {
        doc.getSelection().collapse(at.offsetNode, at.offset);
      }
      this.insertData(e.dataTransfer);
    }, true);
    doc.addEventListener("beforeinput", e => {
      // всё, что прошло мимо перехвата выше (вставка из меню, из системных служб), не вставляется
      if (/^insertFrom(Paste|Drop|Yank)/.test(e.inputType) && !this._ownDrop) {
        e.preventDefault();
      }
    }, true);
    doc.addEventListener("click", e => {
      if (e.target.closest?.("a")) {
        e.preventDefault(); // ссылка в тексте правится, а не открывается
      }
    }, true);

    this.#load(restore);
    this._pending = "";
    this.#applyReadOnly();
    return true;
  }

  /** Цвета рамки берутся у окна: переменные оформления в документ без прав не наследуются. */
  #theme() {
    if (!this.doc || !this._sheet) {
      return;
    }
    const probe = h(this.host, "span", { style: "position:absolute;visibility:hidden;pointer-events:none" });
    this.el.append(probe);
    const cs = this.win.getComputedStyle(probe);
    const color = name => {
      probe.style.color = `var(${name})`;
      return cs.color;
    };
    const colors = { text: color("--tbe-text"), text2: color("--tbe-text-2"), placeholder: color("--tbe-placeholder"), link: color("--tbe-link"), line: color("--tbe-line"), selection: color("--tbe-selection"), bg: "transparent" };
    probe.remove();
    // фон: первый непрозрачный у предков (рамка с содержимым сама прозрачной может не быть)
    for (let el = this.el; el && el.nodeType === 1; el = el.parentNode) {
      const bg = this.win.getComputedStyle(el).backgroundColor;
      if (bg && bg !== "transparent" && !/^rgba\(.*,\s*0\)$/.test(bg)) {
        colors.bg = bg;
        break;
      }
    }
    const css = frameStyle(colors, this.opts.grow || null);
    if (css !== this._css) {
      this._css = css;
      this._sheet.replaceSync(css);
      this.#fit();
    }
  }

  #load(markup) {
    const doc = this.doc;
    // разметка построена clean() или fromText(): в ней только разрешённое
    doc.body.replaceChildren(...[...parseInert(markup).body.childNodes].map(node => doc.importNode(node, true)));
    // отступ абзаца в разметке для редактора записан атрибутом: стилем он ставится здесь, кодом
    for (const block of doc.body.querySelectorAll("[data-indent]")) {
      block.style.marginLeft = `${Number(block.getAttribute("data-indent")) * 40}px`;
      block.removeAttribute("data-indent");
    }
    try {
      const win = this.frame.contentWindow;
      win.docShell.editingSession?.getEditorForWindow(win)?.clearUndoRedo();
    } catch (e) {}
    this.#changed(true);
  }

  #changed(silent = false) {
    const doc = this.doc;
    if (!doc) {
      return;
    }
    const body = doc.body;
    const empty = !body.textContent.trim() && !body.querySelector("li, blockquote");
    body.toggleAttribute("data-empty", empty);
    this.el.toggleAttribute("data-empty", empty);
    this.#fit();
    this.#barSoon();
    if (!silent) {
      this._snapshot = body.innerHTML;
      this.opts.onInput?.();
    }
  }

  #fit() {
    const grow = this.opts.grow;
    if (!grow || !this.doc) {
      return;
    }
    const root = this.doc.documentElement;
    root.removeAttribute("data-scroll");
    const wanted = Math.ceil(this.doc.body.getBoundingClientRect().height);
    const height = Math.max(grow.min, Math.min(grow.max, wanted));
    root.toggleAttribute("data-scroll", wanted > grow.max);
    if (this.frame.style.height !== `${height}px`) {
      this.frame.style.height = `${height}px`;
    }
  }

  #focused(on) {
    this.el.toggleAttribute("data-focus", on);
    this.#barSoon();
    this.opts.onFocus?.(on);
  }

  #ownDrag(e) {
    const source = e.dataTransfer?.mozSourceNode;
    return !!source && source.ownerDocument === this.doc;
  }

  /** Вставляет то, что лежит в буфере обмена или перетащено (data — DataTransfer): разметку,
   * построенную заново из разрешённого, а если её нет — текст. */
  insertData(data) {
    const doc = this.doc;
    if (!data || !doc || this._readOnly) {
      return;
    }
    const html = data.getData("text/html");
    const text = data.getData("text/plain") || "";
    const out = html ? clean(html) : null;
    if (out?.edit) {
      doc.execCommand("insertHTML", false, out.edit);
    } else if (text.includes("\n")) {
      doc.execCommand("insertHTML", false, text.replace(/\r\n?/g, "\n").split("\n").map(escapeHtml).join("<br>"));
    } else if (text) {
      doc.execCommand("insertText", false, text);
    }
  }

  #applyReadOnly() {
    if (this.doc) {
      this.doc.body.contentEditable = this._readOnly ? "false" : "true";
      this.doc.body.toggleAttribute("data-readonly", this._readOnly);
    }
    this.bar.toggleAttribute("data-disabled", this._readOnly);
  }

  /* ---- для владельца ---- */

  /** Документ рамки готов: до этого текст хранится и ставится при готовности. */
  get ready() {
    return this.#setup();
  }

  get empty() {
    return this.doc ? this.doc.body.hasAttribute("data-empty") : !this._pending;
  }

  /** Набранное: { text, html, formatted }. html пуст, если оформления нет: письмо уйдёт текстом. */
  content() {
    this.#setup();
    const out = clean(this.doc ? this.doc.body.innerHTML : this._pending, { own: true });
    return { text: out.text, html: out.formatted ? out.html : "", formatted: out.formatted };
  }

  /** Ставит текст: html — сохранённая разметка (чистится заново), иначе простой текст. */
  set({ html = "", text = "" } = {}) {
    const markup = html ? clean(html, { own: true }).edit : text ? fromText(text) : "";
    if (this.#setup()) {
      this.#load(markup);
      this._snapshot = this.doc.body.innerHTML;
    } else {
      this._pending = markup;
    }
  }

  clear() {
    this.set();
  }

  focus({ end = false } = {}) {
    if (!this.#setup()) {
      return;
    }
    this.frame.contentWindow.focus();
    this.doc.body.focus({ preventScroll: true });
    if (end) {
      const selection = this.doc.getSelection();
      selection.selectAllChildren(this.doc.body);
      selection.collapseToEnd();
    }
  }

  get focused() {
    return this.el.hasAttribute("data-focus");
  }

  setReadOnly(on) {
    this._readOnly = !!on;
    this.#applyReadOnly();
  }

  setPlaceholder(text) {
    this.opts.placeholder = text;
    this.doc?.body.setAttribute("data-placeholder", text);
  }

  setBarShown(on) {
    this.bar.hidden = !on;
    this.toggle.setAttribute("aria-pressed", String(!!on));
    if (on) {
      this.#overflow();
    }
  }

  /* ---- команды ---- */

  exec(command, value = null) {
    const doc = this.doc;
    if (!doc || this._readOnly) {
      return;
    }
    this.focus();
    const run = (name, arg = null) => {
      try {
        doc.execCommand(name, false, arg);
      } catch (e) {
        console.error("Tabora editor:", name, e);
      }
    };
    if (command === "indent" || command === "outdent") {
      // отступ — полем абзаца: без этого редактор делает его цитатой
      run("styleWithCSS", true);
      run(command);
      run("styleWithCSS", false);
    } else if (command === "quote") {
      if (this.#inside("blockquote")) {
        run("outdent");
      } else {
        run("formatBlock", "blockquote");
      }
    } else if (command === "clear") {
      run("removeFormat");
      run("unlink");
    } else {
      run(command, value);
    }
    this.#changed();
  }

  #inside(tag) {
    for (let node = this.doc?.getSelection()?.anchorNode; node && node !== this.doc.body; node = node.parentNode) {
      if (node.localName === tag) {
        return node;
      }
    }
    return null;
  }

  #state(command) {
    try {
      return this.doc.queryCommandState(command);
    } catch (e) {
      return false;
    }
  }

  #value(command) {
    try {
      return this.doc.queryCommandValue(command) || "";
    } catch (e) {
      return "";
    }
  }

  /* ---- панель оформления ---- */

  #buildBar() {
    const doc = this.host;
    this._toggles = new Map();
    const button = (command, title, icon, extra = {}) => {
      const b = h(doc, "button", { class: "tb-editor-btn", type: "button", title, "aria-label": title, "data-command": command, ...extra }, [svg(doc, ICONS[icon])]);
      b.addEventListener("mousedown", e => e.preventDefault()); // фокус остаётся в тексте
      b.addEventListener("click", () => (command === "link" ? this.#linkForm() : this.exec(command)));
      return b;
    };
    const toggle = (command, title, icon) => {
      const b = button(command, title, icon, { "aria-pressed": "false" });
      this._toggles.set(command, b);
      return b;
    };
    const pick = (id, title, content) => {
      const b = h(doc, "button", { class: `tb-editor-btn tb-editor-pick`, type: "button", title, "aria-label": title, "aria-haspopup": "menu", "data-pick": id }, [...[].concat(content), svg(doc, ICONS.caret, 12)]);
      b.addEventListener("mousedown", e => e.preventDefault());
      b.addEventListener("click", () => this.opts.menu?.(this.#pickItems(id), b.getBoundingClientRect()));
      return b;
    };
    const sep = () => h(doc, "span", { class: "tb-editor-sep", "aria-hidden": "true" });
    this._fontLabel = h(doc, "span", { class: "tb-editor-pick-label" }, FONTS[0].label);
    this._colorMark = h(doc, "span", { class: "tb-editor-color", "aria-hidden": "true" });
    const tools = h(doc, "div", { class: "tb-editor-tools" }, [
      button("undo", tt`Отменить (⌘Z)`, "undo"),
      button("redo", tt`Повторить (⇧⌘Z)`, "redo"),
      sep(),
      pick("font", tt`Шрифт`, this._fontLabel),
      pick("size", tt`Размер`, svg(doc, ICONS.size)),
      sep(),
      toggle("bold", tt`Жирный (⌘B)`, "bold"),
      toggle("italic", tt`Курсив (⌘I)`, "italic"),
      toggle("underline", tt`Подчёркнутый (⌘U)`, "underline"),
      pick("color", tt`Цвет текста`, h(doc, "span", { class: "tb-editor-color-icon" }, [svg(doc, ICONS.color), this._colorMark])),
      sep(),
      pick("align", tt`Выравнивание`, svg(doc, ICONS.left)),
      toggle("insertOrderedList", tt`Нумерованный список`, "ordered"),
      toggle("insertUnorderedList", tt`Маркированный список`, "bullets"),
      button("outdent", tt`Уменьшить отступ`, "outdent"),
      button("indent", tt`Увеличить отступ`, "indent"),
      sep(),
      toggle("quote", tt`Цитата`, "quote"),
      toggle("strikeThrough", tt`Зачёркнутый (⇧⌘X)`, "strike"),
      button("link", tt`Ссылка`, "link"),
      sep(),
      button("clear", tt`Убрать оформление`, "clear"),
    ]);
    const more = h(doc, "button", { class: "tb-editor-btn tb-editor-more", type: "button", title: tt`Ещё`, "aria-label": tt`Ещё`, "aria-haspopup": "menu", hidden: true }, [svg(doc, ICONS.more)]);
    more.addEventListener("mousedown", e => e.preventDefault());
    more.addEventListener("click", () => this.opts.menu?.(this.#moreItems(), more.getBoundingClientRect()));
    this._tools = tools;
    this._more = more;
    this._linkForm = this.#buildLinkForm();
    const bar = h(doc, "div", { class: "tb-editor-bar", role: "toolbar", "aria-label": tt`Оформление текста` }, [tools, more, this._linkForm]);
    // что не поместилось в строку, уходит в «Ещё»
    this._overflowWatch = new this.win.ResizeObserver(() => this.#overflow());
    this._overflowWatch.observe(tools);
    return bar;
  }

  #hiddenTools() {
    const first = this._tools.firstElementChild;
    return first ? [...this._tools.children].filter(el => el.offsetTop > first.offsetTop + 4) : [];
  }

  #overflow() {
    const hidden = new Set(this.#hiddenTools());
    let last = null;
    for (const el of this._tools.children) {
      el.removeAttribute("data-trailing");
      if (!hidden.has(el)) {
        last = el;
      }
    }
    // разделитель, за которым в строке ничего не осталось, не показывается
    if (hidden.size && last?.classList.contains("tb-editor-sep")) {
      last.setAttribute("data-trailing", "true");
    }
    this._more.hidden = ![...hidden].some(el => el.localName === "button");
  }

  #pickItems(id) {
    if (id === "font") {
      const current = this.#currentFont();
      return FONTS.map(f => ({ label: f.label, checked: f.id === current.id, run: () => this.exec("fontName", f.css) }));
    }
    if (id === "size") {
      const current = this.#value("fontSize");
      return SIZES.map(s => ({ label: s.label, checked: current ? s.font === current || (s.id === "normal" && current === "3") : s.id === "normal", run: () => this.exec("fontSize", s.font) }));
    }
    if (id === "color") {
      const current = this.#currentColor();
      return [
        { label: tt`По умолчанию`, checked: !current, run: () => this.exec("foreColor", NO_COLOR) },
        { separator: true },
        ...COLORS.map(c => ({ label: c.label, swatch: c.hex, checked: current === c.hex, run: () => this.exec("foreColor", c.hex) })),
      ];
    }
    return [
      { label: tt`По левому краю`, icon: ICONS.left, checked: this.#state("justifyLeft"), run: () => this.exec("justifyLeft") },
      { label: tt`По центру`, icon: ICONS.center, checked: this.#state("justifyCenter"), run: () => this.exec("justifyCenter") },
      { label: tt`По правому краю`, icon: ICONS.right, checked: this.#state("justifyRight"), run: () => this.exec("justifyRight") },
    ];
  }

  #moreItems() {
    const titles = { font: tt`Шрифт`, size: tt`Размер`, color: tt`Цвет текста`, align: tt`Выравнивание` };
    const items = [];
    for (const el of this.#hiddenTools()) {
      if (el.localName !== "button") {
        if (items.length && !items[items.length - 1].separator) {
          items.push({ separator: true });
        }
      } else if (el.dataset.pick) {
        items.push({ label: titles[el.dataset.pick], children: this.#pickItems(el.dataset.pick) });
      } else {
        const command = el.dataset.command;
        items.push({ label: el.title.replace(/\s*\(.*\)$/, ""), checked: el.getAttribute("aria-pressed") === "true", run: () => (command === "link" ? this.#linkForm() : this.exec(command)) });
      }
    }
    return items;
  }

  #currentFont() {
    const name = this.#value("fontName").split(",")[0].trim().replace(/^['"]|['"]$/g, "").toLowerCase();
    return FONTS.find(f => f.css.split(",")[0].trim().replace(/^['"]|['"]$/g, "").toLowerCase() === name) || FONTS[0];
  }

  #currentColor() {
    const m = this.#value("foreColor").match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
    const hex = m ? `#${m.slice(1).map(n => Number(n).toString(16).padStart(2, "0")).join("")}` : "";
    return COLORS.some(c => c.hex === hex) ? hex : "";
  }

  #barSoon() {
    if (this._barFrame || this.bar.hidden) {
      return;
    }
    this._barFrame = this.win.requestAnimationFrame(() => {
      this._barFrame = 0;
      this.#syncBar();
    });
  }

  #syncBar() {
    if (!this.doc || this.bar.hidden) {
      return;
    }
    for (const [command, b] of this._toggles) {
      b.setAttribute("aria-pressed", String(command === "quote" ? !!this.#inside("blockquote") : this.#state(command)));
    }
    this._fontLabel.textContent = this.#currentFont().label;
    const color = this.#currentColor();
    this._colorMark.style.background = color || "";
  }

  /* ---- ссылка ---- */

  #buildLinkForm() {
    const doc = this.host;
    const input = h(doc, "input", { type: "text", class: "tb-editor-link-input", placeholder: "https://…", "aria-label": tt`Адрес ссылки`, autocomplete: "off", spellcheck: "false" });
    const apply = h(doc, "button", { type: "button", class: "tb-editor-link-apply" }, tt`Вставить`);
    const remove = h(doc, "button", { type: "button", class: "tb-editor-link-remove" }, tt`Убрать`);
    const form = h(doc, "div", { class: "tb-editor-link", hidden: true }, [input, apply, remove]);
    const close = () => {
      form.hidden = true;
      this.focus();
    };
    const submit = () => {
      let href = input.value.trim();
      if (!href) {
        close();
        return;
      }
      if (/^[^\s@:/]+@[^\s@]+\.[^\s@]+$/.test(href)) {
        href = `mailto:${href}`;
      } else if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) {
        href = `https://${href}`;
      }
      // адрес проверяется тем же разбором, что и вся разметка: остаются http, https и mailto
      const checked = clean(`<a href="${escapeHtml(href).replace(/"/g, "&quot;")}">x</a>`, { own: true }).html.match(/href="([^"]+)"/);
      if (!checked) {
        input.setAttribute("aria-invalid", "true");
        return;
      }
      form.hidden = true;
      this.focus();
      const selection = this.doc.getSelection();
      if (selection.isCollapsed && !this.#inside("a")) {
        const shown = escapeHtml(href.replace(/^mailto:/, ""));
        this.doc.execCommand("insertHTML", false, `<a href="${checked[1]}">${shown}</a>`);
      } else {
        this.doc.execCommand("createLink", false, checked[1].replace(/&amp;/g, "&"));
      }
      this.#changed();
    };
    input.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    });
    input.addEventListener("input", () => input.removeAttribute("aria-invalid"));
    apply.addEventListener("click", submit);
    remove.addEventListener("click", () => {
      form.hidden = true;
      this.exec("unlink");
    });
    this._linkInput = input;
    this._linkRemove = remove;
    return form;
  }

  #linkForm() {
    if (!this.doc || this._readOnly) {
      return;
    }
    const link = this.#inside("a");
    this._linkInput.value = link?.getAttribute("href") || "";
    this._linkInput.removeAttribute("aria-invalid");
    this._linkRemove.hidden = !link;
    this._linkForm.hidden = false;
    this._linkInput.focus();
    this._linkInput.select();
  }
}
