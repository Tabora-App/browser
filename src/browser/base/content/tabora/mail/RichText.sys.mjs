/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Оформленный текст письма: что редактор принимает и что отдаёт.
 *
 * Редактор (RichEditor.sys.mjs) держит набранное в документе без прав, но его разметка никуда
 * не уходит как есть. Всё, что попадает в редактор извне (буфер обмена, перетаскивание,
 * сохранённый черновик), и всё, что из него выходит (письмо на отправку, черновик), проходит
 * через clean(). Разметка разбирается в неактивном документе (DOMParser из привилегированного
 * кода создаёт документ с пустым принципалом: скрипты не выполняются, ничего не загружается),
 * дерево обходится, и по нему заново строится разметка из короткого списка разрешённого:
 *
 *   начертание      b, i, u, s
 *   шрифт           span style="font-family | font-size | color" — только свои значения из
 *                   списков FONTS, SIZES и цвет вида #rrggbb
 *   абзацы          div (выравнивание, отступ), br, списки ul/ol/li, цитата blockquote
 *   ссылки          a href — только http, https и mailto
 *
 * Ничего другого в результате быть не может: картинок, стилей, классов, обработчиков, чужих
 * атрибутов. Текст экранируется. Для чужой разметки (буфер обмена, перетаскивание) остаётся
 * только начертание, списки, цитаты и ссылки: шрифт, размер, цвет и выравнивание чужой страницы
 * в письмо не переносятся.
 *
 * Разметка строится в двух видах. html — для письма: оформление записано стилями в самих
 * элементах, так его показывает любая почтовая программа. edit — для редактора: то же самое
 * записано атрибутами (font color/face/size, align, data-indent), потому что документ редактора
 * встроенных стилей не принимает (на странице почты их запрещает унаследованная политика
 * содержимого, в окне письма — собственная политика рамки).
 *
 * Вместе с разметкой clean() строит текстовый вид письма (для программ без оформления и для
 * писем, в которых оформления нет) и говорит, есть ли в письме оформление вообще. */

const lazy = {};

ChromeUtils.defineLazyGetter(lazy, "parser", () => {
  if (typeof DOMParser === "undefined") {
    Cu.importGlobalProperties(["DOMParser"]);
  }
  return new DOMParser();
});

// css — как шрифт записывается в письме; первое имя служит и для узнавания при разборе
export const FONTS = [
  { id: "sans", label: "Без засечек", css: "Arial, Helvetica, sans-serif" },
  { id: "serif", label: "С засечками", css: "'Times New Roman', Times, serif" },
  { id: "mono", label: "Моноширинный", css: "'Courier New', Courier, monospace" },
  { id: "wide", label: "Широкий", css: "'Arial Black', Arial, sans-serif" },
  { id: "narrow", label: "Узкий", css: "'Arial Narrow', Arial, sans-serif" },
  { id: "georgia", label: "Georgia", css: "Georgia, serif" },
  { id: "garamond", label: "Garamond", css: "Garamond, 'Times New Roman', serif" },
  { id: "tahoma", label: "Tahoma", css: "Tahoma, Geneva, sans-serif" },
  { id: "trebuchet", label: "Trebuchet MS", css: "'Trebuchet MS', Helvetica, sans-serif" },
  { id: "verdana", label: "Verdana", css: "Verdana, Geneva, sans-serif" },
  { id: "comic", label: "Comic Sans MS", css: "'Comic Sans MS', cursive" },
];

// font — значение для команды редактора fontSize (1–7), px — размер в письме
export const SIZES = [
  { id: "small", label: "Мелкий", font: "1", px: 11 },
  { id: "normal", label: "Обычный", font: "3", px: 0 },
  { id: "large", label: "Крупный", font: "5", px: 18 },
  { id: "huge", label: "Огромный", font: "6", px: 26 },
];

export const COLORS = [
  { label: "Чёрный", hex: "#16171a" },
  { label: "Серый", hex: "#6e737d" },
  { label: "Красный", hex: "#d93025" },
  { label: "Оранжевый", hex: "#e8710a" },
  { label: "Жёлтый", hex: "#f2b600" },
  { label: "Зелёный", hex: "#188038" },
  { label: "Бирюзовый", hex: "#129eaf" },
  { label: "Синий", hex: "#1a56c4" },
  { label: "Фиолетовый", hex: "#8430ce" },
  { label: "Розовый", hex: "#d01884" },
];

