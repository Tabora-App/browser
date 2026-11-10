/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Почта Tabora. Интерфейс готов, данные пока демонстрационные: модуль MailStore
 * держит их в профиле (кэш зашифрован ключом сейфа). Когда появится почтовый
 * сервер на домене, MailStore заменится на настоящий источник, остальной
 * код не меняется.
 *
 * Почта — часть аккаунта: без входа (или с заблокированным сейфом) страница показывает
 * экран входа, а любое обращение к данным проходит через App.access().
 *
 * ПРАВИЛО для тела письма. Сейчас тело — список блоков, каждый выводится через textContent;
 * innerHTML на странице не используется вовсе. Когда появятся настоящие письма с HTML,
 * их можно показывать только в <iframe sandbox=""> (без allow-scripts, allow-same-origin,
 * allow-forms, allow-popups) со строгим CSP внутри (default-src 'none'; style-src
 * 'unsafe-inline'; img-src data:) — без скриптов и без загрузки внешних ресурсов
 * (картинки-маячки только по явному действию пользователя через прокси). Никогда не
 * вставлять HTML письма в DOM этой страницы: у неё системные права. */

"use strict";

const { MailStore, ACCOUNT, SPACE_COLORS } = ChromeUtils.importESModule("chrome://tabora/content/mail/MailStore.sys.mjs");
const { Account } = ChromeUtils.importESModule("chrome://tabora/content/account/Account.sys.mjs");
const { Vault } = ChromeUtils.importESModule("chrome://tabora/content/vault/Vault.sys.mjs");
const Shell = window.browsingContext?.topChromeWindow?.Tabora || null;

/* Доступ к данным почты только через этот посредник: без входа в аккаунт он отдаёт пустые
 * данные и показывает экран входа, ничего не читая из хранилища. */
const EMPTY = { v: 5, accounts: [], messages: [], aliases: [] };
const Store = new Proxy(MailStore, {
  get(target, prop, receiver) {
    switch (prop) {
      case "messages":
      case "aliases":
      case "accounts":
        return App.access() ? Reflect.get(target, prop, receiver) : [];
      case "data":
        return App.access() ? target.data : EMPTY;
      case "byId":
        return id => (App.access() ? target.byId(id) : undefined);
      case "thread":
        return id => (App.access() ? target.thread(id) : []);
      case "update":
      case "add":
      case "remove":
      case "save":
        return (...args) => (App.access() ? target[prop](...args) : undefined);
      case "unreadInbox":
        return () => (App.access() ? target.unreadInbox() : 0);
    }
    return Reflect.get(target, prop, receiver);
  },
});

const LABELS = [
  { id: "codes", name: "Коды", color: "#c8f25a" },
  { id: "news", name: "Рассылки", color: "#7cc4ff" },
  { id: "finance", name: "Финансы", color: "#ff9f5a" },
  { id: "travel", name: "Поездки", color: "#b9a6ff" },
];

const ICONS = {
  inbox: "M3 13h5l2 3h4l2-3h5M5 5h14l2 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z",
  star: "m12 3 2.8 5.9 6.4.9-4.6 4.5 1.1 6.4L12 17.7l-5.7 3 1.1-6.4L2.8 9.8l6.4-.9z",
  sent: "M21 3 3 10.5l8 2.5 2.5 8z",
  drafts: "M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17z",
  archive: "M3 4h18v5H3zM5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4",
  spam: "M12 3l9 16H3zM12 10v4M12 17.5v.5",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  clip: "m21 12-8.5 8.5a5 5 0 0 1-7-7L14 5a3.3 3.3 0 0 1 4.7 4.7L10.5 18a1.7 1.7 0 0 1-2.4-2.4L16 7.7",
  read: "M3 7l9 6 9-6M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z",
  reply: "M9 14 4 9l5-5M4 9h9a7 7 0 0 1 7 7v4",
  forward: "m15 14 5-5-5-5M20 9h-9a7 7 0 0 0-7 7v4",
  copy: "M8 8h12v12H8zM4 16V4h12",
  check: "m5 12 5 5L20 7",
  close: "M6 6l12 12M18 6 6 18",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  open: "M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5",
  mask: "M4 10c0-2.8 2.2-5 5-5h6c2.8 0 5 2.2 5 5v1.5c0 2.5-2 4.5-4.5 4.5-1.4 0-2.6-.6-3.5-1.6-.9 1-2.1 1.6-3.5 1.6C6 16 4 14 4 11.5z",
};

const FOLDERS = [
  { id: "inbox", name: "Входящие", icon: "inbox" },
  { id: "starred", name: "Со звездой", icon: "star", virtual: true },
  { id: "sent", name: "Отправленные", icon: "sent" },
  { id: "drafts", name: "Черновики", icon: "drafts" },
  { id: "archive", name: "Архив", icon: "archive" },
  { id: "spam", name: "Спам", icon: "spam" },
  { id: "trash", name: "Корзина", icon: "trash" },
];

/* ---- Утилиты ----------------------------------------------------------- */

const $ = id => document.getElementById(id);

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) {
      continue;
    }
    if (k === "class") {
      node.className = v;
    } else if (k === "text") {
      node.textContent = v;
    } else if (k === "style") {
      node.style.cssText = v; // через CSSOM: атрибут style запрещён CSP страницы
    } else if (k.startsWith("on")) {
      node.addEventListener(k.slice(2), v);
    } else if (k === "dataset") {
      Object.assign(node.dataset, v);
    } else {
      node.setAttribute(k, v === true ? "" : v);
    }
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) {
      continue;
    }
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function icon(name, size = 15, stroke = 2) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", stroke);
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}

const MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

function dayKey(iso) {
  const d = new Date(iso);
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.floor((start - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86_400_000);
  return diff <= 0 ? "today" : diff === 1 ? "yesterday" : diff < 7 ? "week" : "earlier";
}

function shortTime(iso) {
  const d = new Date(iso);
  const key = dayKey(iso);
  if (key === "today") {
    return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  }
  if (key === "yesterday") {
    return "вчера";
  }
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

function longTime(iso) {
  const d = new Date(iso);
  const key = dayKey(iso);
  const time = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  if (key === "today") {
    return `сегодня, ${time}`;
  }
  if (key === "yesterday") {
    return `вчера, ${time}`;
  }
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${time}`;
}

function dateWord(iso) {
  const key = dayKey(iso);
  if (key === "today") {
    return "сегодня";
  }
  if (key === "yesterday") {
    return "вчера";
  }
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

function size(bytes) {
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1).replace(".", ",")} МБ` : `${Math.max(1, Math.round(bytes / 1000))} КБ`;
}

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) {
    return many;
  }
  if (b > 1 && b < 5) {
    return few;
  }
  return b === 1 ? one : many;
}

function letterOf(name) {
  return (name || "?").trim().charAt(0).toUpperCase();
}

