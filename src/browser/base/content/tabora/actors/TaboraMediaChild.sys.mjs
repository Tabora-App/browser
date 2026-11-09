/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Актор страницы Tabora: собирает медиа для ящика и даёт агенту читать текст,
 * заполнять поля и нажимать кнопки на странице.
 *
 * Работает только на обычных сайтах (контентный принципал, http/https): регистрация
 * ограничена matches, а здесь проверка повторяется на каждое сообщение.
 * Миниатюры медиа рисуются здесь, в процессе страницы, и уходят в оболочку готовой
 * картинкой data:image/png|jpeg: окно браузера не загружает адреса со страницы.
 * Заполнение и нажатие идут в два сообщения. Первое ничего не меняет: актор находит
 * элементы и описывает их (тип, подпись, куда ведёт, видны ли), оболочка решает, нужен ли
 * вопрос пользователю, и показывает ему адрес и значения. Второе, с token из первого
 * ответа, выполняет действие над теми же элементами. Origin и сайт назначения оболочка
 * считает сама из адреса; здесь они не вычисляются.
 * Модели отдаётся только видимый человеку текст: скрытые ветки (display, visibility,
 * прозрачность, обрезка, нулевой размер, цвет под фон, за краем страницы) и meta description
 * пропускаются; невидимые поля считаются скрытыми. Нажатие без подтверждения пользователя —
 * недоверенное событие; ссылки mailto: и внешних приложений не нажимаются.
 * Поля выбора файла не заполняются никогда: значение, заданное из системного кода,
 * прикрепило бы к форме любой файл с диска. */

const MIN_SIDE = 72;
const LIMIT = 80;
const TEXT_LIMIT = 24000;
const THUMB = 240; // сторона квадратной миниатюры, px
const THUMB_PNG_MAX = 48 * 1024; // тяжелее — пережимаем в JPEG
const POSTER_WAIT_MS = 2000;
const HTML_NS = "http://www.w3.org/1999/xhtml";

const isWeb = spec => /^https?:\/\//i.test(String(spec || ""));

// ветки, текст которых модели не нужен: служебное, навигация, содержимое полей форм
const SKIP_TEXT = new Set(["script", "style", "noscript", "template", "svg", "nav", "footer", "header", "aside", "head", "title", "iframe", "object", "embed", "canvas", "video", "audio", "select", "datalist", "textarea"]);

/** "rgb(1, 2, 3)" / "rgba(1, 2, 3, 0.5)" → [r, g, b, a]; другое представление цвета — null (не сравниваем). */
const rgba = value => {
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/.exec(String(value || ""));
  if (!m) {
    return null;
  }
  const alpha = m[4] === undefined ? 1 : Number(m[4]) / (m[5] ? 100 : 1);
  return [Number(m[1]), Number(m[2]), Number(m[3]), alpha];
};

/** Цвета почти совпадают: текст таким цветом на таком фоне человек не прочтёт. */
const near = (a, b) => Math.abs(a[0] - b[0]) <= 20 && Math.abs(a[1] - b[1]) <= 20 && Math.abs(a[2] - b[2]) <= 20;

export class TaboraMediaChild extends JSWindowActorChild {
  /** Только обычные сайты: контентный принципал и http(s). */
  allowed(doc) {
    try {
      return !!doc?.nodePrincipal?.isContentPrincipal && /^https?:$/.test(doc.location?.protocol || "");
    } catch (e) {
      return false;
    }
  }

  receiveMessage(message) {
    const doc = this.document;
    if (!doc || !doc.location) {
      return null;
    }
    if (!this.allowed(doc)) {
      return message.name === "TaboraMedia:Collect" ? [] : { error: "агент работает только с обычными сайтами (http и https)" };
    }
    const data = message.data || {};
    switch (message.name) {
      case "TaboraMedia:Collect":
        return this.collectMedia(doc);
      case "TaboraPage:Read":
        return this.readPage(doc, data);
      case "TaboraPage:Fill":
        return this.fillFields(doc, data);
      case "TaboraPage:Click":
        return this.click(doc, data);
      case "TaboraPage:Forms":
        return this.describeForms(doc);
    }
    return null;
  }

