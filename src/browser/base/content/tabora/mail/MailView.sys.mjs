import { tt } from "chrome://tabora/content/i18n/I18n.sys.mjs";
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Письмо с вёрсткой: подготовка документа для показа и кэш вёрстки.
 *
 * Чужая разметка никогда не попадает в страницу почты (у неё системные права) и не
 * отрисовывается в главном процессе. Письмо показывается в отдельном процессе содержимого:
 * страница почты создаёт элемент browser и загружает в него документ data:, собранный здесь.
 * Защита в три слоя:
 *   1. разметку чистит встроенный очиститель Firefox (nsIParserUtils.sanitize): скрипты,
 *      обработчики событий, формы, рамки, объекты и опасные адреса удаляются; затем здесь
 *      убираются оставшиеся служебные элементы, а ссылкам оставляются только http, https и mailto;
 *   2. в документе первой строкой стоит политика содержимого: default-src 'none', стили только
 *      встроенные, картинки только data: (а по явному действию пользователя ещё и https),
 *      шрифты, медиа, отправка форм и base запрещены;
 *   3. у контекста просмотра выключен JavaScript, происхождение документа пустое (data:), акторы
 *      кошелька, сейфа и баннеров в нём не работают (другая группа сообщений).
 * Картинки с чужих серверов по умолчанию не загружаются: отправитель не узнаёт, что письмо
 * открыли. Картинки, вложенные в само письмо (cid:), подставляются сразу — сети они не касаются.
 *
 * Кэш вёрстки: исходная разметка письма (до очистки, чтобы улучшения очистителя действовали и
 * на старые письма) лежит в профиле в каталоге tabora-mail-html, по файлу на письмо,
 * зашифрованная подключом сейфа "mail-html". В общий кэш писем она не входит: тот шифруется
 * целиком при каждом изменении, и вёрстка сотен писем сделала бы эту запись долгой. */

const { Vault } = ChromeUtils.importESModule("chrome://tabora/content/vault/Vault.sys.mjs");

const lazy = {};
ChromeUtils.defineLazyGetter(lazy, "parser", () => new DOMParser());
ChromeUtils.defineLazyGetter(lazy, "sanitizer", () => Cc["@mozilla.org/parserutils;1"].getService(Ci.nsIParserUtils));

const DIR = () => PathUtils.join(PathUtils.profileDir, "tabora-mail-html");
const KEY = "mail-html";
const MAX_HTML = 600_000; // больше этого письмо показывается текстом
const MAX_INLINE = 1_500_000; // вложенные в письмо картинки, суммарно в base64
const TOKEN = /^[0-9a-f]{32}$/;
const RECENT_MAX = 12; // столько писем держится в памяти расшифрованными…
const RECENT_CHARS = 6_000_000; // …и не больше стольких знаков разметки
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

// Теги, которые простое письмо может содержать, оставаясь «простым»: такое письмо показывается
// блоками самой страницы почты (в цветах темы). Всё остальное — письмо с вёрсткой.
const PLAIN_TAGS = new Set(["html", "head", "body", "meta", "title", "div", "p", "br", "span", "a", "blockquote", "wbr"]);

// Оформление по умолчанию стоит в :where(): его вес нулевой, и любое правило самого письма
// сильнее. Без :where() остаются только ограничения, которые письму менять нельзя.
const BASE_STYLE = `
:where(html) { background: #ffffff; color: #16171a; font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; overflow-wrap: anywhere; }
:where(body) { margin: 0; padding: 16px 18px; }
:where(a[href]) { color: #1a56c4; }
:where(a:not([href])) { color: inherit; text-decoration: none; cursor: default; }
:where(pre) { white-space: pre-wrap; }
:where(blockquote) { margin: 0.6em 0; padding-inline-start: 12px; border-inline-start: 3px solid #dcdce2; color: #5e626b; }
html { overflow: hidden; scrollbar-width: none; }
img { max-width: 100%; height: auto; }
img[data-tabora-blocked] { background: #f1f1f4; outline: 1px dashed #d4d4dc; outline-offset: -1px; color: #868b95; font-size: 11px; }
img[data-tabora-blocked="tiny"] { display: none; }
`;

