/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Вёрстка чужого письма перед показом. Письмо — недоверенное содержимое, и защита здесь в два слоя:
 *
 *  1. Очистка (этот файл): разметка разбирается в отдельном неактивном документе (DOMParser: скрипты
 *     в нём не исполняются, ничего не загружается), из него переносится только разрешённое —
 *     без скриптов, форм, рамок, обработчиков событий и ссылок на непонятные схемы. Картинки с чужих
 *     серверов не подставляются, пока человек не попросит: загрузка картинки сообщает отправителю,
 *     что письмо открыли, когда и откуда.
 *  2. Рамка (views/mail-reader.js): очищенное письмо вкладывается в отдельный документ, которому
 *     браузер запрещает скрипты вовсе (sandbox без allow-scripts) и у которого своя политика
 *     содержимого: сеть закрыта, из картинок разрешены только вложенные в письмо. Даже если
 *     очистка что-то пропустит, исполниться или уйти в сеть этому не дадут.
 */

const DROP = new Set(["script", "iframe", "frame", "frameset", "object", "embed", "applet", "link", "meta", "base", "title", "noscript", "template", "svg", "math", "audio", "video", "source", "track", "canvas", "portal", "dialog", "slot", "input", "button", "select", "textarea", "option", "datalist", "label", "fieldset", "legend", "progress", "meter", "marquee", "bgsound", "head"]);
const UNWRAP = new Set(["form", "html", "body"]);
const DROP_ATTRS = new Set(["srcdoc", "srcset", "ping", "action", "formaction", "contenteditable", "autofocus", "tabindex", "poster", "integrity", "crossorigin", "referrerpolicy", "loading", "decoding", "usemap", "ismap", "download", "accesskey", "draggable", "nonce", "is", "slot", "part", "popover", "inert"]);
const IMAGE_DATA = /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i;
const MAX_NODES = 30000;
const MAX_CSS = 300 * 1024;

/** Стили письма: без подгрузки чужих таблиц и без адресов, по которым браузер пошёл бы в сеть. */
function cleanCss(css, remote) {
  let out = String(css || "").slice(0, MAX_CSS);
  out = out.replace(/@import[^;]*;?/gi, "").replace(/expression\s*\(/gi, "x(").replace(/-moz-binding/gi, "x").replace(/behavior\s*:/gi, "x:");
  out = out.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (m, q, u) => {
    const v = u.trim();
    if (IMAGE_DATA.test(v)) {
      return m;
    }
    return remote && /^https:\/\//i.test(v) ? `url("${v.replace(/["\\\n]/g, "")}")` : "none";
  });
  return out;
}

function safeHref(value) {
  const v = String(value || "").trim();
  if (/^(https?:|mailto:|tel:)/i.test(v) && !/[\u0000-\u001f]/.test(v)) {
    return v;
  }
  return "";
}

/**
 * @param {string} html разметка письма
 * @param {{ inline?: Record<string, string>, remote?: boolean }} opts inline — картинки из самого
 *   письма по Content-ID (адрес blob: или data:); remote — человек разрешил картинки с чужих серверов
 * @returns {{ doc: Document, css: string, blocked: number, body: { style: string, bgcolor: string, text: string } }}
 */
export function sanitizeMail(html, { inline = {}, remote = false } = {}) {
  const doc = new DOMParser().parseFromString(String(html || "").slice(0, 2_000_000), "text/html");
  let blocked = 0;
  let count = 0;
  const css = [];
  for (const style of [...doc.querySelectorAll("style")]) {
    css.push(cleanCss(style.textContent, remote));
    style.remove();
  }
  const bodyInfo = { style: cleanCss(doc.body?.getAttribute("style") || "", remote), bgcolor: doc.body?.getAttribute("bgcolor") || "", text: doc.body?.getAttribute("text") || "" };

  const image = (el, attr) => {
    const v = (el.getAttribute(attr) || "").trim();
    el.removeAttribute(attr);
    if (/^cid:/i.test(v)) {
      let cid = v.slice(4);
      try {
        cid = decodeURIComponent(cid);
      } catch (e) {}
      const url = inline[cid.toLowerCase()];
      if (url && attr === "src") {
        el.setAttribute("src", url);
      }
      return;
    }
    if (IMAGE_DATA.test(v)) {
      if (attr === "src") {
        el.setAttribute("src", v);
      }
      return;
    }
    if (/^https:\/\//i.test(v) || /^http:\/\//i.test(v)) {
      const url = v.replace(/^http:/i, "https:");
      if (remote) {
        if (attr === "src") {
          el.setAttribute("src", url);
        } else {
          el.style.backgroundImage = `url("${url.replace(/["\\\n]/g, "")}")`;
        }
      } else {
        blocked++;
        if (attr === "src") {
          el.setAttribute("data-blocked", "1");
        }
      }
    }
  };

  const walk = node => {
    for (const el of [...node.children]) {
      if (++count > MAX_NODES) {
        el.remove();
        continue;
      }
      const tag = el.localName;
      if (DROP.has(tag) || tag.includes("-") || el.namespaceURI !== "http://www.w3.org/1999/xhtml") {
        el.remove();
        continue;
      }
      if (UNWRAP.has(tag)) {
        walk(el);
        el.replaceWith(...el.childNodes);
        continue;
      }
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        if (name.startsWith("on") || DROP_ATTRS.has(name) || name.startsWith("xmlns") || name.includes(":")) {
          el.removeAttribute(attr.name);
        } else if (name === "style") {
          el.setAttribute("style", cleanCss(attr.value, remote));
        } else if (name === "href") {
          const href = tag === "a" || tag === "area" ? safeHref(attr.value) : "";
          if (href) {
            el.setAttribute("href", href);
          } else {
            el.removeAttribute("href");
          }
        } else if (name === "src") {
          if (tag === "img") {
            image(el, "src");
          } else {
            el.removeAttribute("src");
          }
        } else if (name === "background") {
          image(el, "background");
        } else if (name === "target" || name === "rel") {
          el.removeAttribute(attr.name);
        }
      }
      if (tag === "a" && el.hasAttribute("href")) {
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noopener noreferrer nofollow");
      }
      if (tag === "img" && !el.hasAttribute("src")) {
        // место под картинку остаётся, чтобы вёрстка не схлопнулась
        el.setAttribute("data-empty", "1");
      }
      walk(el);
    }
  };
  walk(doc.documentElement);
  // комментарии (в том числе условные для Outlook) письму не нужны
  const it = doc.createNodeIterator(doc.documentElement, NodeFilter.SHOW_COMMENT);
  const comments = [];
  for (let n = it.nextNode(); n; n = it.nextNode()) {
    comments.push(n);
  }
  comments.forEach(n => n.remove());
  return { doc, css: css.join("\n"), blocked, body: bodyInfo };
}

