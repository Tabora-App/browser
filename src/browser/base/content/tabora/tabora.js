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
      this._lazy.cis = ChromeUtils.importESModule(
        "resource://gre/modules/ContextualIdentityService.sys.mjs"
      ).ContextualIdentityService;
    }
    return this._lazy.cis;
  },

  init() {
    if (window.toolbar.visible === false) {
      return;
    }
    this.moveToolboxIntoBrowser();
    this.buildSidebarExtras();
    this.buildTopbar();
    this.buildAgentPanel();
    this.initSpaces();
    this.initKeys();
    this.initTabHooks();
    this.startTimers();
    this.updateTitle();
  },

  html(tag, attrs = {}, text) {
    const el = document.createElementNS(this.HTML_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      el.setAttribute(k, v);
    }
    if (text !== undefined) {
      el.textContent = text;
    }
    return el;
  },

  /* ---- Раскладка ------------------------------------------------------- */

  moveToolboxIntoBrowser() {
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
      verticalTabs.prepend(head);
    }

    const memory = this.html("div", { id: "tabora-memory" });
    memory.innerHTML = `
      <div class="row"><span class="label">Память</span><span class="value" id="tabora-memory-value">…</span></div>
      <div class="bar" aria-hidden="true"><div id="tabora-memory-bar"></div></div>
      <span class="note" id="tabora-memory-note"></span>`;
    const mail = this.html("button", { id: "tabora-mail", title: "Почта и алиасы: в разработке" });
    mail.innerHTML = `<span>Почта и алиасы</span><span class="pill">скоро</span>`;
    if (sidebar) {
      sidebar.after(memory, mail);
    } else {
      toolbox.append(memory, mail);
    }
  },

  buildTopbar() {
    const tabbox = document.getElementById("tabbrowser-tabbox");
    const bar = this.html("div", { id: "tabora-topbar" });
    bar.innerHTML = `
      <span class="title" id="tabora-title"></span>
      <span class="chip" id="tabora-blocked"></span>
      <button class="icon-btn" id="tabora-reader" title="Режим чтения" aria-label="Режим чтения">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>
      </button>
      <button id="tabora-agent-toggle" aria-pressed="false" title="Панель агента (⌘J)">
        <span class="dot"></span>Агент<span class="kbd">⌘J</span>
      </button>`;
    tabbox.prepend(bar);
    bar.querySelector("#tabora-reader").addEventListener("click", () => {
      const btn = document.getElementById("reader-mode-button");
      if (btn && !btn.hidden) {
        btn.click();
      }
    });
    bar.querySelector("#tabora-agent-toggle").addEventListener("click", () =>
      this.toggleAgent()
    );
  },

  buildAgentPanel() {
    const browser = document.getElementById("browser");
    const panel = this.html("div", { id: "tabora-agent", hidden: "true" });
    panel.innerHTML = `
      <div class="head">
        <span class="orb" aria-hidden="true"></span>
        <div class="who"><span class="name">Агент</span><span class="where" id="tabora-agent-where"></span></div>
        <button class="close" aria-label="Скрыть панель агента">×</button>
      </div>
      <div class="log" id="tabora-agent-log">
        <div class="msg agent">Я пока учусь. Регистрация на сайтах, алиасы почты и коды из писем появятся в следующих сборках. Сейчас могу показать, что умею: усыплять вкладки и держать пространства раздельно.</div>
      </div>
      <div class="chips">
        <button data-q="Саммари страницы">Саммари страницы</button>
        <button data-q="Сравнить вкладки">Сравнить вкладки</button>
        <button data-q="Тёмная тема для сайта">Тёмная тема для сайта</button>
      </div>
      <div class="composer">
        <input id="tabora-agent-input" placeholder="Спросите или поручите…" aria-label="Сообщение агенту">
        <button class="send" aria-label="Отправить">→</button>
      </div>`;
    browser.append(panel);
    panel.querySelector(".close").addEventListener("click", () => this.toggleAgent(false));
    const send = () => {
      const input = panel.querySelector("#tabora-agent-input");
      const text = input.value.trim();
      if (!text) {
        return;
      }
      this.agentSay(text, "user");
      input.value = "";
      this.agentSay("Принял: «" + text + "». Выполнять задачи я научусь в одной из следующих сборок.", "agent");
    };
    panel.querySelector(".send").addEventListener("click", send);
    panel.querySelector("#tabora-agent-input").addEventListener("keydown", e => {
      if (e.key === "Enter") {
        send();
      }
    });
    for (const chip of panel.querySelectorAll(".chips button")) {
      chip.addEventListener("click", () => {
        panel.querySelector("#tabora-agent-input").value = chip.dataset.q;
        send();
      });
    }
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
      if (e.target === gBrowser.selectedTab) {
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
    try {
      host = new URL(gBrowser.selectedBrowser.currentURI.spec).hostname.replace(/^www\./, "");
    } catch (e) {}
    const label = tab.label || "";
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
    chip.textContent = count ? `${count} ${this.plural(count, "трекер заблокирован", "трекера заблокировано", "трекеров заблокировано")}` : "";
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
