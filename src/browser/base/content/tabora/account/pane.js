/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Раздел «Аккаунт» на странице настроек (about:preferences#sync). Занимает место раздела
 * Firefox «Аккаунт и синхронизация»: его группы скрыты (preferences.css), а сюда встаёт
 * профиль аккаунта Tabora с горизонтальными вкладками.
 *
 * Группы и строки собраны из тех же компонентов, что остальные настройки (moz-card,
 * moz-fieldset, moz-box-group, moz-box-item, moz-button, moz-toggle), поэтому раздел выглядит
 * так же, как соседние. Чувствительные действия раздел сам не выполняет: смена пароля,
 * проверка владельца, ключ восстановления, импорт и экспорт паролей — окна и листы оболочки
 * (Tabora.accountDialog, vaultOwnerCheck, vaultRecoveryCreateSheet). То, чему нужен сервер
 * аккаунтов, так и подписано, пока он не запущен. Вкладка «Аккаунты» — остальные аккаунты
 * этого компьютера: у каждого свой профиль браузера (account/Profiles.sys.mjs).
 *
 * Подключается из preferences.js. Разметка строится через DOM, стили — preferences.css. */

"use strict";

window.TaboraAccountPane = (function () {
  const { Account } = ChromeUtils.importESModule("chrome://tabora/content/account/Account.sys.mjs");
  const { Vault } = ChromeUtils.importESModule("chrome://tabora/content/vault/Vault.sys.mjs");
  const { Profiles } = ChromeUtils.importESModule("chrome://tabora/content/account/Profiles.sys.mjs");
  const Shell = window.browsingContext?.topChromeWindow?.Tabora || null;
  const HTML = "http://www.w3.org/1999/xhtml";
  const LATER = "появится в одной из следующих версий";

  const TABS = [
    ["profile", "Профиль"],
    ["security", "Безопасность"],
    ["sync", "Синхронизация"],
    ["data", "Данные"],
    ["accounts", "Аккаунты"],
    ["exit", "Выход"],
  ];

  const state = { tab: "profile", root: null, pane: null, devices: null, devicesFor: "", profiles: null, timer: null };

  /* ---- Помощники разметки -------------------------------------------------- */

  function el(tag, attrs = {}, children = []) {
    const node = document.createElementNS(HTML, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v !== null && v !== undefined && v !== false) {
        node.setAttribute(k, v === true ? "" : v);
      }
    }
    for (const c of [].concat(children)) {
      if (c !== null && c !== undefined && c !== false) {
        node.append(c);
      }
    }
    return node;
  }

  function button(label, onClick, { type = "default", disabled = false } = {}) {
    const b = el("moz-button", { label, type: type === "default" ? null : type, slot: "actions" });
    b.disabled = disabled;
    b.addEventListener("click", onClick);
    return b;
  }

  function value(text, muted = false) {
    return el("span", { class: `tabora-acc-value${muted ? " muted" : ""}`, slot: "actions" }, text);
  }

  /** Строка: название и пояснение слева, справа кнопки, переключатель или значение. */
  function item(label, description, actions = []) {
    return el("moz-box-item", { label, description: description || null }, actions);
  }

  /** Группа настроек: та же обёртка, что рисует setting-group у остальных разделов. */
  function group(label, description, items) {
    return el("moz-card", { role: "presentation", class: "tabora-acc-group" }, [
      el("moz-fieldset", { label, description: description || null, headinglevel: "2" }, [el("moz-box-group", { type: "list" }, items.filter(Boolean))]),
    ]);
  }

  function date(v) {
    // без хвоста «г.»: дата стоит в середине фраз
    return v ? new Date(v).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" }).replace(/\s*г\.$/, "") : "";
  }

  function plural(n, one, few, many) {
    const m10 = n % 10;
    const m100 = n % 100;
    return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  }

  /** Действие оболочки; если страницу открыли вне окна браузера, ничего не делаем. */
  const shell = fn => () => Shell && fn(Shell);

  /* ---- Вкладки ------------------------------------------------------------- */

  const PANELS = {
    profile() {
      const colors = Shell?.AVATAR_COLORS || [];
      const current = Shell?.accountAvatarColor();
      const names = { "#c8f25a": "лаймовый", "#7cc4ff": "голубой", "#b9a6ff": "сиреневый", "#ff9f5a": "оранжевый", "#5ee0d0": "бирюзовый", "#ff8fb3": "розовый" };
      const swatches = el("div", { class: "tabora-acc-swatches", role: "radiogroup", "aria-label": "Цвет аватара", slot: "actions" }, colors.map(color => {
        const b = el("button", { class: "tabora-acc-swatch", type: "button", role: "radio", "aria-checked": String(color === current), "aria-label": names[color] || color, title: names[color] || color });
        b.style.setProperty("--avatar", color);
        b.addEventListener("click", () => {
          Services.prefs.setStringPref(Shell.AVATAR_PREF, color);
          Shell.renderAccountButton();
          render();
        });
        return b;
      }));
      let aliases = 0;
      try {
        aliases = Shell?.mail().MailStore.aliases?.length || 0;
      } catch (e) {}
      const link = Account.needsServerLink;
      const mailbox = Account.isLocalMode
        ? "Ящик заработает, когда аккаунт подключат к серверу Tabora."
        : link
          ? "Ящик заработает после подключения аккаунта к серверу."
          : `Письма на ${Account.email} приходят на сервер Tabora и открываются в разделе «Почта».`;
      return [
        link
          ? group("Сервер Tabora", "", [
              item("Аккаунт не подключён к серверу", "Он создан на этом компьютере. Подключите его, чтобы заработали почта на этом адресе и вход с других компьютеров. Понадобится пароль аккаунта.", [
                button("Подключить", shell(s => s.accountDialog("link")), { type: "primary" }),
              ]),
            ])
          : null,
        group("Адрес и вид", "Аккаунт Tabora — это адрес почты и один пароль для входа и для сейфа.", [
          item("Адрес почты", Account.email, [button("Скопировать", shell(s => {
            Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(Account.email);
            s.notice("Адрес скопирован");
          }))]),
          item("Цвет аватара", "Кружок с первой буквой адреса виден в правом верхнем углу окна и в почте.", [swatches]),
          Account.data?.createdAt ? item("Аккаунт создан", "", [value(date(Account.data.createdAt))]) : null,
          Account.data?.lastLoginAt ? item("Последний вход на этом компьютере", "", [value(date(Account.data.lastLoginAt))]) : null,
        ]),
        group("Почта", "Адрес аккаунта — это и почтовый ящик. Для сайтов браузер создаёт отдельные адреса-алиасы, чтобы основной адрес никто не знал.", [
          item("Почтовый ящик", mailbox, [button("Открыть почту", shell(s => s.openMail()))]),
          item("Алиасы", aliases ? `${aliases} ${plural(aliases, "адрес", "адреса", "адресов")} для сайтов. Выключенный алиас перестаёт принимать письма.` : "Пока нет. Алиас создаётся при регистрации на сайте.", [button("Открыть алиасы", shell(s => s.openMail("aliases")))]),
        ]),
      ].filter(Boolean);
    },

    security() {
      const rkAt = Vault.recoveryKeyCreatedAt;
      const offServer = !!rkAt && !!Account.data?.recoveryOffServer;
      const upgrade = !!rkAt && (Account.recoveryNeedsUpgrade || offServer);
      const silent = Vault.hasOsKey && Vault.osUnlockEnabled;
      const unlockTitle = Vault.osUnlockEnabled ? "Спрашивать пароль при запуске" : "Открывать сейф через связку ключей";
      const toggle = el("moz-toggle", { slot: "actions", "aria-label": "Открывать сейф через связку ключей macOS" });
      toggle.pressed = !!silent;
      toggle.disabled = !Vault.hasPassword;
      toggle.addEventListener("toggle", () => {
        // состояние меняется только после проверки владельца: до неё переключатель возвращается
        toggle.pressed = !!silent;
        shell(s => s.vaultOwnerCheck(unlockTitle, async () => {
          await Vault.setOsUnlock(!Vault.osUnlockEnabled);
          s.notice(Vault.osUnlockEnabled ? "Сейф снова открывается сам через связку ключей" : "Сейф будет спрашивать пароль при запуске");
          render();
        }))();
      });
      return [
        group("Пароль и восстановление", "Пароли сайтов, коды входа и почта на этом компьютере зашифрованы ключом сейфа. Открыть его можно паролем аккаунта или ключом восстановления.", [
          item("Пароль", "Один для входа в аккаунт и для сейфа. Меняются всегда вместе.", [button("Сменить пароль", shell(s => s.accountDialog("change")))]),
          item(
            "Ключ восстановления",
            !rkAt
              ? "Не создан. Если забудете пароль, сейф открыть будет нечем."
              : offServer
                ? `Создан ${date(rkAt)}, до подключения к серверу: сейф он откроет, но сбросить им забытый пароль аккаунта нельзя. Создайте новый.`
                : upgrade
                  ? `Создан ${date(rkAt)}, но защищён по прежней схеме. Создайте новый: тогда сервер будет хранить только открытый ключ.`
                  : `Создан ${date(rkAt)}. Откроет сейф, если вы забудете пароль.`,
            [button(rkAt ? "Создать новый" : "Создать ключ", shell(s => s.vaultRecoveryCreateSheet()), { type: !rkAt || upgrade ? "primary" : "default" })]
          ),
        ]),
        group("Сейф", "", [
          item("Открывать сейф через связку ключей macOS", silent ? "Сейф открывается сам при запуске браузера на этом компьютере." : "При каждом запуске браузер спрашивает пароль.", [toggle]),
          item("Состояние", Vault.unlocked ? "Сейф открыт: пароли и коды подставляются на сайтах." : "Сейф заблокирован: пароли и коды закрыты до проверки.", [
            Vault.unlocked ? button("Заблокировать", shell(s => s.accountLockVault())) : button("Разблокировать", shell(s => s.vaultUnlockByUser()), { type: "primary" }),
          ]),
        ]),
      ];
    },

    sync() {
      const local = Account.isLocalMode;
      const here = Account.deviceId();
      const list = state.devices || [];
      const devices = list.length
        ? list.map(dev => item(dev.name || "Устройство", dev.id === here ? "Этот компьютер" : "", [value(dev.at ? `вход ${date(dev.at)}` : "")]))
        : [item(Account.deviceName(), "Этот компьютер")];
      const what = [
        ["Пароли сайтов", "Логины и пароли из сейфа."],
        ["Коды входа", "Одноразовые коды двухфакторной защиты."],
        ["Закладки", "Папки и ссылки из раздела «Закладки»."],
        ["Вкладки и пространства", "Открытые вкладки, закреплённые сайты и пространства."],
      ];
      const offline = local || Account.needsServerLink;
      return [
        group("Синхронизация", "Перенос данных между вашими компьютерами. Всё будет шифроваться на устройстве: сервер получит только шифрованные копии.", [
          item(
            "Состояние",
            offline ? "Аккаунт есть только на этом компьютере." : `Аккаунт на сервере ${new URL(Account.serverUrl).host}: вход и почта работают с любого компьютера. Пароли, коды, закладки и вкладки пока остаются на каждом компьютере свои.`,
            [value(offline ? "только здесь" : "вход и почта", true)]
          ),
          ...what.map(([label, text]) => item(label, text, [value("позже", true)])),
          item("Фраза восстановления кошелька", "Не синхронизируется никогда: остаётся только на том компьютере, где её ввели.", [value("никогда", true)]),
        ]),
        group("Устройства", offline ? "Список появится, когда аккаунт подключат к серверу." : "Компьютеры, на которых выполнен вход в этот аккаунт.", devices),
      ];
    },

    data() {
      return [
        group("Принести в Tabora", "Закладки, историю и пароли из другого браузера переносит «Импорт данных браузера» ниже.", [
          item("Пароли из файла CSV", "Подходят файлы из Chrome, Firefox, Safari, Bitwarden и 1Password.", [button("Выбрать файл", shell(s => s.accountImportPasswords()))]),
          item("Коды входа", "Экспорт Google Authenticator, Aegis, 2FAS или список ссылок otpauth://.", [button("Выбрать файл", shell(s => s.otpImportFile()))]),
        ]),
        group("Забрать из Tabora", "", [
          item("Пароли в файл CSV", "Файл не зашифрован: кто его откроет, увидит все пароли. Удалите его сразу после переноса.", [button("Сохранить файл", shell(s => s.accountExportPasswords()))]),
        ]),
      ];
    },

    accounts() {
      const others = (state.profiles || []).filter(p => !p.current);
      const stateText = p => (p.email ? (p.signedIn ? "Вход выполнен." : "Выход выполнен.") : p.fresh ? "Аккаунт ещё не создан." : "Аккаунта в этом профиле нет.");
      return [
        group("Аккаунты на этом компьютере", "У каждого аккаунта свой профиль браузера: свои вкладки, история, сейф, кошелёк и почта. Между аккаунтами ничего не передаётся.", [
          item(Account.email, "Этот профиль.", [value("открыт сейчас", true)]),
          ...others.map(p =>
            item(p.email || (p.fresh ? "Новый аккаунт" : "Профиль без аккаунта"), stateText(p), [
              button("Открыть", shell(s => s.accountOpen(p))),
              button("Удалить", shell(s => s.accountDialog("remove", { profile: p })), { type: "destructive" }),
            ])
          ),
          item("Добавить аккаунт", "Откроется новое окно: в нём создают аккаунт или входят в существующий.", [button("Добавить", shell(s => s.accountAdd()))]),
        ]),
      ];
    },

    exit() {
      return [
        group("Выход", "После выхода кошелёк, коды, пароли и почта закрыты до следующего входа. Данные остаются на этом компьютере зашифрованными.", [
          item("Выйти из аккаунта", Account.email, [button("Выйти", shell(s => s.accountLogout({ thenLogin: false })))]),
        ]),
        group("Удаление", "", [item("Удалить аккаунт", `Удаление аккаунта вместе с почтой ${LATER}.`, [button("Удалить", () => {}, { type: "destructive", disabled: true })])]),
      ];
    },
  };

  /* ---- Отрисовка ----------------------------------------------------------- */

  function who() {
    const email = Account.email;
    if (!Account.signedIn) {
      return el("div", { class: "tabora-acc-who out" }, [
        el("div", { class: "tabora-acc-id" }, [
          el("b", {}, email ? "Вы вышли из аккаунта" : "Аккаунт Tabora"),
          el("span", {}, email ? `${email}. Кошелёк, коды, пароли и почта этого профиля закрыты, пока вы не войдёте снова.` : "Адрес почты на tabora.app и один пароль для входа и сейфа. Кошелёк, коды и почта открываются после входа в аккаунт."),
        ]),
        el("div", { class: "tabora-acc-actions" }, [
          (() => {
            const b = button(email ? "Войти" : "Создать аккаунт", shell(s => s.accountDialog(email ? "login" : "register")), { type: "primary" });
            b.removeAttribute("slot");
            return b;
          })(),
          (() => {
            const b = button(email ? "Другой аккаунт" : "Войти", shell(s => (email ? s.accountShowAccounts() : s.accountDialog("login"))));
            b.removeAttribute("slot");
            return b;
          })(),
        ]),
      ]);
    }
    const status = Shell?.accountStatus() || { level: "ok", text: "" };
    const avatar = el("span", { class: "tabora-acc-avatar", "aria-hidden": "true" }, (email || "?").trim().charAt(0).toUpperCase());
    avatar.style.setProperty("--avatar", Shell?.accountAvatarColor() || "#c8f25a");
    return el("div", { class: "tabora-acc-who" }, [
      avatar,
      el("div", { class: "tabora-acc-id" }, [el("b", {}, email), el("span", { class: "tabora-acc-status" }, [el("i", { class: `tabora-acc-dot ${status.level}` }), status.text])]),
    ]);
  }

  function tabs() {
    const attention = Shell?.accountStatus().level === "warn";
    // значок «нужно действие» стоит на той вкладке, где это действие: подключение к серверу —
    // в «Профиле», ключ восстановления — в «Безопасности»
    const where = Account.needsServerLink ? "profile" : "security";
    const bar = el("div", { class: "tabora-acc-tabs", role: "tablist", "aria-label": "Разделы аккаунта" }, TABS.map(([id, label]) => {
      const selected = id === state.tab;
      const b = el("button", { class: "tabora-acc-tab", type: "button", role: "tab", id: `tabora-acc-tab-${id}`, "aria-selected": String(selected), tabindex: selected ? "0" : "-1" }, [
        label,
        id === where && attention ? el("span", { class: "tabora-acc-badge", "aria-label": "нужно действие" }, "1") : null,
      ]);
      b.addEventListener("click", () => select(id));
      return b;
    }));
    // стрелки переключают вкладки, как положено списку вкладок
    bar.addEventListener("keydown", e => {
      const i = TABS.findIndex(t => t[0] === state.tab);
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (step) {
        e.preventDefault();
        select(TABS[(i + step + TABS.length) % TABS.length][0], { focus: true });
      } else if (e.key === "Home" || e.key === "End") {
        e.preventDefault();
        select(TABS[e.key === "Home" ? 0 : TABS.length - 1][0], { focus: true });
      }
    });
    return bar;
  }

  function render() {
    const root = state.root;
    if (!root?.isConnected) {
      return;
    }
    const signedIn = Account.signedIn;
    // состояние читает preferences.css: без входа — только приглашение; на вкладке «Данные»
    // под нашими группами показывается штатный «Импорт данных браузера»
    state.pane?.setAttribute("data-acc-tab", signedIn ? state.tab : "out");
    if (!signedIn) {
      root.replaceChildren(who());
      return;
    }
    const panel = el("div", { class: "tabora-acc-panel", role: "tabpanel", "aria-labelledby": `tabora-acc-tab-${state.tab}` }, PANELS[state.tab]());
    root.replaceChildren(who(), tabs(), panel);
    if (state.tab === "sync") {
      loadDevices();
    }
  }

  /** Список аккаунтов компьютера: его меняют и другие окна, поэтому перечитывается при
   * открытии вкладки, по сигналу Profiles и когда окно снова становится активным. */
  async function loadProfiles() {
    let list;
    try {
      list = await Profiles.list();
    } catch (e) {
      list = state.profiles || [];
    }
    const changed = JSON.stringify(list) !== JSON.stringify(state.profiles);
    state.profiles = list;
    if (changed && state.tab === "accounts") {
      render();
    }
  }

  function select(id, { focus = false, fromHash = false } = {}) {
    if (!PANELS[id]) {
      return;
    }
    state.tab = id;
    if (id === "accounts") {
      loadProfiles();
    }
    if (!fromHash) {
      // адрес меняется без события hashchange: страница настроек не переключает раздел заново
      history.replaceState(history.state, "", id === "profile" ? "#sync" : `#sync-${id}`);
    }
    render();
    if (focus) {
      document.getElementById(`tabora-acc-tab-${id}`)?.focus();
    }
  }

  function tabFromHash() {
    const m = /^#sync-([a-z]+)$/.exec(location.hash);
    return m && PANELS[m[1]] ? m[1] : null;
  }

  /** Страница настроек сводит адрес вида #sync-accounts к #sync, а подраздел оставляет в
   * gLastCategory и сообщает событием paneshown: вкладку, которую просили открыть, берём оттуда. */
  function tabFromPage() {
    const last = typeof gLastCategory === "object" && gLastCategory ? gLastCategory : null;
    return last?.category === "paneSync" && PANELS[last.subcategory] ? last.subcategory : null;
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
    if (state.tab === "sync" && Account.email === email) {
      render();
    }
  }

  /** section — секция раздела paneSync. Повторный вызов ничего не делает. */
  function mount(section) {
    if (state.root?.isConnected) {
      return;
    }
    state.pane = section.closest("setting-pane");
    state.root = el("div", { id: "tabora-account" });
    const header = section.querySelector("moz-page-header");
    if (header) {
      // заголовок раздела: «Аккаунт» вместо «Аккаунт и синхронизация» Firefox
      header.removeAttribute("data-l10n-id");
      header.setAttribute("heading", "Аккаунт");
      header.heading = "Аккаунт";
      header.after(state.root);
    } else {
      section.prepend(state.root);
    }
    state.tab = tabFromHash() || tabFromPage() || state.tab;
    Promise.all([Account.ready(), Vault.ready(), loadProfiles()]).then(render, render);
  }

  document.addEventListener("paneshown", e => {
    const { category, subcategory } = e.detail || {};
    if (category === "paneSync" && PANELS[subcategory] && state.root?.isConnected) {
      select(subcategory);
    }
  });

  window.addEventListener("hashchange", () => {
    if (location.hash === "#sync") {
      select("profile", { fromHash: true });
    } else {
      const id = tabFromHash();
      if (id) {
        select(id, { fromHash: true });
      }
    }
  });

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
  Services.obs.addObserver(loadProfiles, Profiles.TOPIC);
  window.addEventListener("focus", loadProfiles);
  window.addEventListener("unload", () => {
    Services.obs.removeObserver(refresh, Account.TOPIC);
    Services.obs.removeObserver(refresh, Vault.TOPIC);
    Services.obs.removeObserver(loadProfiles, Profiles.TOPIC);
  }, { once: true });

  return { mount, render };
})();
