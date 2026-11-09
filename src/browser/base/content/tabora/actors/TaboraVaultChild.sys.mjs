/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Актор страницы для сейфа: перехватывает ссылки otpauth:// (добавление кода в
 * аутентификатор), сообщает о фокусе на поле одноразового кода и отдаёт родителю пиксели
 * картинок для распознавания QR. Картинки, canvas и SVG страницы растеризуются здесь, в
 * процессе страницы: родитель получает только ограниченные по размеру пиксели в оттенках
 * серого и никогда не декодирует разметку страницы. Секретов у актора нет. Сообщениям
 * отсюда родитель не доверяет: хост он берёт из принципала документа, а вставку кода
 * подтверждает своим наблюдением за клавиатурой. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ContentDOMReference: "resource://gre/modules/ContentDOMReference.sys.mjs",
});

const MIN_QR_SIDE = 80;
const MAX_IMAGES = 24;
const MAX_SIDE = 1600; // одна картинка из меню: QR крупнее не бывает
const PAGE_MAX_SIDE = 1024; // поиск по странице: много картинок, каждая меньше
const PAGE_BUDGET = 16 * 1024 * 1024; // байт пикселей на весь ответ

/* Поле одноразового кода: явный autocomplete, характерные имена, числовое поле на 6–8 знаков
 * или группа из 4–8 однознаковых полей. Родитель покажет подсказку, только если у сайта есть запись. */
const OTP_NAME = /(^|[^a-z])(otp|totp|2fa|mfa|one.?time|verif|auth(enticat(or|ion))?.?code|security.?code|passcode|token|код)([^a-z]|$)/i;
const NOT_OTP = /zip|postal|phone|tel\b|cvv|cvc|card|ccn|expir|captcha|search|price|amount|qty|quantity|year|month|day|age/i;

export class TaboraVaultChild extends JSWindowActorChild {
  _otpTarget = null; // поле (или первое поле группы), для которого показана подсказка
  _otpGroup = null;
  _armed = false;
  _scrollHandler = null;

  handleEvent(event) {
    switch (event.type) {
      case "click":
        this.onClick(event);
        break;
      case "focusin":
        this.onFocusIn(event);
        break;
      case "focusout":
        this.onFocusOut(event);
        break;
      case "keydown":
        this.onKeyDown(event);
        break;
    }
  }

  didDestroy() {
    this.detachScroll();
  }

  /* ---- поле кода ---- */

  labelText(el) {
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

  isTextInput(el) {
    const win = this.contentWindow;
    return win.HTMLInputElement.isInstance(el) && ["", "text", "tel", "number", "password"].includes(el.type) && !el.disabled && !el.readOnly;
  }

  /** Группа однознаковых полей (4–8), в которую входит el. */
  digitGroup(el) {
    let node = el.parentElement;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      const inputs = [...node.querySelectorAll("input")].filter(i => this.isTextInput(i) && i.maxLength === 1);
      if (inputs.length >= 4 && inputs.length <= 8 && inputs.includes(el)) {
        return inputs;
      }
      if (node.querySelectorAll("input").length > 12) {
        break;
      }
    }
    return null;
  }

