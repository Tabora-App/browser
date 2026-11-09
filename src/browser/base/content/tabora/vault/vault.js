/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Раздел «Коды» в ящике и интерфейс сейфа: создание, разблокировка, мастер-пароль.
 * Сейф (vault/Vault.sys.mjs) хранит ключ, которым шифруются пароли сайтов и секреты
 * одноразовых кодов. Разметка — chrome-DOM, стили общие с кошельком (w-*).
 * Подключается из tabora.js после wallet/*.js. */

Object.assign(Tabora, {
  _vaultMod: null,
  _otpMod: null,
  codes: { view: "main", timer: null },

  vaultMod() {
    if (!this._vaultMod) {
      this._vaultMod = ChromeUtils.importESModule("chrome://browser/content/tabora/vault/Vault.sys.mjs");
      Services.obs.addObserver((subject, topic, what) => {
        this.drawerDirty("codes");
        if (what === "waiting") {
          this.vaultAskUnlock();
        }
      }, this._vaultMod.Vault.TOPIC);
    }
    return this._vaultMod;
  },

  /** Хранилище паролей ждёт ключ: сейф настроен на мастер-пароль при запуске. Просим ввести его в активном окне. */
  vaultAskUnlock() {
    if (window !== Services.wm.getMostRecentBrowserWindow() || !this.drawer?.el) {
      return;
    }
    this.notice("Введите мастер-пароль сейфа, чтобы включить пароли сайтов");
    this.openDrawer("codes");
  },

  /** При загрузке окна: модуль мог начать ждать ключ до появления окна. */
  vaultInit() {
    const { Vault } = this.vaultMod();
    if (Vault.waiting) {
      setTimeout(() => this.vaultAskUnlock(), 400);
    }
  },

  /* ---- Раздел ящика ---------------------------------------------------- */

  async drawer_codes(seq) {
    const d = this.drawer;
    const { Vault } = this.vaultMod();
    await Vault.ready();
    if (Vault.exists && !Vault.unlocked) {
      await Vault.unlock(); // тихо, через хранилище ключей системы
    }
    if (Vault.unlocked) {
      await this.otpMod().Otp.ready();
    }
    if (seq !== d.seq) {
      return;
    }
    let node;
    if (!Vault.exists) {
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
      h("div", { class: "w-orb" }),
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
    const recovery = Vault.hasRecoveryKey ? this.wButton("Войти по ключу восстановления", "ghost", () => this.vaultRecoverySheet()) : null;
    if (!Vault.hasPassword) {
      return h("div", { class: "w-locked" }, null, [
        h("div", { class: "w-lock-mark" }, null, [this.wIcon(["M7 11V8a5 5 0 0 1 10 0v3", "M5 11h14v10H5z"], 22, 1.8)]),
        h("b", {}, "Сейф недоступен"),
        h("p", { class: "w-sub" }, Vault.hasRecoveryKey ? "Ключ сейфа хранится в связке ключей другого компьютера, мастер-пароль не задан. Откройте сейф ключом восстановления и задайте пароль." : "Ключ сейфа хранится в связке ключей системы, а мастер-пароль не задан. Если файл перенесён с другого компьютера, открыть его нельзя."),
        recovery,
      ].filter(Boolean));
    }
    const pass = this.wField("Мастер-пароль", { type: "password", autocomplete: "off" });
    const err = h("div", { class: "w-error", hidden: "true" });
    const go = this.wButton("Разблокировать", "primary", async () => {
      go.disabled = true;
      try {
        await Vault.unlockWithPassword(pass.input.value);
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
      h("b", {}, "Сейф заблокирован"),
      h("p", { class: "w-sub" }, Vault.hasOsKey && Vault.osUnlockEnabled ? "Связка ключей системы не ответила. Введите мастер-пароль." : "Введите мастер-пароль"),
      pass.wrap, err, go, recovery,
    ].filter(Boolean));
  },

  otpMod() {
    if (!this._otpMod) {
      this._otpMod = ChromeUtils.importESModule("chrome://browser/content/tabora/vault/Otp.sys.mjs");
      Services.obs.addObserver(() => this.drawerDirty("codes"), this._otpMod.Otp.TOPIC);
    }
    return this._otpMod;
  },

  /** Актор страницы: ссылки otpauth:// и пиксели картинок для QR; пункт в меню картинки. */
  initVaultActor() {
    try {
      ChromeUtils.registerWindowActor("TaboraVault", {
        parent: { esModuleURI: "chrome://browser/content/tabora/actors/TaboraVaultParent.sys.mjs" },
        child: {
          esModuleURI: "chrome://browser/content/tabora/actors/TaboraVaultChild.sys.mjs",
          events: { click: { capture: true }, focusin: { capture: true }, focusout: { capture: true }, keydown: { capture: true } },
        },
        allFrames: true,
        messageManagerGroups: ["browsers"],
        safeForUntrustedWebProcess: true,
      });
    } catch (e) {
      // уже зарегистрирован другим окном
    }
    this.otpInitContextMenu();
  },

  /* ---- Список кодов ---------------------------------------------------- */

  codesMainView() {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { Otp } = this.otpMod();
    const q = (this.drawer.query || "").toLowerCase();
    const entries = Otp.list()
      .filter(e => !q || `${e.issuer} ${e.account} ${(e.domains || []).join(" ")}`.toLowerCase().includes(q))
      .sort((a, b) => (b.usedAt || 0) - (a.usedAt || 0) || (a.issuer || a.account).localeCompare(b.issuer || b.account, "ru"));
    const add = this.wButton("Добавить", "primary small", e => this.otpAddMenu(e.currentTarget));
    const head = h("div", { class: "otp-head" }, null, [h("b", {}, "Коды"), add]);
    const list = h("div", { class: "otp-list" }, null, entries.map(e => this.otpRow(e)));
    const empty = this.drawerEmpty(q ? "Ничего не найдено" : "Кодов пока нет", q ? "" : "Добавьте код: с QR на странице, по ссылке otpauth:// или вручную");
    const body = h("div", { class: "w-settings" }, null, [head, entries.length ? list : empty, this.accountCard(), this.vaultCard()]);
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

  otpRow(e) {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const domain = e.domains?.[0];
    const icon = h("span", { class: "otp-icon" }, domain ? null : (e.issuer || e.account || "?")[0].toUpperCase(), domain ? [h("img", { src: `page-icon:https://${domain}/`, alt: "" })] : []);
    const title = e.issuer || e.account;
    const sub = e.issuer ? e.account || (e.domains || []).join(", ") : (e.domains || []).join(", ");
    const code = h("span", { class: "otp-code" }, "··· ···");
    const ring = h("span", { class: "otp-ring", style: "--p:100" });
    const row = h("div", { class: "otp-row", tabindex: "0", "data-id": e.id, title: "Нажмите, чтобы скопировать код" }, null, [
      icon, h("div", { class: "otp-text" }, null, [h("b", {}, title), h("span", {}, sub)]), code, ring,
    ]);
    row.addEventListener("click", () => this.otpCopy(e.id, row));
    row.addEventListener("keydown", ev => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        this.otpCopy(e.id, row);
      }
    });
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
          row.querySelector(".otp-code").textContent = this.otpFmt(c.code);
          row.querySelector(".otp-ring").style.setProperty("--p", String(Math.round((c.remaining / c.period) * 100)));
          row.classList.toggle("ending", c.remaining <= 5);
          row.title = `Действует ещё ${c.remaining} с · следующий ${this.otpFmt(c.next)} · нажмите, чтобы скопировать`;
        } catch (err) {
          row.querySelector(".otp-code").textContent = "—";
        }
      }
    };
    tick();
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
      Otp.touch(id).catch(() => {});
    } catch (e) {
      this.notice(e.message);
    }
  },

  /** Копирование с автоочисткой: буфер стирается, если там всё ещё наш текст. */
  copyWithExpiry(text, ms) {
    const helper = Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper);
    helper.copyString(text);
    clearTimeout(this._clipTimer);
    this._clipTimer = setTimeout(() => {
      if (this.readClipboard() === text) {
        helper.copyString("");
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

  otpManualSheet(prefill = {}) {
    const { Otp } = this.otpMod();
    const issuer = this.wField("Сервис", { placeholder: "GitHub", value: prefill.issuer || "" });
    const account = this.wField("Аккаунт", { placeholder: "you@example.com", value: prefill.account || "" });
    const secret = this.wField("Секрет (Base32)", { placeholder: "JBSW Y3DP EHPK 3PXP", value: prefill.secret || "", autocomplete: "off", spellcheck: "false" });
    const domains = this.wField("Сайт: подсказка кода в поле входа", { placeholder: "github.com", value: (prefill.domains || []).join(", ") });
    issuer.input.addEventListener("input", () => {
      if (!domains.input.value) {
        const g = Otp.guessDomain(issuer.input.value);
        if (g.length) {
          domains.input.value = g.join(", ");
        }
      }
    });
    const params = this.otpParamSelects(prefill);
    this.vaultSheet(
      prefill.secret ? "Добавить код" : "Новый код",
      prefill.secret ? "Проверьте название и сайт: подсказка с кодом появится только на нём." : null,
      [issuer.wrap, account.wrap, secret.wrap, domains.wrap, params.box],
      "Сохранить",
      async () => {
        const meta = await Otp.add({ issuer: issuer.input.value, account: account.input.value, secret: secret.input.value, domains: domains.input.value, ...params.read() });
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

  /** Ссылка otpauth:// со страницы или из QR: лист добавления, только для активной вкладки. */
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
    if (host) {
      parsed.domains = Otp.normalizeDomains([host]);
    }
    if (!parsed.domains?.length) {
      parsed.domains = Otp.guessDomain(parsed.issuer);
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

  /** Текст QR из картинки (data: URL или SVG-разметка), распознавание локально. */
  async otpDecodeImage(data) {
    const { jsQR } = ChromeUtils.importESModule("chrome://browser/content/tabora/vault/vendor/qr.sys.mjs");
    const src = data?.dataURL || (data?.svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(data.svg)}` : null);
    if (!src) {
      return null;
    }
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error("image"));
      img.src = src;
    });
    const w0 = img.naturalWidth || data.w;
    const h0 = img.naturalHeight || data.h;
    if (!w0 || !h0 || w0 * h0 > (data.screen ? 40_000_000 : 4_000_000)) {
      return null;
    }
    // снимок экрана большой: сначала уменьшенная копия (быстро), затем полный размер
    const scales = data.screen && w0 * h0 > 2_000_000 ? [0.5, 1] : [1];
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
    const host = browser.currentURI?.host || "";
    for (const data of images) {
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
      const host = gBrowser.selectedBrowser?.currentURI?.host || "";
      if (text && /^otpauth(-migration)?:\/\//i.test(text)) {
        this.otpAddFromUrl(text, { host: /^https?:/.test(gBrowser.selectedBrowser?.currentURI?.spec || "") ? host : "" });
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
    const host = gc.browser?.currentURI?.host || "";
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

  /* ---- Подсказка в поле одноразового кода ----------------------------------------- */

  otpPop: { el: null, actor: null, entries: [], active: 0, timer: null, host: "" },

  /** Поле кода получило фокус: показываем коды сайта (только активная вкладка, только совпадающий домен). */
  async otpFieldFocused(data, actor) {
    const browser = actor.browsingContext?.top?.embedderElement;
    if (!browser || browser !== gBrowser.selectedBrowser) {
      return;
    }
    const { Vault } = this.vaultMod();
    const { Otp } = this.otpMod();
    await Vault.ready();
    if (Vault.exists && !Vault.unlocked) {
      await Vault.unlock();
    }
    if (!Vault.unlocked) {
      return; // сейф на мастер-пароле: без подсказок, кодов всё равно не посчитать
    }
    await Otp.ready();
    const entries = Otp.forHost(data.host);
    if (!entries.length) {
      return;
    }
    const pop = this.otpPop;
    pop.actor = actor;
    pop.entries = entries;
    pop.active = 0;
    pop.host = data.host;
    pop.maxLength = data.maxLength || 0;
    this.otpPopRender(browser, data.rect, data.zoom || 1);
    actor.sendAsyncMessage("TaboraVault:Arm", { armed: true });
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
      el.addEventListener("pointerdown", e => e.preventDefault()); // не отбираем фокус у поля
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

  otpPopRender(browser, rect, zoom) {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const pop = this.otpPop;
    const el = this.otpPopEl();
    el.replaceChildren();
    pop.entries.forEach((e, i) => {
      const row = h("div", { class: `otp-pop-row${i === pop.active ? " active" : ""}`, role: "option", "data-id": e.id }, null, [
        h("span", { class: "otp-icon" }, e.domains?.[0] ? null : (e.issuer || e.account || "?")[0].toUpperCase(), e.domains?.[0] ? [h("img", { src: `page-icon:https://${e.domains[0]}/`, alt: "" })] : []),
        h("div", { class: "otp-text" }, null, [h("b", {}, e.issuer || e.account), h("span", {}, e.issuer ? e.account || "" : "")]),
        h("span", { class: "otp-code" }, "··· ···"),
        h("span", { class: "otp-ring", style: "--p:100" }),
      ]);
      row.addEventListener("click", () => {
        pop.active = i;
        this.otpPopAccept(pop.actor);
      });
      row.addEventListener("mouseenter", () => this.otpPopSetActive(i));
      el.append(row);
    });
    el.append(h("div", { class: "otp-pop-hint" }, "Enter — вставить код · Esc — закрыть · форма не отправляется"));
    el.hidden = false;
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
    this.otpPopTick();
    clearInterval(pop.timer);
    pop.timer = setInterval(() => this.otpPopTick(), 1000);
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
    try {
      if (pop.actor.browsingContext.currentWindowGlobal !== pop.actor.manager) {
        this.otpPopHide();
        return;
      }
    } catch (e) {
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

  otpPopSetActive(i) {
    const pop = this.otpPop;
    pop.active = (i + pop.entries.length) % pop.entries.length;
    pop.el?.querySelectorAll(".otp-pop-row").forEach((r, k) => r.classList.toggle("active", k === pop.active));
  },

  otpPopMove(actor, delta) {
    if (this.otpPop.actor === actor && this.otpPop.entries.length) {
      this.otpPopSetActive(this.otpPop.active + delta);
    }
  },

  /** Вставить активный код в поле: следующий код, если текущий вот-вот истечёт. */
  async otpPopAccept(actor) {
    const pop = this.otpPop;
    if (!pop.el || pop.el.hidden || pop.actor !== actor) {
      return;
    }
    const entry = pop.entries[pop.active];
    if (!entry) {
      return;
    }
    const { Otp } = this.otpMod();
    try {
      const c = await Otp.code(entry.id);
      const code = c.remaining <= 3 ? c.next : c.code;
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
    pop.entries = [];
  },

  /* ---- Меню записи ------------------------------------------------------------ */

  otpRowMenu(e) {
    const { Otp } = this.otpMod();
    return [
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
      { label: "Ссылка для переноса", icon: ["M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1", "M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"], run: () => this.otpExportSheet(e) },
      { separator: true },
      { label: "Удалить", icon: ["M4 7h16", "M10 11v6", "M14 11v6", "M6 7l1 12h10l1-12", "M9 7V4h6v3"], danger: true, run: () => this.otpDeleteSheet(e) },
    ];
  },

  otpEditSheet(e) {
    const { Otp } = this.otpMod();
    const issuer = this.wField("Сервис", { value: e.issuer || "" });
    const account = this.wField("Аккаунт", { value: e.account || "" });
    const domains = this.wField("Сайты через запятую", { value: (e.domains || []).join(", "), placeholder: "github.com" });
    this.vaultSheet("Название и сайт", "Подсказка с кодом появляется только на указанных сайтах: на похожем домене кода не будет.", [issuer.wrap, account.wrap, domains.wrap], "Сохранить", async () => {
      await Otp.update(e.id, { issuer: issuer.input.value, account: account.input.value, domains: domains.input.value });
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

  /** Карточка состояния сейфа: как хранится ключ и что с этим делать. */
  vaultCard() {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { Vault } = this.vaultMod();
    const row = (name, value, cls = "") => h("div", { class: `w-kv ${cls}`.trim() }, null, [h("span", {}, name), h("b", {}, value)]);
    const kids = [
      row("Связка ключей системы", Vault.hasOsKey && Vault.osUnlockEnabled ? "ключ сохранён · тихая разблокировка" : "не используется"),
      row("Мастер-пароль", Vault.hasPassword ? "задан · можно перенести на другой компьютер" : "не задан · только этот компьютер", Vault.hasPassword ? "" : "muted"),
      this.wButton(Vault.hasPassword ? "Сменить мастер-пароль" : "Задать мастер-пароль", "ghost", () => this.vaultPasswordSheet()),
    ];
    if (Vault.hasPassword) {
      kids.push(this.wButton(Vault.osUnlockEnabled ? "Спрашивать мастер-пароль при запуске" : "Открывать тихо через связку ключей", "ghost", async () => {
        try {
          await Vault.setOsUnlock(!Vault.osUnlockEnabled);
        } catch (e) {
          this.notice(e.message);
        }
      }));
    }
    const rkAt = Vault.recoveryKeyCreatedAt;
    kids.push(row("Ключ восстановления", rkAt ? `создан ${new Date(rkAt).toLocaleDateString("ru-RU")} · откроет сейф без мастер-пароля` : "не создан · забытый мастер-пароль не восстановить", rkAt ? "" : "muted"));
    kids.push(this.wButton(rkAt ? "Создать новый ключ восстановления" : "Создать ключ восстановления", "ghost", () => this.vaultRecoveryCreateSheet()));
    if (rkAt) {
      kids.push(this.wButton("Отозвать ключ восстановления", "ghost", () => this.vaultOwnerCheck("Отзыв ключа восстановления", async () => {
        await Vault.revokeRecoveryKey();
        this.notice("Ключ восстановления отозван");
      })));
    }
    kids.push(this.wButton("Заблокировать сейф", "ghost", () => Vault.lock()));
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

  /** Пара полей пароля с повтором; возвращает значение или бросает ошибку. */
  vaultPasswordFields(label = "Мастер-пароль") {
    const { Vault } = this.vaultMod();
    const pass = this.wField(label, { type: "password", autocomplete: "new-password" });
    const again = this.wField("Повторите", { type: "password", autocomplete: "new-password" });
    const read = ({ optional = false } = {}) => {
      const a = pass.input.value;
      const b = again.input.value;
      if (optional && !a && !b) {
        return "";
      }
      if (a.length < Vault.MIN_PASSWORD) {
        throw new Error(`Мастер-пароль не короче ${Vault.MIN_PASSWORD} символов`);
      }
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
      if (e.key === "Enter" && e.target.localName === "input") {
        ok.click();
      } else if (e.key === "Escape") {
        box.remove();
      }
    });
    const box = h("div", { class: "w-sheet" }, null, [card]);
    this.wSheetShow(box);
    setTimeout(() => card.querySelector("input")?.focus(), 50);
    return box;
  },

  /** Подтверждение владельца перед чувствительным действием: мастер-пароль, а без него — проверка системы (Touch ID или пароль macOS). */
  vaultOwnerCheck(title, onOk) {
    const { Vault } = this.vaultMod();
    if (Vault.hasPassword) {
      const pass = this.wField("Мастер-пароль", { type: "password", autocomplete: "current-password" });
      this.vaultSheet(title, "Подтвердите, что это вы.", [pass.wrap], "Продолжить", async () => {
        await Vault.verifyPassword(pass.input.value);
        setTimeout(() => onOk().catch(e => this.notice(e.message)), 0);
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
      await onOk();
    })().catch(e => this.notice(e.message));
  },

  vaultRecoveryCreateSheet() {
    const { Vault } = this.vaultMod();
    const h = (t, a, x, c) => this.html(t, a, x, c);
    this.vaultOwnerCheck("Ключ восстановления", async () => {
      const key = await Vault.createRecoveryKey();
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
        "Запишите его и храните отдельно от компьютера. Он откроет сейф, если вы забудете мастер-пароль, и показывается только сейчас. Прежний ключ, если был, больше не действует.",
        [pre, h("div", { class: "w-actions" }, null, [reveal, copy]), h("p", { class: "w-hint" }, "Кто знает этот ключ, сможет открыть сейф на любом компьютере.")],
        "Я записал ключ",
        async () => {}
      );
      box.classList.add("w-reveal");
    });
  },

  vaultRecoverySheet() {
    const { Vault } = this.vaultMod();
    const key = this.wField("Ключ восстановления", { placeholder: "XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX", autocomplete: "off", spellcheck: "false" });
    this.vaultSheet("Вход по ключу восстановления", "Введите ключ, записанный при настройке сейфа. После входа задайте новый мастер-пароль.", [key.wrap], "Открыть", async () => {
      await Vault.unlockWithRecoveryKey(key.input.value);
      this.notice("Сейф открыт ключом восстановления");
      setTimeout(() => this.vaultPasswordSheet({ reset: true }), 400);
    });
  },

  vaultCreateSheet() {
    const { Vault } = this.vaultMod();
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const f = this.vaultPasswordFields("Мастер-пароль (можно оставить пустым)");
    this.vaultSheet(
      "Создать сейф",
      "Ключ сейфа сохранится в связке ключей этого компьютера. Мастер-пароль нужен, чтобы открыть сейф на другом компьютере: его можно задать и позже.",
      [f.pass.wrap, f.again.wrap, h("p", { class: "w-hint" }, "Забытый мастер-пароль восстановить нельзя: сейф откроется только на этом компьютере.")],
      "Создать",
      async () => {
        const password = f.read({ optional: true });
        await Vault.create({ password });
        this.notice(password ? "Сейф создан, мастер-пароль задан" : "Сейф создан");
      }
    );
  },

  vaultPasswordSheet({ reset = false } = {}) {
    const { Vault } = this.vaultMod();
    const change = Vault.hasPassword && !reset;
    const old = change ? this.wField("Текущий мастер-пароль", { type: "password", autocomplete: "current-password" }) : null;
    const f = this.vaultPasswordFields(change ? "Новый мастер-пароль" : "Мастер-пароль");
    this.vaultSheet(
      change ? "Сменить мастер-пароль" : reset ? "Новый мастер-пароль" : "Задать мастер-пароль",
      change ? null : reset ? "Сейф открыт ключом восстановления. Задайте новый мастер-пароль: старый больше не действует." : "С мастер-паролем файл сейфа можно перенести на другой компьютер. Забытый пароль восстановить нельзя.",
      [old?.wrap, f.pass.wrap, f.again.wrap].filter(Boolean),
      "Сохранить",
      async () => {
        const password = f.read();
        if (change) {
          await Vault.changePassword(old.input.value, password);
        } else {
          await Vault.setPassword(password);
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
