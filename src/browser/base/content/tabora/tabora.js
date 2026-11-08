/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Оболочка Tabora: пространства на контейнерах, спящие вкладки, память,
 * панель агента и перестановка элементов окна под макет. */

"use strict";

var Tabora = {
  SLEEP_AFTER_MS: 15 * 60 * 1000,
  MEMORY_BAR_MAX_MB: 4096,
  HTML_NS: "http://www.w3.org/1999/xhtml",

  spaces: [],
  activeSpaceId: "personal",
  _lazy: {},

  get ContextualIdentityService() {
    if (!this._lazy.cis) {
      this._lazy.cis =
        window.ContextualIdentityService ||
        ChromeUtils.importESModule(
          "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs"
        ).ContextualIdentityService;
    }
    return this._lazy.cis;
  },

  init() {
    if (window.toolbar.visible === false) {
      return;
    }
    this.moveToolboxIntoBrowser();
    for (const step of [
      "buildSidebarExtras", "buildTopbar", "initPrivate", "initTheme", "buildStartPage", "buildAgentPanel", "buildCommandBar", "buildCompose", "buildContextMenu",
      "searchEngineName", "initSpaces", "initKeys", "initTabHooks", "initDownloads", "startTimers", "updateTitle", "localizeUrlbar",
      "routeUrlbarToCommandBar",
    ]) {
      try {
        this[step]();
      } catch (e) {
        console.error(`Tabora: ${step}`, e);
      }
    }
  },

  /* ---- Окно нового письма: живёт в оболочке, видно на любой вкладке ------ */

  mail() {
    if (!this._mail) {
      this._mail = ChromeUtils.importESModule("chrome://browser/content/tabora/mail/MailStore.sys.mjs");
    }
    return this._mail;
  },

  buildCompose() {
    Services.scriptloader.loadSubScript("chrome://browser/content/tabora/select.js", window);
    const h = (tag, attrs, text, children) => this.html(tag, attrs, text, children);
    const iconBtn = (id, title, paths, extra = "") => h("button", { class: `icon-btn ${extra}`.trim(), id, type: "button", title, "aria-label": title }, null, [this.svg(paths, 14, 2.2)]);

    const fromSelect = h("select", { id: "tabora-compose-from", "aria-label": "Отправитель" });
    const toInput = h("input", { id: "tabora-compose-to", type: "text", placeholder: "Адрес, Enter или запятая", autocomplete: "off" });
    const box = h("div", { id: "tabora-compose", hidden: "true", role: "dialog", "aria-label": "Новое письмо", "data-min": "false" }, null, [
      h("div", { class: "head", id: "tabora-compose-head" }, null, [
        h("span", { class: "grip" }),
        h("span", { class: "title", id: "tabora-compose-title" }, "Новое письмо"),
        iconBtn("tabora-compose-min", "Свернуть", ["M5 12h14"]),
        iconBtn("tabora-compose-close", "Закрыть (Esc)", ["M6 6l12 12M18 6 6 18"]),
      ]),
      h("div", { class: "body" }, null, [
        h("div", { class: "field" }, null, [h("label", { for: "tabora-compose-from" }, "От"), fromSelect]),
        h("div", { class: "field" }, null, [
          h("label", { for: "tabora-compose-to" }, "Кому"),
          h("div", { class: "chips", id: "tabora-compose-chips" }, null, [toInput]),
          h("button", { class: "link", id: "tabora-compose-cc-toggle", type: "button" }, "Копия"),
        ]),
        h("div", { class: "field", id: "tabora-compose-cc-field", hidden: "true" }, null, [
          h("label", { for: "tabora-compose-cc" }, "Копия"),
          h("input", { id: "tabora-compose-cc", type: "text", placeholder: "Через запятую" }),
        ]),
        h("div", { class: "field" }, null, [
          h("label", { for: "tabora-compose-subject" }, "Тема"),
          h("input", { id: "tabora-compose-subject", type: "text", placeholder: "О чём письмо" }),
        ]),
        h("textarea", { id: "tabora-compose-text", placeholder: "Текст письма", "aria-label": "Текст письма" }),
        h("div", { class: "attachments", id: "tabora-compose-attachments" }),
      ]),
      h("div", { class: "foot" }, null, [
        h("button", { class: "primary", id: "tabora-compose-send", type: "button" }, null, [document.createTextNode("Отправить"), h("span", { class: "kbd" }, "⌘⏎")]),
        iconBtn("tabora-compose-attach", "Прикрепить файл", ["m21 12-8.5 8.5a5 5 0 0 1-7-7L14 5a3.3 3.3 0 0 1 4.7 4.7L10.5 18a1.7 1.7 0 0 1-2.4-2.4L16 7.7"]),
        h("span", { class: "status", id: "tabora-compose-status" }, "Черновик сохраняется автоматически"),
        iconBtn("tabora-compose-discard", "Удалить черновик", ["M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"], "danger"),
      ]),
      h("div", { class: "resize", id: "tabora-compose-resize", "aria-hidden": "true" }),
    ]);
    document.getElementById("browser").append(box);
    window.TaboraSelect.enhance(fromSelect, { inline: true });
    this.compose = { box, state: null, draftTimer: null };

    const $ = id => document.getElementById(id);
    $("tabora-compose-close").addEventListener("click", () => this.closeCompose());
    $("tabora-compose-discard").addEventListener("click", () => this.closeCompose(true));
    $("tabora-compose-min").addEventListener("click", () => {
      box.dataset.min = box.dataset.min === "true" ? "false" : "true";
      this.keepComposeInWindow();
    });
    $("tabora-compose-send").addEventListener("click", () => this.sendCompose());
    $("tabora-compose-cc-toggle").addEventListener("click", () => {
      $("tabora-compose-cc-field").hidden = false;
      $("tabora-compose-cc").focus();
    });
    toInput.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === "," || (e.key === "Tab" && toInput.value.trim())) {
        e.preventDefault();
        this.addRecipient(toInput.value);
      } else if (e.key === "Backspace" && !toInput.value && this.compose.state?.to.length) {
        this.compose.state.to.pop();
        $("tabora-compose-chips").querySelector(".chip:last-of-type")?.remove();
      }
    });
    toInput.addEventListener("blur", () => toInput.value.trim() && this.addRecipient(toInput.value));
    $("tabora-compose-attach").addEventListener("click", async () => {
      const picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
      picker.init(window.browsingContext, "Прикрепить файлы", Ci.nsIFilePicker.modeOpenMultiple);
      const result = await new Promise(resolve => picker.open(resolve));
      if (result === Ci.nsIFilePicker.returnCancel) {
        return;
      }
      for (const file of picker.files) {
        this.compose.state.attachments.push({ name: file.leafName, size: file.fileSize, path: file.path });
      }
      this.renderComposeAttachments();
    });
    for (const id of ["tabora-compose-subject", "tabora-compose-text"]) {
      $(id).addEventListener("input", () => {
        clearTimeout(this.compose.draftTimer);
        $("tabora-compose-status").textContent = "Сохраняется…";
        this.compose.draftTimer = setTimeout(() => this.saveDraft(), 1200);
      });
    }
    box.addEventListener("keydown", e => {
      if (e.key === "Escape") {
        e.stopPropagation();
        this.closeCompose();
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        this.sendCompose();
      }
    });

    // Перетаскивание за шапку и изменение размера за угол
    const head = $("tabora-compose-head");
    head.addEventListener("pointerdown", e => {
      if (e.button !== 0 || e.target.closest("button")) {
        return;
      }
      const start = { x: e.clientX, y: e.clientY, left: box.offsetLeft, top: box.offsetTop };
      head.setPointerCapture(e.pointerId);
      box.dataset.dragging = "true";
      const move = ev => this.placeCompose(start.left + ev.clientX - start.x, start.top + ev.clientY - start.y);
      const up = () => {
        head.removeEventListener("pointermove", move);
        head.removeEventListener("pointerup", up);
        delete box.dataset.dragging;
        this.saveComposeRect();
      };
      head.addEventListener("pointermove", move);
      head.addEventListener("pointerup", up);
    });
    head.addEventListener("dblclick", e => {
      if (!e.target.closest("button")) {
        $("tabora-compose-min").click();
      }
    });
    const grip = $("tabora-compose-resize");
    grip.addEventListener("pointerdown", e => {
      const start = { x: e.clientX, y: e.clientY, w: box.offsetWidth, h: box.offsetHeight };
      grip.setPointerCapture(e.pointerId);
      const move = ev => {
        box.style.width = `${Math.max(380, Math.min(window.innerWidth - box.offsetLeft - 12, start.w + ev.clientX - start.x))}px`;
        box.style.height = `${Math.max(320, Math.min(window.innerHeight - box.offsetTop - 12, start.h + ev.clientY - start.y))}px`;
      };
      const up = () => {
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
        this.saveComposeRect();
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up);
    });
    window.addEventListener("resize", () => !box.hidden && this.keepComposeInWindow());
  },

  placeCompose(left, top) {
    const box = this.compose.box;
    const maxLeft = window.innerWidth - box.offsetWidth - 8;
    const maxTop = window.innerHeight - box.offsetHeight - 8;
    box.style.left = `${Math.round(Math.max(8, Math.min(maxLeft, left)))}px`;
    box.style.top = `${Math.round(Math.max(8, Math.min(maxTop, top)))}px`;
  },

  keepComposeInWindow() {
    this.placeCompose(this.compose.box.offsetLeft, this.compose.box.offsetTop);
  },

  saveComposeRect() {
    const box = this.compose.box;
    Services.prefs.setStringPref("tabora.mail.compose.rect", JSON.stringify({ left: box.offsetLeft, top: box.offsetTop, width: box.offsetWidth, height: box.offsetHeight }));
  },

  restoreComposeRect() {
    const box = this.compose.box;
    let rect = null;
    try {
      rect = JSON.parse(Services.prefs.getStringPref("tabora.mail.compose.rect", ""));
    } catch (e) {}
    box.style.width = `${rect?.width || 560}px`;
    box.style.height = `${rect?.height || Math.min(640, window.innerHeight - 40)}px`;
    this.placeCompose(rect?.left ?? window.innerWidth - box.offsetWidth - 20, rect?.top ?? window.innerHeight - box.offsetHeight - 20);
  },

  async openCompose(opts = {}) {
    const { MailStore, ACCOUNT } = this.mail();
    await MailStore.ready();
    const $ = id => document.getElementById(id);
    const box = this.compose.box;
    const from = $("tabora-compose-from");
    from.replaceChildren(this.html("option", { value: ACCOUNT.address }, ACCOUNT.address));
    for (const a of MailStore.aliases.filter(a => a.on)) {
      from.append(this.html("option", { value: a.address, "data-note": a.site }, a.address));
    }
    from._tsel?.refresh();
    this.compose.state = { to: [], attachments: [], draftId: null, thread: null, labels: [] };
    $("tabora-compose-chips").querySelectorAll(".chip").forEach(n => n.remove());
    $("tabora-compose-to").value = "";
    $("tabora-compose-cc").value = "";
    $("tabora-compose-cc-field").hidden = true;
    $("tabora-compose-subject").value = "";
    $("tabora-compose-text").value = "";
    $("tabora-compose-attachments").replaceChildren();
    $("tabora-compose-title").textContent = "Новое письмо";
    $("tabora-compose-status").textContent = "Черновик сохраняется автоматически";

    const when = iso => new Date(iso).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
    const text = m => (m.body || []).map(b => b.p || b.h || b.code || "").filter(Boolean).join("\n");
    if (opts.replyTo) {
      const m = MailStore.byId(opts.replyTo);
      if (m) {
        this.addRecipient(m.from.email);
        $("tabora-compose-subject").value = m.subject.startsWith("Re:") ? m.subject : `Re: ${m.subject}`;
        $("tabora-compose-text").value = `\n\n${when(m.date)}, ${m.from.name} <${m.from.email}>:\n> ${text(m).split("\n")[0]}`;
        $("tabora-compose-title").textContent = `Ответ: ${m.from.name}`;
        this.compose.state.thread = m.thread;
        this.compose.state.labels = m.labels;
        if (m.alias && [...from.options].some(o => o.value === m.alias)) {
          from.value = m.alias;
          from._tsel?.refresh();
        }
      }
    } else if (opts.forwardOf) {
      const m = MailStore.byId(opts.forwardOf);
      if (m) {
        $("tabora-compose-subject").value = `Fwd: ${m.subject}`;
        $("tabora-compose-text").value = `\n\n---------- Пересланное письмо ----------\nОт: ${m.from.name} <${m.from.email}>\nДата: ${when(m.date)}\nТема: ${m.subject}\n\n${text(m)}`;
        $("tabora-compose-title").textContent = "Переслать";
        this.compose.state.attachments = (m.attachments || []).map(a => ({ ...a }));
      }
    } else if (opts.draftId) {
      const m = MailStore.byId(opts.draftId);
      if (m) {
        m.to.forEach(t => this.addRecipient(t));
        $("tabora-compose-subject").value = m.subject;
        $("tabora-compose-text").value = (m.body || []).map(b => b.p).join("\n\n");
        this.compose.state.draftId = m.id;
        this.compose.state.attachments = (m.attachments || []).map(a => ({ ...a }));
        $("tabora-compose-title").textContent = "Черновик";
      }
    } else if (opts.to) {
      this.addRecipient(opts.to);
    }
    this.renderComposeAttachments();
    box.hidden = false;
    box.dataset.min = "false";
    this.restoreComposeRect();
    setTimeout(() => (this.compose.state.to.length ? $("tabora-compose-subject") : $("tabora-compose-to")).focus(), 30);
  },

  composeHasContent() {
    const s = this.compose.state;
    return !!(s && (s.to.length || document.getElementById("tabora-compose-subject").value.trim() || document.getElementById("tabora-compose-text").value.trim() || s.attachments.length));
  },

  closeCompose(discard = false) {
    const { MailStore } = this.mail();
    const box = this.compose.box;
    if (this.compose.state) {
      clearTimeout(this.compose.draftTimer);
      const hasContent = this.composeHasContent();
      if (discard || !hasContent) {
        if (this.compose.state.draftId) {
          MailStore.remove(this.compose.state.draftId);
        }
        if (discard && hasContent) {
          this.notice("Черновик удалён");
        }
      } else {
        this.saveDraft();
        this.notice("Черновик сохранён в почте");
      }
    }
    box.hidden = true;
    this.compose.state = null;
    gBrowser.selectedBrowser?.focus();
  },

  composeDraft() {
    const s = this.compose.state;
    const $ = id => document.getElementById(id);
    const text = $("tabora-compose-text").value;
    return {
      id: s.draftId || `d${Date.now()}`, thread: s.thread || `td${Date.now()}`, folder: "drafts", unread: false, starred: false,
      labels: s.labels || [], from: { name: "Я", email: $("tabora-compose-from").value }, to: s.to.slice(), alias: $("tabora-compose-from").value,
      date: new Date().toISOString(), subject: $("tabora-compose-subject").value.trim(), body: text.split(/\n{2,}/).filter(Boolean).map(p => ({ p })),
      attachments: s.attachments.slice(), draft: true,
    };
  },

  saveDraft() {
    const { MailStore } = this.mail();
    if (!this.compose.state || !this.composeHasContent()) {
      return;
    }
    const draft = this.composeDraft();
    if (this.compose.state.draftId) {
      MailStore.update(draft.id, draft);
    } else {
      MailStore.add(draft);
      this.compose.state.draftId = draft.id;
    }
    document.getElementById("tabora-compose-status").textContent = `Черновик сохранён в ${new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`;
  },

  addRecipient(raw) {
    const value = raw.trim().replace(/,$/, "");
    if (!value || !this.compose.state) {
      return;
    }
    const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    this.compose.state.to.push(value);
    const chip = this.html("span", { class: "chip", "data-bad": String(!ok), title: ok ? value : "Похоже, адрес с ошибкой" }, null, [
      document.createTextNode(value),
      this.html("button", { type: "button", "aria-label": `Убрать ${value}` }, null, [this.svg(["M6 6l12 12M18 6 6 18"], 11, 2.4)]),
    ]);
    chip.lastChild.addEventListener("click", () => {
      this.compose.state.to = this.compose.state.to.filter(v => v !== value);
      chip.remove();
    });
    const input = document.getElementById("tabora-compose-to");
    input.before(chip);
    input.value = "";
  },

  renderComposeAttachments() {
    const box = document.getElementById("tabora-compose-attachments");
    box.replaceChildren();
    const size = b => (b >= 1_000_000 ? `${(b / 1_000_000).toFixed(1).replace(".", ",")} МБ` : `${Math.max(1, Math.round(b / 1000))} КБ`);
    for (const a of this.compose.state?.attachments || []) {
      const remove = this.html("button", { type: "button", "aria-label": `Убрать ${a.name}` }, null, [this.svg(["M6 6l12 12M18 6 6 18"], 12, 2.4)]);
      remove.addEventListener("click", () => {
        this.compose.state.attachments = this.compose.state.attachments.filter(x => x !== a);
        this.renderComposeAttachments();
      });
      box.append(this.html("span", { class: "attachment" }, null, [
        this.html("span", { class: "ext" }, a.name.split(".").pop().slice(0, 4)),
        this.html("span", { class: "info" }, null, [this.html("span", { class: "name" }, a.name), this.html("span", { class: "size" }, size(a.size))]),
        remove,
      ]));
    }
  },

  sendCompose() {
    const { MailStore } = this.mail();
    const s = this.compose.state;
    if (!s) {
      return;
    }
    const $ = id => document.getElementById(id);
    const pending = $("tabora-compose-to").value.trim();
    if (pending) {
      this.addRecipient(pending);
    }
    if (!s.to.length) {
      $("tabora-compose-to").focus();
      this.notice("Укажите получателя");
      return;
    }
    const bad = s.to.find(v => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v));
    if (bad) {
      this.notice(`Проверьте адрес: ${bad}`);
      return;
    }
    clearTimeout(this.compose.draftTimer);
    const message = { ...this.composeDraft(), id: `s${Date.now()}`, thread: s.thread || `ts${Date.now()}`, folder: "sent", draft: false };
    message.subject ||= "(без темы)";
    if (s.draftId) {
      MailStore.remove(s.draftId);
    }
    MailStore.add(message);
    this.compose.box.hidden = true;
    this.compose.state = null;
    this.notice(`Отправлено: ${message.to.join(", ")}`);
  },

  /** Короткое уведомление оболочки внизу окна. */
  notice(text) {
    let box = document.getElementById("tabora-notices");
    if (!box) {
      box = this.html("div", { id: "tabora-notices", "aria-live": "polite" });
      document.getElementById("browser").append(box);
    }
    const node = this.html("div", { class: "notice" }, text);
    box.append(node);
    while (box.children.length > 3) {
      box.firstChild.remove();
    }
    setTimeout(() => node.remove(), 3200);
  },

  /* ---- Контекстные меню Tabora: своё меню вместо системного ---------------- */

  buildContextMenu() {
    const menu = this.html("div", { id: "tabora-menu", role: "menu", hidden: "true" });
    const sub = this.html("div", { id: "tabora-submenu", role: "menu", hidden: "true" });
    document.getElementById("browser").append(menu, sub);
    this.menu = { el: menu, sub, items: [], active: -1, closers: [] };

    const close = e => {
      if (menu.hidden) {
        return;
      }
      if (e && e.type === "pointerdown" && (menu.contains(e.target) || sub.contains(e.target))) {
        return;
      }
      this.hideMenu();
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    gBrowser.tabContainer.addEventListener("TabSelect", () => this.hideMenu());
    window.addEventListener(
      "keydown",
      e => {
        if (menu.hidden) {
          return;
        }
        const keys = ["Escape", "ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Enter", " ", "Home", "End"];
        if (!keys.includes(e.key)) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Escape") {
          this.hideMenu();
        } else if (e.key === "ArrowDown") {
          this.menuMove(1);
        } else if (e.key === "ArrowUp") {
          this.menuMove(-1);
        } else if (e.key === "Home") {
          this.menuMove(-Infinity);
        } else if (e.key === "End") {
          this.menuMove(Infinity);
        } else if (e.key === "ArrowRight") {
          const item = this.menu.items[this.menu.active];
          if (item?.children) {
            this.openSubmenu(item, this.menu.active, true);
          }
        } else if (e.key === "ArrowLeft") {
          this.closeSubmenu();
        } else {
          const node = (this.menu.subActive >= 0 ? sub : menu).querySelector("[data-active]");
          node?.click();
        }
      },
      true
    );

    // Правый клик по вкладке или по пустому месту списка вкладок
    gBrowser.tabContainer.addEventListener(
      "contextmenu",
      e => {
        const tab = e.target.closest?.("tab.tabbrowser-tab");
        e.preventDefault();
        e.stopPropagation();
        this.showMenu(tab ? this.tabMenuItems(tab) : this.tabListMenuItems(), e.clientX, e.clientY);
      },
      true
    );
  },

  /** items: { label, hint, icon, danger, disabled, checked, children, run } | { separator: true } */
  showMenu(items, x, y) {
    const menu = this.menu.el;
    this.closeSubmenu();
    menu.replaceChildren();
    this.menu.items = items;
    this.menu.active = -1;
    this.menu.subActive = -1;
    items.forEach((item, i) => menu.append(this.menuNode(item, i, false)));
    menu.hidden = false;
    this.placeMenu(menu, x, y);
  },

  menuNode(item, index, inSub) {
    if (item.separator) {
      return this.html("div", { class: "sep", role: "separator" });
    }
    if (item.header) {
      return this.html("div", { class: "header" }, item.header);
    }
    const node = this.html("button", { class: `item${item.danger ? " danger" : ""}`, role: "menuitem", type: "button", "data-index": String(index) }, null, [
      this.html("span", { class: "icon" }, null, item.icon ? [this.svg(item.icon, 15, 1.9)] : item.checked ? [this.svg(["m5 12 5 5L20 7"], 15, 2.4)] : []),
      this.html("span", { class: "label" }, item.label),
      item.hint ? this.html("span", { class: "hint" }, item.hint) : item.children ? this.html("span", { class: "chevron" }, null, [this.svg(["m9 6 6 6-6 6"], 13, 2.2)]) : this.html("span", { class: "hint" }),
    ]);
    if (item.disabled) {
      node.setAttribute("disabled", "true");
    }
    node.addEventListener("mouseenter", () => {
      if (inSub) {
        this.menuSetActive(index, true);
      } else {
        this.menuSetActive(index, false);
        if (item.children) {
          this.openSubmenu(item, index, false);
        } else {
          this.closeSubmenu();
        }
      }
    });
    node.addEventListener("click", e => {
      e.stopPropagation();
      if (item.disabled) {
        return;
      }
      if (item.children) {
        this.openSubmenu(item, index, true);
        return;
      }
      this.hideMenu();
      try {
        item.run?.();
      } catch (err) {
        console.error("Tabora menu", err);
      }
    });
    return node;
  },

  placeMenu(el, x, y) {
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.min(x, window.innerWidth - w - 8);
    const top = y + h > window.innerHeight - 8 ? Math.max(8, y - h) : y;
    el.style.left = `${Math.max(8, left)}px`;
    el.style.top = `${Math.max(8, top)}px`;
  },

  menuSetActive(index, inSub) {
    const el = inSub ? this.menu.sub : this.menu.el;
    for (const n of el.querySelectorAll(".item")) {
      n.toggleAttribute("data-active", Number(n.dataset.index) === index);
    }
    if (inSub) {
      this.menu.subActive = index;
    } else {
      this.menu.active = index;
      for (const n of this.menu.sub.querySelectorAll(".item")) {
        n.removeAttribute("data-active");
      }
      this.menu.subActive = -1;
    }
  },

  menuMove(delta) {
    const inSub = this.menu.subActive >= 0 || (!this.menu.sub.hidden && this.menu.subActive === -1 && delta > 0 && false);
    const list = inSub ? this.menu.subItems : this.menu.items;
    const current = inSub ? this.menu.subActive : this.menu.active;
    const selectable = list.map((it, i) => (!it.separator && !it.header && !it.disabled ? i : -1)).filter(i => i >= 0);
    if (!selectable.length) {
      return;
    }
    let next;
    if (delta === Infinity) {
      next = selectable.at(-1);
    } else if (delta === -Infinity) {
      next = selectable[0];
    } else {
      const pos = selectable.indexOf(current);
      next = selectable[(pos + delta + selectable.length) % selectable.length];
      if (pos === -1) {
        next = delta > 0 ? selectable[0] : selectable.at(-1);
      }
    }
    this.menuSetActive(next, inSub);
  },

  openSubmenu(item, index, focusFirst) {
    const sub = this.menu.sub;
    sub.replaceChildren();
    this.menu.subItems = item.children;
    item.children.forEach((child, i) => sub.append(this.menuNode(child, i, true)));
    sub.hidden = false;
    const parent = this.menu.el.querySelector(`.item[data-index="${index}"]`);
    const r = parent.getBoundingClientRect();
    const w = sub.offsetWidth;
    const left = r.right + 4 + w > window.innerWidth - 8 ? r.left - w - 4 : r.right + 4;
    const top = Math.min(r.top - 6, window.innerHeight - sub.offsetHeight - 8);
    sub.style.left = `${Math.max(8, left)}px`;
    sub.style.top = `${Math.max(8, top)}px`;
    this.menu.subActive = -1;
    if (focusFirst) {
      this.menuMove(1);
      this.menuSetActive(this.menu.subItems.findIndex(it => !it.separator && !it.disabled), true);
    }
  },

  closeSubmenu() {
    this.menu.sub.hidden = true;
    this.menu.sub.replaceChildren();
    this.menu.subItems = [];
    this.menu.subActive = -1;
  },

  hideMenu() {
    if (!this.menu || this.menu.el.hidden) {
      return;
    }
    this.closeSubmenu();
    this.menu.el.hidden = true;
    this.menu.el.replaceChildren();
    this.menu.items = [];
  },

  /* ---- Меню вкладки ---- */

  tabMenuItems(tab) {
    const I = {
      pin: ["M12 17v5", "M8 3h8l-1 7 3 3H6l3-3z"],
      unpin: ["M12 17v5", "M8 3h8l-1 7 3 3H6l3-3z", "M4 4l16 16"],
      sleep: ["M21 13a8 8 0 1 1-10-10 6 6 0 0 0 10 10z"],
      wake: ["M12 3v2M12 19v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M3 12h2M19 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4", "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"],
      copy: ["M8 8h12v12H8z", "M4 16V4h12"],
      reload: ["M20 12a8 8 0 1 1-2.3-5.7", "M20 4v5h-5"],
      duplicate: ["M7 7h12v12H7z", "M3 17V3h14"],
      mute: ["M11 5 6 9H2v6h4l5 4z", "M16 9l5 6M21 9l-5 6"],
      unmute: ["M11 5 6 9H2v6h4l5 4z", "M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"],
      move: ["M4 8h11l-3-3M20 16H9l3 3"],
      star: ["m12 3 2.8 5.9 6.4.9-4.6 4.5 1.1 6.4L12 17.7l-5.7 3 1.1-6.4L2.8 9.8l6.4-.9z"],
      close: ["M6 6l12 12M18 6 6 18"],
      closeOthers: ["M4 6h10M4 12h16M4 18h10"],
      closeBelow: ["M4 6h16M4 12h16", "m9 17 3 3 3-3"],
      restore: ["M4 12a8 8 0 1 0 2.3-5.7", "M4 4v5h5"],
      newTab: ["M12 5v14M5 12h14"],
    };
    const url = tab.linkedBrowser?.currentURI?.spec || "";
    const pending = tab.hasAttribute("pending");
    const audible = tab.hasAttribute("soundplaying") || tab.hasAttribute("muted");
    const muted = tab.hasAttribute("muted");
    const others = gBrowser.visibleTabs.filter(t => t !== tab && !t.pinned);
    const below = gBrowser.visibleTabs.slice(gBrowser.visibleTabs.indexOf(tab) + 1).filter(t => !t.pinned);
    const realUrl = /^https?:/.test(url);
    const spaces = this.spaces.filter(s => s.userContextId !== this.contextOf(tab));
    const items = [
      tab.pinned
        ? { label: "Открепить", icon: I.unpin, run: () => gBrowser.unpinTab(tab) }
        : { label: "Закрепить", hint: "в карточки", icon: I.pin, run: () => gBrowser.pinTab(tab) },
      pending
        ? { label: "Разбудить", icon: I.wake, run: () => (gBrowser.selectedTab = tab) }
        : { label: "Усыпить вкладку", hint: "освободить память", icon: I.sleep, disabled: tab.selected || !realUrl, run: () => { gBrowser.discardBrowser(tab); this.updateMemory(); } },
      { label: "Дублировать", icon: I.duplicate, disabled: !url || this.isStartUrl(url), run: () => gBrowser.duplicateTab(tab) },
      { label: "Обновить", icon: I.reload, hint: "⌘R", disabled: this.isStartUrl(url), run: () => gBrowser.reloadTab(tab) },
      audible ? { label: muted ? "Включить звук" : "Выключить звук", icon: muted ? I.unmute : I.mute, run: () => tab.toggleMuteAudio() } : null,
      { separator: true },
      spaces.length && !tab.pinned
        ? {
            label: "Переместить в пространство",
            icon: I.move,
            children: spaces.map(s => ({ label: s.name, run: () => this.moveTabToSpace(tab, s) })),
          }
        : null,
      { label: "Копировать адрес", icon: I.copy, disabled: !realUrl, run: () => this.copyText(url, "Адрес скопирован") },
      { label: "В закладки", icon: I.star, hint: "⌘D", disabled: !realUrl, run: () => { gBrowser.selectedTab = tab; PlacesCommandHook.bookmarkPage(); } },
      { separator: true },
      { label: "Закрыть", icon: I.close, hint: "⌘W", danger: true, run: () => gBrowser.removeTab(tab, { animate: true }) },
      { label: `Закрыть остальные${others.length ? ` (${others.length})` : ""}`, icon: I.closeOthers, disabled: !others.length, danger: true, run: () => gBrowser.removeAllTabsBut(tab) },
      { label: `Закрыть ниже${below.length ? ` (${below.length})` : ""}`, icon: I.closeBelow, disabled: !below.length, danger: true, run: () => gBrowser.removeTabsToTheEndFrom(tab) },
      { separator: true },
      { label: "Восстановить закрытую", icon: I.restore, hint: "⌘⇧T", disabled: !this.canUndoClose(), run: () => this.undoCloseTab() },
    ];
    return items.filter(Boolean);
  },

  tabListMenuItems() {
    const sleeping = gBrowser.tabs.filter(t => !t.selected && !t.pinned && !t.hasAttribute("pending") && /^https?:/.test(t.linkedBrowser?.currentURI?.spec || ""));
    return [
      { label: "Новая вкладка", icon: ["M12 5v14M5 12h14"], hint: "⌘T", run: () => BrowserCommands.openTab() },
      { label: "Усыпить все кроме текущей", icon: ["M21 13a8 8 0 1 1-10-10 6 6 0 0 0 10 10z"], disabled: !sleeping.length, run: () => { sleeping.forEach(t => gBrowser.discardBrowser(t)); this.updateMemory(); } },
      { separator: true },
      { label: "Восстановить закрытую", icon: ["M4 12a8 8 0 1 0 2.3-5.7", "M4 4v5h5"], hint: "⌘⇧T", disabled: !this.canUndoClose(), run: () => this.undoCloseTab() },
    ];
  },

  canUndoClose() {
    try {
      return SessionStore.getClosedTabCountForWindow(window) > 0;
    } catch (e) {
      return true;
    }
  },

  undoCloseTab() {
    const { SessionWindowUI } = ChromeUtils.importESModule("resource:///modules/sessionstore/SessionWindowUI.sys.mjs");
    SessionWindowUI.undoCloseTab(window);
  },

  /** Контейнер вкладки менять нельзя: открываем ту же страницу в другом пространстве и закрываем старую. */
  moveTabToSpace(tab, space) {
    const url = tab.linkedBrowser?.currentURI?.spec || "about:blank";
    const fresh = gBrowser.addTab(url, {
      userContextId: space.userContextId,
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      index: tab._tPos + 1,
    });
    gBrowser.removeTab(tab);
    this.switchSpace(space.id);
    gBrowser.selectedTab = fresh;
    this.notice(`Перенесено в «${space.name}»`);
  },

  copyText(text, message) {
    Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(text);
    if (message) {
      this.notice(message);
    }
  },

  /** Тема оболочки следует выбору «Тема браузера» в настройках Firefox:
   *  browser.theme.toolbar-theme 0 — тёмная, 1 — светлая, 2 — как в системе. */
  initTheme() {
    // Одна настройка на весь браузер: выбор схемы в «Настройки → Внешний вид»
    // (0 тёмная, 1 светлая, 2 как в системе) красит и сайты, и оболочку.
    const PREF = "layout.css.prefers-color-scheme.content-override";
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const apply = () => {
      const pref = Services.prefs.getIntPref(PREF, 2);
      const light = pref === 1 || (pref === 2 && media.matches);
      document.documentElement.setAttribute("tabora-theme", light && !this.isPrivate ? "light" : "dark");
    };
    apply();
    Services.prefs.addObserver(PREF, apply);
    media.addEventListener("change", apply);
    window.addEventListener("unload", () => Services.prefs.removeObserver(PREF, apply));
  },

  /** Приватное окно: фиолетовый акцент, метка в шапке, без пространств (контейнеры там не работают). */
  initPrivate() {
    const { PrivateBrowsingUtils } = ChromeUtils.importESModule("resource://gre/modules/PrivateBrowsingUtils.sys.mjs");
    this.isPrivate = PrivateBrowsingUtils.isWindowPrivate(window);
    if (!this.isPrivate) {
      return;
    }
    document.documentElement.setAttribute("tabora-private", "true");
    const chip = this.html("span", { class: "chip private", id: "tabora-private-chip", title: "История, cookies и поиск не сохраняются" }, null, [
      this.svg(["M4 10c0-2.8 2.2-5 5-5h6c2.8 0 5 2.2 5 5v1.5c0 2.5-2 4.5-4.5 4.5-1.4 0-2.6-.6-3.5-1.6-.9 1-2.1 1.6-3.5 1.6C6 16 4 14 4 11.5z"], 13, 2),
      this.html("span", {}, "Приватное окно"),
    ]);
    const bar = document.getElementById("tabora-topbar");
    bar.insertBefore(chip, document.getElementById("tabora-blocked"));
  },

  localizeUrlbar() {
    const apply = () => {
      const field = gURLBar?.inputField;
      if (field && field.getAttribute("placeholder") !== "Адрес или поиск") {
        field.setAttribute("placeholder", "Адрес или поиск");
      }
    };
    apply();
    gBrowser.tabContainer.addEventListener("TabSelect", apply);
    gURLBar.inputField.addEventListener("blur", apply);
    // Firefox переписывает подпись после инициализации поиска: возвращаем свою.
    new MutationObserver(apply).observe(gURLBar.inputField, { attributes: true, attributeFilter: ["placeholder"] });
  },

  html(tag, attrs = {}, text, children = []) {
    const el = document.createElementNS(this.HTML_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      el.setAttribute(k, v);
    }
    if (text !== undefined && text !== null) {
      el.textContent = text;
    }
    el.append(...children);
    return el;
  },

  svg(paths, size = 16, stroke = 2) {
    const NS = "http://www.w3.org/2000/svg";
    const el = document.createElementNS(NS, "svg");
    for (const [k, v] of Object.entries({
      width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
      "stroke-width": stroke, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true",
    })) {
      el.setAttribute(k, v);
    }
    for (const d of paths) {
      const path = document.createElementNS(NS, "path");
      path.setAttribute("d", d);
      el.append(path);
    }
    return el;
  },

  /* ---- Раскладка ------------------------------------------------------- */

  moveToolboxIntoBrowser() {
    // Кнопка «обновить» в Firefox 159 не стоит в панели по умолчанию: ставим её после «вперёд»
    try {
      if (!CustomizableUI.getPlacementOfWidget("stop-reload-button")) {
        CustomizableUI.addWidgetToArea("stop-reload-button", CustomizableUI.AREA_NAVBAR, 2);
      }
    } catch (e) {
      console.error("Tabora: reload button", e);
    }
    const browser = document.getElementById("browser");
    const toolbox = document.getElementById("navigator-toolbox");
    const sidebar = document.getElementById("sidebar-container");
    if (!browser || !toolbox) {
      return;
    }
    browser.prepend(toolbox);
    if (sidebar) {
      sidebar.removeAttribute("hidden");
      toolbox.append(sidebar);
    }
  },

  buildSidebarExtras() {
    const toolbox = document.getElementById("navigator-toolbox");
    const navBar = document.getElementById("nav-bar");
    const sidebar = document.getElementById("sidebar-container");

    const spaces = this.html("div", { id: "tabora-spaces", role: "tablist" });
    navBar.after(spaces);

    const verticalTabs = document.getElementById("vertical-tabs");
    if (verticalTabs) {
      const head = this.html("div", { id: "tabora-tabs-head" });
      head.append(this.html("span", {}, "Сегодня"));
      const newTab = document.getElementById("vertical-tabs-newtab-button");
      if (newTab) {
        newTab.setAttribute("tooltiptext", "Новая вкладка (⌘T)");
        head.append(newTab);
      }
      // Заголовок стоит после плиток закреплённых вкладок, перед прокручиваемым списком
      const scrollbox = document.getElementById("tabbrowser-arrowscrollbox");
      if (scrollbox?.parentNode?.id === "tabbrowser-tabs") {
        scrollbox.before(head);
      } else {
        verticalTabs.prepend(head);
      }
    }

    const memory = this.html("div", { id: "tabora-memory" }, null, [
      this.html("div", { class: "row" }, null, [
        this.html("span", { class: "label" }, "Память"),
        this.html("span", { class: "value", id: "tabora-memory-value" }, "…"),
      ]),
      this.html("div", { class: "bar", "aria-hidden": "true" }, null, [
        this.html("div", { id: "tabora-memory-bar" }),
      ]),
      this.html("span", { class: "note", id: "tabora-memory-note" }),
    ]);
    const mail = this.html("button", { id: "tabora-mail", title: "Почта и алиасы (⌘⇧M)" }, null, [
      this.svg(["M3.5 6.5h17v11h-17z", "M3.5 7l8.5 6 8.5-6"], 16, 1.8),
      this.html("span", {}, "Почта и алиасы"),
      this.html("span", { class: "kbd" }, "⌘⇧M"),
    ]);
    mail.addEventListener("click", () => this.openMail());
    const downloads = this.buildDownloadsCard();
    if (sidebar) {
      sidebar.after(memory, mail, downloads);
    } else {
      toolbox.append(memory, mail, downloads);
    }
  },

  /* ---- Карточка загрузок под почтой: кнопка и живой прогресс ------------- */

  buildDownloadsCard() {
    const h = (tag, attrs, text, children) => this.html(tag, attrs, text, children);
    const head = h("button", { class: "head", id: "tabora-downloads-open", title: "Загрузки (⌘⇧J)" }, null, [
      this.svg(["M12 4v11", "M7 10l5 5 5-5", "M4 19h16"], 16, 1.8),
      h("span", { class: "title" }, "Загрузки"),
      h("span", { class: "pill", id: "tabora-downloads-pill", hidden: "true" }),
      h("span", { class: "kbd" }, "⌘⇧J"),
    ]);
    head.addEventListener("click", () => this.openDownloads());
    const toggle = h("button", { class: "icon-btn", id: "tabora-downloads-toggle", type: "button", title: "Пауза" }, null, [this.svg(["M8 5v14", "M16 5v14"], 13, 2.2)]);
    const cancel = h("button", { class: "icon-btn", id: "tabora-downloads-cancel", type: "button", title: "Отменить" }, null, [this.svg(["M6 6l12 12", "M18 6 6 18"], 13, 2.2)]);
    toggle.addEventListener("click", e => { e.stopPropagation(); this.downloadsToggle(); });
    cancel.addEventListener("click", e => { e.stopPropagation(); this.downloadsCancel(); });
    const live = h("div", { class: "live", id: "tabora-downloads-live", hidden: "true" }, null, [
      h("div", { class: "row" }, null, [
        h("span", { class: "name", id: "tabora-downloads-name" }),
        h("span", { class: "pct", id: "tabora-downloads-pct" }),
      ]),
      h("div", { class: "bar", "aria-hidden": "true" }, null, [h("div", { id: "tabora-downloads-bar" })]),
      h("div", { class: "row" }, null, [
        h("span", { class: "note", id: "tabora-downloads-note" }),
        h("span", { class: "ctl" }, null, [toggle, cancel]),
      ]),
    ]);
    const card = h("div", { id: "tabora-downloads" }, null, [head, live]);
    card.addEventListener("dragover", e => { if (e.dataTransfer.types.includes("text/uri-list") || e.dataTransfer.types.includes("text/plain")) { e.preventDefault(); card.toggleAttribute("drop", true); } });
    card.addEventListener("dragleave", () => card.removeAttribute("drop"));
    card.addEventListener("drop", e => { e.preventDefault(); card.removeAttribute("drop"); this.downloadFromDrop(e.dataTransfer); });
    return card;
  },

  async initDownloads() {
    // Все пути к «Библиотеке → Загрузки» ведут на нашу страницу
    const self = this;
    BrowserCommands.downloadsUI = () => self.openDownloads();
    const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
    this._dl = { list: await Downloads.getList(Downloads.ALL), items: new Set(), timer: null };
    const refresh = () => this.updateDownloadsCard();
    await this._dl.list.addView({
      onDownloadAdded: d => { this._dl.items.add(d); refresh(); },
      onDownloadChanged: d => { this.downloadFinished(d); refresh(); },
      onDownloadRemoved: d => { this._dl.items.delete(d); refresh(); },
    });
  },

  downloadFinished(d) {
    if (d.succeeded && !d._taboraNoticed) {
      d._taboraNoticed = true;
      if (this._dl.seenStart && d.startTime >= this._dl.seenStart) {
        this.notice(`Скачано: ${PathUtils.filename(d.target.path)}`);
      }
    }
  },

  activeDownloads() {
    return [...this._dl.items].filter(d => !d.stopped || (d.canceled && d.hasPartialData && !d.error));
  },

  updateDownloadsCard() {
    const card = document.getElementById("tabora-downloads");
    if (!card || !this._dl) {
      return;
    }
    this._dl.seenStart ??= new Date();
    const running = [...this._dl.items].filter(d => !d.stopped);
    const paused = [...this._dl.items].filter(d => d.stopped && d.canceled && d.hasPartialData && !d.error);
    const live = document.getElementById("tabora-downloads-live");
    const pill = document.getElementById("tabora-downloads-pill");
    const all = [...running, ...paused];
    pill.hidden = !all.length;
    pill.textContent = String(all.length);
    card.toggleAttribute("active", !!running.length);
    card.toggleAttribute("paused", !running.length && !!paused.length);
    live.hidden = !all.length;
    if (!all.length) {
      clearInterval(this._dl.timer);
      this._dl.timer = null;
      return;
    }
    if (!this._dl.timer) {
      this._dl.timer = setInterval(() => this.updateDownloadsCard(), 1000);
    }
    const cur = running[0] || paused[0];
    const total = all.reduce((n, d) => n + (d.totalBytes > 0 ? d.totalBytes : d.currentBytes), 0);
    const done = all.reduce((n, d) => n + d.currentBytes, 0);
    const speed = running.reduce((n, d) => n + (d.speed || 0), 0);
    const fmt = this.fmtBytes;
    document.getElementById("tabora-downloads-name").textContent = all.length > 1 ? `${PathUtils.filename(cur.target.path)} и ещё ${all.length - 1}` : PathUtils.filename(cur.target.path);
    const pctEl = document.getElementById("tabora-downloads-pct");
    const bar = document.getElementById("tabora-downloads-bar");
    const known = all.every(d => d.hasProgress && d.totalBytes > 0);
    const pct = known && total ? Math.round((done / total) * 100) : null;
    pctEl.textContent = pct === null ? "" : `${pct}%`;
    bar.style.width = `${pct ?? 100}%`;
    bar.classList.toggle("indeterminate", pct === null && !!running.length);
    const parts = [];
    const bytes = total ? `${fmt(done)} из ${fmt(total)}` : fmt(done);
    if (running.length) {
      if (speed > 0) {
        parts.push(`${fmt(speed)}/с`);
        if (known && total > done) {
          parts.push(this.fmtEta((total - done) / speed));
        }
      } else {
        parts.push(bytes);
      }
    } else {
      parts.push("на паузе", bytes);
    }
    const note = document.getElementById("tabora-downloads-note");
    note.textContent = parts.join(" · ");
    note.title = bytes;
    const toggle = document.getElementById("tabora-downloads-toggle");
    const pausedMode = !running.length;
    toggle.title = pausedMode ? "Продолжить" : "Пауза";
    toggle.replaceChildren(pausedMode ? this.svg(["M7 5v14l12-7z"], 13, 2.2) : this.svg(["M8 5v14", "M16 5v14"], 13, 2.2));
  },

  downloadsToggle() {
    const running = [...this._dl.items].filter(d => !d.stopped);
    if (running.length) {
      running.forEach(d => d.cancel());
    } else {
      [...this._dl.items].filter(d => d.stopped && d.canceled && d.hasPartialData && !d.error).forEach(d => d.start());
    }
  },

  downloadsCancel() {
    for (const d of this.activeDownloads()) {
      d.cancel().then(() => d.removePartialData()).then(() => this._dl.list.remove(d)).catch(() => {});
    }
  },

  async downloadFromDrop(dt) {
    const url = (dt.getData("text/uri-list") || dt.getData("text/plain") || "").split("\n")[0].trim();
    if (!/^https?:\/\//i.test(url)) {
      return;
    }
    const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
    const dir = await Downloads.getPreferredDownloadsDirectory();
    const name = decodeURIComponent(url.split("/").pop().split(/[?#]/)[0]) || "файл";
    const download = await Downloads.createDownload({ source: url, target: PathUtils.join(dir, name) });
    await this._dl.list.add(download);
    download.start().catch(() => {});
  },

  fmtBytes(b) {
    if (!(b > 0)) {
      return "0 Б";
    }
    const u = ["Б", "КБ", "МБ", "ГБ"];
    let i = 0;
    while (b >= 1000 && i < u.length - 1) {
      b /= 1000;
      i++;
    }
    return `${i ? b.toFixed(b < 10 ? 1 : 0).replace(".", ",") : Math.round(b)} ${u[i]}`;
  },

  fmtEta(sec) {
    if (!isFinite(sec) || sec < 1) {
      return "";
    }
    if (sec < 60) {
      return `ещё ${Math.ceil(sec)} с`;
    }
    if (sec < 3600) {
      return `ещё ${Math.ceil(sec / 60)} мин`;
    }
    return `ещё ${Math.floor(sec / 3600)} ч ${Math.ceil((sec % 3600) / 60)} мин`;
  },

  buildTopbar() {
    const tabbox = document.getElementById("tabbrowser-tabbox");
    const reader = this.html("button", { class: "icon-btn", id: "tabora-reader", title: "Режим чтения", "aria-label": "Режим чтения", disabled: "true" }, null, [
      this.svg(["M6 3h9l5 5v13H6z", "M14 3v6h6", "M9 13h7M9 17h7"], 16, 1.8),
    ]);
    const toggle = this.html("button", { id: "tabora-agent-toggle", "aria-pressed": "false", title: "Панель агента (⌘J)" }, null, [
      this.html("span", { class: "dot" }),
      document.createTextNode("Агент"),
      this.html("span", { class: "kbd" }, "⌘J"),
    ]);
    const bar = this.html("div", { id: "tabora-topbar" }, null, [
      this.html("span", { class: "title", id: "tabora-title" }),
      this.html("span", { class: "chip", id: "tabora-blocked", hidden: "true" }, null, [
        this.svg(["M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"], 13, 2),
        this.html("span", { id: "tabora-blocked-text" }),
      ]),
      reader,
      toggle,
    ]);
    tabbox.prepend(bar);
    reader.addEventListener("click", () => {
      const btn = document.getElementById("reader-mode-button");
      if (btn && !btn.hidden) {
        btn.click();
      }
    });
    toggle.addEventListener("click", () => this.toggleAgent());
  },

  /* ---- Стартовая страница поверх пустой вкладки ------------------------- */

  START_URLS: ["about:blank", "about:newtab", "about:home", "about:welcome", "about:privatebrowsing", "chrome://browser/content/blanktab.html"],
  MAIL_URL: "chrome://browser/content/tabora/mail/mail.html",
  DOWNLOADS_URL: "chrome://browser/content/tabora/downloads/downloads.html",

  isMailUrl(spec) {
    return (spec || "").startsWith(this.MAIL_URL);
  },

  /** Как показывать адрес человеку: внутренние страницы получают короткие имена. */
  displayUrl(spec) {
    if (this.isMailUrl(spec)) {
      const hash = spec.split("#")[1] || "";
      return hash === "aliases" ? "tabora://mail/aliases" : "tabora://mail";
    }
    if (spec.startsWith("about:preferences")) {
      return "tabora://settings";
    }
    if (spec.startsWith(this.DOWNLOADS_URL)) {
      return "tabora://downloads";
    }
    return spec;
  },

  openDownloads() {
    this.openInternal(this.DOWNLOADS_URL);
  },

  openUrl(url) {
    gBrowser.selectedTab = gBrowser.addTab(url, { triggeringPrincipal: Services.scriptSecurityManager.createNullPrincipal({}) });
  },

  /** Открыть внутреннюю страницу (одну на окно): уже открытая вкладка переиспользуется. */
  openInternal(url) {
    const existing = gBrowser.tabs.find(t => (t.linkedBrowser?.currentURI?.spec || "").startsWith(url) && !t.hidden);
    if (existing) {
      gBrowser.selectedTab = existing;
      return;
    }
    gBrowser.selectedTab = gBrowser.addTab(url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
  },

  /** Контекстное меню для наших страниц: координаты страницы переводятся в координаты окна. */
  showMenuFromContent(contentWindow, items, x, y) {
    const browser = gBrowser.getBrowserForContentWindow?.(contentWindow) || gBrowser.selectedBrowser;
    const rect = browser.getBoundingClientRect();
    this.showMenu(items, rect.left + x, rect.top + y);
  },

  openMail(hash = "") {
    const url = this.MAIL_URL + (hash ? `#${hash}` : "");
    const existing = gBrowser.tabs.find(t => this.isMailUrl(t.linkedBrowser?.currentURI?.spec) && !t.hidden);
    if (existing) {
      gBrowser.selectedTab = existing;
      if (hash) {
        existing.linkedBrowser.loadURI(Services.io.newURI(url), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      }
      return;
    }
    gBrowser.selectedTab = gBrowser.addTab(url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
  },

  /** Внутренние страницы показывают в адресной строке своё имя вместо chrome:// и about:. */
  syncUrlbarDisplay() {
    const spec = gBrowser.selectedBrowser?.currentURI?.spec || "";
    const shown = this.displayUrl(spec);
    if (shown !== spec && !gURLBar.focused && gURLBar.value !== shown) {
      gURLBar.value = shown;
    }
  },

  buildStartPage() {
    const tabbox = document.getElementById("tabbrowser-tabbox");
    const input = this.html("input", { id: "tabora-start-input", placeholder: "Найти, открыть или поручить агенту", "aria-label": "Поиск или адрес" });
    const search = this.html("div", { class: "search" }, null, [
      this.html("span", { class: "dot", "aria-hidden": "true" }),
      input,
      this.html("span", { class: "kbd" }, "⏎"),
    ]);
    const page = this.html("div", { id: "tabora-start", hidden: "true" }, null, [
      this.html("div", { class: "hero" }, null, [
        this.html("div", { class: "date", id: "tabora-start-date" }),
        this.html("h1", { class: "greeting", id: "tabora-start-greeting" }),
      ]),
      search,
      this.html("div", { class: "dial", id: "tabora-start-dial", hidden: "true" }),
    ]);
    page.querySelector(".hero").style.cssText = "display:flex;flex-direction:column;align-items:center;gap:0";
    tabbox.append(page);
    input.setAttribute("readonly", "true");
    input.addEventListener("mousedown", e => {
      e.preventDefault();
      this.openCommandBar();
    });
    input.addEventListener("keydown", e => {
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        this.openCommandBar(e.key);
      } else if (e.key === "Enter") {
        e.preventDefault();
        this.openCommandBar();
      }
    });
    gBrowser.addTabsProgressListener({
      onLocationChange: browser => {
        if (browser === gBrowser.selectedBrowser) {
          this.updateStart();
          this.syncUrlbarDisplay();
        }
      },
    });
    gBrowser.tabContainer.addEventListener("TabSelect", () => {
      this.updateStart();
      this.syncUrlbarDisplay();
    });
    this.updateStart();
  },

  go(text) {
    gURLBar.value = text;
    gURLBar.handleCommand();
  },

  isStartUrl(spec) {
    return this.START_URLS.some(u => spec === u || spec.startsWith(u + "?") || spec.startsWith(u + "#"));
  },

  startLabel() {
    return this.isPrivate ? "Приватная вкладка" : "Новая вкладка";
  },

  /** Стартовые вкладки получают атрибут tabora-start: свой значок вместо глобуса Firefox. */
  markStartTab(tab) {
    const spec = tab?.linkedBrowser?.currentURI?.spec || "about:blank";
    tab?.toggleAttribute("tabora-start", this.isStartUrl(spec));
  },

  updateStart() {
    const page = document.getElementById("tabora-start");
    const browser = gBrowser.selectedBrowser;
    if (!page || !browser) {
      return;
    }
    const spec = browser.currentURI?.spec || "about:blank";
    const show = this.isStartUrl(spec);
    page.hidden = !show;
    this.markStartTab(gBrowser.selectedTab);
    if (!show) {
      return;
    }
    if (gBrowser.selectedTab.label !== this.startLabel()) {
      gBrowser.selectedTab.label = this.startLabel();
    }
    this.markStartTab(gBrowser.selectedTab);
    const now = new Date();
    const hour = now.getHours();
    const name = Services.prefs.getStringPref("tabora.user.name", "");
    const word = hour < 5 ? "Доброй ночи" : hour < 12 ? "Доброе утро" : hour < 18 ? "Добрый день" : "Добрый вечер";
    if (this.isPrivate) {
      document.getElementById("tabora-start-greeting").textContent = "Приватное окно";
      document.getElementById("tabora-start-date").textContent = "история, cookies и поиск не сохраняются";
    } else {
      document.getElementById("tabora-start-greeting").textContent = name ? `${word}, ${name}` : word;
      document.getElementById("tabora-start-date").textContent = new Intl.DateTimeFormat("ru-RU", {
        weekday: "long", day: "numeric", month: "long",
      }).format(now);
    }
    this.fillDial();
    const input = document.getElementById("tabora-start-input");
    setTimeout(() => {
      if (!page.hidden && gBrowser.selectedBrowser === browser) {
        input.focus();
      }
    }, 60);
  },

  async fillDial() {
    const dial = document.getElementById("tabora-start-dial");
    if (!dial || dial.dataset.filledAt > Date.now() - 60_000) {
      return;
    }
    let sites = [];
    try {
      const { NewTabUtils } = ChromeUtils.importESModule("resource://gre/modules/NewTabUtils.sys.mjs");
      sites = await NewTabUtils.activityStreamProvider.getTopFrecentSites({ numItems: 12, includeFavicon: true });
    } catch (e) {
      console.error("Tabora dial", e);
    }
    dial.replaceChildren();
    dial.dataset.filledAt = String(Date.now());
    dial.hidden = !sites.length;
    for (const site of sites.slice(0, 12)) {
      let host = "";
      try {
        host = new URL(site.url).hostname.replace(/^www\./, "");
      } catch (e) {}
      const label = site.title && site.title.length <= 18 ? site.title : host;
      const glyph = this.html("span", { class: "glyph", "aria-hidden": "true" });
      if (site.favicon) {
        glyph.classList.add("has-icon");
        glyph.append(this.html("img", { src: site.favicon, alt: "" }));
      } else {
        glyph.textContent = (host || "?").charAt(0).toUpperCase();
      }
      const a = this.html("a", { href: site.url, title: site.url }, null, [glyph, this.html("span", { class: "label" }, label)]);
      a.addEventListener("click", e => {
        e.preventDefault();
        this.go(site.url);
      });
      dial.append(a);
    }
  },

  buildAgentPanel() {
    const browser = document.getElementById("browser");
    const closeBtn = this.html("button", { class: "close", "aria-label": "Скрыть панель агента" }, null, [
      this.svg(["M6 6l12 12M18 6L6 18"], 14, 2.2),
    ]);
    const input = this.html("input", { id: "tabora-agent-input", placeholder: "Спросите или поручите…", "aria-label": "Сообщение агенту" });
    const sendBtn = this.html("button", { class: "send", "aria-label": "Отправить" }, null, [
      this.svg(["M5 12h14M13 6l6 6-6 6"], 16, 2.2),
    ]);
    const chips = ["Саммари страницы", "Сравнить вкладки", "Тёмная тема для сайта"].map(q =>
      this.html("button", { "data-q": q }, q)
    );
    const panel = this.html("div", { id: "tabora-agent", hidden: "true" }, null, [
      this.html("div", { class: "head" }, null, [
        this.html("span", { class: "orb", "aria-hidden": "true" }),
        this.html("div", { class: "who" }, null, [
          this.html("span", { class: "name" }, "Агент"),
          this.html("span", { class: "where", id: "tabora-agent-where" }),
        ]),
        closeBtn,
      ]),
      this.html("div", { class: "log", id: "tabora-agent-log" }, null, [
        this.html("div", { class: "msg agent" }, "Я пока учусь. Регистрация на сайтах, алиасы почты и коды из писем появятся в следующих сборках. Сейчас умею усыплять вкладки и держать пространства раздельно."),
      ]),
      this.html("div", { class: "chips" }, null, chips),
      this.html("div", { class: "composer" }, null, [input, sendBtn]),
    ]);
    browser.append(panel);
    closeBtn.addEventListener("click", () => this.toggleAgent(false));
    const send = () => {
      if (this.agentSend(input.value)) {
        input.value = "";
      }
    };
    sendBtn.addEventListener("click", send);
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        send();
      }
    });
    for (const chip of chips) {
      chip.addEventListener("click", () => {
        input.value = chip.getAttribute("data-q");
        send();
      });
    }
  },

  agentSend(raw) {
    const text = (raw || "").trim();
    if (!text) {
      return false;
    }
    this.toggleAgent(true);
    this.agentSay(text, "user");
    this.agentSay("Принял: «" + text + "». Выполнять задачи я научусь в одной из следующих сборок.", "agent");
    return true;
  },

  agentSay(text, who) {
    const log = document.getElementById("tabora-agent-log");
    log.append(this.html("div", { class: `msg ${who}` }, text));
    log.scrollTop = log.scrollHeight;
  },

  toggleAgent(force) {
    const panel = document.getElementById("tabora-agent");
    const show = force === undefined ? panel.hidden : force;
    panel.hidden = !show;
    document
      .getElementById("tabora-agent-toggle")
      ?.setAttribute("aria-pressed", String(show));
    if (show) {
      document.getElementById("tabora-agent-input")?.focus();
    }
  },

  /* ---- Командная строка ⌘K --------------------------------------------- */

  cmd: { items: [], sel: 0, seq: 0 },

  hint(key, label) {
    return this.html("span", { class: "hint" }, null, [
      this.html("span", { class: "k" }, key),
      document.createTextNode(" " + label),
    ]);
  },

  buildCommandBar() {
    const browser = document.getElementById("browser");
    const input = this.html("input", {
      id: "tabora-cmd-input",
      placeholder: "Команда, адрес или задача агенту",
      "aria-label": "Команда, адрес или задача агенту",
      autocomplete: "off",
      spellcheck: "false",
    });
    const dialog = this.html("div", { class: "dialog", role: "dialog", "aria-label": "Командная строка" }, null, [
      this.html("div", { class: "head" }, null, [
        this.html("span", { class: "dot", "aria-hidden": "true" }),
        input,
        this.html("span", { class: "kbd" }, "esc"),
      ]),
      this.html("div", { class: "body", id: "tabora-cmd-body", role: "listbox" }),
      this.html("div", { class: "foot" }, null, [
        this.hint("↑↓", "выбрать"),
        this.hint("⏎", "выполнить"),
        this.hint("⇥", "поручить агенту"),
        this.html("span", { class: "spacer" }),
        this.html("span", {}, "Адрес или запрос открываются по ⏎, задача агенту по ⇥"),
      ]),
    ]);
    const overlay = this.html("div", { id: "tabora-cmd", hidden: "true" }, null, [dialog]);
    browser.append(overlay);

    overlay.addEventListener("mousedown", e => {
      if (e.target === overlay) {
        this.closeCommandBar();
      }
    });
    input.addEventListener("input", () => this.cmdUpdate());
    input.addEventListener("keydown", e => {
      switch (e.key) {
        case "Escape":
          this.closeCommandBar();
          break;
        case "ArrowDown":
          this.cmdMove(1);
          break;
        case "ArrowUp":
          this.cmdMove(-1);
          break;
        case "Enter":
          this.cmdRun(this.cmd.items[this.cmd.sel]);
          break;
        case "Tab": {
          const text = input.value.trim();
          this.closeCommandBar();
          this.toggleAgent(true);
          const agentInput = document.getElementById("tabora-agent-input");
          if (agentInput) {
            agentInput.value = text;
            agentInput.focus();
          }
          break;
        }
        default:
          return;
      }
      e.preventDefault();
      e.stopPropagation();
    });
  },

  openCommandBar(prefill = "", { select = false } = {}) {
    const overlay = document.getElementById("tabora-cmd");
    const input = document.getElementById("tabora-cmd-input");
    if (!overlay || !input) {
      return;
    }
    overlay.hidden = false;
    input.value = prefill;
    input.focus();
    if (select) {
      input.select();
    } else {
      input.setSelectionRange(prefill.length, prefill.length);
    }
    this.cmdUpdate();
  },

  /* Адресная строка в колонке только показывает адрес: фокус в ней
   * открывает командную строку с текущим адресом, как в Arc. */
  routeUrlbarToCommandBar() {
    const field = gURLBar.inputField;
    field.addEventListener("focus", () => {
      if (!document.getElementById("tabora-cmd")?.hidden) {
        return;
      }
      const spec = gBrowser.selectedBrowser?.currentURI?.spec || "";
      if (this.isStartUrl(spec)) {
        // Новая вкладка: показываем стартовую страницу, набор текста откроет бар.
        gURLBar.blur();
        document.getElementById("tabora-start-input")?.focus();
        return;
      }
      let prefill = this.displayUrl(spec);
      if (prefill === spec) {
        try {
          prefill = decodeURI(spec);
        } catch (e) {
          prefill = spec;
        }
        prefill = prefill.replace(/^https:\/\/(www\.)?/, "").replace(/\/$/, "");
      }
      gURLBar.blur();
      this.openCommandBar(prefill, { select: true });
    });
  },

  closeCommandBar() {
    const overlay = document.getElementById("tabora-cmd");
    if (!overlay || overlay.hidden) {
      return;
    }
    overlay.hidden = true;
    this.cmd.seq++;
    gBrowser.selectedBrowser?.focus();
  },

  looksLikeUrl(text) {
    if (/\s/.test(text)) {
      return null;
    }
    if (/^(about|chrome|file|moz-extension):/.test(text)) {
      return { host: text, path: "" };
    }
    try {
      const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
      const host = url.hostname;
      if (!host || (!host.includes(".") && host !== "localhost")) {
        return null;
      }
      if (!/^[a-z0-9.-]+$/i.test(host) || /\.$/.test(host) || /^\./.test(host)) {
        return null;
      }
      let path = url.pathname === "/" ? "" : url.pathname + url.search;
      try {
        path = decodeURI(path);
      } catch (e) {}
      return { host: host.replace(/^www\./, ""), path };
    } catch (e) {
      return null;
    }
  },

  letterOf(text) {
    const s = (text || "").replace(/^(https?:\/\/)?(www\.)?/, "").trim();
    return s ? s[0].toUpperCase() : "•";
  },

  hostOf(spec) {
    try {
      return new URL(spec).hostname.replace(/^www\./, "");
    } catch (e) {
      return spec || "";
    }
  },

  _engineName: "",

  searchEngineName() {
    if (!this._engineName) {
      this._engineName = "Поиск";
      const { SearchService } = ChromeUtils.importESModule("moz-src:///toolkit/components/search/SearchService.sys.mjs");
      SearchService.getDefault()
        .then(engine => {
          if (engine?.name) {
            this._engineName = engine.name;
          }
        })
        .catch(() => {});
    }
    return this._engineName;
  },

  commands() {
    const others = gBrowser.tabs.filter(t => t !== gBrowser.selectedTab && !t.closing && !t.hasAttribute("pending"));
    return [
      { glyph: "+", title: "Новая вкладка", note: "В текущем пространстве", key: "⌘T", tags: "new tab создать", run: () => BrowserCommands.openTab() },
      {
        glyph: "Z",
        title: "Усыпить все вкладки, кроме текущей",
        note: others.length
          ? `${others.length} ${this.plural(others.length, "вкладка освободит", "вкладки освободят", "вкладок освободят")} память`
          : "Все остальные вкладки уже спят",
        key: "",
        tags: "sleep память ram спать",
        run: () => {
          for (const tab of others) {
            gBrowser.discardBrowser(tab);
          }
          this.updateMemory();
        },
      },
      ...this.spaces.map((s, i) => ({
        glyph: s.name[0],
        title: `Пространство: ${s.name}`,
        note: s.id === this.activeSpaceId ? "Текущее" : "Переключить",
        key: `⌘${i + 1}`,
        tags: "space пространство",
        run: () => this.switchSpace(s.id),
      })),
      { glyph: "●", title: "Панель агента", note: "Показать или скрыть", key: "⌘J", tags: "agent ai", run: () => this.toggleAgent() },
      { glyph: "P", title: "Приватное окно", note: "Без истории и cookies", key: "⌘⇧P", tags: "private инкогнито", run: () => OpenBrowserWindow({ private: true }) },
      { glyph: "↓", title: "Загрузки", note: "Прогресс, миниатюры, файлы под рукой", key: "⌘⇧J", tags: "downloads загрузки файлы", run: () => this.openDownloads() },
      { glyph: "✎", title: "Написать письмо", note: "Окно письма поверх любой вкладки", key: "", tags: "compose написать письмо mail new", run: () => this.openCompose() },
      { glyph: "✉", title: "Почта и алиасы", note: "Входящие, коды подтверждения, алиасы", key: "⌘⇧M", tags: "mail почта email письма алиасы inbox", run: () => this.openMail() },
      { glyph: "⚙", title: "Настройки", note: "Поведение, приватность, внешний вид", key: "⌘,", tags: "settings preferences", run: () => openPreferences() },
    ];
  },

  async cmdHistory(q) {
    try {
      const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
      const like = "%" + q.replace(/[%_\\]/g, "\\$&") + "%";
      const rows = await PlacesUtils.withConnectionWrapper("Tabora command bar", db =>
        db.executeCached(
          `SELECT url, title FROM moz_places
           WHERE hidden = 0 AND frecency > 0 AND url NOT LIKE 'place:%'
             AND (title LIKE :q ESCAPE '\\' OR url LIKE :q ESCAPE '\\')
           ORDER BY frecency DESC LIMIT 5`,
          { q: like }
        )
      );
      return rows.map(r => {
        const url = r.getResultByName("url");
        const title = r.getResultByName("title") || this.hostOf(url);
        return { glyph: this.letterOf(title), icon: `page-icon:${url}`, title, note: this.hostOf(url), key: "", run: () => this.go(url) };
      });
    } catch (e) {
      console.error("Tabora cmd history", e);
      return [];
    }
  },

  async cmdUpdate() {
    const seq = ++this.cmd.seq;
    const q = document.getElementById("tabora-cmd-input").value.trim();
    const lower = q.toLowerCase();
    const groups = [];

    if (q) {
      const url = this.looksLikeUrl(q);
      groups.push({
        name: "Открыть",
        items: [
          url
            ? { glyph: this.letterOf(url.host), icon: `page-icon:https://${url.host}/`, title: url.host + url.path, note: "Открыть адрес", key: "⏎", run: () => this.go(q) }
            : { glyph: this.svg(["M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z", "M20 20l-4-4"], 15, 2), title: `Искать «${q}»`, note: this.searchEngineName(), key: "⏎", run: () => this.go(q) },
        ],
      });
      if (!url) {
        groups.push({
          name: "Агенту",
          agent: true,
          items: [{ glyph: "●", title: q, note: "Поручить агенту. Он уточнит, если чего-то не хватает", key: "⇥", run: () => this.agentSend(q) }],
        });
      }
    }

    const tabs = gBrowser.tabs
      .filter(t => t !== gBrowser.selectedTab && !t.closing && !t.hidden)
      .filter(t => !q || (t.label || "").toLowerCase().includes(lower) || (t.linkedBrowser?.currentURI?.spec || "").toLowerCase().includes(lower))
      .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))
      .slice(0, q ? 4 : 3);
    if (tabs.length) {
      groups.push({
        name: "Вкладки",
        items: tabs.map(t => ({
          glyph: this.letterOf(t.label),
          icon: t.getAttribute("image") || `page-icon:${t.linkedBrowser?.currentURI?.spec || ""}`,
          title: t.label,
          note: this.hostOf(t.linkedBrowser?.currentURI?.spec) + (t.hasAttribute("pending") ? " · спит" : ""),
          key: "",
          run: () => {
            gBrowser.selectedTab = t;
          },
        })),
      });
    }

    const cmds = this.commands().filter(c => !q || c.title.toLowerCase().includes(lower) || (c.tags || "").includes(lower));
    if (cmds.length) {
      groups.push({ name: "Команды", items: cmds.slice(0, q ? 4 : 7) });
    }

    if (q.length >= 2) {
      const hist = await this.cmdHistory(q);
      if (seq !== this.cmd.seq) {
        return;
      }
      if (hist.length) {
        groups.push({ name: "История", items: hist });
      }
    }
    this.cmdRender(groups);
  },

  cmdRender(groups) {
    const body = document.getElementById("tabora-cmd-body");
    body.textContent = "";
    this.cmd.items = [];
    this.cmd.sel = 0;
    if (!groups.length) {
      body.append(this.html("div", { class: "empty" }, "Ничего не нашлось"));
      return;
    }
    for (const g of groups) {
      const list = this.html("div", { class: "group" }, null, [this.html("span", { class: "name" }, g.name)]);
      for (const item of g.items) {
        const index = this.cmd.items.length;
        const glyph = this.html("span", { class: "glyph", "aria-hidden": "true" });
        if (item.glyph instanceof Node) {
          glyph.append(item.glyph);
        } else {
          glyph.textContent = item.glyph;
        }
        if (item.icon) {
          const img = this.html("img", { src: item.icon, alt: "" });
          img.addEventListener("load", () => glyph.classList.add("has-icon"), { once: true });
          img.addEventListener("error", () => img.remove(), { once: true });
          glyph.append(img);
        }
        const row = this.html("button", { class: "row" + (g.agent ? " agent" : ""), role: "option", type: "button" }, null, [
          glyph,
          this.html("span", { class: "text" }, null, [
            this.html("span", { class: "title" }, item.title),
            this.html("span", { class: "note" }, item.note || ""),
          ]),
          this.html("span", { class: "key" }, item.key || ""),
        ]);
        row.addEventListener("mousemove", () => this.cmdSelect(index));
        row.addEventListener("click", () => this.cmdRun(item));
        this.cmd.items.push({ ...item, row });
        list.append(row);
      }
      body.append(list);
    }
    this.cmdSelect(0);
  },

  cmdSelect(index) {
    const items = this.cmd.items;
    if (!items.length) {
      return;
    }
    this.cmd.sel = (index + items.length) % items.length;
    items.forEach((it, i) => {
      it.row.toggleAttribute("selected", i === this.cmd.sel);
      it.row.setAttribute("aria-selected", String(i === this.cmd.sel));
    });
  },

  cmdMove(delta) {
    this.cmdSelect(this.cmd.sel + delta);
    this.cmd.items[this.cmd.sel]?.row.scrollIntoView({ block: "nearest" });
  },

  cmdRun(item) {
    if (!item) {
      return;
    }
    this.closeCommandBar();
    try {
      item.run();
    } catch (e) {
      console.error("Tabora cmd run", e);
    }
  },

  /* ---- Пространства на контейнерах Firefox ----------------------------- */

  DEFAULT_SPACES: [
    { id: "personal", name: "Личное", icon: "fingerprint", color: "yellow", userContextId: 0 },
    { id: "work", name: "Работа", icon: "briefcase", color: "blue" },
    { id: "projects", name: "Проекты", icon: "chill", color: "orange" },
  ],

  initSpaces() {
    const cis = this.ContextualIdentityService;
    let saved = [];
    try {
      saved = JSON.parse(Services.prefs.getStringPref("tabora.spaces", "[]"));
    } catch (e) {}
    const known = new Set(cis.getPublicIdentities().map(i => i.userContextId));
    this.spaces = this.DEFAULT_SPACES.map(def => {
      const prev = saved.find(s => s.id === def.id);
      let userContextId = def.userContextId ?? prev?.userContextId;
      if (userContextId === undefined || (userContextId !== 0 && !known.has(userContextId))) {
        const identity = cis.create(def.name, def.icon, def.color);
        userContextId = identity.userContextId;
      }
      return { ...def, userContextId };
    });
    Services.prefs.setStringPref("tabora.spaces", JSON.stringify(this.spaces));
    this.activeSpaceId = Services.prefs.getStringPref("tabora.spaces.active", "personal");
    if (!this.spaces.some(s => s.id === this.activeSpaceId)) {
      this.activeSpaceId = "personal";
    }

    const bar = document.getElementById("tabora-spaces");
    for (const space of this.spaces) {
      const b = this.html(
        "button",
        { class: "tabora-space", role: "tab", "data-space": space.id },
        space.name
      );
      b.addEventListener("click", () => this.switchSpace(space.id));
      bar.append(b);
    }

    const current = this.activeSpaceFor(gBrowser.selectedTab);
    if (current) {
      this.activeSpaceId = current.id;
    }
    this.applySpace();

    const original = BrowserCommands.openTab.bind(BrowserCommands);
    BrowserCommands.openTab = (options = {}) => {
      const space = this.activeSpace();
      if (!space || space.userContextId === 0 || options.url) {
        return original(options);
      }
      gBrowser.selectedTab = gBrowser.addTab(BROWSER_NEW_TAB_URL, {
        userContextId: space.userContextId,
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      });
      gURLBar.select();
      return undefined;
    };
  },

  activeSpace() {
    return this.spaces.find(s => s.id === this.activeSpaceId);
  },

  activeSpaceFor(tab) {
    const ctx = this.contextOf(tab);
    return this.spaces.find(s => s.userContextId === ctx);
  },

  contextOf(tab) {
    return parseInt(tab?.getAttribute("usercontextid") || "0", 10);
  },

  switchSpace(id) {
    if (!this.spaces.some(s => s.id === id)) {
      return;
    }
    this.activeSpaceId = id;
    Services.prefs.setStringPref("tabora.spaces.active", id);
    this.applySpace();
  },

  applySpace() {
    const space = this.activeSpace();
    for (const b of document.querySelectorAll("#tabora-spaces .tabora-space")) {
      b.setAttribute("aria-selected", String(b.dataset.space === space.id));
    }
    const inSpace = tab => tab.pinned || this.contextOf(tab) === space.userContextId;

    if (!inSpace(gBrowser.selectedTab)) {
      const candidate = gBrowser.tabs.find(t => !t.closing && !t.pinned && inSpace(t));
      if (candidate) {
        gBrowser.selectedTab = candidate;
      } else {
        gBrowser.selectedTab = gBrowser.addTab(BROWSER_NEW_TAB_URL, {
          userContextId: space.userContextId,
          triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
        });
      }
    }
    for (const tab of gBrowser.tabs) {
      if (tab.closing) {
        continue;
      }
      if (inSpace(tab)) {
        gBrowser.showTab(tab);
      } else {
        gBrowser.hideTab(tab);
      }
    }
    this.updateMemory();
  },

  /* ---- Вкладки: заголовок, блокировка, сон ------------------------------ */

  initTabHooks() {
    gBrowser.tabContainer.addEventListener("TabSelect", () => {
      const space = this.activeSpaceFor(gBrowser.selectedTab);
      if (space && space.id !== this.activeSpaceId && !gBrowser.selectedTab.pinned) {
        this.activeSpaceId = space.id;
        Services.prefs.setStringPref("tabora.spaces.active", space.id);
        this.applySpace();
      }
      this.updateTitle();
    });
    gBrowser.tabContainer.addEventListener("TabAttrModified", e => {
      const tab = e.target;
      if (e.detail?.changed?.some(a => a === "image" || a === "label" || a === "busy")) {
        this.markStartTab(tab);
      }
      if (
        e.detail?.changed?.includes("label") &&
        tab.label !== this.startLabel() &&
        this.isStartUrl(tab.linkedBrowser?.currentURI?.spec || "")
      ) {
        tab.label = this.startLabel();
      }
      if (tab === gBrowser.selectedTab) {
        this.updateTitle();
      }
    });
    gBrowser.tabContainer.addEventListener("TabOpen", e => {
      const space = this.activeSpace();
      if (space && !e.target.pinned && this.contextOf(e.target) !== space.userContextId) {
        gBrowser.hideTab(e.target);
      }
    });
  },

  updateTitle() {
    const tab = gBrowser.selectedTab;
    const title = document.getElementById("tabora-title");
    if (!title || !tab) {
      return;
    }
    let host = "";
    const spec = gBrowser.selectedBrowser.currentURI?.spec || "";
    if (!this.isStartUrl(spec) && /^https?:/.test(spec)) {
      try {
        host = new URL(spec).hostname.replace(/^www\./, "");
      } catch (e) {}
    }
    let label = this.isStartUrl(spec) ? this.startLabel() : tab.label || "";
    if (/^[\w.-]+\/$/.test(label)) {
      label = label.slice(0, -1); // у страницы без заголовка Firefox пишет «host/»
    }
    title.textContent = host && !label.includes(host) ? `${label} · ${host}` : label;
    document.getElementById("tabora-agent-where").textContent = host ? `Работает на ${host}` : "Готов к задачам";
    this.updateBlocked();
  },

  async updateBlocked() {
    const chip = document.getElementById("tabora-blocked");
    const browser = gBrowser.selectedBrowser;
    if (!chip || !browser) {
      return;
    }
    let count = 0;
    try {
      const log = JSON.parse(await browser.getContentBlockingLog());
      for (const entries of Object.values(log)) {
        for (const [, blocked, n] of entries) {
          if (blocked) {
            count += n;
          }
        }
      }
    } catch (e) {}
    if (browser !== gBrowser.selectedBrowser) {
      return;
    }
    chip.hidden = !count;
    document.getElementById("tabora-blocked-text").textContent = count
      ? `${count} ${this.plural(count, "трекер заблокирован", "трекера заблокировано", "трекеров заблокировано")}`
      : "";
    const readerBtn = document.getElementById("tabora-reader");
    if (readerBtn) {
      const native = document.getElementById("reader-mode-button");
      readerBtn.toggleAttribute("disabled", !(native && !native.hidden));
    }
  },

  startTimers() {
    this.updateMemory();
    setInterval(() => this.updateMemory(), 5000);
    setInterval(() => this.sleepIdleTabs(), 60 * 1000);
    setInterval(() => this.updateBlocked(), 3000);
  },

  sleepIdleTabs() {
    const limit = Date.now() - this.SLEEP_AFTER_MS;
    for (const tab of gBrowser.tabs) {
      if (
        tab.selected ||
        tab.pinned ||
        tab.closing ||
        tab.hasAttribute("pending") ||
        tab.soundPlaying ||
        tab.lastAccessed > limit
      ) {
        continue;
      }
      gBrowser.discardBrowser(tab);
    }
  },

  async updateMemory() {
    const valueEl = document.getElementById("tabora-memory-value");
    if (!valueEl) {
      return;
    }
    let mb = 0;
    try {
      // Весь браузер: главный процесс и все дочерние, иначе на пустой вкладке было бы «0 МБ».
      const info = await ChromeUtils.requestProcInfo();
      mb = info.memory / (1024 * 1024);
      for (const child of info.children) {
        mb += child.memory / (1024 * 1024);
      }
    } catch (e) {}
    const sleeping = gBrowser.tabs.filter(t => t.hasAttribute("pending") && !t.closing).length;
    const awake = gBrowser.tabs.filter(t => !t.hasAttribute("pending") && !t.closing && !t.hidden).length;
    valueEl.textContent = mb >= 1024 ? `${(mb / 1024).toFixed(1)} ГБ` : `${Math.round(mb)} МБ`;
    document.getElementById("tabora-memory-bar").style.width = `${Math.min(100, (mb / this.MEMORY_BAR_MAX_MB) * 100)}%`;
    document.getElementById("tabora-memory-note").textContent = sleeping
      ? `${sleeping} ${this.plural(sleeping, "вкладка спит", "вкладки спят", "вкладок спят")} и не ${sleeping === 1 ? "занимает" : "занимают"} RAM`
      : `${awake} ${this.plural(awake, "вкладка активна", "вкладки активны", "вкладок активны")}, через 15 минут простоя засыпают`;
  },

  plural(n, one, few, many) {
    const m10 = n % 10;
    const m100 = n % 100;
    if (m10 === 1 && m100 !== 11) {
      return one;
    }
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) {
      return few;
    }
    return many;
  },

  /* ---- Клавиши ---------------------------------------------------------- */

  initKeys() {
    window.addEventListener(
      "keydown",
      e => {
        const mod = e.metaKey || e.ctrlKey;
        if (!mod && !e.altKey && e.key.length === 1 && !e.isComposing) {
          // На стартовой странице любая буква открывает командную строку.
          const start = document.getElementById("tabora-start");
          const cmd = document.getElementById("tabora-cmd");
          const active = document.activeElement;
          const typing = active && (active.localName === "input" || active.localName === "textarea" || active.isContentEditable);
          if (start && !start.hidden && cmd?.hidden && !typing) {
            this.openCommandBar(e.key);
            e.preventDefault();
            e.stopPropagation();
          }
          return;
        }
        if (!mod || e.altKey) {
          return;
        }
        if (!e.shiftKey && ["1", "2", "3"].includes(e.key)) {
          const space = this.spaces[parseInt(e.key, 10) - 1];
          if (space) {
            this.switchSpace(space.id);
            e.preventDefault();
            e.stopPropagation();
          }
        } else if (!e.shiftKey && e.key.toLowerCase() === "j") {
          this.toggleAgent();
          e.preventDefault();
          e.stopPropagation();
        } else if (!e.shiftKey && e.key.toLowerCase() === "k") {
          this.openCommandBar();
          e.preventDefault();
          e.stopPropagation();
        } else if (e.shiftKey && e.code === "KeyM") {
          this.openMail();
          e.preventDefault();
          e.stopPropagation();
        } else if (e.shiftKey && e.code === "KeyJ") {
          this.openDownloads();
          e.preventDefault();
          e.stopPropagation();
        }
      },
      true
    );
  },
};

Services.obs.addObserver(function onStartup(subject) {
  if (subject !== window) {
    return;
  }
  Services.obs.removeObserver(onStartup, "browser-delayed-startup-finished");
  try {
    Tabora.init();
  } catch (e) {
    console.error("Tabora init failed", e);
  }
}, "browser-delayed-startup-finished");