  token() {
    return Services.uuid.generateUUID().toString().slice(1, -1);
  }

  /* ---- Медиа для ящика ------------------------------------------------------ */

  async collectMedia(doc) {
    const seen = new Set();
    const out = [];
    const base = { page: doc.location.href, title: doc.title };
    for (const img of doc.images) {
      if (out.length >= LIMIT) {
        break;
      }
      const src = img.currentSrc || img.src;
      if (!isWeb(src) || seen.has(src)) {
        continue;
      }
      // картинка ещё не загружена (ленивая, за пределами экрана) — показать нечего
      if (!img.complete || !img.naturalWidth || !img.naturalHeight) {
        continue;
      }
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (w < MIN_SIDE || h < MIN_SIDE) {
        continue;
      }
      const thumb = this.thumbOf(doc, img, w, h);
      if (!thumb) {
        continue;
      }
      seen.add(src);
      out.push({ ...base, kind: "image", src, w, h, alt: img.alt || "", thumb });
    }
    const videos = [];
    for (const video of doc.querySelectorAll("video")) {
      if (out.length + videos.length >= LIMIT) {
        break;
      }
      const src = video.currentSrc || video.src || video.querySelector("source")?.src || "";
      if (!isWeb(src) || seen.has(src)) {
        continue;
      }
      seen.add(src);
      videos.push({ video, src });
    }
    const items = await Promise.all(
      videos.map(async ({ video, src }) => {
        let thumb = "";
        // текущий кадр, если он уже есть; иначе постер, загруженный от имени страницы
        if (video.readyState >= 2 && video.videoWidth && video.videoHeight) {
          thumb = this.thumbOf(doc, video, video.videoWidth, video.videoHeight);
        }
        if (!thumb && isWeb(video.poster)) {
          const poster = await this.loadImage(doc, video.poster);
          if (poster) {
            thumb = this.thumbOf(doc, poster, poster.naturalWidth, poster.naturalHeight);
          }
        }
        return { ...base, kind: "video", src, w: video.videoWidth || 0, h: video.videoHeight || 0, alt: video.title || "", thumb };
      })
    );
    return out.concat(items);
  }

  /** Картинка в процессе страницы: src задаётся из системного кода, но загрузка идёт с принципалом документа
   * (системный принципал не перекрывает CSP страницы, см. nsContentUtils::GetAttrTriggeringPrincipal). */
  loadImage(doc, src) {
    const win = doc.defaultView;
    return new Promise(resolve => {
      let timer = null;
      let img = null;
      const done = ok => {
        win.clearTimeout(timer);
        resolve(ok && img.naturalWidth && img.naturalHeight ? img : null);
      };
      try {
        img = doc.createElementNS(HTML_NS, "img"); // в документ не вставляется
        timer = win.setTimeout(() => done(false), POSTER_WAIT_MS);
        img.addEventListener("load", () => done(true), { once: true });
        img.addEventListener("error", () => done(false), { once: true });
        img.src = src;
      } catch (e) {
        resolve(null);
      }
    });
  }

  /** Квадратная миниатюра по центру (как object-fit: cover), не больше THUMB px. */
  thumbOf(doc, source, sw, sh) {
    if (!(sw > 0 && sh > 0)) {
      return "";
    }
    try {
      const crop = Math.min(sw, sh);
      const side = Math.max(1, Math.min(THUMB, Math.round(crop)));
      const canvas = doc.createElementNS(HTML_NS, "canvas"); // в документ не вставляется
      canvas.width = side;
      canvas.height = side;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(source, (sw - crop) / 2, (sh - crop) / 2, crop, crop, 0, 0, side, side);
      let url = canvas.toDataURL("image/png");
      if (url.length > THUMB_PNG_MAX) {
        // фото: JPEG в разы легче; прозрачные места заливаем нейтральным серым
        ctx.globalCompositeOperation = "destination-over";
        ctx.fillStyle = "#808080";
        ctx.fillRect(0, 0, side, side);
        url = canvas.toDataURL("image/jpeg", 0.82);
      }
      return /^data:image\/(?:png|jpeg);base64,/.test(url) ? url : "";
    } catch (e) {
      return "";
    }
  }

