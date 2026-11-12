/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Ящик Tabora: выдвижная панель между сайдбаром и страницей.
 * Рейка разделов слева (редактируется: состав и порядок), панель содержимого справа.
 * Разделы: почта (страница во вкладке), загрузки, кошелёк, коды, история, медиа, пространства
 * (на всю ширину), закладки.
 *
 * Три состояния: ничего не видно; видна одна рейка (drawer.rail); рейка с панелью раздела
 * (drawer.open). Рейку без панели показывает кнопка «Разделы» внизу колонки: выбор раздела
 * открывает панель, закрытие панели прячет и рейку. Закреплённая рейка (кнопка внизу рейки,
 * настройка tabora.drawer.pinned) остаётся на месте и после закрытия панели, и после перезапуска;
 * в узком окне она не держится, чтобы не отнимать место у страницы.
 * Подключается из tabora.js через loadSubScript и расширяет объект Tabora. */

Object.assign(Tabora, {
  DRAWER_WIDTH: 384,
  DRAWER_RAIL: 64,
  SECTIONS_PREF: "tabora.drawer.sections",
  SECTION_PREF: "tabora.drawer.section",
  RAIL_PINNED_PREF: "tabora.drawer.pinned",

  // page — раздел без панели: имя метода, который открывает его страницу во вкладке (и возвращает
  // с неё), current — стоит ли страница перед глазами; badge — у раздела есть счётчик событий
  SECTIONS: {
    mail: { label: tt`Почта`, key: "⌘⇧M", icon: ["M3.5 6.5h17v11h-17z", "M3.5 7l8.5 6 8.5-6"], page: "toggleMail", current: () => Tabora.isMailUrl(gBrowser.selectedBrowser?.currentURI?.spec), badge: "mail" },
    downloads: { label: tt`Загрузки`, key: "⌘⇧J", icon: ["M12 4v11", "M7 10l5 5 5-5", "M4 19h16"], search: tt`Имя файла или сайт`, full: tt`Открыть страницу загрузок`, badge: "downloads" },
    history: { label: tt`История`, key: "⌘⇧H", icon: ["M12 7v5l3 2", "M3.5 12a8.5 8.5 0 1 0 2.5-6", "M3 4v4h4"], search: tt`Поиск в истории` },
    media: { label: tt`Медиа`, key: "⌘⇧I", icon: ["M4 5h16v14H4z", "M4 15l5-5 4 4 3-3 4 4", "M15.5 9.5h.01"], search: tt`Поиск по медиа` },
    spaces: { label: tt`Пространства`, short: tt`Простран­ства`, key: "⌘⇧S", icon: ["M8 8h12v12H8z", "M4 4h12v12", "M4 4v12h12"], wide: true },
    bookmarks: { label: tt`Закладки`, key: "⌘⇧B", icon: ["M6 4h12v16l-6-4-6 4z"], search: tt`Поиск по закладкам` },
  },
  SECTION_ORDER: ["mail", "downloads", "history", "media", "spaces", "bookmarks"],

  drawer: { open: false, rail: false, section: "downloads", editing: false, query: "", filter: "all", el: null, inner: null, body: null, timer: null, cache: {} },

  /* ---- Каркас ------------------------------------------------------------ */

  buildDrawer() {
    const h = (tag, attrs, text, children) => this.html(tag, attrs, text, children);
    const d = this.drawer;
    d.section = Services.prefs.getStringPref(this.SECTION_PREF, "downloads");
    if (!this.SECTIONS[d.section] || this.SECTIONS[d.section].page) {
      d.section = "downloads";
    }

    const rail = h("nav", { class: "rail", "aria-label": tt`Разделы` }, null, [
      h("div", { class: "rail-items", id: "tabora-rail-items" }),
      h("div", { class: "rail-foot" }, null, [
        this.iconButton("tabora-rail-back", tt`Готово`, ["M19 12H5", "m11 6-6 6 6 6"], () => this.setDrawerEditing(false)),
        this.iconButton("tabora-rail-pin", tt`Закрепить рейку`, ["M12 17v5", "M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.8l-1.8-.9a2 2 0 0 1-1.1-1.8V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"], () => this.setRailPinned(!this.railPinned())),
        this.iconButton("tabora-rail-edit", tt`Настроить разделы`, ["M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17z", "M13.5 6.5l3 3"], () => this.setDrawerEditing(!d.editing)),
      ]),
    ]);
    rail.addEventListener("keydown", e => {
      // стрелки переходят по разделам рейки
      const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
      const items = [...rail.querySelectorAll(".rail-item:not([data-hidden])")];
      const at = items.indexOf(document.activeElement);
      if (step && at >= 0 && !d.editing) {
        items[(at + step + items.length) % items.length].focus();
        e.preventDefault();
      }
    });

    const search = h("div", { class: "dsearch" }, null, [
      this.svg(["M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z", "M20 20l-4-4"], 15, 2),
      h("input", { id: "tabora-drawer-search", type: "search", autocomplete: "off", placeholder: tt`Поиск` }),
      h("kbd", {}, "/"),
    ]);
    const filterBtn = h("button", { class: "dfilter", id: "tabora-drawer-filter", type: "button", "aria-pressed": "false" }, null, [
      this.svg(["M4 6h16", "M7 12h10", "M10 18h4"], 14, 2),
      h("span", {}, tt`Фильтр`),
    ]);
    const close = this.iconButton("tabora-drawer-close", tt`Закрыть (Esc)`, ["M6 6l12 12", "M18 6 6 18"], () => this.closeDrawer());
    const head = h("header", { class: "dhead" }, null, [search, filterBtn, close]);
    const chips = h("div", { class: "dchips", id: "tabora-drawer-chips", hidden: "true" });
    const body = h("div", { class: "dbody", id: "tabora-drawer-body" });
    const foot = h("footer", { class: "dfoot", id: "tabora-drawer-foot", hidden: "true" });
    const panel = h("section", { class: "dpanel" }, null, [head, chips, body, foot]);
    const inner = h("div", { class: "inner" }, null, [rail, panel]);
    const el = h("div", { id: "tabora-drawer", role: "complementary", "aria-label": tt`Ящик` }, null, [inner]);

    const toolbox = document.getElementById("navigator-toolbox");
    toolbox.after(el);
    d.el = el;
    d.inner = inner;
    d.body = body;

    search.querySelector("input").addEventListener("input", e => {
      d.query = e.target.value.trim();
      clearTimeout(d.timer);
      d.timer = setTimeout(() => this.renderDrawer(), 120);
    });
    search.querySelector("input").addEventListener("keydown", e => {
      if (e.key === "Escape") {
        if (e.target.value) {
          e.target.value = "";
          d.query = "";
          this.renderDrawer();
        } else {
          this.closeDrawer();
        }
        e.stopPropagation();
      }
    });
    filterBtn.addEventListener("click", () => {
      const on = filterBtn.getAttribute("aria-pressed") !== "true";
      filterBtn.setAttribute("aria-pressed", String(on));
      chips.hidden = !on;
      if (!on) {
        d.filter = "all";
        this.renderDrawer();
      }
    });
    el.addEventListener("keydown", e => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        if (d.open) {
          this.closeDrawer();
        } else {
          this.hideRail();
          gBrowser.selectedBrowser?.focus();
        }
        e.stopPropagation();
      } else if (e.key === "/" && e.target.localName !== "input") {
        search.querySelector("input").focus();
        e.preventDefault();
      }
    });
    el.addEventListener("transitionend", e => {
      if (e.target === el && e.propertyName === "width" && !d.open && !d.rail) {
        el.hidden = true;
      }
    });
    window.addEventListener("resize", () => this.sizeDrawer());

    this.renderRail();
    const pinned = () => this.syncRail();
    Services.prefs.addObserver(this.RAIL_PINNED_PREF, pinned);
    window.addEventListener("unload", () => Services.prefs.removeObserver(this.RAIL_PINNED_PREF, pinned), { once: true });
    this.syncRail({ animate: false });
    // раздел-страница отмечен на рейке, пока его страница перед глазами
    gBrowser.tabContainer.addEventListener("TabSelect", () => this.syncRailCurrent());
    gBrowser.addTabsProgressListener({
      onLocationChange: browser => {
        if (browser === gBrowser.selectedBrowser) {
          this.syncRailCurrent();
        }
      },
    });

    // Все пути к «Библиотеке» ведут в ящик
    BrowserCommands.downloadsUI = () => this.openDrawer("downloads");
    const placesOriginal = PlacesCommandHook.showPlacesOrganizer.bind(PlacesCommandHook);
    PlacesCommandHook.showPlacesOrganizer = item => {
      if (item === "History") {
        this.openDrawer("history");
      } else if (item === "Downloads") {
        this.openDrawer("downloads");
      } else if (item === "AllBookmarks" || item === "BookmarksToolbar" || item === "BookmarksMenu" || item === "UnfiledBookmarks") {
        this.openDrawer("bookmarks");
      } else {
        placesOriginal(item);
      }
    };

    // Актор медиа и страницы для агента: только обычные сайты в веб-процессах
    // (не about:, chrome:, file:, страницы дополнений и привилегированные процессы).
    try {
      ChromeUtils.registerWindowActor("TaboraMedia", {
        parent: { esModuleURI: "chrome://tabora/content/actors/TaboraMediaParent.sys.mjs" },
        child: { esModuleURI: "chrome://tabora/content/actors/TaboraMediaChild.sys.mjs" },
        allFrames: false,
        matches: ["http://*/*", "https://*/*"],
        remoteTypes: ["web"],
        messageManagerGroups: ["browsers"],
        safeForUntrustedWebProcess: true,
      });
    } catch (e) {
      // уже зарегистрирован другим окном
    }

    gBrowser.tabContainer.addEventListener("TabOpen", () => this.drawerDirty("spaces", "media"));
    gBrowser.tabContainer.addEventListener("TabClose", () => this.drawerDirty("spaces", "media"));
    gBrowser.tabContainer.addEventListener("TabAttrModified", () => this.drawerDirty("spaces"));
  },

  iconButton(id, title, paths, onClick, size = 15) {
    const b = this.html("button", { class: "icon-btn", id, type: "button", title, "aria-label": title }, null, [this.svg(paths, size, 2)]);
    b.addEventListener("click", e => {
      e.stopPropagation();
      onClick(e);
    });
    return b;
  },

  REMOVED_PREF: "tabora.drawer.removed",

  /** Разделы, которые пользователь убрал сам. Новые разделы (появившиеся в обновлении) сюда не попадают. */
  removedSections() {
    let removed = null;
    try {
      removed = JSON.parse(Services.prefs.getStringPref(this.REMOVED_PREF, "null"));
    } catch (e) {}
    if (Array.isArray(removed)) {
      return removed;
    }
    // старый профиль: списка убранных нет, считаем убранными только те из прежнего набора, которых нет в сохранённом списке
    let saved = null;
    try {
      saved = JSON.parse(Services.prefs.getStringPref(this.SECTIONS_PREF, "null"));
    } catch (e) {}
    if (!Array.isArray(saved) || !saved.length) {
      return [];
    }
    const legacy = ["wallet", "downloads", "history", "media", "spaces", "bookmarks"];
    return legacy.filter(id => !saved.includes(id));
  },

  visibleSections() {
    let list = null;
    try {
      list = JSON.parse(Services.prefs.getStringPref(this.SECTIONS_PREF, "null"));
    } catch (e) {}
    if (!Array.isArray(list) || !list.length) {
      list = [...this.SECTION_ORDER];
    }
    list = list.filter(id => this.SECTIONS[id]);
    // разделы, появившиеся после сохранения списка, встают на своё место в порядке по умолчанию
    const removed = this.removedSections();
    for (const id of this.SECTION_ORDER) {
      if (list.includes(id) || removed.includes(id)) {
        continue;
      }
      const after = this.SECTION_ORDER.slice(0, this.SECTION_ORDER.indexOf(id)).filter(x => list.includes(x)).pop();
      list.splice(after ? list.indexOf(after) + 1 : 0, 0, id);
    }
    return list;
  },

  saveSections(list) {
    Services.prefs.setStringPref(this.SECTIONS_PREF, JSON.stringify(list));
    Services.prefs.setStringPref(this.REMOVED_PREF, JSON.stringify(this.SECTION_ORDER.filter(id => !list.includes(id))));
    this.renderRail();
  },

  renderRail() {
    const d = this.drawer;
    const box = document.getElementById("tabora-rail-items");
    const visible = this.visibleSections();
    const hidden = this.SECTION_ORDER.filter(id => !visible.includes(id));
    box.replaceChildren();
    const make = (id, isHidden) => {
      const s = this.SECTIONS[id];
      const b = this.html("button", { class: "rail-item", type: "button", "data-section": id, title: `${s.label} (${s.key})`, "aria-selected": String(!isHidden && this.railCurrent(id)) }, null, [
        this.svg(s.icon, 18, 1.7),
        this.html("span", {}, s.short || s.label),
      ]);
      if (isHidden) {
        b.setAttribute("data-hidden", "true");
      } else if (s.badge) {
        b.append(this.html("span", { class: "rail-pill", "data-badge": s.badge, hidden: "true" }));
        if (s.badge === "downloads") {
          b.append(this.html("span", { class: "rail-bar", "data-badge": "progress", "aria-hidden": "true", hidden: "true" }, null, [this.html("span")]));
          // ссылку можно бросить на раздел: она скачается, как раньше с карточки загрузок
          b.addEventListener("dragover", e => {
            if (e.dataTransfer.types.includes("text/uri-list") || e.dataTransfer.types.includes("text/plain")) {
              e.preventDefault();
              b.toggleAttribute("drop", true);
            }
          });
          b.addEventListener("dragleave", () => b.removeAttribute("drop"));
          b.addEventListener("drop", e => {
            e.preventDefault();
            b.removeAttribute("drop");
            this.downloadFromDrop(e.dataTransfer);
          });
        }
      }
      const ctl = this.html("span", { class: "rail-ctl", title: isHidden ? tt`Вернуть раздел` : tt`Убрать раздел` }, null, [
        this.svg(isHidden ? ["M12 5v14", "M5 12h14"] : ["M6 6l12 12", "M18 6 6 18"], 11, 2.4),
      ]);
      ctl.addEventListener("click", e => {
        e.stopPropagation();
        if (isHidden) {
          this.saveSections([...visible, id]);
        } else {
          const rest = visible.filter(x => x !== id);
          if (!rest.length) {
            return;
          }
          if (d.section === id) {
            // панель переходит к первому оставшемуся разделу с панелью
            const next = rest.find(x => !this.SECTIONS[x].page);
            if (next) {
              this.setDrawerSection(next);
              this.renderDrawer();
            } else if (d.open) {
              d.open = false;
              this.applyDrawer();
            }
          }
          this.saveSections(rest);
        }
      });
      b.append(ctl);
      b.addEventListener("click", () => {
        if (d.editing || this._railDragged) {
          return;
        }
        this.toggleDrawer(id);
      });
      // Перестановка в режиме правки: тянем указателем, соседи раздвигаются
      b.addEventListener("pointerdown", e => {
        if (!d.editing || isHidden || e.button !== 0 || e.target.closest(".rail-ctl")) {
          return;
        }
        this.railDrag(b, e, visible);
      });
      return b;
    };
    visible.forEach(id => box.append(make(id, false)));
    if (d.editing) {
      hidden.forEach(id => box.append(make(id, true)));
    }
    this.paintBadges();
  },

  /** Раздел отмечен на рейке: открыта его панель или его страница стоит перед глазами. */
  railCurrent(id) {
    const d = this.drawer;
    const s = this.SECTIONS[id];
    return s.page ? !d.open && !!s.current?.() : d.open && d.section === id;
  },

  syncRailCurrent() {
    for (const b of document.querySelectorAll("#tabora-rail-items .rail-item:not([data-hidden])")) {
      b.setAttribute("aria-selected", String(this.railCurrent(b.dataset.section)));
    }
  },

  /* ---- События разделов ---------------------------------------------------------------
   * То, что произошло и ещё не просмотрено: новые письма (mail), поступления в кошелёк
   * (wallet), загрузки — идущие и законченные, но не просмотренные (downloads). Число стоит на
   * своём разделе рейки и на значке в строке адреса, сумма всех — на кнопке «Разделы», число
   * писем — ещё и на вкладке почты. Элемент с атрибутом data-badge получает значение: имя
   * раздела — его число, total — сумму, progress — полоску хода загрузок (active — идут ли они). */
  badges: { mail: 0, wallet: 0, downloads: 0, active: 0, progress: null, running: false },
  BADGE_SECTIONS: ["mail", "wallet", "downloads"],

  setBadges(patch) {
    Object.assign(this.badges, patch);
    this.paintBadges();
  },

  paintBadges() {
    const b = this.badges;
    const text = n => (n > 99 ? "99+" : String(n));
    const total = this.BADGE_SECTIONS.reduce((n, id) => n + (b[id] || 0), 0);
    for (const el of document.querySelectorAll("[data-badge]")) {
      const kind = el.dataset.badge;
      if (kind === "progress") {
        el.hidden = !b.active;
        el.toggleAttribute("paused", !b.running);
        const fill = el.firstElementChild;
        fill.style.width = `${b.progress ?? 100}%`;
        fill.classList.toggle("indeterminate", b.progress === null && b.running);
      } else {
        const n = kind === "total" ? total : b[kind] || 0;
        el.textContent = text(n);
        el.hidden = !n;
      }
    }
    const button = document.getElementById("tabora-sections");
    if (button) {
      const parts = [];
      if (b.mail) {
        parts.push(`${b.mail} ${this.plural(b.mail, tt`новое письмо|новых письма|новых писем`)}`);
      }
      if (b.wallet) {
        parts.push(tt`${b.wallet} ${this.plural(b.wallet, tt`поступление|поступления|поступлений`)} в кошелёк`);
      }
      if (b.downloads) {
        parts.push(`${b.downloads} ${this.plural(b.downloads, tt`загрузка|загрузки|загрузок`)}${b.active && b.progress !== null ? `, ${b.progress}%` : ""}`);
      }
      button.dataset.note = parts.join(" · ");
      button.title = parts.length ? tt`Разделы: ${parts.join(" · ")}` : tt`Разделы`;
    }
    this.syncMailTabs?.();
  },

  /* ---- Рейка без панели и закрепление --------------------------------------------------- */

  // методы, а не свойства с get: Object.assign скопировал бы значение, вычисленное один раз
  railPinned() {
    return Services.prefs.getBoolPref(this.RAIL_PINNED_PREF, false);
  },

  /** Закреплённая рейка держится на экране, пока окно не узкое: там место нужнее странице. */
  railHeld() {
    return this.railPinned() && !this.narrowQuery.matches;
  },

  setRailPinned(on) {
    if (on) {
      this.drawer.rail = true; // рейка уже на экране: остаётся и после закрытия панели
    }
    Services.prefs.setBoolPref(this.RAIL_PINNED_PREF, on);
  },

  /** Приводит рейку к настройке и ширине окна (запуск, смена настройки, узкое окно). */
  syncRail({ animate = true } = {}) {
    const d = this.drawer;
    const held = this.railHeld();
    document.documentElement.toggleAttribute("tabora-rail-held", held);
    const pin = document.getElementById("tabora-rail-pin");
    if (pin) {
      const title = this.railPinned() ? tt`Открепить рейку` : tt`Закрепить рейку`;
      pin.title = title;
      pin.setAttribute("aria-label", title);
      pin.setAttribute("aria-pressed", String(this.railPinned()));
    }
    if (this.railPinned()) {
      d.rail = held;
    }
    this.applyDrawer({ animate });
  },

  showRail() {
    const d = this.drawer;
    d.rail = true;
    this.applyDrawer();
    this.syncRailCurrent();
    document.querySelector("#tabora-rail-items .rail-item")?.focus({ preventScroll: true });
  },

  /** Прячет рейку вместе с открытой панелью. Закреплённая рейка остаётся. */
  hideRail() {
    const d = this.drawer;
    if (d.open) {
      this.closeDrawer();
    }
    if (this.railHeld() || !d.rail) {
      return;
    }
    d.rail = false;
    d.editing = false;
    d.el.removeAttribute("editing");
    this.applyDrawer();
    this.renderRail();
  },

  /** Кнопка «Разделы»: показывает рейку; повторное нажатие прячет её (закреплённую — открепляет). */
  toggleRail() {
    const d = this.drawer;
    if (!d.open && !d.rail) {
      this.showRail();
      return;
    }
    if (this.railPinned()) {
      Services.prefs.setBoolPref(this.RAIL_PINNED_PREF, false);
    }
    this.hideRail();
    gBrowser.selectedBrowser?.focus();
  },

  /** Показывает то, что задано состоянием: ничего, одну рейку или рейку с панелью. */
  applyDrawer({ animate = true } = {}) {
    const d = this.drawer;
    const shown = d.open || d.rail;
    if (shown && d.el.hidden) {
      d.el.hidden = false;
      d.el.getBoundingClientRect(); // кадр на раскладку, затем движение
    }
    if (!animate) {
      d.el.setAttribute("still", "true");
    }
    d.el.toggleAttribute("open", shown);
    d.el.toggleAttribute("panel", d.open);
    const panel = d.el.querySelector(".dpanel");
    panel.inert = !d.open;
    document.getElementById("browser").toggleAttribute("tabora-drawer-open", d.open);
    document.getElementById("tabora-sections")?.setAttribute("aria-pressed", String(shown));
    this.sizeDrawer();
    if (!animate) {
      d.el.getBoundingClientRect();
      d.el.removeAttribute("still");
      if (!shown) {
        d.el.hidden = true;
      }
    }
  },

  railDrag(item, e, order) {
    const box = item.parentNode;
    const items = [...box.querySelectorAll('.rail-item:not([data-hidden])')];
    const from = items.indexOf(item);
    const startY = e.clientY;
    const step = item.getBoundingClientRect().height + 6;
    let to = from;
    let moved = false;
    const place = () => {
      items.forEach((it, i) => {
        if (it === item) {
          return;
        }
        let shift = 0;
        if (from < to && i > from && i <= to) {
          shift = -step;
        } else if (to < from && i >= to && i < from) {
          shift = step;
        }
        it.setAttribute("shifting", "true");
        it.style.transform = shift ? `translateY(${shift}px)` : "";
      });
    };
    const onMove = ev => {
      const dy = ev.clientY - startY;
      if (!moved && Math.abs(dy) < 4) {
        return;
      }
      if (!moved) {
        moved = true;
        item.setAttribute("dragging", "true");
        item.setPointerCapture(e.pointerId);
      }
      item.style.transform = `translateY(${dy}px)`;
      to = Math.max(0, Math.min(items.length - 1, from + Math.round(dy / step)));
      place();
    };
    const onUp = () => {
      item.removeEventListener("pointermove", onMove);
      item.removeEventListener("pointerup", onUp);
      item.removeEventListener("pointercancel", onUp);
      items.forEach(it => {
        it.style.transform = "";
        it.removeAttribute("shifting");
      });
      item.removeAttribute("dragging");
      if (moved && to !== from) {
        const list = [...order];
        const [id] = list.splice(from, 1);
        list.splice(to, 0, id);
        this.saveSections(list);
      }
      if (moved) {
        this._railDragged = true;
        setTimeout(() => (this._railDragged = false), 0);
      }
    };
    item.addEventListener("pointermove", onMove);
    item.addEventListener("pointerup", onUp);
    item.addEventListener("pointercancel", onUp);
  },

  setDrawerEditing(on) {
    const d = this.drawer;
    d.editing = on;
    d.el.toggleAttribute("editing", on);
    this.renderRail();
    if (on && !d.open && !d.rail) {
      this.showRail();
    }
  },

  /** Ширина ящика. Обычный раздел занимает DRAWER_WIDTH рядом со страницей. Широкий раздел и
   * любой раздел в узком окне, где странице рядом не остаётся PAGE_MIN, занимают всю область
   * страницы: она на это время скрыта. */
  PAGE_MIN: 360,

  sizeDrawer() {
    const d = this.drawer;
    const browser = document.getElementById("browser");
    if (!d.open) {
      // панели нет: рейка сама по себе или ничего
      d.el.style.width = d.rail ? `${this.DRAWER_RAIL}px` : "0px";
      d.el.removeAttribute("wide");
      d.el.removeAttribute("full");
      browser.removeAttribute("tabora-drawer-wide");
      browser.removeAttribute("tabora-drawer-full");
      return;
    }
    const wide = !!this.SECTIONS[d.section]?.wide;
    const toolbox = document.getElementById("navigator-toolbox");
    const cs = getComputedStyle(browser);
    const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
    // при вкладках сверху колонки слева нет: ящик занимает всю ширину под верхними строками
    const column = this.horizontalTabs ? -10 : toolbox.getBoundingClientRect().width;
    let room = Math.round(browser.getBoundingClientRect().width - pad - column - 10);
    // открытая панель агента занимает часть этого места; в узком окне она занимает его целиком,
    // и тогда ящик открывается вместо неё
    const agent = document.getElementById("tabora-agent");
    if (agent?.hasAttribute("open")) {
      if (!wide && window.matchMedia("(max-width: 840px)").matches) {
        this.toggleAgent(false);
      } else {
        room -= Math.round(agent.getBoundingClientRect().width) + 10;
      }
    }
    const full = wide || room < this.DRAWER_WIDTH + this.PAGE_MIN;
    const width = full ? (wide ? Math.max(this.DRAWER_WIDTH, room) : Math.max(280, room)) : this.DRAWER_WIDTH;
    d.el.style.width = `${width}px`;
    d.inner.style.width = `${width}px`;
    d.el.toggleAttribute("wide", wide);
    d.el.toggleAttribute("full", full && !wide);
    browser.toggleAttribute("tabora-drawer-wide", wide);
    browser.toggleAttribute("tabora-drawer-full", full && !wide);
  },

  openDrawer(section) {
    const d = this.drawer;
    const s = section && this.SECTIONS[section];
    if (s?.page) {
      // у раздела нет панели: открывается его страница
      if (!s.current?.()) {
        this[s.page]();
      }
      return;
    }
    if (s && !this.visibleSections().includes(section)) {
      this.saveSections([...this.visibleSections(), section]);
    }
    if (!d.open) {
      d.open = true;
      this.applyDrawer();
    }
    if (s) {
      this.setDrawerSection(section);
    } else {
      this.renderRail();
      this.sizeDrawer();
    }
    this.renderDrawer();
    const input = document.getElementById("tabora-drawer-search");
    if (input && !this.SECTIONS[d.section].wide && !this.SECTIONS[d.section].noSearch) {
      input.focus({ preventScroll: true });
    }
  },

  /** Закрывает панель. Рейка остаётся, только если закреплена. */
  closeDrawer() {
    const d = this.drawer;
    if (!d.open) {
      return;
    }
    d.open = false;
    d.rail = this.railHeld();
    d.editing = false;
    d.el.removeAttribute("editing");
    this.applyDrawer();
    this.renderRail();
    gBrowser.selectedBrowser?.focus();
  },

  toggleDrawer(section) {
    const d = this.drawer;
    const s = this.SECTIONS[section];
    if (s?.page) {
      this[s.page]();
      // рейку показывали, чтобы выбрать раздел: выбран — она уходит
      if (!d.open) {
        this.hideRail();
      }
      return;
    }
    if (d.open && d.section === section) {
      this.closeDrawer();
    } else {
      this.openDrawer(section);
    }
  },

  setDrawerSection(id) {
    const d = this.drawer;
    if (d.section !== id) {
      d.section = id;
      d.query = "";
      d.filter = "all";
      const input = document.getElementById("tabora-drawer-search");
      if (input) {
        input.value = "";
      }
      document.getElementById("tabora-drawer-filter")?.setAttribute("aria-pressed", "false");
      document.getElementById("tabora-drawer-chips").hidden = true;
      Services.prefs.setStringPref(this.SECTION_PREF, id);
    }
    this.renderRail();
    if (d.open) {
      this.sizeDrawer();
    }
  },

  drawerDirty(...sections) {
    const d = this.drawer;
    for (const s of sections) {
      delete d.cache[s];
    }
    if (d.open && sections.includes(d.section)) {
      clearTimeout(d.timer);
      d.timer = setTimeout(() => this.renderDrawer(), 60);
    }
  },

  /* ---- Отрисовка разделов ----------------------------------------------- */

  async renderDrawer() {
    const d = this.drawer;
    if (!d.open) {
      return;
    }
    const s = this.SECTIONS[d.section];
    const panel = d.el.querySelector(".dpanel");
    panel.setAttribute("data-section", d.section);
    // раздел перед глазами: его события просмотрены
    if (d.section === "wallet") {
      this.walletSeen?.();
    } else if (d.section === "downloads") {
      this.downloadsSeen?.();
    }
    const input = document.getElementById("tabora-drawer-search");
    input.placeholder = s.search || tt`Поиск`;
    panel.querySelector(".dhead").hidden = !!s.wide || !!s.noSearch;
    panel.querySelector(".dchips").hidden = true;
    const foot = document.getElementById("tabora-drawer-foot");
    foot.replaceChildren();
    foot.hidden = true;
    const seq = (d.seq = (d.seq || 0) + 1);
    const render = this[`drawer_${d.section}`];
    if (!render) {
      return;
    }
    try {
      await render.call(this, seq);
    } catch (e) {
      console.error("Tabora drawer", d.section, e);
      d.body.replaceChildren(this.drawerEmpty(tt`Не удалось загрузить раздел`, String(e.message || e)));
    }
  },

  drawerEmpty(title, sub) {
    return this.html("div", { class: "dempty" }, null, [
      this.html("b", {}, title),
      sub ? this.html("span", {}, sub) : this.html("span"),
    ]);
  },

  drawerChips(options, current, onPick) {
    const chips = document.getElementById("tabora-drawer-chips");
    chips.replaceChildren(
      ...options.map(([id, label]) => {
        const b = this.html("button", { class: "chip", type: "button", "aria-pressed": String(id === current) }, label);
        b.addEventListener("click", () => onPick(id));
        return b;
      })
    );
  },

  drawerFoot(label, onClick, paths) {
    const foot = document.getElementById("tabora-drawer-foot");
    const b = this.html("button", { class: "dfull", type: "button" }, null, [
      this.html("span", {}, label),
      this.svg(paths || ["M14 4h6v6", "M20 4l-9 9", "M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"], 14, 2),
    ]);
    b.addEventListener("click", onClick);
    foot.append(b);
    foot.hidden = false;
  },

  dayLabel(date) {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const t = date.getTime();
    if (t >= start) {
      return tt`Сегодня`;
    }
    if (t >= start - 86400000) {
      return tt`Вчера`;
    }
    if (t >= start - 6 * 86400000) {
      return date.toLocaleDateString(ttLocale(), { weekday: "long" });
    }
    return date.toLocaleDateString(ttLocale(), { day: "numeric", month: "long" });
  },

  timeLabel(date) {
    return date.toLocaleTimeString(ttLocale(), { hour: "2-digit", minute: "2-digit" });
  },

  favicon(url) {
    return this.html("img", { class: "fav", src: `page-icon:${url}`, alt: "" });
  },

  rowNode({ icon, title, sub, meta, actions = [], onClick, onContext, draggable }) {
    const row = this.html("div", { class: "drow", role: "button", tabindex: "0" }, null, [
      this.html("span", { class: "dicon" }, null, [icon]),
      this.html("span", { class: "dtext" }, null, [
        this.html("span", { class: "dtitle" }, title),
        sub ? this.html("span", { class: "dsub" }, null, Array.isArray(sub) ? sub : [sub]) : this.html("span", { class: "dsub" }, ""),
      ]),
      meta ? this.html("span", { class: "dmeta" }, meta) : this.html("span", { class: "dmeta" }),
      this.html("span", { class: "dacts" }, null, actions.filter(Boolean).map(a => {
        const b = this.html("button", { class: `icon-btn ${a.danger ? "danger" : ""}`.trim(), type: "button", title: a.title, "aria-label": a.title }, null, [this.svg(a.icon, 14, 2)]);
        b.addEventListener("click", e => {
          e.stopPropagation();
          a.run();
        });
        return b;
      })),
    ]);
    if (onClick) {
      row.addEventListener("click", onClick);
      row.addEventListener("keydown", e => {
        if (e.key === "Enter") {
          onClick(e);
        }
      });
    }
    if (onContext) {
      row.addEventListener("contextmenu", e => {
        e.preventDefault();
        this.showMenu(onContext(), e.clientX, e.clientY);
      });
    }
    if (draggable) {
      row.draggable = true;
      row.addEventListener("dragstart", draggable);
    }
    return row;
  },

  groupNode(label, count) {
    return this.html("div", { class: "dgroup" }, null, [
      this.html("span", {}, label),
      count !== undefined ? this.html("span", { class: "n" }, String(count)) : this.html("span"),
    ]);
  },

  matches(query, ...fields) {
    if (!query) {
      return true;
    }
    const q = query.toLowerCase();
    return fields.some(f => (f || "").toLowerCase().includes(q));
  },

  /* ---- Загрузки ------------------------------------------------------------ */

  async drawer_downloads(seq) {
    const d = this.drawer;
    if (!this._dl) {
      await this.initDownloads();
    }
    const all = (await this._dl.list.getAll()).slice().sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
    if (seq !== d.seq) {
      return;
    }
    this.drawerChips([["all", tt`Все`], ["active", tt`Идут`], ["done", tt`Готовые`], ["failed", tt`С ошибкой`]], d.filter, id => {
      d.filter = id;
      this.renderDrawer();
    });
    const stateOf = dl => (!dl.stopped ? "active" : dl.succeeded ? "done" : dl.canceled && dl.hasPartialData ? "paused" : "failed");
    const list = all.filter(dl => {
      const name = PathUtils.filename(dl.target.path);
      const st = stateOf(dl);
      if (d.filter === "active" && st !== "active" && st !== "paused") {
        return false;
      }
      if (d.filter === "done" && st !== "done") {
        return false;
      }
      if (d.filter === "failed" && st !== "failed") {
        return false;
      }
      return this.matches(d.query, name, dl.source.url);
    });
    const frag = document.createDocumentFragment();
    if (!list.length) {
      frag.append(this.drawerEmpty(d.query ? tt`Ничего не найдено` : tt`Пока ничего не скачано`, d.query ? "" : tt`Файлы появятся здесь сразу, как начнётся загрузка`));
    }
    let lastDay = "";
    for (const dl of list) {
      const date = new Date(dl.startTime || Date.now());
      const day = this.dayLabel(date);
      if (day !== lastDay) {
        frag.append(this.groupNode(day));
        lastDay = day;
      }
      const st = stateOf(dl);
      const name = PathUtils.filename(dl.target.path);
      const host = this.hostOf(dl.source.url);
      const icon = this.html("img", { class: "fileicon", src: `moz-icon://file://${encodeURI(dl.target.path)}?size=32`, alt: "" });
      let sub;
      if (st === "active") {
        const pct = dl.hasProgress ? `${Math.round(dl.progress)}%` : "";
        sub = [this.html("span", { class: "dprog" }, null, [this.html("span", { style: `width:${dl.hasProgress ? dl.progress : 100}%` })]), this.html("span", { class: "mono" }, `${pct}${dl.speed ? tt` · ${this.fmtBytes(dl.speed)}/с` : ""}`)];
      } else if (st === "paused") {
        sub = [this.html("span", { class: "mono" }, tt`на паузе · ${this.fmtBytes(dl.currentBytes)}`)];
      } else if (st === "failed") {
        sub = [this.html("span", { class: "warn" }, dl.error ? tt`ошибка загрузки` : tt`отменено`)];
      } else {
        sub = [this.html("span", { class: "mono" }, this.fmtBytes(dl.target.size || dl.currentBytes)), this.html("span", { class: "dot" }, "·"), this.html("span", {}, host)];
      }
      const actions = [];
      if (st === "active") {
        actions.push({ title: tt`Пауза`, icon: ["M8 5v14", "M16 5v14"], run: () => dl.cancel() });
        actions.push({ title: tt`Отменить`, icon: ["M6 6l12 12", "M18 6 6 18"], danger: true, run: () => dl.cancel().then(() => dl.removePartialData()).then(() => this._dl.list.remove(dl)) });
      } else if (st === "paused") {
        actions.push({ title: tt`Продолжить`, icon: ["M7 5v14l12-7z"], run: () => dl.start() });
      } else if (st === "done") {
        actions.push({ title: tt`Показать в Finder`, icon: ["M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"], run: () => dl.showContainingDirectory() });
        actions.push({ title: tt`Убрать из списка`, icon: ["M6 6l12 12", "M18 6 6 18"], run: () => this._dl.list.remove(dl).then(() => this.drawerDirty("downloads")) });
      } else {
        actions.push({ title: tt`Повторить`, icon: ["M20 12a8 8 0 1 1-2.3-5.7", "M20 4v5h-5"], run: () => dl.start().catch(() => {}) });
        actions.push({ title: tt`Убрать из списка`, icon: ["M6 6l12 12", "M18 6 6 18"], run: () => this._dl.list.remove(dl).then(() => this.drawerDirty("downloads")) });
      }
      frag.append(
        this.rowNode({
          icon,
          title: name,
          sub,
          meta: this.timeLabel(date),
          actions,
          onClick: () => {
            if (st === "done") {
              dl.launch().catch(() => {});
            }
          },
          onContext: () => [
            { label: tt`Открыть`, disabled: st !== "done", run: () => dl.launch().catch(() => {}) },
            { label: tt`Показать в Finder`, disabled: st !== "done", run: () => dl.showContainingDirectory() },
            { label: tt`Копировать ссылку`, run: () => this.copyText(dl.source.url, tt`Ссылка скопирована`) },
            { separator: true },
            { label: tt`Убрать из списка`, run: () => this._dl.list.remove(dl).then(() => this.drawerDirty("downloads")) },
          ],
          draggable: e => {
            if (st !== "done") {
              e.preventDefault();
              return;
            }
            const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
            file.initWithPath(dl.target.path);
            e.dataTransfer.mozSetDataAt("application/x-moz-file", file, 0);
            e.dataTransfer.setData("text/uri-list", `file://${encodeURI(dl.target.path)}`);
            e.dataTransfer.effectAllowed = "copyMove";
          },
        })
      );
    }
    d.body.replaceChildren(frag);
    this.drawerFoot(this.SECTIONS.downloads.full, () => {
      this.openDownloads();
    });
  },

  /* ---- История ------------------------------------------------------------ */

  async drawer_history(seq) {
    const d = this.drawer;
    this.drawerChips([["all", tt`Всё`], ["today", tt`Сегодня`], ["week", tt`Неделя`]], d.filter, id => {
      d.filter = id;
      this.renderDrawer();
    });
    const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
    const q = PlacesUtils.history.getNewQuery();
    if (d.query) {
      q.searchTerms = d.query;
    }
    const now = Date.now();
    if (d.filter === "today") {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      q.beginTime = start.getTime() * 1000;
      q.endTime = now * 1000;
    } else if (d.filter === "week") {
      q.beginTime = (now - 7 * 86400000) * 1000;
      q.endTime = now * 1000;
    }
    const opts = PlacesUtils.history.getNewQueryOptions();
    opts.sortingMode = opts.SORT_BY_DATE_DESCENDING;
    opts.resultType = opts.RESULTS_AS_URI;
    opts.maxResults = 300;
    opts.queryType = opts.QUERY_TYPE_HISTORY;
    const root = PlacesUtils.history.executeQuery(q, opts).root;
    root.containerOpen = true;
    const items = [];
    for (let i = 0; i < root.childCount; i++) {
      const node = root.getChild(i);
      if (this.isMailUrl(node.uri) || node.uri.startsWith("chrome://") || node.uri.startsWith("about:")) {
        continue;
      }
      items.push({ url: node.uri, title: node.title || this.hostOf(node.uri), time: new Date(node.time / 1000) });
    }
    root.containerOpen = false;
    // Pages visited on other devices of the account (history sync). They are only shown: this
    // computer's history is not changed by them. A page that was also opened here is added only
    // if the other device opened it later.
    try {
      const { Sync } = ChromeUtils.importESModule("chrome://tabora/content/sync/Sync.sys.mjs");
      const here = new Map(items.map(it => [it.url, it.time.getTime()]));
      const since = d.filter === "today" ? new Date().setHours(0, 0, 0, 0) : d.filter === "week" ? now - 7 * 86400000 : 0;
      for (const r of Sync.remoteHistory({ query: d.query || "", since, limit: 300 })) {
        if (!(here.get(r.url) >= r.at)) {
          items.push({ url: r.url, title: r.title || this.hostOf(r.url), time: new Date(r.at), device: r.device || tt`Другое устройство` });
        }
      }
      items.sort((a, b) => b.time - a.time);
      items.splice(300);
    } catch (e) {
      console.error("Tabora history of other devices", e);
    }
    if (seq !== d.seq) {
      return;
    }
    const frag = document.createDocumentFragment();
    if (!items.length) {
      frag.append(this.drawerEmpty(d.query ? tt`Ничего не найдено` : tt`История пуста`, d.query ? "" : tt`Посещённые страницы появятся здесь`));
    }
    let lastDay = "";
    for (const it of items) {
      const day = this.dayLabel(it.time);
      if (day !== lastDay) {
        frag.append(this.groupNode(day));
        lastDay = day;
      }
      const where = this.hostOf(it.url) + (new URL(it.url).pathname.length > 1 ? new URL(it.url).pathname.replace(/\/$/, "") : "");
      const row = this.rowNode({
        icon: this.favicon(it.url),
        title: it.title,
        sub: it.device ? [this.html("span", { class: "tag", title: tt`Открыто на другом устройстве` }, it.device), this.html("span", {}, where)] : where,
        meta: this.timeLabel(it.time),
        actions: [
          // a page of another device is not in this computer's history: there is nothing to delete here
          it.device ? null : { title: tt`Удалить из истории`, icon: ["M4 7h16", "M10 11v6M14 11v6", "M6 7l1 13h10l1-13", "M9 7V4h6v3"], danger: true, run: async () => {
            await PlacesUtils.history.remove(it.url);
            row.remove();
          } },
          { title: tt`Открыть в новой вкладке`, icon: ["M14 4h6v6", "M20 4l-9 9", "M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"], run: () => this.openInSpace(it.url, true) },
        ],
        onClick: () => this.openInSpace(it.url, false),
        onContext: () => [
          { label: tt`Открыть`, run: () => this.openInSpace(it.url, false) },
          { label: tt`Открыть в новой вкладке`, run: () => this.openInSpace(it.url, true) },
          { label: tt`Копировать ссылку`, run: () => this.copyText(it.url, tt`Ссылка скопирована`) },
          ...(it.device
            ? []
            : [
                { separator: true },
                { label: tt`Удалить из истории`, danger: true, run: async () => {
                  await PlacesUtils.history.remove(it.url);
                  row.remove();
                } },
                { label: tt`Забыть этот сайт`, danger: true, run: async () => {
                  const { ForgetAboutSite } = ChromeUtils.importESModule("resource://gre/modules/ForgetAboutSite.sys.mjs");
                  await ForgetAboutSite.removeDataFromBaseDomain(this.hostOf(it.url));
                  this.drawerDirty("history");
                  this.renderDrawer();
                } },
              ]),
        ],
        draggable: e => {
          e.dataTransfer.setData("text/uri-list", it.url);
          e.dataTransfer.setData("text/plain", it.url);
        },
      });
      frag.append(row);
    }
    d.body.replaceChildren(frag);
    this.drawerFoot(tt`Удалить историю за сегодня`, async () => {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      await PlacesUtils.history.removeByFilter({ beginDate: start, endDate: new Date() });
      this.notice(tt`История за сегодня удалена`);
      this.renderDrawer();
    }, ["M4 7h16", "M10 11v6M14 11v6", "M6 7l1 13h10l1-13", "M9 7V4h6v3"]);
  },

  /** Открыть адрес из истории, закладок или кошелька. Сайты открываются с нулевым принципалом
   * в контейнере пространства; системный принципал — только для своих внутренних страниц
   * из закладок (about:, chrome:, file:), которые пользователь сохранил сам. */
  openInSpace(url, newTab) {
    const spec = String(url || "").trim();
    if (!spec || /^(javascript|data|blob|view-source|jar):/i.test(spec)) {
      return;
    }
    const space = this.activeSpace();
    if (newTab) {
      const userContextId = space?.userContextId || 0;
      const web = /^https?:/i.test(spec);
      gBrowser.selectedTab = gBrowser.addTab(spec, {
        userContextId,
        triggeringPrincipal: web ? Services.scriptSecurityManager.createNullPrincipal({ userContextId }) : Services.scriptSecurityManager.getSystemPrincipal(),
      });
    } else {
      this.openUrl(spec);
    }
  },

  /** Адрес со страницы: только http(s) и без логина в адресе. Иначе пустая строка. */
  mediaWebUrl(spec) {
    try {
      const u = new URL(String(spec || ""));
      return (u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password ? u.href : "";
    } catch (e) {
      return "";
    }
  },

  /** Элемент медиа от актора страницы: проверяем всё, что пришло из контент-процесса. */
  mediaItem(raw, tab, principal) {
    const src = this.mediaWebUrl(raw?.src);
    if (!src) {
      return null;
    }
    const thumb = typeof raw.thumb === "string" && raw.thumb.length < 400000 && /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+=*$/.test(raw.thumb) ? raw.thumb : "";
    const kind = raw.kind === "video" ? "video" : "image";
    if (kind === "image" && !thumb) {
      return null;
    }
    const num = v => (Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
    return {
      kind,
      src,
      thumb,
      page: this.mediaWebUrl(raw.page),
      title: String(raw.title || "").slice(0, 200),
      alt: String(raw.alt || "").slice(0, 200),
      w: num(raw.w),
      h: num(raw.h),
      tab,
      principal,
    };
  },

  /** Медиа открывается от имени страницы-источника: её принципал и её контейнер. */
  openMediaUrl(it) {
    const url = this.mediaWebUrl(it?.src);
    if (!url || !it.principal?.isContentPrincipal) {
      this.notice(tt`Этот адрес нельзя открыть`);
      return;
    }
    gBrowser.selectedTab = gBrowser.addTab(url, {
      userContextId: it.principal.originAttributes.userContextId || 0,
      triggeringPrincipal: it.principal,
    });
  },

  /* ---- Медиа ------------------------------------------------------------ */

  async drawer_media(seq) {
    const d = this.drawer;
    this.drawerChips([["all", tt`Всё`], ["image", tt`Картинки`], ["video", tt`Видео`], ["current", tt`Эта вкладка`]], d.filter, id => {
      d.filter = id;
      this.renderDrawer();
    });
    if (!d.cache.media) {
      d.body.replaceChildren(this.drawerEmpty(tt`Собираем медиа…`, tt`Со всех вкладок текущего пространства`));
      const space = this.activeSpace();
      const tabs = gBrowser.tabs.filter(t => !t.closing && !t.hasAttribute("pending") && (t.pinned || this.contextOf(t) === space.userContextId));
      const results = await Promise.all(
        tabs.map(async t => {
          try {
            const wg = t.linkedBrowser.browsingContext?.currentWindowGlobal;
            const principal = wg?.documentPrincipal;
            if (!wg || !principal?.isContentPrincipal) {
              return [];
            }
            // актор есть только у http(s)-страниц; миниатюры он рисует сам, в процессе страницы
            const items = await wg.getActor("TaboraMedia").sendQuery("TaboraMedia:Collect");
            return (Array.isArray(items) ? items : []).map(it => this.mediaItem(it, t, principal)).filter(Boolean);
          } catch (e) {
            return [];
          }
        })
      );
      d.cache.media = results.flat();
    }
    if (seq !== d.seq) {
      return;
    }
    const items = d.cache.media.filter(it => {
      if (d.filter === "image" && it.kind !== "image") {
        return false;
      }
      if (d.filter === "video" && it.kind !== "video") {
        return false;
      }
      if (d.filter === "current" && it.tab !== gBrowser.selectedTab) {
        return false;
      }
      return this.matches(d.query, it.alt, it.title, it.src, this.hostOf(it.page));
    });
    const frag = document.createDocumentFragment();
    if (!items.length) {
      frag.append(this.drawerEmpty(d.query ? tt`Ничего не найдено` : tt`Медиа не найдено`, tt`Откройте страницы с картинками или видео в этом пространстве`));
    }
    const grid = this.html("div", { class: "dgrid" });
    for (const it of items) {
      // в окне браузера показываем только готовую миниатюру data:image от актора, адреса со страницы не грузим
      const img = it.thumb
        ? this.html("img", { src: it.thumb, alt: it.alt, draggable: "false" })
        : this.html("span", { style: "display:flex;width:100%;height:100%;align-items:center;justify-content:center;color:var(--tabora-text-5)" }, null, [this.svg(["M4 6h16v12H4z", "M10 9.5v5l4.5-2.5z"], 28, 1.6)]);
      const tile = this.html("button", { class: "dtile", type: "button", title: `${it.alt || it.title}\n${this.hostOf(it.page)}${it.w ? ` · ${it.w}×${it.h}` : ""}` }, null, [
        img,
        it.kind === "video" ? this.html("span", { class: "play" }, null, [this.svg(["M8 5v14l11-7z"], 14, 2)]) : this.html("span"),
        this.html("span", { class: "dtile-meta" }, null, [this.favicon(it.page), this.html("span", {}, it.w ? `${it.w}×${it.h}` : it.kind === "video" ? tt`видео` : "")]),
      ]);
      img.addEventListener("error", () => tile.remove());
      tile.draggable = true;
      tile.addEventListener("dragstart", e => {
        e.dataTransfer.setData("text/uri-list", it.src);
        e.dataTransfer.setData("text/plain", it.src);
        e.dataTransfer.effectAllowed = "copy";
      });
      const menu = () => [
        { label: tt`Открыть в новой вкладке`, run: () => this.openMediaUrl(it) },
        { label: tt`Сохранить файл…`, run: () => this.saveMedia(it) },
        { label: tt`Копировать ссылку`, run: () => this.copyText(it.src, tt`Ссылка скопирована`) },
        { separator: true },
        { label: tt`К странице-источнику`, hint: this.hostOf(it.page), disabled: it.tab.closing || !it.tab.parentNode, run: () => { gBrowser.selectedTab = it.tab; } },
      ];
      tile.addEventListener("click", () => this.openMediaUrl(it));
      tile.addEventListener("contextmenu", e => {
        e.preventDefault();
        this.showMenu(menu(), e.clientX, e.clientY);
      });
      grid.append(tile);
    }
    frag.append(grid);
    d.body.replaceChildren(frag);
    const refresh = this.html("button", { class: "dfull", type: "button" }, null, [this.html("span", {}, tt`Обновить · ${items.length}`), this.svg(["M20 12a8 8 0 1 1-2.3-5.7", "M20 4v5h-5"], 14, 2)]);
    refresh.addEventListener("click", () => {
      delete d.cache.media;
      this.renderDrawer();
    });
    const foot = document.getElementById("tabora-drawer-foot");
    foot.append(refresh);
    foot.hidden = false;
  },

  /** Сохранение медиа от имени страницы-источника: её принципал, контейнер и адрес как referrer. */
  saveMedia(it) {
    const url = this.mediaWebUrl(it?.src);
    if (!url || !it.principal?.isContentPrincipal) {
      this.notice(tt`Этот файл нельзя сохранить`);
      return;
    }
    try {
      const { PrivateBrowsingUtils } = ChromeUtils.importESModule("resource://gre/modules/PrivateBrowsingUtils.sys.mjs");
      let referrerInfo = null;
      if (it.page) {
        const ReferrerInfo = Components.Constructor("@mozilla.org/referrer-info;1", "nsIReferrerInfo", "init");
        referrerInfo = new ReferrerInfo(Ci.nsIReferrerInfo.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, true, Services.io.newURI(it.page));
      }
      saveURL(url, null, null, null, true, true, referrerInfo, null, null, PrivateBrowsingUtils.isWindowPrivate(window), it.principal);
    } catch (e) {
      console.error("Tabora saveMedia", e);
      this.openMediaUrl(it);
    }
  },

  /* ---- Закладки ------------------------------------------------------------ */

  async drawer_bookmarks(seq) {
    const d = this.drawer;
    const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
    const frag = document.createDocumentFragment();
    const cur = gBrowser.selectedBrowser.currentURI.spec;
    const canAdd = /^https?:/.test(cur);
    const add = this.html("button", { class: "dprimary", type: "button", disabled: canAdd ? null : "true" }, null, [this.svg(["M12 5v14", "M5 12h14"], 14, 2.4), this.html("span", {}, tt`Добавить текущую`)]);
    if (!canAdd) {
      add.disabled = true;
    }
    add.addEventListener("click", async () => {
      await PlacesUtils.bookmarks.insert({ parentGuid: PlacesUtils.bookmarks.toolbarGuid, url: cur, title: gBrowser.selectedTab.label });
      this.notice(tt`Добавлено в закладки`);
      this.renderDrawer();
    });
    frag.append(this.html("div", { class: "dtoolbar" }, null, [add]));

    if (d.query) {
      const found = await PlacesUtils.bookmarks.search({ query: d.query });
      if (seq !== d.seq) {
        return;
      }
      if (!found.length) {
        frag.append(this.drawerEmpty(tt`Ничего не найдено`, ""));
      }
      for (const b of found.slice(0, 100)) {
        if (!b.url) {
          continue;
        }
        frag.append(this.bookmarkRow(b.guid, b.title || this.hostOf(b.url.href), b.url.href, PlacesUtils));
      }
      d.body.replaceChildren(frag);
      return;
    }

    const roots = [
      [PlacesUtils.bookmarks.toolbarGuid, tt`Панель закладок`],
      [PlacesUtils.bookmarks.menuGuid, tt`Меню закладок`],
      [PlacesUtils.bookmarks.unfiledGuid, tt`Другие`],
      [PlacesUtils.bookmarks.mobileGuid, tt`С телефона`],
    ];
    let total = 0;
    for (const [guid, label] of roots) {
      let tree;
      try {
        tree = await PlacesUtils.promiseBookmarksTree(guid);
      } catch (e) {
        continue;
      }
      if (!tree?.children?.length) {
        continue;
      }
      total += tree.children.length;
      frag.append(this.groupNode(label, this.countBookmarks(tree)));
      frag.append(this.bookmarkList(tree.children, PlacesUtils, 0));
    }
    if (seq !== d.seq) {
      return;
    }
    if (!total) {
      frag.append(this.drawerEmpty(tt`Закладок пока нет`, tt`Нажмите «Добавить текущую» или ⌘D на любой странице`));
    }
    d.body.replaceChildren(frag);
  },

  countBookmarks(node) {
    return (node.children || []).reduce((n, c) => n + (c.children ? this.countBookmarks(c) : c.uri ? 1 : 0), 0);
  },

  bookmarkList(children, PlacesUtils, depth) {
    const box = this.html("div", { class: "dlist", style: `--depth:${depth}` });
    for (const c of children) {
      if (c.type === "text/x-moz-place-separator") {
        box.append(this.html("div", { class: "dsep" }));
      } else if (c.type === "text/x-moz-place-container") {
        const open = depth === 0;
        const head = this.html("button", { class: "dfolder", type: "button", "aria-expanded": String(open) }, null, [
          this.svg(["m9 6 6 6-6 6"], 12, 2.4),
          this.svg(["M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"], 15, 1.8),
          this.html("span", {}, c.title || tt`Папка`),
          this.html("span", { class: "n" }, String(this.countBookmarks(c))),
        ]);
        const inner = this.bookmarkList(c.children || [], PlacesUtils, depth + 1);
        inner.hidden = !open;
        head.addEventListener("click", () => {
          const now = head.getAttribute("aria-expanded") !== "true";
          head.setAttribute("aria-expanded", String(now));
          inner.hidden = !now;
        });
        head.addEventListener("contextmenu", e => {
          e.preventDefault();
          this.showMenu([
            { label: tt`Открыть все во вкладках`, hint: String(this.countBookmarks(c)), run: () => this.openAll(c) },
            { separator: true },
            { label: tt`Удалить папку`, danger: true, run: async () => {
              await PlacesUtils.bookmarks.remove(c.guid);
              this.renderDrawer();
            } },
          ], e.clientX, e.clientY);
        });
        box.append(head, inner);
      } else if (c.uri) {
        box.append(this.bookmarkRow(c.guid, c.title || this.hostOf(c.uri), c.uri, PlacesUtils));
      }
    }
    return box;
  },

  openAll(folder) {
    const space = this.activeSpace();
    for (const c of folder.children || []) {
      if (c.uri) {
        gBrowser.addTab(c.uri, { userContextId: space?.userContextId || 0, triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      }
    }
  },

  bookmarkRow(guid, title, url, PlacesUtils) {
    const row = this.rowNode({
      icon: this.favicon(url),
      title,
      sub: this.hostOf(url),
      actions: [
        { title: tt`Удалить закладку`, icon: ["M4 7h16", "M10 11v6M14 11v6", "M6 7l1 13h10l1-13", "M9 7V4h6v3"], danger: true, run: async () => {
          await PlacesUtils.bookmarks.remove(guid);
          row.remove();
        } },
        { title: tt`Открыть в новой вкладке`, icon: ["M14 4h6v6", "M20 4l-9 9", "M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"], run: () => this.openInSpace(url, true) },
      ],
      onClick: () => this.openInSpace(url, false),
      onContext: () => [
        { label: tt`Открыть`, run: () => this.openInSpace(url, false) },
        { label: tt`Открыть в новой вкладке`, run: () => this.openInSpace(url, true) },
        { label: tt`Копировать ссылку`, run: () => this.copyText(url, tt`Ссылка скопирована`) },
        { separator: true },
        { label: tt`Переименовать…`, run: () => this.renameBookmark(row, guid, title, PlacesUtils) },
        { label: tt`Удалить закладку`, danger: true, run: async () => {
          await PlacesUtils.bookmarks.remove(guid);
          row.remove();
        } },
      ],
      draggable: e => {
        e.dataTransfer.setData("text/uri-list", url);
        e.dataTransfer.setData("text/plain", url);
      },
    });
    return row;
  },

  renameBookmark(row, guid, title, PlacesUtils) {
    const titleEl = row.querySelector(".dtitle");
    const input = this.html("input", { class: "dinline", type: "text", value: title });
    titleEl.replaceChildren(input);
    input.focus();
    input.select();
    const finish = async save => {
      const value = input.value.trim();
      if (save && value && value !== title) {
        await PlacesUtils.bookmarks.update({ guid, title: value });
        titleEl.textContent = value;
      } else {
        titleEl.textContent = title;
      }
    };
    input.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Enter") {
        finish(true);
      } else if (e.key === "Escape") {
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("click", e => e.stopPropagation());
  },

  /* ---- Пространства: полотно на всю ширину ----------------------------------- */

  SPACE_HEX: { blue: "#7cc4ff", turquoise: "#5ee0d0", green: "#7ddf6a", yellow: "#c8f25a", orange: "#ff9f5a", red: "#ff7b7b", pink: "#ff8fd1", purple: "#c39bff", toolbar: "#c9ccd3" },
  SPACE_COLOR_NAMES: { yellow: tt`Лайм`, blue: tt`Голубой`, turquoise: tt`Бирюза`, green: tt`Зелёный`, orange: tt`Оранжевый`, red: tt`Красный`, pink: tt`Розовый`, purple: tt`Фиолетовый` },

  spaceHex(space) {
    return this.SPACE_HEX[space.color] || this.SPACE_HEX.yellow;
  },

  async drawer_spaces(seq) {
    const d = this.drawer;
    const board = this.html("div", { class: "dboard" });
    const tabsOf = space => gBrowser.tabs.filter(t => !t.closing && !t.pinned && this.contextOf(t) === space.userContextId);
    this.spaces.forEach((space, index) => {
      const col = this.html("section", { class: "dcol", "data-space": space.id, style: `--space:${this.spaceHex(space)}` });
      if (space.id === this.activeSpaceId) {
        col.setAttribute("active", "true");
      }
      const name = this.html("span", { class: "dcol-name" }, space.name);
      const rename = this.iconButton("", tt`Переименовать`, ["M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17z", "M13.5 6.5l3 3"], () => this.renameSpace(space, name), 13);
      const head = this.html("header", { class: "dcol-head" }, null, [this.html("span", { class: "dcol-dot" }), name, this.html("span", { class: "dcol-count" }, String(tabsOf(space).length)), rename]);
      head.addEventListener("dblclick", () => this.renameSpace(space, name));
      const list = this.html("div", { class: "dcol-list" });
      const tabs = tabsOf(space);
      if (!tabs.length) {
        list.append(this.html("div", { class: "dcol-empty" }, tt`Перетащите вкладки сюда`));
      }
      for (const tab of tabs) {
        const url = tab.linkedBrowser?.currentURI?.spec || "";
        const row = this.html("div", { class: "dtab", draggable: "true", title: url }, null, [
          this.isStartUrl(url) ? this.html("span", { class: "start-dot" }) : this.favicon(url),
          this.html("span", { class: "dtab-title" }, tab.label || this.startLabel()),
          tab.hasAttribute("pending") ? this.html("span", { class: "zz" }, tt`спит`) : this.html("span"),
        ]);
        if (tab.selected) {
          row.setAttribute("selected", "true");
        }
        const close = this.iconButton("", tt`Закрыть вкладку`, ["M6 6l12 12", "M18 6 6 18"], () => gBrowser.removeTab(tab), 12);
        row.append(close);
        row.addEventListener("click", () => {
          this.switchSpace(space.id);
          gBrowser.selectedTab = tab;
          this.closeDrawer();
        });
        row.addEventListener("dragstart", e => {
          this._dragTab = tab;
          e.dataTransfer.setData("tabora/tab", String(tab._tPos));
          e.dataTransfer.effectAllowed = "move";
          row.setAttribute("dragging", "true");
        });
        row.addEventListener("dragend", () => {
          row.removeAttribute("dragging");
          this._dragTab = null;
        });
        row.addEventListener("contextmenu", e => {
          e.preventDefault();
          this.showMenu(this.tabMenuItems(tab), e.clientX, e.clientY);
        });
        list.append(row);
      }
      col.addEventListener("dragover", e => {
        if (e.dataTransfer.types.includes("tabora/tab")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          col.setAttribute("drop", "true");
        } else if (e.dataTransfer.types.includes("tabora/space")) {
          e.preventDefault();
          const r = col.getBoundingClientRect();
          col.setAttribute("drop-col", e.clientX < r.left + r.width / 2 ? "before" : "after");
        }
      });
      col.addEventListener("dragleave", e => {
        if (!col.contains(e.relatedTarget)) {
          col.removeAttribute("drop");
          col.removeAttribute("drop-col");
        }
      });
      col.addEventListener("drop", e => {
        e.preventDefault();
        col.removeAttribute("drop");
        const side = col.getAttribute("drop-col");
        col.removeAttribute("drop-col");
        const tab = this._dragTab;
        if (tab && e.dataTransfer.types.includes("tabora/tab")) {
          if (this.contextOf(tab) !== space.userContextId) {
            this.moveTabQuiet(tab, space);
          }
          this.drawerDirty("spaces");
          this.renderDrawer();
          return;
        }
        const fromId = e.dataTransfer.getData("tabora/space");
        if (fromId && fromId !== space.id) {
          // перетащить можно только существующее пространство на существующее
          const moving = this.spaces.find(s => s.id === fromId);
          const list2 = this.spaces.filter(s => s.id !== fromId);
          const target = list2.indexOf(space);
          if (!moving || target < 0) {
            return;
          }
          const at = target + (side === "after" ? 1 : 0);
          list2.splice(at, 0, moving);
          this.spaces = list2;
          this.saveSpaces();
          this.renderDrawer();
        }
      });
      const grip = this.html("button", { class: "icon-btn dgrip", type: "button", title: tt`Переставить`, draggable: "true" }, null, [this.svg(["M12 3v18", "M3 12h18", "m8 7 4-4 4 4", "m8 17 4 4 4-4", "m7 8-4 4 4 4", "m17 8 4 4-4 4"], 13, 1.8)]);
      grip.addEventListener("dragstart", e => {
        e.dataTransfer.setData("tabora/space", space.id);
        e.dataTransfer.effectAllowed = "move";
        col.setAttribute("dragging", "true");
      });
      grip.addEventListener("dragend", () => col.removeAttribute("dragging"));
      const more = this.iconButton("", tt`Ещё`, ["M5 12h.01", "M12 12h.01", "M19 12h.01"], e => {
        const r = e.currentTarget.getBoundingClientRect();
        this.showMenu(this.spaceMenuItems(space, name), r.left, r.bottom + 6);
      }, 15);
      const newTab = this.iconButton("", tt`Новая вкладка здесь`, ["M12 5v14", "M5 12h14"], () => {
        gBrowser.selectedTab = gBrowser.addTab(BROWSER_NEW_TAB_URL, { userContextId: space.userContextId, triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
        this.switchSpace(space.id);
        this.closeDrawer();
        gURLBar.select();
      }, 14);
      col.append(head, list, this.html("footer", { class: "dcol-foot" }, null, [grip, this.html("span", { class: "dcol-hint" }, `⌘${index + 1}`), newTab, more]));
      board.append(col);
    });
    const add = this.html("button", { class: "dcol-add", type: "button", title: tt`Новое пространство` }, null, [this.svg(["M12 5v14", "M5 12h14"], 16, 2.2)]);
    add.addEventListener("click", () => this.addSpace());
    board.append(add);
    if (seq !== d.seq) {
      return;
    }
    d.body.replaceChildren(board);
  },

  spaceMenuItems(space, nameEl) {
    const colors = Object.entries(this.SPACE_COLOR_NAMES).map(([id, label]) => ({
      label,
      checked: space.color === id,
      swatch: this.SPACE_HEX[id],
      run: () => this.updateSpace(space, { color: id }),
    }));
    return [
      { label: tt`Переименовать`, run: () => this.renameSpace(space, nameEl) },
      { label: tt`Цвет`, children: colors },
      { label: tt`Усыпить все вкладки`, run: () => {
        for (const t of gBrowser.tabs) {
          if (!t.selected && !t.pinned && this.contextOf(t) === space.userContextId && !t.hasAttribute("pending")) {
            gBrowser.discardBrowser(t);
          }
        }
        this.drawerDirty("spaces");
        this.renderDrawer();
      } },
      { separator: true },
      { label: tt`Удалить пространство`, danger: true, disabled: space.userContextId === 0, hint: space.userContextId === 0 ? tt`основное` : "", run: () => this.removeSpace(space) },
    ];
  },

  renameSpace(space, nameEl) {
    const input = this.html("input", { class: "dinline", type: "text", value: space.name, maxlength: "24" });
    nameEl.replaceChildren(input);
    input.focus();
    input.select();
    let done = false;
    const finish = save => {
      if (done) {
        return;
      }
      done = true;
      const value = input.value.trim();
      if (save && value && value !== space.name) {
        this.updateSpace(space, { name: value });
      } else {
        nameEl.textContent = space.name;
      }
    };
    input.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Enter") {
        finish(true);
      } else if (e.key === "Escape") {
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("click", e => e.stopPropagation());
  },

  updateSpace(space, patch) {
    Object.assign(space, patch);
    if (space.userContextId !== 0) {
      try {
        this.ContextualIdentityService.update(space.userContextId, space.name, space.icon || "circle", space.color || "yellow");
      } catch (e) {
        console.error("Tabora updateSpace", e);
      }
    }
    this.saveSpaces();
    this.renderDrawer();
  },

  addSpace() {
    const used = new Set(this.spaces.map(s => s.color));
    const color = Object.keys(this.SPACE_COLOR_NAMES).find(c => !used.has(c)) || "purple";
    const name = tt`Пространство ${this.spaces.length + 1}`;
    const identity = this.ContextualIdentityService.create(name, "circle", color);
    const space = { id: `space-${Date.now().toString(36)}`, name, icon: "circle", color, userContextId: identity.userContextId };
    this.spaces.push(space);
    this.saveSpaces();
    this.renderDrawer().then(() => {
      const nameEl = this.drawer.body.querySelector(`.dcol[data-space="${space.id}"] .dcol-name`);
      if (nameEl) {
        this.renameSpace(space, nameEl);
      }
    });
  },

  removeSpace(space) {
    if (space.userContextId === 0) {
      return;
    }
    const personal = this.spaces.find(s => s.userContextId === 0) || this.spaces[0];
    for (const t of gBrowser.tabs.filter(t => !t.closing && this.contextOf(t) === space.userContextId)) {
      this.moveTabQuiet(t, personal);
    }
    this.spaces = this.spaces.filter(s => s !== space);
    try {
      this.ContextualIdentityService.remove(space.userContextId);
    } catch (e) {
      console.error("Tabora removeSpace", e);
    }
    if (this.activeSpaceId === space.id) {
      this.activeSpaceId = personal.id;
      Services.prefs.setStringPref("tabora.spaces.active", personal.id);
    }
    this.saveSpaces();
    this.applySpace();
    this.notice(tt`Пространство «${space.name}» удалено, вкладки перенесены в «${personal.name}»`);
    this.renderDrawer();
  },

  moveTabQuiet(tab, space) {
    const url = tab.linkedBrowser?.currentURI?.spec || "about:blank";
    const wasSelected = tab.selected;
    // сайт заново открывается с нулевым принципалом нового контейнера; системный — только для внутренних страниц
    const web = /^https?:/i.test(url);
    const fresh = gBrowser.addTab(url, {
      userContextId: space.userContextId,
      triggeringPrincipal: web ? Services.scriptSecurityManager.createNullPrincipal({ userContextId: space.userContextId }) : Services.scriptSecurityManager.getSystemPrincipal(),
      index: tab._tPos + 1,
      skipAnimation: true,
    });
    gBrowser.removeTab(tab, { skipPermitUnload: true });
    if (wasSelected && space.id === this.activeSpaceId) {
      gBrowser.selectedTab = fresh;
    }
    this.applySpace();
  },

  saveSpaces() {
    Services.prefs.setStringPref("tabora.spaces", JSON.stringify(this.spaces));
    this.renderSpacesBar();
  },

  renderSpacesBar() {
    const bar = document.getElementById("tabora-spaces");
    if (!bar) {
      return;
    }
    bar.replaceChildren();
    // В свёрнутой колонке пространство подписано первой буквой названия (tabora.css); если
    // буквы совпадают, берутся две.
    const letter = name => (name || "?").trim().charAt(0).toUpperCase();
    const taken = {};
    for (const space of this.spaces) {
      taken[letter(space.name)] = (taken[letter(space.name)] || 0) + 1;
    }
    for (const space of this.spaces) {
      const b = this.html("button", { class: "tabora-space", role: "tab", "data-space": space.id, style: `--space:${this.spaceHex(space)}` }, space.name);
      const name = (space.name || "?").trim();
      b.dataset.initial = taken[letter(name)] > 1 ? letter(name) + name.charAt(1).toLowerCase() : letter(name);
      b.title = name; // в строке вкладок и в свёрнутой колонке видна только буква
      b.setAttribute("aria-selected", String(space.id === this.activeSpaceId));
      b.addEventListener("click", () => this.switchSpace(space.id));
      bar.append(b);
    }
    bar.toggleAttribute("many", this.spaces.length > 3);
  },
});