function csp(images) {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `img-src data:${images ? " https:" : ""}`,
    "font-src 'none'",
    "media-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    ...(images ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

function utf8Base64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

const remoteUrl = value => /^\s*(https?:)?\/\//i.test(String(value || ""));

export const MailView = {
  /** Нужен ли письму показ с вёрсткой: в нём есть что-то кроме абзацев, переносов, цитат и ссылок. */
  rich(html) {
    if (!html || html.length > MAX_HTML) {
      return false;
    }
    const re = /<\s*([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
    let m;
    let seen = 0;
    while ((m = re.exec(html)) && seen++ < 20_000) {
      if (!PLAIN_TAGS.has(m[1].toLowerCase()) || /\b(?:style|bgcolor|background|color|align|width)\s*=/i.test(m[2])) {
        return true;
      }
    }
    return false;
  },

  /** Картинки, вложенные в письмо, подставляются в разметку вместо ссылок cid:. inline:
   * { "<content-id>": { type, data: base64 } }. */
  embedInline(html, inline) {
    const ids = Object.keys(inline || {});
    if (!ids.length) {
      return html;
    }
    let budget = MAX_INLINE;
    return html.replace(/(["'(=])\s*cid:([^"'\s)>]+)/gi, (whole, lead, id) => {
      const part = inline[decodeURIComponent(id).toLowerCase()] || inline[id.toLowerCase()];
      if (!part || !IMAGE_TYPES.has(part.type) || part.data.length > budget) {
        return whole;
      }
      budget -= part.data.length;
      return `${lead}data:${part.type};base64,${part.data}`;
    });
  },

  /** Документ для показа письма: { url: "data:…", remote: число картинок с чужих серверов } либо
   * null, если письмо показать нельзя (слишком большое, разметка не разобралась).
   * images: true — пользователь разрешил этому письму загрузить картинки. */
  document(html, { images = false } = {}) {
    if (!html || html.length > MAX_HTML + MAX_INLINE) {
      return null;
    }
    let doc;
    try {
      const U = Ci.nsIParserUtils;
      const clean = lazy.sanitizer.sanitize(html, U.SanitizerAllowStyle | U.SanitizerDropForms);
      doc = lazy.parser.parseFromString(clean, "text/html");
    } catch (e) {
      console.error("Tabora mail: разметка письма не очищена", e);
      return null;
    }
    // второй проход поверх очистителя: то, чему в письме делать нечего ни при каких условиях
    for (const el of doc.querySelectorAll("script, meta, base, link, title, iframe, frame, frameset, object, embed, applet, audio, video, source, track, form, input, button, select, textarea, noscript, template, svg, math, dialog, slot, portal")) {
      el.remove();
    }
    for (const el of doc.querySelectorAll("*")) {
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        if (name.startsWith("on") || name === "srcdoc" || name === "contenteditable" || name === "autofocus" || name === "ping" || name === "target" || name === "download" || name === "formaction") {
          el.removeAttribute(attr.name);
        }
      }
    }
    for (const a of doc.querySelectorAll("a[href], area[href]")) {
      const href = a.getAttribute("href").trim();
      if (!/^(https?:\/\/|mailto:)/i.test(href) || href.length > 4000) {
        a.removeAttribute("href");
      } else {
        a.setAttribute("rel", "noopener noreferrer");
      }
    }
    let remote = 0;
    for (const img of doc.querySelectorAll("img, picture source, input[type=image]")) {
      const src = img.getAttribute("src") || "";
      const set = img.getAttribute("srcset") || "";
      if (/^data:image\/(png|jpeg|gif|webp);base64,/i.test(src.trim()) && !set) {
        continue;
      }
      if (remoteUrl(src) || set) {
        remote++;
        if (images) {
          img.removeAttribute("srcset"); // одна картинка — один адрес, без выбора по размеру экрана
          continue;
        }
      }
      // чужой сервер без разрешения, cid: без вложения, любая другая схема. Место большой
      // картинки остаётся видно (рамкой), а маячки и распорки в один-два пикселя прячутся целиком.
      const side = name => parseInt(img.getAttribute(name) || "", 10);
      const tiny = [side("width"), side("height")].some(n => n >= 0 && n <= 8);
      img.removeAttribute("src");
      img.removeAttribute("srcset");
      img.setAttribute("data-tabora-blocked", tiny ? "tiny" : "");
      const [w, h] = [side("width"), side("height")];
      if (!tiny && w > 0 && h > 0 && w <= 4000 && h <= 4000) {
        // место картинки занято заранее: после «Показать картинки» письмо не сдвигается
        img.style.cssText = `display: inline-block; width: ${w}px; max-width: 100%; height: auto; aspect-ratio: ${w} / ${h}; box-sizing: border-box; padding: 8px; overflow: hidden;`;
      }
    }
    for (const el of doc.querySelectorAll("[background]")) {
      if (remoteUrl(el.getAttribute("background"))) {
        remote++;
      }
    }
    for (const el of doc.querySelectorAll("[style], style")) {
      const css = el.localName === "style" ? el.textContent : el.getAttribute("style");
      remote += (css.match(/url\(\s*['"]?\s*(https?:)?\/\//gi) || []).length;
    }
    const head = doc.head || doc.documentElement.insertBefore(doc.createElement("head"), doc.documentElement.firstChild);
    const meta = (attrs) => {
      const el = doc.createElement("meta");
      for (const [k, v] of Object.entries(attrs)) {
        el.setAttribute(k, v);
      }
      return el;
    };
    const style = doc.createElement("style");
    style.textContent = BASE_STYLE;
    head.prepend(
      meta({ charset: "utf-8" }),
      meta({ "http-equiv": "Content-Security-Policy", content: csp(images) }),
      meta({ name: "referrer", content: "no-referrer" }),
      meta({ name: "color-scheme", content: "only light" }),
      style
    );
    const text = `<!doctype html>${doc.documentElement.outerHTML}`;
    if (text.length > 2 * (MAX_HTML + MAX_INLINE)) {
      return null;
    }
    return { url: `data:text/html;charset=utf-8;base64,${utf8Base64(text)}`, remote };
  },

  /* ---- кэш вёрстки ---------------------------------------------------------------------- */

  newToken() {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("");
  },

  _file(token) {
    if (!TOKEN.test(token)) {
      throw new Error(tt`Tabora mail: неверное имя записи вёрстки`);
    }
    return PathUtils.join(DIR(), `${token}.json`);
  },

  /** Недавно сохранённая и недавно показанная разметка держится в памяти: запись в файл идёт
   * не мгновенно, а письмо могут открыть сразу после получения; повторное открытие тоже
   * обходится без чтения и расшифровки файла. */
  _recent: new Map(),

  _remember(token, html) {
    this._recent.delete(token);
    this._recent.set(token, html);
    let size = 0;
    for (const value of this._recent.values()) {
      size += value.length;
    }
    for (const key of this._recent.keys()) {
      if (this._recent.size <= RECENT_MAX && size <= RECENT_CHARS) {
        break;
      }
      size -= this._recent.get(key).length;
      this._recent.delete(key);
    }
  },

  /** Сохранить разметку письма. Ошибка записи не мешает почте: письмо покажется текстом. */
  async put(token, html) {
    if (!Vault.unlocked || !html) {
      return false;
    }
    this._remember(token, html);
    try {
      const bytes = new TextEncoder().encode(html);
      const box = await Vault.encrypt(KEY, bytes);
      await IOUtils.makeDirectory(DIR(), { permissions: 0o700 });
      const file = this._file(token);
      await IOUtils.writeJSON(file, { v: 1, enc: box }, { tmpPath: `${file}.tmp` });
      await IOUtils.setPermissions(file, 0o600).catch(() => {});
      return true;
    } catch (e) {
      console.error("Tabora mail: вёрстка письма не сохранена", e);
      return false;
    }
  },

  /** Разметка письма или null, если записи нет или она не читается этим ключом. */
  async get(token) {
    if (!Vault.unlocked) {
      return null;
    }
    const recent = this._recent.get(token);
    if (recent) {
      return recent;
    }
    try {
      const raw = await IOUtils.readJSON(this._file(token));
      if (raw?.v !== 1 || !raw.enc) {
        return null;
      }
      const html = new TextDecoder().decode(await Vault.decrypt(KEY, raw.enc));
      this._remember(token, html);
      return html;
    } catch (e) {
      return null;
    }
  },

  /** Убрать записи, на которые не ссылается ни одно письмо. Свежие (моложе десяти минут) не
   * трогаются: запись письма в кэш и запись его вёрстки идут не одним разом. */
  async sweep(keep) {
    try {
      const now = Date.now();
      for (const path of await IOUtils.getChildren(DIR())) {
        const name = PathUtils.filename(path);
        const token = name.replace(/\.json(\.tmp)?$/, "");
        if (keep.has(token)) {
          continue;
        }
        const info = await IOUtils.stat(path);
        if (now - info.lastModified > 600_000) {
          await IOUtils.remove(path, { ignoreAbsent: true });
        }
      }
    } catch (e) {
      if (e.name !== "NotFoundError") {
        console.error("Tabora mail: уборка кэша вёрстки", e);
      }
    }
  },

  async clear() {
    this._recent.clear();
    await IOUtils.remove(DIR(), { recursive: true, ignoreAbsent: true }).catch(() => {});
  },

  /** Сейф заблокирован или вышли из аккаунта: расшифрованной разметки в памяти быть не должно. */
  forget() {
    this._recent.clear();
  },
};

/* Смена ключа сейфа: вёрстка — кэш, его проще собрать заново (письма подгрузят её с сервера при
 * открытии), чем перешифровывать сотни файлов. */
Vault.registerRekey(KEY, () => MailView.clear());
