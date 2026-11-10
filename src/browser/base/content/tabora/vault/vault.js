/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Раздел «Коды» в ящике и интерфейс сейфа: создание, разблокировка, мастер-пароль,
 * восстановление повреждённого файла, смена ключа. Сейф (vault/Vault.sys.mjs) хранит
 * ключ, которым шифруются пароли сайтов, секреты одноразовых кодов и кэш почты.
 * Разметка — chrome-DOM, стили общие с кошельком (w-*).
 * Подключается из tabora.js после wallet/*.js. */

// подсказка кода реагирует на клик и Enter не раньше, чем через столько мс после показа:
// страница не успеет подсунуть подсказку под уже начатый клик
const OTP_POP_ARM_MS = 400;
// нажатие клавиши, увиденное окном браузера, считается действием пользователя столько мс
const OTP_KEY_FRESH_MS = 1500;
// самая большая сторона картинки, которую принимаем от страницы для поиска QR
const OTP_QR_MAX_SIDE = 1600;

Object.assign(Tabora, {
  _vaultMod: null,
  _otpMod: null,
  codes: { view: "main", timer: null },

  vaultMod() {
    if (!this._vaultMod) {
      this._vaultMod = ChromeUtils.importESModule("chrome://tabora/content/vault/Vault.sys.mjs");
      const topic = this._vaultMod.Vault.TOPIC;
      const observer = (subject, t, what) => {
        this.drawerDirty("codes");
        if (what === "waiting") {
          this.vaultAskUnlock();
        } else if (what === "need-password") {
          this.vaultAskPassword();
        } else if (what === "corrupt") {
          this.vaultAskCorrupt();
        } else if (what === "locked") {
          this.otpPopHide();
        } else if (what === "unlocked") {
          this.otpPopRefresh();
        }
      };
      Services.obs.addObserver(observer, topic);
      window.addEventListener("unload", () => Services.obs.removeObserver(observer, topic), { once: true });
    }
    return this._vaultMod;
  },

  /** Модулю нужен ключ: при запуске (мастер-пароль при запуске) или хранилищу паролей после
   * блокировки. Просим разблокировать в активном окне; сам сейф не открывается. */
  vaultAskUnlock() {
    if (window !== Services.wm.getMostRecentBrowserWindow() || !this.drawer?.el) {
      return;
    }
    const { Vault } = this.vaultMod();
    if (Vault.waitingReason === "passwords") {
      // хранилище паролей спрашивает при каждом поле входа: раздел открываем не чаще раза в 3 минуты
      if (Date.now() - (this._vaultAskedAt || 0) < 180000) {
        return;
      }
      this._vaultAskedAt = Date.now();
      this.notice("Сейф заблокирован: разблокируйте его, чтобы подставить пароль");
    } else {
      this.notice("Введите мастер-пароль сейфа, чтобы включить пароли сайтов");
    }
    this.openDrawer("codes");
  },

  /** В профиле был основной пароль Firefox: перешифровать пароли под сейф без пароля значило бы
   * молча снять защиту. Просим задать мастер-пароль сейфа; до этого пароли работают под NSS. */
  vaultAskPassword() {
    if (window !== Services.wm.getMostRecentBrowserWindow() || !this.drawer?.el) {
      return;
    }
    const { Vault } = this.vaultMod();
    if (!Vault.needsPassword || this._vaultAskedPassword) {
      return;
    }
    this._vaultAskedPassword = true;
    this.openDrawer("codes");
    setTimeout(() => {
      if (!Vault.exists) {
        this.vaultCreateSheet({ migration: true });
      } else if (Vault.unlocked && !Vault.hasPassword) {
        this.vaultPasswordSheet({ migration: true });
      }
    }, 300);
  },

  vaultAskCorrupt() {
    if (window !== Services.wm.getMostRecentBrowserWindow() || !this.drawer?.el) {
      return;
    }
    this.notice(this.vaultMod().Vault.corrupt?.missing ? "Файл сейфа пропал: выберите, как восстановиться" : "Файл сейфа повреждён: выберите, как восстановиться");
    this.openDrawer("codes");
  },

  /** При загрузке окна: модуль мог начать ждать ключ до появления окна. */
  vaultInit() {
    const { Vault } = this.vaultMod();
    Vault.ready().then(() => {
      if (Vault.state === "corrupt") {
        setTimeout(() => this.vaultAskCorrupt(), 400);
      } else if (Vault.needsPassword) {
        setTimeout(() => this.vaultAskPassword(), 400);
      } else if (Vault.waiting) {
        setTimeout(() => this.vaultAskUnlock(), 400);
      }
    });
    // окно браузера видит нажатия клавиш до страницы: так родитель отличает настоящий Enter
    // пользователя от сообщения, которое мог прислать взломанный процесс страницы
    window.addEventListener("keydown", e => this.otpChromeKey(e), true);
  },

  /** Разблокировать действием пользователя: Touch ID или пароль macOS, а без связки ключей —
   * раздел «Коды» с полем мастер-пароля. */
  async vaultUnlockByUser() {
    const { Vault } = this.vaultMod();
    await Vault.ready();
    if (Vault.unlocked) {
      return true;
    }
    if (Vault.exists && Vault.hasOsKey && Vault.osUnlockEnabled && (await Vault.unlock({ user: true }))) {
      return true;
    }
    this.openDrawer("codes");
    return false;
  },

  /* ---- Раздел ящика ---------------------------------------------------- */

  async drawer_codes(seq) {
    const d = this.drawer;
    const { Vault } = this.vaultMod();
    await Vault.ready();
    if (Vault.exists && !Vault.unlocked) {
      await Vault.unlock(); // тихо, через связку ключей; после явной блокировки не откроется
    }
    if (Vault.unlocked) {
      await this.otpMod().Otp.ready();
    }
    if (seq !== d.seq) {
      return;
    }
    let node;
    if (Vault.state === "corrupt") {
      node = this.vaultCorruptView();
    } else if (!Vault.exists) {
      node = this.vaultWelcomeView();
    } else if (!Vault.unlocked) {
      node = this.vaultLockedView();
    } else {
      node = this.codesMainView();
    }
    d.body.replaceChildren(node);
  },

  /* ---- Экраны сейфа ------------------------------------------------------ */

  vaultWelcomeView() {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const create = this.wButton("Создать сейф", "primary", () => this.vaultCreateSheet());
    return h("div", { class: "w-welcome" }, null, [
      h("div", { class: "w-orb" }, null, [this.markSvg()]),
      h("b", {}, "Сейф Tabora"),
      h("p", {}, "Пароли сайтов и коды двухфакторной защиты шифруются одним ключом. Ключ хранится в связке ключей этого компьютера и, по желанию, под мастер-паролем для переноса."),
      h("div", { class: "w-actions" }, null, [create]),
      h("ul", { class: "w-points" }, null, [
        h("li", {}, "Ни один пароль не лежит на диске открытым текстом"),
        h("li", {}, "Открывается сам на этом компьютере, без ввода пароля"),
        h("li", {}, "Мастер-пароль нужен только для переезда на другой компьютер"),
      ]),
    ]);
  },

  vaultLockedView() {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { Vault } = this.vaultMod();
    const mark = h("div", { class: "w-lock-mark" }, null, [this.wIcon(["M7 11V8a5 5 0 0 1 10 0v3", "M5 11h14v10H5z"], 22, 1.8)]);
    const err = h("div", { class: "w-error", hidden: "true" });
    const recovery = Vault.hasRecoveryKey ? this.wButton("Войти по ключу восстановления", "ghost", () => this.vaultRecoverySheet()) : null;
    const later = Vault.waiting && Vault.waitingReason === "passwords" ? this.wButton("Не сейчас", "ghost", () => Vault.cancelWaiting()) : null;
    const canTouch = Vault.hasOsKey && Vault.osUnlockEnabled;
    const touch = canTouch ? this.wButton(Vault.hasPassword ? "Touch ID или пароль macOS" : "Разблокировать", Vault.hasPassword ? "ghost" : "primary", async () => {
      touch.disabled = true;
      err.hidden = true;
      const ok = await Vault.unlock({ user: true });
      touch.disabled = false;
      if (!ok) {
        err.textContent = "Проверка не пройдена";
        err.hidden = false;
      }
    }) : null;
    const lockedText = Vault.explicitlyLocked ? "Сейф заблокирован вами. Пароли сайтов и коды откроются после проверки." : null;
    if (!Vault.hasPassword) {
      if (touch) {
        return h("div", { class: "w-locked" }, null, [
          mark,
          h("b", {}, "Сейф заблокирован"),
          h("p", { class: "w-sub" }, lockedText || "Подтвердите, что это вы: Touch ID или пароль macOS."),
          err, touch, recovery, later,
        ].filter(Boolean));
      }
      return h("div", { class: "w-locked" }, null, [
        mark,
        h("b", {}, "Сейф недоступен"),
        h("p", { class: "w-sub" }, Vault.hasRecoveryKey ? "Ключ сейфа хранится в связке ключей другого компьютера, мастер-пароль не задан. Откройте сейф ключом восстановления и задайте пароль." : "Ключ сейфа хранится в связке ключей системы, а мастер-пароль не задан. Если файл перенесён с другого компьютера, открыть его нельзя."),
        recovery,
      ].filter(Boolean));
    }
    const pass = this.wField("Мастер-пароль", { type: "password", autocomplete: "off" });
    const go = this.wButton("Разблокировать", "primary", async () => {
      go.disabled = true;
      go.classList.add("loading");
      err.hidden = true;
      try {
        await Vault.unlockWithPassword(pass.input.value);
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
      mark,
      h("b", {}, "Сейф заблокирован"),
      h("p", { class: "w-sub" }, lockedText || (canTouch ? "Введите мастер-пароль или подтвердите через систему." : "Введите мастер-пароль")),
      pass.wrap, err, go, touch, recovery, later,
    ].filter(Boolean));
  },

  /** Файл сейфа повреждён или пропал (а данные под его ключом остались): варианты
   * восстановления, новый сейф — только осознанно. */
  vaultCorruptView() {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { Vault } = this.vaultMod();
    const c = Vault.corrupt || {};
    const err = h("div", { class: "w-error", hidden: "true" });
    const run = (btn, fn) => async () => {
      btn.disabled = true;
      err.hidden = true;
      try {
        await fn();
      } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
      } finally {
        btn.disabled = false;
      }
    };
    const kids = [
      h("div", { class: "w-lock-mark" }, null, [this.wIcon(["M12 9v4", "M12 17h.01", "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"], 22, 1.8)]),
      h("b", {}, c.missing ? "Файл сейфа пропал" : "Файл сейфа повреждён"),
      h("p", { class: "w-sub" }, `Причина: ${c.reason || "неизвестна"}. ${c.movedTo ? `Файл сохранён рядом как ${PathUtils.filename(c.movedTo)}. ` : ""}${c.missing && !c.backup ? "Если у вас есть копия файла tabora-vault.json, закройте браузер и верните её в папку профиля. " : ""}Пароли сайтов и коды недоступны, пока вы не выберете, как восстановиться.`),
      err,
    ];
    if (c.backup) {
      const b = this.wButton("Восстановить из запасной копии", "primary", () => {});
      b.addEventListener("click", run(b, async () => {
        await Vault.restoreBackup();
        this.notice("Сейф восстановлен из запасной копии");
      }));
      kids.push(b);
    }
    if (c.backup?.rk || c.salvage?.rk) {
      kids.push(this.wButton("Восстановить ключом восстановления", c.backup ? "ghost" : "primary", () => {
        const key = this.wField("Ключ восстановления", { placeholder: "XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX", autocomplete: "off", spellcheck: "false" });
        this.vaultSheet("Восстановление сейфа", "Ключ восстановления откроет прежний ключ сейфа: пароли и коды снова станут доступны. Затем задайте мастер-пароль.", [key.wrap], "Восстановить", async () => {
          const recoveryKey = key.input.value;
          await Vault.recoverCorrupt(recoveryKey);
          this.notice("Сейф восстановлен ключом восстановления");
          setTimeout(() => this.vaultPasswordSheet({ reset: true, recoveryKey }), 400);
        });
      }));
    }
    kids.push(this.wButton("Создать новый сейф", "ghost danger", () => {
      this.vaultSheet(
        "Создать новый сейф",
        "Пароли сайтов, коды и почта, зашифрованные прежним ключом, станут недоступны. Их файлы не удаляются: они сохранятся рядом с пометкой vault-lost, и если найдётся прежний файл сейфа, их можно будет вернуть.",
        [],
        "Создать новый",
        async () => {
          await Vault.startOverAfterCorrupt();
          this.notice("Создан новый сейф");
        }
      );
    }));
    kids.push(h("p", { class: "w-hint" }, "Новый ключ браузер сам не создаёт: иначе прежние данные пропали бы молча."));
    return h("div", { class: "w-locked" }, null, kids);
  },

  otpMod() {
    if (!this._otpMod) {
      this._otpMod = ChromeUtils.importESModule("chrome://tabora/content/vault/Otp.sys.mjs");
      const topic = this._otpMod.Otp.TOPIC;
      // Отметка «код использован» список не перерисовывает: иначе после копирования все коды
      // на секунду сменялись точками, а строка уезжала из-под курсора наверх. Новый порядок
      // (последние использованные сверху) применится при следующем открытии раздела.
      const observer = () => {
        if (!this.codes.touching) {
          this.drawerDirty("codes");
        }
      };
      Services.obs.addObserver(observer, topic);
      window.addEventListener("unload", () => Services.obs.removeObserver(observer, topic), { once: true });
    }
    return this._otpMod;
  },

  /** Актор страницы: ссылки otpauth:// и пиксели картинок для QR; пункт в меню картинки.
   * Только веб-страницы: внутренние страницы и файлы актор не получают. */
  initVaultActor() {
    try {
      ChromeUtils.registerWindowActor("TaboraVault", {
        parent: { esModuleURI: "chrome://tabora/content/actors/TaboraVaultParent.sys.mjs" },
        child: {
          esModuleURI: "chrome://tabora/content/actors/TaboraVaultChild.sys.mjs",
          events: { click: { capture: true }, focusin: { capture: true }, focusout: { capture: true }, keydown: { capture: true } },
        },
        matches: ["https://*/*", "http://*/*"],
        allFrames: true,
        messageManagerGroups: ["browsers"],
        safeForUntrustedWebProcess: true,
        remoteTypes: ["web"],
      });
    } catch (e) {
      // уже зарегистрирован другим окном
    }
    this.otpInitContextMenu();
  },

  /* ---- Список кодов ---------------------------------------------------- */

  otpSitesText(e) {
    return (e.sites || []).map(s => (s.sub ? `${s.host} и поддомены` : s.host)).join(", ");
  },

  codesMainView() {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { Otp } = this.otpMod();
    const q = (this.drawer.query || "").toLowerCase();
    const entries = Otp.list()
      .filter(e => !q || `${e.issuer} ${e.account} ${(e.sites || []).map(s => s.host).join(" ")}`.toLowerCase().includes(q))
      .sort((a, b) => (b.usedAt || 0) - (a.usedAt || 0) || (a.issuer || a.account).localeCompare(b.issuer || b.account, "ru"));
    const add = this.wButton("Добавить", "primary small", e => this.otpAddMenu(e.currentTarget));
    if (Otp.loadError) {
      add.disabled = true;
    }
    const head = h("div", { class: "otp-head" }, null, [h("b", {}, "Коды"), add]);
    const list = h("div", { class: "otp-list" }, null, entries.map(e => this.otpRow(e)));
    const empty = this.drawerEmpty(q ? "Ничего не найдено" : "Кодов пока нет", q ? "" : "Добавьте код: с QR на странице, по ссылке otpauth:// или вручную");
    const body = h("div", { class: "w-settings" }, null, [head, Otp.loadError ? this.otpCorruptCard() : null, entries.length ? list : empty, this.accountCard(), this.vaultCard()].filter(Boolean));
    if (entries.length) {
      this.otpStartTicking();
      if (Date.now() - Otp.clockCheckedAt > 86400000) {
        Otp.checkClock().then(r => {
          if (r.applied) {
            this.notice(`Часы компьютера расходятся с сетью на ${Math.round(r.offset / 1000)} с: коды считаются с поправкой`);
          }
        }).catch(() => {});
      }
    }
    return body;
  },

  /** Файл кодов повреждён: он перенесён в сторону, новые коды не пишутся, пока пользователь не решит. */
  otpCorruptCard() {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { Otp } = this.otpMod();
    const c = Otp.loadError;
    const actions = [];
    if (c.backup) {
      actions.push(this.wButton("Восстановить из копии", "primary small", async () => {
        try {
          await Otp.restoreBackup();
          this.notice("Коды восстановлены из запасной копии");
        } catch (e) {
          this.notice(e.message);
        }
      }));
    }
    actions.push(this.wButton("Начать список заново", "ghost small", () => {
      this.vaultSheet("Начать список кодов заново", "Записи из повреждённого файла в списке не появятся. Сам файл остаётся рядом, его можно будет разобрать вручную.", [], "Начать заново", async () => {
        await Otp.startFresh();
        this.notice("Список кодов начат заново");
      });
    }));
    return h("div", { class: "w-group" }, null, [
      h("b", { class: "w-group-title" }, c.missing ? "Файл кодов пропал" : "Файл кодов повреждён"),
      h("p", { class: "w-hint" }, `Причина: ${c.reason}. ${c.movedTo ? `Файл сохранён как ${PathUtils.filename(c.movedTo)}. ` : ""}Пока вы не выберете, что делать, новые коды не сохраняются.`),
      h("div", { class: "w-actions" }, null, actions),
    ]);
  },

  otpRow(e) {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const site = e.sites?.[0]?.host;
    const icon = h("span", { class: "otp-icon" }, site ? null : (e.issuer || e.account || "?")[0].toUpperCase(), site ? [h("img", { src: `page-icon:https://${site}/`, alt: "" })] : []);
    const title = e.issuer || e.account;
    const sitesText = this.otpSitesText(e);
    const invalid = e.valid === false;
    const sub = invalid ? "запись изменена вне браузера: код не выдаётся" : e.issuer ? e.account || sitesText : sitesText;
    // при перерисовке списка строка сразу показывает последний известный код, а не заглушку
    const known = this.codes.shown?.get(e.id);
    const code = h("span", { class: "otp-code" }, invalid ? "—" : known?.text || "··· ···");
    const ring = h("span", { class: "otp-ring", style: `--p:${known?.p ?? 100}` });
    const row = h("div", { class: `otp-row${invalid ? " invalid" : ""}`, tabindex: "0", "data-id": e.id, title: invalid ? "Подпись записи не сходится: её изменили вне браузера. Удалите запись и добавьте код заново" : "Нажмите, чтобы скопировать код" }, null, [
      icon, h("div", { class: "otp-text" }, null, [h("b", {}, title), h("span", {}, sub)]), code, ring,
    ]);
    if (invalid) {
      row.removeAttribute("data-id");
      row.dataset.invalidId = e.id;
    } else {
      row.addEventListener("click", () => this.otpCopy(e.id, row));
      row.addEventListener("keydown", ev => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          this.otpCopy(e.id, row);
        }
      });
    }
    row.addEventListener("contextmenu", ev => {
      ev.preventDefault();
      ev.stopPropagation();
      this.showMenu(this.otpRowMenu(e), ev.clientX, ev.clientY);
    });
    return row;
  },

  otpFmt(code) {
    const s = String(code || "");
    return s.length === 6 ? `${s.slice(0, 3)} ${s.slice(3)}` : s.length === 8 ? `${s.slice(0, 4)} ${s.slice(4)}` : s;
  },

  /** Живые коды: раз в секунду, пока раздел открыт. */
  otpStartTicking() {
    clearInterval(this.codes.timer);
    const tick = async () => {
      const d = this.drawer;
      if (!d.open || d.section !== "codes") {
        clearInterval(this.codes.timer);
        this.codes.timer = null;
        return;
      }
      const { Otp } = this.otpMod();
      if (!this.vaultMod().Vault.unlocked) {
        return;
      }
      for (const row of d.body.querySelectorAll(".otp-row[data-id]")) {
        try {
          const c = await Otp.code(row.dataset.id);
          const text = this.otpFmt(c.code);
          const p = Math.round((c.remaining / c.period) * 100);
          (this.codes.shown ||= new Map()).set(row.dataset.id, { text, p });
          row.querySelector(".otp-code").textContent = text;
          row.querySelector(".otp-ring").style.setProperty("--p", String(p));
          row.classList.toggle("ending", c.remaining <= 5);
          row.title = `Действует ещё ${c.remaining} с · следующий ${this.otpFmt(c.next)} · нажмите, чтобы скопировать`;
        } catch (err) {
          row.querySelector(".otp-code").textContent = "—";
        }
      }
    };
    // первый проход — после того как новые строки встанут в ящик (список строится до вставки)
    queueMicrotask(tick);
    this.codes.timer = setInterval(tick, 1000);
  },

  async otpCopy(id, row) {
    const { Otp } = this.otpMod();
    try {
      const c = await Otp.code(id);
      const useNext = c.remaining <= 3; // на излёте периода копируем следующий, чтобы код не протух при вводе
      this.copyWithExpiry(useNext ? c.next : c.code, 30000);
      row?.classList.add("copied");
      setTimeout(() => row?.classList.remove("copied"), 1200);
      this.notice(useNext ? "Скопирован следующий код: текущий истекает" : "Код скопирован · буфер очистится через 30 с");
      this.codes.touching = true;
      Otp.touch(id).catch(() => {}).finally(() => setTimeout(() => (this.codes.touching = false), 0));
    } catch (e) {
      this.notice(e.message);
    }
  },

  /** Копирование секрета с автоочисткой: данные помечаются как чувствительные (менеджеры буфера
   * и история буфера их не сохраняют), буфер стирается, если там всё ещё наш текст. */
  copyWithExpiry(text, ms) {
    const helper = Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper);
    helper.copyString(text, null, Ci.nsIClipboardHelper.Sensitive);
    clearTimeout(this._clipTimer);
    this._clipTimer = setTimeout(() => {
      if (this.readClipboard() === text) {
        helper.copyString("", null, Ci.nsIClipboardHelper.Sensitive);
      }
    }, ms);
  },

  readClipboard() {
    try {
      const trans = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
      trans.init(null);
      trans.addDataFlavor("text/plain");
      Services.clipboard.getData(trans, Services.clipboard.kGlobalClipboard, window.browsingContext?.currentWindowContext);
      const data = {};
      trans.getTransferData("text/plain", data);
      return data.value?.QueryInterface(Ci.nsISupportsString)?.data ?? "";
    } catch (e) {
      return null;
    }
  },

  /* ---- Добавление ---------------------------------------------------------- */

  otpAddMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    this.showMenu([
      { label: "Найти QR на этой странице", icon: ["M4 4h6v6H4z", "M14 4h6v6h-6z", "M4 14h6v6H4z", "M14 14h3v3h-3z", "M20 20h-3"], run: () => this.otpScanPage() },
      { label: "Сканировать с экрана", icon: ["M4 8V5a1 1 0 0 1 1-1h3", "M16 4h3a1 1 0 0 1 1 1v3", "M20 16v3a1 1 0 0 1-1 1h-3", "M8 20H5a1 1 0 0 1-1-1v-3"], run: () => this.otpScanScreen() },
      { separator: true },
      { label: "Импорт из файла (Google Authenticator, Aegis, 2FAS)", icon: ["M12 4v11", "M7 10l5 5 5-5", "M4 19h16"], run: () => this.otpImportFile() },
      { label: "Вставить ссылку otpauth://", icon: ["M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1", "M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"], run: () => this.otpLinkSheet() },
      { label: "Ввести вручную", icon: ["M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17z", "M13.5 6.5l3 3"], run: () => this.otpManualSheet() },
    ], r.left, r.bottom + 4);
  },

  otpParamSelects(prefill = {}) {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const sel = (label, values, current, fmt = v => String(v)) => {
      const s = h("select", { class: "w-input" }, null, values.map(v => {
        const o = h("option", { value: String(v) }, fmt(v));
        if (String(v) === String(current)) {
          o.selected = true;
        }
        return o;
      }));
      return { wrap: h("label", { class: "w-field" }, null, [h("span", {}, label), s]), select: s };
    };
    const digits = sel("Цифр", [6, 7, 8], prefill.digits || 6);
    const period = sel("Период", [15, 30, 60, 90, 120], prefill.period || 30, v => `${v} с`);
    const algorithm = sel("Алгоритм", ["SHA1", "SHA256", "SHA512"], prefill.algorithm || "SHA1");
    const box = h("details", { class: "w-details" }, null, [h("summary", {}, "Параметры (обычно менять не нужно)"), h("div", { class: "otp-advanced" }, null, [digits.wrap, period.wrap, algorithm.wrap])]);
    if (prefill.digits && prefill.digits !== 6 || prefill.period && prefill.period !== 30 || prefill.algorithm && prefill.algorithm !== "SHA1") {
      box.open = true;
    }
    return { box, read: () => ({ digits: Number(digits.select.value), period: Number(period.select.value), algorithm: algorithm.select.value }) };
  },

  /** Поле сайтов и галочка «на всех поддоменах». По умолчанию подсказка с кодом появляется
   * только на точном адресе; поддомены — только если пользователь отметил это сам. */
  otpSitesFields(sites = [], label = "Сайт, где спрашивают код") {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { Otp } = this.otpMod();
    const field = this.wField(label, { placeholder: "github.com", value: sites.map(s => s.host).join(", "), autocomplete: "off", spellcheck: "false" });
    const sub = h("input", { type: "checkbox" });
    sub.checked = sites.some(s => s.sub);
    const subText = h("span", {}, "");
    const wrap = h("label", { class: "w-check" }, null, [sub, subText]);
    const update = () => {
      const first = Otp.normalizeHost(field.input.value.split(/[\s,;]+/)[0]);
      const base = first ? Otp.baseDomain(first) : "";
      subText.textContent = base ? `Также на всех адресах ${base} (например, accounts.${base})` : "Также на всех поддоменах";
    };
    field.input.addEventListener("input", update);
    update();
    const read = () => {
      const hosts = field.input.value.split(/[\s,;]+/).map(x => Otp.normalizeHost(x)).filter(Boolean);
      return Otp.normalizeSites(hosts.map(host => (sub.checked ? { host: Otp.baseDomain(host), sub: true } : { host, sub: false })));
    };
    return { field, wrap, nodes: [field.wrap, wrap], read };
  },

  otpManualSheet(prefill = {}) {
    const { Otp } = this.otpMod();
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const issuer = this.wField("Сервис", { placeholder: "GitHub", value: prefill.issuer || "" });
    const account = this.wField("Аккаунт", { placeholder: "you@example.com", value: prefill.account || "" });
    const secret = this.wField("Секрет (Base32)", { placeholder: "JBSW Y3DP EHPK 3PXP", value: prefill.secret || "", autocomplete: "off", spellcheck: "false" });
    const sites = this.otpSitesFields(prefill.sites || []);
    issuer.input.addEventListener("input", () => {
      if (!sites.field.input.value) {
        const g = Otp.guessSites(issuer.input.value);
        if (g.length) {
          sites.field.input.value = g.map(s => s.host).join(", ");
          sites.field.input.dispatchEvent(new Event("input"));
        }
      }
    });
    const params = this.otpParamSelects(prefill);
    this.vaultSheet(
      prefill.secret ? "Добавить код" : "Новый код",
      prefill.secret ? "Проверьте название и сайт: подсказка с кодом появится только на нём." : null,
      [issuer.wrap, account.wrap, secret.wrap, ...sites.nodes, h("p", { class: "w-hint" }, "Подсказка с кодом появится только на указанном адресе и только по https. Если вход на сервис идёт с другого адреса того же сайта, отметьте «Также на всех адресах»."), params.box],
      "Сохранить",
      async () => {
        const meta = await Otp.add({ issuer: issuer.input.value, account: account.input.value, secret: secret.input.value, sites: sites.read(), ...params.read() });
        this.notice(`Код «${meta.issuer || meta.account}» добавлен`);
      }
    );
  },

  otpLinkSheet() {
    const link = this.wField("Ссылка", { placeholder: "otpauth://totp/…", autocomplete: "off", spellcheck: "false" });
    this.vaultSheet(
      "Код по ссылке",
      "Сайты дают её под QR-кодом, обычно по ссылке «не можете отсканировать?».",
      [link.wrap],
      "Далее",
      async () => {
        const parsed = this.otpMod().parseOtpauth(link.input.value);
        setTimeout(() => this.otpManualSheet(parsed), 0);
      }
    );
  },

  /** Хост страницы для привязки кода: только https, иначе привязку подставлять нельзя. */
  otpPageHost(uri) {
    try {
      return uri?.schemeIs("https") ? uri.asciiHost.toLowerCase() : "";
    } catch (e) {
      return "";
    }
  },

  /** Ссылка otpauth:// со страницы или из QR: лист добавления, только для активной вкладки.
   * host — точный хост https-страницы, где показан QR (родитель берёт его из адреса вкладки). */
  otpAddFromUrl(url, { host = "", browser = null } = {}) {
    const tab = browser && gBrowser.getTabForBrowser(browser);
    if (tab && tab !== gBrowser.selectedTab) {
      return;
    }
    const { Otp, parseOtpauth, parseMigration } = this.otpMod();
    if (/^otpauth-migration:/i.test(url)) {
      try {
        this.otpImportSheet(parseMigration(url), "Экспорт Google Authenticator");
      } catch (e) {
        this.notice(e.message);
      }
      return;
    }
    let parsed;
    try {
      parsed = parseOtpauth(url);
    } catch (e) {
      this.notice(e.message);
      return;
    }
    parsed.sites = host ? Otp.normalizeSites([host]) : [];
    if (!parsed.sites.length) {
      parsed.sites = Otp.guessSites(parsed.issuer);
    }
    this.openDrawer("codes");
    setTimeout(async () => {
      const { Vault } = this.vaultMod();
      await Vault.ready();
      if (!Vault.exists || !Vault.unlocked) {
        this.notice(Vault.exists ? "Разблокируйте сейф и повторите" : "Создайте сейф и повторите");
        return;
      }
      await Otp.ready();
      this.otpManualSheet(parsed);
    }, 350);
  },

  /* ---- QR ------------------------------------------------------------------- */

  /** Текст QR. От страницы принимаются только готовые пиксели в оттенках серого (их растеризует
   * процесс страницы, см. TaboraVaultChild): разметку и картинки страницы родитель не декодирует.
   * PNG декодируется только для своего снимка экрана (screen: true). */
  async otpDecodeImage(data) {
    const { jsQR } = ChromeUtils.importESModule("chrome://tabora/content/vault/vendor/qr.sys.mjs");
    if (data?.gray) {
      const w = Number(data.w);
      const h = Number(data.h);
      const gray = data.gray;
      if (!Number.isInteger(w) || !Number.isInteger(h) || w < 16 || h < 16 || w > OTP_QR_MAX_SIDE || h > OTP_QR_MAX_SIDE || !ArrayBuffer.isView(gray) || gray.length !== w * h) {
        return null;
      }
      const rgba = new Uint8ClampedArray(w * h * 4);
      for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
        const v = gray[i];
        rgba[j] = v;
        rgba[j + 1] = v;
        rgba[j + 2] = v;
        rgba[j + 3] = 255;
      }
      return jsQR(rgba, w, h, { inversionAttempts: "attemptBoth" })?.data || null;
    }
    if (!data?.screen || !/^data:image\/png;base64,/.test(data.dataURL || "")) {
      return null;
    }
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error("image"));
      img.src = data.dataURL;
    });
    const w0 = img.naturalWidth;
    const h0 = img.naturalHeight;
    if (!w0 || !h0 || w0 * h0 > 40_000_000) {
      return null;
    }
    // снимок экрана большой: сначала уменьшенная копия (быстро), затем полный размер
    const scales = w0 * h0 > 2_000_000 ? [0.5, 1] : [1];
    for (const scale of scales) {
      const w = Math.round(w0 * scale);
      const h = Math.round(h0 * scale);
      const canvas = this.html("canvas", { width: String(w), height: String(h) });
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      const px = ctx.getImageData(0, 0, w, h);
      const found = jsQR(px.data, w, h, { inversionAttempts: "attemptBoth" });
      if (found?.data) {
        return found.data;
      }
    }
    return null;
  },

  async otpScanPage() {
    const browser = gBrowser.selectedBrowser;
    let images = [];
    try {
      images = (await browser.browsingContext.currentWindowGlobal.getActor("TaboraVault").sendQuery("TaboraVault:PageImages")) || [];
    } catch (e) {
      this.notice("Не удалось прочитать картинки страницы");
      return;
    }
    const host = this.otpPageHost(browser.currentURI);
    for (const data of images.slice(0, 32)) {
      const text = await this.otpDecodeImage(data).catch(() => null);
      if (text && /^otpauth(-migration)?:\/\//i.test(text)) {
        this.otpAddFromUrl(text, { host });
        return;
      }
    }
    this.notice(images.length ? `QR с кодом не найден (картинок проверено: ${images.length})` : "На странице нет подходящих картинок");
  },

  /** Снимок области экрана системным выделением (как ⌘⇧4): QR из любого приложения. */
  async otpScanScreen() {
    const path = PathUtils.join(PathUtils.tempDir, `tabora-qr-${Date.now()}.png`);
    try {
      const bin = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      bin.initWithPath("/usr/sbin/screencapture");
      if (!bin.exists()) {
        this.notice("Захват экрана доступен только на macOS");
        return;
      }
      const proc = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
      proc.init(bin);
      const args = ["-i", "-x", "-t", "png", path];
      await new Promise(resolve => proc.runAsync(args, args.length, { observe: () => resolve() }));
      if (!(await IOUtils.exists(path))) {
        return; // выделение отменено (Esc)
      }
      const bytes = await IOUtils.read(path);
      let bin64 = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin64 += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      const text = await this.otpDecodeImage({ dataURL: `data:image/png;base64,${btoa(bin64)}`, screen: true });
      if (text && /^otpauth(-migration)?:\/\//i.test(text)) {
        this.otpAddFromUrl(text, { host: this.otpPageHost(gBrowser.selectedBrowser?.currentURI) });
      } else {
        this.notice(text ? "В этом QR нет кода аутентификатора" : "QR-код в выделенной области не распознан");
      }
    } catch (e) {
      this.notice(`Захват экрана не удался: ${e.message}`);
    } finally {
      IOUtils.remove(path, { ignoreAbsent: true }).catch(() => {});
    }
  },

  /** Импорт файла экспорта другого аутентификатора. */
  otpImportFile() {
    const fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    fp.init(window.browsingContext, "Импорт кодов", Ci.nsIFilePicker.modeOpen);
    fp.appendFilter("Экспорт аутентификатора", "*.json; *.txt; *.2fas");
    fp.appendFilters(Ci.nsIFilePicker.filterAll);
    fp.open(async rv => {
      if (rv !== Ci.nsIFilePicker.returnOK || !fp.file) {
        return;
      }
      try {
        const text = await IOUtils.readUTF8(fp.file.path);
        this.otpImportSheet(this.otpMod().parseImportText(text), fp.file.leafName);
      } catch (e) {
        this.notice(e.message);
      }
    });
  },

  /** Предпросмотр импорта: что добавится, что пропущено. */
  otpImportSheet({ entries, skipped }, source) {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { Otp } = this.otpMod();
    if (!entries.length) {
      this.notice(skipped.length ? `Нечего импортировать: ${skipped[0]}` : "Нечего импортировать");
      return;
    }
    const list = h("ul", { class: "w-points" }, null, entries.slice(0, 8).map(e => h("li", {}, `${e.issuer || "—"} · ${e.account || ""}`.trim())));
    if (entries.length > 8) {
      list.append(h("li", {}, `…и ещё ${entries.length - 8}`));
    }
    const body = [list];
    if (skipped.length) {
      body.push(h("p", { class: "w-hint" }, `Пропущено ${skipped.length}: ${skipped.slice(0, 3).join("; ")}${skipped.length > 3 ? "…" : ""}`));
    }
    body.push(h("p", { class: "w-hint" }, "Сайт для подсказки подставится, только если издатель записан как домен (github.com). Остальным сайт можно указать потом: «Название и сайт»."));
    this.vaultSheet(`Импорт: ${source}`, `Записей для добавления: ${entries.length}. Повторы будут пропущены.`, body, "Импортировать", async () => {
      const r = await Otp.addMany(entries);
      this.notice(`Добавлено ${r.added}${r.skipped ? `, повторов ${r.skipped}` : ""}${r.errors.length ? `, ошибок ${r.errors.length}` : ""}`);
    });
  },

  /** Пункт «Добавить код в аутентификатор» в системном меню картинки. */
  otpInitContextMenu() {
    // меню страницы создаётся из шаблона лениво, поэтому слушаем документ, а не само меню
    const item = document.createXULElement("menuitem");
    item.id = "tabora-otp-image";
    item.setAttribute("label", "Добавить код в аутентификатор");
    item.addEventListener("command", () => this.otpFromContextImage());
    document.addEventListener("popupshowing", e => {
      const menu = e.target;
      if (menu.id !== "contentAreaContextMenu") {
        return;
      }
      const show = !!window.gContextMenu?.onImage;
      item.hidden = !show;
      if (show) {
        const anchor = document.getElementById("context-copyimage") || document.getElementById("context-copyimage-contents");
        if (anchor?.parentNode === menu) {
          anchor.after(item);
        } else {
          menu.append(item);
        }
      }
    });
  },

  async otpFromContextImage() {
    const gc = window.gContextMenu;
    if (!gc?.actor || !gc.targetIdentifier) {
      return;
    }
    const host = this.otpPageHost(gc.browser?.currentURI);
    try {
      const actor = gc.actor.manager.getActor("TaboraVault");
      const data = await actor.sendQuery("TaboraVault:ImageData", { targetIdentifier: gc.targetIdentifier });
      const text = data ? await this.otpDecodeImage(data) : null;
      if (text && /^otpauth(-migration)?:\/\//i.test(text)) {
        this.otpAddFromUrl(text, { host });
      } else {
        this.notice(text ? "В этом QR нет кода аутентификатора" : "QR-код не распознан");
      }
    } catch (e) {
      this.notice("Не удалось прочитать картинку");
    }
  },

  /* ---- Подсказка в поле одноразового кода -----------------------------------------
   * Хост берёт родительская часть актора из принципала документа (только https, тот же
   * сайт, что и вкладка), а не из сообщения страницы. Код вставляется только по настоящему
   * клику по подсказке или по Enter, который увидело окно браузера, и не раньше чем через
   * OTP_POP_ARM_MS после показа. Фокус на поле сейф не открывает: в заблокированном состоянии
   * подсказка предлагает «Разблокировать». */

  otpPop: { el: null, actor: null, browser: null, data: null, entries: [], active: 0, timer: null, host: "", locked: false, shownAt: 0, downAt: 0, key: null },

  /** Поле кода получило фокус: показываем коды сайта (только активная вкладка, только совпадающий хост). */
  async otpFieldFocused(data, actor) {
    const browser = actor.browsingContext?.top?.embedderElement;
    if (!browser || browser !== gBrowser.selectedBrowser || !data?.host) {
      return;
    }
    const { Vault } = this.vaultMod();
    const { Otp } = this.otpMod();
    await Vault.ready();
    if (!Vault.exists) {
      return;
    }
    await Otp.ready();
    const entries = Otp.forHost(data.host);
    if (!entries.length || browser !== gBrowser.selectedBrowser) {
      return;
    }
    const pop = this.otpPop;
    const fresh = pop.actor !== actor || pop.el?.hidden !== false;
    pop.actor = actor;
    pop.browser = browser;
    pop.data = data;
    pop.host = data.host;
    pop.locked = !Vault.unlocked;
    pop.entries = pop.locked ? [] : entries;
    pop.active = 0;
    pop.maxLength = data.maxLength || 0;
    this.otpPopRender(browser, data.rect, data.zoom || 1, { fresh });
    if (!pop.locked) {
      actor.sendAsyncMessage("TaboraVault:Arm", { armed: true });
    }
  },

  /** Сейф разблокирован, пока подсказка показывала «Разблокировать»: показать коды. */
  otpPopRefresh() {
    const pop = this.otpPop;
    if (pop.el && !pop.el.hidden && pop.locked && pop.actor && pop.data) {
      this.otpFieldFocused(pop.data, pop.actor).catch(e => console.error("Tabora otp", e));
    }
  },

  otpFieldBlurred(actor) {
    if (this.otpPop.actor === actor) {
      this.otpPopHide();
    }
  },

  otpPopEl() {
    let el = this.otpPop.el;
    if (!el) {
      const h = (t, a, x, c) => this.html(t, a, x, c);
      el = h("div", { id: "tabora-otp-pop", role: "listbox", hidden: "true" });
      document.getElementById("browser").append(el);
      el.addEventListener("pointerdown", e => {
        e.preventDefault(); // не отбираем фокус у поля
        if (e.isTrusted) {
          this.otpPop.downAt = performance.now();
        }
      });
      window.addEventListener("pointerdown", e => {
        if (!el.hidden && !el.contains(e.target)) {
          this.otpPopHide();
        }
      }, true);
      gBrowser.tabContainer.addEventListener("TabSelect", () => this.otpPopHide());
      window.addEventListener("blur", () => this.otpPopHide());
      this.otpPop.el = el;
    }
    return el;
  },

  /** Клик по подсказке засчитывается, только если нажатие началось после того, как подсказка
   * простояла на экране OTP_POP_ARM_MS: так её нельзя подсунуть под уже летящий клик. */
  otpPopClickOk(ev) {
    const pop = this.otpPop;
    return ev.isTrusted && pop.downAt - pop.shownAt >= OTP_POP_ARM_MS;
  },

  otpPopRender(browser, rect, zoom, { fresh = true } = {}) {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const pop = this.otpPop;
    const el = this.otpPopEl();
    el.replaceChildren(h("div", { class: "otp-pop-head" }, null, [h("span", {}, "Код для "), h("b", {}, pop.host)]));
    if (pop.locked) {
      const row = h("div", { class: "otp-pop-row otp-pop-unlock", role: "option" }, null, [
        h("span", { class: "otp-icon" }, null, [this.wIcon(["M7 11V8a5 5 0 0 1 10 0v3", "M5 11h14v10H5z"], 15, 1.8)]),
        h("div", { class: "otp-text" }, null, [h("b", {}, "Разблокировать сейф"), h("span", {}, "Для этого сайта есть коды")]),
      ]);
      row.addEventListener("click", ev => {
        if (!this.otpPopClickOk(ev)) {
          return;
        }
        // системный диалог Touch ID уводит фокус окна и прячет подсказку: после разблокировки
        // показываем коды для того же поля заново
        const saved = { data: pop.data, actor: pop.actor };
        this.vaultUnlockByUser().then(ok => {
          if (ok && saved.actor) {
            return this.otpFieldFocused(saved.data, saved.actor);
          }
          return null;
        }).catch(e => this.notice(e.message));
      });
      el.append(row, h("div", { class: "otp-pop-hint" }, "Сейф заблокирован: подсказка сама его не открывает"));
    } else {
      pop.entries.forEach((e, i) => {
        const site = e.sites?.[0]?.host;
        const note = e.match === "sub" ? `запись для всех адресов ${(e.sites.find(s => s.sub && pop.host.endsWith(`.${s.host}`)) || e.sites[0]).host}` : e.issuer ? e.account || "" : "";
        const row = h("div", { class: `otp-pop-row${i === pop.active ? " active" : ""}`, role: "option", "data-id": e.id }, null, [
          h("span", { class: "otp-icon" }, site ? null : (e.issuer || e.account || "?")[0].toUpperCase(), site ? [h("img", { src: `page-icon:https://${site}/`, alt: "" })] : []),
          h("div", { class: "otp-text" }, null, [h("b", {}, e.issuer || e.account), h("span", { class: e.match === "sub" ? "otp-pop-note" : "" }, note)]),
          h("span", { class: "otp-code" }, "··· ···"),
          h("span", { class: "otp-ring", style: "--p:100" }),
        ]);
        row.addEventListener("click", ev => {
          if (!this.otpPopClickOk(ev)) {
            return;
          }
          pop.active = i;
          this.otpPopInsert();
        });
        row.addEventListener("mouseenter", () => this.otpPopSetActive(i));
        el.append(row);
      });
      el.append(h("div", { class: "otp-pop-hint" }, "Enter — вставить код · Esc — закрыть · форма не отправляется"));
    }
    el.hidden = false;
    if (fresh) {
      pop.shownAt = performance.now();
      pop.downAt = 0;
      pop.key = null;
    }
    // координаты поля страницы → координаты окна: масштаб страницы и смещение области браузера
    const b = browser.getBoundingClientRect();
    const root = document.getElementById("browser").getBoundingClientRect();
    const x = b.left - root.left + rect.x * zoom;
    const yTop = b.top - root.top + rect.y * zoom;
    const yBottom = yTop + rect.h * zoom;
    el.style.left = `${Math.max(8, Math.min(x, root.width - el.offsetWidth - 8))}px`;
    const below = yBottom + 6;
    const fits = below + el.offsetHeight <= root.height - 8;
    el.style.top = `${fits ? below : Math.max(8, yTop - el.offsetHeight - 6)}px`;
    clearInterval(pop.timer);
    if (!pop.locked) {
      this.otpPopTick();
      pop.timer = setInterval(() => this.otpPopTick(), 1000);
    }
  },

  async otpPopTick() {
    const pop = this.otpPop;
    const el = pop.el;
    if (!el || el.hidden) {
      clearInterval(pop.timer);
      pop.timer = null;
      return;
    }
    // документ, для которого показана подсказка, ушёл (навигация, закрытие) — прячем
    if (!this.otpPopDocOk()) {
      this.otpPopHide();
      return;
    }
    const { Otp } = this.otpMod();
    for (const row of el.querySelectorAll(".otp-pop-row[data-id]")) {
      try {
        const c = await Otp.code(row.dataset.id);
        row.querySelector(".otp-code").textContent = this.otpFmt(c.code);
        row.querySelector(".otp-ring").style.setProperty("--p", String(Math.round((c.remaining / c.period) * 100)));
        row.classList.toggle("ending", c.remaining <= 5);
      } catch (e) {
        row.querySelector(".otp-code").textContent = "—";
      }
    }
  },

  /** Документ подсказки всё ещё текущий, https и тот же хост. */
  otpPopDocOk() {
    const pop = this.otpPop;
    try {
      const wg = pop.actor.manager;
      if (pop.actor.browsingContext.currentWindowGlobal !== wg) {
        return false;
      }
      const p = wg.documentPrincipal;
      return !!p?.isContentPrincipal && p.schemeIs("https") && p.asciiHost.toLowerCase() === pop.host && pop.actor.browsingContext.top.embedderElement === gBrowser.selectedBrowser;
    } catch (e) {
      return false;
    }
  },

  /** Нажатие в окне браузера, адресованное странице с подсказкой. Окно видит его раньше страницы,
   * поэтому сообщение OtpAccept от страницы принимается только вместе с таким нажатием. */
  otpChromeKey(e) {
    const pop = this.otpPop;
    // фокус ввода в этой вкладке: событие адресовано её странице
    if (!pop.el || pop.el.hidden || !e.isTrusted || e.isReplyEventFromRemoteContent || !pop.browser || document.activeElement !== pop.browser) {
      return;
    }
    if (["Enter", "ArrowDown", "ArrowUp"].includes(e.key) && !e.repeat) {
      pop.key = { key: e.key, at: performance.now() };
    }
  },

  /** Настоящее ли это нажатие key: окно видело его недавно и после взвода подсказки. */
  otpPopTakeKey(keys) {
    const pop = this.otpPop;
    const k = pop.key;
    const now = performance.now();
    if (!k || !keys.includes(k.key) || now - k.at > OTP_KEY_FRESH_MS || k.at - pop.shownAt < OTP_POP_ARM_MS) {
      return false;
    }
    pop.key = null;
    return true;
  },

  otpPopSetActive(i) {
    const pop = this.otpPop;
    if (!pop.entries.length) {
      return;
    }
    pop.active = (i + pop.entries.length) % pop.entries.length;
    pop.el?.querySelectorAll(".otp-pop-row").forEach((r, k) => r.classList.toggle("active", k === pop.active));
  },

  otpPopMove(actor, delta) {
    if (this.otpPop.actor === actor && this.otpPop.entries.length && this.otpPopTakeKey(["ArrowDown", "ArrowUp"])) {
      this.otpPopSetActive(this.otpPop.active + delta);
    }
  },

  /** Enter в поле (сообщение страницы): вставляем, только если окно браузера видело этот Enter. */
  otpPopAccept(actor) {
    const pop = this.otpPop;
    if (!pop.el || pop.el.hidden || pop.actor !== actor || pop.locked || !this.otpPopTakeKey(["Enter"])) {
      return;
    }
    this.otpPopInsert();
  },

  /** Вставить активный код в поле: следующий код, если текущий вот-вот истечёт. */
  async otpPopInsert() {
    const pop = this.otpPop;
    const actor = pop.actor;
    const entry = pop.entries[pop.active];
    if (!entry || !actor || pop.locked || !this.otpPopDocOk()) {
      this.otpPopHide();
      return;
    }
    const { Otp } = this.otpMod();
    try {
      const c = await Otp.code(entry.id);
      const code = c.remaining <= 3 ? c.next : c.code;
      if (!this.otpPopDocOk()) {
        this.otpPopHide();
        return;
      }
      const ok = await actor.sendQuery("TaboraVault:FillOtp", { code });
      this.otpPopHide();
      if (ok) {
        Otp.touch(entry.id).catch(() => {});
      } else {
        this.notice("Поле кода больше недоступно");
      }
    } catch (e) {
      this.otpPopHide();
      this.notice(e.message);
    }
  },

  otpPopHide(actor) {
    const pop = this.otpPop;
    if (actor && pop.actor !== actor) {
      return;
    }
    if (pop.el) {
      pop.el.hidden = true;
      pop.el.replaceChildren();
    }
    clearInterval(pop.timer);
    pop.timer = null;
    try {
      pop.actor?.sendAsyncMessage("TaboraVault:Arm", { armed: false });
    } catch (e) {}
    pop.actor = null;
    pop.browser = null;
    pop.data = null;
    pop.entries = [];
    pop.key = null;
  },

  /* ---- Меню записи ------------------------------------------------------------ */

  otpRowMenu(e) {
    const { Otp } = this.otpMod();
    const items = [];
    if (e.valid !== false) {
      items.push(
        { label: "Копировать код", icon: ["M8 8h12v12H8z", "M16 8V4H4v12h4"], run: () => this.otpCopy(e.id) },
        { label: "Копировать следующий код", icon: ["M5 12h14", "m13 6 6 6-6 6"], run: async () => {
          try {
            const c = await Otp.code(e.id);
            this.copyWithExpiry(c.next, 30000);
            this.notice("Следующий код скопирован");
          } catch (err) {
            this.notice(err.message);
          }
        } },
        { separator: true },
        { label: "Название и сайт", icon: ["M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17z", "M13.5 6.5l3 3"], run: () => this.otpEditSheet(e) },
        { label: "Ссылка для переноса", icon: ["M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1", "M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"], run: () => this.vaultOwnerCheck("Ссылка для переноса", () => this.otpExportSheet(e)) },
        { separator: true }
      );
    }
    items.push({ label: "Удалить", icon: ["M4 7h16", "M10 11v6", "M14 11v6", "M6 7l1 12h10l1-12", "M9 7V4h6v3"], danger: true, run: () => this.otpDeleteSheet(e) });
    return items;
  },

  otpEditSheet(e) {
    const { Otp } = this.otpMod();
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const issuer = this.wField("Сервис", { value: e.issuer || "" });
    const account = this.wField("Аккаунт", { value: e.account || "" });
    const sites = this.otpSitesFields(e.sites || [], "Сайты через запятую");
    const legacy = (e.sites || []).some(s => s.legacy);
    const body = [issuer.wrap, account.wrap, ...sites.nodes];
    if (legacy) {
      body.push(h("p", { class: "w-hint" }, "Запись добавлена до уточнения сайтов и подходит для всех адресов домена. Укажите точный адрес входа и снимите галочку, чтобы код не показывался на других поддоменах."));
    }
    this.vaultSheet("Название и сайт", "Подсказка с кодом появляется только на указанных сайтах и только по https: на похожем домене кода не будет.", body, "Сохранить", async () => {
      await Otp.update(e.id, { issuer: issuer.input.value, account: account.input.value, sites: sites.read() });
    });
  },

  async otpExportSheet(e) {
    const { Otp } = this.otpMod();
    const h = (t, a, x, c) => this.html(t, a, x, c);
    let url;
    try {
      url = await Otp.otpauthUrl(e.id);
    } catch (err) {
      this.notice(err.message);
      return;
    }
    const pre = h("pre", { class: "v-secret", masked: "true" }, url);
    const reveal = this.wButton("Показать", "ghost small", () => {
      pre.toggleAttribute("masked");
      reveal.textContent = pre.hasAttribute("masked") ? "Показать" : "Скрыть";
    });
    const copy = this.wButton("Скопировать ссылку", "ghost small", () => {
      this.copyWithExpiry(url, 60000);
      this.notice("Ссылка скопирована · буфер очистится через минуту");
    });
    const box = this.vaultSheet("Ссылка для переноса", "В ней секрет кода. Вставьте её в другое приложение-аутентификатор и больше никому не показывайте.", [pre, h("div", { class: "w-actions" }, null, [reveal, copy])], "Готово", async () => {});
    box.classList.add("w-reveal"); // скрывается при потере фокуса окна, как фраза кошелька
  },

  otpDeleteSheet(e) {
    const { Otp } = this.otpMod();
    this.vaultSheet("Удалить код", `«${e.issuer || e.account}» исчезнет из браузера. Если у сервиса включена двухфакторная защита, отключите её заранее или сохраните ссылку для переноса.`, [], "Удалить", async () => {
      await Otp.remove(e.id);
      this.notice("Код удалён");
    });
  },

  /** Аккаунт Tabora, если модуль окна аккаунта загружен (account.js подключается после vault.js). */
  vaultAccount() {
    try {
      return this.accountMod?.().Account || null;
    } catch (e) {
      return null;
    }
  },

  /** Карточка состояния сейфа: как хранится ключ и что с этим делать. */
  vaultCard() {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { Vault } = this.vaultMod();
    const Account = this.vaultAccount();
    const row = (name, value, cls = "") => h("div", { class: `w-kv ${cls}`.trim() }, null, [h("span", {}, name), h("b", {}, value)]);
    const kids = [
      row("Связка ключей системы", Vault.hasOsKey && Vault.osUnlockEnabled ? "ключ сохранён · тихая разблокировка" : "не используется"),
      row("Мастер-пароль", Vault.hasPassword ? "задан · можно перенести на другой компьютер" : "не задан · только этот компьютер", Vault.hasPassword ? "" : "muted"),
    ];
    if (Account?.signedIn) {
      // пароль аккаунта и есть мастер-пароль: меняются вместе, иначе вход и сейф разойдутся
      kids.push(this.wButton("Сменить пароль аккаунта и сейфа", "ghost", () => this.accountDialog("change")));
    } else if (Vault.hasPassword) {
      kids.push(this.wButton("Сменить мастер-пароль", "ghost", () => this.vaultPasswordSheet()));
    } else {
      kids.push(this.wButton("Задать мастер-пароль", "ghost", () => this.vaultOwnerCheck("Задать мастер-пароль", async () => this.vaultPasswordSheet())));
    }
    if (Vault.hasPassword) {
      const title = Vault.osUnlockEnabled ? "Спрашивать мастер-пароль при запуске" : "Открывать тихо через связку ключей";
      kids.push(this.wButton(title, "ghost", () => this.vaultOwnerCheck(title, async () => {
        await Vault.setOsUnlock(!Vault.osUnlockEnabled);
        this.notice(Vault.osUnlockEnabled ? "Сейф снова открывается тихо через связку ключей" : "Сейф будет спрашивать мастер-пароль при запуске");
      })));
    }
    const rkAt = Vault.recoveryKeyCreatedAt;
    kids.push(row("Ключ восстановления", rkAt ? `создан ${new Date(rkAt).toLocaleDateString("ru-RU")} · откроет сейф без мастер-пароля` : "не создан · забытый мастер-пароль не восстановить", rkAt ? "" : "muted"));
    kids.push(this.wButton(rkAt ? "Создать новый ключ восстановления" : "Создать ключ восстановления", "ghost", () => this.vaultRecoveryCreateSheet()));
    if (rkAt) {
      kids.push(this.wButton("Отозвать ключ восстановления", "ghost", () => this.vaultOwnerCheck("Отзыв ключа восстановления", async password => {
        this.notice("Меняем ключ сейфа и перешифровываем данные…");
        const r = await Vault.revokeRecoveryKey({ password });
        await this.vaultAccount()?.registerRecoveryKey(null);
        this.notice(r.complete ? "Ключ восстановления отозван, ключ сейфа заменён" : "Ключ отозван; часть данных перешифруется при следующей разблокировке");
      })));
    }
    if (rkAt && Account?.signedIn && Account.recoveryNeedsUpgrade) {
      // на сервере лежит ключ проверки прежнего образца (общий секрет): заменить его открытым
      // ключом можно только с самим ключом восстановления, а он нигде не хранится
      kids.push(row("Сброс пароля аккаунта", "защищён по прежней схеме · создайте новый ключ восстановления, чтобы сервер хранил только открытый ключ", "muted"));
    }
    if (Vault.rekeyPending) {
      kids.push(row("Смена ключа", "не завершена · данные перешифруются при следующей разблокировке", "muted"));
    }
    kids.push(this.wButton("Заблокировать сейф", "ghost", () => {
      Vault.lock();
      this.notice(Vault.lockPending ? "Сейф заблокируется, как только закончится текущая операция с ключом" : "Сейф заблокирован: пароли сайтов и коды закрыты до проверки");
    }));
    const { Otp } = this.otpMod();
    const off = Otp.clockOffset;
    const checked = Otp.clockCheckedAt;
    const clockText = !checked ? "не сверялось" : off ? `поправка ${off > 0 ? "+" : "−"}${Math.round(Math.abs(off) / 1000)} с · часы компьютера ${off > 0 ? "отстают" : "спешат"}` : "совпадает с сетью";
    kids.push(row("Время для кодов", clockText, off ? "" : "muted"));
    kids.push(this.wButton("Сверить время с сетью", "ghost", async () => {
      try {
        const r = await Otp.checkClock();
        this.notice(r.applied ? `Часы расходятся на ${Math.round(r.offset / 1000)} с: коды считаются с поправкой` : "Время совпадает с сетью");
      } catch (e) {
        this.notice(e.message);
      }
    }));
    // карточка свёрнута по умолчанию: заголовок с короткой сводкой, подробности по клику
    const brief = [
      Vault.hasOsKey && Vault.osUnlockEnabled ? "открывается тихо" : "пароль при запуске",
      Vault.hasPassword ? "мастер-пароль" : "без мастер-пароля",
      rkAt ? "ключ восстановления" : "без ключа восстановления",
    ].join(" · ");
    const summary = h("summary", { class: "v-card-head" }, null, [
      h("b", { class: "w-group-title" }, "Сейф"),
      h("span", { class: "v-card-sub" }, brief),
      this.svg(["m6 9 6 6 6-6"], 14, 2.2),
    ]);
    const card = h("details", { class: "w-group v-card" }, null, [summary, h("div", { class: "v-card-body" }, null, kids)]);
    card.open = Services.prefs.getBoolPref("tabora.vault.cardOpen", false);
    card.addEventListener("toggle", () => Services.prefs.setBoolPref("tabora.vault.cardOpen", card.open));
    return card;
  },

  /* ---- Листы ---------------------------------------------------------------- */

  /** Пара полей пароля с повтором и оценкой стойкости; read() возвращает значение или бросает
   * ошибку. Слабый пароль не принимается (минимальная длина — 6 символов). */
  vaultPasswordFields(label = "Мастер-пароль") {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { Vault } = this.vaultMod();
    const pass = this.wField(label, { type: "password", autocomplete: "new-password", placeholder: `не короче ${Vault.MIN_PASSWORD} символов` });
    const meter = h("span", { class: "v-strength", "data-score": "0" }, "");
    pass.wrap.append(meter);
    pass.input.addEventListener("input", () => {
      const s = Vault.passwordStrength(pass.input.value);
      meter.dataset.score = String(s.score);
      meter.textContent = pass.input.value ? `Стойкость: ${s.label}` : "";
    });
    const again = this.wField("Повторите", { type: "password", autocomplete: "new-password" });
    const read = ({ optional = false } = {}) => {
      const a = pass.input.value;
      const b = again.input.value;
      if (optional && !a && !b) {
        return "";
      }
      Vault.checkNewPassword(a);
      if (a !== b) {
        throw new Error("Пароли не совпадают");
      }
      return a;
    };
    return { pass, again, read };
  },

  vaultSheet(title, text, body, okLabel, onOk) {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const err = h("div", { class: "w-error", hidden: "true" });
    const cancel = this.wButton("Отмена", "ghost", () => box.remove());
    const ok = this.wButton(okLabel, "primary", async () => {
      ok.disabled = true;
      err.hidden = true;
      try {
        await onOk();
        box.remove();
      } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
        ok.disabled = false;
      }
    });
    const card = h("div", { class: "w-sheet-card" }, null, [
      h("b", {}, title),
      text ? h("p", { class: "w-sub" }, text) : null,
      ...body,
      err,
      h("div", { class: "w-actions" }, null, [cancel, ok]),
    ].filter(Boolean));
    card.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Enter" && e.target.localName === "input" && e.target.type !== "checkbox") {
        ok.click();
      } else if (e.key === "Escape") {
        box.remove();
      }
    });
    const box = h("div", { class: "w-sheet" }, null, [card]);
    this.wSheetShow(box);
    setTimeout(() => card.querySelector("input:not([type=checkbox])")?.focus(), 50);
    return box;
  },

  /** Подтверждение владельца перед чувствительным действием: мастер-пароль, а без него — проверка
   * системы (Touch ID или пароль macOS). onOk получает проверенный мастер-пароль (или null):
   * он нужен, например, чтобы завернуть новый ключ при его смене. */
  vaultOwnerCheck(title, onOk) {
    const { Vault } = this.vaultMod();
    if (Vault.hasPassword) {
      const pass = this.wField("Мастер-пароль", { type: "password", autocomplete: "current-password" });
      this.vaultSheet(title, "Подтвердите, что это вы.", [pass.wrap], "Продолжить", async () => {
        const password = pass.input.value;
        await Vault.verifyPassword(password);
        setTimeout(() => Promise.resolve(onOk(password)).catch(e => this.notice(e.message)), 0);
      });
      return;
    }
    (async () => {
      const { OSKeyStore } = ChromeUtils.importESModule("resource://gre/modules/OSKeyStore.sys.mjs");
      const r = await OSKeyStore.ensureLoggedIn(`Tabora: ${title}`, "", window).catch(() => ({ authenticated: false }));
      if (!r?.authenticated) {
        this.notice("Подтверждение не пройдено");
        return;
      }
      await onOk(null);
    })().catch(e => this.notice(e.message));
  },

  /** Показать новый ключ восстановления один раз. */
  vaultShowRecoveryKey(key, { replaced = false } = {}) {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const pre = h("pre", { class: "v-secret", masked: "true" }, key);
    const reveal = this.wButton("Показать", "ghost small", () => {
      pre.toggleAttribute("masked");
      reveal.textContent = pre.hasAttribute("masked") ? "Показать" : "Скрыть";
    });
    const copy = this.wButton("Скопировать", "ghost small", () => {
      this.copyWithExpiry(key, 60000);
      this.notice("Ключ скопирован · буфер очистится через минуту");
    });
    const box = this.vaultSheet(
      "Ключ восстановления",
      `Запишите его и храните отдельно от компьютера. Он откроет сейф, если вы забудете мастер-пароль, и показывается только сейчас.${replaced ? " Ключ сейфа заменён: прежний ключ восстановления и старые копии файла сейфа больше ничего не открывают." : ""}`,
      [pre, h("div", { class: "w-actions" }, null, [reveal, copy]), h("p", { class: "w-hint" }, "Кто знает этот ключ, сможет открыть сейф на любом компьютере.")],
      "Я записал ключ",
      async () => {}
    );
    box.classList.add("w-reveal");
  },

  /** Новый ключ восстановления. Если прежний был, сейф меняет K и перешифровывает данные:
   * старый ключ (и копии файла с его обёрткой) перестают действовать. */
  vaultRecoveryCreateSheet() {
    const { Vault } = this.vaultMod();
    const replacing = Vault.hasRecoveryKey;
    this.vaultOwnerCheck(replacing ? "Новый ключ восстановления" : "Ключ восстановления", async password => {
      if (replacing) {
        this.notice("Меняем ключ сейфа и перешифровываем данные…");
      }
      const Account = this.vaultAccount();
      const key = Account ? await Account.createRecoveryKey({ password }) : await Vault.createRecoveryKey({ password });
      this.vaultShowRecoveryKey(key, { replaced: replacing });
    });
  },

  vaultRecoverySheet() {
    const { Vault } = this.vaultMod();
    const Account = this.vaultAccount();
    if (Account?.email) {
      // пароль аккаунта и сейфа один: сбрасываем оба через окно аккаунта
      this.accountDialog("forgot");
      return;
    }
    const key = this.wField("Ключ восстановления", { placeholder: "XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX", autocomplete: "off", spellcheck: "false" });
    this.vaultSheet("Вход по ключу восстановления", "Введите ключ, записанный при настройке сейфа. После входа задайте новый мастер-пароль.", [key.wrap], "Открыть", async () => {
      await Vault.unlockWithRecoveryKey(key.input.value);
      this.notice("Сейф открыт ключом восстановления");
      setTimeout(() => this.vaultPasswordSheet({ reset: true }), 400);
    });
  },

  vaultCreateSheet({ migration = false } = {}) {
    const { Vault } = this.vaultMod();
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const f = this.vaultPasswordFields(migration ? "Мастер-пароль" : "Мастер-пароль (можно оставить пустым)");
    const askAtStart = h("input", { type: "checkbox" });
    askAtStart.checked = true;
    const body = [f.pass.wrap, f.again.wrap];
    if (migration) {
      body.push(h("label", { class: "w-check" }, null, [askAtStart, h("span", {}, "Спрашивать мастер-пароль при запуске (как основной пароль Firefox)")]));
    } else {
      body.push(h("p", { class: "w-hint" }, "Забытый мастер-пароль восстановить нельзя: сейф откроется только на этом компьютере."));
    }
    this.vaultSheet(
      "Создать сейф",
      migration ? "Пароли сайтов в этом профиле были защищены основным паролем Firefox. Чтобы они остались под паролем, задайте мастер-пароль сейфа: пароли перешифруются при следующем запуске, а пока работают по-старому." : "Ключ сейфа сохранится в связке ключей этого компьютера. Мастер-пароль нужен, чтобы открыть сейф на другом компьютере: его можно задать и позже.",
      body,
      "Создать",
      async () => {
        const password = f.read({ optional: !migration });
        await Vault.create({ password });
        if (migration && askAtStart.checked) {
          await Vault.setOsUnlock(false);
        }
        this.notice(password ? "Сейф создан, мастер-пароль задан" : "Сейф создан");
      }
    );
  },

  /** Задать или сменить мастер-пароль сейфа (без аккаунта; с аккаунтом — окно смены пароля аккаунта).
   * reset — после входа по ключу восстановления; migration — защита паролей из-под основного пароля Firefox. */
  vaultPasswordSheet({ reset = false, migration = false, recoveryKey = null } = {}) {
    const { Vault } = this.vaultMod();
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const change = Vault.hasPassword && !reset;
    const old = change ? this.wField("Текущий мастер-пароль", { type: "password", autocomplete: "current-password" }) : null;
    const f = this.vaultPasswordFields(change ? "Новый мастер-пароль" : "Мастер-пароль");
    const rotate = h("input", { type: "checkbox" });
    const askAtStart = h("input", { type: "checkbox" });
    askAtStart.checked = true;
    const body = [old?.wrap, f.pass.wrap, f.again.wrap];
    if (change) {
      body.push(h("label", { class: "w-check" }, null, [rotate, h("span", {}, "Сменить и ключ шифрования сейфа (если пароль мог узнать кто-то ещё)")]));
    }
    if (migration) {
      body.push(h("label", { class: "w-check" }, null, [askAtStart, h("span", {}, "Спрашивать мастер-пароль при запуске (как основной пароль Firefox)")]));
    }
    const text = change ? null
      : reset ? "Сейф открыт ключом восстановления. Задайте новый мастер-пароль: старый больше не действует."
      : migration ? "Пароли сайтов в этом профиле были защищены основным паролем Firefox. Чтобы они остались под паролем, задайте мастер-пароль сейфа: пароли перешифруются при следующем запуске."
      : "С мастер-паролем файл сейфа можно перенести на другой компьютер. Забытый пароль восстановить нельзя.";
    this.vaultSheet(
      change ? "Сменить мастер-пароль" : reset ? "Новый мастер-пароль" : "Задать мастер-пароль",
      text,
      body.filter(Boolean),
      "Сохранить",
      async () => {
        const password = f.read();
        if (change) {
          if (rotate.checked) {
            this.notice("Меняем ключ сейфа и перешифровываем данные…");
          }
          const r = await Vault.changePassword(old.input.value, password, { rotate: rotate.checked });
          if (r.recoveryKey) {
            await this.vaultAccount()?.registerRecoveryKey(r.recoveryKey);
            setTimeout(() => this.vaultShowRecoveryKey(r.recoveryKey, { replaced: true }), 300);
          }
        } else if (reset && recoveryKey && this.vaultAccount()?.email) {
          // с аккаунтом пароль один: новый пароль получают и аккаунт, и сейф
          await this.vaultAccount().resetPasswordWithRecovery(recoveryKey, password);
        } else {
          await Vault.setPassword(password);
          if (migration && askAtStart.checked) {
            await Vault.setOsUnlock(false);
          }
        }
        this.notice("Мастер-пароль сохранён");
      }
    );
  },
});

// наблюдатель сейфа регистрируется сразу после загрузки оболочки: хранилище паролей
// могло начать ждать ключ ещё до появления окна
setTimeout(() => {
  try {
    Tabora.vaultInit();
  } catch (e) {
    console.error("Tabora vault init", e);
  }
}, 1000);

Tabora.SECTIONS.codes = { label: "Коды", key: "⌘⇧K", search: "Поиск по кодам", icon: ["M4 7h16v10H4z", "M8 12h.01", "M12 12h.01", "M16 12h.01"], wide: false };
if (!Tabora.SECTION_ORDER.includes("codes")) {
  const at = Tabora.SECTION_ORDER.indexOf("wallet");
  Tabora.SECTION_ORDER.splice(at >= 0 ? at + 1 : 1, 0, "codes");
}
