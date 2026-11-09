/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Актор страницы для сейфа: перехватывает ссылки otpauth:// (добавление кода в
 * аутентификатор) и отдаёт родителю пиксели картинок для распознавания QR.
 * Секретов у актора нет: распознавание и хранение — в родительском процессе. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ContentDOMReference: "resource://gre/modules/ContentDOMReference.sys.mjs",
});

const MIN_QR_SIDE = 80;
const MAX_IMAGES = 24;
const MAX_SIDE = 1600; // QR крупнее не бывает, а память контент-процесса бережём

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

  onFocusIn(event) {
    const el = event.composedTarget || event.target;
    if (!/^https?:$/.test(this.document.location.protocol) || !el || el === this._otpTarget) {
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
    this.sendAsyncMessage("TaboraVault:OtpField", { host: this.document.location.host, kind, rect, zoom: this.contentWindow.windowUtils?.fullZoom || 1, maxLength: group ? group.length : el.maxLength > 0 ? el.maxLength : 0 });
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
    if (!this._armed || !this._otpTarget) {
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
    if (event.button !== 0 || event.defaultPrevented) {
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
        if (message.data?.armed && this._otpTarget) {
          this._armed = true;
          this.attachScroll();
        } else {
          this.resetOtp(); // подсказка скрыта: следующий фокус на поле снова покажет её
        }
        return this._armed;
      case "TaboraVault:FillOtp":
        return this.fillOtp(message.data?.code);
      case "TaboraVault:ImageData":
        return this.imageData(lazy.ContentDOMReference.resolve(message.data.targetIdentifier));
      case "TaboraVault:PageImages":
        return this.pageImages(doc);
    }
    return null;
  }

  /** Пиксели картинки или canvas в виде data: URL (PNG). Для чужих доменов это разрешено
   * системному принципалу актора, как и встроенной команде «Копировать изображение». */
  imageData(target) {
    if (!target) {
      return null;
    }
    try {
      const win = this.contentWindow;
      let w;
      let h;
      let source = target;
      if (win.HTMLCanvasElement.isInstance(target)) {
        w = target.width;
        h = target.height;
      } else if (win.HTMLImageElement.isInstance(target)) {
        w = target.naturalWidth;
        h = target.naturalHeight;
      } else if (win.SVGSVGElement.isInstance(target) || target.closest?.("svg")) {
        return null; // встроенный SVG отдаём отдельным путём (см. pageImages)
      } else {
        return null;
      }
      if (!w || !h) {
        return null;
      }
      const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
      const canvas = this.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff"; // прозрачный фон QR иначе станет чёрным
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
      return { dataURL: canvas.toDataURL("image/png"), w: canvas.width, h: canvas.height, alt: target.alt || "" };
    } catch (e) {
      return null;
    }
  }

  /** Все заметные картинки, canvas и встроенные SVG страницы: кандидаты в QR. */
  pageImages(doc) {
    const out = [];
    const win = this.contentWindow;
    const visible = el => {
      const r = el.getBoundingClientRect();
      return r.width >= MIN_QR_SIDE && r.height >= MIN_QR_SIDE;
    };
    for (const el of doc.querySelectorAll("img, canvas")) {
      if (out.length >= MAX_IMAGES) {
        break;
      }
      if (!visible(el)) {
        continue;
      }
      const data = this.imageData(el);
      if (data) {
        out.push(data);
      }
    }
    for (const svg of doc.querySelectorAll("svg")) {
      if (out.length >= MAX_IMAGES) {
        break;
      }
      if (!visible(svg) || svg.closest("svg") !== svg) {
        continue;
      }
      try {
        const r = svg.getBoundingClientRect();
        const clone = svg.cloneNode(true);
        clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
        clone.setAttribute("width", String(Math.round(r.width)));
        clone.setAttribute("height", String(Math.round(r.height)));
        const xml = new win.XMLSerializer().serializeToString(clone);
        out.push({ svg: xml, w: Math.round(r.width), h: Math.round(r.height), alt: svg.getAttribute("aria-label") || "" });
      } catch (e) {}
    }
    return out;
  }
}
