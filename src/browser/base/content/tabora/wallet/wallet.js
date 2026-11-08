/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Панель кошелька в ящике: онбординг (фраза, пароль, проверка слов), блокировка,
 * кошельки и адреса, балансы по сетям, узлы, резервная фраза. Вся разметка — chrome-DOM,
 * веб-страницам недоступна. Подключается из tabora.js после drawer.js. */

Object.assign(Tabora, {
  _walletMod: null,
  wallet: { view: "main", flow: null, balances: {}, prices: {}, loading: false, hideTimer: null },

  walletStore() {
    if (!this._walletMod) {
      this._walletMod = ChromeUtils.importESModule("chrome://browser/content/tabora/wallet/WalletStore.sys.mjs");
      Services.obs.addObserver(() => this.drawerDirty("wallet"), this._walletMod.WalletStore.TOPIC);
      window.addEventListener("blur", () => this.walletHideSecrets());
    }
    return this._walletMod;
  },

  walletHideSecrets() {
    const el = this.drawer.body?.querySelector(".w-phrase");
    if (el) {
      el.setAttribute("masked", "true");
    }
  },

  shortAddr(a) {
    return a && a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a || "";
  },

  wIcon(paths, size = 15, stroke = 2) {
    return this.svg(paths, size, stroke);
  },

  wButton(label, cls, onClick, attrs = {}) {
    const b = this.html("button", { class: `w-btn ${cls || ""}`.trim(), type: "button", ...attrs }, label);
    b.addEventListener("click", onClick);
    return b;
  },

  wField(label, attrs = {}) {
    const input = this.html("input", { class: "w-input", ...attrs });
    const wrap = this.html("label", { class: "w-field" }, null, [this.html("span", {}, label), input]);
    return { wrap, input };
  },

  wError(text) {
    return this.html("div", { class: "w-error", role: "alert" }, text);
  },

  wAppend(parent, ...nodes) {
    parent.append(...nodes.filter(Boolean));
    return parent;
  },

  /* ---- Раздел ящика ---------------------------------------------------- */

  async drawer_wallet(seq) {
    const d = this.drawer;
    const { WalletStore } = this.walletStore();
    await WalletStore.ready();
    if (seq !== d.seq) {
      return;
    }
    const w = this.wallet;
    let node;
    if (w.flow) {
      node = this.walletFlowView();
    } else if (!WalletStore.exists) {
      node = this.walletWelcomeView();
    } else if (!WalletStore.unlocked) {
      if (WalletStore.passwordless) {
        try {
          await WalletStore.unlock("");
        } catch (e) {}
      }
      node = WalletStore.unlocked ? this.walletMainView() : this.walletLockedView();
    } else if (w.view === "settings") {
      node = this.walletSettingsView();
    } else if (w.view === "receive") {
      node = this.walletReceiveView();
    } else {
      node = this.walletMainView();
    }
    d.body.replaceChildren(node);
    if (WalletStore.exists && WalletStore.unlocked && !w.flow && w.view === "main") {
      this.walletLoadBalances(seq);
    }
  },

  walletGo(view) {
    this.wallet.view = view;
    this.renderDrawer();
  },

  /* ---- Приветствие ------------------------------------------------------- */

  walletWelcomeView() {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const create = this.wButton("Создать кошелёк", "primary", () => this.walletStartFlow("create"));
    const imp = this.wButton("Импортировать фразу", "", () => this.walletStartFlow("import"));
    return h("div", { class: "w-welcome" }, null, [
      h("div", { class: "w-orb" }),
      h("b", {}, "Кошелёк Tabora"),
      h("p", {}, "Одна seed-фраза, сети Ethereum и L2, Bitcoin, Solana и TRON. Ключи только на этом устройстве, зашифрованы вашим паролем."),
      h("div", { class: "w-actions" }, null, [create, imp]),
      h("ul", { class: "w-points" }, null, [
        h("li", {}, "Фраза шифруется Argon2id + AES-256, никуда не отправляется"),
        h("li", {}, "Подпись и отправка только после подтверждения и пароля"),
        h("li", {}, "Публичные ноды на ваш выбор, без привязки к сервисам"),
      ]),
    ]);
  },

  /* ---- Онбординг: шаги -------------------------------------------------- */

  walletStartFlow(kind, opts = {}) {
    const { WalletStore } = this.walletStore();
    this.wallet.flow = {
      kind, // create | import | add-create | add-import
      step: WalletStore.exists ? (kind.endsWith("import") ? "phrase" : "words") : "password",
      password: "",
      passwordless: false,
      words: kind.endsWith("create") ? WalletStore.generateMnemonic(12).split(" ") : [],
      imported: "",
      quiz: null,
      error: "",
      name: opts.name || "",
    };
    if (kind === "add-create" || kind === "add-import") {
      this.wallet.flow.step = kind === "add-create" ? "words" : "phrase";
    }
    this.renderDrawer();
  },

  walletFlowView() {
    const f = this.wallet.flow;
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { WalletStore } = this.walletStore();
    const steps = f.kind.startsWith("add") ? ["words/phrase", "done"] : ["password", f.kind === "create" ? "words" : "phrase", "done"];
    const back = this.wButton("Отмена", "ghost small", () => {
      this.wallet.flow = null;
      this.renderDrawer();
    });
    const head = h("div", { class: "w-flow-head" }, null, [
      h("b", {}, { password: "Пароль кошелька", words: "Резервная фраза", quiz: "Проверка фразы", phrase: "Введите фразу", nopass: "Без пароля?" }[f.step] || ""),
      back,
    ]);
    const body = h("div", { class: "w-flow-body" });
    const err = f.error ? this.wError(f.error) : null;

    if (f.step === "password") {
      const p1 = this.wField("Пароль", { type: "password", autocomplete: "new-password", placeholder: "не короче 8 символов" });
      const p2 = this.wField("Ещё раз", { type: "password", autocomplete: "new-password" });
      const meter = h("div", { class: "w-meter" }, null, [h("span"), h("span"), h("span"), h("span")]);
      const score = v => Math.min(4, (v.length >= 8) + (v.length >= 12) + /[A-ZА-Я]/.test(v) + /\d/.test(v) + /[^\w\s]/.test(v));
      p1.input.addEventListener("input", () => meter.setAttribute("level", String(score(p1.input.value))));
      const next = this.wButton("Продолжить", "primary", () => {
        const v = p1.input.value;
        if (v.length < 8) {
          f.error = "Пароль короче 8 символов";
        } else if (v !== p2.input.value) {
          f.error = "Пароли не совпадают";
        } else {
          f.password = v;
          f.passwordless = false;
          f.error = "";
          f.step = f.kind === "create" ? "words" : "phrase";
        }
        this.renderDrawer();
      });
      const nopass = h("button", { class: "w-link", type: "button" }, "Продолжить без пароля");
      nopass.addEventListener("click", () => {
        f.step = "nopass";
        f.error = "";
        this.renderDrawer();
      });
      this.wAppend(body, 
        h("p", { class: "w-sub" }, "Пароль нужен для разблокировки и для каждой подписи. Он не восстанавливается: без него доступ только по резервной фразе."),
        p1.wrap, p2.wrap, meter, err, next, nopass
      );
      setTimeout(() => p1.input.focus(), 50);
    } else if (f.step === "nopass") {
      const agree = h("input", { type: "checkbox", id: "w-nopass-agree" });
      const go = this.wButton("Понимаю риск, продолжить", "danger", () => {
        if (!agree.checked) {
          f.error = "Подтвердите, что понимаете риск";
          this.renderDrawer();
          return;
        }
        f.password = "";
        f.passwordless = true;
        f.error = "";
        f.step = f.kind === "create" ? "words" : "phrase";
        this.renderDrawer();
      });
      go.disabled = true;
      agree.addEventListener("change", () => (go.disabled = !agree.checked));
      this.wAppend(body, 
        h("div", { class: "w-warn" }, null, [
          h("b", {}, "Крайне не рекомендуем"),
          h("p", {}, "Без пароля любой, кто откроет этот профиль браузера, сможет подписывать транзакции и увидеть фразу. Ключ будет лежать в менеджере паролей Firefox. Кошелёк будет постоянно помечен как незащищённый."),
        ]),
        h("label", { class: "w-check" }, null, [agree, h("span", {}, "Я понимаю, что средства могут быть украдены")]),
        err, go,
        this.wButton("Вернуться к паролю", "ghost", () => {
          f.step = "password";
          f.error = "";
          this.renderDrawer();
        })
      );
    } else if (f.step === "words") {
      const grid = h("ol", { class: "w-phrase", masked: "true" }, null, f.words.map((w, i) => h("li", {}, null, [h("i", {}, String(i + 1)), h("span", {}, w)])));
      const reveal = this.wButton("Показать фразу", "ghost", () => {
        grid.toggleAttribute("masked");
        reveal.textContent = grid.hasAttribute("masked") ? "Показать фразу" : "Скрыть";
        clearTimeout(this.wallet.hideTimer);
        if (!grid.hasAttribute("masked")) {
          this.wallet.hideTimer = setTimeout(() => grid.setAttribute("masked", "true"), 60000);
        }
      });
      grid.addEventListener("copy", e => e.preventDefault());
      const count = h("div", { class: "w-seg" }, null, [12, 24].map(n => {
        const b = h("button", { type: "button", "aria-pressed": String(f.words.length === n) }, `${n} слов`);
        b.addEventListener("click", () => {
          f.words = WalletStore.generateMnemonic(n).split(" ");
          this.renderDrawer();
        });
        return b;
      }));
      const next = this.wButton("Я записал фразу", "primary", () => {
        const idx = [];
        while (idx.length < 3) {
          const i = Math.floor(Math.random() * f.words.length);
          if (!idx.includes(i)) {
            idx.push(i);
          }
        }
        idx.sort((a, b) => a - b);
        f.quiz = { idx, answers: {} };
        f.error = "";
        f.step = "quiz";
        this.renderDrawer();
      });
      this.wAppend(body, 
        h("p", { class: "w-sub" }, "Запишите слова по порядку и храните офлайн. Это единственный способ восстановить кошелёк. Никому не показывайте, Tabora никогда её не спросит."),
        count, grid, reveal, err, next
      );
    } else if (f.step === "quiz") {
      const list = WalletStore.wordlist();
      const rows = f.quiz.idx.map(i => {
        const correct = f.words[i];
        const options = new Set([correct]);
        while (options.size < 4) {
          options.add(list[Math.floor(Math.random() * list.length)]);
        }
        const opts = [...options].sort();
        const row = h("div", { class: "w-quiz" }, null, [h("b", {}, `Слово №${i + 1}`), h("div", { class: "w-quiz-opts" }, null, opts.map(o => {
          const b = h("button", { type: "button", "aria-pressed": String(f.quiz.answers[i] === o) }, o);
          b.addEventListener("click", () => {
            f.quiz.answers[i] = o;
            row.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
          });
          return b;
        }))]);
        return row;
      });
      const next = this.wButton("Подтвердить", "primary", async () => {
        const ok = f.quiz.idx.every(i => f.quiz.answers[i] === f.words[i]);
        if (!ok) {
          f.error = "Есть ошибки: проверьте запись";
          this.renderDrawer();
          return;
        }
        await this.walletFinish(f.words.join(" "));
      });
      this.wAppend(body, h("p", { class: "w-sub" }, "Выберите нужные слова из записанной фразы."), ...rows, err, next, this.wButton("Назад к фразе", "ghost", () => {
        f.step = "words";
        f.error = "";
        this.renderDrawer();
      }));
    } else if (f.step === "phrase") {
      const ta = h("textarea", { class: "w-textarea", rows: "4", placeholder: "12 или 24 слова через пробел", autocomplete: "off", spellcheck: "false" });
      ta.value = f.imported;
      const status = h("div", { class: "w-status" });
      const check = () => {
        const words = ta.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
        const valid = [12, 15, 18, 21, 24].includes(words.length) && WalletStore.validateMnemonic(words.join(" "));
        status.textContent = words.length ? `${words.length} слов · ${valid ? "фраза корректна" : "проверка не пройдена"}` : "";
        status.toggleAttribute("ok", valid);
        return valid;
      };
      ta.addEventListener("input", () => {
        f.imported = ta.value;
        check();
      });
      ta.addEventListener("paste", () => setTimeout(check, 0));
      const next = this.wButton("Импортировать", "primary", async () => {
        if (!check()) {
          f.error = "Фраза не проходит проверку BIP-39";
          this.renderDrawer();
          return;
        }
        await this.walletFinish(ta.value);
      });
      this.wAppend(body, h("p", { class: "w-sub" }, "Фраза вводится только здесь, в защищённой панели браузера, и сразу шифруется."), ta, status, err, next);
      setTimeout(() => ta.focus(), 50);
    }
    const stage = { password: 0, nopass: 0, words: 1, quiz: 1, phrase: 1 }[f.step] ?? 0;
    const total = f.kind.startsWith("add") ? 2 : 3;
    const bars = Array.from({ length: total }, (_, i) => h("span", { class: i <= (f.kind.startsWith("add") ? stage - 1 + 1 : stage) ? "on" : "" }));
    return h("div", { class: "w-flow" }, null, [head, h("div", { class: "w-steps" }, null, bars), body]);
  },

  async walletFinish(phrase) {
    const f = this.wallet.flow;
    const { WalletStore } = this.walletStore();
    try {
      this.agentStatus?.("", false);
      if (f.kind.startsWith("add")) {
        await WalletStore.addWallet({ mnemonic: phrase, name: f.name || `Кошелёк ${WalletStore.wallets.length + 1}` });
      } else {
        await WalletStore.create({ mnemonic: phrase, password: f.passwordless ? "" : f.password, name: "Кошелёк 1" });
      }
      this.wallet.flow = null;
      this.wallet.view = "main";
      this.notice(f.kind.includes("import") ? "Кошелёк импортирован" : "Кошелёк создан");
    } catch (e) {
      f.error = e.message || String(e);
    }
    this.renderDrawer();
  },

  /* ---- Заблокирован ----------------------------------------------------- */

  walletLockedView() {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { WalletStore } = this.walletStore();
    const pass = this.wField("Пароль", { type: "password", autocomplete: "current-password" });
    const err = h("div", { class: "w-error", hidden: "true" });
    const go = this.wButton("Разблокировать", "primary", async () => {
      go.disabled = true;
      try {
        await WalletStore.unlock(pass.input.value);
      } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
        go.disabled = false;
        pass.input.select();
      }
    });
    pass.input.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        go.click();
      }
      e.stopPropagation();
    });
    setTimeout(() => pass.input.focus(), 50);
    return h("div", { class: "w-locked" }, null, [
      h("div", { class: "w-lock-mark" }, null, [this.wIcon(["M7 11V8a5 5 0 0 1 10 0v3", "M5 11h14v10H5z"], 22, 1.8)]),
      h("b", {}, "Кошелёк заблокирован"),
      h("p", { class: "w-sub" }, `${WalletStore.wallets.length} ${this.plural(WalletStore.wallets.length, "кошелёк", "кошелька", "кошельков")} · автоблокировка через ${Services.prefs.getIntPref("tabora.wallet.autolockMinutes", 15)} мин`),
      pass.wrap, err, go,
    ]);
  },

  /* ---- Главный экран ------------------------------------------------------ */

  walletMainView() {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { WalletStore, CHAINS, CHAIN_ORDER } = this.walletStore();
    const wallet = WalletStore.activeWallet;
    const account = WalletStore.activeAccount;
    const hidden = new Set(WalletStore.data.settings?.hiddenChains || []);

    // Шапка: кошелёк, адрес, итог
    const walletBtn = h("button", { class: "w-pick", type: "button" }, null, [h("span", { class: "w-pick-name" }, wallet.name), this.wIcon(["m6 9 6 6 6-6"], 12, 2.2)]);
    walletBtn.addEventListener("click", e => {
      const r = e.currentTarget.getBoundingClientRect();
      this.showMenu([
        ...WalletStore.wallets.map(w => ({ label: w.name, hint: `${w.accounts.length} адр.`, checked: w.id === wallet.id, run: () => WalletStore.setActive(w.id, 0) })),
        { separator: true },
        { label: "Добавить кошелёк по фразе…", run: () => this.walletStartFlow("add-import") },
        { label: "Создать новый кошелёк…", run: () => this.walletStartFlow("add-create") },
        { label: "Переименовать", run: () => this.walletPrompt("Название кошелька", wallet.name, v => WalletStore.renameWallet(wallet.id, v)) },
      ], r.left, r.bottom + 6);
    });
    const accBtn = h("button", { class: "w-pick small", type: "button" }, null, [h("span", {}, account.name), this.wIcon(["m6 9 6 6 6-6"], 11, 2.2)]);
    accBtn.addEventListener("click", e => {
      const r = e.currentTarget.getBoundingClientRect();
      this.showMenu([
        ...wallet.accounts.map(a => ({ label: a.name, hint: this.shortAddr(a.addresses.ethereum), checked: a.index === account.index, run: () => WalletStore.setActive(wallet.id, a.index) })),
        { separator: true },
        { label: "Новый адрес", hint: `№${wallet.accounts.length + 1}`, run: async () => { await WalletStore.addAccount(wallet.id); this.notice("Новый адрес создан"); } },
        { label: "Переименовать адрес", run: () => this.walletPrompt("Название адреса", account.name, v => WalletStore.renameAccount(wallet.id, account.index, v)) },
      ], r.left, r.bottom + 6);
    });
    const total = h("div", { class: "w-total", id: "tabora-wallet-total" }, null, [h("span", { class: "w-total-sum" }, "—"), h("span", { class: "w-total-note" }, "обновляем…")]);
    const lock = this.iconButton("", "Заблокировать", ["M7 11V8a5 5 0 0 1 10 0v3", "M5 11h14v10H5z"], () => WalletStore.lock(), 15);
    const settings = this.iconButton("", "Настройки кошелька", ["M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"], () => this.walletGo("settings"), 15);
    const head = h("div", { class: "w-head" }, null, [
      h("div", { class: "w-head-row" }, null, [walletBtn, h("span", { class: "spacer" }), settings, lock]),
      accBtn,
      total,
      WalletStore.passwordless ? h("div", { class: "w-badge-danger" }, "Без пароля · незащищённый режим") : h("span"),
    ]);

    // Сети
    const list = h("div", { class: "w-chains" });
    for (const id of CHAIN_ORDER) {
      if (hidden.has(id)) {
        continue;
      }
      const chain = CHAINS[id];
      const address = account.addresses[id];
      const row = h("div", { class: "w-chain", "data-chain": id, style: `--c:${chain.color}` }, null, [
        h("span", { class: "w-dot" }),
        h("div", { class: "w-chain-text" }, null, [
          h("b", {}, chain.name),
          h("span", { class: "w-addr mono", title: address }, this.shortAddr(address)),
        ]),
        h("div", { class: "w-chain-bal" }, null, [
          h("b", { class: "w-native" }, "…"),
          h("span", { class: "w-usd" }, ""),
        ]),
      ]);
      row.addEventListener("click", () => {
        this.wallet.receive = id;
        this.walletGo("receive");
      });
      row.addEventListener("contextmenu", e => {
        e.preventDefault();
        this.showMenu([
          { label: "Копировать адрес", run: () => this.copyText(address, "Адрес скопирован") },
          { label: "Показать адрес и QR", run: () => { this.wallet.receive = id; this.walletGo("receive"); } },
          { label: "Открыть в обозревателе", run: () => this.openInSpace(chain.explorer + address, true) },
          { separator: true },
          { label: "Скрыть сеть", run: async () => { WalletStore.data.settings.hiddenChains = [...hidden, id]; await WalletStore.save(); } },
        ], e.clientX, e.clientY);
      });
      list.append(row);
    }
    const foot = document.getElementById("tabora-drawer-foot");
    foot.replaceChildren();
    const refresh = this.html("button", { class: "dfull", type: "button" }, null, [this.html("span", {}, "Обновить балансы"), this.svg(["M20 12a8 8 0 1 1-2.3-5.7", "M20 4v5h-5"], 14, 2)]);
    refresh.addEventListener("click", () => {
      this.wallet.balances = {};
      this.renderDrawer();
    });
    foot.append(refresh);
    foot.hidden = false;
    return h("div", { class: "w-main" }, null, [head, list]);
  },

  async walletLoadBalances(seq) {
    const { WalletStore, CHAINS, CHAIN_ORDER } = this.walletStore();
    const account = WalletStore.activeAccount;
    const body = this.drawer.body;
    const prices = await WalletStore.prices();
    let totalUsd = 0;
    let known = 0;
    const jobs = CHAIN_ORDER.filter(id => !(WalletStore.data.settings?.hiddenChains || []).includes(id)).map(async id => {
      const chain = CHAINS[id];
      const addr = account.addresses[id];
      const cacheKey = `${id}:${addr}`;
      let bal = this.wallet.balances[cacheKey];
      if (!bal || Date.now() - bal.at > 60000) {
        try {
          bal = { ...(await WalletStore.balance(id, addr)), at: Date.now() };
        } catch (e) {
          bal = { error: e.message, at: Date.now() };
        }
        this.wallet.balances[cacheKey] = bal;
      }
      if (seq !== this.drawer.seq) {
        return;
      }
      const row = body.querySelector(`.w-chain[data-chain="${id}"]`);
      if (!row) {
        return;
      }
      const nat = row.querySelector(".w-native");
      const usd = row.querySelector(".w-usd");
      if (bal.error) {
        nat.textContent = "нет связи";
        nat.classList.add("err");
        usd.textContent = bal.error.slice(0, 40);
        return;
      }
      nat.textContent = `${bal.native} ${chain.symbol}`;
      const price = prices[chain.symbol] || 0;
      let value = parseFloat(bal.native) * price;
      for (const t of bal.tokens) {
        value += parseFloat(t.amount) * (prices[t.symbol] || 0);
      }
      totalUsd += value;
      known++;
      usd.textContent = (bal.tokens.length ? bal.tokens.map(t => `${t.amount} ${t.symbol}`).join(" · ") + " · " : "") + (price ? `$${value.toFixed(2)}` : "");
    });
    await Promise.all(jobs);
    if (seq !== this.drawer.seq) {
      return;
    }
    const total = body.querySelector("#tabora-wallet-total");
    if (total) {
      total.querySelector(".w-total-sum").textContent = `$${totalUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      total.querySelector(".w-total-note").textContent = `${known} ${this.plural(known, "сеть", "сети", "сетей")} · ${new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`;
    }
  },

  /* ---- Получить ------------------------------------------------------------- */

  walletReceiveView() {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { WalletStore, CHAINS } = this.walletStore();
    const id = this.wallet.receive || "ethereum";
    const chain = CHAINS[id];
    const account = WalletStore.activeAccount;
    const address = account.addresses[id];
    const back = this.wButton("Назад", "ghost small", () => this.walletGo("main"));
    const qr = h("canvas", { class: "w-qr", width: "220", height: "220" });
    this.drawQr(qr, address);
    const copy = this.wButton("Копировать адрес", "primary", () => this.copyText(address, "Адрес скопирован"));
    const explorer = this.wButton("В обозревателе", "ghost", () => this.openInSpace(chain.explorer + address, true));
    return h("div", { class: "w-receive" }, null, [
      h("div", { class: "w-flow-head" }, null, [h("b", {}, `Получить ${chain.symbol}`), back]),
      h("p", { class: "w-sub" }, `${chain.name}${chain.sameAs ? " и другие сети EVM с тем же адресом" : ""} · ${account.name}`),
      qr,
      h("div", { class: "w-address mono", title: address }, address),
      h("div", { class: "w-actions" }, null, [copy, explorer]),
      chain.kind === "evm" ? h("p", { class: "w-hint" }, "Этот адрес одинаков в Ethereum, Base, Arbitrum и Polygon. Отправитель должен выбрать нужную сеть.") : h("span"),
    ]);
  },

  drawQr(canvas, text) {
    try {
      const modules = this.qrModules(text);
      const n = modules.length;
      const ctx = canvas.getContext("2d");
      const size = canvas.width;
      const quiet = 2;
      const cell = Math.floor(size / (n + quiet * 2));
      const offset = Math.floor((size - cell * n) / 2);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = "#0b0c0e";
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          if (modules[y][x]) {
            ctx.fillRect(offset + x * cell, offset + y * cell, cell, cell);
          }
        }
      }
    } catch (e) {
      console.error("Tabora QR", e);
      canvas.hidden = true;
    }
  },

  /** Модули QR-кода (уровень M) через проверенную библиотеку qrcode-generator из вендорного бандла. */
  qrModules(text) {
    const { qrcodegen } = this.walletStore();
    const qr = qrcodegen(0, "M");
    qr.addData(text, "Byte");
    qr.make();
    const n = qr.getModuleCount();
    const out = [];
    for (let y = 0; y < n; y++) {
      const row = [];
      for (let x = 0; x < n; x++) {
        row.push(qr.isDark(y, x) ? 1 : 0);
      }
      out.push(row);
    }
    return out;
  },

  /* ---- Настройки ------------------------------------------------------------ */

  walletSettingsView() {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { WalletStore, CHAINS, CHAIN_ORDER } = this.walletStore();
    const back = this.wButton("Назад", "ghost small", () => this.walletGo("main"));
    const wallet = WalletStore.activeWallet;
    const hidden = new Set(WalletStore.data.settings?.hiddenChains || []);

    const nodes = h("div", { class: "w-group" }, null, [h("b", { class: "w-group-title" }, "Ноды (публичные, можно менять)")]);
    for (const id of CHAIN_ORDER) {
      const chain = CHAINS[id];
      const { list, index } = WalletStore.nodesFor(id);
      const select = h("select", {}, null, list.map((u, i) => {
        const o = h("option", { value: String(i) }, new URL(u).host);
        if (i === index) {
          o.selected = true;
        }
        return o;
      }));
      select.addEventListener("change", () => {
        WalletStore.setNodes(id, list, parseInt(select.value, 10));
        this.wallet.balances = {};
      });
      const add = this.iconButton("", "Добавить свою ноду", ["M12 5v14", "M5 12h14"], () => this.walletPrompt(`Адрес ноды для ${chain.name}`, "https://", v => {
        if (/^https?:\/\//.test(v)) {
          WalletStore.setNodes(id, [...list, v.trim()], list.length);
          this.wallet.balances = {};
        }
      }), 13);
      const row = h("div", { class: "w-node", style: `--c:${chain.color}` }, null, [h("span", { class: "w-dot" }), h("span", { class: "w-node-name" }, chain.name), select, add]);
      nodes.append(row);
      if (window.TaboraSelect) {
        window.TaboraSelect.enhance(select, { compact: true });
      }
    }

    const chains = h("div", { class: "w-group" }, null, [h("b", { class: "w-group-title" }, "Сети в списке")]);
    for (const id of CHAIN_ORDER) {
      const cb = h("input", { type: "checkbox" });
      cb.checked = !hidden.has(id);
      cb.addEventListener("change", async () => {
        const set = new Set(WalletStore.data.settings.hiddenChains || []);
        cb.checked ? set.delete(id) : set.add(id);
        WalletStore.data.settings.hiddenChains = [...set];
        await WalletStore.save();
      });
      chains.append(h("label", { class: "w-check" }, null, [cb, h("span", {}, CHAINS[id].name)]));
    }

    const autolock = h("select", {}, null, [5, 15, 30, 60, 0].map(v => {
      const o = h("option", { value: String(v) }, v ? `${v} мин` : "никогда");
      if (v === Services.prefs.getIntPref("tabora.wallet.autolockMinutes", 15)) {
        o.selected = true;
      }
      return o;
    }));
    autolock.addEventListener("change", () => {
      Services.prefs.setIntPref("tabora.wallet.autolockMinutes", parseInt(autolock.value, 10));
      WalletStore.armAutolock();
    });
    const security = h("div", { class: "w-group" }, null, [
      h("b", { class: "w-group-title" }, "Безопасность"),
      h("div", { class: "w-node" }, null, [h("span", { class: "w-node-name" }, "Автоблокировка"), autolock]),
      this.wButton(`Показать фразу: ${wallet.name}`, "ghost", () => this.walletRevealFlow(wallet)),
      this.wButton(WalletStore.passwordless ? "Установить пароль" : "Сменить пароль", "ghost", () => this.walletChangePasswordFlow()),
      this.wButton(`Удалить кошелёк «${wallet.name}» из браузера`, "ghost danger", () => this.walletPassword("Удаление кошелька", "Фраза останется только у вас. Введите пароль для подтверждения.", async pass => {
        await WalletStore.removeWallet(wallet.id, pass);
        this.notice("Кошелёк удалён из браузера");
        if (!WalletStore.wallets.length) {
          await WalletStore.destroy(pass).catch(() => {});
        }
        this.walletGo("main");
      })),
    ]);
    if (window.TaboraSelect) {
      window.TaboraSelect.enhance(autolock, { compact: true });
    }
    return h("div", { class: "w-settings" }, null, [h("div", { class: "w-flow-head" }, null, [h("b", {}, "Настройки кошелька"), back]), security, nodes, chains]);
  },

  /** Запрос пароля в панели: колбэк получает пароль, при ошибке показываем текст. */
  walletPassword(title, sub, onOk) {
    const { WalletStore } = this.walletStore();
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const pass = this.wField("Пароль", { type: "password", autocomplete: "current-password" });
    const err = h("div", { class: "w-error", hidden: "true" });
    const ok = this.wButton("Подтвердить", "primary", async () => {
      ok.disabled = true;
      try {
        await onOk(pass.input.value);
        box.remove();
      } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
        ok.disabled = false;
      }
    });
    const cancel = this.wButton("Отмена", "ghost", () => box.remove());
    const box = h("div", { class: "w-sheet" }, null, [h("div", { class: "w-sheet-card" }, null, [h("b", {}, title), h("p", { class: "w-sub" }, sub), WalletStore.passwordless ? h("span") : pass.wrap, err, h("div", { class: "w-actions" }, null, [cancel, ok])])]);
    pass.input.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Enter") {
        ok.click();
      }
    });
    this.drawer.this.wAppend(body, box);
    setTimeout(() => pass.input.focus(), 50);
  },

  walletPrompt(title, value, onOk) {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const input = h("input", { class: "w-input", type: "text", value });
    const ok = this.wButton("Сохранить", "primary", async () => {
      await onOk(input.value);
      box.remove();
      this.renderDrawer();
    });
    const cancel = this.wButton("Отмена", "ghost", () => box.remove());
    const box = h("div", { class: "w-sheet" }, null, [h("div", { class: "w-sheet-card" }, null, [h("b", {}, title), input, h("div", { class: "w-actions" }, null, [cancel, ok])])]);
    input.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Enter") {
        ok.click();
      }
    });
    this.drawer.this.wAppend(body, box);
    setTimeout(() => {
      input.focus();
      input.select();
    }, 50);
  },

  walletRevealFlow(wallet) {
    const { WalletStore } = this.walletStore();
    this.walletPassword(`Фраза: ${wallet.name}`, "Никому не показывайте. Фраза скроется при переключении окна и через 60 секунд.", async pass => {
      const phrase = await WalletStore.revealMnemonic(wallet.id, pass);
      const h = (t, a, x, c) => this.html(t, a, x, c);
      const grid = h("ol", { class: "w-phrase" }, null, phrase.split(" ").map((w, i) => h("li", {}, null, [h("i", {}, String(i + 1)), h("span", {}, w)])));
      grid.addEventListener("copy", e => e.preventDefault());
      const close = this.wButton("Скрыть", "primary", () => sheet.remove());
      const sheet = h("div", { class: "w-sheet" }, null, [h("div", { class: "w-sheet-card" }, null, [h("b", {}, wallet.name), grid, close])]);
      this.drawer.this.wAppend(body, sheet);
      clearTimeout(this.wallet.hideTimer);
      this.wallet.hideTimer = setTimeout(() => sheet.remove(), 60000);
    });
  },

  walletChangePasswordFlow() {
    const { WalletStore } = this.walletStore();
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const old = this.wField("Текущий пароль", { type: "password" });
    const p1 = this.wField("Новый пароль", { type: "password", placeholder: "не короче 8 символов" });
    const p2 = this.wField("Ещё раз", { type: "password" });
    const err = h("div", { class: "w-error", hidden: "true" });
    const ok = this.wButton("Сменить", "primary", async () => {
      if (p1.input.value.length < 8 || p1.input.value !== p2.input.value) {
        err.textContent = p1.input.value.length < 8 ? "Пароль короче 8 символов" : "Пароли не совпадают";
        err.hidden = false;
        return;
      }
      ok.disabled = true;
      try {
        await WalletStore.changePassword(old.input.value, p1.input.value);
        box.remove();
        this.notice("Пароль кошелька обновлён");
        this.renderDrawer();
      } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
        ok.disabled = false;
      }
    });
    const cancel = this.wButton("Отмена", "ghost", () => box.remove());
    const box = h("div", { class: "w-sheet" }, null, [h("div", { class: "w-sheet-card" }, null, [h("b", {}, WalletStore.passwordless ? "Установить пароль" : "Сменить пароль"), WalletStore.passwordless ? h("span") : old.wrap, p1.wrap, p2.wrap, err, h("div", { class: "w-actions" }, null, [cancel, ok])])]);
    box.querySelectorAll("input").forEach(i => i.addEventListener("keydown", e => e.stopPropagation()));
    this.drawer.this.wAppend(body, box);
  },
});

// Регистрация раздела в ящике
Tabora.SECTIONS.wallet = { label: "Кошелёк", key: "⌘⇧W", noSearch: true, icon: ["M3 7a2 2 0 0 1 2-2h13a1 1 0 0 1 1 1v2", "M3 7v10a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-7a1 1 0 0 0-1-1H5a2 2 0 0 1-2-2z", "M16 14h.01"], wide: false };
if (!Tabora.SECTION_ORDER.includes("wallet")) {
  Tabora.SECTION_ORDER.splice(1, 0, "wallet");
}
