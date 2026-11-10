/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Страница аккаунта Tabora: кто вошёл и вкладки-разделы слева, настройки раздела справа.
 *
 * Страница ничего чувствительного сама не делает. Смена пароля, проверка владельца, ключ
 * восстановления, импорт и экспорт паролей — те же окна и листы оболочки, что и в разделе
 * «Коды» (Tabora.accountDialog, vaultOwnerCheck, vaultRecoveryCreateSheet): они открываются
 * поверх окна. То, чему нужен сервер аккаунтов, так и подписано, пока он не запущен.
 *
 * Разметка строится через DOM (textContent), innerHTML не используется: у страницы системные
 * права. Стили из кода — только через CSSOM (цвет аватара). */

"use strict";

const { Account } = ChromeUtils.importESModule("chrome://tabora/content/account/Account.sys.mjs");
const { Vault } = ChromeUtils.importESModule("chrome://tabora/content/vault/Vault.sys.mjs");
const Shell = window.browsingContext?.topChromeWindow?.Tabora || null;

const SVG_NS = "http://www.w3.org/2000/svg";
const LATER = "появится после запуска сервера аккаунтов";

const TABS = [
  { id: "profile", label: "Профиль", icon: ["M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M4.5 20c1.4-3.3 4.2-5 7.5-5s6.1 1.7 7.5 5"] },
  { id: "security", label: "Безопасность", icon: ["M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"] },
  { id: "devices", label: "Устройства", icon: ["M4 5h16v11H4z", "M9 20h6", "M12 16v4"] },
  { id: "sync", label: "Синхронизация", icon: ["M20 12a8 8 0 0 0-14-5.3L4 9", "M4 4v5h5", "M4 12a8 8 0 0 0 14 5.3l2-2.3", "M20 20v-5h-5"] },
  { id: "mail", label: "Почта", icon: ["M3.5 6.5h17v11h-17z", "M3.5 7l8.5 6 8.5-6"] },
  { id: "data", label: "Данные", icon: ["M12 4v11", "M7 10l5 5 5-5", "M4 19h16"] },
  { id: "exit", label: "Выход", icon: ["M10 17l5-5-5-5", "M15 12H3", "M21 4v16"] },
];

const state = { tab: "profile", devices: null, devicesFor: "", timer: null };

/* ---- Помощники разметки ---------------------------------------------------- */

function h(tag, attrs = {}, text = null, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== null && v !== undefined && v !== false) {
      el.setAttribute(k, v === true ? "" : v);
    }
  }
  if (text !== null) {
    el.textContent = text;
  }
  for (const c of children) {
    if (c) {
      el.append(c);
    }
  }
  return el;
}

function icon(paths, size = 16) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}

function button(label, cls, onClick, attrs = {}) {
  const b = h("button", { class: `btn ${cls || ""}`.trim(), type: "button", ...attrs }, label);
  b.addEventListener("click", onClick);
  return b;
}

/** Строка настройки: название и пояснение слева, значение или действие справа. */
function row({ title, text = "", control = null, tone = "" }) {
  return h("div", { class: `row ${tone}`.trim() }, null, [h("div", {}, null, [h("b", {}, title), text ? h("span", { class: "text" }, text) : null]), control]);
}

function value(text, cls = "") {
  return h("span", { class: `value ${cls}`.trim() }, text);
}

function card(rows) {
  return h("div", { class: "card" }, null, rows);
}

function titled(title, rows) {
  return h("section", {}, null, [h("h2", { class: "card-title" }, title), card(rows)]);
}

function panel(title, lead, blocks) {
  return h("div", { class: "panel" }, null, [h("header", {}, null, [h("h1", {}, title), lead ? h("p", { class: "lead" }, lead) : null]), ...blocks]);
}

function date(v) {
  // без хвоста «г.»: дата стоит в середине фраз, и точка сокращения спорит с точкой предложения
  return v ? new Date(v).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" }).replace(/\s*г\.$/, "") : "";
}

function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
}

function avatar(email) {
  const el = h("span", { class: "avatar", "aria-hidden": "true" }, (email || "?").trim().charAt(0).toUpperCase());
  el.style.setProperty("--avatar", Shell?.accountAvatarColor() || "#c8f25a");
  return el;
}

/** Действие оболочки: без окна браузера (страницу открыли отдельно) ничего не делаем. */
function shell(fn) {
  return () => {
    if (Shell) {
      fn(Shell);
    }
  };
}

/* ---- Разделы --------------------------------------------------------------- */

