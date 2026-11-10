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
      this._walletMod = ChromeUtils.importESModule("chrome://tabora/content/wallet/WalletStore.sys.mjs");
      Services.obs.addObserver((subject, topic, what) => {
        this.drawerDirty("wallet");
        if (what === "locked" || what === "destroyed") {
          const pill = document.getElementById("tabora-wallet-total");
          if (pill) {
            pill.hidden = true;
          }
          // после блокировки на экране не остаётся показанной фразы, а в памяти — слов недописанного кошелька
          this.walletHideSecrets();
          clearTimeout(this.wallet.hideTimer);
          if (this.wallet.flow?.kind?.startsWith("add")) {
            this.wallet.flow = null;
          }
        }
      }, this._walletMod.WalletStore.TOPIC);
      window.addEventListener("blur", () => this.walletHideSecrets());
    }
    return this._walletMod;
  },

  walletHideSecrets() {
    const root = this.drawer.el || document;
    root.querySelectorAll(".w-phrase").forEach(el => el.setAttribute("masked", "true"));
    root.querySelectorAll(".w-sheet.w-reveal").forEach(el => el.remove());
  },

  /** Сумма для узкой колонки истории: лишние знаки после запятой отбрасываются, ведущие нули малых сумм сохраняются. */
  shortAmount(s, max = 6) {
    s = String(s ?? "");
    if (s.length <= max || !s.includes(".")) {
      return s;
    }
    const [int, frac] = s.split(".");
    const room = Math.max(max - int.length - 1, 2);
    let cut = frac.slice(0, room).replace(/0+$/, "");
    if (!cut && /^-?0$/.test(int)) {
      const m = /^(0*)([1-9])/.exec(frac); // 0.00000123 → 0.000001: порядок малой суммы важнее знаков
      cut = m ? m[1] + m[2] : "";
    }
    return cut ? `${int}.${cut}` : int;
  },

  shortAddr(a, head = 8, tail = 6) {
    return a && a.length > head + tail + 2 ? `${a.slice(0, head)}…${a.slice(-tail)}` : a || "";
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
    const { Account } = this.accountMod();
    await Promise.all([WalletStore.ready(), Account.ready()]);
    if (seq !== d.seq) {
      return;
    }
    const w = this.wallet;
    if (!Account.signedIn) {
      // кошелёк принадлежит аккаунту: без входа раздел показывает приглашение войти
      w.flow = null;
      w.view = "main";
      d.body.replaceChildren(this.accountGateView("wallet"));
      return;
    }
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
      node = !WalletStore.unlocked ? this.walletLockedView() : WalletStore.unverified ? this.walletUnverifiedView() : this.walletMainView();
    } else if (WalletStore.unverified) {
      node = this.walletUnverifiedView(); // ни один кошелёк файла не проверен: адресов нет, приём и отправка закрыты
    } else if (w.view === "settings") {
      node = this.walletSettingsView();
    } else if (w.view === "receive") {
      node = this.walletReceiveView();
    } else if (w.view === "send") {
      node = this.walletSendView();
    } else {
      node = this.walletMainView();
    }
    // предупреждение о подменённом файле видно на всех экранах кошелька
    const tamper = WalletStore.exists && WalletStore.unlocked && WalletStore.tampered && !WalletStore.unverified && !w.flow ? this.walletTamperBanner() : null;
    d.body.replaceChildren(...[tamper, node].filter(Boolean));
    if (WalletStore.exists && WalletStore.unlocked && !WalletStore.unverified && !w.flow && w.view === "main") {
      this.walletLoadBalances(seq);
    }
  },

  walletGo(view) {
    this.wallet.view = view;
    this.renderDrawer();
  },

  /** Файл кошелька изменён вне Tabora: что это значит и подтверждение правок паролем.
   * Перед вводом пароля показывается, что именно из файла начнёт действовать. */
  walletTamperBanner() {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { WalletStore } = this.walletStore();
    const fixed = WalletStore._addrFixed;
    const unsigned = WalletStore.tamperReason === "unsigned";
    const what = unsigned ? "Файл кошелька старого формата: его открытая часть не была подписана, проверить её нечем." : WalletStore.tamperReason === "rollback" ? "Файл кошелька заменён более старой копией." : "Файл кошелька изменён вне Tabora.";
    const accept = this.wButton(unsigned ? "Проверить и принять…" : "Это мои правки, принять…", "small ghost", () => {
      const content = WalletStore.untrustedContent();
      this.walletPassword(
        "Принять файл кошелька",
        [
          unsigned ? "Адреса приёма уже пересчитаны из вашей фразы. Остальное содержимое файла начнёт действовать только после вашего пароля." : "Вы подтверждаете, что файл изменили вы. Если вы файл не меняли, не принимайте: восстановите кошелёк по фразе.",
          content.length ? "После подтверждения кошелёк начнёт доверять этим данным из файла:" : "Кроме адресов (они пересчитаны из фразы), в файле нет данных, требующих доверия.",
          ...content.map(line => `• ${line}`),
          "Знак подлинности на листах подтверждения будет выдан новый.",
        ],
        async pass => {
          await WalletStore.acceptFile(pass);
          this.notice("Файл кошелька подтверждён. Знак подлинности выдан новый");
          this.renderDrawer();
        }
      );
    });
    return h("div", { class: "w-badge-danger w-tamper" }, null, [
      h("span", {}, `${what} Пока вы не подтвердите его паролем, кошелёк ему не доверяет: адреса приёма пересчитаны из фразы${fixed ? ` (не совпадало: ${fixed})` : ""}, контакты, ноды, свои токены и настройки из файла не используются, сайты отключены.`),
      accept,
    ]);
  },

  /** Ни один кошелёк файла не прошёл проверку по seed: адреса из файла не показываются, приём и отправка закрыты. */
  walletUnverifiedView() {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { WalletStore } = this.walletStore();
    const lock = this.wButton("Заблокировать", "ghost", () => WalletStore.lock());
    const restore = this.wButton("Восстановить по фразе…", "primary", () => this.walletPassword(
      "Восстановление кошелька",
      [
        "Файл кошелька будет убран в сторону (tabora-wallet.json.unverified.bak в профиле), после чего кошелёк можно создать заново, импортировав seed-фразу.",
        "Продолжайте, только если фраза у вас записана: из этого файла её достать не удалось.",
      ],
      async pass => {
        await WalletStore.quarantine(pass);
        this.wallet.view = "main";
        this.renderDrawer();
      }
    ));
    return h("div", { class: "w-locked" }, null, [
      h("div", { class: "w-lock-mark" }, null, [this.wIcon(["M12 9v4", "M12 17h.01", "M10.3 3.9 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"], 22, 1.8)]),
      h("b", {}, "Кошелёк не удалось проверить"),
      h("p", { class: "w-badge-danger" }, "Файл кошелька изменён вне Tabora, и ни один зашифрованный блок с ключами не прошёл проверку. Адреса из такого файла не показываются: они могут принадлежать тому, кто его правил. Приём, отправка и запросы сайтов закрыты."),
      h("p", { class: "w-sub" }, "Восстановите файл профиля из резервной копии или создайте кошелёк заново по seed-фразе."),
      h("div", { class: "w-actions" }, null, [lock, restore]),
    ]);
  },

  /* ---- Приветствие ------------------------------------------------------- */

  walletWelcomeView() {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const create = this.wButton("Создать кошелёк", "primary", () => this.walletStartFlow("create"));
    const imp = this.wButton("Импортировать фразу", "", () => this.walletStartFlow("import"));
    return h("div", { class: "w-welcome" }, null, [
      h("div", { class: "w-orb" }, null, [this.markSvg()]),
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
        // новый кошелёк = новые адреса приёма: добавление только с паролем
        this.walletPassword("Добавить кошелёк", "Введите пароль кошелька, чтобы добавить фразу.", async pass => {
          await WalletStore.addWallet({ mnemonic: phrase, name: f.name || `Кошелёк ${WalletStore.wallets.length + 1}` }, pass);
          this.wallet.flow = null;
          this.wallet.view = "main";
          this.notice(f.kind.includes("import") ? "Кошелёк импортирован" : "Кошелёк создан");
          this.renderDrawer();
        });
        return;
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
    const pass = this.wField("Пароль", { type: "password", autocomplete: "off" });
    const err = h("div", { class: "w-error", hidden: "true" });
    const go = this.wButton("Разблокировать", "primary", async () => {
      go.disabled = true;
      go.classList.add("loading");
      err.hidden = true;
      try {
        await WalletStore.unlock(pass.input.value);
      } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
        go.disabled = false;
        pass.input.select();
      } finally {
        go.classList.remove("loading");
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
      h("p", { class: "w-sub" }, `${WalletStore.wallets.length} ${this.plural(WalletStore.wallets.length, "кошелёк", "кошелька", "кошельков")} · ${WalletStore.autolockMinutes ? `автоблокировка через ${WalletStore.autolockMinutes} мин` : "без автоблокировки"}`),
      pass.wrap, err, go,
    ]);
  },

  /* ---- Главный экран ------------------------------------------------------ */

  walletMainView() {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { WalletStore, CHAINS, CHAIN_ORDER } = this.walletStore();
    const wallet = WalletStore.activeWallet;
    const account = WalletStore.activeAccount;
    const hidden = WalletStore.hiddenChains;
    const w = this.wallet;
    w.tab ||= "assets";

    const walletBtn = h("button", { class: "w-pick", type: "button" }, null, [h("span", { class: "w-pick-name" }, wallet.name), this.wIcon(["m6 9 6 6 6-6"], 12, 2.2)]);
    walletBtn.addEventListener("click", e => {
      const r = e.currentTarget.getBoundingClientRect();
      this.showMenu([
        ...WalletStore.wallets.map(x => ({ label: x.name, hint: `${x.accounts.length} адр.`, checked: x.id === wallet.id, run: () => WalletStore.setActive(x.id, 0) })),
        { separator: true },
        { label: "Добавить кошелёк по фразе…", run: () => this.walletStartFlow("add-import") },
        { label: "Создать новый кошелёк…", run: () => this.walletStartFlow("add-create") },
        { label: "Переименовать", run: () => this.walletPrompt("Название кошелька", wallet.name, v => WalletStore.renameWallet(wallet.id, v)) },
      ], r.left, r.bottom + 6);
    });
    const accBtn = h("button", { class: "w-pick small", type: "button" }, null, [h("span", {}, `${account.name} · ${this.shortAddr(account.addresses.ethereum)}`), this.wIcon(["m6 9 6 6 6-6"], 11, 2.2)]);
    accBtn.addEventListener("click", e => {
      const r = e.currentTarget.getBoundingClientRect();
      this.showMenu([
        ...wallet.accounts.map(a => ({ label: a.name, hint: this.shortAddr(a.addresses.ethereum), checked: a.index === account.index, run: () => WalletStore.setActive(wallet.id, a.index) })),
        { separator: true },
        { label: "Новый адрес", hint: `№${wallet.accounts.length + 1}`, run: async () => { await WalletStore.addAccount(wallet.id); this.notice("Новый адрес создан"); } },
        { label: "Переименовать адрес", run: () => this.walletPrompt("Название адреса", account.name, v => WalletStore.renameAccount(wallet.id, account.index, v)) },
      ], r.left, r.bottom + 6);
    });

    const assets = this.walletAssets();
    const totalUsd = assets.reduce((n, a) => n + (a.usd || 0), 0);
    const loaded = assets.filter(a => !a.pending).length;
    const total = h("div", { class: "w-total" }, null, [
      h("span", { class: "w-total-sum" }, loaded ? `$${totalUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—"),
      h("span", { class: "w-total-note" }, assets.some(a => a.pending) ? "обновляем…" : `${CHAIN_ORDER.filter(id => !hidden.has(id)).length} сетей · ${new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`),
    ]);
    const lock = this.iconButton("", "Заблокировать", ["M7 11V8a5 5 0 0 1 10 0v3", "M5 11h14v10H5z"], () => WalletStore.lock(), 15);
    const settings = this.iconButton("", "Настройки кошелька", ["M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"], () => this.walletGo("settings"), 15);
    const receiveBtn = this.wButton("Получить", "", () => { w.receive = "ethereum"; this.walletGo("receive"); });
    receiveBtn.prepend(this.wIcon(["M12 5v14", "M5 12l7 7 7-7"], 14, 2.2));
    const sendBtn = this.wButton("Отправить", "primary", () => this.walletSendStart());
    sendBtn.prepend(this.wIcon(["M12 19V5", "M5 12l7-7 7 7"], 14, 2.2));
    const head = h("div", { class: "w-head" }, null, [
      h("div", { class: "w-head-row" }, null, [walletBtn, h("span", { class: "spacer" }), settings, lock]),
      accBtn,
      total,
      h("div", { class: "w-head-actions" }, null, [sendBtn, receiveBtn]),
      WalletStore.passwordless ? h("div", { class: "w-badge-danger" }, "Без пароля · незащищённый режим") : h("span"),
    ]);

    const seg = h("div", { class: "w-seg wide" }, null, [["assets", "Активы"], ["chains", "Сети"], ["activity", "История"]].map(([id, label]) => {
      const b = h("button", { type: "button", "aria-pressed": String(w.tab === id) }, label);
      b.addEventListener("click", () => {
        w.tab = id;
        this.renderDrawer();
      });
      return b;
    }));

    let list = h("div", { class: "w-chains" });
    if (w.tab === "activity") {
      list = this.walletActivityList();
    } else if (w.tab === "assets") {
      const nonzero = assets.filter(a => a.pending || parseFloat(a.amount) > 0);
      const zero = assets.filter(a => !a.pending && !(parseFloat(a.amount) > 0));
      nonzero.forEach(a => list.append(this.walletAssetRow(a)));
      if (!nonzero.length && !assets.some(a => a.pending)) {
        list.append(h("div", { class: "w-empty" }, "Пока пусто. Пополните любой адрес: ниже кнопка «Получить»."));
      }
      if (zero.length) {
        const toggle = h("button", { class: "w-link", type: "button" }, w.showZero ? "Скрыть пустые" : `Показать ${zero.length} без баланса`);
        toggle.addEventListener("click", () => {
          w.showZero = !w.showZero;
          this.renderDrawer();
        });
        list.append(h("div", { class: "w-zero-toggle" }, null, [toggle]));
        if (w.showZero) {
          zero.forEach(a => list.append(this.walletAssetRow(a)));
        }
      }
      const add = h("button", { class: "w-add", type: "button" }, null, [this.wIcon(["M12 5v14", "M5 12h14"], 14, 2.2), h("span", {}, "Добавить токен по адресу контракта")]);
      add.addEventListener("click", () => this.walletAddTokenSheet());
      list.append(add);
    } else {
      for (const id of CHAIN_ORDER) {
        if (hidden.has(id)) {
          continue;
        }
        const chain = CHAINS[id];
        const address = account.addresses[id];
        const bal = w.balances[`${id}:${address}`];
        const price = w.prices?.[chain.symbol] || 0;
        const row = h("div", { class: "w-chain", "data-chain": id, style: `--c:${chain.color}` }, null, [
          h("img", { class: "w-logo", src: chain.logo, alt: "" }),
          h("div", { class: "w-chain-text" }, null, [h("b", {}, chain.name), h("span", { class: "w-addr mono", title: address }, this.shortAddr(address))]),
          h("div", { class: "w-chain-bal" }, null, [
            h("b", { class: `w-native${bal?.error ? " err" : ""}` }, bal ? (bal.error ? "нет связи" : `${bal.native} ${chain.symbol}`) : "…"),
            h("span", { class: "w-usd" }, bal && !bal.error ? (price ? `$${(parseFloat(bal.native) * price).toFixed(2)}` : "") : bal?.error ? bal.error.slice(0, 36) : ""),
          ]),
        ]);
        row.addEventListener("click", () => { w.receive = id; this.walletGo("receive"); });
        row.addEventListener("contextmenu", e => {
          e.preventDefault();
          this.showMenu([
            { label: "Копировать адрес", run: () => this.copyText(address, "Адрес скопирован") },
            { label: "Показать адрес и QR", run: () => { w.receive = id; this.walletGo("receive"); } },
            { label: "Открыть в обозревателе", run: () => this.openInSpace(chain.explorer + address, true) },
            { separator: true },
            { label: "Скрыть сеть", run: () => WalletStore.setChainHidden(id, true).catch(e => this.notice(e.message)) },
          ], e.clientX, e.clientY);
        });
        list.append(row);
      }
    }

    const foot = document.getElementById("tabora-drawer-foot");
    foot.replaceChildren();
    const refreshing = !!w.refreshing;
    const refresh = h("button", { class: `dfull${refreshing ? " loading" : ""}`, type: "button" }, null, [
      h("span", {}, refreshing ? "Обновляем…" : "Обновить балансы"),
      refreshing ? h("span", { class: "spin" }) : this.svg(["M20 12a8 8 0 1 1-2.3-5.7", "M20 4v5h-5"], 14, 2),
    ]);
    refresh.disabled = refreshing;
    refresh.addEventListener("click", () => {
      if (w.refreshing) {
        return;
      }
      for (const k of Object.keys(w.balances)) {
        w.balances[k].at = 0; // старые значения остаются на экране до прихода новых
      }
      w.pricesAt = 0;
      w.refreshing = true;
      this.renderDrawer();
    });
    foot.append(refresh);
    foot.hidden = false;
    return h("div", { class: "w-main" }, null, [head, seg, list]);
  },

  /** Плоский список активов из кэша балансов: нативные монеты и токены каждой сети. */
  walletAssets() {
    const { WalletStore, CHAINS, CHAIN_ORDER } = this.walletStore();
    const account = WalletStore.activeAccount;
    const hidden = WalletStore.hiddenChains;
    const prices = this.wallet.prices || {};
    const out = [];
    for (const id of CHAIN_ORDER) {
      if (hidden.has(id)) {
        continue;
      }
      const chain = CHAINS[id];
      const address = account.addresses[id];
      const bal = this.wallet.balances[`${id}:${address}`];
      if (!bal || bal.error) {
        out.push({ key: `${id}:native`, chain: id, chainName: chain.name, color: chain.color, symbol: chain.symbol, logo: chain.logo, chainLogo: chain.logo, amount: "0", usd: 0, native: true, pending: !bal, error: bal?.error });
        continue;
      }
      out.push({ key: `${id}:native`, chain: id, chainName: chain.name, color: chain.color, symbol: chain.symbol, logo: chain.logo, chainLogo: chain.logo, amount: bal.native, usd: parseFloat(bal.native) * (prices[chain.symbol] || 0), native: true, address });
      for (const t of bal.tokens || []) {
        // свои токены не оцениваются: символ «USDT» у своего токена ничего не стоит
        out.push({ key: `${id}:${t.address || t.mint}`, chain: id, chainName: chain.name, color: chain.color, symbol: t.symbol, logo: t.logo, chainLogo: chain.logo, amount: t.amount, usd: parseFloat(t.amount) * (WalletStore.unitPrice(id, t, prices) || 0), token: t, address });
      }
    }
    out.sort((a, b) => (b.usd || 0) - (a.usd || 0) || (parseFloat(b.amount) || 0) - (parseFloat(a.amount) || 0));
    return out;
  },

  walletAssetRow(a) {
    const h = (t, x, y, c) => this.html(t, x, y, c);
    const { WalletStore, CHAINS } = this.walletStore();
    const row = h("div", { class: "w-asset", style: `--c:${a.color}` }, null, [
      h("span", { class: "w-coin" }, null, [
        a.logo ? h("img", { src: a.logo, alt: "" }) : h("b", {}, a.symbol.slice(0, 1)),
        h("i", { class: "w-coin-chain" }, null, a.chainLogo ? [h("img", { src: a.chainLogo, alt: "" })] : []),
      ]),
      h("div", { class: "w-chain-text" }, null, [h("b", {}, a.symbol), h("span", { class: "w-sub-line" }, a.native ? a.chainName : `${a.chainName}${a.token?.custom ? " · свой токен" : ""}`)]),
      h("div", { class: "w-chain-bal" }, null, [
        h("b", { class: `w-native${a.error ? " err" : ""}` }, a.pending ? "…" : a.error ? "нет связи" : a.amount),
        h("span", { class: "w-usd" }, a.pending || a.error ? "" : a.usd ? `$${a.usd.toFixed(2)}` : ""),
      ]),
    ]);
    row.addEventListener("click", () => { this.wallet.receive = a.chain; this.walletGo("receive"); });
    row.addEventListener("contextmenu", e => {
      e.preventDefault();
      const items = [
        { label: `Отправить ${a.symbol}`, run: () => this.walletSendStart(a.key) },
        { label: `Получить ${a.symbol}`, run: () => { this.wallet.receive = a.chain; this.walletGo("receive"); } },
        { label: "Копировать адрес", run: () => this.copyText(a.address, "Адрес скопирован") },
        { label: "Открыть в обозревателе", run: () => this.openInSpace(CHAINS[a.chain].explorer + a.address, true) },
      ];
      if (a.token) {
        items.push({ separator: true }, { label: "Скрыть токен", run: async () => { await WalletStore.hideToken(a.chain, a.token); this.wallet.balances = {}; } });
      }
      this.showMenu(items, e.clientX, e.clientY);
    });
    return row;
  },

  walletAddTokenSheet() {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { WalletStore, CHAINS, CHAIN_ORDER } = this.walletStore();
    const chainSel = h("select", {}, null, CHAIN_ORDER.filter(id => CHAINS[id].kind !== "btc").map(id => h("option", { value: id }, CHAINS[id].name)));
    const addr = this.wField("Адрес контракта или mint", { type: "text", placeholder: "0x… / T… / mint", autocomplete: "off", spellcheck: "false" });
    const sym = this.wField("Символ", { type: "text", placeholder: "USDT", maxlength: "12" });
    const dec = this.wField("Знаков после запятой", { type: "number", min: "0", max: "18", placeholder: "6" });
    const status = h("div", { class: "w-status" });
    const err = h("div", { class: "w-error", hidden: "true" });
    let timer = null;
    const lookup = async () => {
      const v = addr.input.value.trim();
      if (v.length < 20) {
        return;
      }
      status.textContent = "Ищем контракт…";
      try {
        const info = await WalletStore.tokenInfo(chainSel.value, v);
        if (info.symbol) {
          sym.input.value = info.symbol;
        }
        dec.input.value = String(info.decimals);
        status.textContent = info.name ? `Найдено: ${info.name}` : "Контракт найден, укажите символ";
        status.toggleAttribute("ok", true);
      } catch (e) {
        status.textContent = e.message;
        status.removeAttribute("ok");
      }
    };
    addr.input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(lookup, 400);
    });
    chainSel.addEventListener("change", lookup);
    const ok = this.wButton("Добавить", "primary", async () => {
      const v = addr.input.value.trim();
      const symbol = sym.input.value.trim().toUpperCase();
      const decimals = parseInt(dec.input.value, 10);
      if (!v || !symbol || Number.isNaN(decimals) || decimals < 0 || decimals > 36) {
        err.textContent = "Заполните адрес, символ и знаки";
        err.hidden = false;
        return;
      }
      const kind = CHAINS[chainSel.value].kind;
      try {
        await WalletStore.addToken(chainSel.value, kind === "sol" ? { mint: v, symbol, decimals } : { address: v, symbol, decimals });
        box.remove();
        this.wallet.balances = {};
        this.notice(`Токен ${symbol} добавлен`);
        this.renderDrawer();
      } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
      }
    });
    const cancel = this.wButton("Отмена", "ghost", () => box.remove());
    const box = h("div", { class: "w-sheet" }, null, [h("div", { class: "w-sheet-card" }, null, [
      h("b", {}, "Добавить токен"),
      h("p", { class: "w-sub" }, "ERC-20, TRC-20 и SPL. Символ и знаки подставим из контракта, проверьте их перед добавлением."),
      h("label", { class: "w-field" }, null, [h("span", {}, "Сеть"), chainSel]),
      addr.wrap, h("div", { class: "w-row2" }, null, [sym.wrap, dec.wrap]), status, err,
      h("div", { class: "w-actions" }, null, [cancel, ok]),
    ])]);
    box.querySelectorAll("input").forEach(i => i.addEventListener("keydown", e => e.stopPropagation()));
    this.wSheetShow(box);
    if (window.TaboraSelect) {
      window.TaboraSelect.enhance(chainSel, { compact: true });
    }
    setTimeout(() => addr.input.focus(), 50);
  },

  /** Загрузка балансов активного аккаунта: только устаревшие, затем одна перерисовка. */
  async walletLoadBalances(seq) {
    const { WalletStore, CHAIN_ORDER } = this.walletStore();
    const account = WalletStore.activeAccount;
    const w = this.wallet;
    const hidden = WalletStore.hiddenChains;
    const stale = CHAIN_ORDER.filter(id => !hidden.has(id)).filter(id => {
      const b = w.balances[`${id}:${account.addresses[id]}`];
      return !b || Date.now() - b.at > 60000;
    });
    const needPrices = !w.pricesAt || Date.now() - w.pricesAt > 120000;
    if (!stale.length && !needPrices) {
      w.refreshing = false;
      return;
    }
    if (w.loadingNow) {
      return; // уже идёт
    }
    w.loadingNow = true;
    if (needPrices) {
      w.prices = await WalletStore.prices();
      w.pricesAt = Date.now();
    }
    await Promise.all(stale.map(async id => {
      const addr = account.addresses[id];
      try {
        w.balances[`${id}:${addr}`] = { ...(await WalletStore.balance(id, addr)), at: Date.now() };
      } catch (e) {
        w.balances[`${id}:${addr}`] = { error: e.message, at: Date.now() };
      }
    }));
    w.loadingNow = false;
    w.refreshing = false;
    this.updateWalletCard();
    // перерисовываем текущий экран (главный, отправка), если панель кошелька открыта
    if (this.drawer.open && this.drawer.section === "wallet" && !this.wallet.flow) {
      this.renderDrawer();
    }
  },

  /** Сумма активов на карточке сайдбара (только пока кошелёк разблокирован). */
  updateWalletCard() {
    const pill = document.getElementById("tabora-wallet-total");
    if (!pill) {
      return;
    }
    const { WalletStore } = this.walletStore();
    if (!WalletStore.exists || !WalletStore.unlocked) {
      pill.hidden = true;
      return;
    }
    const assets = this.walletAssets();
    if (assets.some(a => a.pending)) {
      return;
    }
    const total = assets.reduce((n, a) => n + (a.usd || 0), 0);
    pill.textContent = `$${total.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
    pill.hidden = false;
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
      h("div", { class: "w-flow-head" }, null, [h("span", { class: "w-title-logo" }, null, [h("img", { class: "w-logo", src: chain.logo, alt: "" }), h("b", {}, `Получить ${chain.symbol}`)]), back]),
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

  /** Карточка «Знак подлинности» в настройках. */
  walletMarkCard() {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { WalletStore } = this.walletStore();
    return h("div", { class: "w-group" }, null, [
      h("b", { class: "w-group-title" }, "Знак подлинности"),
      h("div", { class: "w-mark big" }, null, [h("span", {}, WalletStore.phishMark || "—")]),
      h("p", { class: "w-hint" }, "Эти эмодзи показываются на каждом настоящем запросе от сайта. Если на листе подтверждения их нет или они другие, это подделка внутри страницы: ничего не вводите."),
    ]);
  },

  walletSettingsView() {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { WalletStore, CHAINS, CHAIN_ORDER } = this.walletStore();
    const back = this.wButton("Назад", "ghost small", () => this.walletGo("main"));
    const wallet = WalletStore.activeWallet;
    const hidden = WalletStore.hiddenChains;
    // смена нод, автоблокировки и режима пароля — только с паролем кошелька (кто угодно за разблокированным компьютером не ослабит защиту)
    const guarded = (title, sub, run) => this.walletPassword(title, sub, async pass => {
      await run(pass);
      this.renderDrawer();
    }, () => this.renderDrawer());

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
        const next = parseInt(select.value, 10);
        guarded(`Нода ${chain.name}`, `Переключить на ${this.hostOf(list[next])}? Нода видит ваши адреса и сообщает балансы, комиссии и результаты симуляции.`, async pass => {
          await WalletStore.setNodes(id, list, next, { password: pass });
          this.wallet.balances = {};
        });
      });
      const add = this.iconButton("", "Добавить свою ноду", ["M12 5v14", "M5 12h14"], () => this.walletPrompt(`Адрес ноды для ${chain.name}`, "https://", v => {
        let url;
        try {
          url = WalletStore.validateNodeUrl(v.trim());
        } catch (e) {
          this.notice(e.message);
          return;
        }
        guarded(`Своя нода ${chain.name}`, `Добавить и выбрать ${this.hostOf(url)}? Своя нода видит ваши адреса и может сообщать ложные балансы, комиссии и результаты симуляции.`, async pass => {
          await WalletStore.setNodes(id, list.includes(url) ? list : [...list, url], list.includes(url) ? list.indexOf(url) : list.length, { password: pass });
          this.wallet.balances = {};
        });
      }), 13);
      const row = h("div", { class: "w-node rpc", style: `--c:${chain.color}` }, null, [h("img", { class: "w-logo small", src: chain.logo, alt: "" }), h("span", { class: "w-node-name" }, chain.name), select, add]);
      nodes.append(row);
      if (window.TaboraSelect) {
        window.TaboraSelect.enhance(select, { compact: true });
      }
    }

    const chains = h("div", { class: "w-group" }, null, [h("b", { class: "w-group-title" }, "Сети в списке")]);
    for (const id of CHAIN_ORDER) {
      const cb = h("input", { type: "checkbox" });
      cb.checked = !hidden.has(id);
      cb.addEventListener("change", () => WalletStore.setChainHidden(id, !cb.checked).catch(e => {
        this.notice(e.message);
        this.renderDrawer();
      }));
      chains.append(h("label", { class: "w-check" }, null, [cb, h("span", {}, CHAINS[id].name)]));
    }

    const autolockNow = WalletStore.autolockMinutes;
    const autolock = h("select", {}, null, [...new Set([5, 15, 30, 60, 0, autolockNow])].map(v => {
      const o = h("option", { value: String(v) }, v ? `${v} мин` : "никогда");
      if (v === autolockNow) {
        o.selected = true;
      }
      return o;
    }));
    autolock.addEventListener("change", () => {
      const v = parseInt(autolock.value, 10);
      guarded("Автоблокировка", v ? `Блокировать кошелёк через ${v} мин без действий?` : "Отключить автоблокировку? Кошелёк останется открытым, пока вы не заблокируете его вручную.", async pass => {
        await WalletStore.setAutolock(v, pass);
        this.notice(v ? `Автоблокировка через ${v} мин` : "Автоблокировка выключена");
      });
    });
    const sp = WalletStore.signPassword;
    const spCurrent = !sp.skip ? "always" : sp.thresholdUsd ? String(sp.thresholdUsd) : "never";
    const signSel = h("select", {}, null, [["always", "каждый раз"], ["100", "только от 100 $"], ["500", "только от 500 $"], ["2000", "только от 2000 $"], ["never", "никогда до автоблокировки"]].map(([v, label]) => {
      const o = h("option", { value: v }, label);
      if (v === spCurrent) {
        o.selected = true;
      }
      return o;
    }));
    signSel.addEventListener("change", () => {
      const v = signSel.value;
      guarded("Пароль при подписи", v === "always" ? "Спрашивать пароль на каждую подпись?" : "Подписи без пароля до автоблокировки: любой за этим компьютером сможет подписать операцию ниже порога. Суммы без известного курса и опасные операции по-прежнему спросят пароль.", async pass => {
        await WalletStore.setSignPassword(v === "always" ? { skip: false } : { skip: true, thresholdUsd: v === "never" ? 0 : Number(v) }, pass);
        this.notice(v === "always" ? "Пароль нужен на каждую подпись" : "Пароль только при разблокировке, крупных суммах и опасных операциях");
      });
    });
    const security = h("div", { class: "w-group" }, null, [
      h("b", { class: "w-group-title" }, "Безопасность"),
      h("div", { class: "w-node" }, null, [h("span", { class: "w-node-name" }, "Автоблокировка"), autolock]),
      h("div", { class: "w-node" }, null, [h("span", { class: "w-node-name" }, "Пароль при подписи"), signSel]),
      WalletStore.signPassword.skip ? h("p", { class: "w-hint" }, "Пока кошелёк разблокирован, подпись не спрашивает пароль: любой за этим компьютером сможет подписать транзакцию до автоблокировки. Опасные операции, суммы от порога и суммы без известного курса спрашивают пароль всегда.") : h("span", { hidden: "true" }),
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
      window.TaboraSelect.enhance(signSel, { compact: true });
    }
    return h("div", { class: "w-settings" }, null, [h("div", { class: "w-flow-head" }, null, [h("b", {}, "Настройки кошелька"), back]), security, this.walletMarkCard(), this.walletContactsCard(), this.walletSitesCard(), nodes, chains]);
  },

  /** Запрос пароля в панели: колбэк получает пароль, при ошибке показываем текст; onCancel — при отмене. */
  walletPassword(title, sub, onOk, onCancel = null) {
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
    const cancel = this.wButton("Отмена", "ghost", () => {
      box.remove();
      onCancel?.();
    });
    const box = h("div", { class: "w-sheet" }, null, [h("div", { class: "w-sheet-card" }, null, [h("b", {}, title), ...[].concat(sub).map(line => h("p", { class: "w-sub" }, line)), WalletStore.passwordless ? h("span") : pass.wrap, err, h("div", { class: "w-actions" }, null, [cancel, ok])])]);
    pass.input.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Enter") {
        ok.click();
      }
    });
    this.wSheetShow(box);
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
    this.wSheetShow(box);
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
      const sheet = h("div", { class: "w-sheet w-reveal" }, null, [h("div", { class: "w-sheet-card" }, null, [h("b", {}, wallet.name), grid, close])]);
      this.wSheetShow(sheet);
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
    this.wSheetShow(box);
  },
});

// Фоновое наблюдение за поступлениями (раз в минуту, с уведомлением)
setTimeout(() => Tabora.walletStartWatch?.(), 5000);

// Регистрация раздела в ящике
Tabora.SECTIONS.wallet = { label: "Кошелёк", key: "⌘⇧W", noSearch: true, icon: ["M3 7a2 2 0 0 1 2-2h13a1 1 0 0 1 1 1v2", "M3 7v10a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-7a1 1 0 0 0-1-1H5a2 2 0 0 1-2-2z", "M16 14h.01"], wide: false };
if (!Tabora.SECTION_ORDER.includes("wallet")) {
  Tabora.SECTION_ORDER.splice(1, 0, "wallet");
}
