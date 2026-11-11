/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Построение разметки. Страница собирается узлами DOM, без innerHTML: текст из писем, названий и
 * адресов попадает в документ только как текст и не может стать разметкой или скриптом. */

import { ICONS } from "./icons.js";

const SVG = "http://www.w3.org/2000/svg";

/**
 * h("button", { class: "btn", onclick: fn, "aria-label": "…" }, "текст", узел, [узлы])
 * Свойства: on* — обработчики; class, hidden, disabled, value, checked — как есть; data и aria —
 * атрибутами; null, undefined и false пропускаются.
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) {
        continue;
      }
      if (k.startsWith("on") && typeof v === "function") {
        el.addEventListener(k.slice(2), v);
      } else if (k === "class") {
        el.className = v;
      } else if (k === "text") {
        el.textContent = v;
      } else if (k === "value" || k === "checked" || k === "disabled" || k === "hidden" || k === "selected" || k === "readOnly" || k === "indeterminate") {
        el[k] = v;
      } else {
        el.setAttribute(k, v === true ? "" : String(v));
      }
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) {
      continue;
    }
    if (Array.isArray(c)) {
      append(el, c);
    } else if (c instanceof Node) {
      el.append(c);
    } else {
      el.append(document.createTextNode(String(c)));
    }
  }
  return el;
}

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

export function icon(name, size = 18, stroke = 1.8) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", stroke);
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("icon");
  for (const d of [].concat(ICONS[name] || ICONS.dot)) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/** Знак Tabora: лаймовый квадрат с монограммой T. */
export function mark(size = 28) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 256 256");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("mark");
  const rect = (x, y, w, hh, rx, fill) => {
    const r = document.createElementNS(SVG, "rect");
    for (const [k, v] of Object.entries({ x, y, width: w, height: hh, rx, fill })) {
      r.setAttribute(k, v);
    }
    return r;
  };
  const dot = document.createElementNS(SVG, "circle");
  dot.setAttribute("cx", 181);
  dot.setAttribute("cy", 85);
  dot.setAttribute("r", 11);
  dot.setAttribute("fill", "#c8f25a");
  svg.append(rect(0, 0, 256, 256, 58, "#c8f25a"), rect(56, 66, 144, 38, 19, "#0b0c0e"), rect(109, 66, 38, 134, 19, "#0b0c0e"), dot);
  return svg;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