const PANELS = {
  profile() {
    const colors = Shell?.AVATAR_COLORS || [];
    const current = Shell?.accountAvatarColor();
    const names = { "#c8f25a": "лаймовый", "#7cc4ff": "голубой", "#b9a6ff": "сиреневый", "#ff9f5a": "оранжевый", "#5ee0d0": "бирюзовый", "#ff8fb3": "розовый" };
    const swatches = h("div", { class: "swatches", role: "radiogroup", "aria-label": "Цвет аватара" }, null, colors.map(color => {
      const b = h("button", { class: "swatch", type: "button", role: "radio", "aria-checked": String(color === current), "aria-label": names[color] || color, title: names[color] || color });
      b.style.setProperty("--avatar", color);
      b.addEventListener("click", () => {
        Services.prefs.setStringPref(Shell.AVATAR_PREF, color);
        Shell.renderAccountButton();
        render();
      });
      return b;
    }));
    const copy = button("Скопировать", "", shell(s => {
      Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(Account.email);
      s.notice("Адрес скопирован");
    }));
    return panel("Профиль", "Аккаунт Tabora — это адрес почты и один пароль для входа и для сейфа.", [
      card([
        row({ title: "Адрес почты", text: Account.email, control: copy }),
        row({ title: "Цвет аватара", text: "Кружок с первой буквой адреса виден в правом верхнем углу окна и в почте.", control: swatches }),
      ]),
      card([
        Account.data?.createdAt ? row({ title: "Аккаунт создан", control: value(date(Account.data.createdAt)) }) : null,
        Account.data?.lastLoginAt ? row({ title: "Последний вход на этом компьютере", control: value(date(Account.data.lastLoginAt)) }) : null,
        row({ title: "Место в почте", control: value("появится с запуском почты", "muted") }),
      ]),
    ]);
  },

  security() {
    const rkAt = Vault.recoveryKeyCreatedAt;
    const upgrade = !!rkAt && Account.recoveryNeedsUpgrade;
    const silent = Vault.hasOsKey && Vault.osUnlockEnabled;
    const unlockTitle = Vault.osUnlockEnabled ? "Спрашивать пароль при запуске" : "Открывать сейф через связку ключей";
    const toggle = h("button", { class: "switch", type: "button", role: "switch", "aria-checked": String(!!silent), "aria-label": "Открывать сейф через связку ключей macOS" });
    toggle.disabled = !Vault.hasPassword;
    toggle.addEventListener("click", shell(s => s.vaultOwnerCheck(unlockTitle, async () => {
      await Vault.setOsUnlock(!Vault.osUnlockEnabled);
      s.notice(Vault.osUnlockEnabled ? "Сейф снова открывается сам через связку ключей" : "Сейф будет спрашивать пароль при запуске");
      render();
    })));
    return panel("Безопасность", "Пароли сайтов, коды входа и почта на этом компьютере зашифрованы ключом сейфа. Открыть его можно паролем аккаунта или ключом восстановления.", [
      titled("Пароль и восстановление", [
        row({ title: "Пароль", text: "Один для входа в аккаунт и для сейфа. Меняются всегда вместе.", control: button("Сменить пароль", "", shell(s => s.accountDialog("change"))) }),
        row({
          title: "Ключ восстановления",
          text: !rkAt ? "Не создан. Если забудете пароль, сейф открыть будет нечем." : upgrade ? `Создан ${date(rkAt)}, но защищён по прежней схеме. Создайте новый: тогда сервер будет хранить только открытый ключ.` : `Создан ${date(rkAt)}. Откроет сейф, если вы забудете пароль.`,
          tone: !rkAt || upgrade ? "warn" : "",
          control: button(rkAt ? "Создать новый" : "Создать ключ", !rkAt || upgrade ? "primary" : "", shell(s => s.vaultRecoveryCreateSheet())),
        }),
      ]),
      titled("Сейф", [
        row({ title: "Открывать сейф через связку ключей macOS", text: silent ? "Сейф открывается сам при запуске браузера на этом компьютере." : "При каждом запуске браузер спрашивает пароль.", control: toggle }),
        row({
          title: "Состояние",
          text: Vault.unlocked ? "Сейф открыт: пароли и коды подставляются на сайтах." : "Сейф заблокирован: пароли и коды закрыты до проверки.",
          control: Vault.unlocked ? button("Заблокировать", "", shell(s => s.accountLockVault())) : button("Разблокировать", "primary", shell(s => s.vaultUnlockByUser())),
        }),
      ]),
    ]);
  },

  devices() {
    const list = state.devices || [];
    const here = Account.deviceId();
    const rows = list.length
      ? list.map(dev => row({ title: dev.name || "Устройство", text: dev.id === here ? "Этот компьютер" : "", control: value(dev.at ? `вход ${date(dev.at)}` : "") }))
      : [row({ title: Account.deviceName(), text: "Этот компьютер" })];
    return panel("Устройства", "Компьютеры, на которых выполнен вход в этот аккаунт.", [
      card(rows),
      h("p", { class: "note" }, Account.isLocalMode ? `Список других устройств и выход на них ${LATER}. Сейчас аккаунт работает только на этом компьютере.` : "Незнакомое устройство в списке — повод сразу сменить пароль."),
    ]);
  },

  sync() {
    const local = Account.isLocalMode;
    const what = [
      ["Пароли сайтов", "Логины и пароли из сейфа."],
      ["Коды входа", "Одноразовые коды двухфакторной защиты."],
      ["Закладки", "Папки и ссылки из раздела «Закладки»."],
      ["Вкладки и пространства", "Открытые вкладки, закреплённые сайты и пространства."],
    ];
    return panel("Синхронизация", "Перенос данных между вашими компьютерами. Всё шифруется на устройстве: сервер хранит только шифрованные копии.", [
      card([row({ title: "Состояние", text: local ? "Данные хранятся только на этом компьютере." : `Сервер ${new URL(Account.serverUrl).host}.`, control: value(local ? LATER : "включена", local ? "muted" : "") })]),
      titled("Что будет переноситься", what.map(([title, text]) => row({ title, text, control: value(local ? "позже" : "да", "muted") }))),
      h("p", { class: "note" }, "Фраза восстановления кошелька не синхронизируется никогда: она остаётся только на том компьютере, где её ввели."),
    ]);
  },

  mail() {
    let aliases = 0;
    try {
      aliases = Shell?.mail().MailStore.aliases?.length || 0;
    } catch (e) {}
    return panel("Почта", "Адрес аккаунта — это и почтовый ящик. Для сайтов браузер создаёт отдельные адреса-алиасы, чтобы основной адрес никто не знал.", [
      card([
        row({ title: "Основной адрес", text: Account.email, control: button("Открыть почту", "", shell(s => s.openMail())) }),
        row({ title: "Алиасы", text: aliases ? `${aliases} ${plural(aliases, "адрес", "адреса", "адресов")} для сайтов. Выключенный алиас перестаёт принимать письма.` : "Пока нет. Алиас создаётся при регистрации на сайте.", control: button("Открыть алиасы", "", shell(s => s.openMail("aliases"))) }),
      ]),
      h("p", { class: "note" }, "В версии 0.1 раздел почты показывает пример ящика. Настоящие адреса на tabora.app начнём выдавать, когда откроем регистрацию."),
    ]);
  },

  data() {
    return panel("Данные", "Перенос паролей и кодов из других программ и сохранение своих данных в файл.", [
      titled("Принести в Tabora", [
        row({ title: "Пароли из файла CSV", text: "Подходят файлы из Chrome, Firefox, Safari, Bitwarden и 1Password.", control: button("Выбрать файл", "", shell(s => s.accountImportPasswords())) }),
        row({ title: "Коды входа", text: "Экспорт Google Authenticator, Aegis, 2FAS или список ссылок otpauth://.", control: button("Выбрать файл", "", shell(s => s.otpImportFile())) }),
      ]),
      titled("Забрать из Tabora", [
        row({ title: "Пароли в файл CSV", text: "Файл не зашифрован: кто его откроет, увидит все пароли. Удалите его сразу после переноса.", control: button("Сохранить файл", "", shell(s => s.accountExportPasswords())) }),
      ]),
    ]);
  },

  exit() {
    return panel("Выход", "После выхода сейф блокируется. Пароли, коды и кошелёк остаются на этом компьютере зашифрованными.", [
      card([
        row({ title: "Выйти из аккаунта", text: Account.email, control: button("Выйти", "", shell(s => s.accountLogout({ thenLogin: false }))) }),
        row({ title: "Войти в другой аккаунт", text: "Текущий аккаунт останется на компьютере, к нему можно вернуться.", control: button("Сменить аккаунт", "", shell(s => s.accountLogout({ thenLogin: true, blankEmail: true }))) }),
      ]),
      titled("Удаление", [row({ title: "Удалить аккаунт", text: `Удаление аккаунта вместе с почтой ${LATER}.`, control: button("Удалить", "danger", () => {}, { disabled: true }) })]),
    ]);
  },
};