/** «Цвет по умолчанию»: у редактора нет команды «снять цвет», поэтому он красит текст этим
 * цветом, сам показывает его обычным цветом текста, а clean() выбрасывает. */
export const NO_COLOR = "#000001";

const MAX_INPUT = 1_000_000;
const MAX_NODES = 20_000;
const INDENT_PX = 40;
const MAX_INDENT = 8;

const DROP = new Set([
  "script", "style", "head", "title", "meta", "link", "base", "object", "embed", "iframe", "frame", "frameset", "applet", "svg", "math",
  "template", "noscript", "img", "picture", "source", "video", "audio", "canvas", "map", "area", "input", "button", "select", "option",
  "optgroup", "datalist", "textarea",
]);
const BLOCK = new Set([
  "div", "p", "section", "article", "header", "footer", "main", "aside", "nav", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "address",
  "figure", "figcaption", "table", "thead", "tbody", "tfoot", "tr", "dl", "dt", "dd", "center", "details", "summary", "ul", "ol", "li",
  "blockquote", "hr",
]);
const QUOTE_STYLE = "margin:0 0 0 0.8ex;border-left:1px solid #cccccc;padding-left:1ex";

export function escapeHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/ /g, "&nbsp;");
}

const escapeAttr = text => escapeHtml(text).replace(/"/g, "&quot;");

function hexColor(value) {
  const v = String(value || "").trim().toLowerCase();
  let m = v.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/);
  if (m) {
    return `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`;
  }
  if (/^#[0-9a-f]{6}$/.test(v)) {
    return v;
  }
  m = v.match(/^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/);
  if (m && m.slice(1).every(n => Number(n) <= 255)) {
    return `#${m.slice(1).map(n => Number(n).toString(16).padStart(2, "0")).join("")}`;
  }
  return "";
}

const firstFamily = css => String(css || "").split(",")[0].trim().replace(/^['"]|['"]$/g, "").toLowerCase();
const FONT_BY_NAME = new Map(FONTS.map(f => [firstFamily(f.css), f]));
const GENERIC_FONTS = { "sans-serif": "sans", serif: "serif", monospace: "mono" };

function fontOf(value) {
  const name = firstFamily(value);
  return FONT_BY_NAME.get(name) || FONTS.find(f => f.id === GENERIC_FONTS[name]) || null;
}

function sizeOf(value) {
  const v = String(value || "").trim().toLowerCase();
  if (!v) {
    return null;
  }
  const byId = id => SIZES.find(s => s.id === id);
  if (/^[1-7]$/.test(v)) {
    return byId(v <= 2 ? "small" : v === "3" ? "normal" : v <= 5 ? "large" : "huge");
  }
  const word = { "xx-small": "small", "x-small": "small", small: "small", medium: "normal", large: "large", "x-large": "large", "xx-large": "huge", "xxx-large": "huge" }[v];
  if (word) {
    return byId(word);
  }
  const m = v.match(/^([\d.]+)(px|pt)$/);
  if (!m) {
    return null;
  }
  const px = Number(m[1]) * (m[2] === "pt" ? 4 / 3 : 1);
  return byId(px <= 12 ? "small" : px < 17 ? "normal" : px < 23 ? "large" : "huge");
}

function safeHref(value) {
  const raw = String(value || "").trim();
  if (!/^(https?:\/\/|mailto:)/i.test(raw) || raw.length > 2000) {
    return "";
  }
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:" ? url.href : "";
  } catch (e) {
    return "";
  }
}

/** Текстовый вид письма: строки с приставками цитат, списков и отступов. */
class TextOut {
  lines = [];
  cur = "";
  prefixes = [];

  write(text) {
    const t = this.cur ? text : text.replace(/^ +/, "");
    this.cur += t;
  }

  prefix() {
    let out = "";
    for (const p of this.prefixes) {
      out += p.used ? p.rest : p.first;
      p.used = true;
    }
    return out;
  }

  /** Перевод строки: начатая строка закрывается; пустая — только если forced. */
  line(forced = false) {
    if (this.cur || forced) {
      this.lines.push((this.prefix() + this.cur.replace(/ /g, " ")).replace(/[ \t]+$/, ""));
      this.cur = "";
    }
  }

  push(first, rest = first) {
    this.line();
    this.prefixes.push({ first, rest, used: false });
  }

  pop() {
    this.line();
    this.prefixes.pop();
  }

  toString() {
    this.line();
    return this.lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+|\s+$/g, "");
  }
}

