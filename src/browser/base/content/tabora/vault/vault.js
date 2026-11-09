/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Раздел «Коды» в ящике и интерфейс сейфа: создание, разблокировка, мастер-пароль.
 * Сейф (vault/Vault.sys.mjs) хранит ключ, которым шифруются пароли сайтов и секреты
 * одноразовых кодов. Разметка — chrome-DOM, стили общие с кошельком (w-*).
 * Подключается из tabora.js после wallet/*.js. */

Object.assign(Tabora, {
  _vaultMod: null,
  codes: { view: "main" },

  vaultMod() {
    if (!this._vaultMod) {
      this._vaultMod = ChromeUtils.importESModule("chrome://browser/content/tabora/vault/Vault.sys.mjs");
      Services.obs.addObserver(() => this.drawerDirty("codes"), this._vaultMod.Vault.TOPIC);
    }
    return this._vaultMod;
  },

  /* ---- Раздел ящика ---------------------------------------------------- */

  async drawer_codes(seq) {
    const d = this.drawer;
    const { Vault } = this.vaultMod();
    await Vault.ready();
    if (Vault.exists && !Vault.unlocked) {
      await Vault.unlock(); // тихо, через хранилище ключей системы
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
    if (!Vault.hasPassword) {
      return h("div", { class: "w-locked" }, null, [
        h("div", { class: "w-lock-mark" }, null, [this.wIcon(["M7 11V8a5 5 0 0 1 10 0v3", "M5 11h14v10H5z"], 22, 1.8)]),
        h("b", {}, "Сейф недоступен"),
        h("p", { class: "w-sub" }, "Ключ сейфа хранится в связке ключей системы, а мастер-пароль не задан. Если файл перенесён с другого компьютера, открыть его нельзя."),
      ]);
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
      pass.wrap, err, go,
    ]);
  },

  codesMainView() {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    return h("div", { class: "w-settings" }, null, [
      h("div", { class: "w-flow-head" }, null, [h("b", {}, "Коды")]),
      this.drawerEmpty("Кодов пока нет", "Добавление кодов появится на следующем шаге"),
      this.vaultCard(),
    ]);
  },

  /** Карточка состояния сейфа: как хранится ключ и что с этим делать. */
  vaultCard() {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { Vault } = this.vaultMod();
    const row = (name, value, cls = "") => h("div", { class: `w-kv ${cls}`.trim() }, null, [h("span", {}, name), h("b", {}, value)]);
    const kids = [
      h("b", { class: "w-group-title" }, "Сейф"),
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
    kids.push(this.wButton("Заблокировать сейф", "ghost", () => Vault.lock()));
    return h("div", { class: "w-group" }, null, kids);
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

  vaultPasswordSheet() {
    const { Vault } = this.vaultMod();
    const change = Vault.hasPassword;
    const old = change ? this.wField("Текущий мастер-пароль", { type: "password", autocomplete: "current-password" }) : null;
    const f = this.vaultPasswordFields(change ? "Новый мастер-пароль" : "Мастер-пароль");
    this.vaultSheet(
      change ? "Сменить мастер-пароль" : "Задать мастер-пароль",
      change ? null : "С мастер-паролем файл сейфа можно перенести на другой компьютер. Забытый пароль восстановить нельзя.",
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

Tabora.SECTIONS.codes = { label: "Коды", key: "⌘⇧K", noSearch: true, icon: ["M4 7h16v10H4z", "M8 12h.01", "M12 12h.01", "M16 12h.01"], wide: false };
if (!Tabora.SECTION_ORDER.includes("codes")) {
  const at = Tabora.SECTION_ORDER.indexOf("wallet");
  Tabora.SECTION_ORDER.splice(at >= 0 ? at + 1 : 1, 0, "codes");
}
