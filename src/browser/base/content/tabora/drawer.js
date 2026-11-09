/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Ящик Tabora: выдвижная панель между сайдбаром и страницей.
 * Рейка разделов слева (редактируется: состав и порядок), панель содержимого справа.
 * Разделы: загрузки, история, почта, медиа, пространства (на всю ширину), закладки.
 * Подключается из tabora.js через loadSubScript и расширяет объект Tabora. */

Object.assign(Tabora, {
  DRAWER_WIDTH: 384,
  DRAWER_RAIL: 64,
  SECTIONS_PREF: "tabora.drawer.sections",
  SECTION_PREF: "tabora.drawer.section",

  SECTIONS: {
    downloads: { label: "Загрузки", key: "⌘⇧J", icon: ["M12 4v11", "M7 10l5 5 5-5", "M4 19h16"], search: "Имя файла или сайт", full: "Открыть страницу загрузок" },
    history: { label: "История", key: "⌘⇧H", icon: ["M12 7v5l3 2", "M3.5 12a8.5 8.5 0 1 0 2.5-6", "M3 4v4h4"], search: "Поиск в истории" },
    media: { label: "Медиа", key: "⌘⇧I", icon: ["M4 5h16v14H4z", "M4 15l5-5 4 4 3-3 4 4", "M15.5 9.5h.01"], search: "Поиск по медиа" },
    spaces: { label: "Пространства", short: "Простран\u00adства", key: "⌘⇧S", icon: ["M8 8h12v12H8z", "M4 4h12v12", "M4 4v12h12"], wide: true },
    bookmarks: { label: "Закладки", key: "⌘⇧B", icon: ["M6 4h12v16l-6-4-6 4z"], search: "Поиск по закладкам" },
  },
  SECTION_ORDER: ["downloads", "history", "media", "spaces", "bookmarks"],

  drawer: { open: false, section: "downloads", editing: false, query: "", filter: "all", el: null, inner: null, body: null, timer: null, cache: {} },

  /* ---- Каркас ------------------------------------------------------------ */

  buildDrawer() {
    const h = (tag, attrs, text, children) => this.html(tag, attrs, text, children);
    const d = this.drawer;
    d.section = Services.prefs.getStringPref(this.SECTION_PREF, "downloads");
    if (!this.SECTIONS[d.section]) {
      d.section = "downloads";
    }

    const rail = h("nav", { class: "rail", "aria-label": "Разделы" }, null, [
      h("div", { class: "rail-items", id: "tabora-rail-items" }),
      h("div", { class: "rail-foot" }, null, [
        this.iconButton("tabora-rail-back", "Готово", ["M19 12H5", "m11 6-6 6 6 6"], () => this.setDrawerEditing(false)),
        this.iconButton("tabora-rail-edit", "Настроить разделы", ["M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17z", "M13.5 6.5l3 3"], () => this.setDrawerEditing(!d.editing)),
      ]),
    ]);

    const search = h("div", { class: "dsearch" }, null, [
      this.svg(["M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z", "M20 20l-4-4"], 15, 2),
      h("input", { id: "tabora-drawer-search", type: "search", autocomplete: "off", placeholder: "Поиск" }),
      h("kbd", {}, "/"),
    ]);
    const filterBtn = h("button", { class: "dfilter", id: "tabora-drawer-filter", type: "button", "aria-pressed": "false" }, null, [
      this.svg(["M4 6h16", "M7 12h10", "M10 18h4"], 14, 2),
      h("span", {}, "Фильтр"),
    ]);
    const close = this.iconButton("tabora-drawer-close", "Закрыть (Esc)", ["M6 6l12 12", "M18 6 6 18"], () => this.closeDrawer());
    const head = h("header", { class: "dhead" }, null, [search, filterBtn, close]);
    const chips = h("div", { class: "dchips", id: "tabora-drawer-chips", hidden: "true" });
    const body = h("div", { class: "dbody", id: "tabora-drawer-body" });
    const foot = h("footer", { class: "dfoot", id: "tabora-drawer-foot", hidden: "true" });
    const panel = h("section", { class: "dpanel" }, null, [head, chips, body, foot]);
    const inner = h("div", { class: "inner" }, null, [rail, panel]);
    const el = h("div", { id: "tabora-drawer", role: "complementary", "aria-label": "Ящик" }, null, [inner]);

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
        this.closeDrawer();
        e.stopPropagation();
      } else if (e.key === "/" && e.target.localName !== "input") {
        search.querySelector("input").focus();
        e.preventDefault();
      }
    });
    el.addEventListener("transitionend", e => {
      if (e.target === el && e.propertyName === "width" && !d.open) {
        el.hidden = true;
      }
    });
    window.addEventListener("resize", () => this.sizeDrawer());

    this.renderRail();

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

    try {
      ChromeUtils.registerWindowActor("TaboraMedia", {
        parent: { esModuleURI: "chrome://browser/content/tabora/actors/TaboraMediaParent.sys.mjs" },
        child: { esModuleURI: "chrome://browser/content/tabora/actors/TaboraMediaChild.sys.mjs" },
        allFrames: false,
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
      const b = this.html("button", { class: "rail-item", type: "button", "data-section": id, title: `${s.label} (${s.key})`, "aria-selected": String(d.section === id && !isHidden) }, null, [
        this.svg(s.icon, 18, 1.7),
        this.html("span", {}, s.short || s.label),
      ]);
      if (isHidden) {
        b.setAttribute("data-hidden", "true");
      }
      const ctl = this.html("span", { class: "rail-ctl", title: isHidden ? "Вернуть раздел" : "Убрать раздел" }, null, [
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
            this.setDrawerSection(rest[0]);
          }
          this.saveSections(rest);
        }
      });
      b.append(ctl);
      b.addEventListener("click", () => {
        if (d.editing || this._railDragged) {
          return;
        }
        if (d.open && d.section === id) {
          this.closeDrawer();
        } else {
          this.openDrawer(id);
        }
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
    this.drawer.editing = on;
    this.drawer.el.toggleAttribute("editing", on);
    this.renderRail();
    if (on && !this.drawer.open) {
      this.openDrawer(this.drawer.section);
    }
  },

  sizeDrawer() {
    const d = this.drawer;
    if (!d.open) {
      d.el.style.width = "0px";
      return;
    }
    const wide = this.SECTIONS[d.section]?.wide;
    if (wide) {
      const browser = document.getElementById("browser");
      const toolbox = document.getElementById("navigator-toolbox");
      const cs = getComputedStyle(browser);
      const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
      const width = browser.getBoundingClientRect().width - pad - toolbox.getBoundingClientRect().width - 10;
      d.el.style.width = `${Math.max(this.DRAWER_WIDTH, Math.round(width))}px`;
      d.inner.style.width = d.el.style.width;
    } else {
      d.el.style.width = `${this.DRAWER_WIDTH}px`;
      d.inner.style.width = `${this.DRAWER_WIDTH}px`;
    }
    d.el.toggleAttribute("wide", !!wide);
    document.getElementById("browser").toggleAttribute("tabora-drawer-wide", !!wide);
  },

  openDrawer(section) {
    const d = this.drawer;
    if (section && this.SECTIONS[section]) {
      if (!this.visibleSections().includes(section)) {
        this.saveSections([...this.visibleSections(), section]);
      }
      this.setDrawerSection(section);
    }
    if (!d.open) {
      d.open = true;
      d.el.hidden = false;
      // кадр на раскладку, затем анимация выдвижения
      d.el.getBoundingClientRect();
      d.el.setAttribute("open", "true");
      document.getElementById("browser").setAttribute("tabora-drawer-open", "true");
    }
    this.sizeDrawer();
    this.renderDrawer();
    const input = document.getElementById("tabora-drawer-search");
    if (input && !this.SECTIONS[d.section].wide && !this.SECTIONS[d.section].noSearch) {
      input.focus({ preventScroll: true });
    }
  },

  closeDrawer() {
    const d = this.drawer;
    if (!d.open) {
      return;
    }
    d.open = false;
    d.editing = false;
    d.el.removeAttribute("editing");
    d.el.removeAttribute("open");
    d.el.removeAttribute("wide");
    const browser = document.getElementById("browser");
    browser.removeAttribute("tabora-drawer-open");
    browser.removeAttribute("tabora-drawer-wide");
    this.sizeDrawer();
    this.renderRail();
    gBrowser.selectedBrowser?.focus();
  },

  toggleDrawer(section) {
    const d = this.drawer;
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
    const input = document.getElementById("tabora-drawer-search");
    input.placeholder = s.search || "Поиск";
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
      d.body.replaceChildren(this.drawerEmpty("Не удалось загрузить раздел", String(e.message || e)));
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
      return "Сегодня";
    }
    if (t >= start - 86400000) {
      return "Вчера";
    }
    if (t >= start - 6 * 86400000) {
      return date.toLocaleDateString("ru-RU", { weekday: "long" });
    }
    return date.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
  },

  timeLabel(date) {
    return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
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
      this.html("span", { class: "dacts" }, null, actions.map(a => {
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
    this.drawerChips([["all", "Все"], ["active", "Идут"], ["done", "Готовые"], ["failed", "С ошибкой"]], d.filter, id => {
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
      frag.append(this.drawerEmpty(d.query ? "Ничего не найдено" : "Пока ничего не скачано", d.query ? "" : "Файлы появятся здесь сразу, как начнётся загрузка"));
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
        sub = [this.html("span", { class: "dprog" }, null, [this.html("span", { style: `width:${dl.hasProgress ? dl.progress : 100}%` })]), this.html("span", { class: "mono" }, `${pct}${dl.speed ? ` · ${this.fmtBytes(dl.speed)}/с` : ""}`)];
      } else if (st === "paused") {
        sub = [this.html("span", { class: "mono" }, `на паузе · ${this.fmtBytes(dl.currentBytes)}`)];
      } else if (st === "failed") {
        sub = [this.html("span", { class: "warn" }, dl.error ? "ошибка загрузки" : "отменено")];
      } else {
        sub = [this.html("span", { class: "mono" }, this.fmtBytes(dl.target.size || dl.currentBytes)), this.html("span", { class: "dot" }, "·"), this.html("span", {}, host)];
      }
      const actions = [];
      if (st === "active") {
        actions.push({ title: "Пауза", icon: ["M8 5v14", "M16 5v14"], run: () => dl.cancel() });
        actions.push({ title: "Отменить", icon: ["M6 6l12 12", "M18 6 6 18"], danger: true, run: () => dl.cancel().then(() => dl.removePartialData()).then(() => this._dl.list.remove(dl)) });
      } else if (st === "paused") {
        actions.push({ title: "Продолжить", icon: ["M7 5v14l12-7z"], run: () => dl.start() });
      } else if (st === "done") {
        actions.push({ title: "Показать в Finder", icon: ["M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"], run: () => dl.showContainingDirectory() });
        actions.push({ title: "Убрать из списка", icon: ["M6 6l12 12", "M18 6 6 18"], run: () => this._dl.list.remove(dl).then(() => this.drawerDirty("downloads")) });
      } else {
        actions.push({ title: "Повторить", icon: ["M20 12a8 8 0 1 1-2.3-5.7", "M20 4v5h-5"], run: () => dl.start().catch(() => {}) });
        actions.push({ title: "Убрать из списка", icon: ["M6 6l12 12", "M18 6 6 18"], run: () => this._dl.list.remove(dl).then(() => this.drawerDirty("downloads")) });
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
            { label: "Открыть", disabled: st !== "done", run: () => dl.launch().catch(() => {}) },
            { label: "Показать в Finder", disabled: st !== "done", run: () => dl.showContainingDirectory() },
            { label: "Копировать ссылку", run: () => this.copyText(dl.source.url, "Ссылка скопирована") },
            { separator: true },
            { label: "Убрать из списка", run: () => this._dl.list.remove(dl).then(() => this.drawerDirty("downloads")) },
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
    this.drawerChips([["all", "Всё"], ["today", "Сегодня"], ["week", "Неделя"]], d.filter, id => {
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
    if (seq !== d.seq) {
      return;
    }
    const frag = document.createDocumentFragment();
    if (!items.length) {
      frag.append(this.drawerEmpty(d.query ? "Ничего не найдено" : "История пуста", d.query ? "" : "Посещённые страницы появятся здесь"));
    }
    let lastDay = "";
    for (const it of items) {
      const day = this.dayLabel(it.time);
      if (day !== lastDay) {
        frag.append(this.groupNode(day));
        lastDay = day;
      }
      const row = this.rowNode({
        icon: this.favicon(it.url),
        title: it.title,
        sub: this.hostOf(it.url) + (new URL(it.url).pathname.length > 1 ? new URL(it.url).pathname.replace(/\/$/, "") : ""),
        meta: this.timeLabel(it.time),
        actions: [
          { title: "Удалить из истории", icon: ["M4 7h16", "M10 11v6M14 11v6", "M6 7l1 13h10l1-13", "M9 7V4h6v3"], danger: true, run: async () => {
            await PlacesUtils.history.remove(it.url);
            row.remove();
          } },
          { title: "Открыть в новой вкладке", icon: ["M14 4h6v6", "M20 4l-9 9", "M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"], run: () => this.openInSpace(it.url, true) },
        ],
        onClick: () => this.openInSpace(it.url, false),
        onContext: () => [
          { label: "Открыть", run: () => this.openInSpace(it.url, false) },
          { label: "Открыть в новой вкладке", run: () => this.openInSpace(it.url, true) },
          { label: "Копировать ссылку", run: () => this.copyText(it.url, "Ссылка скопирована") },
          { separator: true },
          { label: "Удалить из истории", danger: true, run: async () => {
            await PlacesUtils.history.remove(it.url);
            row.remove();
          } },
          { label: "Забыть этот сайт", danger: true, run: async () => {
            const { ForgetAboutSite } = ChromeUtils.importESModule("resource://gre/modules/ForgetAboutSite.sys.mjs");
            await ForgetAboutSite.removeDataFromBaseDomain(this.hostOf(it.url));
            this.drawerDirty("history");
            this.renderDrawer();
          } },
        ],
        draggable: e => {
          e.dataTransfer.setData("text/uri-list", it.url);
          e.dataTransfer.setData("text/plain", it.url);
        },
      });
      frag.append(row);
    }
    d.body.replaceChildren(frag);
    this.drawerFoot("Удалить историю за сегодня", async () => {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      await PlacesUtils.history.removeByFilter({ beginDate: start, endDate: new Date() });
      this.notice("История за сегодня удалена");
      this.renderDrawer();
    }, ["M4 7h16", "M10 11v6M14 11v6", "M6 7l1 13h10l1-13", "M9 7V4h6v3"]);
  },

  openInSpace(url, newTab) {
    const space = this.activeSpace();
    if (newTab) {
      gBrowser.selectedTab = gBrowser.addTab(url, {
        userContextId: space?.userContextId || 0,
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      });
    } else {
      this.openUrl(url);
    }
  },

  /* ---- Медиа ------------------------------------------------------------ */

  async drawer_media(seq) {
    const d = this.drawer;
    this.drawerChips([["all", "Всё"], ["image", "Картинки"], ["video", "Видео"], ["current", "Эта вкладка"]], d.filter, id => {
      d.filter = id;
      this.renderDrawer();
    });
    if (!d.cache.media) {
      d.body.replaceChildren(this.drawerEmpty("Собираем медиа…", "Со всех вкладок текущего пространства"));
      const space = this.activeSpace();
      const tabs = gBrowser.tabs.filter(t => !t.closing && !t.hasAttribute("pending") && (t.pinned || this.contextOf(t) === space.userContextId));
      const results = await Promise.all(
        tabs.map(async t => {
          try {
            const wg = t.linkedBrowser.browsingContext?.currentWindowGlobal;
            if (!wg) {
              return [];
            }
            const items = await wg.getActor("TaboraMedia").sendQuery("TaboraMedia:Collect");
            return (items || []).map(it => ({ ...it, tab: t }));
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
      frag.append(this.drawerEmpty(d.query ? "Ничего не найдено" : "Медиа не найдено", "Откройте страницы с картинками или видео в этом пространстве"));
    }
    const grid = this.html("div", { class: "dgrid" });
    for (const it of items) {
      const img = this.html("img", { src: it.kind === "video" ? it.poster || "" : it.src, alt: it.alt, loading: "lazy", draggable: "false" });
      const tile = this.html("button", { class: "dtile", type: "button", title: `${it.alt || it.title}\n${this.hostOf(it.page)}${it.w ? ` · ${it.w}×${it.h}` : ""}` }, null, [
        img,
        it.kind === "video" ? this.html("span", { class: "play" }, null, [this.svg(["M8 5v14l11-7z"], 14, 2)]) : this.html("span"),
        this.html("span", { class: "dtile-meta" }, null, [this.favicon(it.page), this.html("span", {}, it.w ? `${it.w}×${it.h}` : it.kind === "video" ? "видео" : "")]),
      ]);
      img.addEventListener("error", () => tile.remove());
      tile.draggable = true;
      tile.addEventListener("dragstart", e => {
        e.dataTransfer.setData("text/uri-list", it.src);
        e.dataTransfer.setData("text/plain", it.src);
        e.dataTransfer.effectAllowed = "copy";
      });
      const menu = () => [
        { label: "Открыть в новой вкладке", run: () => this.openInSpace(it.src, true) },
        { label: "Сохранить файл…", run: () => this.saveMedia(it) },
        { label: "Копировать ссылку", run: () => this.copyText(it.src, "Ссылка скопирована") },
        { separator: true },
        { label: "К странице-источнику", hint: this.hostOf(it.page), run: () => { gBrowser.selectedTab = it.tab; } },
      ];
      tile.addEventListener("click", () => this.openInSpace(it.src, true));
      tile.addEventListener("contextmenu", e => {
        e.preventDefault();
        this.showMenu(menu(), e.clientX, e.clientY);
      });
      grid.append(tile);
    }
    frag.append(grid);
    d.body.replaceChildren(frag);
    const refresh = this.html("button", { class: "dfull", type: "button" }, null, [this.html("span", {}, `Обновить · ${items.length}`), this.svg(["M20 12a8 8 0 1 1-2.3-5.7", "M20 4v5h-5"], 14, 2)]);
    refresh.addEventListener("click", () => {
      delete d.cache.media;
      this.renderDrawer();
    });
    const foot = document.getElementById("tabora-drawer-foot");
    foot.append(refresh);
    foot.hidden = false;
  },

  saveMedia(it) {
    try {
      const { PrivateBrowsingUtils } = ChromeUtils.importESModule("resource://gre/modules/PrivateBrowsingUtils.sys.mjs");
      saveURL(it.src, null, null, null, true, true, null, null, null, PrivateBrowsingUtils.isWindowPrivate(window), Services.scriptSecurityManager.getSystemPrincipal());
    } catch (e) {
      console.error("Tabora saveMedia", e);
      this.openInSpace(it.src, true);
    }
  },

  /* ---- Закладки ------------------------------------------------------------ */

  async drawer_bookmarks(seq) {
    const d = this.drawer;
    const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
    const frag = document.createDocumentFragment();
    const cur = gBrowser.selectedBrowser.currentURI.spec;
    const canAdd = /^https?:/.test(cur);
    const add = this.html("button", { class: "dprimary", type: "button", disabled: canAdd ? null : "true" }, null, [this.svg(["M12 5v14", "M5 12h14"], 14, 2.4), this.html("span", {}, "Добавить текущую")]);
    if (!canAdd) {
      add.disabled = true;
    }
    add.addEventListener("click", async () => {
      await PlacesUtils.bookmarks.insert({ parentGuid: PlacesUtils.bookmarks.toolbarGuid, url: cur, title: gBrowser.selectedTab.label });
      this.notice("Добавлено в закладки");
      this.renderDrawer();
    });
    frag.append(this.html("div", { class: "dtoolbar" }, null, [add]));

    if (d.query) {
      const found = await PlacesUtils.bookmarks.search({ query: d.query });
      if (seq !== d.seq) {
        return;
      }
      if (!found.length) {
        frag.append(this.drawerEmpty("Ничего не найдено", ""));
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
      [PlacesUtils.bookmarks.toolbarGuid, "Панель закладок"],
      [PlacesUtils.bookmarks.menuGuid, "Меню закладок"],
      [PlacesUtils.bookmarks.unfiledGuid, "Другие"],
      [PlacesUtils.bookmarks.mobileGuid, "С телефона"],
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
      frag.append(this.drawerEmpty("Закладок пока нет", "Нажмите «Добавить текущую» или ⌘D на любой странице"));
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
          this.html("span", {}, c.title || "Папка"),
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
            { label: "Открыть все во вкладках", hint: String(this.countBookmarks(c)), run: () => this.openAll(c) },
            { separator: true },
            { label: "Удалить папку", danger: true, run: async () => {
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
        { title: "Удалить закладку", icon: ["M4 7h16", "M10 11v6M14 11v6", "M6 7l1 13h10l1-13", "M9 7V4h6v3"], danger: true, run: async () => {
          await PlacesUtils.bookmarks.remove(guid);
          row.remove();
        } },
        { title: "Открыть в новой вкладке", icon: ["M14 4h6v6", "M20 4l-9 9", "M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"], run: () => this.openInSpace(url, true) },
      ],
      onClick: () => this.openInSpace(url, false),
      onContext: () => [
        { label: "Открыть", run: () => this.openInSpace(url, false) },
        { label: "Открыть в новой вкладке", run: () => this.openInSpace(url, true) },
        { label: "Копировать ссылку", run: () => this.copyText(url, "Ссылка скопирована") },
        { separator: true },
        { label: "Переименовать…", run: () => this.renameBookmark(row, guid, title, PlacesUtils) },
        { label: "Удалить закладку", danger: true, run: async () => {
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
  SPACE_COLOR_NAMES: { yellow: "Лайм", blue: "Голубой", turquoise: "Бирюза", green: "Зелёный", orange: "Оранжевый", red: "Красный", pink: "Розовый", purple: "Фиолетовый" },

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
      const rename = this.iconButton("", "Переименовать", ["M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17z", "M13.5 6.5l3 3"], () => this.renameSpace(space, name), 13);
      const head = this.html("header", { class: "dcol-head" }, null, [this.html("span", { class: "dcol-dot" }), name, this.html("span", { class: "dcol-count" }, String(tabsOf(space).length)), rename]);
      head.addEventListener("dblclick", () => this.renameSpace(space, name));
      const list = this.html("div", { class: "dcol-list" });
      const tabs = tabsOf(space);
      if (!tabs.length) {
        list.append(this.html("div", { class: "dcol-empty" }, "Перетащите вкладки сюда"));
      }
      for (const tab of tabs) {
        const url = tab.linkedBrowser?.currentURI?.spec || "";
        const row = this.html("div", { class: "dtab", draggable: "true", title: url }, null, [
          this.isStartUrl(url) ? this.html("span", { class: "start-dot" }) : this.favicon(url),
          this.html("span", { class: "dtab-title" }, tab.label || this.startLabel()),
          tab.hasAttribute("pending") ? this.html("span", { class: "zz" }, "спит") : this.html("span"),
        ]);
        if (tab.selected) {
          row.setAttribute("selected", "true");
        }
        const close = this.iconButton("", "Закрыть вкладку", ["M6 6l12 12", "M18 6 6 18"], () => gBrowser.removeTab(tab), 12);
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
          const list2 = this.spaces.filter(s => s.id !== fromId);
          const moving = this.spaces.find(s => s.id === fromId);
          const at = list2.indexOf(space) + (side === "after" ? 1 : 0);
          list2.splice(at, 0, moving);
          this.spaces = list2;
          this.saveSpaces();
          this.renderDrawer();
        }
      });
      const grip = this.html("button", { class: "icon-btn dgrip", type: "button", title: "Переставить", draggable: "true" }, null, [this.svg(["M12 3v18", "M3 12h18", "m8 7 4-4 4 4", "m8 17 4 4 4-4", "m7 8-4 4 4 4", "m17 8 4 4-4 4"], 13, 1.8)]);
      grip.addEventListener("dragstart", e => {
        e.dataTransfer.setData("tabora/space", space.id);
        e.dataTransfer.effectAllowed = "move";
        col.setAttribute("dragging", "true");
      });
      grip.addEventListener("dragend", () => col.removeAttribute("dragging"));
      const more = this.iconButton("", "Ещё", ["M5 12h.01", "M12 12h.01", "M19 12h.01"], e => {
        const r = e.currentTarget.getBoundingClientRect();
        this.showMenu(this.spaceMenuItems(space, name), r.left, r.bottom + 6);
      }, 15);
      const newTab = this.iconButton("", "Новая вкладка здесь", ["M12 5v14", "M5 12h14"], () => {
        gBrowser.selectedTab = gBrowser.addTab(BROWSER_NEW_TAB_URL, { userContextId: space.userContextId, triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
        this.switchSpace(space.id);
        this.closeDrawer();
        gURLBar.select();
      }, 14);
      col.append(head, list, this.html("footer", { class: "dcol-foot" }, null, [grip, this.html("span", { class: "dcol-hint" }, `⌘${index + 1}`), newTab, more]));
      board.append(col);
    });
    const add = this.html("button", { class: "dcol-add", type: "button", title: "Новое пространство" }, null, [this.svg(["M12 5v14", "M5 12h14"], 16, 2.2)]);
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
      { label: "Переименовать", run: () => this.renameSpace(space, nameEl) },
      { label: "Цвет", children: colors },
      { label: "Усыпить все вкладки", run: () => {
        for (const t of gBrowser.tabs) {
          if (!t.selected && !t.pinned && this.contextOf(t) === space.userContextId && !t.hasAttribute("pending")) {
            gBrowser.discardBrowser(t);
          }
        }
        this.drawerDirty("spaces");
        this.renderDrawer();
      } },
      { separator: true },
      { label: "Удалить пространство", danger: true, disabled: space.userContextId === 0, hint: space.userContextId === 0 ? "основное" : "", run: () => this.removeSpace(space) },
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
    const name = `Пространство ${this.spaces.length + 1}`;
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
    this.notice(`Пространство «${space.name}» удалено, вкладки перенесены в «${personal.name}»`);
    this.renderDrawer();
  },

  moveTabQuiet(tab, space) {
    const url = tab.linkedBrowser?.currentURI?.spec || "about:blank";
    const wasSelected = tab.selected;
    const fresh = gBrowser.addTab(url, {
      userContextId: space.userContextId,
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
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
    for (const space of this.spaces) {
      const b = this.html("button", { class: "tabora-space", role: "tab", "data-space": space.id, style: `--space:${this.spaceHex(space)}` }, space.name);
      b.setAttribute("aria-selected", String(space.id === this.activeSpaceId));
      b.addEventListener("click", () => this.switchSpace(space.id));
      bar.append(b);
    }
    bar.toggleAttribute("many", this.spaces.length > 3);
  },
});
