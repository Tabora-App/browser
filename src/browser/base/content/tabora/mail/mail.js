/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Почта Tabora: страница tabora://mail. Данные и работу с серверами держит MailStore
 * (mail/MailStore.sys.mjs): ящик аккаунта и внешние ящики по IMAP и SMTP, кэш в профиле
 * зашифрован ключом сейфа.
 *
 * Почта — часть аккаунта: без входа (или с заблокированным сейфом) страница показывает
 * экран входа, а любое обращение к данным проходит через App.access().
 *
 * ПРАВИЛО для тела письма. У этой страницы системные права, поэтому разметка письма в её DOM
 * не попадает никогда и innerHTML на странице не используется вовсе. Простое письмо — список
 * блоков, каждый выводится через textContent. Письмо с вёрсткой показывается в отдельном
 * процессе содержимого: элемент browser (группа сообщений "tabora-mail", JavaScript выключен)
 * с документом data:, который собирает MailView — очищенная разметка под политикой
 * содержимого default-src 'none'. Картинки с чужих серверов грузятся только по явному
 * действию пользователя. Из того процесса сюда приходят лишь высота содержимого и адреса
 * ссылок (актор TaboraMailView), и они проверяются. */

"use strict";

const { MailStore, ACCOUNT, SPACE_COLORS } = ChromeUtils.importESModule("chrome://tabora/content/mail/MailStore.sys.mjs");
const { Account } = ChromeUtils.importESModule("chrome://tabora/content/account/Account.sys.mjs");
const { Vault } = ChromeUtils.importESModule("chrome://tabora/content/vault/Vault.sys.mjs");
const { RichEditor } = ChromeUtils.importESModule("chrome://tabora/content/mail/RichEditor.sys.mjs");
// языки: надписи в коде (tt`…`) и в разметке mail.html (переводятся здесь же, до показа)
const { tt, tr: ttr, form: ttForm, locale: ttLocale, translateDocument } = ChromeUtils.importESModule("chrome://tabora/content/i18n/I18n.sys.mjs");
translateDocument(document);
const Shell = window.browsingContext?.topChromeWindow?.Tabora || null;
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, { Pgp: "chrome://tabora/content/mail/Pgp.sys.mjs" });

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
  { id: "codes", name: tt`Коды`, color: "#c8f25a" },
  { id: "news", name: tt`Рассылки`, color: "#7cc4ff" },
  { id: "finance", name: tt`Финансы`, color: "#ff9f5a" },
  { id: "travel", name: tt`Поездки`, color: "#b9a6ff" },
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
  lock: "M7 11V8a5 5 0 0 1 10 0v3M6 11h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z",
  seal: "M12 3 5 6v5c0 4.6 2.9 8.2 7 10 4.1-1.8 7-5.4 7-10V6zM9 12l2 2 4-4",
  back: "M15 5l-7 7 7 7",
  image: "M4 5h16v14H4zM4 16l4.5-4.5 3.5 3.5 3-3 5 5M9 9.5h.01",
  alert: "M12 3 5 6v5c0 4.6 2.9 8.2 7 10 4.1-1.8 7-5.4 7-10V6zM12 8v5M12 16.5v.5",
};

/* Что сказать о защите письма (OpenPGP): [тон, значок, заголовок, пояснение]. Тон: ok — письму
 * можно верить, warn — защита неполная, bad — письму верить нельзя, info — дело в процессе. */
function pgpNote(m) {
  const p = m.pgp;
  if (!p) {
    return null;
  }
  const mine = m.folder === "sent" || m.folder === "drafts";
  if (p.pending) {
    return ["info", "lock", tt`Письмо зашифровано`, tt`Расшифровываем…`];
  }
  if (p.error) {
    const why = {
      "no-key": tt`Оно зашифровано ключом, которого нет в этом профиле. Прочитать его можно там, где этот ключ есть.`,
      locked: tt`Когда письмо пришло, сейф был закрыт.`,
    }[p.error] || tt`Письмо повреждено или зашифровано способом, которого Tabora не знает.`;
    return ["warn", "lock", tt`Письмо не расшифровано`, why];
  }
  const other = tt`Подпись сделана ключом адреса ${p.signer}, а не отправителя.`;
  const noKey = tt`Ключа, которым оно подписано, здесь нет: он придёт с письмом отправителя или добавляется в разделе «Шифрование».`;
  if (p.encrypted) {
    return {
      valid: ["ok", "lock", tt`Зашифровано и подписано`, mine ? tt`Прочитать письмо можете только вы и получатели.` : tt`Прочитать письмо могли только вы и другие получатели. Подпись отправителя верна.`],
      none: ["warn", "lock", tt`Зашифровано, но не подписано`, tt`Прочитать письмо могли только получатели, а вот кто его написал, проверить нельзя.`],
      unknown: ["warn", "lock", tt`Зашифровано, подпись не проверена`, noKey],
      other: ["warn", "lock", tt`Зашифровано, подписано другим адресом`, other],
      invalid: ["bad", "alert", tt`Зашифровано, но подпись неверна`, tt`Письмо изменили после подписи или подписал его не отправитель.`],
    }[p.signature] || ["ok", "lock", tt`Зашифровано`, tt`Прочитать письмо могли только получатели.`];
  }
  return {
    valid: ["ok", "seal", tt`Подпись верна`, tt`Письмо написал владелец этого адреса, и в пути оно не менялось.`],
    unknown: ["info", "seal", tt`Подпись не проверена`, noKey],
    other: ["warn", "seal", tt`Подписано другим адресом`, other],
    invalid: ["bad", "alert", tt`Подпись неверна`, tt`Письмо изменили в пути или подписал его не отправитель.`],
  }[p.signature] || null;
}

/** Отпечаток ключа группами по четыре знака: так его сверяют по телефону. */
function fingerprintText(fp) {
  return String(fp || "").toUpperCase().replace(/(.{4})/g, "$1 ").trim();
}

const FOLDERS = [
  { id: "inbox", name: tt`Входящие`, icon: "inbox" },
  { id: "starred", name: tt`Со звездой`, icon: "star", virtual: true },
  { id: "sent", name: tt`Отправленные`, icon: "sent" },
  { id: "drafts", name: tt`Черновики`, icon: "drafts" },
  { id: "archive", name: tt`Архив`, icon: "archive" },
  { id: "spam", name: tt`Спам`, icon: "spam" },
  { id: "trash", name: tt`Корзина`, icon: "trash" },
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

const MONTHS = [tt`янв`, tt`фев`, tt`мар`, tt`апр`, tt`мая`, tt`июн`, tt`июл`, tt`авг`, tt`сен`, tt`окт`, tt`ноя`, tt`дек`];

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
    return d.toLocaleTimeString(ttLocale(), { hour: "2-digit", minute: "2-digit" });
  }
  if (key === "yesterday") {
    return tt`вчера`;
  }
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