function snippetOf(m) {
  if (m.snippet) {
    return m.snippet;
  }
  const first = (m.body || []).find(b => b.p || b.h);
  return first ? first.p || first.h : "";
}

/** Ссылка из письма: открывается новой вкладкой в браузере, сама страница почты никуда не уходит. */
function mailLink(text, href, cls = "") {
  const a = el("a", { class: cls || null, href, title: href, rel: "noopener noreferrer", text });
  a.addEventListener("click", e => {
    e.preventDefault();
    e.stopPropagation();
    const shell = window.browsingContext?.topChromeWindow;
    if (/^mailto:/i.test(href)) {
      shell?.Tabora?.openCompose({ to: decodeURIComponent(href.slice(7).split("?")[0]) });
    } else if (/^https?:\/\//i.test(href)) {
      // адрес пришёл из письма: открываем как ссылку с веб-страницы, без прав браузера
      shell?.openWebLinkIn(href, "tab");
    }
  });
  return a;
}

function codeOf(m) {
  if (m.code) {
    return m.code;
  }
  const match = (m.subject || "").match(/\b\d[\d ]{3,8}\d\b/) || snippetOf(m).match(/\b\d{4,8}\b/);
  return match ? match[0] : null;
}

function validEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

/* ---- Приложение -------------------------------------------------------- */