/* ---- Отрисовка ------------------------------------------------------------- */

function renderGate() {
  const known = Account.email;
  const gate = document.getElementById("gate");
  gate.replaceChildren(h("div", { class: "gate-card" }, null, [
    h("h1", {}, known ? "Вы вышли из аккаунта" : "Аккаунт Tabora"),
    h("p", {}, known ? `${known}. Войдите, чтобы открыть сейф и настройки аккаунта.` : "Адрес почты на tabora.app и один пароль для входа и сейфа. Аккаунт нужен, чтобы перенести пароли и коды на другой компьютер."),
    h("div", { class: "actions" }, null, [
      button(known ? "Войти" : "Создать аккаунт", "primary", shell(s => s.accountDialog(known ? "login" : "register"))),
      button(known ? "Другой аккаунт" : "Войти", "", shell(s => s.accountDialog(known ? "register" : "login", { blankEmail: true }))),
    ]),
  ]));
}

function renderSide() {
  const status = Shell?.accountStatus() || { level: "ok", text: "" };
  document.getElementById("who").replaceChildren(
    avatar(Account.email),
    h("div", {}, null, [h("b", {}, Account.email), h("span", { class: "status" }, null, [h("i", { class: `dot ${status.level}` }), document.createTextNode(status.text)])])
  );
  const attention = status.level === "warn";
  const tabs = document.getElementById("tabs");
  tabs.replaceChildren(...TABS.map(t => {
    const selected = t.id === state.tab;
    const b = h("button", { class: "tab", type: "button", role: "tab", id: `tab-${t.id}`, "aria-selected": String(selected), "aria-controls": "content", tabindex: selected ? "0" : "-1" }, null, [
      icon(t.icon),
      h("span", {}, t.label),
      t.id === "security" && attention ? h("span", { class: "badge" }, "1") : null,
    ]);
    b.addEventListener("click", () => select(t.id));
    return b;
  }));
}

