/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Фирменный выпадающий список вместо системного <select>.
 * TaboraSelect.enhance(select) прячет родной элемент и рисует кнопку со списком;
 * значение по-прежнему читается и пишется через select.value, событие change
 * уходит на родной select. Список рисуется поверх всего (position: fixed),
 * поэтому не обрезается прокручиваемыми контейнерами. Стили: select.css. */

(function () {
  const NS = "http://www.w3.org/1999/xhtml";
  let openState = null; // { pop, wrap, select, close }

  function h(doc, tag, cls, text) {
    const node = doc.createElementNS(NS, tag);
    if (cls) {
      node.className = cls;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }

  function chevron(doc) {
    const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "14");
    svg.setAttribute("height", "14");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2.2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "m6 9 6 6 6-6");
    svg.append(path);
    return svg;
  }

  function check(doc) {
    const svg = chevron(doc);
    svg.firstChild.setAttribute("d", "m5 12 5 5L20 7");
    svg.setAttribute("stroke-width", "2.6");
    return svg;
  }

  function closeOpen() {
    if (openState) {
      openState.close();
    }
  }

  function enhance(select, opts = {}) {
    if (!select || select.dataset.tsel) {
      return select?._tsel;
    }
    const doc = select.ownerDocument;
    const win = doc.defaultView;
    const wrap = h(doc, "div", "tsel");
    if (opts.compact) {
      wrap.dataset.compact = "true";
    }
    if (opts.inline) {
      wrap.dataset.inline = "true";
    }
    const btn = h(doc, "button", "tsel-btn");
    btn.type = "button";
    btn.setAttribute("aria-haspopup", "listbox");
    btn.setAttribute("aria-expanded", "false");
    if (select.getAttribute("aria-label")) {
      btn.setAttribute("aria-label", select.getAttribute("aria-label"));
    }
    const label = doc.querySelector(`label[for="${select.id}"]`);
    if (label) {
      label.addEventListener("click", e => {
        e.preventDefault();
        btn.focus();
      });
    }
    const value = h(doc, "span", "tsel-value");
    btn.append(value, chevron(doc));
    wrap.append(btn);
    select.dataset.tsel = "1";
    select.tabIndex = -1;
    select.setAttribute("aria-hidden", "true");
    select.insertAdjacentElement("afterend", wrap);
    wrap.append(select); // родной select остаётся в форме, но не виден

    const api = {
      wrap,
      btn,
      refresh() {
        const opt = select.options[select.selectedIndex];
        value.textContent = opt ? opt.textContent : "";
        value.dataset.empty = String(!opt);
      },
      open() {
        closeOpen();
        const pop = h(doc, "div", "tsel-pop");
        pop.setAttribute("role", "listbox");
        pop.tabIndex = -1;
        const items = [];
        [...select.options].forEach((opt, i) => {
          const item = h(doc, "button", "tsel-item");
          item.type = "button";
          item.setAttribute("role", "option");
          item.setAttribute("aria-selected", String(i === select.selectedIndex));
          if (opt.disabled) {
            item.disabled = true;
          }
          const text = h(doc, "span", "tsel-item-text", opt.textContent);
          const note = opt.dataset.note ? h(doc, "span", "tsel-item-note", opt.dataset.note) : null;
          item.append(text);
          if (note) {
            item.append(note);
          }
          item.append(check(doc));
          item.addEventListener("click", () => {
            choose(i);
          });
          item.addEventListener("mousemove", () => setActive(i));
          items.push(item);
          pop.append(item);
        });
        let active = Math.max(0, select.selectedIndex);
        const setActive = i => {
          active = Math.max(0, Math.min(items.length - 1, i));
          items.forEach((it, j) => it.toggleAttribute("data-active", j === active));
          items[active]?.scrollIntoView({ block: "nearest" });
        };
        const choose = i => {
          const changed = select.selectedIndex !== i;
          select.selectedIndex = i;
          api.refresh();
          close();
          if (changed) {
            select.dispatchEvent(new win.Event("change", { bubbles: true }));
          }
        };
        const place = () => {
          const r = btn.getBoundingClientRect();
          const vh = win.innerHeight;
          pop.style.minWidth = `${Math.max(r.width, 180)}px`;
          pop.style.left = `${Math.round(r.left)}px`;
          const below = vh - r.bottom - 12;
          const height = Math.min(pop.scrollHeight + 2, 320);
          pop.style.maxHeight = `${Math.min(320, Math.max(below, r.top - 12) )}px`;
          if (below >= height || below >= r.top - 12) {
            pop.style.top = `${Math.round(r.bottom + 6)}px`;
            pop.dataset.side = "bottom";
          } else {
            pop.style.top = `${Math.round(r.top - 6 - Math.min(height, r.top - 12))}px`;
            pop.dataset.side = "top";
          }
          const right = r.left + pop.offsetWidth;
          if (right > win.innerWidth - 12) {
            pop.style.left = `${Math.max(12, win.innerWidth - 12 - pop.offsetWidth)}px`;
          }
        };
        const onKey = e => {
          if (e.key === "ArrowDown") {
            setActive(active + 1);
          } else if (e.key === "ArrowUp") {
            setActive(active - 1);
          } else if (e.key === "Home") {
            setActive(0);
          } else if (e.key === "End") {
            setActive(items.length - 1);
          } else if (e.key === "Enter" || e.key === " ") {
            choose(active);
          } else if (e.key === "Escape" || e.key === "Tab") {
            close();
          } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
            const q = e.key.toLowerCase();
            const idx = items.findIndex((it, j) => j > active && it.textContent.toLowerCase().startsWith(q));
            const first = items.findIndex(it => it.textContent.toLowerCase().startsWith(q));
            setActive(idx !== -1 ? idx : first !== -1 ? first : active);
            return;
          } else {
            return;
          }
          e.preventDefault();
          e.stopPropagation();
        };
        const onDown = e => {
          if (!pop.contains(e.target) && !wrap.contains(e.target)) {
            close();
          }
        };
        const close = () => {
          pop.remove();
          btn.setAttribute("aria-expanded", "false");
          doc.removeEventListener("pointerdown", onDown, true);
          doc.removeEventListener("keydown", onKey, true);
          win.removeEventListener("resize", close);
          doc.removeEventListener("scroll", close, true);
          openState = null;
          btn.focus({ preventScroll: true });
        };
        doc.body.append(pop);
        place();
        setActive(active);
        btn.setAttribute("aria-expanded", "true");
        doc.addEventListener("pointerdown", onDown, true);
        doc.addEventListener("keydown", onKey, true);
        win.addEventListener("resize", close);
        doc.addEventListener("scroll", close, true);
        openState = { pop, wrap, select, close };
        pop.focus({ preventScroll: true });
      },
    };

    btn.addEventListener("click", () => (openState?.select === select ? closeOpen() : api.open()));
    btn.addEventListener("keydown", e => {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        api.open();
      }
    });
    select.addEventListener("change", () => api.refresh());
    new win.MutationObserver(() => api.refresh()).observe(select, { childList: true, subtree: true, characterData: true });
    api.refresh();
    select._tsel = api;
    return api;
  }

  window.TaboraSelect = {
    enhance,
    enhanceAll(root = document, opts) {
      for (const s of root.querySelectorAll("select:not([data-tsel])")) {
        enhance(s, opts);
      }
    },
    close: closeOpen,
  };
})();
