/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Оболочка Tabora: пространства на контейнерах, спящие вкладки, память,
 * панель агента и перестановка элементов окна под макет. */

"use strict";

var Tabora = {
  // Автоусыпление неактивных вкладок: минуты простоя, 0 — никогда (по умолчанию). Усыплённая
  // вкладка загружается заново при возврате, поэтому включается только по желанию в настройках.
  SLEEP_PREF: "tabora.tabs.sleepAfterMinutes",

  get sleepAfterMs() {
    const min = Services.prefs.getIntPref(this.SLEEP_PREF, 0);
    return min > 0 ? min * 60 * 1000 : 0;
  },
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
    Services.scriptloader.loadSubScript("chrome://tabora/content/drawer.js", window);
    Services.scriptloader.loadSubScript("chrome://tabora/content/agent.js", window);
    Services.scriptloader.loadSubScript("chrome://tabora/content/wallet/wallet.js", window);
    Services.scriptloader.loadSubScript("chrome://tabora/content/wallet/provider.js", window);
    Services.scriptloader.loadSubScript("chrome://tabora/content/wallet/send.js", window);
    Services.scriptloader.loadSubScript("chrome://tabora/content/vault/vault.js", window);
    Services.scriptloader.loadSubScript("chrome://tabora/content/account/account.js", window);
    Services.scriptloader.loadSubScript("chrome://tabora/content/update/update.js", window);
    for (const step of [
      "buildSidebarExtras", "buildTopbar", "initPrivate", "initTheme", "buildStartPage", "buildAgentPanel", "buildCommandBar", "buildCompose", "buildContextMenu",
      "searchEngineName", "initSpaces", "buildDrawer", "initUserAgent", "initCookieBanners", "initWalletProvider", "initVaultActor", "initAccount", "initUpdates", "initSidebarCompact", "initKeys", "initTabHooks", "initDownloads", "initLegacyShellUrls", "initMailToggle", "initMailBackground", "startTimers", "updateTitle", "localizeUrlbar",
      "routeUrlbarToCommandBar", "initTabMotion", "initMotion", "initBookmarkDefaults", "initTabsLayout", "initAddonsPage", "initAppMenu",
    ]) {
      try {
        this[step]();
      } catch (e) {
        console.error(`Tabora: ${step}`, e);
      }
    }
  },

  /* ---- Закладки по умолчанию: папка Tabora вместо «Mozilla Firefox» --------------------
   * Новый профиль получает их из default-bookmarks.html. В профилях, созданных раньше, осталась
   * папка Firefox со ссылками на справку Mozilla: если её не трогали (в ней только эти ссылки),
   * она один раз заменяется папкой Tabora. Изменённую пользователем папку не трогаем. */

  BOOKMARK_DEFAULTS_PREF: "tabora.bookmarks.defaultsMigrated",
  BOOKMARK_DEFAULTS: [
    ["Сайт Tabora", "https://tabora.app/"],
    ["Исходный код", "https://github.com/Tabora-App/browser"],
    ["Сообщить о проблеме", "https://github.com/Tabora-App/browser/issues"],
  ],

  initBookmarkDefaults() {
    if (Services.prefs.getBoolPref(this.BOOKMARK_DEFAULTS_PREF, false)) {
      return;
    }
    setTimeout(async () => {
      try {
        const stock = url => {
          try {
            return ["support.mozilla.org", "www.mozilla.org"].includes(new URL(url).host);
          } catch (e) {
            return false;
          }
        };
        let replaced = false;
        const tree = await PlacesUtils.promiseBookmarksTree(PlacesUtils.bookmarks.menuGuid);
        for (const node of tree?.children || []) {
          const kids = node.children || [];
          if (node.type === PlacesUtils.TYPE_X_MOZ_PLACE_CONTAINER && kids.length && kids.length <= 4 && kids.every(k => k.uri && stock(k.uri))) {
            await PlacesUtils.bookmarks.remove(node.guid);
            replaced = true;
          }
        }
        if (replaced) {
          const folder = await PlacesUtils.bookmarks.insert({ parentGuid: PlacesUtils.bookmarks.menuGuid, type: PlacesUtils.bookmarks.TYPE_FOLDER, title: "Tabora", index: 0 });
          for (const [title, url] of this.BOOKMARK_DEFAULTS) {
            await PlacesUtils.bookmarks.insert({ parentGuid: folder.guid, title, url });
          }
          this.drawerDirty?.("bookmarks");
        }
        Services.prefs.setBoolPref(this.BOOKMARK_DEFAULTS_PREF, true);
      } catch (e) {
        console.error("Tabora: закладки по умолчанию", e);
      }
    }, 4000);
  },

  /* Страница расширений запоминает последний открытый раздел. Вводный экран «Рекомендации»
   * (реклама каталога Mozilla) выключен настройкой extensions.getAddons.showPane, но в профиле,
   * где он был открыт последним, страница продолжала бы открываться на нём. */
  initAddonsPage() {
    const PREF = "extensions.ui.lastCategory";
    if (Services.prefs.getStringPref(PREF, "") === "addons://discover/") {
      Services.prefs.clearUserPref(PREF);
    }
  },

  /* ---- Главное меню и помощь ---------------------------------------------------------
   * Сочетания ⌘J и ⇧⌘J оболочка забрала себе (агент и ящик загрузок), а меню продолжало
   * показывать подсказки Firefox: «Загрузки ⌘J», «Консоль браузера ⇧⌘J». Темы оформления
   * Firefox на окно Tabora не действуют, поэтому пункт называется просто «Расширения». */
  REPO_URL: "https://github.com/Tabora-App/browser",

  initAppMenu() {
    // подсказку у «Загрузок» меню вычисляет по этой клавише; само сочетание обрабатывает оболочка
    document.getElementById("key_openDownloads")?.setAttribute("modifiers", "accel,shift");

    // «Получить помощь» (меню, F1) ведёт в репозиторий Tabora, как ссылки поддержки в настройках.
    // Справочные ссылки «Подробнее» по темам остаются как есть.
    const helpLink = window.openHelpLink;
    window.openHelpLink = (topic, ...rest) =>
      topic === "firefox-help" ? openTrustedLinkIn(`${this.REPO_URL}/issues`, "tab") : helpLink(topic, ...rest);

    const tidy = e => {
      const view = e.target;
      if (view.id === "appMenu-mainView") {
        const ext = view.querySelector("#appMenu-extensions-themes-button");
        if (ext && (ext.hasAttribute("data-l10n-id") || ext.getAttribute("label") !== "Расширения")) {
          ext.removeAttribute("data-l10n-id"); // иначе перевод вернёт «Расширения и темы»
          ext.setAttribute("label", "Расширения");
        }
      } else if (view.id === "appmenu-moreTools") {
        for (const item of view.querySelectorAll('toolbarbutton[key="key_browserConsole"][shortcut]')) {
          item.removeAttribute("shortcut");
        }
      }
    };
    document.addEventListener("ViewShowing", tidy);
    document.addEventListener("ViewShown", tidy);
  },

  /* ---- Окно нового письма: живёт в оболочке, видно на любой вкладке ------ */

  mail() {
    if (!this._mail) {
      this._mail = ChromeUtils.importESModule("chrome://tabora/content/mail/MailStore.sys.mjs");
    }
    return this._mail;
  },

  buildCompose() {
    Services.scriptloader.loadSubScript("chrome://tabora/content/select.js", window);
    const h = (tag, attrs, text, children) => this.html(tag, attrs, text, children);
    const iconBtn = (id, title, paths, extra = "") => h("button", { class: `icon-btn ${extra}`.trim(), id, type: "button", title, "aria-label": title }, null, [this.svg(paths, 14, 2)]);

    // Текст письма набирается в редакторе с оформлением: рамка без прав браузера, панель снаружи
    // (mail/RichEditor.sys.mjs).
    const { RichEditor } = ChromeUtils.importESModule("chrome://tabora/content/mail/RichEditor.sys.mjs");
    const editor = new RichEditor(document, {
      label: "Текст письма",
      placeholder: "Текст письма",
      menu: (items, rect) => this.showMenu(items, rect.left, rect.bottom + 6),
      onInput: () => this.composeChanged(),
      onSubmit: () => this.sendCompose(),
      onEscape: () => this.closeCompose(),
    });
    editor.el.id = "tabora-compose-text";
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
        editor.el,
        h("div", { class: "attachments", id: "tabora-compose-attachments" }),
      ]),
      h("div", { class: "format" }, null, [editor.bar]),
      h("div", { class: "foot" }, null, [
        h("button", { class: "primary", id: "tabora-compose-send", type: "button" }, null, [document.createTextNode("Отправить"), h("span", { class: "kbd" }, "⌘⏎")]),
        editor.toggle,
        iconBtn("tabora-compose-attach", "Прикрепить файл", ["m21 12-8.5 8.5a5 5 0 0 1-7-7L14 5a3.3 3.3 0 0 1 4.7 4.7L10.5 18a1.7 1.7 0 0 1-2.4-2.4L16 7.7"]),
        iconBtn("tabora-compose-lock", "Шифрование", [this.LOCK_OPEN, this.LOCK_BODY], "lock"),
        h("span", { class: "status", id: "tabora-compose-status" }, "Черновик сохраняется автоматически"),
        iconBtn("tabora-compose-discard", "Удалить черновик", ["M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"], "danger"),
      ]),
      h("div", { class: "resize", id: "tabora-compose-resize", "aria-hidden": "true" }),
    ]);
    document.getElementById("browser").append(box);
    window.TaboraSelect.enhance(fromSelect, { inline: true });
    this.compose = { box, editor, state: null, draftTimer: null };

    const $ = id => document.getElementById(id);
    $("tabora-compose-lock").hidden = true;
    $("tabora-compose-lock").setAttribute("aria-pressed", "false");
    $("tabora-compose-lock").addEventListener("click", () => this.toggleComposeLock());
    fromSelect.addEventListener("change", () => this.updateComposeLock());
    $("tabora-compose-cc").addEventListener("input", () => {
      clearTimeout(this.compose.lockTimer);
      this.compose.lockTimer = setTimeout(() => this.updateComposeLock(), 400);
    });
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
        this.updateComposeLock();
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
    $("tabora-compose-subject").addEventListener("input", () => this.composeChanged());
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

  /** Тема или текст письма изменились: черновик сохранится через секунду с небольшим. */
  composeChanged() {
    if (!this.compose.state) {
      return;
    }
    clearTimeout(this.compose.draftTimer);
    document.getElementById("tabora-compose-status").textContent = "Сохраняется…";
    this.compose.draftTimer = setTimeout(() => this.saveDraft(), 1200);
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
    try {
      await MailStore.ready();
    } catch (e) {
      // почта доступна только после входа и при открытом сейфе
      if (e?.code === "signed-out") {
        this.accountDialog("login", { after: () => this.openCompose(opts) });
      } else if (e?.code === "vault-locked") {
        this.notice("Сейф заблокирован: разблокируйте его, чтобы написать письмо");
        this.openDrawer?.("codes");
      } else {
        this.notice(`Почта недоступна: ${e?.message || e}`);
      }
      return;
    }
    const $ = id => document.getElementById(id);
    const box = this.compose.box;
    const from = $("tabora-compose-from");
    const senders = MailStore.senders();
    if (!senders.length) {
      const { Account } = this.accountMod();
      this.notice(Account.needsServerLink ? "Писать пока не с чего: подключите аккаунт к серверу или добавьте ящик в почте" : "Писать пока не с чего: добавьте ящик в почте");
      return;
    }
    // адреса отправителя: ящик аккаунта, его включённые алиасы, внешние ящики
    from.replaceChildren(...senders.map(s => this.html("option", { value: s.address, "data-note": s.note }, s.address)));
    from.value = ACCOUNT.address;
    from._tsel?.refresh();
    // encryptChoice — явный выбор пользователя (null — решает правило), secret — письмо отвечает
    // на зашифрованное или пересылает его: открытым оно уходит только с подтверждением
    this.compose.state = { to: [], attachments: [], draftId: null, thread: null, labels: [], replyTo: null, encrypt: false, encryptChoice: null, secret: false, plan: null };
    $("tabora-compose-lock").hidden = true;
    $("tabora-compose-chips").querySelectorAll(".chip").forEach(n => n.remove());
    $("tabora-compose-to").value = "";
    $("tabora-compose-cc").value = "";
    $("tabora-compose-cc-field").hidden = true;
    $("tabora-compose-subject").value = "";
    const editor = this.compose.editor;
    const { fromText } = ChromeUtils.importESModule("chrome://tabora/content/mail/RichText.sys.mjs");
    editor.clear();
    editor.setReadOnly(false);
    $("tabora-compose-attachments").replaceChildren();
    $("tabora-compose-title").textContent = "Новое письмо";
    $("tabora-compose-status").textContent = "Черновик сохраняется на этом компьютере";
    $("tabora-compose-send").disabled = false;

    const when = iso => new Date(iso).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
    const text = m => (m.body || []).map(b => b.p || b.h || b.q || b.code || b.btn || "").filter(Boolean).join("\n");
    if (opts.replyTo) {
      const m = MailStore.byId(opts.replyTo);
      if (m) {
        this.addRecipient(m.replyTo || m.from.email);
        this.compose.state.replyTo = m.id;
        this.compose.state.secret = !!m.pgp?.encrypted;
        $("tabora-compose-subject").value = m.subject.startsWith("Re:") ? m.subject : `Re: ${m.subject}`;
        // исходное письмо цитируется текстом; набранное в быстром ответе переносится с оформлением
        const quote = `\n\n${when(m.date)}, ${m.from.name} <${m.from.email}>:\n> ${text(m).split("\n")[0]}`;
        editor.set(opts.html ? { html: opts.html + fromText(quote) } : { text: `${opts.text || ""}${quote}` });
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
        editor.set({ text: `\n\n---------- Пересланное письмо ----------\nОт: ${m.from.name} <${m.from.email}>\nДата: ${when(m.date)}\nТема: ${m.subject}\n\n${text(m)}` });
        $("tabora-compose-title").textContent = "Переслать";
        this.compose.state.secret = !!m.pgp?.encrypted;
        // вложения исходного письма берутся с сервера в момент отправки
        this.compose.state.attachments = m.at?.uid ? (m.attachments || []).map((a, index) => ({ name: a.name, size: a.size, source: { id: m.id, index } })) : [];
      }
    } else if (opts.draftId) {
      const m = MailStore.byId(opts.draftId);
      if (m) {
        m.to.forEach(t => this.addRecipient(t));
        $("tabora-compose-subject").value = m.subject;
        editor.set({ html: m.rich || "", text: typeof m.text === "string" ? m.text : (m.body || []).map(b => b.p).join("\n\n") });
        this.compose.state.draftId = m.id;
        this.compose.state.attachments = (m.attachments || []).map(a => ({ ...a }));
        $("tabora-compose-title").textContent = "Черновик";
      }
    } else if (opts.to) {
      this.addRecipient(opts.to);
    }
    this.renderComposeAttachments();
    this.updateComposeLock();
    box.hidden = false;
    box.dataset.min = "false";
    this.restoreComposeRect();
    setTimeout(() => (this.compose.state.to.length ? $("tabora-compose-subject") : $("tabora-compose-to")).focus(), 30);
  },

  composeHasContent() {
    const s = this.compose.state;
    return !!(s && (s.to.length || document.getElementById("tabora-compose-subject").value.trim() || !this.compose.editor.empty || s.attachments.length));
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
    // text — текстовый вид письма, rich — разметка с оформлением (пусто, если оформления нет)
    const { text, html } = this.compose.editor.content();
    return {
      id: s.draftId || `d${Date.now()}`, thread: s.thread || `td${Date.now()}`, folder: "drafts", unread: false, starred: false,
      labels: s.labels || [], from: { name: "Я", email: $("tabora-compose-from").value }, to: s.to.slice(), alias: $("tabora-compose-from").value,
      cc: $("tabora-compose-cc").value.split(/[,;\s]+/).map(v => v.trim()).filter(Boolean), replyTo: s.replyTo || undefined,
      date: new Date().toISOString(), subject: $("tabora-compose-subject").value.trim(), body: text.split(/\n{2,}/).filter(Boolean).map(p => ({ p })),
      attachments: s.attachments.slice(), draft: true, text, rich: html || undefined,
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
    const chip = this.html("span", { class: "chip", "data-bad": String(!ok), "data-address": value, "data-key": "false", title: ok ? value : "Похоже, адрес с ошибкой" }, null, [
      this.html("span", { class: "key", "aria-hidden": "true" }, null, [this.svg([this.LOCK_CLOSED, this.LOCK_BODY], 11, 2.2)]),
      document.createTextNode(value),
      this.html("button", { type: "button", "aria-label": `Убрать ${value}` }, null, [this.svg(["M6 6l12 12M18 6 6 18"], 11, 2.4)]),
    ]);
    chip.lastChild.addEventListener("click", () => {
      this.compose.state.to = this.compose.state.to.filter(v => v !== value);
      chip.remove();
      this.updateComposeLock();
    });
    const input = document.getElementById("tabora-compose-to");
    input.before(chip);
    input.value = "";
    this.updateComposeLock();
  },

  /* Замок окна письма. Письмо шифруется, если есть ключи всех получателей и этого хочет
   * пользователь; без его явного выбора — когда об этом просят сами получатели (их ключ
   * внесён вручную или их программа объявляет это в заголовке Autocrypt) и когда письмо
   * отвечает на зашифрованное. */
  LOCK_BODY: "M6 11h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z",
  LOCK_CLOSED: "M7 11V8a5 5 0 0 1 10 0v3",
  LOCK_OPEN: "M7 11V8a5 5 0 0 1 9.8-1.4",

  async updateComposeLock() {
    const s = this.compose.state;
    if (!s) {
      return;
    }
    const $ = id => document.getElementById(id);
    const turn = (s.lockTurn = (s.lockTurn || 0) + 1);
    const valid = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
    const all = [...s.to, ...$("tabora-compose-cc").value.split(/[,;\s]+/).map(v => v.trim()).filter(Boolean)];
    const plan = await this.mail().MailStore.encryptPlan($("tabora-compose-from").value, all.filter(valid));
    if (this.compose.state !== s || s.lockTurn !== turn) {
      return;
    }
    const possible = plan.possible && all.every(valid);
    // письмо, которое уже собиралось уйти зашифрованным, остаётся «ожидающим шифрования»:
    // появился получатель без ключа — замок предупреждает, а не молча снимается
    const wanted = s.encryptChoice ?? (plan.suggested || s.secret || s.expected);
    s.plan = { ...plan, possible, wanted };
    s.encrypt = possible && wanted;
    s.expected ||= s.encrypt;
    s.plainConfirmed = false;
    const lock = $("tabora-compose-lock");
    const blocked = plan.available && wanted && !possible && all.length > 0;
    const state = s.encrypt ? "on" : blocked ? "blocked" : "off";
    const was = s.lockState || null;
    s.lockState = state;
    lock.hidden = !plan.available;
    lock.dataset.state = state;
    lock.setAttribute("aria-pressed", String(s.encrypt));
    lock.querySelector("path").setAttribute("d", s.encrypt ? this.LOCK_CLOSED : this.LOCK_OPEN);
    const title = s.encrypt
      ? "Письмо уйдёт зашифрованным. Нажмите, чтобы отправить открытым"
      : possible
        ? "Зашифровать письмо"
        : plan.missing.length
          ? `Зашифровать нельзя: нет ключа ${plan.missing.join(", ")}`
          : "Шифрование: сначала укажите получателя";
    lock.title = title;
    lock.setAttribute("aria-label", title);
    for (const chip of $("tabora-compose-chips").querySelectorAll(".chip")) {
      const a = chip.dataset.address;
      chip.dataset.key = String(plan.available && valid(a) && !plan.missing.includes(a.toLowerCase()));
    }
    if (state !== was && (state !== "off" || was)) {
      const more = plan.missing.length - 1;
      $("tabora-compose-status").textContent = s.encrypt ? "Письмо уйдёт зашифрованным" : blocked && plan.missing.length ? `Нет ключа ${plan.missing[0]}${more > 0 ? ` и ещё ${more}` : ""}: письмо уйдёт открытым` : "Письмо уйдёт открытым";
    }
  },

  toggleComposeLock() {
    const s = this.compose.state;
    if (!s?.plan) {
      return;
    }
    if (!s.plan.possible) {
      this.notice(s.plan.missing.length
        ? `Нет ключа ${s.plan.missing.join(", ")}. Он придёт с письмом собеседника или добавляется в почте, в разделе «Шифрование»`
        : "Укажите получателя: зашифровать можно письмо тому, чей ключ известен");
      return;
    }
    s.encryptChoice = !s.encrypt;
    s.expected = false;
    this.updateComposeLock();
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

  async sendCompose() {
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
    const draft = this.composeDraft();
    const badCc = draft.cc.find(v => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v));
    if (badCc) {
      this.notice(`Проверьте адрес в копии: ${badCc}`);
      return;
    }
    clearTimeout(this.compose.draftTimer);
    const button = $("tabora-compose-send");
    const status = $("tabora-compose-status");
    if (button.disabled) {
      return;
    }
    // кнопка занята до ответа сервера: кольцо вместо надписи, поля письма не правятся
    const busy = on => {
      button.disabled = on;
      button.classList.toggle("loading", on);
      button.toggleAttribute("aria-busy", on);
      this.compose.box.toggleAttribute("sending", on);
      this.compose.editor.setReadOnly(on);
    };
    busy(true);
    try {
      // замок должен отвечать тому, что сейчас в полях
      const confirmed = s.plainConfirmed;
      await this.updateComposeLock();
      if (this.compose.state !== s) {
        return;
      }
      if (s.plan?.wanted && !s.encrypt && s.plan.available && !confirmed) {
        // письмо, которое должно было уйти зашифрованным, открытым уходит только с ведома пользователя
        s.plainConfirmed = true;
        status.textContent = "Письмо уйдёт открытым";
        this.notice(`${s.plan.missing.length ? `Нет ключа ${s.plan.missing.join(", ")}` : "Зашифровать не получится"}. Нажмите «Отправить» ещё раз, чтобы письмо ушло открытым`);
        return;
      }
      status.textContent = s.encrypt ? "Шифруем и отправляем…" : "Отправляем…";
      await MailStore.send({ ...draft, html: draft.rich || "", subject: draft.subject || "(без темы)", thread: s.thread || undefined, encrypt: s.encrypt });
      if (s.draftId) {
        MailStore.remove(s.draftId);
      }
      // окно могли успеть открыть для другого письма: закрываем только своё
      if (this.compose.state === s) {
        this.compose.box.hidden = true;
        this.compose.state = null;
      }
      this.notice(`${s.encrypt ? "Отправлено зашифрованным" : "Отправлено"}: ${draft.to.join(", ")}`);
    } catch (e) {
      status.textContent = "Не отправлено: письмо осталось в окне";
      this.notice(`Письмо не отправлено. ${e.message}`);
    } finally {
      busy(false);
    }
  },

  /** Вложение письма сохраняется в «Загрузки» через загрузки браузера: с его проверками и
   * отметкой карантина macOS, как у файла, скачанного с сайта. Возвращает имя сохранённого файла. */
  async saveMailAttachment(id, index) {
    const { MailStore } = this.mail();
    const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
    const got = await MailStore.attachment(id, index);
    // имя из письма: только имя файла, без путей и управляющих знаков
    const clean = String(got.name || "вложение").replace(/[\u0000-\u001f\u007f/\\:]/g, "_").replace(/^\.+/, "").slice(0, 120) || "вложение";
    const tmp = await IOUtils.createUniqueFile(PathUtils.tempDir, "tabora-mail-attachment", 0o600);
    try {
      await IOUtils.write(tmp, got.bytes);
      const dir = await Downloads.getPreferredDownloadsDirectory();
      const target = await IOUtils.createUniqueFile(dir, clean, 0o600);
      const download = await Downloads.createDownload({ source: { url: PathUtils.toFileURI(tmp) }, target });
      (await Downloads.getList(Downloads.PUBLIC)).add(download);
      await download.start();
      return PathUtils.filename(target);
    } finally {
      IOUtils.remove(tmp, { ignoreAbsent: true }).catch(() => {});
    }
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

  /** items: { label, hint, note, icon, avatar, danger, disabled, caption, checked, children, run } |
   * { separator: true } | { header }. hint — сочетание клавиш, note — пометка словами; avatar —
   * кружок аккаунта вместо значка; caption — подпись без действия.
   * end: x — правый край меню (меню под кнопкой у правого края окна);
   * owner — кто открыл меню: его кнопка узнаёт, что щелчок по ней это меню только что закрыл. */
  showMenu(items, x, y, { end = false, owner = "" } = {}) {
    const menu = this.menu.el;
    this.closeSubmenu();
    menu.replaceChildren();
    this.menu.items = items;
    this.menu.active = -1;
    this.menu.subActive = -1;
    this.menu.owner = owner;
    items.forEach((item, i) => menu.append(this.menuNode(item, i, false)));
    menu.hidden = false;
    this.placeMenu(menu, end ? x - menu.offsetWidth : x, y);
  },

  menuJustClosed(owner) {
    return this.menu.closedOwner === owner && performance.now() - (this.menu.closedAt || 0) < 400;
  },

  menuNode(item, index, inSub) {
    if (item.separator) {
      return this.html("div", { class: "sep", role: "separator" });
    }
    if (item.header) {
      return this.html("div", { class: "header" }, item.header);
    }
    const node = this.html("button", { class: `item${item.danger ? " danger" : ""}${item.caption ? " caption" : ""}`, role: "menuitem", type: "button", "data-index": String(index) }, null, [
      this.html("span", { class: `icon${item.avatar ? " avatar" : ""}` }, null, item.avatar
        ? [this.accountAvatar(item.avatar.email, { size: "mini", color: item.avatar.color, empty: item.avatar.empty })]
        : item.icon
        ? [this.svg(item.icon, 15, 1.9)]
        : item.swatch
          ? [this.html("span", { class: "swatch", style: `background:${item.swatch}` }), ...(item.checked ? [this.svg(["m5 12 5 5L20 7"], 11, 2.6)] : [])]
          : item.checked ? [this.svg(["m5 12 5 5L20 7"], 15, 2.4)] : []),
      this.html("span", { class: "label" }, item.label),
      item.note ? this.html("span", { class: "hint note" }, item.note) : item.hint ? this.html("span", { class: "hint" }, item.hint) : item.children ? this.html("span", { class: "chevron" }, null, [this.svg(["m9 6 6 6-6 6"], 13, 2.2)]) : this.html("span", { class: "hint" }),
    ]);
    if (item.disabled || item.caption) {
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
      if (item.disabled || item.caption) {
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
    const selectable = list.map((it, i) => (!it.separator && !it.header && !it.disabled && !it.caption ? i : -1)).filter(i => i >= 0);
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
    this.menu.closedOwner = this.menu.owner || "";
    this.menu.closedAt = performance.now();
    this.menu.owner = "";
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
            children: spaces.map(s => ({ label: s.name, swatch: this.spaceHex(s), run: () => this.moveTabToSpace(tab, s) })),
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
    // сайт заново открывается с нулевым принципалом нового контейнера; системный — только для внутренних страниц
    const ssm = Services.scriptSecurityManager;
    const web = /^https?:/i.test(url);
    const fresh = gBrowser.addTab(url, {
      userContextId: space.userContextId,
      triggeringPrincipal: web ? ssm.createNullPrincipal({ userContextId: space.userContextId }) : ssm.getSystemPrincipal(),
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

  /** User-Agent: сборка подставляет «Tabora/<версия движка>» вместо «Firefox/…». Возвращаем токен
   * Firefox ради совместимости с сайтами и добавляем «Tabora/<наша версия>», чтобы нас узнавали. */
  initUserAgent() {
    const PREF = "general.useragent.override";
    const version = Services.prefs.getStringPref("tabora.version", "0.1.0");
    const gecko = Services.appinfo.version.split(".").slice(0, 2).join(".").replace(/\.\d+$/, ".0");
    const tail = `Firefox/${gecko} Tabora/${version}`;
    const current = Services.prefs.getStringPref(PREF, "");
    if (current.endsWith(tail)) {
      return;
    }
    if (current) {
      Services.prefs.clearUserPref(PREF);
    }
    const http = Cc["@mozilla.org/network/protocol;1?name=http"].getService(Ci.nsIHttpProtocolHandler);
    const base = http.userAgent.replace(/\s+(Tabora|Firefox)\/[\d.]+/g, "");
    Services.prefs.setStringPref(PREF, `${base} ${tail}`);
  },

  /** Баннеры cookie: актор страницы нажимает «Отклонить» за пользователя (см. actors/TaboraCookiesChild).
   * Только обычные сайты в веб-процессах: внутренние страницы, file: и дополнения актор не видит. */
  initCookieBanners() {
    try {
      ChromeUtils.registerWindowActor("TaboraCookies", {
        parent: { esModuleURI: "chrome://tabora/content/actors/TaboraCookiesParent.sys.mjs" },
        child: {
          esModuleURI: "chrome://tabora/content/actors/TaboraCookiesChild.sys.mjs",
          events: { DOMContentLoaded: {}, pageshow: {} },
        },
        allFrames: true,
        matches: ["http://*/*", "https://*/*"],
        remoteTypes: ["web"],
        messageManagerGroups: ["browsers"],
        safeForUntrustedWebProcess: true,
      });
    } catch (e) {
      // уже зарегистрирован другим окном
    }
  },

  /** Провайдер кошелька для сайтов (EIP-1193, TronLink API, Wallet Standard). */
  initWalletProvider() {
    try {
      ChromeUtils.registerWindowActor("TaboraWallet", {
        parent: { esModuleURI: "chrome://tabora/content/actors/TaboraWalletParent.sys.mjs" },
        child: {
          esModuleURI: "chrome://tabora/content/actors/TaboraWalletChild.sys.mjs",
          events: { DOMWindowCreated: {} },
        },
        // только веб-страницы: http(s) (порт не важен, localhost тоже подходит) в веб-процессах
        matches: ["https://*/*", "http://*/*"],
        remoteTypes: ["web"],
        allFrames: true,
        messageManagerGroups: ["browsers"],
        safeForUntrustedWebProcess: true,
      });
    } catch (e) {
      // уже зарегистрирован другим окном
    }
  },

  cookieBannerHandled(data, topContext) {
    const now = Date.now();
    // Сообщение приходит из процесса страницы, а страница может плодить фреймы и перезагрузки.
    // Поэтому считаем не чаще раза в 3 секунды на вкладку и не больше 30 раз в минуту на окно.
    const browser = topContext?.embedderElement;
    const tab = browser ? gBrowser.getTabForBrowser(browser) : null;
    if (!tab) {
      return;
    }
    const seen = (this._cookieSeen ||= new WeakMap());
    if (now - (seen.get(browser) || 0) < 3000) {
      return;
    }
    seen.set(browser, now);
    const rate = (this._cookieRate ||= { at: now, n: 0 });
    if (now - rate.at > 60000) {
      rate.at = now;
      rate.n = 0;
    }
    if (++rate.n > 30) {
      return;
    }
    const count = Services.prefs.getIntPref("tabora.cookies.handledCount", 0) + 1;
    Services.prefs.setIntPref("tabora.cookies.handledCount", count);
    this._cookieLast = { ...data, at: now };
    if (data?.thirdParty) {
      return; // фрейм другого сайта: в счётчик попадает, но уведомления от имени сайта вкладки не будет
    }
    if (!Services.prefs.getBoolPref("tabora.cookies.notify", true)) {
      return;
    }
    if (tab !== gBrowser.selectedTab) {
      return; // фоновые вкладки не отвлекают
    }
    if (this._cookieNoticeAt && now - this._cookieNoticeAt < 4000) {
      return;
    }
    this._cookieNoticeAt = now;
    // только сайт: текст кнопки задаёт страница, показывать его в оболочке нельзя
    const host = String(data?.host || "").replace(/[^\p{L}\p{N}.:\[\]-]/gu, "").slice(0, 80);
    if (host) {
      this.notice(`Cookie-баннер закрыт · ${host}`);
    }
  },

  /* ---- Свёрнутый сайдбар: только значки, подсказка при наведении ---------------- */

  SIDEBAR_PREF: "tabora.sidebar.compact",

  initSidebarCompact() {
    const toolbox = document.getElementById("navigator-toolbox");
    const navBar = document.getElementById("nav-bar");
    // Кнопка поиска вместо адресной строки в свёрнутом виде
    const search = this.html("button", { class: "icon-btn", id: "tabora-compact-search", type: "button", title: "Адрес или поиск (⌘K)" }, null, [
      this.svg(["M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z", "M20 20l-4-4"], 16, 2),
    ]);
    search.addEventListener("click", () => this.openCommandBar());
    navBar.append(search);
    // Ручка сворачивания внизу колонки
    const toggle = this.html("button", { class: "icon-btn", id: "tabora-sidebar-toggle", type: "button", title: "Свернуть панель (⌘B)" }, null, [
      this.svg(["m11 17-5-5 5-5", "m18 17-5-5 5-5"], 15, 2),
    ]);
    toggle.addEventListener("click", () => this.toggleSidebar());
    // «Разделы» показывает рейку ящика (drawer.js): почта, загрузки, кошелёк, коды и остальное.
    // Пока рейка спрятана, на кнопке стоят число непрочитанных писем и ход загрузок.
    const sections = this.html("button", { id: "tabora-sections", type: "button", title: "Разделы", "aria-pressed": String(!!(this.drawer?.open || this.drawer?.rail)) }, null, [
      this.svg(["M4 4h6.5v6.5H4z", "M13.5 4H20v6.5h-6.5z", "M4 13.5h6.5V20H4z", "M13.5 13.5H20V20h-6.5z"], 16, 1.8),
      this.html("span", { class: "label" }, "Разделы"),
      this.html("span", { class: "pill", "data-badge": "unread", hidden: "true" }),
      this.html("span", { class: "bar", "data-badge": "progress", "aria-hidden": "true", hidden: "true" }, null, [this.html("span")]),
    ]);
    sections.addEventListener("click", () => this.toggleRail());
    toolbox.append(this.html("div", { id: "tabora-sidebar-foot" }, null, [sections, toggle]));
    this.paintBadges?.();
    // Подсказка
    this.tipEl = this.html("div", { id: "tabora-tip", role: "tooltip", hidden: "true" });
    document.getElementById("browser").append(this.tipEl);
    toolbox.addEventListener("mouseover", e => this.tipMaybe(e));
    toolbox.addEventListener("mouseout", e => {
      if (this.tipTarget && !this.tipTarget.contains(e.relatedTarget)) {
        this.tipHide();
      }
    });
    toolbox.addEventListener("mousedown", () => this.tipHide(), true);
    toolbox.addEventListener("wheel", () => this.tipHide(), { passive: true });
    this.applySidebarCompact(this.sidebarCompactWanted, false);
    this.narrowQuery.addEventListener("change", () => this.applyNarrowWindow());
    document.documentElement.toggleAttribute("tabora-narrow", this.narrowQuery.matches);
  },

  /* ---- Узкое окно: колонка сама сворачивается до значков ------------------------------
   * В окне уже NARROW_WINDOW развёрнутая колонка оставляет странице меньше половины ширины.
   * Колонка сворачивается сама и сама разворачивается, когда окно снова широкое; настройка
   * tabora.sidebar.compact при этом не меняется. Кнопка и ⌘B в узком окне действуют до
   * следующей смены ширины. Корню ставится атрибут tabora-narrow. */
  NARROW_WINDOW: 900,

  get narrowQuery() {
    return (this._narrowQuery ||= window.matchMedia(`(max-width: ${this.NARROW_WINDOW}px)`));
  },

  get sidebarCompactWanted() {
    return this.narrowQuery.matches ? (this._narrowChoice ?? true) : Services.prefs.getBoolPref(this.SIDEBAR_PREF, false);
  },

  applyNarrowWindow() {
    this._narrowChoice = null;
    document.documentElement.toggleAttribute("tabora-narrow", this.narrowQuery.matches);
    if (!this.horizontalTabs) {
      this.applySidebarCompact(this.sidebarCompactWanted);
    }
    this.syncTopbarInset();
    this.syncRail?.();
    if (this.drawer?.open) {
      this.sizeDrawer();
    }
  },

  /* ---- Движение: одна система на весь интерфейс ---------------------------------------
   * Длительности и кривые повторяют переменные --tabora-t-* и --tabora-curve* из tabora.css.
   * Вход и перестроение: быстрое начало, мягкая остановка. Выход короче входа и с ускорением.
   * При «уменьшить движение» в системе ничего не анимируется, состояние меняется сразу. */
  MOTION: { fast: 140, base: 200, slow: 300, out: 150, curve: "cubic-bezier(0.2, 0, 0, 1)", curveOut: "cubic-bezier(0.4, 0, 1, 1)" },

  get reducedMotion() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  },

  /** Свойства ставятся с !important: у вкладок Firefox и у нас размеры заданы важными правилами. */
  motionSet(el, props) {
    for (const [name, value] of Object.entries(props)) {
      el.style.setProperty(name, value, "important");
    }
  },

  motionClear(el, names) {
    for (const name of names) {
      el.style.removeProperty(name);
    }
  },

  /* ---- Сворачивание и разворачивание колонки -------------------------------------------
   * Всё, что есть в обеих раскладках (закреплённые плитки, вкладки, кошелёк, почта, загрузки,
   * «+», кнопка сворачивания), переезжает на новое место одним движением вместе с шириной
   * колонки. Пока идёт движение, раскладка развёрнутая, а каждый элемент сдвигом, обрезкой или
   * настоящим размером приводится к тому, как он выглядит в свёрнутой колонке; в конце
   * включается свёрнутая раскладка, и она совпадает с тем, что уже на экране. Элементы не
   * масштабируются, поэтому значки не сплющиваются. Подписи гаснут и проявляются стилями
   * (tabora-sidebar-anim в tabora.css). */

  SIDEBAR_MORPH_PROPS: ["translate", "clip-path", "width", "height", "min-width", "min-height", "padding-inline-start", "border-radius", "overflow", "z-index", "position", "transition", "justify-self", "align-self"],

  sidebarMorphItems() {
    const items = [];
    const shown = el => el && el.getClientRects().length;
    for (const tab of gBrowser.tabs) {
      const anchor = tab.querySelector(".tab-icon-stack");
      if (tab.hidden || tab.closing || !anchor || !shown(tab)) {
        continue;
      }
      items.push(tab.pinned ? { el: tab, kind: "size", anchor, round: tab.querySelector(".tab-background") } : { el: tab, kind: "clip", anchor });
    }
    const sections = document.getElementById("tabora-sections");
    if (shown(sections)) {
      items.push({ el: sections, kind: "size", anchor: sections.querySelector("svg"), pad: sections, round: sections });
    }
    for (const id of ["vertical-tabs-newtab-button", "tabora-sidebar-toggle"]) {
      const el = document.getElementById(id);
      if (shown(el)) {
        items.push({ el, kind: "move" });
      }
    }
    return items;
  },

  sidebarMorphSnap(items) {
    const rect = el => {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    };
    return items.map(it => ({
      box: rect(it.el),
      anchor: it.anchor ? rect(it.anchor) : null,
      radius: it.round ? getComputedStyle(it.round).borderTopLeftRadius : "",
      pad: it.pad ? parseFloat(getComputedStyle(it.pad).paddingInlineStart) || 0 : 0,
    }));
  },

  /**
   * Раскладка сейчас развёрнутая. Для каждого элемента считает два состояния: «как есть»
   * (явными значениями, чтобы переход было из чего интерполировать) и «как в свёрнутой колонке»
   * (compact — снимок свёрнутой раскладки). Возвращает [{ parts: [[элемент, как есть, свёрнуто]] }].
   */
  sidebarMorphStates(items, compact) {
    const px = n => `${Math.round(n * 100) / 100}px`;
    const here = this.sidebarMorphSnap(items);
    // размеры свёрнутого вида ставятся разом, чтобы узнать, куда при них встанут соседи:
    // пока размеры меняются, раскладка сама сдвигает соседей, и сдвиг считается от этого места
    items.forEach((it, i) => {
      if (it.kind === "size") {
        this.motionSet(it.el, { width: px(compact[i].box.w), height: px(compact[i].box.h), "min-width": "0px", "min-height": "0px", "justify-self": "start", "align-self": "start" });
      }
    });
    const sized = this.sidebarMorphSnap(items);
    const states = items.map((it, i) => {
      const c = compact[i];
      const m = sized[i];
      const e = here[i];
      if (it.kind === "move") {
        const dx = c.box.x + c.box.w / 2 - (m.box.x + m.box.w / 2);
        const dy = c.box.y + c.box.h / 2 - (m.box.y + m.box.h / 2);
        return { parts: [[it.el, { translate: "0px 0px" }, { translate: `${px(dx)} ${px(dy)}` }]] };
      }
      if (it.kind === "clip") {
        // окно размером с плитку вокруг значка: строка вкладки обрезается до плитки
        const left = m.anchor.x + m.anchor.w / 2 - m.box.x - c.box.w / 2;
        const top = m.anchor.y + m.anchor.h / 2 - m.box.y - c.box.h / 2;
        const right = m.box.w - left - c.box.w;
        const bottom = m.box.h - top - c.box.h;
        return {
          parts: [[
            it.el,
            { translate: "0px 0px", "clip-path": "inset(0px 0px 0px 0px round 10px)" },
            { translate: `${px(c.box.x - m.box.x - left)} ${px(c.box.y - m.box.y - top)}`, "clip-path": `inset(${px(top)} ${px(right)} ${px(bottom)} ${px(left)} round 10px)` },
          ]],
        };
      }
      const from = { translate: "0px 0px", width: px(e.box.w), height: px(e.box.h), "min-width": "0px", "min-height": "0px", "justify-self": "start", "align-self": "start", overflow: "clip", position: "relative", "z-index": "2" };
      const to = { ...from, translate: `${px(c.box.x - m.box.x)} ${px(c.box.y - m.box.y)}`, width: px(c.box.w), height: px(c.box.h) };
      const parts = [[it.el, from, to]];
      if (it.pad && it.anchor) {
        // значок в свёрнутой плитке стоит по центру: внутренний отступ подводит его туда же
        const shift = c.anchor.x - c.box.x - (m.anchor.x - m.box.x);
        const padFrom = { "padding-inline-start": px(m.pad) };
        const padTo = { "padding-inline-start": px(Math.max(0, m.pad + shift)) };
        if (it.pad === it.el) {
          Object.assign(from, padFrom);
          Object.assign(to, padTo);
        } else {
          parts.push([it.pad, padFrom, padTo]);
        }
      }
      if (it.round && c.radius && e.radius && c.radius !== e.radius) {
        if (it.round === it.el) {
          from["border-radius"] = e.radius;
          to["border-radius"] = c.radius;
        } else {
          parts.push([it.round, { "border-radius": e.radius }, { "border-radius": c.radius }]);
        }
      }
      return { parts };
    });
    items.forEach(it => {
      if (it.kind === "size") {
        this.motionClear(it.el, ["width", "height", "min-width", "min-height", "justify-self", "align-self"]);
      }
    });
    return states;
  },

  sidebarMorphEnd() {
    const run = this._sidebarMorph;
    if (!run) {
      return;
    }
    this._sidebarMorph = null;
    clearTimeout(run.timer);
    const root = document.documentElement;
    run.on ? root.setAttribute("tabora-sidebar", "compact") : root.removeAttribute("tabora-sidebar");
    root.removeAttribute("tabora-sidebar-anim");
    root.removeAttribute("tabora-tabs-fit");
    for (const st of run.states) {
      for (const [el] of st.parts) {
        this.motionClear(el, this.SIDEBAR_MORPH_PROPS);
      }
    }
    if (this.drawer?.open) {
      this.sizeDrawer();
    }
  },

  applySidebarCompact(on, animate = true) {
    const root = document.documentElement;
    this.sidebarMorphEnd(); // прерванное движение доводится до конца сразу
    if (this.horizontalTabs) {
      // колонки нет: вкладки и адрес стоят двумя строками сверху (applyTabsLayout)
      root.removeAttribute("tabora-sidebar");
      root.removeAttribute("tabora-sidebar-anim");
      return;
    }
    const now = root.getAttribute("tabora-sidebar") === "compact";
    if (!animate || this.reducedMotion || now === on) {
      root.removeAttribute("tabora-sidebar-anim");
      on ? root.setAttribute("tabora-sidebar", "compact") : root.removeAttribute("tabora-sidebar");
    } else {
      const toolbox = document.getElementById("navigator-toolbox");
      const scroller = gBrowser.tabContainer.arrowScrollbox?.scrollbox;
      const scrollTop = scroller?.scrollTop ?? 0;
      const items = this.sidebarMorphItems();
      // Короткий список вкладок на время перехода не обрезается своей прокруткой (tabora.css).
      // Считается здесь, до смены раскладки: чтение размеров пересчитывает вёрстку, а между
      // снятием свёрнутой раскладки и включением перехода пересчёта быть не должно, иначе
      // ширина колонки сменится без движения.
      const tabsFit = !scroller || scroller.scrollHeight <= scroller.clientHeight + 1;
      let compact;
      if (on) {
        // свёрнутая раскладка включается на мгновение только для замера, до отрисовки
        root.setAttribute("tabora-sidebar", "compact");
        compact = this.sidebarMorphSnap(items);
        root.removeAttribute("tabora-sidebar");
        toolbox.getBoundingClientRect(); // ширина снова развёрнутая: от неё пойдёт переход
        if (scroller) {
          scroller.scrollTop = scrollTop;
        }
      } else {
        compact = this.sidebarMorphSnap(items);
        root.removeAttribute("tabora-sidebar");
      }
      root.toggleAttribute("tabora-tabs-fit", tabsFit);
      root.setAttribute("tabora-sidebar-anim", on ? "collapse" : "expand");
      const states = this.sidebarMorphStates(items, compact);
      const ms = this.MOTION.slow;
      const transition = ["translate", "clip-path", "width", "height", "padding-inline-start", "border-radius"].map(prop => `${prop} ${ms}ms ${this.MOTION.curve}`).join(", ");
      // начальное состояние без перехода
      for (const st of states) {
        for (const [el, expanded, collapsed] of st.parts) {
          this.motionSet(el, { transition: "none", ...(on ? expanded : collapsed) });
        }
      }
      toolbox.getBoundingClientRect();
      for (const st of states) {
        for (const [el, expanded, collapsed] of st.parts) {
          this.motionSet(el, { transition, ...(on ? collapsed : expanded) });
        }
      }
      this._sidebarMorph = { on, states, timer: this._motionHold ? null : setTimeout(() => this.sidebarMorphEnd(), ms + 40) };
    }
    const tabs = document.getElementById("tabbrowser-tabs");
    if (tabs) {
      if (on) {
        if (tabs.getAttribute("tooltip")) {
          tabs.dataset.tipAttr = tabs.getAttribute("tooltip");
        }
        tabs.removeAttribute("tooltip");
      } else if (tabs.dataset.tipAttr) {
        tabs.setAttribute("tooltip", tabs.dataset.tipAttr);
      }
    }
    const toggle = document.getElementById("tabora-sidebar-toggle");
    if (toggle) {
      toggle.title = on ? "Развернуть панель (⌘B)" : "Свернуть панель (⌘B)";
    }
    this.tipHide();
    if (!animate && this.drawer?.open) {
      this.sizeDrawer();
    }
  },

  /* ---- Раскладка: вкладки сбоку или двумя строками сверху ---------------------------------
   * Настройка Firefox sidebar.verticalTabs («Настройки → Вкладки и просмотр → Внешний вид
   * браузера»). При вкладках сверху Firefox сам переносит полосу вкладок в #TabsToolbar, со
   * своим перетаскиванием, прокруткой и анимацией. Оболочка переставляет своё:
   *   строка 1: кнопки окна, пространства (буквами), закреплённые сайты, вкладки, «+»;
   *   строка 2: назад, вперёд, обновить, меню, адрес, кошелёк, почта, загрузки, «Агент», аккаунт.
   * Заголовок страницы не нужен: название видно на вкладке. Стили — в tabora.css, блок
   * «Горизонтальная раскладка» (атрибут tabora-tabs="horizontal" на корне). */

  TABS_LAYOUT_PREF: "sidebar.verticalTabs",

  get horizontalTabs() {
    return !Services.prefs.getBoolPref(this.TABS_LAYOUT_PREF, true);
  },

  initTabsLayout() {
    // Firefox переносит полосу вкладок своим наблюдателем той же настройки: ждём, пока он закончит
    const observer = () => setTimeout(() => this.applyTabsLayout(), 0);
    Services.prefs.addObserver(this.TABS_LAYOUT_PREF, observer);
    window.addEventListener("unload", () => Services.prefs.removeObserver(this.TABS_LAYOUT_PREF, observer), { once: true });
    this.applyTabsLayout({ animate: false });
  },

  applyTabsLayout({ animate = true } = {}) {
    const root = document.documentElement;
    const horizontal = this.horizontalTabs;
    if ((root.getAttribute("tabora-tabs") === "horizontal") === horizontal) {
      return;
    }
    const toolbox = document.getElementById("navigator-toolbox");
    const navbar = document.getElementById("nav-bar");
    const strip = document.querySelector("#TabsToolbar .toolbar-items");
    const topbar = document.getElementById("tabora-topbar");
    const tabbox = document.getElementById("tabbrowser-tabbox");
    const spaces = document.getElementById("tabora-spaces");
    const dock = document.getElementById("tabora-dock");
    if (!toolbox || !navbar || !strip || !topbar || !tabbox) {
      return;
    }
    this.sidebarMorphEnd();
    if (horizontal) {
      // свёрнутая колонка — понятие вертикальной раскладки
      root.removeAttribute("tabora-sidebar");
      root.removeAttribute("tabora-sidebar-anim");
      root.setAttribute("tabora-tabs", "horizontal");
      if (spaces) {
        strip.before(spaces);
      }
      if (dock) {
        (document.getElementById("tabora-agent-toggle") || topbar.lastChild).before(dock);
      }
      navbar.append(topbar);
    } else {
      root.removeAttribute("tabora-tabs");
      if (spaces) {
        navbar.after(spaces);
      }
      if (dock) {
        toolbox.append(dock);
      }
      tabbox.prepend(topbar);
      this.applySidebarCompact(this.sidebarCompactWanted, false);
    }
    if (animate && !this.reducedMotion) {
      // смена раскладки проявляется, а не перескакивает (tabora-layout-in в tabora.css)
      root.setAttribute("tabora-tabs-switching", "true");
      setTimeout(() => root.removeAttribute("tabora-tabs-switching"), this.MOTION.slow + 60);
    }
    this.syncTopbarInset();
    if (this.drawer?.open || this.drawer?.rail) {
      this.sizeDrawer();
    }
    // адресная строка и переполнение панелей считают свои размеры по событию окна
    window.dispatchEvent(new Event("resize"));
  },

  /* ---- Исчезновение поверхностей -------------------------------------------------------
   * Меню, окна, листы и уведомления скрываются и удаляются кодом мгновенно: это правильно для
   * логики (отменённый лист подписи не должен ещё 150 мс числиться открытым). Чтобы на экране
   * они при этом не пропадали рывком, на месте скрытого элемента гаснет его копия. Копия
   * неактивна, в дереве доступности её нет, пароли и идентификаторы в неё не переносятся.
   * Появление задаётся стилями (tabora.css, «Появление и исчезновение поверхностей»). */

  // [селектор самого элемента, вид исчезновения, селектор родителя для удаляемых узлов]
  MOTION_EXIT: [
    ["#tabora-menu, #tabora-submenu, #tabora-otp-pop", "pop", null],
    ["#tabora-account-dialog, #tabora-update-wall, #tabora-cmd", "fade", null],
    ["#tabora-update-banner, #tabora-compose", "rise", null],
    [".w-sheet", "fade", "#tabora-drawer, #tabora-modal"],
    [".notice", "rise", "#tabora-notices"],
  ],

  /** Под нашими страницами (почта, загрузки) фон области вкладки — цвет оболочки, а не светлый
   *  фон для сайтов: иначе при выезде страницы и при её загрузке мелькает светлая подложка. */
  syncOwnPage() {
    const spec = gBrowser.selectedBrowser?.currentURI?.spec || "";
    document.documentElement.toggleAttribute("tabora-own-page", spec.startsWith("chrome://tabora/content/"));
  },

  initMotion() {
    const host = document.getElementById("browser");
    if (!host) {
      return;
    }
    gBrowser.tabContainer.addEventListener("TabSelect", () => this.syncOwnPage());
    gBrowser.addTabsProgressListener({
      onLocationChange: browser => {
        if (browser === gBrowser.selectedBrowser) {
          this.syncOwnPage();
        }
      },
    });
    this.syncOwnPage();
    const kindOf = (el, parent) => {
      for (const [sel, kind, within] of this.MOTION_EXIT) {
        if (el.matches(sel) && (!within || parent?.closest?.(within))) {
          return kind;
        }
      }
      return null;
    };
    new MutationObserver(records => {
      if (this.reducedMotion) {
        return;
      }
      for (const r of records) {
        if (r.type === "attributes") {
          const el = r.target;
          // атрибут только что появился, и элемент сейчас действительно скрыт
          if (r.oldValue === null && el.hasAttribute("hidden") && el.isConnected && !el.hasAttribute("tb-ghost")) {
            const kind = kindOf(el, el.parentNode);
            if (kind) {
              this.motionGhost(el, kind, el.parentNode, el.nextSibling, false);
            }
          }
          continue;
        }
        for (const node of r.removedNodes) {
          if (node.nodeType === 1 && !node.isConnected && !node.hasAttribute("tb-ghost") && !node.hasAttribute("hidden")) {
            const kind = kindOf(node, r.target);
            if (kind) {
              this.motionGhost(node, kind, r.target, r.nextSibling, true);
            }
          }
        }
      }
    }).observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden"], attributeOldValue: true });
  },

  /** stripIds: копия удалённого узла теряет все id, чтобы новый экземпляр того же листа,
   *  созданный следом, не перепутали с ней при поиске по id. Копия скрытого узла стоит сразу
   *  после оригинала, поиск по id находит оригинал первым. */
  motionGhost(el, kind, parent, before, stripIds) {
    if (!parent?.isConnected) {
      return;
    }
    const ghost = el.cloneNode(true);
    ghost.removeAttribute("hidden");
    ghost.setAttribute("tb-ghost", kind);
    ghost.setAttribute("aria-hidden", "true");
    ghost.setAttribute("inert", "");
    for (const input of ghost.querySelectorAll("input")) {
      if (input.type === "password") {
        input.value = "";
        input.removeAttribute("value");
      }
    }
    if (stripIds) {
      ghost.removeAttribute("id");
      for (const n of ghost.querySelectorAll("[id]")) {
        n.removeAttribute("id");
      }
    }
    // содержимое canvas (QR-коды) клонированием не переносится
    const from = el.querySelectorAll("canvas");
    const to = ghost.querySelectorAll("canvas");
    for (let i = 0; i < from.length && i < to.length; i++) {
      try {
        to[i].getContext("2d").drawImage(from[i], 0, 0);
      } catch (e) {}
    }
    parent.insertBefore(ghost, before && before.parentNode === parent ? before : null);
    const done = () => ghost.remove();
    ghost.addEventListener("animationend", e => e.target === ghost && done());
    setTimeout(done, this.MOTION.out + 120);
  },

  /* ---- Появление и закрытие вкладок ----------------------------------------------------
   * В вертикальной колонке Firefox вкладки не анимирует вовсе (его анимация рассчитана на
   * ширину горизонтальной вкладки). Здесь строка новой вкладки раскрывается по высоте и
   * проявляется, строка закрытой сворачивается и гаснет, соседи при этом плавно сдвигаются. */

  TAB_MOTION_PROPS: ["height", "min-height", "margin-block", "padding-block", "opacity", "overflow", "transition", "pointer-events"],

  initTabMotion() {
    this._tabMotionReady = false; // восстановление сеанса вкладки не анимирует
    this._tabsLeaving = 0;
    const arm = () => setTimeout(() => (this._tabMotionReady = true), 600);
    const restored = window.SessionStore?.promiseAllWindowsRestored;
    restored ? restored.then(arm, arm) : arm();
    gBrowser.tabContainer.addEventListener("TabOpen", e => this.tabEnter(e.target));

    // Закрытие. Firefox в вертикальной колонке сразу зовёт _endRemoveTab; для горизонтальных
    // вкладок он сам откладывает этот вызов до конца анимации, так что отложенное завершение —
    // штатный для него порядок. Анимируются только закрытия, для которых он сам её просит.
    const self = this;
    const removeTab = gBrowser.removeTab;
    const endRemoveTab = gBrowser._endRemoveTab;
    gBrowser.removeTab = function (tab, params) {
      const before = self._tabCloseAnimated;
      self._tabCloseAnimated = !!params?.animate;
      try {
        return removeTab.call(this, tab, params);
      } finally {
        self._tabCloseAnimated = before;
      }
    };
    gBrowser._endRemoveTab = function (tab) {
      if (self._tabCloseAnimated && !tab._taboraLeaving && self.tabCanLeave(tab)) {
        tab._taboraLeaving = true;
        // выбор переходит на соседнюю вкладку сразу, страница не ждёт конца анимации
        if (tab.selected) {
          const next = this._findTabToBlurTo(tab);
          if (next) {
            this.selectedTab = next;
          }
        }
        self.tabLeave(tab, () => endRemoveTab.call(this, tab));
        return undefined;
      }
      return endRemoveTab.call(this, tab);
    };
  },

  tabCanLeave(tab) {
    return (
      gBrowser.tabContainer.verticalMode && // в горизонтальной полосе закрытие анимирует сам Firefox
      this._tabMotionReady &&
      !this.reducedMotion &&
      !this._sidebarMorph &&
      tab.isConnected &&
      !tab.pinned &&
      !tab.hidden &&
      this._tabsLeaving < 4 &&
      tab.getBoundingClientRect().height > 0 &&
      gBrowser.tabs.some(t => t !== tab && !t.closing) // последняя вкладка окна закрывается без анимации
    );
  },

  /** Размеры строки вкладки как явные значения: переход идёт от них к нулю и обратно. */
  tabRowMetrics(tab) {
    const cs = getComputedStyle(tab);
    return { height: `${tab.getBoundingClientRect().height}px`, "margin-block": `${cs.marginTop} ${cs.marginBottom}`, "padding-block": `${cs.paddingTop} ${cs.paddingBottom}` };
  },

  tabEnter(tab) {
    if (!gBrowser.tabContainer.verticalMode || !this._tabMotionReady || this.reducedMotion || this._sidebarMorph || tab.pinned || tab.hidden || !tab.isConnected) {
      return;
    }
    const full = this.tabRowMetrics(tab);
    if (!parseFloat(full.height)) {
      return;
    }
    const ms = this.MOTION.base;
    this.motionSet(tab, { transition: "none", overflow: "clip", "min-height": "0px", height: "0px", "margin-block": "0px", "padding-block": "0px", opacity: "0" });
    tab.getBoundingClientRect();
    this.motionSet(tab, {
      transition: `height ${ms}ms ${this.MOTION.curve}, margin ${ms}ms ${this.MOTION.curve}, padding ${ms}ms ${this.MOTION.curve}, opacity ${ms}ms ${this.MOTION.curve}`,
      ...full,
      opacity: "1",
    });
    const done = () => {
      if (!tab._taboraLeaving) {
        this.motionClear(tab, this.TAB_MOTION_PROPS);
      }
    };
    tab._taboraEnterTimer = this._motionHold ? null : setTimeout(done, ms + 40);
  },

  tabLeave(tab, finish) {
    clearTimeout(tab._taboraEnterTimer);
    this._tabsLeaving++;
    const ms = this.MOTION.out;
    this.motionSet(tab, { transition: "none", overflow: "clip", "min-height": "0px", "pointer-events": "none", ...this.tabRowMetrics(tab), opacity: getComputedStyle(tab).opacity });
    tab.getBoundingClientRect();
    this.motionSet(tab, {
      transition: `height ${ms}ms ${this.MOTION.curve}, margin ${ms}ms ${this.MOTION.curve}, padding ${ms}ms ${this.MOTION.curve}, opacity ${Math.round(ms * 0.7)}ms ${this.MOTION.curveOut}`,
      height: "0px",
      "margin-block": "0px",
      "padding-block": "0px",
      opacity: "0",
    });
    const done = () => {
      this._tabsLeaving = Math.max(0, this._tabsLeaving - 1);
      try {
        finish();
      } catch (e) {
        console.error("Tabora: завершение закрытия вкладки", e);
      }
    };
    if (!this._motionHold) {
      setTimeout(done, ms + 30);
    } else {
      tab._taboraLeaveDone = done;
    }
  },

  toggleSidebar(force) {
    if (this.horizontalTabs) {
      this.notice("Боковая панель есть только при вкладках сбоку. Раскладка меняется в настройках: «Вкладки и просмотр».");
      return;
    }
    const on = force ?? document.documentElement.getAttribute("tabora-sidebar") !== "compact";
    if (this.narrowQuery.matches) {
      this._narrowChoice = on; // в узком окне выбор временный: настройка для широкого окна не трогается
    } else {
      Services.prefs.setBoolPref(this.SIDEBAR_PREF, on);
    }
    this.applySidebarCompact(on);
  },

  tipTextFor(target) {
    const tab = target.closest?.(".tabbrowser-tab");
    if (tab) {
      const url = tab.linkedBrowser?.currentURI?.spec || "";
      const label = this.isStartUrl(url) ? this.startLabel() : tab.label || "";
      return { title: label + (tab.hasAttribute("pending") ? " · спит" : ""), sub: this.isStartUrl(url) ? "" : this.displayUrl(url).replace(/^https?:\/\//, "").replace(/^www\./, "") };
    }
    const space = target.closest?.(".tabora-space");
    if (space) {
      const sp = this.spaces.find(s => s.id === space.dataset.space);
      const n = sp ? gBrowser.tabs.filter(t => !t.closing && !t.pinned && this.contextOf(t) === sp.userContextId).length : 0;
      return { title: sp?.name || "", sub: `${n} ${this.plural(n, "вкладка", "вкладки", "вкладок")}` };
    }
    const map = [
      ["#tabora-compact-search", "Адрес или поиск", "⌘K"],
      ["#vertical-tabs-newtab-button", "Новая вкладка", "⌘T"],
      ["#tabora-memory", `Память · ${document.getElementById("tabora-memory-value")?.textContent || ""}`, document.getElementById("tabora-memory-note")?.textContent || ""],
      ["#tabora-sections", "Разделы", document.getElementById("tabora-sections")?.dataset.note || "почта, загрузки, кошелёк, коды"],
      ["#tabora-sidebar-toggle", "Развернуть панель", "⌘B"],
    ];
    for (const [sel, title, sub] of map) {
      if (target.closest?.(sel)) {
        return { title, sub };
      }
    }
    return null;
  },

  tipMaybe(e) {
    const root = document.documentElement;
    const compact = root.getAttribute("tabora-sidebar") === "compact";
    if (!compact) {
      return;
    }
    const info = this.tipTextFor(e.target);
    const el = info ? e.target.closest(".tabbrowser-tab, .tabora-space, #tabora-compact-search, #vertical-tabs-newtab-button, #tabora-memory, #tabora-sections, #tabora-sidebar-toggle") : null;
    if (!info || !el || el === this.tipTarget) {
      return;
    }
    this.tipHide();
    this.tipTarget = el;
    this.tipTimer = setTimeout(() => {
      const r = el.getBoundingClientRect();
      const tip = this.tipEl;
      tip.replaceChildren(this.html("b", {}, info.title), info.sub ? this.html("span", {}, info.sub) : this.html("span"));
      tip.hidden = false;
      tip.style.left = `${Math.round(r.right + 10)}px`;
      tip.style.top = `${Math.round(r.top + r.height / 2)}px`;
      requestAnimationFrame(() => tip.setAttribute("shown", "true"));
    }, 220);
  },

  tipHide() {
    clearTimeout(this.tipTimer);
    this.tipTarget = null;
    if (this.tipEl) {
      this.tipEl.hidden = true;
      this.tipEl.removeAttribute("shown");
    }
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
      this.html("span", { class: "pill", id: "tabora-mail-unread", hidden: "true" }),
      this.html("span", { class: "kbd" }, "⌘⇧M"),
    ]);
    mail.addEventListener("click", () => this.toggleMail());
    mail.addEventListener("contextmenu", e => {
      e.preventDefault();
      e.stopPropagation();
      this.showMenu([...this.accountMenuItems(), { separator: true }, { label: "Быстрые кнопки", children: this.dockMenuItems().slice(1) }], e.clientX, e.clientY);
    });
    const walletCard = this.html("button", { id: "tabora-wallet-card", title: "Кошелёк (⌘⇧W)" }, null, [
      this.svg(["M3 7a2 2 0 0 1 2-2h13a1 1 0 0 1 1 1v2", "M3 7v10a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-7a1 1 0 0 0-1-1H5a2 2 0 0 1-2-2z", "M16 14h.01"], 16, 1.8),
      this.html("span", {}, "Кошелёк"),
      this.html("span", { class: "pill mono", id: "tabora-wallet-total", hidden: "true" }),
      this.html("span", { class: "kbd" }, "⌘⇧W"),
    ]);
    walletCard.addEventListener("click", () => this.toggleDrawer("wallet"));
    const downloads = this.buildDownloadsCard();
    const ready = { wallet: walletCard, mail, downloads };
    const dock = this.html("div", { id: "tabora-dock", role: "group", "aria-label": "Быстрые кнопки" }, null, this.DOCK.map(it => ready[it.id] || this.buildQuickButton(it)));
    if (sidebar) {
      sidebar.after(dock); // карточка «Память» убрана по решению пользователя (9 ноября 2026)
    } else {
      toolbox.append(dock);
    }
    this.initDock();
  },

  /* ---- Быстрые кнопки --------------------------------------------------------------------
   * Контейнер #tabora-dock — группа значков в строке адреса при вкладках сверху (переносит
   * applyTabsLayout). При вкладках сбоку его нет: карточки под списком вкладок убраны по решению
   * пользователя (11 ноября 2026), те же разделы открывает рейка ящика по кнопке «Разделы» внизу
   * колонки. Закреплённая рейка заменяет группу и при вкладках сверху. Какие кнопки показывать,
   * выбирает пользователь: «Настройки → Вкладки и просмотр → Быстрые кнопки» или меню по правой
   * кнопке на любой из них. Порядок кнопок — порядок списка DOCK. */

  DOCK_PREF: "tabora.dock.items",
  DOCK_DEFAULT: "wallet,mail,codes,downloads",
  // el — id готового элемента; остальным кнопку создаёт buildQuickButton
  DOCK: [
    { id: "wallet", label: "Кошелёк", key: "⌘⇧W", el: "tabora-wallet-card" },
    { id: "mail", label: "Почта и алиасы", key: "⌘⇧M", el: "tabora-mail" },
    { id: "codes", label: "Коды 2FA", key: "⌘⇧K", icon: ["M4 7h16v10H4z", "M8 12h.01", "M12 12h.01", "M16 12h.01"] },
    { id: "downloads", label: "Загрузки", key: "⌘⇧J", el: "tabora-downloads" },
    { id: "history", label: "История", key: "⌘⇧H", icon: ["M12 7v5l3 2", "M3.5 12a8.5 8.5 0 1 0 2.5-6", "M3 4v4h4"] },
    { id: "bookmarks", label: "Закладки", key: "⌘⇧B", icon: ["M6 4h12v16l-6-4-6 4z"] },
    { id: "media", label: "Медиа", key: "⌘⇧I", icon: ["M4 5h16v14H4z", "M4 15l5-5 4 4 3-3 4 4", "M15.5 9.5h.01"] },
    { id: "spaces", label: "Пространства", key: "⌘⇧S", icon: ["M8 8h12v12H8z", "M4 4h12v12", "M4 4v12h12"] },
  ],

  dockElId(it) {
    return it.el || `tabora-quick-${it.id}`;
  },

  buildQuickButton(it) {
    const btn = this.html("button", { class: "tabora-quick", id: this.dockElId(it), title: `${it.label} (${it.key})` }, null, [
      this.svg(it.icon, 16, 1.8),
      this.html("span", {}, it.label),
      this.html("span", { class: "kbd" }, it.key),
    ]);
    btn.addEventListener("click", () => this.toggleDrawer(it.id));
    return btn;
  },

  /** Включённые кнопки в порядке списка DOCK. Пустая настройка — ряд скрыт целиком. */
  dockEnabled() {
    const want = new Set(Services.prefs.getStringPref(this.DOCK_PREF, this.DOCK_DEFAULT).split(",").map(x => x.trim()));
    return this.DOCK.filter(it => want.has(it.id)).map(it => it.id);
  },

  setDockEnabled(ids) {
    const want = new Set(ids);
    Services.prefs.setStringPref(this.DOCK_PREF, this.DOCK.filter(it => want.has(it.id)).map(it => it.id).join(","));
  },

  /** Элементы ряда в порядке списка; all — вместе со скрытыми (для переноса между раскладками). */
  dockEls(all = false) {
    return this.DOCK.map(it => document.getElementById(this.dockElId(it))).filter(el => el && (all || !el.hidden));
  },

  dockMenuItems() {
    const on = new Set(this.dockEnabled());
    return [
      { header: "Быстрые кнопки" },
      ...this.DOCK.map(it => ({
        label: it.label,
        hint: it.key,
        checked: on.has(it.id),
        run: () => this.setDockEnabled(on.has(it.id) ? [...on].filter(x => x !== it.id) : [...on, it.id]),
      })),
    ];
  },

  applyDock() {
    const on = new Set(this.dockEnabled());
    for (const it of this.DOCK) {
      const el = document.getElementById(this.dockElId(it));
      if (el) {
        el.hidden = !on.has(it.id);
      }
    }
    const dock = document.getElementById("tabora-dock");
    if (dock) {
      dock.hidden = !on.size;
    }
    this.tipHide?.();
    // адресная строка считает свою ширину по событию окна (при вкладках сверху ряд стоит рядом с ней)
    window.dispatchEvent(new Event("resize"));
  },

  initDock() {
    for (const it of this.DOCK) {
      const el = document.getElementById(this.dockElId(it));
      // у кнопки почты своё меню (аккаунт): выбор кнопок в нём отдельным пунктом
      if (!el || it.id === "mail") {
        continue;
      }
      el.addEventListener("contextmenu", e => {
        e.preventDefault();
        e.stopPropagation();
        this.showMenu(this.dockMenuItems(), e.clientX, e.clientY);
      });
    }
    const observer = () => this.applyDock();
    Services.prefs.addObserver(this.DOCK_PREF, observer);
    window.addEventListener("unload", () => Services.prefs.removeObserver(this.DOCK_PREF, observer), { once: true });
    this.applyDock();
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
    head.addEventListener("click", () => this.toggleDrawer("downloads"));
    const toggle = h("button", { class: "icon-btn", id: "tabora-downloads-toggle", type: "button", title: "Пауза" }, null, [this.svg(["M8 5v14", "M16 5v14"], 13, 2)]);
    const cancel = h("button", { class: "icon-btn", id: "tabora-downloads-cancel", type: "button", title: "Отменить" }, null, [this.svg(["M6 6l12 12", "M18 6 6 18"], 13, 2)]);
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
    if (this._dl) {
      return;
    }
    const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
    this._dl = { list: await Downloads.getList(Downloads.ALL), items: new Set(), timer: null };
    const refresh = () => {
      this.updateDownloadsCard();
      this.drawerDirty?.("downloads");
    };
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
      this.setBadges?.({ downloads: 0, progress: null, running: false });
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
    this.setBadges?.({ downloads: all.length, progress: pct, running: !!running.length });
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
    toggle.replaceChildren(pausedMode ? this.svg(["M7 5v14l12-7z"], 13, 2) : this.svg(["M8 5v14", "M16 5v14"], 13, 2));
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

  /** Ссылка, брошенная на карточку «Загрузки»: только http(s), имя файла очищается и не
   * перезаписывает существующий файл, загрузка идёт в контейнере текущего пространства. */
  async downloadFromDrop(dt) {
    const raw = (dt.getData("text/uri-list") || dt.getData("text/plain") || "").split("\n")[0].trim();
    let url;
    try {
      url = new URL(raw);
    } catch (e) {
      return;
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      return;
    }
    try {
      const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
      const { DownloadPaths } = ChromeUtils.importESModule("resource://gre/modules/DownloadPaths.sys.mjs");
      const { PrivateBrowsingUtils } = ChromeUtils.importESModule("resource://gre/modules/PrivateBrowsingUtils.sys.mjs");
      const dir = await Downloads.getPreferredDownloadsDirectory();
      let leaf = url.pathname.split("/").pop() || "";
      try {
        leaf = decodeURIComponent(leaf);
      } catch (e) {}
      const name = DownloadPaths.sanitize(leaf) || DownloadPaths.sanitize(url.hostname) || "файл";
      const template = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      template.initWithPath(PathUtils.join(dir, name));
      const target = DownloadPaths.createNiceUniqueFile(template);
      const download = await Downloads.createDownload({
        source: { url: url.href, isPrivate: PrivateBrowsingUtils.isWindowPrivate(window), userContextId: this.activeSpace?.()?.userContextId || 0 },
        target: target.path,
      });
      if (!this._dl) {
        await this.initDownloads();
      }
      await this._dl.list.add(download);
      download.start().catch(() => {});
    } catch (e) {
      console.error("Tabora downloadFromDrop", e);
      this.notice("Не удалось начать загрузку");
    }
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

  /** Зазор между кнопками окна и заголовком вкладки, px. */
  TOPBAR_LIGHTS_GAP: 14,

  /**
   * Кнопки окна macOS (60px и отступ) шире свёрнутой колонки (52px) и выступают над верхней
   * панелью вкладки. Заголовок начинается после них: отступ считается по фактическому положению
   * кнопок и панели, а не подбирается числом, поэтому верен при любой ширине колонки и ящика.
   * В развёрнутой колонке и в полноэкранном режиме (кнопок нет) отступ нулевой.
   */
  syncTopbarInset() {
    const bar = document.getElementById("tabora-topbar");
    if (!bar) {
      return;
    }
    const lights = document.querySelector("#nav-bar .titlebar-buttonbox")?.getBoundingClientRect();
    let inset = 0;
    if (lights && lights.width > 0 && !window.fullScreen && !this.horizontalTabs) {
      const basePad = 8; // собственный отступ панели слева (tabora.css)
      inset = Math.max(0, Math.round(lights.right + this.TOPBAR_LIGHTS_GAP - (bar.getBoundingClientRect().left + basePad)));
    }
    if (this._topbarInset !== inset) {
      this._topbarInset = inset;
      bar.style.setProperty("--tabora-lights-inset", `${inset}px`);
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
      this.buildAccountButton(),
    ]);
    tabbox.prepend(bar);
    // Заголовок не должен попадать под кнопки окна (см. syncTopbarInset). Ширина области вкладки
    // меняется всякий раз, когда сдвигается её левый край: сворачивание колонки, ящик, полный экран.
    this.syncTopbarInset();
    new ResizeObserver(() => this.syncTopbarInset()).observe(tabbox);
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
  MAIL_URL: "chrome://tabora/content/mail/mail.html",
  DOWNLOADS_URL: "chrome://tabora/content/downloads/downloads.html",

  isMailUrl(spec) {
    return (spec || "").startsWith(this.MAIL_URL);
  },

  /** Внутренние страницы переехали из chrome://browser/content/tabora/ в закрытый пакет
   *  chrome://tabora/content/ (сайты не могут его загрузить). Вкладки, сохранённые в сессии
   *  со старым адресом, перенаправляются на новый; другие старые адреса не трогаем. */
  LEGACY_SHELL_PAGES: ["mail/mail.html", "downloads/downloads.html"],

  legacyShellTarget(spec) {
    const prefix = "chrome://browser/content/tabora/";
    if (!spec || !spec.startsWith(prefix)) {
      return null;
    }
    const rest = spec.slice(prefix.length);
    const page = rest.split(/[?#]/)[0];
    return this.LEGACY_SHELL_PAGES.includes(page) ? `chrome://tabora/content/${rest}` : null;
  },

  initLegacyShellUrls() {
    const fix = browser => {
      const target = this.legacyShellTarget(browser?.currentURI?.spec);
      if (target) {
        browser.loadURI(Services.io.newURI(target), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      }
    };
    gBrowser.addTabsProgressListener({
      onLocationChange: (browser, webProgress) => {
        if (webProgress?.isTopLevel) {
          fix(browser);
        }
      },
    });
    for (const tab of gBrowser.tabs) {
      if (!tab.hasAttribute("pending")) {
        fix(tab.linkedBrowser);
      }
    }
  },

  /** Как показывать адрес человеку: внутренние страницы получают короткие имена. */
  displayUrl(spec) {
    const ens = spec.match(new RegExp(`^https?://([a-z0-9-]+(?:\\.[a-z0-9-]+)*)\\.${this.ensGateway().replace(/\./g, "\\.")}(/.*)?$`, "i"));
    if (ens) {
      return `${ens[1]}.eth` + (ens[2] && ens[2] !== "/" ? ens[2] : "");
    }
    const ipfs = spec.match(new RegExp(`^https?://([a-z0-9]+)\\.(ipfs|ipns)\\.${this.ipfsGateway().replace(/\./g, "\\.")}(/.*)?$`, "i"));
    if (ipfs) {
      return `${ipfs[2]}://${ipfs[1]}${ipfs[3] && ipfs[3] !== "/" ? ipfs[3] : ""}`;
    }
    if (this.isMailUrl(spec)) {
      const hash = spec.split("#")[1] || "";
      return hash === "aliases" ? "tabora://mail/aliases" : "tabora://mail";
    }
    if (spec.startsWith("about:preferences")) {
      // раздел «Аккаунт» занимает место раздела Firefox «Аккаунт и синхронизация» (#sync)
      return /#sync(-|$)/.test(spec) ? "tabora://settings/account" : "tabora://settings";
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
      const shown = existing.selected;
      gBrowser.selectedTab = existing;
      if (!shown) {
        this.pageEnter(existing);
      }
      return;
    }
    const tab = gBrowser.addTab(url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
    gBrowser.selectedTab = tab;
    this.pageEnter(tab, { afterLoad: true });
  },

  /* ---- Наши страницы (почта, загрузки) выезжают слева и проявляются, как ящик кошелька -----
   * Движется панель вкладки целиком, так что сама страница об анимации не знает. Край
   * карточки страницы обрезает её по скруглению. */

  /** afterLoad: вкладка только что создана — панель скрыта, пока страница не нарисуется,
   *  иначе сначала мелькнёт пустой фон, а содержимое появится рывком. */
  pageEnter(tab, { afterLoad = false } = {}) {
    const panel = gBrowser.getPanel(tab.linkedBrowser);
    if (!panel || this.reducedMotion) {
      return;
    }
    for (const a of panel.getAnimations()) {
      a.cancel();
    }
    const play = () => {
      panel.style.removeProperty("opacity");
      if (!tab.isConnected || !tab.selected) {
        return;
      }
      panel.animate([{ opacity: 0, translate: "-24px 0" }, { opacity: 1, translate: "0 0" }], { duration: this.MOTION.slow, easing: this.MOTION.curve });
    };
    if (!afterLoad) {
      play();
      return;
    }
    panel.style.setProperty("opacity", "0");
    // адрес вкладки ещё пустой, а фон под страницей уже должен быть «нашим» (см. syncOwnPage)
    document.documentElement.setAttribute("tabora-own-page", "true");
    let done = false;
    const once = () => {
      if (!done) {
        done = true;
        requestAnimationFrame(() => requestAnimationFrame(play));
      }
    };
    tab.linkedBrowser.addEventListener("DOMContentLoaded", once, { capture: true, once: true });
    setTimeout(once, 600); // страница не загрузилась: показываем как есть
  },

  /** Панель уезжает влево и гаснет, затем выполняется переход (смена вкладки). */
  pageLeave(tab, then) {
    const panel = gBrowser.getPanel(tab.linkedBrowser);
    if (!panel || this.reducedMotion) {
      then();
      return;
    }
    const anim = panel.animate([{ opacity: 1, translate: "0 0" }, { opacity: 0, translate: "-16px 0" }], { duration: this.MOTION.out, easing: this.MOTION.curveOut, fill: "forwards" });
    const finish = () => {
      then();
      anim.cancel();
    };
    anim.finished.then(finish, finish);
  },

  /** Контекстное меню для наших страниц: координаты страницы переводятся в координаты окна. */
  showMenuFromContent(contentWindow, items, x, y) {
    const browser = gBrowser.getBrowserForContentWindow?.(contentWindow) || gBrowser.selectedBrowser;
    const rect = browser.getBoundingClientRect();
    this.showMenu(items, rect.left + x, rect.top + y);
  },

  openMail(hash = "") {
    // почта — часть аккаунта: без входа показываем окно входа, после входа открываем почту
    const { Account } = this.accountMod();
    if (!Account._loaded || !Account.signedIn) {
      Account.ready().then(() => {
        if (Account.signedIn) {
          this.openMailTab(hash);
        } else {
          this.accountDialog(Account.email ? "login" : "welcome", { after: () => this.openMailTab(hash) });
        }
      });
      return;
    }
    this.openMailTab(hash);
  },

  /** Почта работает с открытия окна: письма сверяются в фоне, о новых сообщает уведомление
   * (MailStore.start), а на кнопке «Почта и алиасы» стоит число непрочитанных во «Входящих». */
  initMailBackground() {
    const { MailStore } = this.mail();
    const update = () => {
      const pill = document.getElementById("tabora-mail-unread");
      if (!pill) {
        return;
      }
      const n = MailStore.available ? MailStore.unreadInbox() : 0;
      pill.textContent = n > 99 ? "99+" : String(n);
      pill.hidden = !n;
      this.setBadges?.({ unread: n });
      const button = document.getElementById("tabora-mail");
      button.title = n ? `Почта и алиасы: ${n} ${this.plural(n, "новое письмо", "новых письма", "новых писем")} (⌘⇧M)` : "Почта и алиасы (⌘⇧M)";
    };
    const observer = { observe: () => update() };
    Services.obs.addObserver(observer, MailStore.TOPIC);
    window.addEventListener("unload", () => Services.obs.removeObserver(observer, MailStore.TOPIC), { once: true });
    update();
    MailStore.start();
  },

  /** Кнопка «Почта и алиасы» и ⌘⇧M работают как кошелёк: открывают почту, а если она уже
   *  перед глазами, возвращают на вкладку, где человек был до неё. */
  toggleMail() {
    if (this.isMailUrl(gBrowser.selectedBrowser?.currentURI?.spec)) {
      const back = this.tabBeforeMail();
      if (back) {
        this.pageLeave(gBrowser.selectedTab, () => (gBrowser.selectedTab = back));
        return;
      }
    }
    this.openMail();
  },

  /** Вкладка, на которую вернуться из почты: последняя открытая не-почта в текущем пространстве. */
  tabBeforeMail() {
    const ok = t => t && !t.closing && !t.hidden && t.isConnected && !this.isMailUrl(t.linkedBrowser?.currentURI?.spec);
    if (ok(this._lastNonMailTab)) {
      return this._lastNonMailTab;
    }
    const candidates = gBrowser.tabs.filter(ok).sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    return candidates[0] || null;
  },

  initMailToggle() {
    const remember = () => {
      const tab = gBrowser.selectedTab;
      if (!this.isMailUrl(tab?.linkedBrowser?.currentURI?.spec)) {
        this._lastNonMailTab = tab;
      }
    };
    remember();
    gBrowser.tabContainer.addEventListener("TabSelect", remember);
    gBrowser.tabContainer.addEventListener("TabClose", e => {
      if (e.target === this._lastNonMailTab) {
        this._lastNonMailTab = null;
      }
    });
  },

  openMailTab(hash = "") {
    const url = this.MAIL_URL + (hash ? `#${hash}` : "");
    const existing = gBrowser.tabs.find(t => this.isMailUrl(t.linkedBrowser?.currentURI?.spec) && !t.hidden);
    if (existing) {
      const shown = existing.selected;
      gBrowser.selectedTab = existing;
      if (hash) {
        existing.linkedBrowser.loadURI(Services.io.newURI(url), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      }
      if (!shown) {
        this.pageEnter(existing);
      }
      return;
    }
    const tab = gBrowser.addTab(url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
    gBrowser.selectedTab = tab;
    this.pageEnter(tab, { afterLoad: true });
  },

  /** Внутренние страницы показывают в адресной строке своё имя вместо chrome:// и about:. */
  syncUrlbarDisplay() {
    const spec = gBrowser.selectedBrowser?.currentURI?.spec || "";
    const shown = this.displayUrl(spec);
    if (shown !== spec && !gURLBar.focused && gURLBar.value !== shown) {
      gURLBar.value = shown;
    }
  },

  /** Знак Tabora (SVG) для окон и страниц; класс tb-mark даёт анимацию точки, см. tabora.css. */
  markSvg(cls = "") {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 256 256");
    svg.setAttribute("class", `tb-mark ${cls}`.trim());
    svg.setAttribute("aria-hidden", "true");
    const add = (tag, attrs) => {
      const el = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) {
        el.setAttribute(k, v);
      }
      svg.append(el);
      return el;
    };
    add("rect", { width: 256, height: 256, rx: 58, fill: "#c8f25a" });
    add("rect", { x: 56, y: 66, width: 144, height: 38, rx: 19, fill: "#0b0c0e" });
    add("rect", { x: 109, y: 66, width: 38, height: 134, rx: 19, fill: "#0b0c0e" });
    add("circle", { class: "dot", cx: 75, cy: 85, r: 11, fill: "#c8f25a" });
    return svg;
  },

  /** Перезапуск анимации точки: при повторном показе страницы или окна. */
  markReplay(svg) {
    const dot = svg?.querySelector(".dot");
    if (!dot) {
      return;
    }
    const fresh = dot.cloneNode(true);
    dot.replaceWith(fresh);
  },

  buildStartPage() {
    const tabbox = document.getElementById("tabbrowser-tabbox");
    const input = this.html("input", { id: "tabora-start-input", placeholder: "Найти, открыть или поручить агенту", "aria-label": "Поиск или адрес" });
    const search = this.html("div", { class: "search" }, null, [
      this.svg(["M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z", "M20 20l-4-4"], 16, 1.8),
      input,
      this.html("span", { class: "kbd" }, "⌘K"),
    ]);
    const edit = this.html("button", { class: "linkish", id: "tabora-dial-edit", type: "button" }, "Изменить");
    edit.addEventListener("click", () => this.dialToggleEdit());
    const add = this.html("button", { class: "linkish", id: "tabora-dial-add", type: "button" }, "Добавить сайт");
    add.addEventListener("click", () => this.dialAddForm());
    const page = this.html("div", { id: "tabora-start", hidden: "true" }, null, [
      this.html("div", { class: "top" }, null, [
        this.markSvg("start-mark"),
        this.html("span", { class: "date", id: "tabora-start-date" }),
      ]),
      this.html("h1", { class: "greeting", id: "tabora-start-greeting" }),
      this.html("p", { class: "status", id: "tabora-start-status" }),
      search,
      this.html("div", { class: "sites-head", id: "tabora-sites-head", hidden: "true" }, null, [
        this.html("span", { class: "eyebrow" }, "Сайты"),
        this.html("span", { class: "spacer" }),
        add,
        edit,
      ]),
      this.html("div", { class: "dial", id: "tabora-start-dial", hidden: "true" }),
      this.html("div", { id: "tabora-start-form", hidden: "true" }),
    ]);
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
    const web3 = this.web3Url(text);
    if (web3) {
      this.openUrl(web3);
      return;
    }
    gURLBar.value = text;
    gURLBar.handleCommand();
  },

  /* ---- Web3-адреса: имя.eth и ipfs:// через публичные шлюзы (настраиваются) -------- */

  ensGateway() {
    return Services.prefs.getStringPref("tabora.web3.ensGateway", "eth.limo").replace(/^https?:\/\//, "").replace(/\/$/, "");
  },

  ipfsGateway() {
    return Services.prefs.getStringPref("tabora.web3.ipfsGateway", "dweb.link").replace(/^https?:\/\//, "").replace(/\/$/, "");
  },

  /** «vitalik.eth/path» → https://vitalik.eth.limo/path; ipfs://cid/path → https://cid.ipfs.dweb.link/path */
  web3Url(text) {
    const t = String(text || "").trim();
    let m = t.match(/^(?:https?:\/\/)?([a-z0-9-]+(?:\.[a-z0-9-]+)*\.eth)(\/.*)?$/i);
    if (m) {
      // шлюзы вида eth.limo / eth.link: vitalik.eth → vitalik.eth.limo
      return `https://${m[1].toLowerCase().replace(/\.eth$/, "")}.${this.ensGateway()}${m[2] || "/"}`;
    }
    m = t.match(/^ipfs:\/\/([a-z0-9]+)(\/.*)?$/i);
    if (m) {
      return `https://${m[1].toLowerCase()}.ipfs.${this.ipfsGateway()}${m[2] || "/"}`;
    }
    m = t.match(/^ipns:\/\/([a-z0-9.-]+)(\/.*)?$/i);
    if (m) {
      return `https://${m[1].toLowerCase()}.ipns.${this.ipfsGateway()}${m[2] || "/"}`;
    }
    return null;
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
    const wasHidden = page.hidden;
    page.hidden = !show;
    this.markStartTab(gBrowser.selectedTab);
    if (!show) {
      return;
    }
    if (wasHidden) {
      this.markReplay(page.querySelector(".start-mark")); // точка прокатывается при каждом показе
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
    this.updateStartStatus();
    this.fillDial();
    const input = document.getElementById("tabora-start-input");
    setTimeout(() => {
      if (!page.hidden && gBrowser.selectedBrowser === browser) {
        input.focus();
      }
    }, 60);
  },

  /** Строка состояния под приветствием: что реально происходит в браузере. */
  async updateStartStatus() {
    const el = document.getElementById("tabora-start-status");
    if (!el) {
      return;
    }
    const parts = [];
    try {
      const { Account } = this.accountMod();
      await Account.ready();
      if (Account.signedIn) {
        const { MailStore } = this.mail();
        await MailStore.ready();
        const msgs = MailStore.data?.messages || MailStore.messages || [];
        const unread = msgs.filter(m => m.folder === "inbox" && m.unread).length;
        parts.push(unread ? `в почте ${unread} ${this.plural(unread, "новое письмо", "новых письма", "новых писем")}` : "в почте нет нового");
      }
    } catch (e) {}
    const sleeping = gBrowser.tabs.filter(t => t.hasAttribute("pending") && !t.closing).length;
    const open = gBrowser.tabs.filter(t => !t.closing && !t.hidden).length;
    parts.push(`${open} ${this.plural(open, "вкладка", "вкладки", "вкладок")}${sleeping ? `, ${sleeping} ${this.plural(sleeping, "спит", "спят", "спят")}` : ""}`);
    el.textContent = parts.join(" · ");
  },

  DIAL_PREF: "tabora.start.dial",
  DIAL_MAX: 12,

  dialState() {
    try {
      const s = JSON.parse(Services.prefs.getStringPref(this.DIAL_PREF, "{}"));
      return { pinned: Array.isArray(s.pinned) ? s.pinned : [], hidden: Array.isArray(s.hidden) ? s.hidden : [] };
    } catch (e) {
      return { pinned: [], hidden: [] };
    }
  },

  dialSave(state) {
    Services.prefs.setStringPref(this.DIAL_PREF, JSON.stringify({ pinned: state.pinned.slice(0, 48), hidden: state.hidden.slice(0, 200) }));
    const dial = document.getElementById("tabora-start-dial");
    if (dial) {
      dial.dataset.filledAt = "0";
    }
    this.fillDial();
  },

  dialHost(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch (e) {
      return url;
    }
  },

  /** Закреплённые пользователем сайты в его порядке, затем часто открываемые, без убранных. */
  async dialSites() {
    const state = this.dialState();
    const hidden = new Set(state.hidden);
    const hiddenHosts = new Set(state.hidden.map(u => this.dialHost(u)));
    const out = state.pinned.filter(s => s?.url && !hidden.has(s.url)).map(s => ({ ...s, pinned: true }));
    const hosts = new Set(out.map(s => this.dialHost(s.url)));
    try {
      const { NewTabUtils } = ChromeUtils.importESModule("resource://gre/modules/NewTabUtils.sys.mjs");
      const top = await NewTabUtils.activityStreamProvider.getTopFrecentSites({ numItems: 30, includeFavicon: false });
      for (const site of top) {
        if (out.length >= this.DIAL_MAX) {
          break;
        }
        const host = this.dialHost(site.url || "");
        if (!site.url || hidden.has(site.url) || hiddenHosts.has(host) || hosts.has(host)) {
          continue;
        }
        out.push({ url: site.url, title: site.title || "", pinned: false });
        hosts.add(host);
      }
    } catch (e) {
      console.error("Tabora dial", e);
    }
    return out.slice(0, this.DIAL_MAX);
  },

  async fillDial() {
    const dial = document.getElementById("tabora-start-dial");
    if (!dial || dial.dataset.filledAt > Date.now() - 60_000) {
      return;
    }
    dial.dataset.filledAt = String(Date.now());
    const sites = await this.dialSites();
    dial.replaceChildren();
    dial.hidden = !sites.length;
    document.getElementById("tabora-sites-head").hidden = false;
    sites.forEach((site, index) => dial.append(this.dialTile(site, index)));
  },

  dialTile(site, index) {
    const host = this.dialHost(site.url);
    const title = (site.title || "").trim();
    const placeholder = /just a moment|один момент|attention required|access denied|checking your browser|please wait|^\s*$/i.test(title); // заглушки защиты сайтов
    const label = title && !placeholder && title.length <= 28 ? title : host;
    const icon = this.html("span", { class: "icon", "aria-hidden": "true" }, null, [this.html("img", { src: `page-icon:${site.url}`, alt: "" })]);
    icon.firstChild.addEventListener("error", () => {
      icon.replaceChildren();
      icon.textContent = (host || "?").charAt(0).toUpperCase();
    });
    const remove = this.html("button", { class: "remove", type: "button", title: "Убрать", "aria-label": `Убрать ${label}` }, null, [this.svg(["M6 6l12 12", "M18 6 6 18"], 10, 2.2)]);
    remove.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      this.dialRemove(site);
    });
    const a = this.html("a", { class: `tile${site.pinned ? " pinned" : ""}`, href: site.url, title: site.url, draggable: "true", "data-url": site.url, "data-index": String(index) }, null, [
      icon,
      this.html("span", { class: "text" }, null, [this.html("span", { class: "title" }, label), this.html("span", { class: "host" }, label === host ? "" : host)]),
      remove,
    ]);
    a.addEventListener("click", e => {
      e.preventDefault();
      if (document.getElementById("tabora-start")?.hasAttribute("editing")) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.button === 1) {
        gBrowser.addTab(site.url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(), inBackground: true });
      } else {
        this.go(site.url);
      }
    });
    a.addEventListener("contextmenu", e => {
      e.preventDefault();
      e.stopPropagation();
      this.showMenu(this.dialMenu(site), e.clientX, e.clientY);
    });
    a.addEventListener("dragstart", e => {
      e.dataTransfer.setData("text/x-tabora-dial", site.url);
      e.dataTransfer.setData("text/uri-list", site.url);
      e.dataTransfer.effectAllowed = "move";
      a.classList.add("dragging");
    });
    a.addEventListener("dragend", () => {
      a.classList.remove("dragging");
      document.querySelectorAll("#tabora-start-dial .tile.over").forEach(t => t.classList.remove("over"));
    });
    a.addEventListener("dragover", e => {
      if (e.dataTransfer.types.includes("text/x-tabora-dial") || e.dataTransfer.types.includes("text/uri-list")) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        a.classList.add("over");
      }
    });
    a.addEventListener("dragleave", () => a.classList.remove("over"));
    a.addEventListener("drop", e => {
      e.preventDefault();
      a.classList.remove("over");
      const from = e.dataTransfer.getData("text/x-tabora-dial");
      if (from) {
        this.dialMove(from, site.url);
        return;
      }
      const url = (e.dataTransfer.getData("text/uri-list") || "").split("\n")[0].trim();
      if (/^https?:\/\//.test(url)) {
        this.dialAdd(url, "", index);
      }
    });
    return a;
  },

  dialMenu(site) {
    const pinned = this.dialState().pinned.some(s => s.url === site.url);
    return [
      { label: "Открыть", icon: ["M5 12h14", "m13 6 6 6-6 6"], run: () => this.go(site.url) },
      { label: "Открыть в новой вкладке", icon: ["M12 5v14", "M5 12h14"], run: () => { gBrowser.selectedTab = gBrowser.addTab(site.url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }); } },
      { separator: true },
      { label: pinned ? "Открепить" : "Закрепить", icon: ["M12 17v5", "M8 3h8l-1 7 3 3H6l3-3z"], run: () => (pinned ? this.dialUnpin(site) : this.dialAdd(site.url, site.title)) },
      { label: "Переименовать…", icon: ["M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17z", "M13.5 6.5l3 3"], run: () => this.dialRenameForm(site) },
      { label: "Убрать со стартовой", icon: ["M6 6l12 12", "M18 6 6 18"], danger: true, run: () => this.dialRemove(site) },
      { separator: true },
      { label: "Добавить сайт…", icon: ["M12 5v14", "M5 12h14"], run: () => this.dialAddForm() },
      { label: "Изменить порядок", hint: "перетаскивание", icon: ["M4 8h16", "M4 16h16"], run: () => this.dialToggleEdit(true) },
    ];
  },

  dialAdd(url, title = "", index = null) {
    const state = this.dialState();
    const clean = String(url || "").trim();
    if (!/^https?:\/\//.test(clean)) {
      this.notice("Адрес должен начинаться с http:// или https://");
      return;
    }
    state.hidden = state.hidden.filter(u => u !== clean);
    state.pinned = state.pinned.filter(s => s.url !== clean);
    const entry = { url: clean, title: String(title || "").trim().slice(0, 60) };
    if (index === null || index >= state.pinned.length) {
      state.pinned.push(entry);
    } else {
      state.pinned.splice(index, 0, entry);
    }
    this.dialSave(state);
  },

  dialUnpin(site) {
    const state = this.dialState();
    state.pinned = state.pinned.filter(s => s.url !== site.url);
    this.dialSave(state);
  },

  dialRemove(site) {
    const state = this.dialState();
    state.pinned = state.pinned.filter(s => s.url !== site.url);
    if (!state.hidden.includes(site.url)) {
      state.hidden.push(site.url);
    }
    this.dialSave(state);
    this.notice("Сайт убран со стартовой");
  },

  /** Перестановка: видимый список целиком становится закреплённым в новом порядке. */
  async dialMove(fromUrl, toUrl) {
    if (fromUrl === toUrl) {
      return;
    }
    const sites = await this.dialSites();
    const list = sites.map(s => ({ url: s.url, title: s.title || "" }));
    const from = list.findIndex(s => s.url === fromUrl);
    const to = list.findIndex(s => s.url === toUrl);
    if (from < 0 || to < 0) {
      return;
    }
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    const state = this.dialState();
    state.pinned = list;
    this.dialSave(state);
  },

  dialToggleEdit(force) {
    const page = document.getElementById("tabora-start");
    const on = force === undefined ? !page.hasAttribute("editing") : !!force;
    page.toggleAttribute("editing", on);
    document.getElementById("tabora-dial-edit").textContent = on ? "Готово" : "Изменить";
  },

  /** Небольшая форма на стартовой: добавить или переименовать сайт. */
  startForm(title, fields, okLabel, onOk) {
    const box = document.getElementById("tabora-start-form");
    box.replaceChildren();
    const inputs = fields.map(f => this.html("input", { class: "field", placeholder: f.placeholder, value: f.value || "", "aria-label": f.placeholder, spellcheck: "false" }));
    const err = this.html("span", { class: "err", hidden: "true" });
    const ok = this.html("button", { class: "primary", type: "button" }, okLabel);
    const cancel = this.html("button", { class: "ghost", type: "button" }, "Отмена");
    const close = () => {
      box.hidden = true;
      box.replaceChildren();
    };
    cancel.addEventListener("click", close);
    ok.addEventListener("click", async () => {
      try {
        await onOk(inputs.map(i => i.value));
        close();
      } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
      }
    });
    box.append(this.html("div", { class: "form-head" }, title), ...inputs, err, this.html("div", { class: "form-actions" }, null, [cancel, ok]));
    box.onkeydown = e => {
      e.stopPropagation();
      if (e.key === "Enter") {
        ok.click();
      } else if (e.key === "Escape") {
        close();
      }
    };
    box.hidden = false;
    setTimeout(() => inputs[0]?.focus(), 30);
  },

  dialAddForm() {
    this.startForm("Добавить сайт", [{ placeholder: "https://example.com" }, { placeholder: "Название (необязательно)" }], "Добавить", async ([url, title]) => {
      let u = url.trim();
      if (u && !/^https?:\/\//i.test(u)) {
        u = `https://${u}`;
      }
      if (!/^https?:\/\/[^\s/]+\.[^\s/]+/.test(u)) {
        throw new Error("Укажите адрес сайта, например github.com");
      }
      this.dialAdd(u, title);
    });
  },

  dialRenameForm(site) {
    this.startForm("Название сайта", [{ placeholder: "Название", value: site.title || this.dialHost(site.url) }], "Сохранить", async ([title]) => {
      const state = this.dialState();
      const idx = state.pinned.findIndex(s => s.url === site.url);
      if (idx >= 0) {
        state.pinned[idx].title = title.trim().slice(0, 60);
      } else {
        state.pinned.push({ url: site.url, title: title.trim().slice(0, 60) });
      }
      this.dialSave(state);
    });
  },

  buildAgentPanel() {
    const browser = document.getElementById("browser");
    const closeBtn = this.html("button", { class: "close", "aria-label": "Скрыть панель агента", title: "Скрыть (⌘J)" }, null, [
      this.svg(["M6 6l12 12M18 6L6 18"], 14, 2.2),
    ]);
    const moreBtn = this.html("button", { class: "close more", "aria-label": "Настройки агента", title: "Модель, ключ, очистка" }, null, [
      this.svg(["M5 12h.01", "M12 12h.01", "M19 12h.01"], 16, 2.4),
    ]);
    moreBtn.addEventListener("click", e => {
      const r = e.currentTarget.getBoundingClientRect();
      this.showMenu(this.agentMenuItems(), r.right - 200, r.bottom + 6);
    });
    const input = this.html("input", { id: "tabora-agent-input", placeholder: "Спросите или поручите…", "aria-label": "Сообщение агенту" });
    const sendBtn = this.html("button", { class: "send", "aria-label": "Отправить" }, null, [
      this.svg(["M5 12h14M13 6l6 6-6 6"], 16, 2.2),
    ]);
    const chips = ["Саммари этой страницы", "Разложи вкладки по пространствам", "Найди код из последнего письма"].map(q =>
      this.html("button", { "data-q": q }, q)
    );
    const inner = this.html("div", { class: "agent-inner" }, null, [
      this.html("div", { class: "head" }, null, [
        this.html("span", { class: "orb", "aria-hidden": "true" }),
        this.html("div", { class: "who" }, null, [
          this.html("span", { class: "name" }, "Агент"),
          this.html("span", { class: "where", id: "tabora-agent-where" }, "Готов к задачам"),
        ]),
        moreBtn,
        closeBtn,
      ]),
      this.html("div", { class: "log", id: "tabora-agent-log" }, null, [
        this.html("div", { class: "msg agent" }, "Чем помочь? Могу прочитать страницу и сделать саммари, разобрать вкладки по пространствам, найти код из письма, заполнить форму или открыть что угодно."),
      ]),
      this.html("div", { class: "chips" }, null, chips),
      this.html("div", { class: "composer" }, null, [input, sendBtn]),
    ]);
    const panel = this.html("div", { id: "tabora-agent", hidden: "true" }, null, [inner]);
    panel.addEventListener("transitionend", e => {
      if (e.target === panel && e.propertyName === "width" && !panel.hasAttribute("open")) {
        panel.hidden = true;
      }
    });
    browser.append(panel);
    closeBtn.addEventListener("click", () => this.toggleAgent(false));
    const send = () => {
      if (this.agent?.busy && !input.value.trim()) {
        this.agentStop();
        return;
      }
      if (this.agentSend(input.value)) {
        input.value = "";
      }
    };
    sendBtn.addEventListener("click", send);
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        send();
      } else if (e.key === "Escape") {
        this.toggleAgent(false);
      }
    });
    for (const chip of chips) {
      chip.addEventListener("click", () => {
        input.value = chip.getAttribute("data-q");
        send();
      });
    }
  },

  toggleAgent(force) {
    const panel = document.getElementById("tabora-agent");
    const isOpen = panel.hasAttribute("open");
    const show = force === undefined ? !isOpen : force;
    document.getElementById("tabora-agent-toggle")?.setAttribute("aria-pressed", String(show));
    if (show) {
      if (this.drawer?.open && document.getElementById("browser").hasAttribute("tabora-drawer-full")) {
        this.closeDrawer(); // в узком окне место одно: панель агента занимает его вместо ящика
      }
      panel.hidden = false;
      panel.getBoundingClientRect(); // кадр на раскладку, затем выезд справа
      panel.setAttribute("open", "true");
      document.getElementById("tabora-agent-input")?.focus({ preventScroll: true });
    } else {
      panel.removeAttribute("open");
    }
    if (this.drawer?.open) {
      // панель меняет место, оставшееся ящику и странице: ящик пересчитывается, когда она доедет
      clearTimeout(this._agentResize);
      this._agentResize = setTimeout(() => this.sizeDrawer(), 240);
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
    // Щелчок по строке отличаем от фокуса, который ставит сам браузер (новая вкладка, ⌘L)
    let byPointer = false;
    document.getElementById("urlbar-container")?.addEventListener("mousedown", e => {
      if (e.button === 0) {
        byPointer = true;
        setTimeout(() => (byPointer = false), 0);
      }
    }, true);
    field.addEventListener("focus", () => {
      if (!document.getElementById("tabora-cmd")?.hidden) {
        return;
      }
      const spec = gBrowser.selectedBrowser?.currentURI?.spec || "";
      if (this.isStartUrl(spec)) {
        gURLBar.blur();
        if (byPointer) {
          // по строке щёлкнули: командная строка открывается и на новой вкладке
          this.openCommandBar();
        } else {
          // фокус поставил браузер: остаёмся на стартовой странице, набор текста откроет бар
          document.getElementById("tabora-start-input")?.focus();
        }
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
    if (this.web3Url(text)) {
      const m = text.match(/^(?:[a-z]+:\/\/)?([^/]+)(\/.*)?$/i);
      return { host: m[1], path: m[2] || "" };
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
    if (spec?.startsWith("chrome://") || spec?.startsWith("about:")) {
      const shown = this.displayUrl(spec);
      return shown === spec ? "" : shown;
    }
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
      { glyph: "↓", title: "Загрузки", note: "Ящик: прогресс и файлы под рукой", key: "⌘⇧J", tags: "downloads загрузки файлы", run: () => this.openDrawer("downloads") },
      { glyph: "◷", title: "История", note: "Ящик: посещённые страницы", key: "⌘⇧H", tags: "history история журнал", run: () => this.openDrawer("history") },
      { glyph: "★", title: "Закладки", note: "Ящик: папки и поиск", key: "⌘⇧B", tags: "bookmarks закладки избранное", run: () => this.openDrawer("bookmarks") },
      { glyph: "▣", title: "Медиа", note: "Ящик: картинки и видео со вкладок", key: "⌘⇧I", tags: "media медиа картинки видео", run: () => this.openDrawer("media") },
      { glyph: "◫", title: "Пространства", note: "Полотно: вкладки по пространствам", key: "⌘⇧S", tags: "spaces пространства контейнеры", run: () => this.openDrawer("spaces") },
      { glyph: "◈", title: "Кошелёк", note: "Ethereum, L2, Bitcoin, Solana, TRON на одной фразе", key: "⌘⇧W", tags: "wallet кошелёк крипто eth btc sol trx", run: () => this.openDrawer("wallet") },
      { glyph: "✎", title: "Написать письмо", note: "Окно письма поверх любой вкладки", key: "", tags: "compose написать письмо mail new", run: () => this.openCompose() },
      { glyph: "✉", title: "Почта и алиасы", note: "Входящие, коды подтверждения, алиасы", key: "⌘⇧M", tags: "mail почта email письма алиасы inbox", run: () => this.openMail() },
      { glyph: "⚙", title: "Настройки", note: "Поведение, приватность, внешний вид", key: "⌘,", tags: "settings preferences", run: () => openPreferences() },
      { glyph: "⟨", title: document.documentElement.getAttribute("tabora-sidebar") === "compact" ? "Развернуть боковую панель" : "Свернуть боковую панель", note: "Только значки вкладок, названия по наведению", key: "⌘B", tags: "sidebar панель свернуть compact", run: () => this.toggleSidebar() },
      { glyph: "▭", title: this.horizontalTabs ? "Вкладки сбоку" : "Вкладки сверху", note: this.horizontalTabs ? "Вернуть боковую панель с вкладками" : "Вкладки и адрес двумя строками сверху, страница на всю ширину", tags: "layout раскладка вкладки сверху сбоку горизонтальные вертикальные tabs", run: () => Services.prefs.setBoolPref(this.TABS_LAYOUT_PREF, this.horizontalTabs) },
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
          note: (this.hostOf(t.linkedBrowser?.currentURI?.spec) || "Стартовая страница") + (t.hasAttribute("pending") ? " · спит" : ""),
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

  /* ---- Пространства на контейнерах Firefox -----------------------------
   * Пространство — это контейнер Firefox; «Личное» — вкладки без контейнера. Контейнеры видны и в
   * интерфейсе Firefox (настройки «Вкладки и просмотр → Управление контейнерами», меню «Новая
   * вкладка в контейнере»), поэтому список пространств следует за службой контейнеров
   * (syncSpaces): контейнер, заведённый там, становится пространством, переименованный —
   * переименовывается, удалённый — исчезает. Контейнера вне пространств быть не должно: его
   * вкладки не видны ни в одном пространстве. Четыре контейнера, которые Firefox заводит в каждом
   * профиле сам, разбирает cleanStockContainers. */

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
    const list = Array.isArray(saved) && saved.length ? saved : this.DEFAULT_SPACES;
    if (!list.some(s => s.id === "personal")) {
      list.unshift(this.DEFAULT_SPACES[0]);
    }
    this.spaces = list.map(def => {
      let userContextId = def.id === "personal" ? 0 : def.userContextId;
      if (userContextId === undefined || (userContextId !== 0 && !known.has(userContextId))) {
        const identity = cis.create(def.name, def.icon || "circle", def.color || "yellow");
        userContextId = identity.userContextId;
      }
      return { ...def, userContextId };
    });
    Services.prefs.setStringPref("tabora.spaces", JSON.stringify(this.spaces));
    this.activeSpaceId = Services.prefs.getStringPref("tabora.spaces.active", "personal");
    if (!this.spaces.some(s => s.id === this.activeSpaceId)) {
      this.activeSpaceId = "personal";
    }

    this.renderSpacesBar();

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

    // служба сообщает об изменении раньше, чем окно, которое его сделало, сохранит свой список:
    // сверка идёт следующим шагом и читает уже сохранённое
    const observer = {
      observe: () => {
        clearTimeout(this._spacesSync);
        this._spacesSync = setTimeout(() => this.syncSpaces(), 0);
      },
    };
    const topics = ["contextual-identity-created", "contextual-identity-updated", "contextual-identity-deleted"];
    topics.forEach(topic => Services.obs.addObserver(observer, topic));
    window.addEventListener("unload", () => topics.forEach(topic => Services.obs.removeObserver(observer, topic)), { once: true });
    this.cleanStockContainers().catch(e => console.error("Tabora: stock containers", e));
  },

  /** Сверяет список пространств со службой контейнеров: порядок и номера пространств — из
   *  сохранённого списка, название, значок и цвет — из контейнера. */
  syncSpaces() {
    const cis = this.ContextualIdentityService;
    const identities = new Map(cis.getPublicIdentities().map(i => [i.userContextId, i]));
    let saved = null;
    try {
      saved = JSON.parse(Services.prefs.getStringPref("tabora.spaces", "[]"));
    } catch (e) {}
    const list = [];
    for (const space of Array.isArray(saved) && saved.length ? saved : this.spaces) {
      if (space.userContextId === 0) {
        list.push(space);
        continue;
      }
      const identity = identities.get(space.userContextId);
      if (!identity) {
        continue; // контейнер удалён
      }
      identities.delete(space.userContextId);
      list.push({ ...space, name: identity.name || space.name, icon: identity.icon, color: identity.color });
    }
    for (const identity of identities.values()) {
      // без названия — нетронутый контейнер Firefox: им занимается cleanStockContainers
      if (identity.name) {
        list.push({ id: `ctx-${identity.userContextId}`, name: identity.name, icon: identity.icon, color: identity.color, userContextId: identity.userContextId });
      }
    }
    if (!list.some(space => space.userContextId === 0)) {
      list.unshift({ ...this.DEFAULT_SPACES[0] });
    }
    const json = JSON.stringify(list);
    if (json === JSON.stringify(this.spaces)) {
      return;
    }
    this.spaces = list;
    if (Services.prefs.getStringPref("tabora.spaces", "") !== json) {
      Services.prefs.setStringPref("tabora.spaces", json);
    }
    if (!list.some(space => space.id === this.activeSpaceId)) {
      this.activeSpaceId = "personal";
      Services.prefs.setStringPref("tabora.spaces.active", "personal");
    }
    this.renderSpacesBar();
    this.applySpace();
    this.drawerDirty?.("spaces");
  },

  /** Контейнеры «Личное», «Работа», «Банкинг» и «Покупки» Firefox заводит в каждом профиле сам.
   *  Пространствами они не были, а в списках контейнеров стояли рядом с ними: «Работа» дважды,
   *  вкладка в таком контейнере не видна ни в одном пространстве. Один раз на профиль: пустой
   *  нетронутый контейнер удаляется, непустой получает своё название и становится пространством.
   *  Пустой — значит без открытых вкладок, cookie, данных сайтов и привязанных сайтов; если это
   *  не удалось проверить, контейнер считается непустым. */
  async cleanStockContainers() {
    const PREF = "tabora.spaces.stockCleaned";
    if (Services.prefs.getBoolPref(PREF, false)) {
      return;
    }
    Services.prefs.setBoolPref(PREF, true); // сразу: второе окно при запуске не начнёт то же самое
    const cis = this.ContextualIdentityService;
    const spaces = new Set(this.spaces.map(space => space.userContextId));
    const stock = cis.getPublicIdentities().filter(i => !i.name && !spaces.has(i.userContextId));
    if (!stock.length) {
      return;
    }
    const used = await this.containersInUse(stock.map(i => i.userContextId));
    for (const identity of stock) {
      const id = identity.userContextId;
      if (used.has(id)) {
        cis.update(id, cis.getUserContextLabel(id) || `Контейнер ${id}`, identity.icon, identity.color);
      } else {
        cis.remove(id);
      }
    }
  },

  async containersInUse(ids) {
    const used = new Set();
    const cis = this.ContextualIdentityService;
    for (const id of ids) {
      const tabs = [...Services.wm.getEnumerator("navigator:browser")].some(win => win.gBrowser?.tabs.some(t => parseInt(t.getAttribute("usercontextid") || "0", 10) === id));
      const cookies = Services.cookies.getCookiesWithOriginAttributes(JSON.stringify({ userContextId: id })).length;
      const sites = [...(cis._siteAssociations?.values?.() || [])].includes(id);
      if (tabs || cookies || sites) {
        used.add(id);
      }
    }
    try {
      const origins = await new Promise((resolve, reject) => {
        Services.qms.getUsage(request => (request.resultCode === Cr.NS_OK ? resolve(request.result.map(item => item.origin)) : reject(new Error("usage"))));
      });
      for (const origin of origins) {
        const id = Number(/\^(?:.*&)?userContextId=(\d+)/.exec(origin)?.[1]);
        if (ids.includes(id)) {
          used.add(id);
        }
      }
    } catch (e) {
      ids.forEach(id => used.add(id));
    }
    return used;
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
        const shown = this.displayUrl(spec);
        host = shown !== spec ? shown.split("/")[0] : new URL(spec).hostname.replace(/^www\./, "");
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
    const text = count ? `${count} ${this.plural(count, "трекер заблокирован", "трекера заблокировано", "трекеров заблокировано")}` : "";
    document.getElementById("tabora-blocked-text").textContent = text;
    // в узком окне при вкладках сверху от фишки остаются значок и число (tabora.css)
    chip.dataset.count = count || "";
    chip.title = text;
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
    const after = this.sleepAfterMs;
    if (!after) {
      return;
    }
    const limit = Date.now() - after;
    for (const tab of gBrowser.tabs) {
      const sharing = tab._sharingState?.webRTC;
      if (
        tab.selected ||
        tab.pinned ||
        tab.closing ||
        tab.hasAttribute("pending") ||
        tab.soundPlaying ||
        tab.hasAttribute("activemedia-blocked") ||
        sharing?.camera ||
        sharing?.microphone ||
        sharing?.screen ||
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
      : `${awake} ${this.plural(awake, "вкладка активна", "вкладки активны", "вкладок активны")}`;
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

  /** Фокус стоит в редакторе письма (окно письма или быстрый ответ в почте): его рамка —
   *  отдельный документ, и document.activeElement окна об этом не говорит. */
  inMailEditor() {
    const isFrame = el => !!el?.classList?.contains("tb-editor-frame");
    const active = document.activeElement;
    if (isFrame(active)) {
      return true; // окно письма
    }
    try {
      // быстрый ответ на странице почты: страница живёт в этом же процессе
      return active === gBrowser.selectedBrowser && isFrame(active.contentDocument?.activeElement);
    } catch (e) {
      return false;
    }
  },

  initKeys() {
    window.addEventListener(
      "keydown",
      e => {
        const mod = e.metaKey || e.ctrlKey;
        const editing = this.inMailEditor();
        if (!mod && !e.altKey && e.key.length === 1 && !e.isComposing) {
          // На стартовой странице любая буква открывает командную строку.
          const start = document.getElementById("tabora-start");
          const cmd = document.getElementById("tabora-cmd");
          const active = document.activeElement;
          const typing = editing || (active && (active.localName === "input" || active.localName === "textarea" || active.isContentEditable));
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
        } else if (!e.shiftKey && e.code === "KeyB" && !editing) {
          // в редакторе письма ⌘B — жирный
          this.toggleSidebar();
          e.preventDefault();
          e.stopPropagation();
        } else if (e.shiftKey && e.code === "KeyM") {
          this.toggleMail();
          e.preventDefault();
          e.stopPropagation();
        } else if (e.shiftKey && this.drawer && { KeyJ: "downloads", KeyH: "history", KeyI: "media", KeyS: "spaces", KeyB: "bookmarks", KeyW: "wallet", KeyK: "codes" }[e.code]) {
          this.toggleDrawer({ KeyJ: "downloads", KeyH: "history", KeyI: "media", KeyS: "spaces", KeyB: "bookmarks", KeyW: "wallet", KeyK: "codes" }[e.code]);
          e.preventDefault();
          e.stopPropagation();
        } else if (!e.shiftKey && e.key === "Escape" && this.drawer?.open) {
          this.closeDrawer();
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