  otpKind(el) {
    if (!this.isTextInput(el)) {
      return null;
    }
    const auto = (el.getAttribute("autocomplete") || "").toLowerCase();
    if (auto.includes("one-time-code")) {
      return "explicit";
    }
    const group = this.digitGroup(el);
    if (group) {
      return "group";
    }
    const text = this.labelText(el);
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

  rectOf(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }

  /** Коды только для https и защищённого контекста: по http их увидел бы любой посредник. */
  get secure() {
    try {
      return this.document.location.protocol === "https:" && !!this.contentWindow.isSecureContext;
    } catch (e) {
      return false;
    }
  }

  onFocusIn(event) {
    const el = event.composedTarget || event.target;
    if (!event.isTrusted || !this.secure || !el || el === this._otpTarget) {
      return;
    }
    const kind = this.otpKind(el);
    if (!kind) {
      return;
    }
    const group = kind === "group" ? this.digitGroup(el) : null;
    this._otpTarget = group ? group[0] : el;
    this._otpGroup = group;
    const first = group ? group[0] : el;
    const last = group ? group[group.length - 1] : el;
    const a = first.getBoundingClientRect();
    const b = last.getBoundingClientRect();
    const rect = { x: Math.min(a.left, b.left), y: Math.min(a.top, b.top), w: Math.max(a.right, b.right) - Math.min(a.left, b.left), h: Math.max(a.bottom, b.bottom) - Math.min(a.top, b.top) };
    // хост не передаём: родитель берёт его из принципала документа
    this.sendAsyncMessage("TaboraVault:OtpField", { kind, rect, zoom: this.contentWindow.windowUtils?.fullZoom || 1, maxLength: group ? group.length : el.maxLength > 0 ? el.maxLength : 0 });
  }

  onFocusOut(event) {
    const el = event.composedTarget || event.target;
    if (!this._otpTarget) {
      return;
    }
    const inside = this._otpGroup ? this._otpGroup.includes(el) : el === this._otpTarget;
    if (!inside) {
      return;
    }
    // фокус мог перейти в соседнее поле группы: проверяем после события
    this.contentWindow.setTimeout(() => {
      const active = this.document.activeElement;
      const still = this._otpGroup ? this._otpGroup.includes(active) : active === this._otpTarget;
      if (!still) {
        this.resetOtp();
        this.sendAsyncMessage("TaboraVault:OtpFieldBlur", {});
      }
    }, 0);
  }

  onKeyDown(event) {
    if (!event.isTrusted || !this._armed || !this._otpTarget) {
      return;
    }
    const el = event.composedTarget || event.target;
    const inside = this._otpGroup ? this._otpGroup.includes(el) : el === this._otpTarget;
    if (!inside) {
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.sendAsyncMessage("TaboraVault:OtpAccept", {});
    } else if (event.key === "Escape") {
      this.sendAsyncMessage("TaboraVault:OtpDismiss", {});
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      this.sendAsyncMessage("TaboraVault:OtpMove", { delta: event.key === "ArrowDown" ? 1 : -1 });
    }
  }

  /** Подсказку взвели заново (например, после разблокировки сейфа): поле берём из фокуса. */
  reacquire() {
    let el = this.document.activeElement;
    while (el?.shadowRoot?.activeElement) {
      el = el.shadowRoot.activeElement;
    }
    const kind = el && this.secure ? this.otpKind(el) : null;
    if (!kind) {
      return;
    }
    const group = kind === "group" ? this.digitGroup(el) : null;
    this._otpTarget = group ? group[0] : el;
    this._otpGroup = group;
  }

  resetOtp() {
    this._otpTarget = null;
    this._otpGroup = null;
    this._armed = false;
    this.detachScroll();
  }

  attachScroll() {
    if (this._scrollHandler) {
      return;
    }
    this._scrollHandler = () => {
      this.sendAsyncMessage("TaboraVault:OtpFieldBlur", {});
      this._armed = false;
      this.detachScroll();
    };
    this.contentWindow.addEventListener("scroll", this._scrollHandler, { capture: true, passive: true });
    this.contentWindow.addEventListener("resize", this._scrollHandler, { passive: true });
  }

  detachScroll() {
    if (this._scrollHandler) {
      try {
        this.contentWindow.removeEventListener("scroll", this._scrollHandler, { capture: true });
        this.contentWindow.removeEventListener("resize", this._scrollHandler);
      } catch (e) {}
      this._scrollHandler = null;
    }
  }

  setValue(el, value) {
    const win = this.contentWindow;
    const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
    if (setter) {
      setter.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new win.InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    el.dispatchEvent(new win.Event("change", { bubbles: true }));
  }

  /** Вставка кода: в одно поле или по символу в группу. Форму не отправляем. */
  fillOtp(code) {
    const target = this._otpTarget;
    if (!target || !target.isConnected) {
      return false;
    }
    code = String(code || "").replace(/\D/g, "");
    if (this._otpGroup) {
      this._otpGroup.forEach((input, i) => {
        if (i < code.length) {
          input.focus();
          this.setValue(input, code[i]);
        }
      });
      const lastIndex = Math.min(code.length, this._otpGroup.length) - 1;
      this._otpGroup[lastIndex]?.focus();
    } else {
      target.focus();
      this.setValue(target, code);
      try {
        target.setSelectionRange(code.length, code.length);
      } catch (e) {}
    }
    this.resetOtp();
    return true;
  }

  onClick(event) {
    if (!event.isTrusted || event.button !== 0 || event.defaultPrevented) {
      return;
    }
    const a = event.target?.closest?.("a[href]");
    const href = a?.href || "";
    if (!/^otpauth(-migration)?:/i.test(href)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.sendAsyncMessage("TaboraVault:Otpauth", { url: href, host: this.document.location.host });
  }

  receiveMessage(message) {
    const doc = this.document;
    if (!doc || !doc.location) {
      return null;
    }
    switch (message.name) {
      case "TaboraVault:Arm":
        if (message.data?.armed) {
          if (!this._otpTarget) {
            this.reacquire();
          }
          if (this._otpTarget) {
            this._armed = true;
            this.attachScroll();
          }
        } else {
          this.resetOtp(); // подсказка скрыта: следующий фокус на поле снова покажет её
        }
        return this._armed;
      case "TaboraVault:FillOtp":
        return this.fillOtp(message.data?.code);
      case "TaboraVault:ImageData":
        return this.imageData(lazy.ContentDOMReference.resolve(message.data?.targetIdentifier), MAX_SIDE);
      case "TaboraVault:PageImages":
        return this.pageImages(doc);
    }
    return null;
  }

  /** Холст с белым фоном (прозрачный фон QR иначе станет чёрным). */
  canvasFor(w, h) {
    const canvas = this.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    return ctx;
  }

  /** Пиксели холста в оттенках серого: байт на пиксель, вчетверо меньше RGBA. */
  grayOf(ctx, w, h) {
    const px = ctx.getImageData(0, 0, w, h).data;
    const gray = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
      gray[i] = (px[j] * 77 + px[j + 1] * 150 + px[j + 2] * 29) >> 8;
    }
    return gray;
  }

  /** Картинка или canvas → пиксели. Чтение пикселей чужих доменов разрешено системному
   * принципалу актора, как и встроенной команде «Копировать изображение». */
  imageData(target, maxSide = MAX_SIDE) {
    if (!target) {
      return null;
    }
    try {
      const win = this.contentWindow;
      let w;
      let h;
      if (win.HTMLCanvasElement.isInstance(target)) {
        w = target.width;
        h = target.height;
      } else if (win.HTMLImageElement.isInstance(target)) {
        w = target.naturalWidth;
        h = target.naturalHeight;
      } else {
        const svg = win.SVGElement.isInstance(target) ? target.ownerSVGElement || target : null;
        return svg ? this.svgData(svg, maxSide) : null;
      }
      if (!w || !h) {
        return null;
      }
      const scale = Math.min(1, maxSide / Math.max(w, h));
      const cw = Math.max(1, Math.round(w * scale));
      const ch = Math.max(1, Math.round(h * scale));
      const ctx = this.canvasFor(cw, ch);
      ctx.drawImage(target, 0, 0, cw, ch);
      return { gray: this.grayOf(ctx, cw, ch), w: cw, h: ch, alt: String(target.alt || "").slice(0, 200) };
    } catch (e) {
      return null;
    }
  }

  /** Встроенный SVG: снимок области страницы, где он нарисован (drawWindow доступен только
   * системному коду). Разметка SVG никуда не передаётся. */
  svgData(svg, maxSide) {
    try {
      const win = this.contentWindow;
      const r = svg.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) {
        return null;
      }
      const scale = Math.min(2, maxSide / Math.max(r.width, r.height));
      const cw = Math.max(1, Math.round(r.width * scale));
      const ch = Math.max(1, Math.round(r.height * scale));
      const ctx = this.canvasFor(cw, ch);
      ctx.scale(scale, scale);
      ctx.drawWindow(win, r.left + win.scrollX, r.top + win.scrollY, r.width, r.height, "#fff");
      return { gray: this.grayOf(ctx, cw, ch), w: cw, h: ch, alt: String(svg.getAttribute("aria-label") || "").slice(0, 200) };
    } catch (e) {
      return null;
    }
  }

  /** Все заметные картинки, canvas и встроенные SVG страницы: кандидаты в QR. */
  pageImages(doc) {
    const out = [];
    let bytes = 0;
    const visible = el => {
      const r = el.getBoundingClientRect();
      return r.width >= MIN_QR_SIDE && r.height >= MIN_QR_SIDE;
    };
    const push = data => {
      if (data && bytes + data.gray.length <= PAGE_BUDGET) {
        bytes += data.gray.length;
        out.push(data);
      }
    };
    for (const el of doc.querySelectorAll("img, canvas")) {
      if (out.length >= MAX_IMAGES || bytes >= PAGE_BUDGET) {
        break;
      }
      if (visible(el)) {
        push(this.imageData(el, PAGE_MAX_SIDE));
      }
    }
    for (const svg of doc.querySelectorAll("svg")) {
      if (out.length >= MAX_IMAGES || bytes >= PAGE_BUDGET) {
        break;
      }
      if (visible(svg) && !svg.parentElement?.closest("svg")) {
        push(this.svgData(svg, PAGE_MAX_SIDE));
      }
    }
    return out;
  }
}