function longTime(iso) {
  const d = new Date(iso);
  const key = dayKey(iso);
  const time = d.toLocaleTimeString(ttLocale(), { hour: "2-digit", minute: "2-digit" });
  if (key === "today") {
    return tt`сегодня, ${time}`;
  }
  if (key === "yesterday") {
    return tt`вчера, ${time}`;
  }
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${time}`;
}

function dateWord(iso) {
  const key = dayKey(iso);
  if (key === "today") {
    return tt`сегодня`;
  }
  if (key === "yesterday") {
    return tt`вчера`;
  }
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

function size(bytes) {
  return bytes >= 1_000_000 ? tt`${(bytes / 1_000_000).toFixed(1).replace(".", ",")} МБ` : tt`${Math.max(1, Math.round(bytes / 1000))} КБ`;
}

function plural(n, forms) {
  return ttForm(n, forms);
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

/** Адрес из письма: сайт открывается новой вкладкой, почтовый адрес — окном нового письма.
 * Страница почты при этом никуда не уходит. */
function openMailHref(href) {
  const shell = window.browsingContext?.topChromeWindow;
  if (/^mailto:/i.test(href)) {
    let to = href.slice(7).split("?")[0];
    try {
      to = decodeURIComponent(to);
    } catch (e) {}
    shell?.Tabora?.openCompose({ to });
  } else if (/^https?:\/\//i.test(href)) {
    // адрес пришёл из письма: открываем как ссылку с веб-страницы, без прав браузера
    shell?.openWebLinkIn(href, "tab");
  }
}

/** Ссылка из письма в блоках страницы почты. */
function mailLink(text, href, cls = "") {
  const a = el("a", { class: cls || null, href, title: href, rel: "noopener noreferrer", text });
  a.addEventListener("click", e => {
    e.preventDefault();
    e.stopPropagation();
    openMailHref(href);
  });
  return a;
}

/* ---- Письмо с вёрсткой: элемент browser в отдельном процессе (см. mail/MailView.sys.mjs) ---- */

try {
  ChromeUtils.registerWindowActor("TaboraMailView", {
    parent: { esModuleURI: "chrome://tabora/content/actors/TaboraMailViewParent.sys.mjs" },
    child: {
      esModuleURI: "chrome://tabora/content/actors/TaboraMailViewChild.sys.mjs",
      events: {
        DOMContentLoaded: {},
        click: { capture: true },
        auxclick: { capture: true },
        dragover: { capture: true },
        drop: { capture: true },
        submit: { capture: true },
        mouseover: {},
        mouseout: {},
      },
    },
    // только элементы просмотра письма: у вкладок с сайтами другая группа сообщений
    messageManagerGroups: ["tabora-mail"],
    allFrames: false,
    // письмо живёт в обычном процессе содержимого; всё, что актор оттуда присылает, проверяется
    safeForUntrustedWebProcess: true,
  });
} catch (e) {
  // уже зарегистрирован: страницу почты открывали раньше
}

/** Процесс содержимого для элемента просмотра письма готов принять документ. */
function frameReady(browser) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (browser.frameLoader?.remoteTab) {
        resolve();
      } else if (!browser.isConnected || Date.now() - started > 2500) {
        // процесс для письма создаётся сразу; если его нет, движок не дал встроить просмотр
        reject(new Error(tt`Просмотр письма не запустился`));
      } else {
        setTimeout(tick, 30);
      }
    };
    tick();
  });
}

/** Код подтверждения письма: его находит разбор письма (Mime.findCode), здесь догадок нет. */
function codeOf(m) {
  return m.code || null;
}

/** Кнопка на время работы: не нажимается и показывает кольцо (надпись остаётся на месте
 * невидимой, ширина кнопки не меняется). */
function setBusy(button, on) {
  if (!button) {
    return;
  }
  button.disabled = on;
  button.classList.toggle("loading", on);
  if (on) {
    button.setAttribute("aria-busy", "true");
  } else {
    button.removeAttribute("aria-busy");
  }
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
  box: null, // показаны письма только этого ящика (его id) или всех
  replyTexts: new Map(), // набранный быстрый ответ по цепочкам ({ text, html }): переживает уход из переписки
  _reply: null, // быстрый ответ открытой переписки: { thread, el, editor, update }
  sendingReply: null, // цепочка, ответ на которую сейчас отправляется
  expanded: new Set(), // письма открытой цепочки, развёрнутые вручную
  htmlHeights: new Map(), // высота писем с вёрсткой: при повторном показе место отводится сразу
  htmlImages: new Set(), // письма, которым разрешили загрузить картинки с чужих серверов

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
    // системные уведомления о новых письмах: настройка читается хранилищем почты при каждой сверке
    const notify = document.getElementById("account-notify");
    const notifyOn = () => Services.prefs.getBoolPref("tabora.mail.notify", true);
    notify.setAttribute("aria-checked", String(notifyOn()));
    notify.addEventListener("click", () => {
      const on = !notifyOn();
      Services.prefs.setBoolPref("tabora.mail.notify", on);
      notify.setAttribute("aria-checked", String(on));
      this.toast(on ? tt`О новых письмах будет сообщать уведомление` : tt`Уведомления о новых письмах выключены`);
    });
    // подсказка адреса в полях почты на сайтах (её показывает оболочка, см. vault.js)
    const suggest = document.getElementById("account-suggest");
    const suggestOn = () => Services.prefs.getBoolPref("tabora.mail.suggest", true);
    suggest.setAttribute("aria-checked", String(suggestOn()));
    suggest.addEventListener("click", () => {
      const on = !suggestOn();
      Services.prefs.setBoolPref("tabora.mail.suggest", on);
      suggest.setAttribute("aria-checked", String(on));
      this.toast(on ? tt`В полях почты на сайтах будут предлагаться алиас и основной адрес` : tt`Адрес в полях почты на сайтах больше не предлагается`);
    });
    document.getElementById("account-change").addEventListener("click", () => shell()?.accountDialog("change"));
    document.getElementById("account-switch").addEventListener("click", () => shell()?.accountShowAccounts());
    document.getElementById("account-logout").addEventListener("click", () => shell()?.accountLogout({ thenLogin: false }));
  },

  updateAccountRow() {
    const email = Account.email || ACCOUNT.address;
    $("account-email").textContent = email;
    $("account-avatar").textContent = (email[0] || "T").toUpperCase();
    this.renderBoxes();
  },

  /** Ящики: ящик аккаунта и внешние. Щелчок по ящику оставляет в списках только его письма,
   * повторный возвращает все. Внешний ящик можно убрать с этого компьютера. */
  renderBoxes() {
    const box = $("boxes");
    const list = MailStore.accounts;
    box.replaceChildren();
    // один только ящик аккаунта уже показан строкой аккаунта ниже: список нужен, когда есть
    // внешние ящики или с ящиком что-то не так
    box.hidden = !list.some(a => a.kind !== "tabora" || a.error);
    if (this.box && !list.some(a => a.id === this.box)) {
      this.box = null;
    }
    const pickable = list.length > 1;
    for (const a of list) {
      const external = a.kind !== "tabora";
      const selected = this.box === a.id;
      const sub = a.error ? a.error : external ? tt`внешний ящик` : tt`ящик Tabora`;
      const inner = [
        el("span", { class: "box-letter", "aria-hidden": "true", text: letterOf(a.address) }),
        el("span", { class: "box-text" }, [el("b", { text: a.address }), el("span", { text: sub })]),
      ];
      const row = el("div", { class: "box-row", dataset: { error: String(!!a.error), selected: String(selected), static: String(!pickable && !external) } }, [
        pickable
          ? el("button", {
              class: "box-pick", type: "button", "aria-pressed": String(selected),
              title: a.error || (selected ? tt`Показать письма всех ящиков` : tt`Показать только письма ящика ${a.address}`),
              onclick: () => this.pickBox(a.id),
            }, inner)
          : el("div", { class: "box-pick", title: a.error || a.address }, inner),
        external
          ? el("button", {
              class: "box-remove", type: "button", "aria-label": tt`Убрать ящик ${a.address}`, title: tt`Убрать ящик с этого компьютера`,
              onclick: e => {
                const btn = e.currentTarget;
                if (btn.dataset.sure !== "true") {
                  // второй щелчок подтверждает
                  btn.dataset.sure = "true";
                  btn.textContent = tt`Убрать?`;
                  setTimeout(() => {
                    if (btn.isConnected) {
                      btn.dataset.sure = "false";
                      btn.replaceChildren(icon("close", 12, 2.4));
                    }
                  }, 4000);
                  return;
                }
                MailStore.removeAccount(a.id).then(() => this.toast(tt`Ящик ${a.address} убран с этого компьютера`), err => this.toast(err.message));
              },
            }, icon("close", 12, 2.4))
          : null,
      ]);
      box.append(row);
    }
  },

  pickBox(id) {
    this.box = this.box === id ? null : id;
    this.checked.clear();
    this.focusIndex = 0;
    if (this.box && this.selectedThread && !this.threadMsgs(this.selectedThread).some(m => m.account === this.box)) {
      this.selectedThread = null; // открытое письмо лежит в другом ящике
    }
    this.renderBoxes();
    this.setNav(false);
    if (this.view !== "mail") {
      this.go(`folder/${this.folder || "inbox"}`);
    } else {
      this.renderAll();
    }
  },

  /** Письма с учётом выбранного ящика. */
  scope() {
    return this.box ? Store.messages.filter(m => m.account === this.box) : Store.messages;
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
    for (const id of ["messages", "thread", "folder-list", "alias-rows", "alias-stats", "keys-body"]) {
      $(id)?.replaceChildren();
    }
    $("thread").hidden = true;
    $("reader-empty").hidden = false;
    $("account-email").textContent = "";
    document.title = tt`Почта · Tabora`;
    const shell = () => window.browsingContext?.topChromeWindow?.Tabora;
    const texts = {
      "signed-out": [tt`Войдите в аккаунт`, tt`Почта Tabora открывается только после входа в аккаунт.`, tt`Войти`, () => shell()?.accountDialog("login")],
      "vault-locked": [tt`Сейф заблокирован`, tt`Письма хранятся на этом компьютере зашифрованными ключом сейфа. Разблокируйте его, чтобы открыть почту.`, tt`Разблокировать`, () => shell()?.vaultUnlockByUser()],
      error: [tt`Почта недоступна`, message || tt`Не удалось открыть почту.`, tt`Повторить`, () => this.checkAccess()],
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
            this.toast(tt`Не получилось: ${err.where}. ${err.message}`);
          }
          return;
        }
        if (topic === MailStore.TOPIC && what === "sync") {
          $("refresh-btn").dataset.busy = String(MailStore.syncing);
          return;
        }
        $("refresh-btn").dataset.busy = String(MailStore.syncing);
        if (topic === MailStore.TOPIC && what === "changed" && this.started && !this.gate) {
          // сверка, пометки и расшифровка сообщают об изменениях пачками
          this.updateTitle();
          this.renderSoon();
        } else {
          this.checkAccess();
        }
      },
    };
    const topics = [MailStore.TOPIC, Account.TOPIC, Vault.TOPIC, lazy.Pgp.TOPIC];
    for (const t of topics) {
      Services.obs.addObserver(recheck, t);
    }
    window.addEventListener("unload", () => topics.forEach(t => Services.obs.removeObserver(recheck, t)));
    this.checkAccess();
  },

  /** Перерисовка по изменению данных: не чаще раза за кадр и только пока страница видна. */
  renderSoon() {
    if (this._renderQueued) {
      return;
    }
    this._renderQueued = true;
    requestAnimationFrame(() => {
      this._renderQueued = false;
      this.checkAccess();
    });
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
    if (kind === "aliases" || kind === "keys") {
      if (kind === "keys" && this.view !== "keys") {
        // при открытии раздела состояние копии сверяется с сервером; экран обновится по уведомлению
        lazy.Pgp.sync().catch(() => {});
      }
      this.view = kind;
    } else {
      this.view = "mail";
      // В узком окне письмо занимает место списка: выбрав папку или ярлык, человек ждёт список,
      // а не письмо, открытое раньше.
      const single = window.matchMedia("(max-width: 980px)").matches;
      if (kind === "folder" && FOLDERS.some(f => f.id === arg)) {
        this.folder = arg;
        this.label = null;
        if (single) {
          this.selectedThread = null;
        }
      } else if (kind === "label" && LABELS.some(l => l.id === arg)) {
        this.label = arg;
        this.folder = null;
        if (single) {
          this.selectedThread = null;
        }
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

  /** Папки в узком окне: выезжают поверх страницы по кнопке и убираются после выбора. */
  setNav(on) {
    $("app").dataset.nav = String(!!on);
    for (const b of document.querySelectorAll(".nav-btn")) {
      b.setAttribute("aria-expanded", String(!!on));
    }
  },

  /** Закрыть открытое письмо и вернуться к списку. */
  closeThread() {
    this.selectedThread = null;
    history.replaceState(null, "", this.label ? `#label/${this.label}` : `#folder/${this.folder}`);
    this.renderAll();
  },

  go(hash) {
    this.setNav(false);
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
    $("keys-pane").hidden = this.view !== "keys";
    $("list-pane").hidden = this.view !== "mail";
    $("reader").hidden = this.view !== "mail";
    this.renderFolders();
    if (this.view === "mail") {
      this.renderList();
      this.renderReader();
    } else if (this.view === "keys") {
      this.renderKeys();
    } else {
      this.renderAliases();
    }
    this.updateTitle();
  },

  updateTitle() {
    const where = this.view === "aliases" ? tt`Алиасы` : this.view === "keys" ? tt`Шифрование` : this.currentName();
    // число новых писем на вкладке показывает оболочка (значком), в заголовке оно не повторяется
    document.title = tt`${where} · Почта`;
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
    $("keys-link").setAttribute("aria-selected", String(this.view === "keys"));
    $("keys-link").onclick = () => this.go("keys");
    this.countKeys();
  },

  /** Число ключей собеседников рядом со ссылкой «Шифрование». */
  countKeys() {
    lazy.Pgp.peers().then(
      list => ($("keys-count").textContent = list.length ? String(list.length) : ""),
      () => ($("keys-count").textContent = "")
    );
  },

  countFor(folderId) {
    const all = this.scope();
    const msgs = folderId === "starred" ? all.filter(m => m.starred && m.folder !== "trash") : all.filter(m => m.folder === folderId);
    const threads = new Set(msgs.map(m => m.thread));
    return {
      total: threads.size,
      unread: folderId === "inbox" || folderId === "spam" ? new Set(msgs.filter(m => m.unread).map(m => m.thread)).size : 0,
    };
  },

  threadsForView() {
    let msgs = this.scope();
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
    $("list-title").textContent = this.currentName();
    const unread = threads.filter(t => t.latest.unread).length;
    $("list-sub").textContent = threads.length
      ? unread ? `${unread} ${plural(unread, tt`новое|новых|новых`)}` : `${threads.length} ${plural(threads.length, tt`письмо|письма|писем`)}`
      : "";
    const chips = $("filter-chips");
    const picked = this.box && MailStore.accounts.find(a => a.id === this.box);
    const labels = LABELS.filter(l => l.id !== "codes") // для кодов есть свой фильтр
      .filter(l => this.label === l.id || this.scope().some(m => m.labels.includes(l.id) && !["trash", "spam"].includes(m.folder)));
    const chipsSig = JSON.stringify([picked?.id, picked?.address, this.label, this.folder, labels.map(l => l.id)]);
    if (chipsSig !== this._chipsSig) {
      this._chipsSig = chipsSig;
      for (const chip of chips.querySelectorAll("[data-label], [data-box]")) {
        chip.remove();
      }
      if (picked) {
        chips.prepend(el("button", {
          class: "chip box-chip", type: "button", dataset: { box: picked.id }, "aria-pressed": "true", title: tt`Показать письма всех ящиков`,
          onclick: () => this.pickBox(picked.id),
        }, [el("span", { class: "box-chip-text", text: picked.address }), icon("close", 11, 2.6)]));
      }
      for (const l of labels) {
        chips.append(el("button", {
          class: "chip", type: "button", dataset: { label: l.id }, "aria-pressed": String(this.label === l.id),
          onclick: () => this.go(this.label === l.id ? `folder/${this.folder || "inbox"}` : `label/${l.id}`),
        }, [el("span", { class: "label-dot", style: `background:${l.color};margin:0` }), l.name]));
      }
    }
    for (const chip of chips.querySelectorAll("[data-filter]")) {
      chip.setAttribute("aria-pressed", String(this.filters.has(chip.dataset.filter)));
    }
    this.renderBulk();

    // строки перестраиваются, только если в них что-то изменилось: иначе при каждой фоновой
    // сверке кнопки под курсором мигали бы, а список дёргался
    if (this.focusIndex >= threads.length) {
      this.focusIndex = Math.max(0, threads.length - 1);
    }
    const rowsSig = JSON.stringify([
      this.selectedThread, this.focusIndex, [...this.checked], this.query, [...this.filters], this.folder, this.label, new Date().toDateString(),
      MailStore.syncing && !Store.messages.length, MailStore.accounts.length, Account.needsServerLink,
      threads.map(t => [t.latest.id, t.all.length, t.latest.unread, t.latest.starred, t.latest.draft, t.latest.subject, t.latest.date, t.latest.from?.name, t.latest.alias, snippetOf(t.latest), codeOf(t.latest), t.latest.newsletter, !!t.latest.agent, !!t.latest.pgp?.encrypted, (t.latest.attachments || []).length, t.latest.to]),
    ]);
    if (rowsSig === this._rowsSig && box.childElementCount) {
      return;
    }
    this._rowsSig = rowsSig;
    box.replaceChildren();

    if (!threads.length) {
      const filtered = this.query || this.filters.size;
      const none = !MailStore.accounts.length;
      const title = filtered ? tt`Ничего не нашлось` : none ? tt`Ящика пока нет` : MailStore.syncing && !Store.messages.length ? tt`Загружаем письма` : tt`Здесь пусто`;
      const text = filtered
        ? tt`Попробуйте другой запрос или снимите фильтры.`
        : none
          ? Account.needsServerLink
            ? tt`Подключите аккаунт к серверу Tabora, и адрес аккаунта начнёт принимать письма. Или добавьте свой ящик.`
            : tt`Добавьте ящик: Gmail, Яндекс или любой другой с доступом по IMAP.`
          : MailStore.syncing && !Store.messages.length
            ? tt`Первая загрузка занимает несколько секунд.`
            : tt`Новые письма появятся здесь, как только придут.`;
      box.append(el("div", { class: "empty" }, [
        el("strong", { text: title }),
        el("span", { text }),
        none && Account.needsServerLink ? el("button", { class: "primary", type: "button", text: tt`Подключить аккаунт`, onclick: () => Shell?.accountDialog("link") }) : null,
        none ? el("button", { class: none && Account.needsServerLink ? "ghost" : "primary", type: "button", text: tt`Добавить ящик`, onclick: () => this.openBoxModal() }) : null,
      ]));
      return;
    }
    const groups = [["today", tt`Сегодня`], ["yesterday", tt`Вчера`], ["week", tt`На этой неделе`], ["earlier", tt`Ранее`]];
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
    const alias = m.alias && m.alias !== ACCOUNT.address ? m.alias : m.folder === "sent" || m.draft ? tt`кому: ${m.to.join(", ")}` : "";
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
        el("span", { class: "check", role: "checkbox", "aria-checked": String(this.checked.has(m.thread)), "aria-label": tt`Выбрать` }, icon("check", 14, 2.4)),
      ]),
      el("span", { class: "body" }, [
        el("span", { class: "row1" }, [
          el("span", { class: "from", text: m.draft ? tt`Черновик` : m.from.name }),
          t.all.length > 1 ? el("span", { class: "count", text: String(t.all.length) }) : null,
          el("span", { class: "time", text: shortTime(m.date) }),
        ]),
        el("span", { class: "subject", text: m.subject || tt`(без темы)` }),
        el("span", { class: "snippet", text: snippetOf(m) }),
        el("span", { class: "row3" }, [
          alias ? el("span", { class: "alias", text: alias }) : null,
          m.agent ? el("span", { class: "tag", text: tt`агент вставил код` }) : code ? el("span", { class: "tag neutral", text: tt`код` }) : null,
          m.newsletter ? el("span", { class: "tag neutral", text: tt`рассылка` }) : null,
          el("span", { class: "meta" }, [
            m.pgp?.encrypted ? icon("lock", 13) : null,
            m.attachments?.length ? icon("clip", 13) : null,
            el("button", {
              class: "star", type: "button", dataset: { on: String(!!m.starred) }, "aria-label": m.starred ? tt`Снять звезду` : tt`Поставить звезду`, "aria-pressed": String(!!m.starred),
              style: "border:0;background:transparent;padding:0;display:inline-flex",
              onclick: () => this.toggleStar(m.id),
            }, icon("star", 13, m.starred ? 0 : 2)),
          ]),
        ]),
      ]),
      el("span", { class: "actions" }, [
        el("button", { type: "button", title: m.unread ? tt`Прочитано` : tt`Не прочитано`, "aria-label": m.unread ? tt`Отметить прочитанным` : tt`Отметить непрочитанным`, onclick: () => this.setRead(m.thread, !!m.unread) }, icon("read", 14)),
        el("button", { type: "button", title: tt`В архив (E)`, "aria-label": tt`В архив`, onclick: () => this.moveThread(m.thread, "archive") }, icon("archive", 14)),
        el("button", { type: "button", title: tt`Удалить (#)`, "aria-label": tt`Удалить`, onclick: () => this.moveThread(m.thread, "trash") }, icon("trash", 14)),
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
    const names = { archive: tt`В архиве`, trash: tt`Удалено`, inbox: tt`Во входящих`, spam: tt`В спаме` };
    this.toast(names[folder] || tt`Готово`, () => {
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
    this.toast(`${ids.length} ${plural(ids.length, tt`цепочка|цепочки|цепочек`)}: ${action === "archive" ? tt`в архиве` : tt`удалено`}`, () => {
      for (const [id, f] of before) {
        Store.update(id, { folder: f });
      }
      this.renderAll();
    });
  },

  /* ---- Письмо ---- */

  /** Открытое письмо перестраивается, только когда в нём что-то изменилось, а прокрутка,
   * развёрнутые письма и набранный ответ переживают перестройку: фоновая сверка почты не должна
   * мешать читать и писать. */
  renderReader() {
    const thread = this.selectedThread ? this.threadMsgs(this.selectedThread) : [];
    const box = $("thread");
    $("app").dataset.open = String(thread.length > 0); // в узком окне письмо занимает место списка
    const same = this._readerThread === this.selectedThread;
    const aliases = new Set(Store.aliases.map(a => a.address));
    // шапка (тема, звезда, ярлыки) и тело (письма, ответ) перестраиваются по отдельности: звезда
    // не должна перезагружать письмо с вёрсткой
    const last = thread[thread.length - 1];
    const headSig = JSON.stringify(last ? [this.folder, this.label, last.id, last.subject, last.starred, last.folder, [...new Set(thread.flatMap(m => m.labels))]] : []);
    const sig = JSON.stringify([
      this.folder, this.label, this.sendingReply === this.selectedThread, new Date().toDateString(),
      thread.map(m => [m.id, m.folder, m.draft, m.subject, m.date, m.from, m.to, m.alias, aliases.has(m.alias), m.pgp, m.code, m.images, m.agent, m.partial, m.html, m.noHtml, (m.attachments || []).map(a => a.name), JSON.stringify(m.body || []).length]),
    ]);
    if (same && sig === this._readerSig && (box.childElementCount || !thread.length)) {
      if (headSig !== this._readerHeadSig && thread.length) {
        this._readerHeadSig = headSig;
        box.querySelector(".thread-head")?.replaceWith(this.renderThreadHead(thread));
      }
      return;
    }
    const oldBody = box.querySelector(".thread-body");
    const kept = same ? { scroll: oldBody?.scrollTop || 0 } : null;
    // Быстрый ответ набирается в рамке, а рамка, вынутая из документа, теряет набранное, курсор и
    // историю правок. Пока открыта та же переписка, её тело и ответ остаются на месте: меняются
    // только письма над ответом.
    const reply = same && last && !last.draft && this._reply?.thread === this.selectedThread && oldBody?.contains(this._reply.el) ? this._reply : null;
    if (!reply) {
      this.dropQuickReply();
    }
    if (!same) {
      this.expanded.clear();
    }
    this._readerThread = this.selectedThread;
    this._readerSig = sig;
    this._readerHeadSig = headSig;
    $("reader-empty").hidden = thread.length > 0;
    box.hidden = !thread.length;
    if (!thread.length) {
      box.replaceChildren();
      return;
    }
    const head = this.renderThreadHead(thread);
    if (reply) {
      for (const child of [...oldBody.children]) {
        if (child !== reply.el) {
          child.remove();
        }
      }
      box.querySelector(".thread-head").replaceWith(head);
      this.fillThreadBody(thread, oldBody, reply);
      oldBody.scrollTop = kept.scroll;
      return;
    }
    box.replaceChildren();
    const body = el("div", { class: "thread-body" });
    // элемент просмотра письма живёт в другом процессе: после прокрутки ему сообщается новое место
    body.addEventListener("scroll", () => {
      // под курсором уже другое место письма: подпись со ссылкой неактуальна
      for (const status of body.querySelectorAll(".html-status:not([hidden])")) {
        status.hidden = true;
      }
      clearTimeout(this._viewNudge);
      this._viewNudge = setTimeout(() => {
        for (const b of body.querySelectorAll("browser")) {
          b.frameLoader?.requestUpdatePosition?.();
        }
      }, 120);
    }, { passive: true });
    this.fillThreadBody(thread, body, null);
    box.append(head, body);
    if (kept) {
      body.scrollTop = kept.scroll;
    }
  },

  /** Быстрый ответ уходит со страницы (открыта другая переписка, письмо стало черновиком):
   * набранное запоминается и вернётся, когда переписку откроют снова. */
  dropQuickReply() {
    const reply = this._reply;
    if (!reply) {
      return;
    }
    this._reply = null;
    const content = reply.editor.content();
    if (content.text.trim()) {
      this.replyTexts.set(reply.thread, content);
    } else {
      this.replyTexts.delete(reply.thread);
    }
    reply.editor.destroy();
  },

  /** Быстрый ответ: редактор с оформлением, панель (видна, пока в ответе курсор или текст) и
   * строка с кнопками. update(latest, sending) приводит его к состоянию переписки. */
  buildQuickReply(first) {
    const reply = { thread: first.thread, latest: first };
    const send = () => this.sendQuickReply(reply.latest, editor.content());
    const sync = () => (reply.el.dataset.active = String(editor.focused || !editor.empty));
    const editor = new RichEditor(document, {
      label: tt`Быстрый ответ`,
      grow: { min: 44, max: 320 },
      menu: (items, rect) => Shell?.showMenuFromContent?.(window, items, rect.left, rect.bottom + 6),
      onInput: () => sync(),
      onFocus: () => sync(),
      onSubmit: send,
    });
    const hint = el("span", { class: "hint", role: "status" });
    const forward = el("button", { class: "btn", type: "button", onclick: () => this.openCompose({ forward: reply.latest }) }, [icon("forward", 14), tt`Переслать`]);
    const submit = el("button", { class: "primary", type: "button", style: "height:32px;font-size:12px", onclick: send }, tt`Отправить`);
    reply.editor = editor;
    reply.el = el("div", { class: "quick-reply" }, [editor.el, el("div", { class: "format" }, editor.bar), el("div", { class: "bar" }, [hint, editor.toggle, forward, submit])]);
    reply.update = (latest, sending) => {
      reply.latest = latest;
      reply.el.dataset.sending = String(sending);
      editor.setPlaceholder(tt`Ответить ${latest.from.name}…`);
      editor.setReadOnly(sending);
      hint.textContent = sending ? tt`Отправляем…` : tt`⌘⏎ отправить · R развернуть ответ`;
      forward.disabled = sending;
      submit.disabled = sending;
      submit.classList.toggle("loading", sending);
      if (sending) {
        submit.setAttribute("aria-busy", "true");
      } else {
        submit.removeAttribute("aria-busy");
      }
    };
    const saved = this.replyTexts.get(first.thread);
    if (saved) {
      editor.set(saved);
    }
    sync();
    return reply;
  },

  /** Шапка открытого письма: «Назад», тема, действия, ярлыки. */
  renderThreadHead(thread) {
    const latest = thread[thread.length - 1];
    const labels = [...new Set(thread.flatMap(m => m.labels))].map(id => LABELS.find(l => l.id === id)).filter(Boolean);
    const inTrash = latest.folder === "trash";

    const head = el("div", { class: "thread-head" }, [
      el("div", { class: "thread-title-row" }, [
        el("button", { class: "icon-btn back-btn", type: "button", title: tt`К списку (Esc)`, "aria-label": tt`К списку писем`, onclick: () => this.closeThread() }, icon("back", 16, 2.2)),
        el("h2", { class: "thread-title", text: latest.subject || tt`(без темы)` }),
        el("button", { class: "icon-btn", type: "button", title: latest.starred ? tt`Снять звезду (S)` : tt`Звезда (S)`, "aria-pressed": String(!!latest.starred), "aria-label": tt`Звезда`, onclick: () => this.toggleStar(latest.id) }, icon("star", 15, latest.starred ? 0 : 2)),
        el("button", { class: "icon-btn", type: "button", title: tt`Не прочитано (U)`, "aria-label": tt`Отметить непрочитанным`, onclick: () => this.setRead(latest.thread, false) }, icon("read")),
        !inTrash ? el("button", { class: "icon-btn", type: "button", title: tt`В архив (E)`, "aria-label": tt`В архив`, onclick: () => this.moveThread(latest.thread, "archive") }, icon("archive")) : el("button", { class: "icon-btn", type: "button", title: tt`Вернуть во входящие`, "aria-label": tt`Вернуть во входящие`, onclick: () => this.moveThread(latest.thread, "inbox") }, icon("inbox")),
        el("button", { class: "icon-btn danger", type: "button", title: tt`Удалить (#)`, "aria-label": tt`Удалить`, onclick: () => inTrash ? this.deleteForever(latest.thread) : this.moveThread(latest.thread, "trash") }, icon("trash")),
      ]),
      labels.length ? el("div", { class: "thread-labels" }, labels.map(l => el("span", { class: "label-chip" }, [el("span", { class: "label-dot", style: `background:${l.color};margin:0` }), l.name]))) : null,
    ]);
    if (latest.starred) {
      head.querySelector(`[aria-label="${tt`Звезда`}"] svg`).setAttribute("fill", "currentColor");
    }
    return head;
  },

  /** Тело открытого письма: карточка кода, письма цепочки, быстрый ответ. */
  /** Письма переписки и быстрый ответ под ними. reply — быстрый ответ, который уже стоит в теле
   * (та же переписка перестраивается): письма встают над ним. */
  fillThreadBody(thread, body, reply) {
    const latest = thread[thread.length - 1];
    const code = codeOf(latest);
    const add = node => (reply ? body.insertBefore(node, reply.el) : body.append(node));
    if (latest.agent) {
      add(el("div", { class: "agent-card" }, [
        el("span", { class: "mark" }, el("span")),
        el("div", { class: "text" }, [
          el("b", { text: tt`Агент уже вставил этот код на ${latest.agent.site}` }),
          el("span", { text: tt`Регистрация ждёт вашего подтверждения во вкладке «${latest.agent.tab}»` }),
        ]),
        el("button", { class: "btn", type: "button", text: tt`К вкладке`, onclick: () => this.toast(tt`Переключение на вкладку появится вместе с агентом`) }),
      ]));
    } else if (code) {
      add(el("div", { class: "code-card" }, [
        el("div", {}, [el("div", { class: "label", text: tt`Код подтверждения` }), el("div", { class: "code", text: code })]),
        el("span", { class: "spacer" }),
        el("span", { class: "note", text: tt`Найден в письме автоматически` }),
        el("button", { class: "btn", type: "button", onclick: () => this.copy(code.replace(/\s/g, ""), tt`Код скопирован`) }, [icon("copy", 14), tt`Скопировать`]),
      ]));
    }

    thread.forEach((m, i) => {
      try {
        add(this.renderMessage(m, i < thread.length - 1 && !this.expanded.has(m.id)));
      } catch (e) {
        // одно письмо, которое не удалось показать, не должно оставлять пустой всю переписку
        console.error("Tabora mail: письмо не показано", e);
        add(el("div", { class: "mail-item" }, el("div", { class: "paper" }, el("div", { class: "fine", text: tt`Это письмо не удалось показать.` }))));
      }
    });

    if (!latest.draft) {
      const quick = reply || this.buildQuickReply(latest);
      quick.update(latest, this.sendingReply === latest.thread);
      if (!reply) {
        body.append(quick.el);
        this._reply = quick;
      }
    } else {
      body.append(el("div", { class: "quick-reply" }, [
        el("div", { class: "bar" }, [
          el("span", { class: "hint", text: tt`Это черновик` }),
          el("button", { class: "primary", type: "button", style: "height:32px;font-size:12px", onclick: () => this.openCompose({ draft: latest }) }, tt`Продолжить`),
        ]),
      ]));
    }
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
      m.folder !== "sent" && !m.draft && Store.aliases.some(a => a.address === m.alias)
        ? el("button", { class: "to-chip link", type: "button", title: tt`Управлять алиасом`, onclick: e => { e.stopPropagation(); this.go("aliases"); }, text: tt`через ${m.alias}` })
        : el("span", { class: "to-chip", text: m.folder === "sent" || m.draft ? tt`кому: ${m.to.join(", ")}` : tt`на ${m.to[0]}` }),
    ]);
    head.addEventListener("click", () => {
      if (item.classList.contains("collapsed")) {
        item.classList.remove("collapsed");
        this.expanded.add(m.id);
        showBody();
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
      paper.append(el("div", { class: "fine", text: tt`В письме нет текста.` }));
    }
    if (m.images) {
      paper.append(el("div", { class: "fine", text: tt`Картинки из письма не загружаются (${m.images}): так отправитель не узнаёт, что письмо открыли.` }));
    }
    const note = pgpNote(m);
    const sealed = !!(m.pgp?.error || m.pgp?.pending); // текста нет: вместо него объяснение
    item.append(head);
    if (note) {
      const [tone, glyph, title, text] = note;
      item.append(el("div", { class: "pgp-note", dataset: { tone }, role: tone === "bad" ? "alert" : null }, [
        el("span", { class: "pgp-mark", "aria-hidden": "true" }, icon(glyph, 15, 1.9)),
        el("div", { class: "pgp-text" }, [el("b", { text: title }), el("span", { text })]),
        m.pgp.error && m.at?.uid ? el("button", { class: "btn", type: "button", text: tt`Повторить`, onclick: e => this.decryptAgain(m, e.currentTarget) }) : null,
      ]));
    }
    // Письмо с вёрсткой показывается в отдельном процессе (htmlView), простое — блоками страницы.
    // Свёрнутому письму просмотр не создаётся, пока его не развернут.
    let shown = false;
    const showBody = () => {
      if (shown || sealed) {
        return;
      }
      shown = true;
      if (m.html) {
        paper.replaceWith(this.htmlView(m, paper));
      } else if (!m.noHtml && !m.local && m.at?.uid) {
        // письмо получено до появления показа с вёрсткой: разметка подгрузится с сервера, и если
        // она есть, письмо перерисуется (запись получит html)
        MailStore.loadHtml(m.id).catch(() => {});
      }
    };
    if (!sealed) {
      item.append(paper);
      if (!collapsed) {
        showBody();
      }
    }
    if (m.attachments?.length && !sealed) {
      item.append(el("div", { class: "attachments" }, m.attachments.map((a, index) => el("button", {
        class: "attachment", type: "button", title: tt`Сохранить ${a.name} в «Загрузки»`,
        onclick: e => this.saveAttachment(m, index, e.currentTarget),
      }, [
        el("span", { class: "ext", text: a.name.includes(".") ? a.name.split(".").pop().slice(0, 4) : tt`файл` }),
        el("span", { style: "display:flex;flex-direction:column;min-width:0" }, [el("span", { class: "name", text: a.name }), el("span", { class: "size", text: size(a.size) })]),
      ]))));
    }
    return item;
  },

  /** Письмо с вёрсткой. Разметку чистит и оборачивает MailView (скрипты, формы и рамки
   * удалены, политика содержимого запрещает загрузки), показывает её элемент browser в отдельном
   * процессе содержимого с выключенным JavaScript. Сюда из того процесса приходят только высота
   * содержимого, адрес ссылки под курсором и щелчок по ссылке (актор TaboraMailView). Если
   * показать не получилось, остаётся текст письма блоками (fallback). */
  htmlView(m, fallback) {
    const wrap = el("div", { class: "html-wrap" });
    const host = el("div", { class: "html-view", dataset: { state: "loading" } });
    host.style.height = `${this.htmlHeights.get(m.id) || 200}px`;
    const statusText = el("span");
    const status = el("div", { class: "html-status", hidden: true }, statusText);
    const browser = document.createXULElement("browser");
    for (const [name, value] of Object.entries({ type: "content", remote: "true", remoteType: "web", disableglobalhistory: "true", messagemanagergroup: "tabora-mail" })) {
      browser.setAttribute(name, value);
    }
    host.append(browser, status);
    const note = el("div", { class: "html-note", hidden: true }, [
      el("span", { class: "pgp-mark", "aria-hidden": "true" }, icon("image", 14, 1.9)),
      el("span", { class: "html-note-text", text: tt`Картинки с чужих серверов не загружены: так отправитель не узнаёт, что письмо открыли.` }),
      el("button", { class: "btn", type: "button", text: tt`Показать картинки`, onclick: e => {
        this.htmlImages.add(m.id);
        setBusy(e.currentTarget, true);
        load();
      } }),
    ]);
    wrap.append(note, host);

    let url = "";
    let reloads = 0;
    let guarded = false;
    // Документ письма не должен смениться другим: щелчки по ссылкам перехватывает актор, а если
    // переход всё же начался, он останавливается и письмо загружается заново.
    const guard = {
      QueryInterface: ChromeUtils.generateQI(["nsIWebProgressListener", "nsISupportsWeakReference"]),
      onLocationChange: (progress, request, location) => {
        if (progress.isTopLevel && url && location.spec !== url && location.spec !== "about:blank" && reloads++ < 3) {
          browser.stop();
          load();
        }
      },
    };
    host._guard = guard; // слушатель хранится слабой ссылкой: держим его, пока жив элемент
    const fail = () => {
      if (wrap.isConnected) {
        wrap.replaceWith(fallback);
      }
    };
    const load = async () => {
      const images = this.htmlImages.has(m.id);
      const doc = await MailStore.htmlDocument(m.id, { images }).catch(() => null);
      if (!wrap.isConnected) {
        return;
      }
      if (!doc) {
        fail();
        return;
      }
      note.hidden = !doc.remote || images;
      try {
        await frameReady(browser);
        if (!guarded) {
          guarded = true;
          browser.addProgressListener(guard, Ci.nsIWebProgress.NOTIFY_LOCATION);
        }
        browser.browsingContext.allowJavascript = false;
        url = doc.url;
        browser.loadURI(Services.io.newURI(url), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      } catch (e) {
        console.error("Tabora mail: письмо с вёрсткой не показано", e);
        fail();
      }
    };
    // Письмо шире листа (рассылки свёрстаны под 600–700 точек) показывается уменьшенным, как
    // в почтовых программах: масштаб подбирается так, чтобы оно поместилось по ширине, но не
    // мельче MIN_ZOOM. Высота листа — высота письма в этом масштабе.
    const MIN_ZOOM = 0.6;
    let zoom = 1;
    browser.addEventListener("tabora-mail-size", e => {
      const { height, width, view } = e.detail;
      if (view > 0 && width > view + 1 && zoom > MIN_ZOOM) {
        zoom = Math.max(MIN_ZOOM, Math.floor((zoom * view * 100) / width) / 100);
        browser.fullZoom = zoom; // письмо перестроится и сообщит новые размеры
        return;
      }
      const shown = Math.max(40, Math.ceil(height * zoom));
      this.htmlHeights.set(m.id, shown);
      host.style.height = `${shown}px`;
      host.dataset.state = "ready";
    });
    // лист стал шире или уже (окно, боковые панели): масштаб подбирается заново
    let lastWidth = 0;
    new ResizeObserver(() => {
      const w = Math.round(host.getBoundingClientRect().width);
      if (lastWidth && Math.abs(w - lastWidth) > 1 && zoom !== 1) {
        zoom = 1;
        browser.fullZoom = 1;
      }
      lastWidth = w;
    }).observe(host);
    browser.addEventListener("tabora-mail-link", e => openMailHref(e.detail.href));
    // Адрес ссылки под курсором. Письмо узнаёт об уходе курсора только по его движению внутри
    // себя, поэтому подпись прячется и здесь: курсор ушёл с листа или переписку прокрутили
    // (см. renderReader). Курсор снова двинулся над той же ссылкой — подпись возвращается.
    let hovered = "";
    browser.addEventListener("tabora-mail-hover", e => {
      hovered = e.detail.href;
      statusText.textContent = hovered;
      status.hidden = !hovered;
    });
    host.addEventListener("mouseleave", () => {
      hovered = "";
      status.hidden = true;
    });
    host.addEventListener("mousemove", () => {
      if (hovered && status.hidden) {
        status.hidden = false;
      }
    });
    load();
    return wrap;
  },

  /** Повторная расшифровка: ключ мог появиться после того, как письмо пришло. */
  async decryptAgain(m, button) {
    setBusy(button, true);
    const rec = await MailStore.decryptAgain(m.id).catch(() => null);
    if (rec?.pgp?.error) {
      this.toast(tt`Письмо не расшифровано: подходящего ключа по-прежнему нет`);
    }
    setBusy(button, false);
    this.renderReader();
  },

  /** Вложение скачивается с сервера и сохраняется через загрузки браузера (с его же защитой). */
  async saveAttachment(m, index, button) {
    if (m.local || !m.at?.uid) {
      this.toast(tt`Вложение этого письма осталось на сервере отправителя`);
      return;
    }
    if (!Shell?.saveMailAttachment) {
      this.toast(tt`Вложения сохраняются только внутри Tabora`);
      return;
    }
    button.disabled = true;
    button.dataset.busy = "true";
    try {
      const name = await Shell.saveMailAttachment(m.id, index);
      this.toast(tt`Сохранено в «Загрузки»: ${name}`);
    } catch (e) {
      this.toast(tt`Вложение не сохранено. ${e.message}`);
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
    this.toast(tt`Удалено навсегда`);
  },

  /** content — набранное в быстром ответе: { text, html } (html пуст, если оформления нет). */
  async sendQuickReply(to, content) {
    const text = typeof content === "string" ? content : content?.text || "";
    const html = (typeof content === "object" && content?.html) || "";
    if (!text.trim()) {
      this.openCompose({ reply: to });
      return;
    }
    if (this.sendingReply) {
      return;
    }
    const clearReply = () => {
      this.replyTexts.delete(to.thread);
      if (this._reply?.thread === to.thread) {
        this._reply.editor.clear();
      }
    };
    this.sendingReply = to.thread;
    this.renderReader(); // кнопка занята, поле не правится, пока письмо уходит
    // отвечаем с того адреса, на который письмо пришло (алиас остаётся алиасом)
    const mine = MailStore.senders().map(s => s.address);
    const from = mine.includes(to.alias) ? to.alias : ACCOUNT.address;
    const subject = /^re:/i.test(to.subject || "") ? to.subject : `Re: ${to.subject || ""}`.trim();
    const recipient = to.replyTo || to.from.email;
    try {
      const plan = await MailStore.encryptPlan(from, [recipient]);
      if (to.pgp?.encrypted && !plan.possible) {
        // ответ на зашифрованное письмо не уходит открытым незаметно: решение — в окне письма
        clearReply();
        this.openCompose({ reply: to, text, html });
        return;
      }
      const encrypt = plan.possible && (!!to.pgp?.encrypted || plan.suggested);
      await MailStore.send({ from: { email: from }, to: [recipient], subject, text, html, replyTo: to.id, labels: to.labels, encrypt });
      clearReply();
      this.toast(encrypt ? tt`Ответ отправлен ${to.from.name} зашифрованным` : tt`Ответ отправлен ${to.from.name}`);
    } catch (e) {
      this.toast(tt`Ответ не отправлен. ${e.message}`);
    } finally {
      this.sendingReply = null;
      this.renderAll();
    }
  },

  /* ---- Написать: окно живёт в оболочке браузера ---- */

  openCompose(opts = {}) {
    if (!Shell?.openCompose) {
      this.toast(tt`Окно письма доступно только внутри Tabora`);
      return;
    }
    Shell.openCompose({
      replyTo: opts.reply?.id,
      forwardOf: opts.forward?.id,
      draftId: opts.draft?.id,
      to: opts.to,
      text: opts.text,
      html: opts.html,
    });
  },

  /* ---- Алиасы ---- */

  renderAliases() {
    const all = Store.aliases;
    const on = all.filter(a => a.on).length;
    const agent = all.filter(a => a.agent).length;
    $("alias-stats").replaceChildren(
      this.stat(tt`Активных`, String(on)),
      this.stat(tt`Выключено`, String(all.length - on)),
      this.stat(tt`Создано агентом`, String(agent), true),
      this.stat(tt`Писем на алиасы`, String(all.reduce((n, a) => n + (a.count || 0), 0))),
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
      box.append(el("div", { class: "empty" }, [el("strong", { text: tt`Ничего не нашлось` })]));
      return;
    }
    for (const a of rows) {
      box.append(el("div", { class: "alias-row", dataset: { on: String(a.on) } }, [
        el("span", { class: "glyph", text: letterOf(a.site) }),
        el("span", { class: "addr" }, [
          el("button", { type: "button", text: a.address, title: tt`Скопировать адрес`, onclick: () => this.copy(a.address, tt`Адрес скопирован`) }),
          a.warn ? el("span", { class: "warn", text: a.on ? a.warn : a.warn.startsWith(tt`выключен`) ? a.warn : tt`выключен · ${a.warn}` }) : !a.on ? el("span", { class: "warn", text: tt`выключен` }) : null,
        ]),
        el("span", { class: "site" }, [el("b", { text: a.site }), el("span", { text: tt`создан: ${a.by}` })]),
        el("span", { class: "num", text: String(a.count) }),
        el("span", { class: "date", text: dateWord(a.created) }),
        el("span", {}, el("span", { class: "space-pill", text: a.space, style: `--space-color:${SPACE_COLORS[a.space] || "#ecedef"}` })),
        el("button", {
          class: "toggle", type: "button", role: "switch", "aria-checked": String(a.on),
          "aria-label": tt`Алиас ${a.address} ${a.on ? tt`включён` : tt`выключен`}`,
          onclick: async e => {
            const btn = e.currentTarget;
            btn.disabled = true;
            try {
              const next = await MailStore.aliasSet(a.id, !a.on);
              this.toast(next.on ? tt`Алиас ${a.address.split("@")[0]} включён` : tt`Алиас выключен: письма на него больше не придут`);
            } catch (err) {
              this.toast(tt`Алиас не изменён. ${err.message}`);
            }
            this.renderAliases();
            this.renderFolders();
          },
        }),
      ]));
    }
  },

  /* ---- Шифрование: свой ключ и ключи собеседников ---- */

  async renderKeys() {
    const box = $("keys-body");
    const turn = (this._keysTurn = (this._keysTurn || 0) + 1);
    let own = null;
    let peers = [];
    let backup = { state: "local" };
    let failed = "";
    try {
      // ключ аккаунта появляется при первом обращении: сначала сверка с сервером (ключ мог быть
      // создан на другом компьютере), потом, если его нет нигде, создание
      own = MailStore.accounts.some(a => a.kind === "tabora") ? await lazy.Pgp.accountKey() : await lazy.Pgp.own();
      backup = await lazy.Pgp.backup();
      peers = await lazy.Pgp.peers();
    } catch (e) {
      failed = e.message || String(e);
    }
    if (turn !== this._keysTurn || this.view !== "keys") {
      return;
    }
    box.replaceChildren();
    if (failed) {
      box.append(el("div", { class: "empty" }, [el("strong", { text: tt`Ключи недоступны` }), el("span", { text: failed })]));
      return;
    }
    const date = iso => {
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? "" : `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
    };
    if (backup.state === "locked") {
      // у аккаунта на сервере есть ключ, а здесь его нет: ключ возвращают, новый создают только осознанно
      box.append(el("section", { class: "key-card", dataset: { tone: "warn" } }, [
        el("div", { class: "key-card-head" }, [
          el("span", { class: "pgp-mark", "aria-hidden": "true" }, icon("lock", 16, 1.9)),
          el("div", { class: "key-card-title" }, [el("b", { text: tt`Ключа аккаунта на этом компьютере нет` }), el("span", { text: tt`Он создан на другом компьютере. Пока ключ не вернётся, зашифрованные письма здесь не открыть и не отправить.` })]),
        ]),
        el("div", { class: "key-actions" }, [
          backup.canPassword ? el("button", { class: "primary", type: "button", text: tt`Вернуть паролем аккаунта`, onclick: () => this.askKeySecret("unlock") }) : null,
          backup.canRecovery ? el("button", { class: backup.canPassword ? "btn" : "primary", type: "button", text: tt`Вернуть ключом восстановления`, onclick: () => this.askKeySecret("recovery") }) : null,
          el("button", { class: "btn", type: "button", text: tt`Создать новый ключ`, onclick: () => this.askKeySecret("replace") }),
        ]),
        el("p", { class: "key-hint", text: backup.canPassword || backup.canRecovery
          ? tt`Копия ключа лежит на сервере Tabora зашифрованной: её открывает пароль, с которым она была сохранена, или ключ восстановления. Новый ключ заменит прежний, и письма, зашифрованные прежним, прочитать будет нельзя.`
          : tt`Копию ключа ещё не сохранили на сервере. Откройте Tabora на том компьютере, где ключ создан, и в этом разделе сохраните копию. Новый ключ заменит прежний, и письма, зашифрованные прежним, прочитать будет нельзя.` }),
      ]));
    } else {
      const status = {
        ok: ["ok", "seal", tt`Копия ключа сохранена на сервере Tabora. Она зашифрована вашим паролем: сервер прочитать её не может, а новый компьютер получит ключ после входа.`, null],
        "no-password": ["warn", "alert", tt`Копия ключа ещё не привязана к паролю: на другом компьютере ключ не появится, а с потерей этого пропадёт. Введите пароль аккаунта, чтобы сохранить копию.`, [tt`Сохранить копию`, () => this.askKeySecret("password")]],
        unsupported: ["info", "seal", tt`Ключ хранится только на этом компьютере. Копия на сервере появится после обновления сервера Tabora.`, null],
        offline: ["info", "seal", tt`Сервер Tabora недоступен: копия ключа не проверена.`, [tt`Проверить`, () => lazy.Pgp.sync().catch(() => {})]],
        local: ["info", "seal", tt`Аккаунт не подключён к серверу Tabora: ключ хранится только на этом компьютере.`, null],
      }[backup.state];
      box.append(el("section", { class: "key-card" }, own ? [
        el("div", { class: "key-card-head" }, [
          el("span", { class: "pgp-mark", "aria-hidden": "true" }, icon("lock", 16, 1.9)),
          el("div", { class: "key-card-title" }, [el("b", { text: tt`Ваш ключ` }), el("span", { text: `${own.address}${date(own.created) ? tt`, создан ${date(own.created)}` : ""}` })]),
          el("button", { class: "btn", type: "button", onclick: () => this.copy(own.publicKey, tt`Открытый ключ скопирован: его можно отправить собеседнику`) }, [icon("copy", 14), tt`Скопировать открытый ключ`]),
        ]),
        el("div", { class: "key-print", title: tt`Отпечаток ключа`, text: fingerprintText(own.fingerprint) }),
        el("p", { class: "key-hint", text: tt`Отпечаток — короткое имя ключа. Чтобы убедиться, что ключ не подменили по дороге, сверьте его с собеседником голосом или при встрече. Открытый ключ уходит с каждым вашим письмом, закрытый не покидает сейф.` }),
        status ? el("div", { class: "key-backup", dataset: { tone: status[0] } }, [
          el("span", { class: "pgp-mark", "aria-hidden": "true" }, icon(status[1], 14, 1.9)),
          el("span", { class: "key-backup-text", text: status[2] }),
          status[3] ? el("button", { class: "btn", type: "button", text: status[3][0], onclick: status[3][1] }) : null,
        ]) : null,
      ] : [
        el("div", { class: "key-card-head" }, [
          el("span", { class: "pgp-mark", "aria-hidden": "true" }, icon("lock", 16, 1.9)),
          el("div", { class: "key-card-title" }, [el("b", { text: tt`Ключа пока нет` }), el("span", { text: tt`Он появится, когда у аккаунта будет ящик Tabora: подключите аккаунт к серверу.` })]),
        ]),
      ]));
    }

    box.append(el("div", { class: "keys-list-head" }, [
      el("h2", { text: tt`Ключи собеседников` }),
      el("span", { class: "mono", text: peers.length ? String(peers.length) : "" }),
    ]));
    if (!peers.length) {
      box.append(el("div", { class: "empty keys-empty" }, [
        el("strong", { text: tt`Ключей пока нет` }),
        el("span", { text: tt`Ключ собеседника приходит с его письмом и запоминается сам. После этого письма ему можно шифровать.` }),
      ]));
      return;
    }
    const sources = { manual: tt`добавлен вручную`, autocrypt: tt`из письма`, directory: tt`из каталога Tabora` };
    for (const p of peers) {
      box.append(el("div", { class: "key-row" }, [
        el("span", { class: "glyph", "aria-hidden": "true", text: letterOf(p.address) }),
        el("span", { class: "key-who" }, [
          el("b", { text: p.address }),
          el("span", { text: `${sources[p.source] || tt`из письма`}${p.seen ? ` ${dateWord(new Date(p.seen).toISOString())}` : ""}${p.prefer === "mutual" || p.source === "manual" ? tt`, шифруем по умолчанию` : ""}` }),
        ]),
        el("button", { class: "key-print small", type: "button", title: tt`Скопировать отпечаток`, text: fingerprintText(p.fingerprint), onclick: () => this.copy(fingerprintText(p.fingerprint), tt`Отпечаток скопирован`) }),
        el("button", {
          class: "box-remove key-remove", type: "button", "aria-label": tt`Удалить ключ ${p.address}`, title: tt`Удалить ключ`,
          onclick: e => {
            const btn = e.currentTarget;
            if (btn.dataset.sure !== "true") {
              // второй щелчок подтверждает
              btn.dataset.sure = "true";
              btn.textContent = tt`Удалить?`;
              setTimeout(() => {
                if (btn.isConnected) {
                  btn.dataset.sure = "false";
                  btn.replaceChildren(icon("close", 12, 2.4));
                }
              }, 4000);
              return;
            }
            lazy.Pgp.removePeer(p.address).then(() => this.toast(tt`Ключ ${p.address} удалён: письма ему пойдут открытыми`), err => this.toast(err.message));
          },
        }, icon("close", 12, 2.4)),
      ]));
    }
  },

  /** Пароль аккаунта или ключ восстановления для копии ключа: сохранить копию, вернуть ключ или
   * заменить его новым. */
  askKeySecret(kind) {
    const texts = {
      password: [tt`Пароль аккаунта`, tt`Пароль нужен, чтобы зашифровать копию ключа: на сервер попадает только зашифрованная копия, пароль остаётся на этом компьютере.`, tt`Пароль`, tt`Сохранить копию`],
      unlock: [tt`Пароль аккаунта`, tt`Пароль открывает копию ключа шифрования, сохранённую на сервере. Сам пароль остаётся на этом компьютере.`, tt`Пароль`, tt`Вернуть ключ`],
      recovery: [tt`Ключ восстановления`, tt`Введите ключ восстановления аккаунта: им открывается копия ключа шифрования, сохранённая на сервере.`, tt`Ключ восстановления`, tt`Вернуть ключ`],
      replace: [tt`Новый ключ шифрования`, tt`Прежний ключ аккаунта будет заменён. Письма, зашифрованные прежним ключом, прочитать больше не получится, а собеседники получат новый ключ с вашим следующим письмом. Чтобы подтвердить, введите пароль аккаунта.`, tt`Пароль`, tt`Заменить ключ`],
    }[kind];
    $("secret-title").textContent = texts[0];
    $("secret-sub").textContent = texts[1];
    $("secret-label").textContent = texts[2];
    $("secret-ok").textContent = texts[3];
    $("secret-input").type = kind === "recovery" ? "text" : "password";
    $("secret-input").value = "";
    $("secret-error").hidden = true;
    $("secret-modal").dataset.kind = kind;
    $("secret-modal").hidden = false;
    setTimeout(() => $("secret-input").focus(), 20);
  },

  async submitKeySecret() {
    const button = $("secret-ok");
    const kind = $("secret-modal").dataset.kind;
    const value = $("secret-input").value;
    if (button.disabled || !value.trim()) {
      $("secret-input").focus();
      return;
    }
    const error = $("secret-error");
    error.hidden = true;
    setBusy(button, true);
    try {
      const b = kind === "recovery" ? await Account.restoreMailKeys(value) : await Account.confirmMailKeys(value, { replace: kind === "replace" });
      $("secret-input").value = "";
      $("secret-modal").hidden = true;
      this.toast(b.state === "ok" ? (kind === "replace" ? tt`Ключ заменён, копия сохранена на сервере` : tt`Ключ на месте, копия сохранена на сервере`) : tt`Ключ возвращён. Осталось сохранить копию с нынешним паролем`);
      if (kind !== "password") {
        // ключ появился или сменился: письма, которые не открылись, расшифруются при открытии
        this.renderAll();
      }
    } catch (e) {
      error.textContent = e.code === "bad-credentials" ? tt`Неверный пароль` : e.message || tt`Не получилось`;
      error.hidden = false;
      $("secret-input").select();
    } finally {
      setBusy(button, false);
    }
  },

  openKeyModal() {
    $("key-address").value = "";
    $("key-armored").value = "";
    $("key-error").hidden = true;
    $("key-modal").hidden = false;
    setTimeout(() => $("key-address").focus(), 20);
  },

  async addKey() {
    const button = $("key-add");
    if (button.disabled) {
      return;
    }
    const error = $("key-error");
    const show = text => {
      error.textContent = text;
      error.hidden = false;
    };
    error.hidden = true;
    const address = $("key-address").value.trim();
    if (!validEmail(address)) {
      show(tt`Проверьте адрес почты`);
      $("key-address").focus();
      return;
    }
    if (!$("key-armored").value.includes("BEGIN PGP PUBLIC KEY BLOCK")) {
      show(tt`Вставьте открытый ключ целиком: он начинается со строки «-----BEGIN PGP PUBLIC KEY BLOCK-----»`);
      $("key-armored").focus();
      return;
    }
    setBusy(button, true);
    try {
      const k = await lazy.Pgp.setPeer(address, $("key-armored").value, { source: "manual" });
      $("key-modal").hidden = true;
      this.toast(tt`Ключ ${k.address} добавлен: письма ему шифруются по умолчанию`);
    } catch (e) {
      show(e.message || tt`Ключ не добавлен`);
    } finally {
      setBusy(button, false);
    }
  },

  stat(label, value, accent = false) {
    return el("div", { class: "stat" }, [el("span", { class: "l", text: label }), el("span", { class: `v${accent ? " accent" : ""}`, text: value })]);
  },

  openAliasModal() {
    if (!MailStore.accounts.some(a => a.kind === "tabora")) {
      this.toast(Account.needsServerLink ? tt`Алиасы появятся после подключения аккаунта к серверу Tabora` : tt`Алиасы работают для ящика Tabora`);
      return;
    }
    $("alias-modal").hidden = false;
    $("alias-site").value = "";
    $("alias-note").textContent = tt`Адрес подберёт сервер: название сайта и четыре случайных знака, например booking-k3f9@${ACCOUNT.domain}.`;
    setTimeout(() => $("alias-site").focus(), 20);
  },

  async createAlias() {
    const button = $("alias-create");
    if (button.disabled) {
      return;
    }
    setBusy(button, true);
    try {
      const a = await MailStore.aliasCreate({ site: $("alias-site").value.trim(), space: $("alias-space").value, by: "manual" });
      $("alias-modal").hidden = true;
      this.renderAliases();
      this.renderFolders();
      this.copy(a.address, tt`Алиас создан и скопирован: ${a.address}`);
    } catch (e) {
      this.toast(tt`Алиас не создан. ${e.message}`);
    } finally {
      setBusy(button, false);
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
    $("box-note").textContent = g.note || (g.source === "guess" ? tt`Серверы подставлены по имени домена: проверьте их в разделе «Серверы».` : "");
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
      error.textContent = tt`Проверьте адрес почты`;
      error.hidden = false;
      $("box-address").focus();
      return;
    }
    setBusy(button, true);
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
      this.toast(tt`Ящик ${r.address} добавлен: загружаем письма`);
      this.renderAll();
    } catch (e) {
      // ответ сервера (например, требование пароля приложения) показываем как есть
      error.textContent = e.server ? tt`${e.message}. Ответ сервера: ${e.server}` : e.message;
      error.hidden = false;
      $("box-more").open = $("box-more").open || e.code === "network" || e.code === "protocol" || e.code === "tls";
    } finally {
      setBusy(button, false);
    }
  },

  /* ---- Служебное ---- */

  async copy(text, message) {
    try {
      await navigator.clipboard.writeText(text);
      this.toast(message);
    } catch (e) {
      this.toast(tt`Не удалось скопировать`);
    }
  },

  toast(text, undo, undoLabel = tt`Отменить@@действие`) {
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
      if ($("app").dataset.nav === "true") {
        this.setNav(false);
      } else if (!$("alias-modal").hidden) {
        $("alias-modal").hidden = true;
      } else if (!$("key-modal").hidden) {
        $("key-modal").hidden = true;
      } else if (!$("secret-modal").hidden) {
        $("secret-modal").hidden = true;
        $("secret-input").value = "";
      } else if (!$("box-modal").hidden) {
        $("box-modal").hidden = true;
      } else if (this.checked.size) {
        this.checked.clear();
        this.renderList();
      } else if (typing) {
        e.target.blur();
      } else if (this.selectedThread) {
        this.closeThread();
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
      "?": () => this.toast(tt`J/K листать · ⏎ открыть · E архив · # удалить · S звезда · U непрочитано · X выбрать · C написать · R ответить · F переслать · / поиск`),
    };
    if (this.pendingG) {
      this.pendingG = false;
      const go = { i: "folder/inbox", s: "folder/starred", t: "folder/sent", d: "folder/drafts", a: "aliases", k: "keys" }[e.key];
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
    $("compose-btn").addEventListener("click", () => {
      this.setNav(false);
      this.openCompose();
    });
    $("compose-mini").addEventListener("click", () => this.openCompose());
    for (const b of document.querySelectorAll(".nav-btn")) {
      b.addEventListener("click", () => this.setNav($("app").dataset.nav !== "true"));
    }
    $("nav-scrim").addEventListener("click", () => this.setNav(false));
    $("add-box-btn").addEventListener("click", () => this.setNav(false));

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
      if (!chip?.dataset.filter) {
        return; // у ярлыков и выбранного ящика свои обработчики
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

    $("new-key-btn").addEventListener("click", () => this.openKeyModal());
    $("key-cancel").addEventListener("click", () => ($("key-modal").hidden = true));
    $("key-modal").addEventListener("click", e => {
      if (e.target === $("key-modal")) {
        $("key-modal").hidden = true;
      }
    });
    $("key-add").addEventListener("click", () => this.addKey());
    const closeSecret = () => {
      $("secret-modal").hidden = true;
      $("secret-input").value = "";
    };
    $("secret-cancel").addEventListener("click", closeSecret);
    $("secret-modal").addEventListener("click", e => e.target === $("secret-modal") && closeSecret());
    $("secret-ok").addEventListener("click", () => this.submitKeySecret());
    $("secret-input").addEventListener("keydown", e => e.key === "Enter" && this.submitKeySecret());
    $("key-address").addEventListener("keydown", e => e.key === "Enter" && $("key-armored").focus());

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
