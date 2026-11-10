/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Окна аккаунта Tabora: первый запуск, регистрация, вход, смена и сброс пароля.
 * Диалог живёт поверх окна браузера (#tabora-account-dialog), шаги рисуются chrome-DOM.
 * Карточка аккаунта показывается в разделе «Коды». Подключается из tabora.js после vault.js. */

Object.assign(Tabora, {
  _accountMod: null,
  account: { el: null, step: null, after: null },

  accountMod() {
    if (!this._accountMod) {
      this._accountMod = ChromeUtils.importESModule("chrome://tabora/content/account/Account.sys.mjs");
      Services.obs.addObserver(() => this.drawerDirty("codes"), this._accountMod.Account.TOPIC);
    }
    return this._accountMod;
  },

  /** Первый запуск: окно приветствия, пока аккаунт не создан и пользователь не отказался. */
  initAccount() {
    setTimeout(async () => {
      try {
        const { Account } = this.accountMod();
        await Account.ready();
        if (!Account.firstRunDone && !Account.signedIn && window === Services.wm.getMostRecentBrowserWindow()) {
          this.accountDialog("welcome");
        }
      } catch (e) {
        console.error("Tabora account init", e);
      }
    }, 1500);
  },

  /* ---- Диалог ------------------------------------------------------------ */

  accountDialog(step, opts = {}) {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    let root = this.account.el;
    if (!root) {
      root = h("div", { id: "tabora-account-dialog", role: "dialog", "aria-modal": "true", hidden: "true" }, null, [h("div", { class: "ta-scrim" }), h("div", { class: "ta-card" })]);
      document.getElementById("browser").append(root);
      root.querySelector(".ta-scrim").addEventListener("click", () => this.accountClose());
      root.addEventListener("keydown", e => {
        e.stopPropagation();
        if (e.key === "Escape") {
          this.accountClose();
        }
      });
      this.account.el = root;
    }
    root.hidden = false;
    this.account.after = typeof opts.after === "function" ? opts.after : null; // что открыть после входа
    this.account.blankEmail = !!opts.blankEmail; // вход в другой аккаунт: не подставлять прежний адрес
    this.accountRender(step, opts);
  },

  /** Вход или регистрация завершены: выполнить отложенное действие (например, открыть почту). */
  accountAfter() {
    const fn = this.account.after;
    this.account.after = null;
    if (fn) {
      setTimeout(() => fn(), 0);
    }
  },

  accountClose() {
    const root = this.account.el;
    if (!root || root.hidden) {
      return;
    }
    const { Account } = this.accountMod();
    if (this.account.step === "welcome" || this.account.step === "done") {
      Account.markFirstRunDone(); // закрытие приветствия = «продолжить без аккаунта»
    }
    root.hidden = true;
    root.querySelector(".ta-card").replaceChildren();
    this.account.step = null;
    this.account.after = null;
  },

  accountRender(step, opts = {}) {
    const card = this.account.el.querySelector(".ta-card");
    this.account.step = step;
    const builders = { welcome: this.accountWelcome, register: this.accountRegister, recovery: this.accountRecovery, done: this.accountDone, login: this.accountLogin, change: this.accountChange, forgot: this.accountForgot };
    card.replaceChildren(builders[step].call(this, opts));
    setTimeout(() => card.querySelector("input:not([type=checkbox])")?.focus(), 60);
  },

  /* ---- Элементы ---------------------------------------------------------- */

  taField(label, attrs = {}, { suffix = null } = {}) {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const input = h("input", { class: "ta-input", ...attrs });
    const box = suffix ? h("div", { class: "ta-input-wrap" }, null, [input, h("span", { class: "ta-suffix" }, suffix)]) : input;
    return { wrap: h("label", { class: "ta-field" }, null, [h("span", {}, label), box]), input };
  },

  taButton(label, cls, onClick) {
    const b = this.html("button", { class: `ta-btn ${cls || ""}`.trim(), type: "button" }, label);
    b.addEventListener("click", onClick);
    return b;
  },

  taLink(label, onClick) {
    const b = this.html("button", { class: "ta-link", type: "button" }, label);
    b.addEventListener("click", onClick);
    return b;
  },

  /** Поле пароля с индикатором стойкости и повтором. */
  taPasswordPair(label = "Пароль", { withRepeat = true } = {}) {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { passwordStrength, Account } = this.accountMod();
    const pass = this.taField(label, { type: "password", autocomplete: "new-password", placeholder: `не короче ${Account.MIN_PASSWORD} символов` });
    const meter = h("div", { class: "ta-meter", "data-score": "0" }, null, [0, 1, 2, 3].map(() => h("i")));
    const meterText = h("span", { class: "ta-meter-text" }, "");
    pass.wrap.append(h("div", { class: "ta-meter-row" }, null, [meter, meterText]));
    pass.input.addEventListener("input", () => {
      const s = passwordStrength(pass.input.value);
      meter.dataset.score = String(s.score);
      meterText.textContent = pass.input.value ? (s.score < 2 ? `${s.label} · не подойдёт` : s.label) : "";
    });
    const again = withRepeat ? this.taField("Повторите пароль", { type: "password", autocomplete: "new-password" }) : null;
    const read = () => {
      const a = pass.input.value;
      if (again && a !== again.input.value) {
        throw new Error("Пароли не совпадают");
      }
      return a;
    };
    return { pass, again, read, nodes: [pass.wrap, again?.wrap].filter(Boolean) };
  },

  taForm({ title, text, fields, okLabel, busyLabel = "Подождите", onOk, links = [], back = null }) {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { Account } = this.accountMod();
    const err = h("div", { class: "ta-error", hidden: "true" });
    const status = h("p", { class: "ta-progress", role: "status", "aria-live": "polite", hidden: "true" });
    const ok = this.taButton(okLabel, "primary", async () => {
      if (ok.disabled) {
        return;
      }
      const form = ok.closest(".ta-step");
      const controls = Array.from(form.querySelectorAll("input, button, select")).filter(el => !el.disabled);
      const label = h("span", { class: "ta-btn-label" }, `${busyLabel}…`);
      ok.replaceChildren(h("span", { class: "ta-spinner", "aria-hidden": "true" }), label);
      ok.classList.add("loading");
      ok.setAttribute("aria-busy", "true");
      controls.forEach(el => (el.disabled = true));
      err.hidden = true;
      status.hidden = true;
      // этапы операции: текст на кнопке; если тянется дольше, поясняем под кнопкой
      Account.onStep = step => (label.textContent = `${step}…`);
      const slow = setTimeout(() => {
        status.textContent = "Это занимает несколько секунд: пароль проверяется с защитой от подбора.";
        status.hidden = false;
      }, 3000);
      const restore = () => {
        clearTimeout(slow);
        Account.onStep = null;
        status.hidden = true;
        ok.replaceChildren(okLabel);
        ok.classList.remove("loading");
        ok.removeAttribute("aria-busy");
        controls.forEach(el => (el.disabled = false));
      };
      try {
        await onOk();
        clearTimeout(slow);
        Account.onStep = null;
      } catch (e) {
        restore();
        err.textContent = e.message || String(e);
        err.hidden = false;
      }
    });
    const form = h("div", { class: "ta-step" }, null, [
      back ? this.taLink("← Назад", back) : null,
      h("div", { class: "ta-brand" }, null, [this.markSvg("ta-mark"), h("span", {}, "Tabora"), h("i", {}, "аккаунт")]),
      h("h2", {}, title),
      text ? h("p", { class: "ta-text" }, text) : null,
      ...fields,
      err,
      ok,
      status,
      links.length ? h("div", { class: "ta-links" }, null, links) : null,
    ].filter(Boolean));
    form.addEventListener("keydown", e => {
      if (e.key === "Enter" && e.target.localName === "input" && e.target.type !== "checkbox") {
        ok.click();
      }
    });
    return form;
  },

  /* ---- Шаги --------------------------------------------------------------- */

  accountWelcome() {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { Account } = this.accountMod();
    const row = (icon, title, text) =>
      h("li", {}, null, [this.svg(icon, 16, 1.7), h("div", {}, null, [h("b", {}, title), h("span", {}, text)])]);
    const skip = this.taLink("Не сейчас", () => this.accountClose());
    return h("div", { class: "ta-step ta-welcome" }, null, [
      h("div", { class: "ta-brand" }, null, [this.markSvg("ta-mark"), h("span", {}, "Tabora"), h("i", {}, "аккаунт")]),
      h("h2", {}, "Почта, сейф и перенос на другой компьютер"),
      h("ul", { class: "ta-list" }, null, [
        row(["M3.5 6.5h17v11h-17z", "M3.5 7l8.5 6 8.5-6"], `имя@${Account.domain}`, "Свой адрес и алиасы для регистраций"),
        row(["M7 11V8a5 5 0 0 1 10 0v3", "M5 11h14v10H5z"], "Сейф", "Пароли и коды входа шифруются на этом компьютере"),
        row(["M4 7h11v9H4z", "M9 20h11v-9", "M15 11h5"], "Перенос", "Вход на новом компьютере возвращает всё на место"),
      ]),
      h("p", { class: "ta-hint" }, "Один пароль на всё. Он не покидает компьютер, восстановить его можно только вашим ключом восстановления."),
      h("div", { class: "ta-foot" }, null, [
        this.taButton("Создать аккаунт", "primary", () => this.accountRender("register")),
        this.taButton("Войти", "ghost", () => this.accountRender("login")),
        skip,
      ]),
    ]);
  },

  accountRegister() {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { Account } = this.accountMod();
    const { Vault } = this.vaultMod();
    const name = this.taField("Адрес почты", { type: "text", autocomplete: "off", spellcheck: "false", placeholder: "имя", autocapitalize: "off" }, { suffix: `@${Account.domain}` });
    const pw = this.taPasswordPair(Vault.exists && Vault.hasPassword ? "Пароль (мастер-пароль сейфа)" : "Пароль");
    const fields = [name.wrap, ...pw.nodes];
    if (Vault.exists && Vault.hasPassword) {
      fields.push(h("p", { class: "ta-hint" }, "Сейф на этом компьютере уже защищён мастер-паролем. Пароль аккаунта должен быть тем же: он откроет и сейф, и аккаунт."));
    } else {
      fields.push(h("p", { class: "ta-hint" }, "Один пароль для почты и сейфа. Сервер получает только его хеш для входа, сам пароль не покидает компьютер, поэтому забытый пароль восстанавливается только ключом восстановления, который вы получите на следующем шаге."));
    }
    return this.taForm({
      title: "Создать аккаунт",
      fields,
      okLabel: "Создать аккаунт",
      busyLabel: "Создаём аккаунт",
      back: () => this.accountRender("welcome"),
      onOk: async () => {
        const password = pw.read();
        const r = await Account.register(name.input.value, password);
        this.accountRender("recovery", { email: r.email, key: r.recoveryKey });
      },
      links: [this.taLink("Уже есть аккаунт? Войти", () => this.accountRender("login"))],
    });
  },

  /** Ключ восстановления: после регистрации, после перепривязки сейфа к другому аккаунту
   * (rebound) или после смены пароля со сменой ключа сейфа (rotated). Показывается один раз. */
  accountRecovery({ email, key = null, rebound = false, rotated = false }) {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const pre = h("pre", { class: "ta-secret", masked: "true" }, key || "Ключ не создан: создайте его в разделе «Коды» → «Сейф»");
    const reveal = this.taButton("Показать", "ghost small", () => {
      pre.toggleAttribute("masked");
      reveal.textContent = pre.hasAttribute("masked") ? "Показать" : "Скрыть";
    });
    const copy = this.taButton("Скопировать", "ghost small", () => {
      if (key) {
        this.copyWithExpiry(key, 60000);
        this.notice("Ключ скопирован · буфер очистится через минуту");
      }
    });
    copy.disabled = !key;
    const check = h("input", { type: "checkbox", id: "ta-rk-saved" });
    const finish = () => {
      if (rebound || rotated) {
        const after = this.account.after;
        this.accountClose();
        this.account.after = after;
        this.accountAfter();
      } else {
        this.accountRender("done", { email });
      }
    };
    const next = this.taButton("Продолжить", "primary", finish);
    next.disabled = !!key;
    check.addEventListener("change", () => { next.disabled = !check.checked; });
    const text = rebound
      ? `Сейф этого компьютера передан аккаунту ${email}: ключ шифрования заменён, данные перешифрованы. Прежний мастер-пароль и прежний ключ восстановления больше не действуют. Запишите новый ключ и храните отдельно от компьютера: он показывается один раз.`
      : rotated
        ? "Ключ шифрования сейфа заменён, данные перешифрованы. Прежний ключ восстановления больше не действует. Запишите новый и храните отдельно от компьютера: он показывается один раз."
        : "Если вы забудете пароль, только этот ключ откроет сейф и аккаунт. Запишите его и храните отдельно от компьютера: он показывается один раз.";
    return h("div", { class: "ta-step" }, null, [
      h("h2", {}, rebound || rotated ? "Новый ключ восстановления" : "Ключ восстановления"),
      h("p", { class: "ta-text" }, text),
      pre,
      h("div", { class: "ta-actions row" }, null, [reveal, copy]),
      key ? h("label", { class: "ta-check" }, null, [check, h("span", {}, "Я записал ключ в надёжное место")]) : null,
      next,
    ].filter(Boolean));
  },

  accountDone({ email }) {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { Account } = this.accountMod();
    return h("div", { class: "ta-step" }, null, [
      h("div", { class: "ta-orb" }, null, [this.markSvg("ta-mark")]),
      h("h2", {}, "Готово"),
      h("p", { class: "ta-text" }, `Аккаунт ${email || Account.email} создан на этом компьютере.`),
      h("ul", { class: "ta-points" }, null, [
        h("li", {}, "Сейф открыт, пароли сайтов шифруются его ключом"),
        h("li", {}, "Раздел «Коды» для двухфакторной защиты: ⌘⇧K"),
        h("li", {}, "Кошелёк: ⌘⇧W, почта и алиасы: ⌘⇧M"),
        h("li", {}, Account.isLocalMode ? "Синхронизация между компьютерами включится, когда появится сервер" : "Синхронизация с сервером включена"),
      ]),
      this.taButton("Начать", "primary", () => {
        const after = this.account.after;
        this.accountClose();
        this.account.after = after;
        this.accountAfter();
      }),
    ]);
  },

  accountLogin() {
    const { Account } = this.accountMod();
    const email = this.taField("Адрес почты", { type: "text", autocomplete: "username", spellcheck: "false", placeholder: "имя", autocapitalize: "off", value: Account.email && !this.account.blankEmail ? Account.email.split("@")[0] : "" }, { suffix: `@${Account.domain}` });
    const pass = this.taField("Пароль", { type: "password", autocomplete: "current-password" });
    const vaultPass = this.taField("Мастер-пароль сейфа этого компьютера", { type: "password", autocomplete: "off" });
    vaultPass.wrap.hidden = true;
    return this.taForm({
      title: "Вход",
      fields: [email.wrap, pass.wrap, vaultPass.wrap],
      okLabel: "Войти",
      busyLabel: "Входим",
      back: Account.firstRunDone ? null : () => this.accountRender("welcome"),
      onOk: async () => {
        let r;
        try {
          r = await Account.login(email.input.value, pass.input.value, { vaultPassword: vaultPass.wrap.hidden ? null : vaultPass.input.value });
        } catch (e) {
          if (e.code === "vault-mismatch") {
            vaultPass.wrap.hidden = false;
            vaultPass.input.focus();
          }
          throw e;
        }
        this.notice(`Вы вошли как ${r.email}`);
        if (r.rebound) {
          // сейф перепривязан: K сменён, прежний ключ восстановления больше не действует
          this.accountRender("recovery", { email: r.email, key: r.recoveryKey, rebound: true });
          return;
        }
        const after = this.account.after;
        this.accountClose();
        this.account.after = after;
        this.accountAfter();
      },
      links: [
        this.taLink("Забыли пароль? Ключ восстановления", () => this.accountRender("forgot")),
        this.taLink("Создать аккаунт", () => this.accountRender("register")),
      ],
    });
  },

  accountChange() {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { Account } = this.accountMod();
    const old = this.taField("Текущий пароль", { type: "password", autocomplete: "current-password" });
    const pw = this.taPasswordPair("Новый пароль");
    const rotate = h("input", { type: "checkbox" });
    return this.taForm({
      title: "Сменить пароль",
      text: "Пароль аккаунта и мастер-пароль сейфа меняются вместе. На других компьютерах потребуется войти заново.",
      fields: [old.wrap, ...pw.nodes, h("label", { class: "ta-check" }, null, [rotate, h("span", {}, "Сменить и ключ шифрования сейфа: если пароль мог узнать кто-то ещё. Ключ восстановления тоже заменится")])],
      okLabel: "Сменить пароль",
      busyLabel: "Меняем пароль",
      onOk: async () => {
        const r = await Account.changePassword(old.input.value, pw.read(), { rotate: rotate.checked });
        this.notice(r.complete === false ? "Пароль изменён; часть данных перешифруется при следующей разблокировке" : "Пароль изменён");
        if (r.recoveryKey) {
          this.accountRender("recovery", { email: Account.email, key: r.recoveryKey, rotated: true });
          return;
        }
        this.accountClose();
      },
    });
  },

  accountForgot() {
    const { Account } = this.accountMod();
    const { Vault } = this.vaultMod();
    const key = this.taField("Ключ восстановления", { type: "text", autocomplete: "off", spellcheck: "false", placeholder: "XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" });
    const pw = this.taPasswordPair("Новый пароль");
    return this.taForm({
      title: "Восстановление доступа",
      text: Vault.hasRecoveryKey ? "Введите ключ восстановления, записанный при настройке, и задайте новый пароль." : "Для этого сейфа ключ восстановления не создавался: без пароля данные не восстановить.",
      fields: [key.wrap, ...pw.nodes],
      okLabel: "Задать новый пароль",
      busyLabel: "Задаём новый пароль",
      back: () => this.accountRender("login"),
      onOk: async () => {
        const password = pw.read();
        if (Account.email) {
          await Account.resetPasswordWithRecovery(key.input.value, password);
        } else {
          await Vault.unlockWithRecoveryKey(key.input.value);
          await Vault.setPassword(password);
        }
        this.notice("Новый пароль задан");
        this.accountClose();
      },
    });
  },

  /* ---- Выход и меню аккаунта --------------------------------------------------- */

  /** Выйти из аккаунта: почта закрывается, затем окно входа, где можно войти в другой аккаунт. */
  async accountLogout({ thenLogin = true, blankEmail = false } = {}) {
    const { Account } = this.accountMod();
    await Account.logout();
    for (const t of gBrowser.tabs.filter(t => this.isMailUrl(t.linkedBrowser?.currentURI?.spec))) {
      if (gBrowser.tabs.length > 1) {
        gBrowser.removeTab(t);
      } else {
        t.linkedBrowser.loadURI(Services.io.newURI("about:newtab"), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      }
    }
    this.notice("Вы вышли из аккаунта. Сейф заблокирован, данные остаются на этом компьютере.");
    if (thenLogin) {
      this.accountDialog("login", { blankEmail });
    }
  },

  /** Пункты меню аккаунта для правого клика по «Почта и алиасы» и для страницы почты. */
  accountMenuItems() {
    const { Account } = this.accountMod();
    const items = [{ label: "Открыть почту", icon: ["M3.5 6.5h17v11h-17z", "M3.5 7l8.5 6 8.5-6"], run: () => this.openMail() }, { separator: true }];
    if (Account.signedIn) {
      items.push(
        { label: Account.email, disabled: true, run: () => {} },
        { label: "Сменить пароль", icon: ["M7 11V8a5 5 0 0 1 10 0v3", "M5 11h14v10H5z"], run: () => this.accountDialog("change") },
        { label: "Выйти из аккаунта", icon: ["M10 17l5-5-5-5", "M15 12H3", "M21 4v16"], run: () => this.accountLogout() },
        { label: "Войти в другой аккаунт", icon: ["M12 5v14", "M5 12h14"], run: () => this.accountLogout({ thenLogin: true, blankEmail: true }) }
      );
    } else {
      items.push(
        { label: "Войти", icon: ["M14 7l5 5-5 5", "M19 12H9", "M3 4v16"], run: () => this.accountDialog("login") },
        { label: "Создать аккаунт", icon: ["M12 5v14", "M5 12h14"], run: () => this.accountDialog("register") }
      );
    }
    return items;
  },

  /* ---- Карточка аккаунта в разделе «Коды» ------------------------------------ */

  accountCard() {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { Account } = this.accountMod();
    const row = (name, value, cls = "") => h("div", { class: `w-kv ${cls}`.trim() }, null, [h("span", {}, name), h("b", {}, value)]);
    const kids = [];
    if (Account.signedIn) {
      kids.push(row("Аккаунт", Account.email));
      kids.push(row("Синхронизация", Account.isLocalMode ? "появится, когда будет сервер · данные пока только на этом компьютере" : `сервер ${new URL(Account.serverUrl).host}`, Account.isLocalMode ? "muted" : ""));
      kids.push(this.wButton("Сменить пароль", "ghost", () => this.accountDialog("change")));
      kids.push(this.wButton("Выйти из аккаунта", "ghost", () => this.accountLogout({ thenLogin: false })));
      kids.push(this.wButton("Войти в другой аккаунт", "ghost", () => this.accountLogout({ thenLogin: true, blankEmail: true })));
    } else {
      kids.push(row("Аккаунт", Account.email ? `${Account.email} · выход выполнен` : "не создан", "muted"));
      kids.push(h("p", { class: "w-hint" }, "Аккаунт нужен для переноса сейфа, паролей и кодов на другой компьютер."));
      kids.push(h("div", { class: "w-actions" }, null, [
        this.wButton(Account.email ? "Войти" : "Создать аккаунт", "primary small", () => this.accountDialog(Account.email ? "login" : "register")),
        this.wButton(Account.email ? "Другой аккаунт" : "Войти", "ghost small", () => this.accountDialog(Account.email ? "register" : "login")),
      ]));
    }
    const brief = Account.signedIn ? Account.email : Account.email ? "выход выполнен" : "нет аккаунта";
    const summary = h("summary", { class: "v-card-head" }, null, [h("b", { class: "w-group-title" }, "Аккаунт"), h("span", { class: "v-card-sub" }, brief), this.svg(["m6 9 6 6 6-6"], 14, 2.2)]);
    const card = h("details", { class: "w-group v-card" }, null, [summary, h("div", { class: "v-card-body" }, null, kids)]);
    card.open = Services.prefs.getBoolPref("tabora.account.cardOpen", false);
    card.addEventListener("toggle", () => Services.prefs.setBoolPref("tabora.account.cardOpen", card.open));
    return card;
  },

  /* ---- Кнопка аккаунта в правом верхнем углу ------------------------------------------
   * Без входа — «Войти». После входа — кружок с первой буквой и имя до @; точка на кружке:
   * зелёная — всё в порядке, жёлтая — нужно действие (нет ключа восстановления или его пора
   * обновить), серая — сейф заблокирован. Щелчок открывает раздел «Аккаунт» в настройках. */

  AVATAR_PREF: "tabora.account.avatarColor",
  AVATAR_COLORS: ["#c8f25a", "#7cc4ff", "#b9a6ff", "#ff9f5a", "#5ee0d0", "#ff8fb3"],

  accountAvatarColor() {
    const c = Services.prefs.getStringPref(this.AVATAR_PREF, "");
    return this.AVATAR_COLORS.includes(c) ? c : this.AVATAR_COLORS[0];
  },

  /** { level: "ok" | "warn" | "locked", text } — что показать точкой и подсказкой. */
  accountStatus() {
    const { Account } = this.accountMod();
    const { Vault } = this.vaultMod();
    if (!Vault.unlocked) {
      return { level: "locked", text: "сейф заблокирован" };
    }
    if (!Vault.recoveryKeyCreatedAt) {
      return { level: "warn", text: "нет ключа восстановления" };
    }
    if (Account.recoveryNeedsUpgrade) {
      return { level: "warn", text: "ключ восстановления пора обновить" };
    }
    return { level: "ok", text: "всё в порядке" };
  },

  accountAvatar(email, { size = "" } = {}) {
    const letter = (email || "?").trim().charAt(0).toUpperCase() || "?";
    const el = this.html("span", { class: `ta-avatar ${size}`.trim(), "aria-hidden": "true" }, letter);
    el.style.setProperty("--avatar", this.accountAvatarColor());
    return el;
  },

  buildAccountButton() {
    const btn = this.html("button", { id: "tabora-account-btn", type: "button" });
    btn.addEventListener("click", () => this.accountButtonClick());
    btn.addEventListener("contextmenu", e => {
      e.preventDefault();
      this.showMenu(this.accountQuickItems(), e.clientX, e.clientY);
    });
    this.account.button = btn;
    const refresh = () => this.renderAccountButton();
    Services.obs.addObserver(refresh, this.accountMod().Account.TOPIC);
    Services.obs.addObserver(refresh, this.vaultMod().Vault.TOPIC);
    window.addEventListener("unload", () => {
      Services.obs.removeObserver(refresh, this.accountMod().Account.TOPIC);
      Services.obs.removeObserver(refresh, this.vaultMod().Vault.TOPIC);
    }, { once: true });
    this.accountMod().Account.ready().then(refresh, refresh);
    this.renderAccountButton();
    return btn;
  },

  renderAccountButton() {
    const btn = this.account.button;
    if (!btn) {
      return;
    }
    const { Account } = this.accountMod();
    if (Account.signedIn) {
      const status = this.accountStatus();
      const avatar = this.accountAvatar(Account.email);
      avatar.append(this.html("i", { class: `dot ${status.level}` }));
      btn.replaceChildren(avatar, this.html("span", { class: "name" }, Account.email.split("@")[0]));
      btn.title = `${Account.email} · ${status.text}`;
      btn.setAttribute("aria-label", `Аккаунт ${Account.email}, ${status.text}`);
      btn.dataset.state = "in";
    } else {
      btn.replaceChildren(this.svg(["M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M4.5 20c1.4-3.3 4.2-5 7.5-5s6.1 1.7 7.5 5"], 15, 1.9), this.html("span", { class: "name" }, "Войти"));
      btn.title = Account.email ? `Войти в аккаунт ${Account.email}` : "Войти или создать аккаунт Tabora";
      btn.setAttribute("aria-label", btn.title);
      btn.dataset.state = "out";
    }
  },

  accountButtonClick() {
    const { Account } = this.accountMod();
    if (Account.signedIn) {
      this.openAccountPage();
    } else {
      this.accountDialog(Account.email ? "login" : "welcome");
    }
  },

  /** Быстрые действия по правому клику на кнопке аккаунта. */
  accountQuickItems() {
    const { Account } = this.accountMod();
    const { Vault } = this.vaultMod();
    if (!Account.signedIn) {
      return [
        { label: "Войти", icon: ["M14 7l5 5-5 5", "M19 12H9", "M3 4v16"], run: () => this.accountDialog("login") },
        { label: "Создать аккаунт", icon: ["M12 5v14", "M5 12h14"], run: () => this.accountDialog("register") },
      ];
    }
    return [
      { label: Account.email, disabled: true, run: () => {} },
      { label: "Открыть профиль", icon: ["M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M4.5 20c1.4-3.3 4.2-5 7.5-5s6.1 1.7 7.5 5"], run: () => this.openAccountPage() },
      { separator: true },
      Vault.unlocked
        ? { label: "Заблокировать сейф", icon: ["M7 11V8a5 5 0 0 1 10 0v3", "M5 11h14v10H5z"], run: () => this.accountLockVault() }
        : { label: "Разблокировать сейф", icon: ["M7 11V8a5 5 0 0 1 9.6-2", "M5 11h14v10H5z"], run: () => this.vaultUnlockByUser() },
      { label: "Выйти из аккаунта", icon: ["M10 17l5-5-5-5", "M15 12H3", "M21 4v16"], run: () => this.accountLogout() },
      { label: "Сменить аккаунт", icon: ["M12 5v14", "M5 12h14"], run: () => this.accountLogout({ thenLogin: true, blankEmail: true }) },
    ];
  },

  accountLockVault() {
    const { Vault } = this.vaultMod();
    Vault.lock();
    this.notice(Vault.lockPending ? "Сейф заблокируется, как только закончится текущая операция с ключом" : "Сейф заблокирован: пароли сайтов и коды закрыты до проверки");
  },

  /* ---- Раздел «Аккаунт» в настройках ------------------------------------------------------
   * Профиль аккаунта — раздел страницы настроек (account/pane.js, about:preferences#sync),
   * с горизонтальными вкладками. Чувствительные действия он не дублирует: зовёт те же окна и
   * листы оболочки. */

  /** tab — вкладка раздела: profile, security, sync, data, exit. */
  openAccountPage(tab = "") {
    openPreferences(tab && tab !== "profile" ? `sync-${tab}` : "paneSync");
  },

  /** Пароли из файла CSV: разбор и запись делает штатный модуль Firefox, хранилище — сейф. */
  accountImportPasswords() {
    const { Vault } = this.vaultMod();
    if (!Vault.unlocked) {
      this.notice("Сначала разблокируйте сейф");
      return;
    }
    const fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    fp.init(window.browsingContext, "Импорт паролей", Ci.nsIFilePicker.modeOpen);
    fp.appendFilter("Таблица паролей", "*.csv; *.tsv");
    fp.appendFilters(Ci.nsIFilePicker.filterAll);
    fp.open(async rv => {
      if (rv !== Ci.nsIFilePicker.returnOK || !fp.file) {
        return;
      }
      try {
        const { LoginCSVImport } = ChromeUtils.importESModule("resource://gre/modules/LoginCSVImport.sys.mjs");
        const summary = await LoginCSVImport.importFromCSV(fp.file.path);
        const count = what => summary.filter(r => r.result === what).length;
        const added = count("added");
        const changed = count("modified");
        const skipped = summary.length - added - changed;
        this.notice(`Пароли: добавлено ${added}, обновлено ${changed}${skipped ? `, без изменений или с ошибкой ${skipped}` : ""}`);
      } catch (e) {
        this.notice(`Не удалось прочитать файл: ${e.message}`);
      }
    });
  },

  /** Пароли в файл CSV: только после проверки владельца, файл не зашифрован. */
  accountExportPasswords() {
    this.vaultOwnerCheck("Сохранить пароли в файл", async () => {
      const fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
      fp.init(window.browsingContext, "Сохранить пароли", Ci.nsIFilePicker.modeSave);
      fp.appendFilter("Таблица паролей", "*.csv");
      fp.defaultString = "tabora-passwords.csv";
      fp.defaultExtension = "csv";
      fp.open(async rv => {
        if ((rv !== Ci.nsIFilePicker.returnOK && rv !== Ci.nsIFilePicker.returnReplace) || !fp.file) {
          return;
        }
        try {
          const { LoginExport } = ChromeUtils.importESModule("resource://gre/modules/LoginExport.sys.mjs");
          await LoginExport.exportAsCSV(fp.file.path);
          this.notice("Пароли сохранены. Файл не зашифрован: удалите его после переноса.");
        } catch (e) {
          this.notice(`Не удалось сохранить файл: ${e.message}`);
        }
      });
    });
  },
});

