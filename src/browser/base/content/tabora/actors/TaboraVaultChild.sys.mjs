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

export class TaboraVaultChild extends JSWindowActorChild {
  handleEvent(event) {
    if (event.type === "click") {
      this.onClick(event);
    }
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
