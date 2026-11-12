/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Окна аккаунта Tabora: первый запуск, регистрация, вход, смена и сброс пароля, список
 * аккаунтов этого компьютера. Диалог живёт поверх окна браузера (#tabora-account-dialog),
 * шаги рисуются chrome-DOM. Карточка аккаунта показывается в разделе «Коды».
 *
 * Аккаунт и профиль браузера связаны один к одному (account/Profiles.sys.mjs): ещё один
 * аккаунт — это ещё одно окно со своим профилем, данные между ними не передаются. Кошелёк,
 * коды и почта открываются только после входа (accountGateView).
 * Подключается из tabora.js после vault.js. */

Object.assign(Tabora, {
  _accountMod: null,
  account: { el: null, step: null, after: null },

  accountMod() {
    if (!this._accountMod) {
      this._accountMod = ChromeUtils.importESModule("chrome://tabora/content/account/Account.sys.mjs");
      const topic = this._accountMod.Account.TOPIC;
      // вход и выход меняют то, что показывают разделы аккаунта: коды и кошелёк
      const observer = () => this.drawerDirty("codes", "wallet");
      Services.obs.addObserver(observer, topic);
      window.addEventListener("unload", () => Services.obs.removeObserver(observer, topic), { once: true });
    }
    return this._accountMod;
  },

  profilesMod() {
    return ChromeUtils.importESModule("chrome://tabora/content/account/Profiles.sys.mjs");
  },

  /** Первый запуск: окно приветствия, пока аккаунт не создан и пользователь не отказался.
   * В профиле, добавленном для ещё одного аккаунта, окно открывается на шаге, с которого
   * его попросили начать (Profiles.pending). */
  initAccount() {
    const { Profiles } = this.profilesMod();
    Profiles.start();
    this.initSync();
    // ответы поддержки: счётчик в меню аккаунта, сверка раз в несколько минут
    setTimeout(() => this.supportPoll(), 12000);
    setInterval(() => this.supportPoll(), 5 * 60 * 1000);
    setTimeout(async () => {
      try {
        const { Account } = this.accountMod();
        await Account.ready();
        if (!Account.firstRunDone && !Account.signedIn && window === Services.wm.getMostRecentBrowserWindow()) {
          const pending = await Profiles.pending().catch(() => null);
          this.accountDialog(pending?.step || "welcome", { name: pending?.name || "" });
        }
      } catch (e) {
        console.error("Tabora account init", e);
      }
    }, 1500);
  },

  /** Есть ли ответы поддержки: { count, staff, queue }. Новый ответ — уведомление в окне. */
  async supportPoll() {
    const { Account } = this.accountMod();
    try {
      await Account.ready();
      if (!Account.signedIn || Account.isLocalMode || Account.needsServerLink) {
        this.account.support = null;
        return;
      }
      const r = await Account.supportUnread();
      const before = this.account.support;
      this.account.support = { count: Number(r.count) || 0, staff: !!r.staff, queue: Number(r.queue) || 0 };
      if (before && window === Services.wm.getMostRecentBrowserWindow()) {
        if (this.account.support.count > before.count) {
          this.notice(tt`Поддержка Tabora ответила на ваше обращение`);
        } else if (this.account.support.staff && this.account.support.queue > before.queue) {
          this.notice(tt`Новое обращение в очереди поддержки`);
        }
      }
      this.renderAccountButton?.();
    } catch (e) {
      // сервер ещё не знает об обращениях или недоступен: счётчика просто нет
    }
  },

  /** Синхронизация: модуль один на процесс. Окно обновляет своё, когда сверка принесла
   * пространства или ярлыки стартовой страницы с другого компьютера. */
  initSync() {
    try {
      ChromeUtils.importESModule("chrome://tabora/content/sync/Sync.sys.mjs").Sync.start();
      const applied = (subject, topic, what) => {
        if (what === "spaces") {
          this.syncSpaces();
        } else if (what === "start") {
          const dial = document.getElementById("tabora-start-dial");
          if (dial) {
            dial.dataset.filledAt = "0";
            this.fillDial();
          }
        }
      };
      Services.obs.addObserver(applied, "tabora-sync-applied");
      window.addEventListener("unload", () => Services.obs.removeObserver(applied, "tabora-sync-applied"), { once: true });
    } catch (e) {
      console.error("Tabora sync init", e);
    }
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
    this.accountPairStop(); // показанный код входа на телефоне больше не действует
    Account.cancelLogin(); // сервер уже впустил, а сейф не открыли: такая сессия не нужна
  },

  accountRender(step, opts = {}) {
    const card = this.account.el.querySelector(".ta-card");
    if (step !== "pair" && step !== "pair-confirm") {
      this.accountPairStop(); // окно занято другим шагом: показанный код входа больше не ждём
    }
    this.account.step = step;
    const builders = {
      welcome: this.accountWelcome, register: this.accountRegister, recovery: this.accountRecovery, done: this.accountDone, login: this.accountLogin, change: this.accountChange, link: this.accountLink,
      accounts: this.accountAccounts, remove: this.accountRemove,
      vault: this.accountVault, forgot: this.accountForgot, "forgot-key": this.accountForgotKey, "forgot-mail": this.accountForgotMail,
      twofa: this.accountTwoFactor, "twofa-scan": this.accountTwoFactorScan, "twofa-off": this.accountTwoFactorOff, "twofa-codes": this.accountTwoFactorCodes, codes: this.accountBackupCodes,
      bemail: this.accountBackupEmail, "bemail-code": this.accountBackupEmailCode, "bemail-off": this.accountBackupEmailOff,
      pair: this.accountPair, "pair-confirm": this.accountPairConfirm,
    };
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
  taPasswordPair(label = tt`Пароль`, { withRepeat = true } = {}) {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { passwordStrength, Account } = this.accountMod();
    const pass = this.taField(label, { type: "password", autocomplete: "new-password", placeholder: tt`не короче ${Account.MIN_PASSWORD} символов` });
    const meter = h("div", { class: "ta-meter", "data-score": "0" }, null, [0, 1, 2, 3].map(() => h("i")));
    const meterText = h("span", { class: "ta-meter-text" }, "");
    pass.wrap.append(h("div", { class: "ta-meter-row" }, null, [meter, meterText]));
    pass.input.addEventListener("input", () => {
      const s = passwordStrength(pass.input.value);
      meter.dataset.score = String(s.score);
      meterText.textContent = pass.input.value ? (s.score < 2 ? tt`${s.label} · не подойдёт` : s.label) : "";
    });
    const again = withRepeat ? this.taField(tt`Повторите пароль`, { type: "password", autocomplete: "new-password" }) : null;
    const read = () => {
      const a = pass.input.value;
      if (again && a !== again.input.value) {
        throw new Error(tt`Пароли не совпадают`);
      }
      return a;
    };
    return { pass, again, read, nodes: [pass.wrap, again?.wrap].filter(Boolean) };
  },

  taForm({ title, text, fields, okLabel, busyLabel = tt`Подождите`, onOk, links = [], back = null, danger = false }) {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { Account } = this.accountMod();
    const err = h("div", { class: "ta-error", hidden: "true" });
    const status = h("p", { class: "ta-progress", role: "status", "aria-live": "polite", hidden: "true" });
    const ok = this.taButton(okLabel, danger ? "danger" : "primary", async () => {
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
        status.textContent = tt`Это занимает несколько секунд: пароль проверяется с защитой от подбора.`;
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
        err.classList.toggle("note", !!e.note); // note — следующий шаг, а не ошибка
        err.hidden = false;
      }
    });
    const form = h("div", { class: "ta-step" }, null, [
      back ? this.taLink(tt`← Назад`, back) : null,
      h("div", { class: "ta-brand" }, null, [this.markSvg("ta-mark"), h("span", {}, "Tabora"), h("i", {}, tt`аккаунт`)]),
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
    const skip = this.taLink(tt`Не сейчас`, () => this.accountClose());
    const others = this.accountOthers().length ? h("div", { class: "ta-links" }, null, [this.taLink(tt`Аккаунты на этом компьютере`, () => this.accountShowAccounts({ back: "welcome" }))]) : null;
    return h("div", { class: "ta-step ta-welcome" }, null, [
      h("div", { class: "ta-brand" }, null, [this.markSvg("ta-mark"), h("span", {}, "Tabora"), h("i", {}, tt`аккаунт`)]),
      h("h2", {}, tt`Почта, сейф и перенос на другой компьютер`),
      h("ul", { class: "ta-list" }, null, [
        row(["M3.5 6.5h17v11h-17z", "M3.5 7l8.5 6 8.5-6"], tt`имя@${Account.domain}`, tt`Свой адрес и алиасы для регистраций`),
        row(["M7 11V8a5 5 0 0 1 10 0v3", "M5 11h14v10H5z"], tt`Сейф`, tt`Пароли и коды входа шифруются на этом компьютере`),
        row(["M4 7h11v9H4z", "M9 20h11v-9", "M15 11h5"], tt`Перенос`, tt`Вход на новом компьютере возвращает всё на место`),
      ]),
      h("p", { class: "ta-hint" }, tt`Один пароль на всё. Он не покидает компьютер, восстановить его можно только вашим ключом восстановления. Кошелёк, коды и почта открываются после входа.`),
      h("div", { class: "ta-foot" }, null, [
        this.taButton(tt`Создать аккаунт`, "primary", () => this.accountRender("register")),
        this.taButton(tt`Войти`, "ghost", () => this.accountRender("login")),
        skip,
      ]),
      others,
    ].filter(Boolean));
  },

  accountRegister(opts = {}) {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { Account } = this.accountMod();
    const { Vault } = this.vaultMod();
    if (Account.email) {
      // профиль уже принадлежит аккаунту: ещё один создаётся в своём профиле
      return this.accountAccounts({ list: this.account.profiles || [], back: "login" });
    }
    const name = this.taField(tt`Адрес почты`, { type: "text", autocomplete: "off", spellcheck: "false", placeholder: tt`имя`, autocapitalize: "off", value: opts.name || "" }, { suffix: `@${Account.domain}` });
    const pw = this.taPasswordPair(Vault.exists && Vault.hasPassword ? tt`Пароль (мастер-пароль сейфа)` : tt`Пароль`);
    const fields = [name.wrap, ...pw.nodes];
    if (Vault.exists && Vault.hasPassword) {
      fields.push(h("p", { class: "ta-hint" }, tt`В этом профиле уже есть сейф с мастер-паролем. Пароль аккаунта должен быть тем же: он откроет и сейф, и аккаунт.`));
    } else {
      fields.push(h("p", { class: "ta-hint" }, tt`Один пароль для почты и сейфа. Сервер получает только его хеш для входа, сам пароль не покидает компьютер, поэтому забытый пароль восстанавливается только ключом восстановления, который вы получите на следующем шаге.`));
    }
    return this.taForm({
      title: tt`Создать аккаунт`,
      fields,
      okLabel: tt`Создать аккаунт`,
      busyLabel: tt`Создаём аккаунт`,
      back: () => this.accountRender("welcome"),
      onOk: async () => {
        const password = pw.read();
        const r = await Account.register(name.input.value, password);
        this.accountRender("recovery", { email: r.email, key: r.recoveryKey });
      },
      links: [this.taLink(tt`Уже есть аккаунт? Войти`, () => this.accountRender("login"))],
    });
  },

  /** Ключ восстановления: после регистрации, после перехода сейфа на пароль аккаунта
   * (rebound) или после смены пароля со сменой ключа сейфа (rotated). Показывается один раз. */
  accountRecovery({ email, key = null, rebound = false, rotated = false, fresh = false }) {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const pre = h("pre", { class: "ta-secret", masked: "true" }, key || tt`Ключ не создан: создайте его в разделе «Коды» → «Сейф»`);
    const reveal = this.taButton(tt`Показать`, "ghost small", () => {
      pre.toggleAttribute("masked");
      reveal.textContent = pre.hasAttribute("masked") ? tt`Показать` : tt`Скрыть`;
    });
    const copy = this.taButton(tt`Скопировать`, "ghost small", () => {
      if (key) {
        this.copyWithExpiry(key, 60000);
        this.notice(tt`Ключ скопирован · буфер очистится через минуту`);
      }
    });
    copy.disabled = !key;
    const check = h("input", { type: "checkbox", id: "ta-rk-saved" });
    const finish = () => {
      if (rebound || rotated || fresh) {
        const after = this.account.after;
        this.accountClose();
        this.account.after = after;
        this.accountAfter();
      } else {
        this.accountRender("done", { email });
      }
    };
    const next = this.taButton(tt`Продолжить`, "primary", finish);
    next.disabled = !!key;
    check.addEventListener("change", () => { next.disabled = !check.checked; });
    const text = fresh
      ? tt`Создан новый пустой сейф под паролем аккаунта. Прежний остался на диске зашифрованным прежним паролем. Запишите ключ восстановления нового сейфа и храните отдельно от компьютера: он показывается один раз.`
      : rebound
      ? tt`Сейф этого профиля теперь открывается паролем аккаунта ${email}: ключ шифрования заменён, данные перешифрованы. Прежний пароль и прежний ключ восстановления больше не действуют. Запишите новый ключ и храните отдельно от компьютера: он показывается один раз.`
      : rotated
        ? tt`Ключ шифрования сейфа заменён, данные перешифрованы. Прежний ключ восстановления больше не действует. Запишите новый и храните отдельно от компьютера: он показывается один раз.`
        : tt`Если вы забудете пароль, только этот ключ откроет сейф и аккаунт. Запишите его и храните отдельно от компьютера: он показывается один раз.`;
    return h("div", { class: "ta-step" }, null, [
      h("h2", {}, rebound || rotated || fresh ? tt`Новый ключ восстановления` : tt`Ключ восстановления`),
      h("p", { class: "ta-text" }, text),
      pre,
      h("div", { class: "ta-actions row" }, null, [reveal, copy]),
      key ? h("label", { class: "ta-check" }, null, [check, h("span", {}, tt`Я записал ключ в надёжное место`)]) : null,
      next,
    ].filter(Boolean));
  },

  accountDone({ email }) {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { Account } = this.accountMod();
    return h("div", { class: "ta-step" }, null, [
      h("div", { class: "ta-orb" }, null, [this.markSvg("ta-mark")]),
      h("h2", {}, tt`Готово`),
      h("p", { class: "ta-text" }, Account.isLocalMode ? tt`Аккаунт ${email || Account.email} создан на этом компьютере.` : tt`Аккаунт ${email || Account.email} создан. Почта на этом адресе уже принимает письма.`),
      h("ul", { class: "ta-points" }, null, [
        h("li", {}, tt`Сейф открыт, пароли сайтов шифруются его ключом`),
        h("li", {}, tt`Раздел «Коды» для двухфакторной защиты: ⌘⇧K`),
        h("li", {}, tt`Кошелёк: ⌘⇧W, почта и алиасы: ⌘⇧M`),
        h("li", {}, Account.isLocalMode ? tt`Вход с других компьютеров появится, когда аккаунт подключат к серверу` : tt`С другого компьютера входите тем же адресом и паролем`),
      ]),
      this.taButton(tt`Начать`, "primary", () => {
        const after = this.account.after;
        this.accountClose();
        this.account.after = after;
        this.accountAfter();
      }),
    ]);
  },

  accountLogin(opts = {}) {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { Account } = this.accountMod();
    // профиль принадлежит аккаунту: войти здесь можно только в него, адрес не меняется
    const own = Account.email;
    const email = own ? null : this.taField(tt`Адрес почты`, { type: "text", autocomplete: "username", spellcheck: "false", placeholder: tt`имя`, autocapitalize: "off", value: opts.name || "" }, { suffix: `@${Account.domain}` });
    const who = own ? h("div", { class: "ta-field" }, null, [h("span", {}, tt`Аккаунт`), h("div", { class: "ta-static" }, null, [this.accountAvatar(own), h("b", {}, own)])]) : email.wrap;
    const pass = this.taField(tt`Пароль`, { type: "password", autocomplete: "current-password" });
    const code = this.taCodeField();
    code.wrap.hidden = true;
    return this.taForm({
      title: tt`Вход`,
      fields: [who, pass.wrap, code.wrap],
      okLabel: tt`Войти`,
      busyLabel: tt`Входим`,
      back: Account.firstRunDone ? null : () => this.accountRender("welcome"),
      onOk: async () => {
        const address = own || email.input.value;
        const password = pass.input.value;
        let r;
        try {
          r = await Account.login(address, password, { totp: code.wrap.hidden ? "" : code.input.value });
        } catch (e) {
          if (e.code === "vault-mismatch") {
            // сервер пароль принял, а сейф этого профиля под прежним: выбираем, чем его открыть
            this.accountRender("vault", { email: address, password });
            return;
          }
          throw this.taSecondFactor(e, code);
        }
        this.accountLoggedIn(r);
      },
      links: [
        this.taLink(tt`Забыли пароль?`, () => this.accountRender("forgot")),
        own ? this.taLink(tt`Другой аккаунт`, () => this.accountShowAccounts({ back: "login" })) : this.taLink(tt`Создать аккаунт`, () => this.accountRender("register")),
      ],
    });
  },

  /** Поле кода двухфакторной защиты: шесть цифр из приложения или резервный код. */
  taCodeField(label = tt`Код двухфакторной защиты`) {
    return this.taField(label, { type: "text", autocomplete: "one-time-code", spellcheck: "false", autocapitalize: "off", placeholder: tt`6 цифр из приложения или резервный код` });
  },

  /** Ответ сервера «нужен код» превращает форму в следующий шаг: поле кода появляется, вместо
   * ошибки — подсказка. Возвращает ошибку, которую форма покажет. */
  taSecondFactor(e, code) {
    if (e.code !== "2fa-required" && e.code !== "bad-2fa") {
      return e;
    }
    const first = code.wrap.hidden;
    code.wrap.hidden = false;
    setTimeout(() => (first ? code.input.focus() : code.input.select()), 0);
    return e.code === "2fa-required" ? Object.assign(new Error(tt`У аккаунта включена двухфакторная защита. Введите код из приложения на телефоне или резервный код`), { note: true }) : e;
  },

  /** Вход выполнен: сообщить, показать новый ключ восстановления, если сейф его получил, и
   * продолжить то, ради чего входили. */
  accountLoggedIn(r) {
    this.notice(tt`Вы вошли как ${r.email}`);
    if (r.rebound || r.fresh) {
      this.accountRender("recovery", { email: r.email, key: r.recoveryKey, rebound: r.rebound, fresh: r.fresh });
      return;
    }
    const after = this.account.after;
    this.accountClose();
    this.account.after = after;
    this.accountAfter();
  },

  /** Сервер принял пароль аккаунта, а сейф этого профиля зашифрован прежним (пароль сменили на
   * другом компьютере или сбросили по письму). Способы открыть его: проверка системы, прежний
   * пароль, ключ восстановления; если нет ничего — пустой сейф, прежний остаётся на диске. */
  accountVault({ email, password }) {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { Account } = this.accountMod();
    const { Vault } = this.vaultMod();
    const options = [
      Vault.hasOsKey && Vault.osUnlockEnabled ? ["os", tt`Проверка системы`, tt`Touch ID или пароль этого Mac`] : null,
      ["password", tt`Прежний пароль`, tt`Если вы его помните`],
      Vault.hasRecoveryKey ? ["recovery", tt`Ключ восстановления`, tt`Записанный при настройке сейфа`] : null,
      ["fresh", tt`Пустой сейф`, tt`Если открыть прежний нечем`],
    ].filter(Boolean);
    let choice = options[0][0];
    const oldPass = this.taField(tt`Прежний пароль`, { type: "password", autocomplete: "off" });
    const key = this.taField(tt`Ключ восстановления`, { type: "text", autocomplete: "off", spellcheck: "false", placeholder: "XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" });
    const sure = h("input", { type: "checkbox" });
    const fresh = h("div", { class: "ta-option-body" }, null, [
      h("p", { class: "ta-hint" }, tt`Пароли сайтов и коды входа этого профиля останутся на диске зашифрованными прежним паролем, но в новом сейфе их не будет. Кошелёк со своим паролем останется.`),
      h("label", { class: "ta-check" }, null, [sure, h("span", {}, tt`Я понимаю, что начну с пустого сейфа`)]),
    ]);
    const bodies = { password: oldPass.wrap, recovery: key.wrap, fresh };
    const list = h("div", { class: "ta-options", role: "radiogroup", "aria-label": tt`Как открыть сейф` });
    const pick = (id, focus = true) => {
      choice = id;
      for (const b of list.children) {
        b.setAttribute("aria-checked", String(b.dataset.id === id));
      }
      for (const [k, node] of Object.entries(bodies)) {
        node.hidden = k !== id;
      }
      if (focus) {
        bodies[id]?.querySelector("input")?.focus();
      }
    };
    for (const [id, title, sub] of options) {
      const b = h("button", { class: "ta-option", type: "button", role: "radio", "data-id": id }, null, [h("i", { class: "ta-radio" }), h("span", {}, null, [h("b", {}, title), h("em", {}, sub)])]);
      b.addEventListener("click", () => pick(id));
      list.append(b);
    }
    pick(choice, false);
    return this.taForm({
      title: tt`Сейф под прежним паролем`,
      text: tt`Пароль аккаунта принят, но сейф этого профиля зашифрован прежним паролем: сервер его ключа не знает. Выберите, чем открыть сейф; дальше он будет открываться новым паролем.`,
      fields: [list, oldPass.wrap, key.wrap, fresh],
      okLabel: tt`Открыть сейф и войти`,
      busyLabel: tt`Открываем сейф`,
      back: () => {
        Account.cancelLogin();
        this.accountRender("login");
      },
      onOk: async () => {
        let opts;
        if (choice === "password") {
          if (!oldPass.input.value) {
            throw new Error(tt`Введите прежний пароль`);
          }
          opts = { vaultPassword: oldPass.input.value };
        } else if (choice === "recovery") {
          if (!key.input.value.trim()) {
            throw new Error(tt`Введите ключ восстановления`);
          }
          opts = { vaultOpen: { via: "recovery", key: key.input.value } };
        } else if (choice === "fresh") {
          if (!sure.checked) {
            throw new Error(tt`Отметьте, что понимаете последствия`);
          }
          opts = { vaultOpen: { via: "fresh" } };
        } else {
          opts = { vaultOpen: { via: "os" } };
        }
        this.accountLoggedIn(await Account.login(email, password, opts));
      },
    });
  },

  /* ---- Аккаунты этого компьютера ------------------------------------------------------
   * У каждого аккаунта свой профиль браузера и своё окно. Список — из Profiles; открыть
   * аккаунт значит поднять окно его профиля или запустить ещё один экземпляр браузера. */

  /** Свежий список аккаунтов компьютера (текущий первым); заодно обновляет запомненный. */
  async accountProfiles() {
    try {
      this.account.profiles = await this.profilesMod().Profiles.list();
    } catch (e) {
      console.error("Tabora account: список аккаунтов не прочитан", e);
      this.account.profiles ||= [];
    }
    return this.account.profiles;
  },

  /** Другие аккаунты компьютера из запомненного списка: для разметки, которая строится сразу.
   * Профиль, где аккаунт ещё не создали, в списки не попадает: его продолжает «Добавить
   * аккаунт», а убрать можно в настройках. */
  accountOthers(list = this.account.profiles || []) {
    return list.filter(p => !p.current && !p.fresh);
  },

  /** fresh — профиль добавили, но аккаунт в нём ещё не создали; без адреса и без этой
   * отметки — профиль, в котором от аккаунта отказались. */
  accountLabel(p) {
    return p.email || (p.fresh ? tt`Новый аккаунт` : tt`Профиль без аккаунта`);
  },

  accountStateText(p) {
    return p.email ? (p.signedIn ? tt`вход выполнен` : tt`выход выполнен`) : p.fresh ? tt`аккаунт ещё не создан` : tt`аккаунта нет`;
  },

  async accountShowAccounts({ back = null } = {}) {
    const list = await this.accountProfiles();
    if (this.account.el && !this.account.el.hidden) {
      this.accountRender("accounts", { list, back });
    } else {
      this.accountDialog("accounts", { list, back });
    }
  },

  accountAccounts({ list = [], back = null } = {}) {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { Account } = this.accountMod();
    const rows = this.accountOthers(list).map(p => {
      const row = h("button", { class: "ta-account", type: "button" }, null, [
        this.accountAvatar(p.email, { color: p.color, empty: !p.email }),
        h("span", { class: "ta-account-id" }, null, [h("b", {}, this.accountLabel(p)), h("i", {}, this.accountStateText(p))]),
        this.svg(["m9 6 6 6-6 6"], 14, 2),
      ]);
      row.addEventListener("click", () => {
        this.accountClose();
        this.accountOpen(p);
      });
      return row;
    });
    const own = Account.email;
    return this.taForm({
      title: tt`Аккаунты на этом компьютере`,
      text: tt`У каждого аккаунта свой профиль браузера: свои вкладки, история, сейф, кошелёк и почта. Между аккаунтами ничего не передаётся.`,
      fields: [rows.length ? h("div", { class: "ta-accounts" }, null, rows) : h("p", { class: "ta-hint" }, tt`Других аккаунтов на этом компьютере пока нет.`)],
      okLabel: own ? tt`Добавить аккаунт` : tt`Создать аккаунт`,
      busyLabel: tt`Открываем`,
      back: back ? () => this.accountRender(back) : null,
      onOk: async () => {
        if (!own) {
          this.accountRender("register");
          return;
        }
        if (await this.accountAdd()) {
          this.accountClose();
        }
      },
    });
  },

  /** Удаление с компьютера профиля другого аккаунта. Сам аккаунт на сервере остаётся. */
  accountRemove({ profile }) {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const check = h("input", { type: "checkbox" });
    return this.taForm({
      title: profile.email ? tt`Удалить аккаунт с этого компьютера` : tt`Удалить профиль`,
      text: profile.email
        ? tt`Профиль аккаунта ${profile.email} будет удалён с этого компьютера вместе с вкладками, историей, паролями, кодами входа и кошельком. Вернуть их будет нельзя. Сам аккаунт и почта на сервере останутся: в него можно войти снова.`
        : tt`Профиль, в котором аккаунт так и не создали, будет удалён с этого компьютера.`,
      fields: profile.email
        ? [
            h("p", { class: "ta-hint" }, tt`Если в кошельке этого профиля есть средства, сначала сохраните его фразу восстановления: без неё доступ к ним пропадёт.`),
            h("label", { class: "ta-check" }, null, [check, h("span", {}, tt`Я понимаю, что данные этого профиля удаляются безвозвратно`)]),
          ]
        : [],
      okLabel: tt`Удалить с компьютера`,
      busyLabel: tt`Удаляем`,
      danger: true,
      onOk: async () => {
        if (profile.email && !check.checked) {
          throw new Error(tt`Отметьте, что понимаете последствия`);
        }
        await this.profilesMod().Profiles.remove(profile.dir);
        this.notice(profile.email ? tt`Аккаунт ${profile.email} удалён с этого компьютера` : tt`Профиль удалён`);
        this.accountClose();
      },
    });
  },

  /** Открыть окно другого аккаунта: поднять уже запущенное или запустить. */
  async accountOpen(p) {
    try {
      await this.profilesMod().Profiles.open(p.dir);
    } catch (e) {
      this.notice(e.message || tt`Не удалось открыть аккаунт`);
      this.accountProfiles();
    }
  },

  /** Ещё один аккаунт: новый профиль и новое окно, где его создают или входят в существующий.
   * Возвращает true, если окно запрошено. */
  async accountAdd({ step = "welcome", name = "" } = {}) {
    if (Date.now() - (this.account.addedAt || 0) < 3000) {
      return true; // повторный щелчок, пока окно открывается
    }
    this.account.addedAt = Date.now();
    try {
      const { Profiles } = this.profilesMod();
      const dir = await Profiles.create({ step, name });
      await Profiles.open(dir);
      this.notice(tt`Новый аккаунт открывается в отдельном окне`);
      this.accountProfiles();
      return true;
    } catch (e) {
      this.account.addedAt = 0;
      this.notice(tt`Не удалось добавить аккаунт: ${e.message || e}`);
      return false;
    }
  },

  /** Кошелёк, коды и почта принадлежат аккаунту: без входа раздел ящика показывает это
   * приглашение вместо своего содержимого. kind — "wallet" | "codes". */
  accountGateView(kind) {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { Account } = this.accountMod();
    const own = Account.email;
    const title = kind === "wallet" ? tt`Кошелёк откроется после входа` : tt`Коды откроются после входа`;
    const text = own
      ? tt`Вы вышли из аккаунта ${own}. Кошелёк, коды, пароли и почта этого профиля закрыты, пока вы не войдёте снова.`
      : tt`Кошелёк, коды и почта — часть аккаунта Tabora. Создайте аккаунт или войдите, чтобы ими пользоваться.`;
    return h("div", { class: "w-locked" }, null, [
      h("div", { class: "w-lock-mark" }, null, [this.wIcon(["M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M4.5 20c1.4-3.3 4.2-5 7.5-5s6.1 1.7 7.5 5"], 22, 1.8)]),
      h("b", {}, title),
      h("p", { class: "w-sub" }, text),
      own ? this.wButton(tt`Войти`, "primary", () => this.accountDialog("login")) : this.wButton(tt`Создать аккаунт`, "primary", () => this.accountDialog("register")),
      own ? null : this.wButton(tt`Войти`, "ghost", () => this.accountDialog("login")),
    ].filter(Boolean));
  },

  /** Аккаунт создан на этом компьютере без сервера: подключаем его под тем же адресом. */
  accountLink() {
    const { Account } = this.accountMod();
    const pass = this.taField(tt`Пароль аккаунта`, { type: "password", autocomplete: "current-password" });
    return this.taForm({
      title: tt`Подключить аккаунт к серверу`,
      text: tt`Аккаунт ${Account.email} пока есть только на этом компьютере. После подключения на этот адрес начнут приходить письма, а войти можно будет и с другого компьютера. Сервер получит только хеш пароля для входа: сам пароль и ключ сейфа остаются здесь.`,
      fields: [pass.wrap],
      okLabel: tt`Подключить`,
      busyLabel: tt`Подключаем`,
      onOk: async () => {
        const r = await Account.linkToServer(pass.input.value);
        this.notice(r.created ? tt`Аккаунт подключён: ящик ${r.email} работает` : tt`Вы вошли как ${r.email}`);
        const after = this.account.after;
        this.accountClose();
        if (r.recoveryOffServer) {
          // прежний ключ восстановления сервер не знает: сразу предлагаем создать новый
          this.vaultRecoveryCreateSheet();
          return;
        }
        this.account.after = after;
        this.accountAfter();
      },
    });
  },

  accountChange() {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { Account } = this.accountMod();
    const old = this.taField(tt`Текущий пароль`, { type: "password", autocomplete: "current-password" });
    const pw = this.taPasswordPair(tt`Новый пароль`);
    const rotate = h("input", { type: "checkbox" });
    return this.taForm({
      title: tt`Сменить пароль`,
      text: tt`Пароль аккаунта и мастер-пароль сейфа меняются вместе. На других компьютерах потребуется войти заново.`,
      fields: [old.wrap, ...pw.nodes, h("label", { class: "ta-check" }, null, [rotate, h("span", {}, tt`Сменить и ключ шифрования сейфа: если пароль мог узнать кто-то ещё. Ключ восстановления тоже заменится`)])],
      okLabel: tt`Сменить пароль`,
      busyLabel: tt`Меняем пароль`,
      onOk: async () => {
        const r = await Account.changePassword(old.input.value, pw.read(), { rotate: rotate.checked });
        this.notice(r.complete === false ? tt`Пароль изменён; часть данных перешифруется при следующей разблокировке` : tt`Пароль изменён`);
        if (r.recoveryKey) {
          this.accountRender("recovery", { email: Account.email, key: r.recoveryKey, rotated: true });
          return;
        }
        this.accountClose();
      },
    });
  },

  /** Забытый пароль: ключ восстановления возвращает и аккаунт, и сейф; письмо на резервный
   * адрес — только аккаунт и почту (сервер ключа сейфа не знает). */
  accountForgot() {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { Account } = this.accountMod();
    const way = (step, icon, title, sub) => {
      const row = h("button", { class: "ta-account", type: "button" }, null, [
        h("span", { class: "ta-way-icon" }, null, [this.svg(icon, 16, 1.8)]),
        h("span", { class: "ta-account-id" }, null, [h("b", {}, title), h("i", {}, sub)]),
        this.svg(["m9 6 6 6-6 6"], 14, 2),
      ]);
      row.addEventListener("click", () => this.accountRender(step));
      return row;
    };
    const mail = !Account.isLocalMode && !Account.needsServerLink;
    return h("div", { class: "ta-step" }, null, [
      this.taLink(tt`← Назад`, () => this.accountRender("login")),
      h("div", { class: "ta-brand" }, null, [this.markSvg("ta-mark"), h("span", {}, "Tabora"), h("i", {}, tt`аккаунт`)]),
      h("h2", {}, tt`Восстановление доступа`),
      h("p", { class: "ta-text" }, tt`Пароль знаете только вы: сервер хранит лишь его хеш для входа. Вернуть доступ можно двумя способами.`),
      h("div", { class: "ta-accounts" }, null, [
        way("forgot-key", ["M7.5 20a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9z", "m10.7 12.3 9.3-9.3", "m16 7 3 3", "m13.5 9.5 2 2"], tt`Ключ восстановления`, tt`Вернёт и аккаунт, и сейф с паролями и кодами`),
        mail ? way("forgot-mail", ["M3.5 6.5h17v11h-17z", "M3.5 7l8.5 6 8.5-6"], tt`Письмо на резервный адрес`, tt`Вернёт аккаунт и почту; сейф откроется отдельно`) : null,
      ].filter(Boolean)),
    ]);
  },

  accountForgotKey() {
    const { Account } = this.accountMod();
    const { Vault } = this.vaultMod();
    const key = this.taField(tt`Ключ восстановления`, { type: "text", autocomplete: "off", spellcheck: "false", placeholder: "XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" });
    const pw = this.taPasswordPair(tt`Новый пароль`);
    return this.taForm({
      title: tt`Ключ восстановления`,
      text: Vault.hasRecoveryKey ? tt`Введите ключ восстановления, записанный при настройке, и задайте новый пароль.` : tt`Для этого сейфа ключ восстановления не создавался: без пароля данные не восстановить.`,
      fields: [key.wrap, ...pw.nodes],
      okLabel: tt`Задать новый пароль`,
      busyLabel: tt`Задаём новый пароль`,
      back: () => this.accountRender("forgot"),
      onOk: async () => {
        const password = pw.read();
        let off = false;
        if (Account.email) {
          off = (await Account.resetPasswordWithRecovery(key.input.value, password))?.twoFactorDisabled;
        } else {
          await Vault.unlockWithRecoveryKey(key.input.value);
          await Vault.setPassword(password);
        }
        this.notice(off ? tt`Новый пароль задан. Двухфакторная защита выключена: включите её заново в настройках аккаунта` : tt`Новый пароль задан`);
        this.accountClose();
      },
    });
  },

  /** Сброс по письму: сначала запрос кода, затем код и новый пароль. Сервер отвечает одинаково,
   * есть у аккаунта резервный адрес или нет, поэтому второй шаг показывается всегда. */
  accountForgotMail({ email = "" } = {}) {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { Account } = this.accountMod();
    const own = Account.email;
    if (!email) {
      const name = own ? null : this.taField(tt`Адрес почты`, { type: "text", autocomplete: "username", spellcheck: "false", placeholder: tt`имя`, autocapitalize: "off" }, { suffix: `@${Account.domain}` });
      return this.taForm({
        title: tt`Письмо на резервный адрес`,
        text: tt`${own ? tt`На резервный адрес аккаунта ${own}` : tt`На резервный адрес аккаунта`} придёт код. Он вернёт аккаунт и почту. Сейф этого профиля останется под прежним паролем: его откроет проверка системы или ключ восстановления.`,
        fields: name ? [name.wrap] : [],
        okLabel: tt`Отправить код`,
        busyLabel: tt`Отправляем`,
        back: () => this.accountRender("forgot"),
        onOk: async () => {
          const r = await Account.resetByEmailStart(own || name.input.value);
          this.accountRender("forgot-mail", { email: r.email });
        },
      });
    }
    const mailCode = this.taField(tt`Код из письма`, { type: "text", autocomplete: "off", inputmode: "numeric", spellcheck: "false", placeholder: tt`8 цифр` });
    const pw = this.taPasswordPair(tt`Новый пароль`);
    const code = this.taCodeField();
    code.wrap.hidden = true;
    let changed = false; // пароль на сервере уже сменён: дальше остаётся только вход
    const again = this.taLink(tt`Отправить код ещё раз`, async () => {
      again.disabled = true;
      try {
        await Account.resetByEmailStart(email);
        this.notice(tt`Код отправлен ещё раз. В сутки сервер отправляет не больше трёх писем`);
      } catch (e) {
        this.notice(e.message);
      }
      setTimeout(() => (again.disabled = false), 15000);
    });
    return this.taForm({
      title: tt`Код из письма`,
      text: tt`Если у аккаунта ${email} есть подтверждённый резервный адрес, на него отправлено письмо с кодом. Код действует 30 минут.`,
      fields: [mailCode.wrap, ...pw.nodes, code.wrap],
      okLabel: tt`Сменить пароль и войти`,
      busyLabel: tt`Меняем пароль`,
      back: () => this.accountRender("forgot-mail"),
      links: [again],
      onOk: async () => {
        const password = pw.read();
        if (!changed) {
          try {
            await Account.resetByEmailConfirm(email, mailCode.input.value, password, { totp: code.wrap.hidden ? "" : code.input.value });
          } catch (e) {
            throw this.taSecondFactor(e, code);
          }
          changed = true;
        }
        try {
          this.accountLoggedIn(await Account.login(email, password, { totp: code.wrap.hidden ? "" : code.input.value }));
        } catch (e) {
          if (e.code === "vault-mismatch") {
            this.accountRender("vault", { email, password });
            return;
          }
          throw this.taSecondFactor(e, code);
        }
      },
    });
  },

  /* ---- Двухфакторная защита входа -----------------------------------------------------
   * Секрет живёт в приложении кодов на телефоне, а не в «Кодах» Tabora: те открываются только
   * после входа. Резервные коды показываются один раз. */

  /** QR-код как SVG: тёмные модули на белом поле с положенным отступом в четыре модуля. */
  accountQr(text, size = 168, label = tt`QR-код для приложения кодов`) {
    const NS = "http://www.w3.org/2000/svg";
    const modules = this.qrModules(text);
    const quiet = 4;
    let d = "";
    modules.forEach((row, y) => row.forEach((dark, x) => (d += dark ? `M${x + quiet} ${y + quiet}h1v1h-1z` : "")));
    const svg = document.createElementNS(NS, "svg");
    const side = modules.length + quiet * 2;
    for (const [k, v] of Object.entries({ viewBox: `0 0 ${side} ${side}`, width: size, height: size, class: "ta-qr", role: "img", "aria-label": label, "shape-rendering": "crispEdges" })) {
      svg.setAttribute(k, v);
    }
    const bg = document.createElementNS(NS, "rect");
    bg.setAttribute("width", side);
    bg.setAttribute("height", side);
    bg.setAttribute("fill", "#fff");
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "#000");
    svg.append(bg, path);
    return svg;
  },

  accountTwoFactor() {
    const { Account } = this.accountMod();
    const pass = this.taField(tt`Пароль аккаунта`, { type: "password", autocomplete: "current-password" });
    return this.taForm({
      title: tt`Двухфакторная защита`,
      text: tt`При входе в аккаунт, кроме пароля, понадобится код из приложения на телефоне. Понадобится приложение для кодов: Google Authenticator, Aegis, 2FAS или похожее.`,
      fields: [pass.wrap],
      okLabel: tt`Продолжить`,
      busyLabel: tt`Проверяем пароль`,
      onOk: async () => {
        const r = await Account.twoFactorSetup(pass.input.value);
        this.accountRender("twofa-scan", r);
      },
    });
  },

  accountTwoFactorScan({ secret, uri }) {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { Account } = this.accountMod();
    const code = this.taField(tt`Код из приложения`, { type: "text", autocomplete: "off", inputmode: "numeric", spellcheck: "false", placeholder: tt`6 цифр` });
    const text = h("code", { class: "ta-key" }, secret.replace(/(.{4})/g, "$1 ").trim());
    const copy = this.taButton(tt`Скопировать`, "ghost small", () => {
      this.copyWithExpiry(secret, 60000);
      this.notice(tt`Секрет скопирован · буфер очистится через минуту`);
    });
    return this.taForm({
      title: tt`Добавьте аккаунт в приложение`,
      text: tt`Отсканируйте код приложением на телефоне или введите секрет вручную, затем впишите код, который оно покажет.`,
      fields: [
        h("div", { class: "ta-scan" }, null, [this.accountQr(uri), h("div", { class: "ta-scan-side" }, null, [h("span", {}, tt`Секрет`), text, copy])]),
        h("p", { class: "ta-hint" }, tt`Держите этот секрет не только в «Кодах» Tabora: они открываются после входа, а код нужен до него.`),
        code.wrap,
      ],
      okLabel: tt`Включить защиту`,
      busyLabel: tt`Включаем`,
      back: () => this.accountRender("twofa"),
      onOk: async () => {
        const r = await Account.twoFactorEnable(code.input.value);
        this.notice(tt`Двухфакторная защита включена`);
        this.accountRender("codes", { codes: r.backupCodes });
      },
    });
  },

  /* ---- Вход на телефоне по QR-коду ----------------------------------------------------
   * Компьютер показывает код, телефон считывает его и входит без пароля. Человек сверяет шесть
   * цифр на двух экранах и разрешает вход здесь: считать код с чужого экрана мало. */

  accountPairStop() {
    const offer = this.account.pair;
    this.account.pair = null;
    offer?.cancel();
  },

  accountPair() {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { Account } = this.accountMod();
    this.accountPairStop();
    const box = h("div", { class: "ta-pair-box" });
    const note = h("p", { class: "ta-hint" });
    const waiting = text => box.replaceChildren(h("span", { class: "ta-spinner", "aria-hidden": "true" }), h("span", {}, text));
    const failed = e => {
      note.textContent = "";
      box.replaceChildren(
        h("p", { class: "ta-error" }, e.code === "pair-gone" ? tt`Код устарел: он действует три минуты.` : e.message || String(e)),
        this.taButton(tt`Показать новый код`, "primary", show)
      );
    };
    const show = async () => {
      waiting(tt`Готовим код…`);
      let offer = null;
      try {
        offer = await Account.pairOffer();
        if (this.account.step !== "pair" || !box.isConnected) {
          offer.cancel();
          return;
        }
        this.accountPairStop();
        this.account.pair = offer;
        box.replaceChildren(this.accountQr(offer.link, 216, tt`QR-код для входа на телефоне`));
        note.textContent = tt`Код действует три минуты и подходит один раз. Не показывайте его посторонним и не отправляйте снимком.`;
        const seen = await offer.joined();
        if (this.account.pair === offer) {
          this.accountRender("pair-confirm", { offer, seen });
        }
      } catch (e) {
        if (e.code !== "pair-cancelled" && (!offer || this.account.pair === offer) && box.isConnected) {
          this.account.pair = null;
          failed(e);
        }
      }
    };
    show();
    return h("div", { class: "ta-step ta-pair" }, null, [
      h("div", { class: "ta-brand" }, null, [this.markSvg("ta-mark"), h("span", {}, "Tabora"), h("i", {}, tt`аккаунт`)]),
      h("h2", {}, tt`Вход на телефоне`),
      h("p", { class: "ta-text" }, tt`Откройте Tabora на телефоне: «Настройки → Аккаунт Tabora → Войти по QR-коду» и наведите камеру на этот код. Пароль вводить не придётся.`),
      box,
      note,
      this.taButton(tt`Закрыть`, "ghost", () => this.accountClose()),
    ]);
  },

  /** Код считан: сверка шести цифр и разрешение входа. */
  accountPairConfirm({ offer, seen }) {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { Account } = this.accountMod();
    const err = h("div", { class: "ta-error", hidden: "true" });
    const done = () => {
      if (this.account.pair === offer) {
        this.account.pair = null; // обмен завершён: при закрытии окна отменять нечего
      }
    };
    const allow = this.taButton(tt`Разрешить вход`, "primary", async () => {
      allow.disabled = deny.disabled = true;
      err.hidden = true;
      try {
        await seen.approve();
        done();
        this.accountClose();
        this.notice(tt`Вход разрешён: «${seen.deviceName}» появится в списке устройств`);
        setTimeout(() => Account.devicesChanged(), 6000);
      } catch (e) {
        allow.disabled = deny.disabled = false;
        err.textContent = e.code === "pair-gone" ? tt`Код устарел: он действует три минуты. Покажите новый.` : e.message || String(e);
        err.hidden = false;
      }
    });
    const deny = this.taButton(tt`Отклонить`, "ghost", async () => {
      allow.disabled = deny.disabled = true;
      await seen.deny();
      done();
      this.accountClose();
      this.notice(tt`Вход отклонён`);
    });
    return h("div", { class: "ta-step ta-pair" }, null, [
      h("div", { class: "ta-brand" }, null, [this.markSvg("ta-mark"), h("span", {}, "Tabora"), h("i", {}, tt`аккаунт`)]),
      h("h2", {}, tt`Разрешить вход?`),
      h("p", { class: "ta-text" }, tt`В аккаунт хочет войти устройство «${seen.deviceName}». На его экране должен быть этот же код.`),
      h("div", { class: "ta-pair-code", role: "img", "aria-label": tt`Код сверки: ${seen.code.split("").join(" ")}` }, null, [h("span", {}, seen.code.slice(0, 3)), h("span", {}, seen.code.slice(3))]),
      h("p", { class: "ta-hint" }, tt`Если на телефоне кода нет или он другой — отклоните: код считал кто-то ещё. Устройство получит доступ к почте, паролям и кодам входа аккаунта.`),
      err,
      allow,
      deny,
    ]);
  },

  /** Резервные коды: показываются один раз, каждый подходит один раз. */
  accountBackupCodes({ codes = [] }) {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const list = h("div", { class: "ta-codes" }, null, codes.map(c => h("code", {}, c)));
    const copy = this.taButton(tt`Скопировать`, "ghost small", () => {
      this.copyWithExpiry(codes.join("\n"), 60000);
      this.notice(tt`Коды скопированы · буфер очистится через минуту`);
    });
    const check = h("input", { type: "checkbox" });
    const done = this.taButton(tt`Готово`, "primary", () => this.accountClose());
    done.disabled = true;
    check.addEventListener("change", () => (done.disabled = !check.checked));
    return h("div", { class: "ta-step" }, null, [
      h("h2", {}, tt`Резервные коды`),
      h("p", { class: "ta-text" }, tt`Каждый код один раз заменяет код из приложения, если телефона нет под рукой. Сохраните их отдельно от компьютера: они показываются только сейчас.`),
      list,
      h("div", { class: "ta-actions row" }, null, [copy]),
      h("label", { class: "ta-check" }, null, [check, h("span", {}, tt`Я сохранил коды в надёжном месте`)]),
      done,
    ]);
  },

  accountTwoFactorOff() {
    const { Account } = this.accountMod();
    const pass = this.taField(tt`Пароль аккаунта`, { type: "password", autocomplete: "current-password" });
    const code = this.taCodeField();
    return this.taForm({
      title: tt`Выключить двухфакторную защиту`,
      text: tt`После этого для входа в аккаунт снова будет достаточно пароля. Резервные коды перестанут действовать.`,
      fields: [pass.wrap, code.wrap],
      okLabel: tt`Выключить защиту`,
      busyLabel: tt`Выключаем`,
      danger: true,
      onOk: async () => {
        await Account.twoFactorDisable(pass.input.value, code.input.value);
        this.notice(tt`Двухфакторная защита выключена`);
        this.accountClose();
      },
    });
  },

  accountTwoFactorCodes() {
    const { Account } = this.accountMod();
    const pass = this.taField(tt`Пароль аккаунта`, { type: "password", autocomplete: "current-password" });
    const code = this.taCodeField();
    return this.taForm({
      title: tt`Новые резервные коды`,
      text: tt`Прежние резервные коды перестанут действовать. Нужен пароль и код из приложения или один из прежних резервных кодов.`,
      fields: [pass.wrap, code.wrap],
      okLabel: tt`Создать коды`,
      busyLabel: tt`Создаём`,
      onOk: async () => {
        const r = await Account.twoFactorCodes(pass.input.value, code.input.value);
        this.accountRender("codes", { codes: r.backupCodes });
      },
    });
  },

  /* ---- Резервный адрес ------------------------------------------------------------------
   * На него приходит код для сброса забытого пароля. Адрес становится резервным только после
   * подтверждения кодом из письма. twoFactor — у аккаунта включена двухфакторная защита:
   * перемены требуют ещё и её код. */

  accountBackupEmail({ twoFactor = false } = {}) {
    const { Account } = this.accountMod();
    const address = this.taField(tt`Резервный адрес`, { type: "email", autocomplete: "off", spellcheck: "false", autocapitalize: "off", placeholder: tt`вы@другая-почта.com` });
    const pass = this.taField(tt`Пароль аккаунта`, { type: "password", autocomplete: "current-password" });
    const code = this.taCodeField();
    code.wrap.hidden = !twoFactor;
    return this.taForm({
      title: tt`Резервный адрес`,
      text: tt`На этот адрес придёт код, если вы забудете пароль. Укажите ящик в другой почтовой службе, к которому у вас есть доступ. Тот, кто получит этот ящик, сможет сбросить пароль аккаунта: включите вместе с ним двухфакторную защиту.`,
      fields: [address.wrap, pass.wrap, code.wrap],
      okLabel: tt`Отправить код`,
      busyLabel: tt`Отправляем`,
      onOk: async () => {
        let r;
        try {
          r = await Account.backupEmailSet(pass.input.value, address.input.value, code.wrap.hidden ? "" : code.input.value);
        } catch (e) {
          throw this.taSecondFactor(e, code);
        }
        this.accountRender("bemail-code", { address: r.pending.address, twoFactor });
      },
    });
  },

  accountBackupEmailCode({ address, twoFactor = false }) {
    const { Account } = this.accountMod();
    const code = this.taField(tt`Код из письма`, { type: "text", autocomplete: "off", inputmode: "numeric", spellcheck: "false", placeholder: tt`6 цифр` });
    return this.taForm({
      title: tt`Подтвердите адрес`,
      text: tt`На ${address} отправлено письмо с кодом. Он действует 30 минут.`,
      fields: [code.wrap],
      okLabel: tt`Подтвердить`,
      busyLabel: tt`Проверяем`,
      onOk: async () => {
        const r = await Account.backupEmailVerify(code.input.value);
        this.notice(tt`Резервный адрес подтверждён: ${r.address}`);
        this.accountClose();
      },
      links: [this.taLink(tt`Указать другой адрес`, () => this.accountRender("bemail", { twoFactor }))],
    });
  },

  accountBackupEmailOff({ address = "", twoFactor = false } = {}) {
    const { Account } = this.accountMod();
    const pass = this.taField(tt`Пароль аккаунта`, { type: "password", autocomplete: "current-password" });
    const code = this.taCodeField();
    code.wrap.hidden = !twoFactor;
    return this.taForm({
      title: tt`Удалить резервный адрес`,
      text: tt`${address ? tt`Адрес ${address}` : tt`Адрес`} перестанет быть резервным. Забытый пароль после этого вернёт только ключ восстановления.`,
      fields: [pass.wrap, code.wrap],
      okLabel: tt`Удалить адрес`,
      busyLabel: tt`Удаляем`,
      danger: true,
      onOk: async () => {
        try {
          await Account.backupEmailRemove(pass.input.value, code.wrap.hidden ? "" : code.input.value);
        } catch (e) {
          throw this.taSecondFactor(e, code);
        }
        this.notice(tt`Резервный адрес удалён`);
        this.accountClose();
      },
    });
  },

  /* ---- Выход и меню аккаунта --------------------------------------------------- */

  /** Выйти из аккаунта: кошелёк, коды, пароли и почта закрываются до следующего входа. */
  async accountLogout({ thenLogin = true } = {}) {
    const { Account } = this.accountMod();
    await Account.logout();
    for (const t of gBrowser.tabs.filter(t => this.isMailUrl(t.linkedBrowser?.currentURI?.spec))) {
      if (gBrowser.tabs.length > 1) {
        gBrowser.removeTab(t);
      } else {
        t.linkedBrowser.loadURI(Services.io.newURI("about:newtab"), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      }
    }
    this.notice(tt`Вы вышли из аккаунта. Кошелёк, коды, пароли и почта закрыты до следующего входа.`);
    if (thenLogin) {
      this.accountDialog("login");
    }
  },

  /** Пункты меню аккаунта для правого клика по «Почта и алиасы» и для страницы почты. */
  accountMenuItems() {
    const { Account } = this.accountMod();
    const items = [{ label: tt`Открыть почту`, icon: ["M3.5 6.5h17v11h-17z", "M3.5 7l8.5 6 8.5-6"], run: () => this.openMail() }, { separator: true }];
    if (Account.signedIn) {
      items.push(
        { label: Account.email, disabled: true, run: () => {} },
        { label: tt`Сменить пароль`, icon: ["M7 11V8a5 5 0 0 1 10 0v3", "M5 11h14v10H5z"], run: () => this.accountDialog("change") },
        { label: tt`Выйти из аккаунта`, icon: ["M10 17l5-5-5-5", "M15 12H3", "M21 4v16"], run: () => this.accountLogout() },
        { label: tt`Добавить аккаунт`, icon: ["M12 5v14", "M5 12h14"], run: () => this.accountAdd() }
      );
    } else {
      items.push(
        { label: tt`Войти`, icon: ["M14 7l5 5-5 5", "M19 12H9", "M3 4v16"], run: () => this.accountDialog("login") },
        Account.email
          ? { label: tt`Другой аккаунт`, icon: ["M12 5v14", "M5 12h14"], run: () => this.accountShowAccounts() }
          : { label: tt`Создать аккаунт`, icon: ["M12 5v14", "M5 12h14"], run: () => this.accountDialog("register") }
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
      kids.push(row(tt`Аккаунт`, Account.email));
      const offline = Account.isLocalMode || Account.needsServerLink;
      kids.push(row(tt`Сервер`, offline ? tt`аккаунт есть только на этом компьютере` : tt`вход и почта через ${new URL(Account.serverUrl).host}; пароли и коды остаются на этом компьютере`, offline ? "muted" : ""));
      kids.push(this.wButton(tt`Сменить пароль`, "ghost", () => this.accountDialog("change")));
      kids.push(this.wButton(tt`Выйти из аккаунта`, "ghost", () => this.accountLogout({ thenLogin: false })));
      kids.push(this.wButton(tt`Добавить аккаунт`, "ghost", () => this.accountAdd()));
    } else {
      kids.push(row(tt`Аккаунт`, Account.email ? tt`${Account.email} · выход выполнен` : tt`не создан`, "muted"));
      kids.push(h("p", { class: "w-hint" }, tt`Кошелёк, коды и почта открываются после входа в аккаунт.`));
      kids.push(h("div", { class: "w-actions" }, null, [
        this.wButton(Account.email ? tt`Войти` : tt`Создать аккаунт`, "primary small", () => this.accountDialog(Account.email ? "login" : "register")),
        this.wButton(Account.email ? tt`Другой аккаунт` : tt`Войти`, "ghost small", () => (Account.email ? this.accountShowAccounts() : this.accountDialog("login"))),
      ]));
    }
    const brief = Account.signedIn ? Account.email : Account.email ? tt`выход выполнен` : tt`нет аккаунта`;
    const summary = h("summary", { class: "v-card-head" }, null, [h("b", { class: "w-group-title" }, tt`Аккаунт`), h("span", { class: "v-card-sub" }, brief), this.svg(["m6 9 6 6 6-6"], 14, 2.2)]);
    const card = h("details", { class: "w-group v-card" }, null, [summary, h("div", { class: "v-card-body" }, null, kids)]);
    card.open = Services.prefs.getBoolPref("tabora.account.cardOpen", false);
    card.addEventListener("toggle", () => Services.prefs.setBoolPref("tabora.account.cardOpen", card.open));
    return card;
  },

  /* ---- Кнопка аккаунта в правом верхнем углу ------------------------------------------
   * Без входа — «Войти». После входа — кружок с первой буквой и имя до @; точка на кружке:
   * зелёная — всё в порядке, жёлтая — нужно действие (нет ключа восстановления или его пора
   * обновить), серая — сейф заблокирован. Щелчок после входа открывает меню аккаунта: его
   * настройки, остальные аккаунты этого компьютера и «Добавить аккаунт». */

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
      return { level: "locked", text: tt`сейф заблокирован` };
    }
    if (Account.needsServerLink) {
      return { level: "warn", text: tt`не подключён к серверу` };
    }
    if (!Vault.recoveryKeyCreatedAt) {
      return { level: "warn", text: tt`нет ключа восстановления` };
    }
    if (Account.data?.recoveryOffServer) {
      return { level: "warn", text: tt`нужен новый ключ восстановления` };
    }
    if (Account.recoveryNeedsUpgrade) {
      return { level: "warn", text: tt`ключ восстановления пора обновить` };
    }
    return { level: "ok", text: tt`всё в порядке` };
  },

  /** color — цвет другого аккаунта (из его карточки); empty — аккаунта в профиле ещё нет. */
  accountAvatar(email, { size = "", color = "", empty = false } = {}) {
    const letter = empty ? "+" : (email || "?").trim().charAt(0).toUpperCase() || "?";
    const el = this.html("span", { class: `ta-avatar ${size}${empty ? " empty" : ""}`.trim(), "aria-hidden": "true" }, letter);
    if (!empty) {
      el.style.setProperty("--avatar", this.AVATAR_COLORS.includes(color) ? color : this.accountAvatarColor());
    }
    return el;
  },

  buildAccountButton() {
    const btn = this.html("button", { id: "tabora-account-btn", type: "button" });
    btn.addEventListener("click", () => this.accountButtonClick());
    btn.addEventListener("contextmenu", e => {
      e.preventDefault();
      this.accountMenu();
    });
    this.account.button = btn;
    const refresh = () => this.renderAccountButton();
    // список аккаунтов компьютера меняют и другие окна: освежаем, когда это окно становится активным
    const profiles = () => this.accountProfiles();
    Services.obs.addObserver(refresh, this.accountMod().Account.TOPIC);
    Services.obs.addObserver(refresh, this.vaultMod().Vault.TOPIC);
    Services.obs.addObserver(profiles, this.profilesMod().Profiles.TOPIC);
    window.addEventListener("activate", profiles);
    window.addEventListener("unload", () => {
      Services.obs.removeObserver(refresh, this.accountMod().Account.TOPIC);
      Services.obs.removeObserver(refresh, this.vaultMod().Vault.TOPIC);
      Services.obs.removeObserver(profiles, this.profilesMod().Profiles.TOPIC);
    }, { once: true });
    profiles();
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
      btn.setAttribute("aria-label", tt`Аккаунт ${Account.email}, ${status.text}`);
      btn.dataset.state = "in";
    } else {
      btn.replaceChildren(this.svg(["M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M4.5 20c1.4-3.3 4.2-5 7.5-5s6.1 1.7 7.5 5"], 15, 1.9), this.html("span", { class: "name" }, tt`Войти`));
      btn.title = Account.email ? tt`Войти в аккаунт ${Account.email}` : tt`Войти или создать аккаунт Tabora`;
      btn.setAttribute("aria-label", btn.title);
      btn.dataset.state = "out";
    }
  },

  accountButtonClick() {
    const { Account } = this.accountMod();
    if (!Account.signedIn) {
      this.accountDialog(Account.email ? "login" : "welcome");
    } else if (!this.menuJustClosed("account")) {
      this.accountMenu(); // щелчок по кнопке при открытом меню только закрывает его
    }
  },

  /** Меню аккаунта под кнопкой: правый край меню по правому краю кнопки. */
  async accountMenu() {
    const list = await this.accountProfiles();
    const r = this.account.button.getBoundingClientRect();
    this.showMenu(this.accountQuickItems(list), r.right, r.bottom + 6, { end: true, owner: "account" });
  },

  /** Пункты меню аккаунта: текущий аккаунт, остальные аккаунты компьютера, добавление. */
  accountQuickItems(list = this.account.profiles || []) {
    const { Account } = this.accountMod();
    const { Vault } = this.vaultMod();
    const plus = ["M12 5v14", "M5 12h14"];
    const others = this.accountOthers(list).map(p => ({
      label: this.accountLabel(p),
      avatar: { email: p.email, color: p.color, empty: !p.email },
      run: () => this.accountOpen(p),
    }));
    const items = [];
    if (Account.signedIn) {
      items.push(
        { label: Account.email, avatar: { email: Account.email }, caption: true },
        { label: tt`Настройки аккаунта`, icon: ["M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M4.5 20c1.4-3.3 4.2-5 7.5-5s6.1 1.7 7.5 5"], run: () => this.openAccountPage() },
        {
          label: tt`Поддержка`,
          icon: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M9.5 9.5a2.5 2.5 0 1 1 3.4 2.3c-.6.3-.9.8-.9 1.4v.3", "M12 16.5h.01"],
          note: this.account.support?.count
            ? `${this.account.support.count} ${this.plural(this.account.support.count, tt`ответ|ответа|ответов`)}`
            : this.account.support?.staff && this.account.support.queue
              ? tt`в очереди ${this.account.support.queue}`
              : "",
          run: () => this.openAccountPage("support"),
        },
        Vault.unlocked
          ? { label: tt`Заблокировать сейф`, icon: ["M7 11V8a5 5 0 0 1 10 0v3", "M5 11h14v10H5z"], run: () => this.accountLockVault() }
          : { label: tt`Разблокировать сейф`, icon: ["M7 11V8a5 5 0 0 1 9.6-2", "M5 11h14v10H5z"], run: () => this.vaultUnlockByUser() },
        { label: tt`Выйти из аккаунта`, icon: ["M10 17l5-5-5-5", "M15 12H3", "M21 4v16"], run: () => this.accountLogout() }
      );
    } else if (Account.email) {
      items.push({ label: Account.email, avatar: { email: Account.email }, note: tt`выход выполнен`, caption: true }, { label: tt`Войти`, icon: ["M14 7l5 5-5 5", "M19 12H9", "M3 4v16"], run: () => this.accountDialog("login") });
    } else {
      items.push({ label: tt`Создать аккаунт`, icon: plus, run: () => this.accountDialog("register") }, { label: tt`Войти`, icon: ["M14 7l5 5-5 5", "M19 12H9", "M3 4v16"], run: () => this.accountDialog("login") });
    }
    if (others.length || Account.email) {
      items.push({ separator: true });
    }
    if (others.length) {
      items.push({ header: tt`Другие аккаунты` }, ...others);
    }
    if (Account.email) {
      // в профиле без аккаунта добавлять нечего: аккаунт создаётся прямо в нём
      items.push({ label: tt`Добавить аккаунт`, icon: plus, run: () => this.accountAdd() });
    }
    if (others.length && Account.signedIn) {
      items.push({ label: tt`Управление аккаунтами`, icon: ["M4 7h10", "M18 7h2", "M4 17h2", "M10 17h10", "M16 5v4", "M8 15v4"], run: () => this.openAccountPage("accounts") });
    }
    return items;
  },

  accountLockVault() {
    const { Vault } = this.vaultMod();
    Vault.lock();
    this.notice(Vault.lockPending ? tt`Сейф заблокируется, как только закончится текущая операция с ключом` : tt`Сейф заблокирован: пароли сайтов и коды закрыты до проверки`);
  },

  /* ---- Раздел «Аккаунт» в настройках ------------------------------------------------------
   * Профиль аккаунта — раздел страницы настроек (account/pane.js, about:preferences#sync),
   * с горизонтальными вкладками. Чувствительные действия он не дублирует: зовёт те же окна и
   * листы оболочки. */

  /** tab — вкладка раздела: profile, security, sync, data, accounts, exit. */
  openAccountPage(tab = "") {
    openPreferences(tab && tab !== "profile" ? `sync-${tab}` : "paneSync");
  },

  /** Пароли из файла CSV: разбор и запись делает штатный модуль Firefox, хранилище — сейф. */
  accountImportPasswords() {
    const { Vault } = this.vaultMod();
    if (!Vault.unlocked) {
      this.notice(tt`Сначала разблокируйте сейф`);
      return;
    }
    const fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    fp.init(window.browsingContext, tt`Импорт паролей`, Ci.nsIFilePicker.modeOpen);
    fp.appendFilter(tt`Таблица паролей`, "*.csv; *.tsv");
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
        this.notice(tt`Пароли: добавлено ${added}, обновлено ${changed}${skipped ? tt`, без изменений или с ошибкой ${skipped}` : ""}`);
      } catch (e) {
        this.notice(tt`Не удалось прочитать файл: ${e.message}`);
      }
    });
  },

  /** Пароли в файл CSV: только после проверки владельца, файл не зашифрован. */
  accountExportPasswords() {
    this.vaultOwnerCheck(tt`Сохранить пароли в файл`, async () => {
      const fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
      fp.init(window.browsingContext, tt`Сохранить пароли`, Ci.nsIFilePicker.modeSave);
      fp.appendFilter(tt`Таблица паролей`, "*.csv");
      fp.defaultString = "tabora-passwords.csv";
      fp.defaultExtension = "csv";
      fp.open(async rv => {
        if ((rv !== Ci.nsIFilePicker.returnOK && rv !== Ci.nsIFilePicker.returnReplace) || !fp.file) {
          return;
        }
        try {
          const { LoginExport } = ChromeUtils.importESModule("resource://gre/modules/LoginExport.sys.mjs");
          await LoginExport.exportAsCSV(fp.file.path);
          this.notice(tt`Пароли сохранены. Файл не зашифрован: удалите его после переноса.`);
        } catch (e) {
          this.notice(tt`Не удалось сохранить файл: ${e.message}`);
        }
      });
    });
  },
});

