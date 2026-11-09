/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Интерфейс обновлений: плашка «Доступна версия» для необязательных и глухой экран
 * поверх окна для обязательных (ввод в браузер не проходит, пока обновление не
 * скачано и не установлено перезапуском). Логика — update/TaboraUpdate.sys.mjs. */

Object.assign(Tabora, {
  _updateMod: null,
  upd: { banner: null, wall: null },

  updateMod() {
    if (!this._updateMod) {
      this._updateMod = ChromeUtils.importESModule("chrome://browser/content/tabora/update/TaboraUpdate.sys.mjs");
      Services.obs.addObserver(() => this.updateRender(), this._updateMod.TaboraUpdate.TOPIC);
    }
    return this._updateMod;
  },

  initUpdates() {
    const { TaboraUpdate } = this.updateMod();
    TaboraUpdate.start();
    // клавиши при обязательном обновлении: только выход из браузера
    window.addEventListener("keydown", e => {
      if (!this.upd.wall || this.upd.wall.hidden) {
        return;
      }
      const quit = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "q";
      if (!quit) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);
  },

  updateRender() {
    const { TaboraUpdate } = this.updateMod();
    if (window !== Services.wm.getMostRecentBrowserWindow() && !this.upd.wall?.hidden === false) {
      // чужое окно: стену показываем во всех, плашку — в каждом окне тоже
    }
    if (TaboraUpdate.mandatory) {
      this.updateBannerHide();
      this.updateWallShow();
    } else {
      this.updateWallHide();
      if (TaboraUpdate.available && !TaboraUpdate.snoozed) {
        this.updateBannerShow();
      } else {
        this.updateBannerHide();
      }
    }
  },

  /* ---- Плашка ---------------------------------------------------------------- */

  updateBannerShow() {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { TaboraUpdate } = this.updateMod();
    let b = this.upd.banner;
    if (!b) {
      b = h("div", { id: "tabora-update-banner", role: "status", hidden: "true" });
      document.getElementById("browser").append(b);
      this.upd.banner = b;
    }
    const ready = TaboraUpdate.readyForRestart;
    const primary = this.html("button", { class: "primary", type: "button" }, ready ? "Перезапустить и обновить" : "Обновить");
    primary.addEventListener("click", () => {
      if (TaboraUpdate.readyForRestart) {
        TaboraUpdate.restart();
      } else {
        TaboraUpdate.check({ force: true }).catch(() => {});
      }
    });
    const later = this.html("button", { class: "ghost", type: "button" }, "Позже");
    later.addEventListener("click", () => TaboraUpdate.snooze(24));
    const notes = TaboraUpdate.channel?.notesUrl ? this.html("button", { class: "linkish", type: "button" }, "Что нового") : null;
    notes?.addEventListener("click", () => this.go(TaboraUpdate.channel.notesUrl));
    b.replaceChildren(
      this.markSvg(),
      h("div", { class: "text" }, null, [
        h("b", {}, `Доступна версия ${TaboraUpdate.channel?.version || ""}`),
        h("span", {}, ready ? "Скачано и готово к установке. Вкладки восстановятся после перезапуска." : TaboraUpdate.statusText()),
      ]),
      notes,
      later,
      primary
    );
    b.hidden = false;
  },

  updateBannerHide() {
    if (this.upd.banner) {
      this.upd.banner.hidden = true;
    }
  },

  /* ---- Стена обязательного обновления ---------------------------------------- */

  updateWallShow() {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { TaboraUpdate, compareVersions } = this.updateMod();
    let w = this.upd.wall;
    if (!w) {
      w = h("div", { id: "tabora-update-wall", role: "dialog", "aria-modal": "true", hidden: "true" });
      document.getElementById("browser").append(w);
      this.upd.wall = w;
    }
    const ready = TaboraUpdate.readyForRestart;
    const p = TaboraUpdate.progress;
    const pct = p && p.total > 0 ? Math.round((p.done / p.total) * 100) : ready ? 100 : null;
    const S = this.updateMod().TaboraUpdate.appUpdater ? ChromeUtils.importESModule("resource://gre/modules/AppUpdater.sys.mjs").AppUpdater.STATUS : {};
    const failed = [S.DOWNLOAD_FAILED, S.CHECKING_FAILED, S.INTERNAL_ERROR, S.MANUAL_UPDATE, S.UNSUPPORTED_SYSTEM, S.NO_UPDATER].includes(TaboraUpdate.status);
    const action = ready
      ? this.html("button", { class: "primary", type: "button" }, "Перезапустить и установить")
      : failed
        ? this.html("button", { class: "primary", type: "button" }, "Повторить")
        : null;
    action?.addEventListener("click", () => (ready ? TaboraUpdate.restart() : TaboraUpdate.check({ force: true }).catch(() => {})));
    const manual = failed && TaboraUpdate.status !== S.CHECKING_FAILED ? this.html("button", { class: "linkish", type: "button" }, "Скачать с сайта") : null;
    manual?.addEventListener("click", () => this.go(Services.prefs.getStringPref("app.update.url.manual", "https://tabora.app")));
    const quit = this.html("button", { class: "linkish", type: "button" }, "Выйти из браузера");
    quit.addEventListener("click", () => Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit));
    w.replaceChildren(
      h("div", { class: "card" }, null, [
        this.markSvg("wall-mark"),
        h("h2", {}, `Обязательное обновление до ${TaboraUpdate.channel?.version || "новой версии"}`),
        h("p", { class: "why" }, `Версия ${TaboraUpdate.currentVersion} больше не поддерживается${TaboraUpdate.channel?.minimum ? `: минимально допустимая ${TaboraUpdate.channel.minimum}` : ""}. Работа продолжится после установки. Вкладки и данные сохранятся.`),
        TaboraUpdate.channel?.notes ? h("p", { class: "notes" }, TaboraUpdate.channel.notes) : null,
        h("div", { class: "bar", "aria-hidden": "true" }, null, [h("i", { style: `width:${pct ?? 6}%`, class: pct === null ? "indeterminate" : "" })]),
        h("p", { class: `state${failed ? " failed" : ""}` }, TaboraUpdate.statusText()),
        h("div", { class: "actions" }, null, [quit, manual, action].filter(Boolean)),
      ].filter(Boolean))
    );
    w.hidden = false;
    void compareVersions;
  },

  updateWallHide() {
    if (this.upd.wall) {
      this.upd.wall.hidden = true;
    }
  },
});