const App = {
  view: "mail",
  folder: "inbox",
  label: null,
  query: "",
  filters: new Set(),
  selectedThread: null,
  focusIndex: 0,
  checked: new Set(),
  aliasFilter: "all",
  aliasQuery: "",
  compose: null,
  visibleThreads: [],

  started: false,
  gate: null,

  /** Письма цепочки для текущего вида: в «Корзине» — её удалённые письма (их можно открыть и
   * вернуть), в остальных папках — вся переписка, кроме удалённого. */
  threadMsgs(threadId) {
    if (this.folder === "trash" && !this.label) {
      return Store.messages.filter(m => m.thread === threadId && m.folder === "trash").sort((a, b) => a.date.localeCompare(b.date));
    }
    return Store.thread(threadId);
  },

  /** Строка аккаунта под папками: адрес из аккаунта Tabora, смена пароля и выход через оболочку. */
  initAccountRow() {
    const row = document.getElementById("account-row");
    if (!row) {
      return;
    }
    const shell = () => window.browsingContext?.topChromeWindow?.Tabora;
    $("add-box-btn").addEventListener("click", () => this.openBoxModal());
    $("refresh-btn").addEventListener("click", () => this.refresh());
    document.getElementById("account-change").addEventListener("click", () => shell()?.accountDialog("change"));
    document.getElementById("account-switch").addEventListener("click", () => shell()?.accountLogout({ thenLogin: true, blankEmail: true }));
    document.getElementById("account-logout").addEventListener("click", () => shell()?.accountLogout({ thenLogin: false }));
  },

  updateAccountRow() {
    const email = Account.email || ACCOUNT.address;
    $("account-email").textContent = email;
    $("account-avatar").textContent = (email[0] || "T").toUpperCase();
    this.renderBoxes();
  },

  /** Ящики: ящик аккаунта и внешние. Внешний можно убрать с этого компьютера. */
  renderBoxes() {
    const box = $("boxes");
    const list = MailStore.accounts;
    box.replaceChildren();
    // один только ящик аккаунта уже показан строкой аккаунта ниже: список нужен, когда есть
    // внешние ящики или с ящиком что-то не так
    box.hidden = !list.some(a => a.kind !== "tabora" || a.error);
    for (const a of list) {
      const external = a.kind !== "tabora";
      const sub = a.error ? a.error : external ? "внешний ящик" : "ящик Tabora";
      const row = el("div", { class: "box-row", dataset: { error: String(!!a.error) }, title: a.error || a.address }, [
        el("span", { class: "box-letter", "aria-hidden": "true", text: letterOf(a.address) }),
        el("span", { class: "box-text" }, [el("b", { text: a.address }), el("span", { text: sub })]),
        external
          ? el("button", {
              class: "box-remove", type: "button", "aria-label": `Убрать ящик ${a.address}`, title: "Убрать ящик с этого компьютера",
              onclick: e => {
                const btn = e.currentTarget;
                if (btn.dataset.sure !== "true") {
                  // второй щелчок подтверждает
                  btn.dataset.sure = "true";
                  btn.textContent = "Убрать?";
                  setTimeout(() => {
                    if (btn.isConnected) {
                      btn.dataset.sure = "false";
                      btn.replaceChildren(icon("close", 12, 2.4));
                    }
                  }, 4000);
                  return;
                }
                MailStore.removeAccount(a.id).then(() => this.toast(`Ящик ${a.address} убран с этого компьютера`), err => this.toast(err.message));
              },
            }, icon("close", 12, 2.4))
          : null,
      ]);
      box.append(row);
    }
  },

  refresh() {
    $("refresh-btn").dataset.busy = "true";
    MailStore.sync().finally(() => {
      $("refresh-btn").dataset.busy = "false";
    });
  },

  /** Можно ли сейчас трогать данные почты. Если нет — показать экран входа (не синхронно,
   * чтобы не мешать текущей отрисовке) и ничего не читать. */
  access() {
    if (Account.signedIn && MailStore.available) {
      return true;
    }
    if (!this._gatePending) {
      this._gatePending = true;
      Promise.resolve().then(() => {
        this._gatePending = false;
        this.checkAccess();
      });
    }
    return false;
  },

  /** Проверка входа и сейфа: при открытии и при каждом изменении аккаунта, сейфа или почты. */
  async checkAccess() {
    await Account.ready();
    if (!Account.signedIn) {
      this.showGate("signed-out");
      return false;
    }
    try {
      await MailStore.ready();
    } catch (e) {
      this.showGate(e.code === "vault-locked" ? "vault-locked" : e.code === "signed-out" ? "signed-out" : "error", e.message);
      return false;
    }
    if (!MailStore.available) {
      this.showGate("vault-locked");
      return false;
    }
    this.hideGate();
    this.updateAccountRow();
    if (!this.started) {
      this.start();
    } else {
      this.renderAll();
    }
    return true;
  },

  /** Экран вместо почты: без входа — «Войдите в аккаунт», с заблокированным сейфом — «Разблокировать». */
  showGate(kind, message = "") {
    const app = $("app");
    app.hidden = true;
    // уже показанные письма убираем со страницы
    for (const id of ["messages", "thread", "folder-list", "alias-rows", "alias-stats"]) {
      $(id)?.replaceChildren();
    }
    $("thread").hidden = true;
    $("reader-empty").hidden = false;
    $("account-email").textContent = "";
    document.title = "Почта · Tabora";
    const shell = () => window.browsingContext?.topChromeWindow?.Tabora;
    const texts = {
      "signed-out": ["Войдите в аккаунт", "Почта Tabora открывается только после входа в аккаунт.", "Войти", () => shell()?.accountDialog("login")],
      "vault-locked": ["Сейф заблокирован", "Письма хранятся на этом компьютере зашифрованными ключом сейфа. Разблокируйте его, чтобы открыть почту.", "Разблокировать", () => shell()?.vaultUnlockByUser()],
      error: ["Почта недоступна", message || "Не удалось открыть почту.", "Повторить", () => this.checkAccess()],
    };
    const [title, text, label, run] = texts[kind] || texts.error;
    const button = el("button", { class: "primary", type: "button", onclick: () => run() }, label);
    const gate = el("div", { class: "gate", role: "dialog", "aria-labelledby": "gate-title" }, [
      el("div", { class: "gate-card" }, [
        el("img", { src: "chrome://tabora/content/logo.svg", alt: "", width: "44", height: "44" }),
        el("h1", { id: "gate-title", text: title }),
        el("p", { text }),
        button,
      ]),
    ]);
    this.gate?.remove();
    this.gate = gate;
    document.body.append(gate);
    button.focus();
  },

  hideGate() {
    this.gate?.remove();
    this.gate = null;
    $("app").hidden = false;
  },

  init() {
    this.initAccountRow();
    const recheck = {
      observe: (subject, topic, what) => {
        if (topic === MailStore.TOPIC && what === "error") {
          // ошибка сервера: показываем один раз, данные перерисует следующая сверка
          const err = MailStore.lastError;
          if (err && err.at !== this._shownError) {
            this._shownError = err.at;
            this.toast(`Не получилось: ${err.where}. ${err.message}`);
          }
          return;
        }
        if (topic === MailStore.TOPIC && what === "sync") {
          $("refresh-btn").dataset.busy = String(MailStore.syncing);
          return;
        }
        $("refresh-btn").dataset.busy = String(MailStore.syncing);
        this.checkAccess();
      },
    };
    const topics = [MailStore.TOPIC, Account.TOPIC, Vault.TOPIC];
    for (const t of topics) {
      Services.obs.addObserver(recheck, t);
    }
    window.addEventListener("unload", () => topics.forEach(t => Services.obs.removeObserver(recheck, t)));
    this.checkAccess();
  },

  start() {
    this.started = true;
    this.bindStatic();
    window.TaboraSelect?.enhanceAll(document);
    window.addEventListener("hashchange", () => this.route());
    document.addEventListener("keydown", e => this.onKey(e));
    this.route();
  },

  /* Маршруты: #inbox, #folder/<id>, #label/<id>, #msg/<thread>, #aliases, #compose */
  route() {
    const hash = location.hash.replace(/^#/, "");
    const [kind, arg] = hash.split("/");
    if (kind === "aliases") {
      this.view = "aliases";
    } else {
      this.view = "mail";
      if (kind === "folder" && FOLDERS.some(f => f.id === arg)) {
        this.folder = arg;
        this.label = null;
      } else if (kind === "label" && LABELS.some(l => l.id === arg)) {
        this.label = arg;
        this.folder = null;
      } else if (kind === "msg" && arg) {
        this.selectedThread = arg;
      } else if (kind === "compose") {
        this.openCompose();
      } else if (!kind) {
        this.folder = "inbox";
        this.label = null;
      }
    }
    this.renderAll();
  },

  go(hash) {
    if (location.hash !== `#${hash}`) {
      history.replaceState(null, "", `#${hash}`);
    }
    this.route();
  },

  renderAll() {
    if (!this.access()) {
      return;
    }
    $("app").dataset.view = this.view;
    $("aliases-pane").hidden = this.view !== "aliases";
    $("list-pane").hidden = this.view !== "mail";
    $("reader").hidden = this.view !== "mail";
    this.renderFolders();
    if (this.view === "mail") {
      this.renderList();
      this.renderReader();
    } else {
      this.renderAliases();
    }
    this.updateTitle();
  },

  updateTitle() {
    const unread = Store.messages.filter(m => m.folder === "inbox" && m.unread).length;
    const where = this.view === "aliases" ? "Алиасы" : this.currentName();
    document.title = `${where}${unread && this.view === "mail" ? ` (${unread})` : ""} · Почта`;
  },

  currentName() {
    if (this.label) {
      return LABELS.find(l => l.id === this.label).name;
    }
    return FOLDERS.find(f => f.id === this.folder).name;
  },

  /* ---- Папки ---- */

  renderFolders() {
    const list = $("folder-list");
    list.replaceChildren();
    for (const f of FOLDERS) {
      const count = this.countFor(f.id);
      const selected = this.view === "mail" && !this.label && this.folder === f.id;
      const item = el("button", {
        class: "folder-item", type: "button", role: "tab", "aria-selected": String(selected),
        onclick: () => this.go(`folder/${f.id}`),
      }, [
        el("span", { class: "folder-icon" }, icon(f.icon, 16, 1.8)),
        el("span", { class: "folder-name", text: f.name }),
        count.unread ? el("span", { class: "badge", text: String(count.unread) }) : count.total ? el("span", { class: "folder-count", text: String(count.total) }) : null,
      ]);
      list.append(item);
    }
    $("aliases-count").textContent = String(Store.aliases.filter(a => a.on).length);
    $("aliases-link").setAttribute("aria-selected", String(this.view === "aliases"));
    $("aliases-link").onclick = () => this.go("aliases");
  },

  countFor(folderId) {
    const msgs = folderId === "starred"
      ? Store.messages.filter(m => m.starred && m.folder !== "trash")
      : Store.messages.filter(m => m.folder === folderId);
    const threads = new Set(msgs.map(m => m.thread));
    return {
      total: threads.size,
      unread: folderId === "inbox" || folderId === "spam" ? new Set(msgs.filter(m => m.unread).map(m => m.thread)).size : 0,
    };
  },

  threadsForView() {
    let msgs = Store.messages;
    if (this.label) {
      msgs = msgs.filter(m => m.labels.includes(this.label) && !["trash", "spam"].includes(m.folder));
    } else if (this.folder === "starred") {
      msgs = msgs.filter(m => m.starred && m.folder !== "trash");
    } else {
      msgs = msgs.filter(m => m.folder === this.folder);
    }
    const q = this.query.trim().toLowerCase();
    if (q) {
      msgs = msgs.filter(m => [m.subject, m.from.name, m.from.email, m.alias, snippetOf(m), ...(m.attachments || []).map(a => a.name)].join(" ").toLowerCase().includes(q));
    }
    if (this.filters.has("unread")) {
      msgs = msgs.filter(m => m.unread);
    }
    if (this.filters.has("attachments")) {
      msgs = msgs.filter(m => m.attachments?.length);
    }
    if (this.filters.has("codes")) {
      msgs = msgs.filter(m => codeOf(m));
    }
    if (this.filters.has("starred")) {
      msgs = msgs.filter(m => m.starred);
    }
    const byThread = new Map();
    for (const m of msgs) {
      const cur = byThread.get(m.thread);
      if (!cur || m.date > cur.latest.date) {
        byThread.set(m.thread, { latest: m, all: this.threadMsgs(m.thread) });
      }
    }
    return [...byThread.values()].sort((a, b) => b.latest.date.localeCompare(a.latest.date));
  },

  renderList() {
    const threads = this.threadsForView();
    this.visibleThreads = threads;
    const box = $("messages");
    box.replaceChildren();
    $("list-title").textContent = this.currentName();
    const unread = threads.filter(t => t.latest.unread).length;
    $("list-sub").textContent = threads.length
      ? unread ? `${unread} ${plural(unread, "новое", "новых", "новых")}` : `${threads.length} ${plural(threads.length, "письмо", "письма", "писем")}`
      : "";
    const chips = $("filter-chips");
    for (const chip of chips.querySelectorAll("[data-label]")) {
      chip.remove();
    }
    for (const l of LABELS) {
      if (l.id === "codes") {
        continue; // есть фильтр «Коды»
      }
      const total = Store.messages.filter(m => m.labels.includes(l.id) && !["trash", "spam"].includes(m.folder)).length;
      if (!total && this.label !== l.id) {
        continue;
      }
      chips.append(el("button", {
        class: "chip", type: "button", dataset: { label: l.id }, "aria-pressed": String(this.label === l.id),
        onclick: () => this.go(this.label === l.id ? `folder/${this.folder || "inbox"}` : `label/${l.id}`),
      }, [el("span", { class: "label-dot", style: `background:${l.color};margin:0` }), l.name]));
    }
    for (const chip of chips.querySelectorAll("[data-filter]")) {
      chip.setAttribute("aria-pressed", String(this.filters.has(chip.dataset.filter)));
    }
    this.renderBulk();

    if (!threads.length) {
      const filtered = this.query || this.filters.size;
      const none = !MailStore.accounts.length;
      const title = filtered ? "Ничего не нашлось" : none ? "Ящика пока нет" : MailStore.syncing && !Store.messages.length ? "Загружаем письма" : "Здесь пусто";
      const text = filtered
        ? "Попробуйте другой запрос или снимите фильтры."
        : none
          ? Account.needsServerLink
            ? "Подключите аккаунт к серверу Tabora, и адрес аккаунта начнёт принимать письма. Или добавьте свой ящик."
            : "Добавьте ящик: Gmail, Яндекс или любой другой с доступом по IMAP."
          : MailStore.syncing && !Store.messages.length
            ? "Первая загрузка занимает несколько секунд."
            : "Новые письма появятся здесь, как только придут.";
      box.append(el("div", { class: "empty" }, [
        el("strong", { text: title }),
        el("span", { text }),
        none && Account.needsServerLink ? el("button", { class: "primary", type: "button", text: "Подключить аккаунт", onclick: () => Shell?.accountDialog("link") }) : null,
        none ? el("button", { class: none && Account.needsServerLink ? "ghost" : "primary", type: "button", text: "Добавить ящик", onclick: () => this.openBoxModal() }) : null,
      ]));
      return;
    }
    if (this.focusIndex >= threads.length) {
      this.focusIndex = threads.length - 1;
    }
    const groups = [["today", "Сегодня"], ["yesterday", "Вчера"], ["week", "На этой неделе"], ["earlier", "Ранее"]];
    let index = 0;
    for (const [key, title] of groups) {
      const items = threads.filter(t => dayKey(t.latest.date) === key);
      if (!items.length) {
        continue;
      }
      box.append(el("div", { class: "group-title", text: title }));
      for (const t of items) {
        box.append(this.renderRow(t, index++));
      }
    }
  },

  renderRow(t, index) {
    const m = t.latest;
    const alias = m.alias && m.alias !== ACCOUNT.address ? m.alias : m.folder === "sent" || m.draft ? `кому: ${m.to.join(", ")}` : "";
    const code = codeOf(m);
    const row = el("button", {
      class: "msg", type: "button", role: "option",
      "aria-selected": String(this.selectedThread === t.all[0]?.thread),
      dataset: { unread: String(!!m.unread), focus: String(index === this.focusIndex), checked: String(this.checked.has(m.thread)), thread: m.thread },
      onclick: e => {
        if (e.target.closest(".check")) {
          this.toggleCheck(m.thread);
          return;
        }
        if (e.target.closest(".actions") || e.target.closest(".star")) {
          return;
        }
        this.focusIndex = index;
        this.open(m.thread);
      },
    }, [
      el("span", { class: "avatar" }, [
        letterOf(m.from.name),
        el("span", { class: "check", role: "checkbox", "aria-checked": String(this.checked.has(m.thread)), "aria-label": "Выбрать" }, icon("check", 14, 2.4)),
      ]),
      el("span", { class: "body" }, [
        el("span", { class: "row1" }, [
          el("span", { class: "from", text: m.draft ? "Черновик" : m.from.name }),
          t.all.length > 1 ? el("span", { class: "count", text: String(t.all.length) }) : null,
          el("span", { class: "time", text: shortTime(m.date) }),
        ]),
        el("span", { class: "subject", text: m.subject || "(без темы)" }),
        el("span", { class: "snippet", text: snippetOf(m) }),
        el("span", { class: "row3" }, [
          alias ? el("span", { class: "alias", text: alias }) : null,
          m.agent ? el("span", { class: "tag", text: "агент вставил код" }) : code ? el("span", { class: "tag neutral", text: "код" }) : null,
          m.newsletter ? el("span", { class: "tag neutral", text: "рассылка" }) : null,
          el("span", { class: "meta" }, [
            m.attachments?.length ? icon("clip", 13) : null,
            el("button", {
              class: "star", type: "button", dataset: { on: String(!!m.starred) }, "aria-label": m.starred ? "Снять звезду" : "Поставить звезду", "aria-pressed": String(!!m.starred),
              style: "border:0;background:transparent;padding:0;display:inline-flex",
              onclick: () => this.toggleStar(m.id),
            }, icon("star", 13, m.starred ? 0 : 2)),
          ]),
        ]),
      ]),
      el("span", { class: "actions" }, [
        el("button", { type: "button", title: m.unread ? "Прочитано" : "Не прочитано", "aria-label": m.unread ? "Отметить прочитанным" : "Отметить непрочитанным", onclick: () => this.setRead(m.thread, !!m.unread) }, icon("read", 14)),
        el("button", { type: "button", title: "В архив (E)", "aria-label": "В архив", onclick: () => this.moveThread(m.thread, "archive") }, icon("archive", 14)),
        el("button", { type: "button", title: "Удалить (#)", "aria-label": "Удалить", onclick: () => this.moveThread(m.thread, "trash") }, icon("trash", 14)),
      ]),
    ]);
    if (m.starred) {
      row.querySelector(".star svg").setAttribute("fill", "currentColor");
    }
    return row;
  },

  renderBulk() {
    const bar = $("bulk-bar");
    bar.hidden = !this.checked.size;
    $("bulk-count").textContent = String(this.checked.size);
  },

  toggleCheck(threadId) {
    if (this.checked.has(threadId)) {
      this.checked.delete(threadId);
    } else {
      this.checked.add(threadId);
    }
    this.renderList();
  },

  open(threadId) {
    this.selectedThread = threadId;
    $("app").dataset.open = "true";
    for (const m of this.threadMsgs(threadId)) {
      if (m.unread) {
        Store.update(m.id, { unread: false });
      }
    }
    history.replaceState(null, "", `#msg/${threadId}`);
    this.renderFolders();
    this.renderList();
    this.renderReader();
    this.updateTitle();
  },

  toggleStar(id) {
    const m = Store.byId(id);
    Store.update(id, { starred: !m.starred });
    this.renderFolders();
    this.renderList();
    this.renderReader();
  },

  setRead(threadId, read) {
    for (const m of this.threadMsgs(threadId)) {
      Store.update(m.id, { unread: !read });
    }
    this.renderAll();
  },

  moveThread(threadId, folder) {
    const msgs = this.threadMsgs(threadId);
    const before = msgs.map(m => [m.id, m.folder]);
    for (const m of msgs) {
      // отправленные и черновики остаются на месте, если переписку убирают в архив; из корзины
      // письмо возвращается туда, куда просят
      if (folder === "trash" || ["inbox", "spam", "archive", "trash"].includes(m.folder)) {
        Store.update(m.id, { folder });
      }
    }
    if (this.selectedThread === threadId) {
      this.selectedThread = null;
      $("app").dataset.open = "false";
    }
    this.checked.delete(threadId);
    this.renderAll();
    const names = { archive: "В архиве", trash: "Удалено", inbox: "Во входящих", spam: "В спаме" };
    this.toast(names[folder] || "Готово", () => {
      for (const [id, f] of before) {
        Store.update(id, { folder: f });
      }
      this.renderAll();
    });
  },

  bulk(action) {
    const ids = [...this.checked];
    if (action === "clear") {
      this.checked.clear();
      this.renderList();
      return;
    }
    if (action === "read") {
      for (const t of ids) {
        for (const m of this.threadMsgs(t)) {
          Store.update(m.id, { unread: false });
        }
      }
      this.checked.clear();
      this.renderAll();
      return;
    }
    const before = [];
    for (const t of ids) {
      for (const m of this.threadMsgs(t)) {
        before.push([m.id, m.folder]);
        Store.update(m.id, { folder: action });
      }
      if (this.selectedThread === t) {
        this.selectedThread = null;
      }
    }
    this.checked.clear();
    this.renderAll();
    this.toast(`${ids.length} ${plural(ids.length, "цепочка", "цепочки", "цепочек")}: ${action === "archive" ? "в архиве" : "удалено"}`, () => {
      for (const [id, f] of before) {
        Store.update(id, { folder: f });
      }
      this.renderAll();
    });
  },

  /* ---- Письмо ---- */

  renderReader() {
    const thread = this.selectedThread ? this.threadMsgs(this.selectedThread) : [];
    $("reader-empty").hidden = thread.length > 0;
    const box = $("thread");
    box.hidden = !thread.length;
    box.replaceChildren();
    if (!thread.length) {
      $("app").dataset.open = "false";
      return;
    }
    const latest = thread[thread.length - 1];
    const labels = [...new Set(thread.flatMap(m => m.labels))].map(id => LABELS.find(l => l.id === id)).filter(Boolean);
    const inTrash = latest.folder === "trash";

    const head = el("div", { class: "thread-head" }, [
      el("div", { class: "thread-title-row" }, [
        el("h2", { class: "thread-title", text: latest.subject || "(без темы)" }),
        el("button", { class: "icon-btn", type: "button", title: latest.starred ? "Снять звезду (S)" : "Звезда (S)", "aria-pressed": String(!!latest.starred), "aria-label": "Звезда", onclick: () => this.toggleStar(latest.id) }, icon("star", 15, latest.starred ? 0 : 2)),
        el("button", { class: "icon-btn", type: "button", title: "Не прочитано (U)", "aria-label": "Отметить непрочитанным", onclick: () => this.setRead(latest.thread, false) }, icon("read")),
        !inTrash ? el("button", { class: "icon-btn", type: "button", title: "В архив (E)", "aria-label": "В архив", onclick: () => this.moveThread(latest.thread, "archive") }, icon("archive")) : el("button", { class: "icon-btn", type: "button", title: "Вернуть во входящие", "aria-label": "Вернуть во входящие", onclick: () => this.moveThread(latest.thread, "inbox") }, icon("inbox")),
        el("button", { class: "icon-btn danger", type: "button", title: "Удалить (#)", "aria-label": "Удалить", onclick: () => inTrash ? this.deleteForever(latest.thread) : this.moveThread(latest.thread, "trash") }, icon("trash")),
      ]),
      labels.length ? el("div", { class: "thread-labels" }, labels.map(l => el("span", { class: "label-chip" }, [el("span", { class: "label-dot", style: `background:${l.color};margin:0` }), l.name]))) : null,
    ]);
    if (latest.starred) {
      head.querySelector('[aria-label="Звезда"] svg').setAttribute("fill", "currentColor");
    }

    const body = el("div", { class: "thread-body" });
    const code = codeOf(latest);
    if (latest.agent) {
      body.append(el("div", { class: "agent-card" }, [
        el("span", { class: "mark" }, el("span")),
        el("div", { class: "text" }, [
          el("b", { text: `Агент уже вставил этот код на ${latest.agent.site}` }),
          el("span", { text: `Регистрация ждёт вашего подтверждения во вкладке «${latest.agent.tab}»` }),
        ]),
        el("button", { class: "btn", type: "button", text: "К вкладке", onclick: () => this.toast("Переключение на вкладку появится вместе с агентом") }),
      ]));
    } else if (code) {
      body.append(el("div", { class: "code-card" }, [
        el("div", {}, [el("div", { class: "label", text: "Код подтверждения" }), el("div", { class: "code", text: code })]),
        el("span", { class: "spacer" }),
        el("span", { class: "note", text: "Найден в письме автоматически" }),
        el("button", { class: "btn", type: "button", onclick: () => this.copy(code.replace(/\s/g, ""), "Код скопирован") }, [icon("copy", 14), "Скопировать"]),
      ]));
    }

    thread.forEach((m, i) => body.append(this.renderMessage(m, i < thread.length - 1)));

    if (!latest.draft) {
      const ta = el("textarea", { placeholder: `Ответить ${latest.from.name}…`, rows: "1", "aria-label": "Быстрый ответ" });
      ta.addEventListener("input", () => {
        ta.style.height = "auto";
        ta.style.height = `${Math.min(240, ta.scrollHeight)}px`;
      });
      ta.addEventListener("keydown", e => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          this.sendQuickReply(latest, ta.value);
        }
      });
      body.append(el("div", { class: "quick-reply" }, [
        ta,
        el("div", { class: "bar" }, [
          el("span", { class: "hint", text: "⌘⏎ отправить · R развернуть ответ" }),
          el("button", { class: "btn", type: "button", onclick: () => this.openCompose({ forward: latest }) }, [icon("forward", 14), "Переслать"]),
          el("button", { class: "primary", type: "button", style: "height:32px;font-size:12px", onclick: () => this.sendQuickReply(latest, ta.value) }, "Отправить"),
        ]),
      ]));
    } else {
      body.append(el("div", { class: "quick-reply" }, [
        el("div", { class: "bar" }, [
          el("span", { class: "hint", text: "Это черновик" }),
          el("button", { class: "primary", type: "button", style: "height:32px;font-size:12px", onclick: () => this.openCompose({ draft: latest }) }, "Продолжить"),
        ]),
      ]));
    }

    box.append(head, body);
  },

  renderMessage(m, collapsed) {
    const item = el("div", { class: `mail-item${collapsed ? " collapsed" : ""}` });
    const head = el("div", { class: "mail-item-head" }, [
      el("span", { class: "avatar", text: letterOf(m.from.name) }),
      el("div", { class: "who" }, [
        el("b", { text: m.from.name }),
        el("span", { text: `${m.from.email} · ${longTime(m.date)}` }),
      ]),
      el("span", { class: "spacer" }),
      m.alias && m.alias !== ACCOUNT.address && m.folder !== "sent" && !m.draft
        ? el("button", { class: "to-chip link", type: "button", title: "Управлять алиасом", onclick: e => { e.stopPropagation(); this.go("aliases"); }, text: `через ${m.alias}` })
        : el("span", { class: "to-chip", text: m.folder === "sent" || m.draft ? `кому: ${m.to.join(", ")}` : `на ${m.to[0]}` }),
    ]);
    head.addEventListener("click", () => {
      if (item.classList.contains("collapsed")) {
        item.classList.remove("collapsed");
      }
    });
    const paper = el("div", { class: "paper" });
    // текст со ссылками: куски текста и ссылки по очереди
    const runs = block => (block.runs || []).map(r => (typeof r === "string" ? r : mailLink(r.t, r.href)));
    for (const block of m.body || []) {
      if (block.h) {
        paper.append(el("h3", { text: block.h }));
      } else if (block.p) {
        paper.append(block.runs ? el("p", {}, runs(block)) : el("p", { text: block.p }));
      } else if (block.q) {
        paper.append(block.runs ? el("blockquote", {}, runs(block)) : el("blockquote", { text: block.q }));
      } else if (block.code) {
        paper.append(el("div", { class: "big-code", text: block.code }));
      } else if (block.fine) {
        paper.append(block.runs ? el("div", { class: "fine" }, runs(block)) : el("div", { class: "fine", text: block.fine }));
      } else if (block.btn) {
        paper.append(block.href ? mailLink(block.btn, block.href, "paper-btn") : el("span", { class: "paper-btn", text: block.btn }));
      }
    }
    if (!(m.body || []).length) {
      paper.append(el("div", { class: "fine", text: "В письме нет текста." }));
    }
    if (m.images) {
      paper.append(el("div", { class: "fine", text: `Картинки из письма не загружаются (${m.images}): так отправитель не узнаёт, что письмо открыли.` }));
    }
    item.append(head, paper);
    if (m.attachments?.length) {
      item.append(el("div", { class: "attachments" }, m.attachments.map((a, index) => el("button", {
        class: "attachment", type: "button", title: `Сохранить ${a.name} в «Загрузки»`,
        onclick: e => this.saveAttachment(m, index, e.currentTarget),
      }, [
        el("span", { class: "ext", text: a.name.includes(".") ? a.name.split(".").pop().slice(0, 4) : "файл" }),
        el("span", { style: "display:flex;flex-direction:column;min-width:0" }, [el("span", { class: "name", text: a.name }), el("span", { class: "size", text: size(a.size) })]),
      ]))));
    }
    return item;
  },

  /** Вложение скачивается с сервера и сохраняется через загрузки браузера (с его же защитой). */
  async saveAttachment(m, index, button) {
    if (m.local || !m.at?.uid) {
      this.toast("Вложение этого письма осталось на сервере отправителя");
      return;
    }
    if (!Shell?.saveMailAttachment) {
      this.toast("Вложения сохраняются только внутри Tabora");
      return;
    }
    button.disabled = true;
    button.dataset.busy = "true";
    try {
      const name = await Shell.saveMailAttachment(m.id, index);
      this.toast(`Сохранено в «Загрузки»: ${name}`);
    } catch (e) {
      this.toast(`Вложение не сохранено. ${e.message}`);
    } finally {
      button.disabled = false;
      button.dataset.busy = "false";
    }
  },

  deleteForever(threadId) {
    const msgs = this.threadMsgs(threadId).concat(Store.messages.filter(m => m.thread === threadId));
    for (const m of new Set(msgs)) {
      Store.remove(m.id);
    }
    this.selectedThread = null;
    this.renderAll();
    this.toast("Удалено навсегда");
  },

  async sendQuickReply(to, text) {
    if (!text.trim()) {
      this.openCompose({ reply: to });
      return;
    }
    if (this._sending) {
      return;
    }
    this._sending = true;
    // отвечаем с того адреса, на который письмо пришло (алиас остаётся алиасом)
    const mine = MailStore.senders().map(s => s.address);
    const from = mine.includes(to.alias) ? to.alias : ACCOUNT.address;
    const subject = /^re:/i.test(to.subject || "") ? to.subject : `Re: ${to.subject || ""}`.trim();
    try {
      await MailStore.send({ from: { email: from }, to: [to.replyTo || to.from.email], subject, text, replyTo: to.id, labels: to.labels });
      this.renderAll();
      this.toast(`Ответ отправлен ${to.from.name}`);
    } catch (e) {
      this.toast(`Ответ не отправлен. ${e.message}`);
    } finally {
      this._sending = false;
    }
  },

  /* ---- Написать: окно живёт в оболочке браузера ---- */

  openCompose(opts = {}) {
    if (!Shell?.openCompose) {
      this.toast("Окно письма доступно только внутри Tabora");
      return;
    }
    Shell.openCompose({
      replyTo: opts.reply?.id,
      forwardOf: opts.forward?.id,
      draftId: opts.draft?.id,
      to: opts.to,
    });
  },

  /* ---- Алиасы ---- */

  renderAliases() {
    const all = Store.aliases;
    const on = all.filter(a => a.on).length;
    const agent = all.filter(a => a.agent).length;
    $("alias-stats").replaceChildren(
      this.stat("Активных", String(on)),
      this.stat("Выключено", String(all.length - on)),
      this.stat("Создано агентом", String(agent), true),
      this.stat("Писем на алиасы", String(all.reduce((n, a) => n + (a.count || 0), 0))),
    );
    for (const chip of $("alias-filters").children) {
      chip.setAttribute("aria-pressed", String(chip.dataset.afilter === this.aliasFilter));
    }
    const q = this.aliasQuery.trim().toLowerCase();
    let rows = all.filter(a => !q || `${a.address} ${a.site} ${a.space}`.toLowerCase().includes(q));
    if (this.aliasFilter === "on") {
      rows = rows.filter(a => a.on);
    } else if (this.aliasFilter === "off") {
      rows = rows.filter(a => !a.on);
    } else if (this.aliasFilter === "agent") {
      rows = rows.filter(a => a.agent);
    }
    rows.sort((a, b) => b.created.localeCompare(a.created));
    const box = $("alias-rows");
    box.replaceChildren();
    if (!rows.length) {
      box.append(el("div", { class: "empty" }, [el("strong", { text: "Ничего не нашлось" })]));
      return;
    }
    for (const a of rows) {
      box.append(el("div", { class: "alias-row", dataset: { on: String(a.on) } }, [
        el("span", { class: "glyph", text: letterOf(a.site) }),
        el("span", { class: "addr" }, [
          el("button", { type: "button", text: a.address, title: "Скопировать адрес", onclick: () => this.copy(a.address, "Адрес скопирован") }),
          a.warn ? el("span", { class: "warn", text: a.on ? a.warn : a.warn.startsWith("выключен") ? a.warn : `выключен · ${a.warn}` }) : !a.on ? el("span", { class: "warn", text: "выключен" }) : null,
        ]),
        el("span", { class: "site" }, [el("b", { text: a.site }), el("span", { text: `создан: ${a.by}` })]),
        el("span", { class: "num", text: String(a.count) }),
        el("span", { class: "date", text: dateWord(a.created) }),
        el("span", {}, el("span", { class: "space-pill", text: a.space, style: `--space-color:${SPACE_COLORS[a.space] || "#ecedef"}` })),
        el("button", {
          class: "toggle", type: "button", role: "switch", "aria-checked": String(a.on),
          "aria-label": `Алиас ${a.address} ${a.on ? "включён" : "выключен"}`,
          onclick: async e => {
            const btn = e.currentTarget;
            btn.disabled = true;
            try {
              const next = await MailStore.aliasSet(a.id, !a.on);
              this.toast(next.on ? `Алиас ${a.address.split("@")[0]} включён` : "Алиас выключен: письма на него больше не придут");
            } catch (err) {
              this.toast(`Алиас не изменён. ${err.message}`);
            }
            this.renderAliases();
            this.renderFolders();
          },
        }),
      ]));
    }
  },

  stat(label, value, accent = false) {
    return el("div", { class: "stat" }, [el("span", { class: "l", text: label }), el("span", { class: `v${accent ? " accent" : ""}`, text: value })]);
  },

  openAliasModal() {
    if (!MailStore.accounts.some(a => a.kind === "tabora")) {
      this.toast(Account.needsServerLink ? "Алиасы появятся после подключения аккаунта к серверу Tabora" : "Алиасы работают для ящика Tabora");
      return;
    }
    $("alias-modal").hidden = false;
    $("alias-site").value = "";
    $("alias-note").textContent = `Адрес подберёт сервер: название сайта и четыре случайных знака, например booking-k3f9@${ACCOUNT.domain}.`;
    setTimeout(() => $("alias-site").focus(), 20);
  },

  async createAlias() {
    const button = $("alias-create");
    if (button.disabled) {
      return;
    }
    button.disabled = true;
    try {
      const a = await MailStore.aliasCreate({ site: $("alias-site").value.trim(), space: $("alias-space").value, by: "manual" });
      $("alias-modal").hidden = true;
      this.renderAliases();
      this.renderFolders();
      this.copy(a.address, `Алиас создан и скопирован: ${a.address}`);
    } catch (e) {
      this.toast(`Алиас не создан. ${e.message}`);
    } finally {
      button.disabled = false;
    }
  },

  /* ---- Внешний ящик ---- */

  openBoxModal() {
    for (const id of ["box-address", "box-password", "box-imap-host", "box-imap-port", "box-smtp-host", "box-smtp-port", "box-login"]) {
      $(id).value = "";
      delete $(id).dataset.edited;
    }
    $("box-note").hidden = true;
    $("box-error").hidden = true;
    $("box-more").open = false;
    $("box-modal").hidden = false;
    setTimeout(() => $("box-address").focus(), 20);
  },

  /** Адрес введён: подставляем серверы известной службы или автонастройку домена. */
  async guessBox() {
    const address = $("box-address").value.trim();
    if (!validEmail(address) || address === this._guessedFor) {
      return;
    }
    this._guessedFor = address;
    const g = await MailStore.guessSettings(address).catch(() => null);
    if (!g || $("box-address").value.trim() !== address) {
      return;
    }
    const set = (id, value) => {
      if ($(id).dataset.edited !== "true") {
        $(id).value = String(value);
      }
    };
    set("box-imap-host", g.imap.host);
    set("box-imap-port", g.imap.port);
    set("box-smtp-host", g.smtp.host);
    set("box-smtp-port", g.smtp.port);
    $("box-note").textContent = g.note || (g.source === "guess" ? "Серверы подставлены по имени домена: проверьте их в разделе «Серверы»." : "");
    $("box-note").hidden = !$("box-note").textContent;
    if (g.source === "guess") {
      $("box-more").open = true;
    }
  },

  async addBox() {
    const button = $("box-add");
    if (button.disabled) {
      return;
    }
    const error = $("box-error");
    error.hidden = true;
    const address = $("box-address").value.trim();
    if (!validEmail(address)) {
      error.textContent = "Проверьте адрес почты";
      error.hidden = false;
      $("box-address").focus();
      return;
    }
    button.disabled = true;
    button.textContent = "Проверяем…";
    try {
      await this.guessBox();
      const r = await MailStore.addAccount({
        address,
        password: $("box-password").value,
        login: $("box-login").value.trim(),
        imap: { host: $("box-imap-host").value, port: $("box-imap-port").value },
        smtp: { host: $("box-smtp-host").value, port: $("box-smtp-port").value },
      });
      $("box-modal").hidden = true;
      $("box-password").value = "";
      this.toast(`Ящик ${r.address} добавлен: загружаем письма`);
      this.renderAll();
    } catch (e) {
      // ответ сервера (например, требование пароля приложения) показываем как есть
      error.textContent = e.server ? `${e.message}. Ответ сервера: ${e.server}` : e.message;
      error.hidden = false;
      $("box-more").open = $("box-more").open || e.code === "network" || e.code === "protocol" || e.code === "tls";
    } finally {
      button.disabled = false;
      button.textContent = "Проверить и добавить";
    }
  },

  /* ---- Служебное ---- */

  async copy(text, message) {
    try {
      await navigator.clipboard.writeText(text);
      this.toast(message);
    } catch (e) {
      this.toast("Не удалось скопировать");
    }
  },

  toast(text, undo, undoLabel = "Отменить") {
    const box = $("toasts");
    const node = el("div", { class: "toast", role: "status" }, [
      el("span", { text }),
      undo ? el("button", { type: "button", text: undoLabel, onclick: () => {
        undo();
        node.remove();
      } }) : null,
    ]);
    box.append(node);
    while (box.children.length > 3) {
      box.firstChild.remove();
    }
    setTimeout(() => node.remove(), undo ? 7000 : 3200);
  },

  moveFocus(delta) {
    if (!this.visibleThreads.length) {
      return;
    }
    this.focusIndex = Math.max(0, Math.min(this.visibleThreads.length - 1, this.focusIndex + delta));
    this.renderList();
    const row = $("messages").querySelector('.msg[data-focus="true"]');
    row?.scrollIntoView({ block: "nearest" });
    if (this.selectedThread) {
      this.open(this.visibleThreads[this.focusIndex].latest.thread);
    }
  },

  focusedThread() {
    return this.visibleThreads[this.focusIndex]?.latest.thread || this.selectedThread;
  },

  onKey(e) {
    if (!this.access()) {
      return;
    }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if (e.key === "Escape") {
      if (!$("alias-modal").hidden) {
        $("alias-modal").hidden = true;
      } else if (!$("box-modal").hidden) {
        $("box-modal").hidden = true;
      } else if (this.checked.size) {
        this.checked.clear();
        this.renderList();
      } else if (typing) {
        e.target.blur();
      } else if (this.selectedThread) {
        this.selectedThread = null;
        history.replaceState(null, "", this.label ? `#label/${this.label}` : `#folder/${this.folder}`);
        this.renderAll();
      }
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) {
      return;
    }
    const map = {
      j: () => this.moveFocus(1),
      k: () => this.moveFocus(-1),
      ArrowDown: () => this.moveFocus(1),
      ArrowUp: () => this.moveFocus(-1),
      Enter: () => this.focusedThread() && this.open(this.focusedThread()),
      o: () => this.focusedThread() && this.open(this.focusedThread()),
      e: () => this.focusedThread() && this.moveThread(this.focusedThread(), "archive"),
      "#": () => this.focusedThread() && this.moveThread(this.focusedThread(), "trash"),
      s: () => this.focusedThread() && this.toggleStar(this.threadMsgs(this.focusedThread()).at(-1).id),
      u: () => this.focusedThread() && this.setRead(this.focusedThread(), false),
      x: () => this.focusedThread() && this.toggleCheck(this.focusedThread()),
      c: () => this.openCompose(),
      r: () => this.selectedThread && this.openCompose({ reply: this.threadMsgs(this.selectedThread).at(-1) }),
      f: () => this.selectedThread && this.openCompose({ forward: this.threadMsgs(this.selectedThread).at(-1) }),
      "/": () => (this.view === "aliases" ? $("alias-search") : $("search-input")).focus(),
      "?": () => this.toast("J/K листать · ⏎ открыть · E архив · # удалить · S звезда · U непрочитано · X выбрать · C написать · R ответить · F переслать · / поиск"),
    };
    if (this.pendingG) {
      this.pendingG = false;
      const go = { i: "folder/inbox", s: "folder/starred", t: "folder/sent", d: "folder/drafts", a: "aliases" }[e.key];
      if (go) {
        e.preventDefault();
        this.go(go);
      }
      return;
    }
    if (e.key === "g") {
      this.pendingG = true;
      setTimeout(() => (this.pendingG = false), 900);
      return;
    }
    const fn = map[e.key];
    if (fn) {
      e.preventDefault();
      fn();
    }
  },

  bindStatic() {
    $("compose-btn").addEventListener("click", () => this.openCompose());

    $("search-input").addEventListener("input", e => {
      this.query = e.target.value;
      this.focusIndex = 0;
      this.renderList();
    });
    $("search-input").addEventListener("keydown", e => {
      if (e.key === "Enter") {
        e.target.blur();
        $("messages").focus();
      }
    });
    $("filter-chips").addEventListener("click", e => {
      const chip = e.target.closest(".chip");
      if (!chip) {
        return;
      }
      const f = chip.dataset.filter;
      if (this.filters.has(f)) {
        this.filters.delete(f);
      } else {
        this.filters.add(f);
      }
      this.renderList();
    });
    for (const b of $("bulk-bar").querySelectorAll("[data-icon]")) {
      b.prepend(icon(b.dataset.icon, 14));
    }
    $("bulk-bar").addEventListener("click", e => {
      const btn = e.target.closest("[data-bulk]");
      if (btn) {
        this.bulk(btn.dataset.bulk);
      }
    });

    $("new-alias-btn").addEventListener("click", () => this.openAliasModal());
    $("alias-cancel").addEventListener("click", () => ($("alias-modal").hidden = true));
    $("alias-modal").addEventListener("click", e => {
      if (e.target === $("alias-modal")) {
        $("alias-modal").hidden = true;
      }
    });
    $("alias-create").addEventListener("click", () => this.createAlias());
    $("alias-site").addEventListener("keydown", e => e.key === "Enter" && this.createAlias());

    $("box-cancel").addEventListener("click", () => ($("box-modal").hidden = true));
    $("box-modal").addEventListener("click", e => {
      if (e.target === $("box-modal")) {
        $("box-modal").hidden = true;
      }
    });
    $("box-add").addEventListener("click", () => this.addBox());
    $("box-address").addEventListener("change", () => this.guessBox());
    $("box-password").addEventListener("focus", () => this.guessBox());
    for (const id of ["box-imap-host", "box-imap-port", "box-smtp-host", "box-smtp-port"]) {
      $(id).addEventListener("input", e => (e.target.dataset.edited = "true"));
    }
    for (const id of ["box-address", "box-password", "box-login"]) {
      $(id).addEventListener("keydown", e => e.key === "Enter" && this.addBox());
    }
    $("alias-search").addEventListener("input", e => {
      this.aliasQuery = e.target.value;
      this.renderAliases();
    });
    $("alias-filters").addEventListener("click", e => {
      const chip = e.target.closest(".chip");
      if (chip) {
        this.aliasFilter = chip.dataset.afilter;
        this.renderAliases();
      }
    });
  },
};

App.init();
// Для отладки и инструментов проверки (tools/chrome_ctl.py).
window.App = App;
window.Store = Store;