  /* ---- Видимость ------------------------------------------------------------- */

  /** Обрезка до точки: clip: rect(0 0 0 0), clip-path: inset(50%) и подобное. */
  clipped(cs) {
    const clip = cs.clip || "";
    if (clip && clip !== "auto") {
      const n = (clip.match(/-?[\d.]+/g) || []).map(Number); // rect(top, right, bottom, left)
      if (n.length === 4 && (n[1] - n[3] <= 1 || n[2] - n[0] <= 1)) {
        return true;
      }
    }
    const path = cs.clipPath || "";
    return /^inset\(\s*(?:[5-9]\d|100)(?:\.\d+)?%/.test(path) || /^circle\(\s*0(?:px|%)?[\s)]/.test(path);
  }

  /**
   * Почему человек не видит элемент ("" — видит): размер меньше 3×3, за пределами страницы,
   * display/visibility, прозрачность (своя или предка), обрезка clip/clip-path, предок с
   * overflow: hidden, в который элемент не попадает.
   */
  hiddenWhy(el) {
    const doc = el.ownerDocument;
    const win = doc.defaultView;
    if (!el.isConnected || !win) {
      return "detached";
    }
    const r = el.getBoundingClientRect();
    if (r.width < 3 || r.height < 3) {
      return "size";
    }
    const root = doc.documentElement;
    const left = r.left + win.scrollX;
    const top = r.top + win.scrollY;
    if (left + r.width <= 0 || top + r.height <= 0 || left >= Math.max(root.scrollWidth, root.clientWidth) || top >= Math.max(root.scrollHeight, root.clientHeight)) {
      return "offscreen";
    }
    for (let n = el, i = 0; n && n.nodeType === 1 && i < 40; n = n.parentElement, i++) {
      const cs = win.getComputedStyle(n);
      if (!cs) {
        break;
      }
      if (cs.display === "none") {
        return "display";
      }
      if (n === el && cs.visibility !== "visible") {
        return "visibility";
      }
      if (parseFloat(cs.opacity) < 0.1) {
        return "opacity";
      }
      if (this.clipped(cs)) {
        return "clip";
      }
      if (n !== el && n !== root && n !== doc.body && (/hidden|clip/.test(cs.overflowX) || /hidden|clip/.test(cs.overflowY))) {
        const p = n.getBoundingClientRect();
        if (p.width < 3 || p.height < 3 || r.right <= p.left || r.left >= p.right || r.bottom <= p.top || r.top >= p.bottom) {
          return "clip";
        }
      }
    }
    return "";
  }

  isVisible(el) {
    return !this.hiddenWhy(el);
  }

  /** Поле видно само или (флажок, переключатель) видна его подпись: сайты часто прячут сам input и рисуют свой. */
  fieldVisible(el) {
    if (this.isVisible(el)) {
      return true;
    }
    if (el.localName === "input" && (el.type === "checkbox" || el.type === "radio")) {
      const lab = el.labels?.[0] || el.closest("label");
      return !!lab && this.isVisible(lab);
    }
    return false;
  }

  /** Фон по умолчанию, пока его не задал ни один предок: белый, если страница не объявила тёмную схему. */
  canvasColor(doc) {
    const win = doc.defaultView;
    try {
      const scheme = win.getComputedStyle(doc.documentElement).colorScheme || "";
      if (/dark/.test(scheme) && win.matchMedia("(prefers-color-scheme: dark)").matches) {
        return null;
      }
    } catch (e) {}
    return [255, 255, 255, 1];
  }

  /** Фон, на котором нарисован элемент: ближайший непрозрачный цвет фона у него или предков; null — неизвестно (картинка, градиент). */
  backgroundOf(el) {
    const win = el.ownerDocument.defaultView;
    for (let n = el, i = 0; n && n.nodeType === 1 && i < 40; n = n.parentElement, i++) {
      const cs = win.getComputedStyle(n);
      if (!cs) {
        break;
      }
      if (cs.backgroundImage && cs.backgroundImage !== "none") {
        return null;
      }
      const c = rgba(cs.backgroundColor);
      if (c && c[3] > 0.5) {
        return c;
      }
      if (c && c[3] > 0.05) {
        return null;
      }
    }
    return this.canvasColor(el.ownerDocument);
  }

  /** Текст элемента не виден: мелкий шрифт, увод text-indent, прозрачный цвет или цвет, совпадающий с фоном. */
  textHidden(cs, bg) {
    if (cs.visibility !== "visible" || parseFloat(cs.fontSize) < 4 || parseFloat(cs.textIndent) < -400) {
      return true;
    }
    const fg = rgba(cs.color);
    return !!fg && (fg[3] < 0.1 || (!!bg && near(fg, bg)));
  }

  /** Заголовок или ссылка, которые человек действительно видит. */
  shownText(el) {
    if (this.hiddenWhy(el)) {
      return false;
    }
    const cs = el.ownerDocument.defaultView.getComputedStyle(el);
    return !!cs && !this.textHidden(cs, this.backgroundOf(el));
  }

  /* ---- Чтение страницы ------------------------------------------------------ */

  /**
   * Видимый текст поддерева. Обход сверху вниз: скрытая ветка пропускается целиком
   * (display: none, прозрачность, обрезка, нулевой размер с overflow, далеко за краем),
   * а visibility, цвет и размер шрифта проверяются у каждого элемента с текстом.
   * Обход ограничен по числу элементов и по времени.
   */
  visibleText(doc, root, max) {
    const win = doc.defaultView;
    const parts = [];
    let size = 0;
    let count = 0;
    let cut = false;
    const started = win.performance.now();
    const pageWidth = Math.max(doc.documentElement.scrollWidth, doc.documentElement.clientWidth);
    const boxHidden = (el, cs) => {
      if (parseFloat(cs.opacity) < 0.1 || cs.contentVisibility === "hidden" || this.clipped(cs)) {
        return true;
      }
      if (cs.display === "contents") {
        return false;
      }
      const r = el.getBoundingClientRect();
      const clips = cs.overflowX !== "visible" || cs.overflowY !== "visible";
      if (clips && (r.width < 2 || r.height < 2)) {
        return true;
      }
      if (!r.width && !r.height) {
        return false; // пустая обёртка без размеров: решают потомки
      }
      const left = r.left + win.scrollX;
      return left + r.width < -40 || r.top + win.scrollY + r.height < -40 || left > pageWidth + 40;
    };
    const visit = (el, bg, shown) => {
      for (let n = el.firstChild; n; n = n.nextSibling) {
        if (cut || size >= max) {
          return;
        }
        if (n.nodeType === 3) {
          if (shown && n.nodeValue) {
            parts.push(n.nodeValue);
            size += n.nodeValue.length;
          }
          continue;
        }
        if (n.nodeType !== 1) {
          continue;
        }
        const name = n.localName;
        if (SKIP_TEXT.has(name) || n.hasAttribute("hidden") || n.getAttribute("aria-hidden") === "true") {
          continue;
        }
        if (++count > 8000 || (count % 200 === 0 && win.performance.now() - started > 300)) {
          cut = true;
          return;
        }
        if (name === "br") {
          parts.push("\n");
          continue;
        }
        const cs = win.getComputedStyle(n);
        if (!cs || cs.display === "none" || boxHidden(n, cs)) {
          continue;
        }
        let nbg = bg;
        if (cs.backgroundImage && cs.backgroundImage !== "none") {
          nbg = null;
        } else {
          const c = rgba(cs.backgroundColor);
          if (c && c[3] > 0.5) {
            nbg = c;
          } else if (c && c[3] > 0.05) {
            nbg = null;
          }
        }
        const block = !/^inline|^contents$/.test(cs.display);
        if (block) {
          parts.push("\n");
        }
        visit(n, nbg, !this.textHidden(cs, nbg));
        if (block) {
          parts.push("\n");
        }
      }
    };
    if (root && !this.hiddenWhy(root)) {
      const cs = win.getComputedStyle(root);
      const bg = this.backgroundOf(root);
      visit(root, bg, !!cs && !this.textHidden(cs, bg));
    }
    const text = parts.join("").replace(/[ \t ]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    return { text, cut };
  }

  /**
   * Текст страницы без навигации и скриптов, выделение, заголовки и главные ссылки — только то,
   * что видит человек. meta description и скрытый текст модели не отдаются: их пишет страница,
   * а пользователь не видит.
   */
  readPage(doc, { limit = TEXT_LIMIT } = {}) {
    const max = Math.max(500, Math.min(TEXT_LIMIT, Number(limit) || TEXT_LIMIT));
    const win = doc.defaultView;
    const selection = String(win?.getSelection?.() || "").trim().slice(0, 4000);
    const root = doc.querySelector("main, article, [role=main]") || doc.body;
    const { text, cut } = this.visibleText(doc, root, max + 2000);
    const pick = (list, scan, take, make) => {
      const out = [];
      let seen = 0;
      for (const el of list) {
        if (out.length >= take || ++seen > scan) {
          break;
        }
        const item = this.shownText(el) ? make(el) : null;
        if (item) {
          out.push(item);
        }
      }
      return out;
    };
    const line = s => String(s || "").replace(/\s+/g, " ").trim();
    const headings = pick(doc.querySelectorAll("h1, h2, h3"), 200, 30, h => (line(h.textContent) ? `${h.localName}: ${line(h.textContent).slice(0, 120)}` : null));
    const links = pick(doc.links, 400, 40, a => (isWeb(a.href) && line(a.textContent) ? { text: line(a.textContent).slice(0, 80), href: a.href } : null));
    return {
      url: doc.location.href,
      title: String(doc.title || "").slice(0, 300),
      lang: doc.documentElement.lang || "",
      selection,
      headings,
      links,
      text: text.slice(0, max),
      truncated: cut || text.length > max,
    };
  }

  /* ---- Формы ---------------------------------------------------------------- */

  labelOf(doc, el) {
    const id = el.id;
    let lab = null;
    try {
      lab = (id && doc.querySelector(`label[for="${CSS.escape(id)}"]`)) || el.closest("label");
    } catch (e) {}
    return (lab?.textContent || el.getAttribute("aria-label") || el.placeholder || el.name || "").replace(/\s+/g, " ").trim().slice(0, 80);
  }

  /** Видимые поля и кнопки страницы: что можно заполнить и нажать. */
  describeForms(doc) {
    const fields = [];
    let i = 0;
    for (const el of doc.querySelectorAll("input, textarea, select")) {
      if (["hidden", "submit", "button", "image", "reset", "file"].includes(el.type) || el.disabled) {
        continue;
      }
      if (!this.fieldVisible(el)) {
        continue;
      }
      el.dataset.taboraField = String(++i);
      fields.push({
        id: i,
        type: el.localName === "select" ? "select" : el.type || el.localName,
        label: this.labelOf(doc, el),
        name: el.name || "",
        placeholder: el.placeholder || "",
        value: el.type === "password" ? (el.value ? "••••" : "") : String(el.value || "").slice(0, 80),
        required: !!el.required,
        options: el.localName === "select" ? [...el.options].slice(0, 30).map(o => o.textContent.trim()) : undefined,
      });
      if (fields.length >= 60) {
        break;
      }
    }
    const buttons = [];
    let seen = 0;
    for (const b of doc.querySelectorAll("button, input[type=submit], [role=button], a.btn, a.button")) {
      if (buttons.length >= 30 || ++seen > 300) {
        break;
      }
      if (!this.isVisible(b)) {
        continue;
      }
      const id = buttons.length + 1;
      b.dataset.taboraButton = String(id);
      buttons.push({ id, text: (b.textContent || b.value || b.getAttribute("aria-label") || "").trim().slice(0, 60), ...(this.isSubmit(b) ? { submits_form: true } : {}) });
    }
    return { url: doc.location.href, title: String(doc.title || "").slice(0, 300), fields, buttons };
  }

  findField(doc, f) {
    let el = null;
    if (f.id) {
      el = doc.querySelector(`[data-tabora-field="${parseInt(f.id, 10) || 0}"]`);
    }
    if (!el && f.selector) {
      try {
        el = doc.querySelector(String(f.selector));
      } catch (e) {}
    }
    if (!el && f.label) {
      const needle = String(f.label).toLowerCase();
      el = [...doc.querySelectorAll("input, textarea, select")].find(x => this.labelOf(doc, x).toLowerCase().includes(needle));
    }
    // заполняем только поля форм, а не произвольные элементы по селектору
    return el && ["input", "textarea", "select"].includes(el.localName) ? el : null;
  }

  /** Поле, заполнение которого требует подтверждения пользователя в любом случае. */
  sensitiveKind(el) {
    if (el.localName === "input" && el.type === "password") {
      return "password";
    }
    if (el.localName === "input" && el.type === "hidden") {
      return "hidden";
    }
    return this.fieldVisible(el) ? "" : "invisible";
  }

  /**
   * Первый вызов ничего не заполняет: поля находятся, оболочка получает token и описание
   * каждого (найдено ли, подпись, тип, пароль/скрытое/невидимое) и сама решает, спрашивать ли
   * пользователя, показывая значения. Второй вызов с этим token и confirmed заполняет ровно
   * те элементы, что были описаны; поле, ставшее за это время паролем или скрытым, пропускается.
   */
  fillFields(doc, { fields = [], token = "", confirmed = false }) {
    if (!token) {
      const items = (Array.isArray(fields) ? fields : []).slice(0, 60).map(f => {
        const el = this.findField(doc, f || {});
        const usable = !!el && !(el.localName === "input" && el.type === "file");
        return { f: f || {}, el, kind: usable ? this.sensitiveKind(el) : "" };
      });
      this._pendingFill = { token: this.token(), items };
      return {
        needConfirm: true,
        token: this._pendingFill.token,
        fields: items.map(({ el, kind }, index) => {
          const usable = !!el && !(el.localName === "input" && el.type === "file");
          return {
            index,
            found: usable,
            kind,
            type: usable ? (el.localName === "select" ? "select" : el.type || el.localName) : "",
            label: usable ? this.labelOf(doc, el) : "",
            name: usable ? String(el.name || "").slice(0, 80) : "",
          };
        }),
      };
    }
    const pending = this._pendingFill;
    this._pendingFill = null;
    if (!pending || pending.token !== token || !confirmed) {
      return { error: "страница изменилась, заполните поля заново" };
    }
    const done = [];
    const win = doc.defaultView;
    for (const { f, el, kind } of pending.items) {
      const ref = f.id || f.label || f.selector;
      if (!el || !el.isConnected) {
        done.push({ field: ref, ok: false, reason: "поле не найдено" });
        continue;
      }
      if (el.localName === "input" && el.type === "file") {
        done.push({ field: ref, ok: false, reason: "поля выбора файла агент не заполняет" });
        continue;
      }
      if (el.disabled || el.readOnly) {
        done.push({ field: ref, ok: false, reason: "поле недоступно для ввода" });
        continue;
      }
      if (this.sensitiveKind(el) !== kind) {
        done.push({ field: ref, ok: false, reason: "поле изменилось, пока ждали подтверждения" });
        continue;
      }
      const value = f.value === undefined || f.value === null ? "" : f.value;
      el.focus();
      if (el.localName === "select") {
        const opt = [...el.options].find(o => o.textContent.trim().toLowerCase() === String(value).toLowerCase() || o.value === String(value));
        if (opt) {
          el.value = opt.value;
        }
      } else if (el.type === "checkbox" || el.type === "radio") {
        el.checked = value === true || value === "true" || value === "on";
      } else {
        const proto = el.localName === "textarea" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) {
          setter.call(el, String(value));
        } else {
          el.value = String(value);
        }
      }
      el.dispatchEvent(new win.Event("input", { bubbles: true }));
      el.dispatchEvent(new win.Event("change", { bubbles: true }));
      done.push({ field: ref, ok: true });
    }
    return done;
  }

  /* ---- Нажатия ---------------------------------------------------------------- */

  isSubmit(el) {
    const name = el.localName;
    if (name === "button") {
      return el.type === "submit" && !!el.form;
    }
    if (name === "input") {
      return (el.type === "submit" || el.type === "image") && !!el.form;
    }
    return false;
  }

  /**
   * Что произойдёт по нажатию: отправка формы (submit), переход по ссылке (link) или обычная
   * кнопка (other). Отдаётся только адрес назначения: origin, хост и «другой ли это сайт»
   * оболочка считает сама. Ссылки и формы не на http(s) (mailto:, tel:, внешние приложения)
   * агент не нажимает; javascript: — это кнопка самой страницы.
   */
  clickInfo(doc, el) {
    const text = (el.textContent || el.value || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 80);
    const control = el.closest("button, input") || el;
    if (this.isSubmit(control)) {
      const action = String((control.hasAttribute("formaction") ? control.formAction : control.form.action) || doc.location.href);
      return isWeb(action) ? { kind: "submit", text, target_url: action.slice(0, 4096) } : { blocked: true };
    }
    const link = el.closest("a[href], area[href]");
    if (link) {
      const href = String(link.href || "");
      if (isWeb(href)) {
        return { kind: "link", text, target_url: href.slice(0, 4096) };
      }
      if (!/^javascript:/i.test(href)) {
        return { blocked: true };
      }
    }
    return { kind: "other", text };
  }

  findButton(doc, { id, selector, text }) {
    let el = null;
    if (id) {
      el = doc.querySelector(`[data-tabora-button="${parseInt(id, 10) || 0}"]`);
    }
    if (!el && selector) {
      try {
        el = doc.querySelector(String(selector));
      } catch (e) {}
    }
    if (!el && text) {
      const needle = String(text).toLowerCase();
      const all = [...doc.querySelectorAll("button, a, input[type=submit], [role=button]")].filter(b => (b.textContent || b.value || "").trim().toLowerCase().includes(needle));
      el = all.find(b => this.isVisible(b)) || all[0] || null; // сначала тот, что видит человек
    }
    return el;
  }

  /**
   * Первый вызов ничего не нажимает: возвращает token и описание элемента (что это, текст,
   * куда ведёт, виден ли). Спрашивать ли пользователя, решает оболочка. Второй вызов с token
   * нажимает тот же элемент, если его назначение не изменилось. trusted — нажатие разрешил
   * пользователь: тогда это настоящий клик. Иначе страница получает событие, созданное в её
   * окне (isTrusted = false, жеста пользователя нет — всплывающие окна и прочее не сработают).
   */
  click(doc, { id, selector, text, token = "", confirmed = false, trusted = false }) {
    if (!token) {
      const el = this.findButton(doc, { id, selector, text });
      if (!el) {
        return { ok: false, reason: "элемент не найден" };
      }
      if (el.localName === "input" && el.type === "file") {
        return { ok: false, reason: "выбор файла агент не нажимает: пусть файл выберет пользователь" };
      }
      const info = this.clickInfo(doc, el);
      if (info.blocked) {
        return { ok: false, reason: "агент не нажимает почтовые ссылки и ссылки внешних приложений (mailto:, tel: и подобные)" };
      }
      this._pendingClick = { token: this.token(), el, kind: info.kind, target: info.target_url || "" };
      return { needConfirm: true, token: this._pendingClick.token, invisible: !this.isVisible(el), ...info };
    }
    const pending = this._pendingClick;
    this._pendingClick = null;
    if (!pending || pending.token !== token || !confirmed || !pending.el.isConnected) {
      return { ok: false, reason: "страница изменилась, найдите кнопку заново" };
    }
    const el = pending.el;
    const now = this.clickInfo(doc, el);
    if (now.blocked || now.kind !== pending.kind || (now.target_url || "") !== pending.target) {
      return { ok: false, reason: "элемент изменился, пока ждали подтверждения: найдите его заново" };
    }
    el.scrollIntoView({ block: "center" });
    if (trusted) {
      el.click();
    } else {
      const win = doc.defaultView;
      el.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, composed: true, view: win, button: 0 }));
    }
    return { ok: true, text: (el.textContent || el.value || "").trim().slice(0, 60) };
  }
}
