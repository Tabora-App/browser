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
 * Отправку форм, переход по ссылке на другой сайт и заполнение паролей и скрытых
 * полей актор выполняет только со вторым сообщением после подтверждения пользователя
 * в оболочке (token из первого ответа). Поля выбора файла не заполняются никогда:
 * значение, заданное из системного кода, прикрепило бы к форме любой файл с диска. */

const MIN_SIDE = 72;
const LIMIT = 80;
const TEXT_LIMIT = 24000;
const THUMB = 240; // сторона квадратной миниатюры, px
const THUMB_PNG_MAX = 48 * 1024; // тяжелее — пережимаем в JPEG
const POSTER_WAIT_MS = 2000;
const HTML_NS = "http://www.w3.org/1999/xhtml";

const isWeb = spec => /^https?:\/\//i.test(String(spec || ""));

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

  /* ---- Чтение страницы ------------------------------------------------------ */

  /** Текст страницы без навигации и скриптов, выделение, заголовки и главные ссылки. */
  readPage(doc, { limit = TEXT_LIMIT } = {}) {
    const max = Math.max(500, Math.min(TEXT_LIMIT, Number(limit) || TEXT_LIMIT));
    const win = doc.defaultView;
    const selection = String(win?.getSelection?.() || "").trim().slice(0, 4000);
    const root = doc.querySelector("main, article, [role=main]") || doc.body;
    const clone = root ? root.cloneNode(true) : null;
    if (clone) {
      for (const n of clone.querySelectorAll("script, style, noscript, svg, nav, footer, header, aside, [aria-hidden=true], [hidden]")) {
        n.remove();
      }
    }
    const text = (clone?.textContent || "").replace(/[ \t ]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    const headings = [...doc.querySelectorAll("h1, h2, h3")].slice(0, 30).map(h => `${h.localName}: ${h.textContent.trim().slice(0, 120)}`).filter(Boolean);
    const links = [...doc.links].filter(a => isWeb(a.href) && a.textContent.trim()).slice(0, 40).map(a => ({ text: a.textContent.trim().slice(0, 80), href: a.href }));
    const meta = n => doc.querySelector(`meta[name="${n}"], meta[property="${n}"]`)?.content || "";
    return {
      url: doc.location.href,
      title: doc.title,
      description: meta("description") || meta("og:description"),
      lang: doc.documentElement.lang || "",
      selection,
      headings,
      links,
      text: text.slice(0, max),
      truncated: text.length > max,
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

  isVisible(el) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) {
      return false;
    }
    const cs = el.ownerDocument.defaultView.getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && parseFloat(cs.opacity) > 0.05;
  }

  /** Поля форм на странице: что можно заполнить. */
  describeForms(doc) {
    const fields = [];
    let i = 0;
    for (const el of doc.querySelectorAll("input, textarea, select")) {
      if (["hidden", "submit", "button", "image", "reset", "file"].includes(el.type) || el.disabled) {
        continue;
      }
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) {
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
    const buttons = [...doc.querySelectorAll("button, input[type=submit], [role=button], a.btn, a.button")]
      .filter(b => b.getBoundingClientRect().width)
      .slice(0, 30)
      .map((b, j) => {
        b.dataset.taboraButton = String(j + 1);
        const submit = this.isSubmit(b);
        return { id: j + 1, text: (b.textContent || b.value || b.getAttribute("aria-label") || "").trim().slice(0, 60), ...(submit ? { submits_form: true } : {}) };
      });
    return { url: doc.location.href, title: doc.title, fields, buttons };
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

  /** Поле, заполнение которого требует подтверждения пользователя. */
  sensitiveKind(el) {
    if (el.localName === "input" && el.type === "password") {
      return "password";
    }
    if (el.localName === "input" && el.type === "hidden") {
      return "hidden";
    }
    return this.isVisible(el) ? "" : "invisible";
  }

  /**
   * Первый вызов: поля находятся и проверяются. Если среди них пароль, скрытое или невидимое
   * поле — ничего не заполняется, оболочка получает needConfirm и token. Второй вызов с этим
   * token и confirmed заполняет ровно те элементы, что были показаны пользователю.
   */
  fillFields(doc, { fields = [], token = "", confirmed = false }) {
    let items;
    if (token) {
      const pending = this._pendingFill;
      this._pendingFill = null;
      if (!pending || pending.token !== token || !confirmed) {
        return { error: "страница изменилась, заполните поля заново" };
      }
      items = pending.items;
    } else {
      items = (Array.isArray(fields) ? fields : []).slice(0, 60).map(f => ({ f: f || {}, el: this.findField(doc, f || {}) }));
      const sensitive = [];
      items.forEach((it, index) => {
        if (it.el && it.el.type !== "file") {
          const kind = this.sensitiveKind(it.el);
          if (kind) {
            sensitive.push({ index, kind, label: this.labelOf(doc, it.el), name: it.el.name || "" });
          }
        }
      });
      if (sensitive.length) {
        this._pendingFill = { token: this.token(), items };
        return { needConfirm: true, token: this._pendingFill.token, origin: doc.location.origin, host: doc.location.host, sensitive };
      }
    }
    const done = [];
    const win = doc.defaultView;
    for (const { f, el } of items) {
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

  originInfo(spec, here) {
    try {
      const u = new URL(spec);
      return { target_origin: u.origin, target_host: u.host, target_url: u.href.slice(0, 300), cross_origin: u.origin !== here };
    } catch (e) {
      return { target_origin: "", target_host: "", target_url: "", cross_origin: false };
    }
  }

  /** Что произойдёт по нажатию: отправка формы, переход по ссылке или обычная кнопка. */
  clickInfo(doc, el) {
    const text = (el.textContent || el.value || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 60);
    const here = doc.location.origin;
    const control = el.closest("button, input") || el;
    if (this.isSubmit(control)) {
      const action = control.hasAttribute("formaction") ? control.formAction : control.form.action;
      return { kind: "submit", text, ...this.originInfo(action || doc.location.href, here) };
    }
    const link = el.closest("a[href], area[href]");
    if (link && isWeb(link.href)) {
      const info = this.originInfo(link.href, here);
      return { kind: info.cross_origin ? "link" : "same", text, ...info };
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
      el = [...doc.querySelectorAll("button, a, input[type=submit], [role=button]")].find(b => (b.textContent || b.value || "").trim().toLowerCase().includes(needle));
    }
    return el;
  }

  /**
   * Отправка формы и переход по ссылке на другой сайт — только после подтверждения:
   * первый вызов возвращает needConfirm и token, второй с тем же token нажимает
   * тот же элемент. Остальное нажимается сразу.
   */
  click(doc, { id, selector, text, token = "", confirmed = false }) {
    let el;
    if (token) {
      const pending = this._pendingClick;
      this._pendingClick = null;
      if (!pending || pending.token !== token || !confirmed || !pending.el.isConnected) {
        return { ok: false, reason: "страница изменилась, найдите кнопку заново" };
      }
      el = pending.el;
    } else {
      el = this.findButton(doc, { id, selector, text });
      if (!el) {
        return { ok: false, reason: "элемент не найден" };
      }
      if (el.localName === "input" && el.type === "file") {
        return { ok: false, reason: "выбор файла агент не нажимает: пусть файл выберет пользователь" };
      }
      const info = this.clickInfo(doc, el);
      if (info.kind === "submit" || info.kind === "link") {
        this._pendingClick = { token: this.token(), el };
        return { needConfirm: true, token: this._pendingClick.token, origin: doc.location.origin, host: doc.location.host, ...info };
      }
    }
    el.scrollIntoView({ block: "center" });
    el.click();
    return { ok: true, text: (el.textContent || el.value || "").trim().slice(0, 60) };
  }
}