/**
 * Разбирает разметку и строит её заново из разрешённого.
 * own: разметка своя (из редактора, из своего черновика) — сохраняются шрифт, размер, цвет,
 * выравнивание и отступы; иначе (буфер обмена, перетаскивание) они отбрасываются.
 * Возвращает { html, edit, text, formatted }: html — содержимое письма без обёртки, edit — оно же
 * для редактора (обе строки пусты, если текста нет), text — текстовый вид, formatted — есть ли
 * оформление, которого текст не передаёт.
 */
export function clean(source, { own = false } = {}) {
  const doc = lazy.parser.parseFromString(String(source || "").slice(0, MAX_INPUT), "text/html");
  const html = [];
  const edit = [];
  // put(общее) или put(для письма, для редактора)
  const put = (mail, editor = mail) => {
    html.push(mail);
    edit.push(editor);
  };
  // Редактор ставит неразрывный пробел на стыках начертаний, чтобы обычный пробел там не пропал.
  // В письме одиночный такой пробел между словами становится обычным (иначе строка у получателя
  // в этом месте не переносится); в редакторе он остаётся как есть.
  const putText = value => put(escapeHtml(value.replace(/(^|[^ \u00a0])\u00a0(?=[^ \u00a0]|$)/g, "$1 ")), escapeHtml(value));
  const text = new TextOut();
  let formatted = false;
  let budget = MAX_NODES;

  // Начертание, действующее внутри элемента: то, что действует снаружи, плюс своё. Свой цвет
  // «по умолчанию» и свой обычный размер отменяют цвет и размер, заданные снаружи.
  const marksOf = (el, active) => {
    const tag = el.localName;
    const style = el.style;
    const marks = { ...active };
    const weight = style.fontWeight;
    if (tag === "b" || tag === "strong" || weight === "bold" || weight === "bolder" || Number(weight) >= 600) {
      marks.b = true;
    }
    if (tag === "i" || tag === "em" || style.fontStyle === "italic" || style.fontStyle === "oblique") {
      marks.i = true;
    }
    const line = `${style.textDecorationLine || ""} ${style.textDecoration || ""}`;
    if ((tag === "u" || tag === "ins" || /\bunderline\b/.test(line)) && tag !== "a") {
      marks.u = true;
    }
    if (tag === "s" || tag === "strike" || tag === "del" || /\bline-through\b/.test(line)) {
      marks.s = true;
    }
    if (own) {
      const color = hexColor(tag === "font" && el.hasAttribute("color") ? el.getAttribute("color") : style.color);
      if (color === NO_COLOR) {
        delete marks.color;
      } else if (color) {
        marks.color = color;
      }
      const font = fontOf(tag === "font" && el.hasAttribute("face") ? el.getAttribute("face") : style.fontFamily);
      if (font) {
        marks.font = font.id;
      }
      const size = sizeOf(tag === "font" && el.hasAttribute("size") ? el.getAttribute("size") : style.fontSize);
      if (size?.id === "normal") {
        delete marks.size;
      } else if (size) {
        marks.size = size.id;
      }
    }
    if (tag === "a" && !marks.href) {
      const href = safeHref(el.getAttribute("href"));
      if (href) {
        marks.href = href;
      }
    }
    return marks;
  };

  // Теги пишутся не по элементам исходной разметки, а по кускам текста: у каждого куска свой
  // полный набор начертаний, соседние куски с одинаковым набором сливаются. Вложенность исходной
  // разметки (цвет внутри цвета, отмена цвета внутри цветного) на результат не влияет.
  // Возвращает [открыть в письме, закрыть в письме, открыть в редакторе, закрыть в редакторе].
  const tagsFor = marks => {
    let open = "";
    let close = "";
    for (const tag of ["b", "i", "u", "s"]) {
      if (marks[tag]) {
        open += `<${tag}>`;
        close = `</${tag}>${close}`;
      }
    }
    const css = [];
    const attrs = [];
    if (marks.color) {
      css.push(`color:${marks.color}`);
      attrs.push(`color="${marks.color}"`);
    }
    if (marks.font) {
      const family = FONTS.find(f => f.id === marks.font).css;
      css.push(`font-family:${family}`);
      attrs.push(`face="${escapeAttr(family)}"`);
    }
    if (marks.size) {
      const size = SIZES.find(x => x.id === marks.size);
      css.push(`font-size:${size.px}px`);
      attrs.push(`size="${size.font}"`);
    }
    let mail = [css.length ? `${open}<span style="${escapeAttr(css.join(";"))}">` : open, css.length ? `</span>${close}` : close];
    let editor = [attrs.length ? `${open}<font ${attrs.join(" ")}>` : open, attrs.length ? `</font>${close}` : close];
    if (marks.href) {
      const href = escapeAttr(marks.href);
      mail = [`<a href="${href}" target="_blank" rel="noopener noreferrer">${mail[0]}`, `${mail[1]}</a>`];
      editor = [`<a href="${href}">${editor[0]}`, `${editor[1]}</a>`];
    }
    if (mail[0]) {
      formatted = true;
    }
    return [...mail, ...editor];
  };

  let opened = null; // начертание, теги которого сейчас открыты
  const closeMarks = () => {
    if (opened) {
      put(opened.close, opened.closeEdit);
      opened = null;
    }
  };
  const useMarks = marks => {
    const key = JSON.stringify(marks, Object.keys(marks).sort());
    if (opened?.key === key) {
      return;
    }
    closeMarks();
    const [open, close, openEdit, closeEdit] = tagsFor(marks);
    put(open, openEdit);
    opened = { key, close, closeEdit };
  };

  // выравнивание и отступ абзаца: css — стиль для письма, attrs — атрибуты для редактора
  const blockStyle = el => {
    if (!own) {
      return { css: "", attrs: "", level: 0 };
    }
    const css = [];
    const attrs = [];
    const align = (el.getAttribute("align") || el.style.textAlign || "").toLowerCase();
    if (align === "center" || align === "right") {
      css.push(`text-align:${align}`);
      attrs.push(` align="${align}"`);
    }
    const margin = parseFloat(el.style.marginLeft || el.style.marginInlineStart || "0");
    const level = Math.max(0, Math.min(MAX_INDENT, el.hasAttribute("data-indent") ? Number(el.getAttribute("data-indent")) || 0 : Math.round(margin / INDENT_PX)));
    if (level) {
      css.push(`margin-left:${level * INDENT_PX}px`);
      attrs.push(` data-indent="${level}"`);
    }
    return { css: css.join(";"), attrs: attrs.join(""), level };
  };

  const isBlock = node => node.nodeType === 1 && BLOCK.has(node.localName);
  const hasContentAfter = node => {
    // есть ли в том же абзаце что-нибудь после узла: перевод строки в конце абзаца строки не добавляет
    for (let n = node; n && !isBlock(n) && n.localName !== "body"; n = n.parentNode) {
      for (let s = n.nextSibling; s; s = s.nextSibling) {
        if (isBlock(s)) {
          return false;
        }
        if ((s.nodeType === 3 && s.nodeValue.trim()) || (s.nodeType === 1 && !DROP.has(s.localName))) {
          return true;
        }
      }
    }
    return false;
  };

  const walk = (parent, ctx, inline = false) => {
    // строчное содержимое рядом с абзацами (первая строка редактора лежит прямо в body)
    // собирается в свой абзац
    const mixed = parent.localName === "body" || [...parent.childNodes].some(isBlock);
    let run = false;
    const openRun = () => {
      if (mixed && !run) {
        run = true;
        put("<div>");
      }
    };
    const closeRun = () => {
      if (run) {
        closeMarks();
        run = false;
        put("</div>");
        text.line();
      }
    };
    for (const node of parent.childNodes) {
      if (--budget < 0) {
        break;
      }
      if (node.nodeType === 3) {
        const value = ctx.pre ? node.nodeValue : node.nodeValue.replace(/[ \t\r\n]+/g, " ");
        if (!value || (mixed && !run && !value.trim())) {
          continue;
        }
        openRun();
        if (ctx.pre) {
          value.split("\n").forEach((part, i) => {
            if (i) {
              closeMarks();
              put("<br>");
              text.line(true);
            }
            if (part) {
              useMarks(ctx.marks);
              putText(part);
              text.write(part);
            }
          });
        } else {
          useMarks(ctx.marks);
          putText(value);
          text.write(value);
        }
        continue;
      }
      if (node.nodeType !== 1) {
        continue;
      }
      const tag = node.localName;
      if (DROP.has(tag)) {
        continue;
      }
      if (tag === "br") {
        if (hasContentAfter(node)) {
          openRun();
          closeMarks();
          put("<br>");
          text.line(true);
        }
        continue;
      }
      if (!BLOCK.has(tag)) {
        openRun();
        const marks = marksOf(node, ctx.marks);
        const before = text.cur.length;
        walk(node, { ...ctx, marks }, true);
        if (marks.href && !ctx.marks.href) {
          // в текстовом виде адрес ссылки стоит в скобках после её текста
          const shown = text.cur.slice(before).trim();
          const bare = marks.href.replace(/^mailto:/, "");
          if (shown && shown !== marks.href && shown !== bare && shown !== marks.href.replace(/\/$/, "")) {
            text.write(` (${bare})`);
          }
        }
        if (tag === "td" || tag === "th") {
          useMarks(ctx.marks);
          put(" ");
          text.write(" ");
        }
        continue;
      }

      closeMarks(); // начертание не переходит из абзаца в абзац
      closeRun();
      if (tag === "hr") {
        text.line();
        continue;
      }
      const lines = text.lines.length;
      const had = html.length;
      if (tag === "ul" || tag === "ol") {
        formatted = true;
        put(`<${tag}>`);
        text.line();
        walk(node, { ...ctx, list: { ordered: tag === "ol", n: 0, depth: (ctx.list?.depth || 0) + 1 } });
        put(`</${tag}>`);
      } else if (tag === "li" && ctx.list) {
        const mark = ctx.list.ordered ? `${++ctx.list.n}. ` : "• ";
        const pad = "  ".repeat(ctx.list.depth - 1);
        put("<li>");
        text.push(pad + mark, pad + " ".repeat(mark.length));
        walk(node, { ...ctx, list: null, inItem: ctx.list });
        if (text.lines.length === lines && !text.cur) {
          text.line(true);
        }
        text.pop();
        put("</li>");
      } else if (tag === "blockquote") {
        formatted = true;
        put(`<blockquote style="${QUOTE_STYLE}">`, "<blockquote>");
        text.push("> ");
        walk(node, { ...ctx, list: ctx.inItem || null });
        text.pop();
        put("</blockquote>");
      } else {
        const { css, attrs, level } = blockStyle(node);
        const nested = [...node.childNodes].some(isBlock);
        if (css) {
          formatted = true;
        }
        // абзац, в котором лежат только другие абзацы, сам тега не получает (вставки со страниц)
        const wrap = css || !nested;
        const open = [css ? `<div style="${escapeAttr(css)}">` : "<div>", `<div${attrs}>`];
        if (wrap) {
          put(...open);
        }
        if (level) {
          text.push(" ".repeat(level * 4));
        } else {
          text.line();
        }
        const pre = ctx.pre || tag === "pre";
        const heading = /^h[1-6]$/.test(tag);
        walk(node, { ...ctx, pre, marks: heading ? { ...ctx.marks, b: true } : ctx.marks, list: ctx.inItem || ctx.list });
        const empty = text.lines.length === lines && !text.cur;
        if (empty && !nested) {
          // пустой абзац — пустая строка
          html.length = had;
          edit.length = had;
          put(`${open[0]}<br></div>`, `${open[1]}<br></div>`);
          text.line(true);
        } else if (wrap) {
          put("</div>");
        }
        if (level) {
          text.pop();
        } else {
          text.line();
        }
        if (tag === "p" && !empty) {
          text.line(true); // абзацы со страниц разделяются пустой строкой
        }
      }
    }
    if (!inline) {
      closeMarks();
    }
    closeRun();
  };

  if (doc.body) {
    walk(doc.body, { marks: {}, list: null, inItem: null, pre: false });
  }
  const plain = text.toString();
  return { html: plain ? html.join("") : "", edit: plain ? edit.join("") : "", text: plain, formatted: formatted && !!plain };
}

/** Разбор разметки в неактивном документе (пустой принципал, ничего не выполняется и не грузится). */
export function parseInert(markup) {
  return lazy.parser.parseFromString(String(markup || ""), "text/html");
}

/** Простой текст как разметка для редактора: строка — абзац. */
export function fromText(text) {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  return lines.map(line => `<div>${line ? escapeHtml(line.replace(/ {2}/g, "  ").replace(/^ /, " ")) : "<br>"}</div>`).join("");
}

/** Разметка письма целиком: содержимое в обёртке с направлением текста. */
export function wrap(html) {
  return `<div dir="auto">${html}</div>`;
}
