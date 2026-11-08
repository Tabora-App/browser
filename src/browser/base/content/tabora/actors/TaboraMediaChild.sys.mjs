/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Актор страницы Tabora: собирает медиа для ящика и даёт агенту читать текст,
 * заполнять поля и нажимать кнопки на странице. */

const MIN_SIDE = 72;
const LIMIT = 80;
const TEXT_LIMIT = 24000;

export class TaboraMediaChild extends JSWindowActorChild {
  receiveMessage(message) {
    const doc = this.document;
    if (!doc || !doc.location) {
      return null;
    }
    switch (message.name) {
      case "TaboraMedia:Collect":
        return this.collectMedia(doc);
      case "TaboraPage:Read":
        return this.readPage(doc, message.data || {});
      case "TaboraPage:Fill":
        return this.fillFields(doc, message.data || {});
      case "TaboraPage:Click":
        return this.click(doc, message.data || {});
      case "TaboraPage:Forms":
        return this.describeForms(doc);
    }
    return null;
  }

  collectMedia(doc) {
    if (!/^https?:$/.test(doc.location.protocol)) {
      return [];
    }
    const seen = new Set();
    const out = [];
    const push = item => {
      if (!item.src || seen.has(item.src) || !/^https?:/.test(item.src)) {
        return;
      }
      seen.add(item.src);
      out.push({ ...item, page: doc.location.href, title: doc.title });
    };
    for (const img of doc.images) {
      if (out.length >= LIMIT) {
        break;
      }
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      if (w < MIN_SIDE || h < MIN_SIDE) {
        continue;
      }
      push({ kind: "image", src: img.currentSrc || img.src, w, h, alt: img.alt || "" });
    }
    for (const video of doc.querySelectorAll("video")) {
      if (out.length >= LIMIT) {
        break;
      }
      const src = video.currentSrc || video.src || video.querySelector("source")?.src || "";
      push({ kind: "video", src, poster: video.poster || "", w: video.videoWidth, h: video.videoHeight, alt: video.title || "" });
    }
    return out;
  }

  /** Текст страницы без навигации и скриптов, выделение, заголовки и главные ссылки. */
  readPage(doc, { limit = TEXT_LIMIT } = {}) {
    const win = doc.defaultView;
    const selection = String(win?.getSelection?.() || "").trim().slice(0, 4000);
    const root = doc.querySelector("main, article, [role=main]") || doc.body;
    const clone = root ? root.cloneNode(true) : null;
    if (clone) {
      for (const n of clone.querySelectorAll("script, style, noscript, svg, nav, footer, header, aside, [aria-hidden=true], [hidden]")) {
        n.remove();
      }
    }
    const text = (clone?.textContent || "").replace(/[ \t ]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    const headings = [...doc.querySelectorAll("h1, h2, h3")].slice(0, 30).map(h => `${h.localName}: ${h.textContent.trim().slice(0, 120)}`).filter(Boolean);
    const links = [...doc.links].filter(a => a.href.startsWith("http") && a.textContent.trim()).slice(0, 40).map(a => ({ text: a.textContent.trim().slice(0, 80), href: a.href }));
    const meta = n => doc.querySelector(`meta[name="${n}"], meta[property="${n}"]`)?.content || "";
    return {
      url: doc.location.href,
      title: doc.title,
      description: meta("description") || meta("og:description"),
      lang: doc.documentElement.lang || "",
      selection,
      headings,
      links,
      text: text.slice(0, limit),
      truncated: text.length > limit,
    };
  }

  /** Поля форм на странице: что можно заполнить. */
  describeForms(doc) {
    const fields = [];
    const labelFor = el => {
      const id = el.id;
      const lab = (id && doc.querySelector(`label[for="${CSS.escape(id)}"]`)) || el.closest("label");
      return (lab?.textContent || el.getAttribute("aria-label") || el.placeholder || el.name || "").trim().slice(0, 80);
    };
    let i = 0;
    for (const el of doc.querySelectorAll("input, textarea, select")) {
      if (["hidden", "submit", "button", "image", "reset"].includes(el.type) || el.disabled) {
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
        label: labelFor(el),
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
        return { id: j + 1, text: (b.textContent || b.value || b.getAttribute("aria-label") || "").trim().slice(0, 60) };
      });
    return { url: doc.location.href, title: doc.title, fields, buttons };
  }

  fillFields(doc, { fields = [] }) {
    const done = [];
    const win = doc.defaultView;
    for (const f of fields) {
      let el = null;
      if (f.id) {
        el = doc.querySelector(`[data-tabora-field="${f.id}"]`);
      }
      if (!el && f.selector) {
        try {
          el = doc.querySelector(f.selector);
        } catch (e) {}
      }
      if (!el && f.label) {
        const needle = f.label.toLowerCase();
        el = [...doc.querySelectorAll("input, textarea, select")].find(x => {
          const lab = (x.id && doc.querySelector(`label[for="${CSS.escape(x.id)}"]`)?.textContent) || x.closest("label")?.textContent || x.getAttribute("aria-label") || x.placeholder || x.name || "";
          return lab.toLowerCase().includes(needle);
        });
      }
      if (!el) {
        done.push({ field: f.id || f.label || f.selector, ok: false, reason: "поле не найдено" });
        continue;
      }
      el.focus();
      if (el.localName === "select") {
        const opt = [...el.options].find(o => o.textContent.trim().toLowerCase() === String(f.value).toLowerCase() || o.value === f.value);
        if (opt) {
          el.value = opt.value;
        }
      } else if (el.type === "checkbox" || el.type === "radio") {
        el.checked = f.value === true || f.value === "true" || f.value === "on";
      } else {
        const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
        if (setter && el.localName === "input") {
          setter.call(el, String(f.value));
        } else {
          el.value = String(f.value);
        }
      }
      el.dispatchEvent(new win.Event("input", { bubbles: true }));
      el.dispatchEvent(new win.Event("change", { bubbles: true }));
      done.push({ field: f.id || f.label || f.selector, ok: true });
    }
    return done;
  }

  click(doc, { id, selector, text }) {
    let el = null;
    if (id) {
      el = doc.querySelector(`[data-tabora-button="${id}"]`);
    }
    if (!el && selector) {
      try {
        el = doc.querySelector(selector);
      } catch (e) {}
    }
    if (!el && text) {
      const needle = text.toLowerCase();
      el = [...doc.querySelectorAll("button, a, input[type=submit], [role=button]")].find(b => (b.textContent || b.value || "").trim().toLowerCase().includes(needle));
    }
    if (!el) {
      return { ok: false, reason: "элемент не найден" };
    }
    el.scrollIntoView({ block: "center" });
    el.click();
    return { ok: true, text: (el.textContent || el.value || "").trim().slice(0, 60) };
  }
}
