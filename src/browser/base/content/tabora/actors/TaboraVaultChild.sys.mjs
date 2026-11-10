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

/* Поле одноразового кода: группа из 4–8 однознаковых полей, явный autocomplete, характерные имена
 * или числовое поле на 6–8 знаков. Родитель покажет подсказку, только если у сайта есть запись. */
const OTP_NAME = /(^|[^a-z])(otp|totp|2fa|mfa|one.?time|verif|auth(enticat(or|ion))?.?code|security.?code|passcode|token|код)([^a-z]|$)/i;
const NOT_OTP = /zip|postal|phone|tel\b|cvv|cvc|card|ccn|expir|captcha|search|price|amount|qty|quantity|year|month|day|age/i;

export class TaboraVaultChild extends JSWindowActorChild {
  _otpTarget = null; // поле (или первое поле группы), для которого показана подсказка
  _otpGroup = null;
  _armed = false;
  _filling = false; // идёт вставка: собственные переводы фокуса подсказку не вызывают
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

  /** Группа однознаковых полей (4–8), в которую входит el. Ячейка — поле с maxlength=1 либо узкое
   * (примерно квадрат) поле того же размера, что el: у многих виджетов maxlength нет или он равен
   * длине кода, чтобы принять вставку. Поля шире (части номера карты, ключа продукта) не ячейки.
   * Размер берётся из раскладки (offset*): увеличение ячейки в фокусе через transform не мешает. */
  digitGroup(el) {
    if (!this.isTextInput(el) || !el.offsetWidth || !el.offsetHeight) {
      return null;
    }
    let narrowOnly = false; // в группе есть ячейки, принятые только по размеру
    const cell = i => {
      if (!this.isTextInput(i) || !i.offsetWidth || !i.offsetHeight) {
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
          const text = this.labelText(el);
          if (NOT_OTP.test(text) && !/otp|one.?time|2fa|mfa/i.test(text)) {
            return null;
          }
        }
        return cells;
      }
    }
    return null;
  }

  otpKind(el) {
    if (!this.isTextInput(el)) {
      return null;
    }
    // группа проверяется первой: autocomplete="one-time-code" часто стоит и на каждой ячейке,
    // и тогда весь код ушёл бы в одно поле
    if (this.digitGroup(el)) {
      return "group";
    }
    const auto = (el.getAttribute("autocomplete") || "").toLowerCase();
    if (auto.includes("one-time-code")) {
      return "explicit";
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
    if (!event.isTrusted || this._filling || !this.secure || !el || el === this._otpTarget) {
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
    const el = this.deepActive();
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

  nativeSet(el, value) {
    const setter = Object.getOwnPropertyDescriptor(this.contentWindow.HTMLInputElement.prototype, "value")?.set;
    if (setter) {
      setter.call(el, value);
    } else {
      el.value = value;
    }
  }

  setValue(el, value) {
    const win = this.contentWindow;
    this.nativeSet(el, value);
    el.dispatchEvent(new win.InputEvent("input", { bubbles: true, inputType: value ? "insertText" : "deleteContentBackward", data: value || null }));
    el.dispatchEvent(new win.Event("change", { bubbles: true }));
  }

  deepActive() {
    let el = this.document.activeElement;
    while (el?.shadowRoot?.activeElement) {
      el = el.shadowRoot.activeElement;
    }
    return el;
  }

  /** В первых n ячейках по одной своей цифре. */
  groupHolds(group, code) {
    const n = Math.min(code.length, group.length);
    for (let i = 0; i < n; i++) {
      if (!group[i].isConnected || group[i].value.replace(/\D/g, "") !== code[i]) {
        return false;
      }
    }
    return true;
  }

  /** По цифре в каждую ячейку: обычные поля и поля с состоянием (React, Vue). */
  fillCells(group, code) {
    const n = Math.min(code.length, group.length);
    for (let i = 0; i < n; i++) {
      group[i].focus();
      this.setValue(group[i], code[i]);
    }
  }

  /** Как вставка из буфера в первую ячейку: виджеты с обработчиком paste раскладывают цифры сами. */
  pasteCells(group, code) {
    const win = this.contentWindow;
    group[0].focus();
    try {
      group[0].dispatchEvent(new win.ClipboardEvent("paste", { bubbles: true, cancelable: true, dataType: "text/plain", data: code }));
    } catch (e) {}
  }

  /** Как набор с клавиатуры: цифра уходит в ячейку, куда виджет сам перевёл фокус. Виджет, который
   * берёт цифру из keydown и отменяет ввод, получает только событие клавиши (без второй записи). */
  typeCells(group, code) {
    const win = this.contentWindow;
    const n = Math.min(code.length, group.length);
    group[0].focus();
    for (let i = 0; i < n; i++) {
      let cur = this.deepActive();
      if (!group.includes(cur)) {
        cur = group[i];
        cur.focus();
      }
      const key = { key: code[i], code: "Digit" + code[i], keyCode: 48 + Number(code[i]), which: 48 + Number(code[i]), bubbles: true, cancelable: true };
      if (cur.dispatchEvent(new win.KeyboardEvent("keydown", key))) {
        this.setValue(cur, code[i]);
      }
      cur.dispatchEvent(new win.KeyboardEvent("keyup", key));
      if (this.deepActive() === cur) {
        group[group.indexOf(cur) + 1]?.focus();
      }
    }
  }

  clearCells(group) {
    for (const input of group) {
      if (input.isConnected && input.value) {
        this.setValue(input, "");
      }
    }
  }

  settle() {
    // даём виджету перерисоваться, прежде чем сверять значения
    return new Promise(resolve => this.contentWindow.setTimeout(resolve, 60));
  }

  /** Вставка кода: в одно поле или по символу в группу. Форму не отправляем. Если после вставки в
   * ячейках не оказалось по цифре (виджет ведёт своё состояние), пробуем другие способы. */
  async fillOtp(code) {
    const target = this._otpTarget;
    if (!target || !target.isConnected) {
      return false;
    }
    code = String(code || "").replace(/\D/g, "");
    // группа могла не определиться при фокусе (поля появились позже): пробуем ещё раз
    const group = this._otpGroup || (target.maxLength === 1 ? this.digitGroup(target) : null);
    this.resetOtp();
    if (!group) {
      target.focus();
      this.setValue(target, code);
      try {
        target.setSelectionRange(code.length, code.length);
      } catch (e) {}
      return true;
    }
    this._filling = true;
    try {
      for (const way of [this.fillCells, this.pasteCells, this.typeCells, this.fillCells]) {
        this.clearCells(group);
        way.call(this, group, code);
        await this.settle();
        if (!this.document || !group[0].isConnected) {
          return true; // форма ушла дальше (сайт принял код и сменил страницу)
        }
        // ячейки заблокированы: сайт уже проверяет код, повторная вставка отправила бы его дважды
        if (this.groupHolds(group, code) || group.some(i => i.disabled || i.readOnly)) {
          break;
        }
        // последний проход — снова по цифре в ячейку: если виджет не принял ни один способ,
        // цифры хотя бы остаются в полях
      }
      const last = group[Math.min(code.length, group.length) - 1];
      if (last?.isConnected && group.includes(this.deepActive())) {
        last.focus();
      }
    } finally {
      this._filling = false;
    }
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