function renderPanel({ keepScroll = false } = {}) {
  const content = document.getElementById("content");
  const top = content.scrollTop;
  content.setAttribute("aria-labelledby", `tab-${state.tab}`);
  content.replaceChildren(PANELS[state.tab]());
  content.scrollTop = keepScroll ? top : 0;
}

function render({ keepScroll = true } = {}) {
  const signedIn = Account.signedIn;
  document.getElementById("page").hidden = !signedIn;
  document.getElementById("gate").hidden = signedIn;
  if (!signedIn) {
    renderGate();
    return;
  }
  renderSide();
  renderPanel({ keepScroll });
  if (state.tab === "devices") {
    loadDevices();
  }
}

function select(id, { focus = false } = {}) {
  if (!PANELS[id]) {
    return;
  }
  const changed = state.tab !== id;
  state.tab = id;
  if (location.hash.slice(1) !== id) {
    history.replaceState(null, "", `#${id}`);
  }
  render({ keepScroll: !changed });
  if (focus) {
    document.getElementById(`tab-${id}`)?.focus();
  }
}

async function loadDevices() {
  if (state.devicesFor === Account.email && state.devices) {
    return;
  }
  const email = Account.email;
  try {
    state.devices = await Account.devices();
  } catch (e) {
    state.devices = [];
  }
  state.devicesFor = email;
  if (state.tab === "devices" && Account.email === email) {
    renderPanel({ keepScroll: true });
  }
}

/* ---- События ---------------------------------------------------------------- */

// стрелки переключают вкладки-разделы, как положено списку вкладок
document.getElementById("tabs").addEventListener("keydown", e => {
  const i = TABS.findIndex(t => t.id === state.tab);
  const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
  if (step) {
    e.preventDefault();
    select(TABS[(i + step + TABS.length) % TABS.length].id, { focus: true });
  } else if (e.key === "Home" || e.key === "End") {
    e.preventDefault();
    select(TABS[e.key === "Home" ? 0 : TABS.length - 1].id, { focus: true });
  }
});

window.addEventListener("hashchange", () => select(location.hash.slice(1)));

// аккаунт или сейф изменились (вход, выход, блокировка, новый ключ): перерисовать
const refresh = () => {
  clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    state.devices = null;
    render();
  }, 60);
};
Services.obs.addObserver(refresh, Account.TOPIC);
Services.obs.addObserver(refresh, Vault.TOPIC);
window.addEventListener("unload", () => {
  Services.obs.removeObserver(refresh, Account.TOPIC);
  Services.obs.removeObserver(refresh, Vault.TOPIC);
}, { once: true });

(async () => {
  await Account.ready();
  await Vault.ready();
  const initial = location.hash.slice(1);
  if (PANELS[initial]) {
    state.tab = initial;
  }
  render({ keepScroll: false });
})();