/** Простая вёрстка (текст письма, которое пишет человек): только безопасные теги оформления. */
const RICH = new Set(["b", "strong", "i", "em", "u", "s", "strike", "a", "ul", "ol", "li", "blockquote", "br", "p", "div", "pre", "code", "span", "h1", "h2", "h3"]);

/** Очистить разметку из редактора или из буфера обмена: строка HTML из разрешённых тегов.
 * mail — разметка пойдёт в письмо: цитате добавляется встроенный стиль, по которому её узнают
 * почтовые программы (в саму страницу такая разметка не вставляется: там встроенные стили запрещены). */
export function cleanRich(html, { mail = false } = {}) {
  const doc = new DOMParser().parseFromString(`<body>${String(html || "").slice(0, 500_000)}</body>`, "text/html");
  const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const out = node => {
    let s = "";
    for (const n of node.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) {
        s += esc(n.nodeValue);
      } else if (n.nodeType === Node.ELEMENT_NODE) {
        const tag = n.localName;
        if (DROP.has(tag) || tag === "style" || tag === "img") {
          continue;
        }
        const inner = out(n);
        if (!RICH.has(tag) || tag === "span") {
          s += inner + (/^(tr|table|section|article|header|footer|h[4-6]|address)$/.test(tag) ? "<br>" : "");
        } else if (tag === "br") {
          s += "<br>";
        } else if (tag === "a") {
          const href = safeHref(n.getAttribute("href"));
          s += href ? `<a href="${esc(href).replace(/"/g, "&quot;")}">${inner}</a>` : inner;
        } else if (tag === "blockquote") {
          s += mail ? `<blockquote style="margin:0 0 0 .8ex;border-left:2px solid #c8ccd0;padding-left:1.2ex;color:#5e626b">${inner}</blockquote>` : `<blockquote>${inner}</blockquote>`;
        } else {
          s += `<${tag}>${inner}</${tag}>`;
        }
      }
    }
    return s;
  };
  return out(doc.body);
}

/** Текст письма без оформления из простой вёрстки: для текстовой части письма. */
export function richToText(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const block = /^(p|div|li|blockquote|pre|h1|h2|h3|ul|ol)$/;
  const lines = [];
  let line = "";
  const flush = () => {
    lines.push(line);
    line = "";
  };
  const walk = (node, quote) => {
    for (const n of node.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) {
        line += n.nodeValue.replace(/\s+/g, " ");
      } else if (n.nodeType === Node.ELEMENT_NODE) {
        const tag = n.localName;
        if (tag === "br") {
          flush();
          line = quote;
        } else if (block.test(tag)) {
          if (line.trim() && line.trim() !== quote.trim()) {
            flush();
          }
          const q = tag === "blockquote" ? `${quote}> ` : quote;
          line = q + (tag === "li" ? "• " : "");
          walk(n, q);
          if (line.trim() && line.trim() !== q.trim()) {
            flush();
          }
          line = quote;
        } else if (tag === "a" && n.getAttribute("href") && !n.textContent.includes(n.getAttribute("href").replace(/^mailto:/, ""))) {
          walk(n, quote);
          line += ` (${n.getAttribute("href")})`;
        } else {
          walk(n, quote);
        }
      }
    }
  };
  walk(doc.body, "");
  if (line.trim()) {
    flush();
  }
  return lines.map(l => l.replace(/\s+$/, "")).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
