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
      "buildSidebarExtras", "buildTopbar", "buildStartPage", "buildAgentPanel", "buildCommandBar",
      "searchEngineName", "initSpaces", "initKeys", "initTabHooks", "startTimers", "updateTitle", "localizeUrlbar",
      "routeUrlbarToCommandBar",
    ]) {
      try {
        this[step]();
      } catch (e) {
        console.error(`Tabora: ${step}`, e);
      }
    }
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
    const pinned = this.html("div", { id: "tabora-pinned" });
    for (const [letter, label] of [
      ["M", "Почта"],
      ["C", "Календарь"],
      ["P", "Пароли"],
      ["V", "VPN"],
    ]) {
      const b = this.html(
        "button",
        { class: "tabora-pin", title: `${label}: в разработке` },
        letter
      );
      pinned.append(b);
    }
    navBar.after(spaces, pinned);

    const verticalTabs = document.getElementById("vertical-tabs");
    if (verticalTabs) {
      const head = this.html("div", { id: "tabora-tabs-head" });
      head.append(this.html("span", {}, "Сегодня"));
      const newTab = document.getElementById("vertical-tabs-newtab-button");
      if (newTab) {
        newTab.setAttribute("tooltiptext", "Новая вкладка (⌘T)");
        head.append(newTab);
      }
      verticalTabs.prepend(head);
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
    const mail = this.html("button", { id: "tabora-mail", title: "Почта и алиасы: в разработке" }, null, [
      this.html("span", {}, "Почта и алиасы"),
      this.html("span", { class: "pill" }, "скоро"),
    ]);
    if (sidebar) {
      sidebar.after(memory, mail);
    } else {
      toolbox.append(memory, mail);
    }
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

  START_URLS: ["about:blank", "about:newtab", "about:home", "about:welcome", "chrome://browser/content/blanktab.html"],

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
        }
      },
    });
    gBrowser.tabContainer.addEventListener("TabSelect", () => this.updateStart());
    this.updateStart();
  },

  go(text) {
    gURLBar.value = text;
    gURLBar.handleCommand();
  },

  isStartUrl(spec) {
    return this.START_URLS.some(u => spec === u || spec.startsWith(u + "?") || spec.startsWith(u + "#"));
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
    if (!show) {
      return;
    }
    if (gBrowser.selectedTab.label !== "Новая вкладка") {
      gBrowser.selectedTab.label = "Новая вкладка";
    }
    const now = new Date();
    const hour = now.getHours();
    const name = Services.prefs.getStringPref("tabora.user.name", "");
    const word = hour < 5 ? "Доброй ночи" : hour < 12 ? "Доброе утро" : hour < 18 ? "Добрый день" : "Добрый вечер";
    document.getElementById("tabora-start-greeting").textContent = name ? `${word}, ${name}` : word;
    document.getElementById("tabora-start-date").textContent = new Intl.DateTimeFormat("ru-RU", {
      weekday: "long", day: "numeric", month: "long",
    }).format(now);
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
      let prefill = "";
      {
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
      { glyph: "↓", title: "Загрузки", note: "Файлы, которые вы скачали", key: "⌘⇧J", tags: "downloads", run: () => switchToTabHavingURI("about:downloads", true) },
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
      if (
        e.detail?.changed?.includes("label") &&
        tab.label !== "Новая вкладка" &&
        this.isStartUrl(tab.linkedBrowser?.currentURI?.spec || "")
      ) {
        tab.label = "Новая вкладка";
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
    if (!this.isStartUrl(spec)) {
      try {
        host = new URL(spec).hostname.replace(/^www\./, "");
      } catch (e) {}
    }
    const label = this.isStartUrl(spec) ? "Новая вкладка" : tab.label || "";
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
      const info = await ChromeUtils.requestProcInfo();
      for (const child of info.children) {
        if (child.type.startsWith("web") || child.type === "privilegedabout" || child.type === "file") {
          mb += child.memory / (1024 * 1024);
        }
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
