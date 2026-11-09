/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Окна аккаунта Tabora: первый запуск, регистрация, вход, смена и сброс пароля.
 * Диалог живёт поверх окна браузера (#tabora-account-dialog), шаги рисуются chrome-DOM.
 * Карточка аккаунта показывается в разделе «Коды». Подключается из tabora.js после vault.js. */

Object.assign(Tabora, {
  _accountMod: null,
  account: { el: null, step: null },

  accountMod() {
    if (!this._accountMod) {
      this._accountMod = ChromeUtils.importESModule("chrome://browser/content/tabora/account/Account.sys.mjs");
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
    this.accountRender(step, opts);
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
  },

  accountRender(step, opts = {}) {
    const card = this.account.el.querySelector(".ta-card");
    this.account.step = step;
    const builders = { welcome: this.accountWelcome, register: this.accountRegister, recovery: this.accountRecovery, done: this.accountDone, login: this.accountLogin, change: this.accountChange, forgot: this.accountForgot };
    card.replaceChildren(builders[step].call(this, opts));
    setTimeout(() => card.querySelector("input:not([type=checkbox])")?.focus(), 60);
  },

  /* ---- Элементы ---------------------------------------------------------- */

  /** Знак Tabora с точкой, которая прокатывается по перекладине и останавливается на своём месте. */
  taMark() {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 256 256");
    svg.setAttribute("class", "ta-mark");
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
      meterText.textContent = pass.input.value ? s.label : "";
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

  taForm({ title, text, fields, okLabel, onOk, links = [], back = null }) {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const err = h("div", { class: "ta-error", hidden: "true" });
    const ok = this.taButton(okLabel, "primary", async () => {
      ok.disabled = true;
      ok.classList.add("loading");
      err.hidden = true;
      try {
        await onOk();
      } catch (e) {
        err.textContent = e.message || String(e);
        err.hidden = false;
        ok.disabled = false;
        ok.classList.remove("loading");
      }
    });
    const form = h("div", { class: "ta-step" }, null, [
      back ? this.taLink("← Назад", back) : null,
      h("h2", {}, title),
      text ? h("p", { class: "ta-text" }, text) : null,
      ...fields,
      err,
      ok,
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
    return h("div", { class: "ta-step ta-welcome" }, null, [
      h("div", { class: "ta-orb" }, null, [this.taMark()]),
      h("h2", {}, "Добро пожаловать в Tabora"),
      h("p", { class: "ta-text" }, `Аккаунт даёт адрес почты в домене ${Account.domain}, сейф для паролей и кодов и перенос всего на другой компьютер. Один пароль на всё, данные зашифрованы на устройстве.`),
      h("div", { class: "ta-actions" }, null, [
        this.taButton("Создать аккаунт", "primary", () => this.accountRender("register")),
        this.taButton("У меня уже есть аккаунт", "ghost", () => this.accountRender("login")),
      ]),
      this.taLink("Продолжить без аккаунта", () => this.accountClose()),
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
      fields.push(h("p", { class: "ta-hint" }, "Этот пароль станет мастер-паролем сейфа. Он не отправляется на сервер и не восстанавливается без ключа восстановления, который вы получите на следующем шаге."));
    }
    return this.taForm({
      title: "Создать аккаунт",
      fields,
      okLabel: "Создать аккаунт",
      back: () => this.accountRender("welcome"),
      onOk: async () => {
        const password = pw.read();
        const r = await Account.register(name.input.value, password);
        this.accountRender("recovery", { email: r.email });
      },
      links: [this.taLink("Уже есть аккаунт? Войти", () => this.accountRender("login"))],
    });
  },

  accountRecovery({ email }) {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { Vault } = this.vaultMod();
    const pre = h("pre", { class: "ta-secret", masked: "true" }, "…");
    const reveal = this.taButton("Показать", "ghost small", () => {
      pre.toggleAttribute("masked");
      reveal.textContent = pre.hasAttribute("masked") ? "Показать" : "Скрыть";
    });
    const copy = this.taButton("Скопировать", "ghost small", () => {
      this.copyWithExpiry(pre.textContent, 60000);
      this.notice("Ключ скопирован · буфер очистится через минуту");
    });
    const check = h("input", { type: "checkbox", id: "ta-rk-saved" });
    const next = this.taButton("Продолжить", "primary", () => this.accountRender("done", { email }));
    next.disabled = true;
    check.addEventListener("change", () => { next.disabled = !check.checked; });
    Vault.createRecoveryKey().then(key => { pre.textContent = key; }).catch(e => { pre.textContent = `Ошибка: ${e.message}`; });
    return h("div", { class: "ta-step" }, null, [
      h("h2", {}, "Ключ восстановления"),
      h("p", { class: "ta-text" }, "Если вы забудете пароль, только этот ключ откроет сейф и аккаунт. Запишите его и храните отдельно от компьютера: он показывается один раз."),
      pre,
      h("div", { class: "ta-actions row" }, null, [reveal, copy]),
      h("label", { class: "ta-check" }, null, [check, h("span", {}, "Я записал ключ в надёжное место")]),
      next,
    ]);
  },

  accountDone({ email }) {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { Account } = this.accountMod();
    return h("div", { class: "ta-step" }, null, [
      h("div", { class: "ta-orb" }, null, [this.taMark()]),
      h("h2", {}, "Готово"),
      h("p", { class: "ta-text" }, `Аккаунт ${email || Account.email} создан на этом компьютере.`),
      h("ul", { class: "ta-points" }, null, [
        h("li", {}, "Сейф открыт, пароли сайтов шифруются его ключом"),
        h("li", {}, "Раздел «Коды» для двухфакторной защиты: ⌘⇧K"),
        h("li", {}, "Кошелёк: ⌘⇧W, почта и алиасы: ⌘⇧M"),
        h("li", {}, Account.isLocalMode ? "Синхронизация между компьютерами включится, когда появится сервер" : "Синхронизация с сервером включена"),
      ]),
      this.taButton("Начать", "primary", () => this.accountClose()),
    ]);
  },

  accountLogin() {
    const { Account } = this.accountMod();
    const email = this.taField("Адрес почты", { type: "text", autocomplete: "username", spellcheck: "false", placeholder: "имя", autocapitalize: "off", value: Account.email ? Account.email.split("@")[0] : "" }, { suffix: `@${Account.domain}` });
    const pass = this.taField("Пароль", { type: "password", autocomplete: "current-password" });
    return this.taForm({
      title: "Вход",
      fields: [email.wrap, pass.wrap],
      okLabel: "Войти",
      back: Account.firstRunDone ? null : () => this.accountRender("welcome"),
      onOk: async () => {
        const r = await Account.login(email.input.value, pass.input.value);
        this.notice(`Вы вошли как ${r.email}`);
        this.accountClose();
      },
      links: [
        this.taLink("Забыли пароль? Ключ восстановления", () => this.accountRender("forgot")),
        this.taLink("Создать аккаунт", () => this.accountRender("register")),
      ],
    });
  },

  accountChange() {
    const { Account } = this.accountMod();
    const old = this.taField("Текущий пароль", { type: "password", autocomplete: "current-password" });
    const pw = this.taPasswordPair("Новый пароль");
    return this.taForm({
      title: "Сменить пароль",
      text: "Пароль аккаунта и мастер-пароль сейфа меняются вместе. На других компьютерах потребуется войти заново.",
      fields: [old.wrap, ...pw.nodes],
      okLabel: "Сменить пароль",
      onOk: async () => {
        await Account.changePassword(old.input.value, pw.read());
        this.notice("Пароль изменён");
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
      kids.push(this.wButton("Выйти из аккаунта", "ghost", async () => {
        await Account.logout();
        this.notice("Вы вышли из аккаунта. Сейф остаётся на этом компьютере.");
      }));
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
});
