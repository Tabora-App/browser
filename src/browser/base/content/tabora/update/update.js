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
      this._updateMod = ChromeUtils.importESModule("chrome://tabora/content/update/TaboraUpdate.sys.mjs");
      Services.obs.addObserver(() => this.updateRender(), this._updateMod.TaboraUpdate.TOPIC);
    }
    return this._updateMod;
  },

  initUpdates() {
    const { TaboraUpdate } = this.updateMod();
    TaboraUpdate.start();
    // клавиши при обязательном обновлении: выход из браузера (⌘Q / Ctrl+Q) и
    // управление кнопками самого экрана, остальное в браузер не проходит
    window.addEventListener("keydown", e => {
      if (!this.upd.wall || this.upd.wall.hidden) {
        return;
      }
      const quit = (e.metaKey || e.ctrlKey) && (e.key || "").toLowerCase() === "q";
      if (quit || this.upd.wall.contains(e.target)) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
    }, true);
  },

  updateRender() {
    const { TaboraUpdate } = this.updateMod();
    // стена и плашка показываются в каждом окне; обязательность считает TaboraUpdate:
    // только если пакет для этой платформы есть и обновлятор может его поставить
    if (TaboraUpdate.mandatory) {
      this.updateBannerHide();
      this.updateWallShow();
    } else {
      this.updateWallHide();
      // устаревшие сведения (просроченный манифест) показываются и без доступной версии
      if ((TaboraUpdate.available || TaboraUpdate.stale) && !TaboraUpdate.snoozed) {
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
    // сведения устарели: обновления не ставятся, остаётся проверить сайт или повторить
    const stale = !ready && TaboraUpdate.stale;
    b.classList.toggle("stale", stale);
    b.setAttribute("role", stale ? "alert" : "status");
    if (stale) {
      const site = this.html("button", { class: "primary", type: "button" }, tt`Открыть сайт`);
      site.addEventListener("click", () => this.go(TaboraUpdate.manualUrl));
      const retry = this.html("button", { class: "ghost", type: "button" }, tt`Проверить снова`);
      retry.addEventListener("click", () => TaboraUpdate.check({ force: true }).catch(() => {}));
      const hide = this.html("button", { class: "linkish", type: "button" }, tt`Позже`);
      hide.addEventListener("click", () => TaboraUpdate.snooze(24));
      b.replaceChildren(
        this.markSvg(),
        h("div", { class: "text" }, null, [
          h("b", {}, tt`Сведения об обновлениях устарели`),
          h("span", {}, tt`Действительный манифест обновлений не получен: новая версия могла выйти, но браузер о ней не узнает. Проверьте сайт Tabora.`),
        ]),
        hide,
        retry,
        site
      );
      b.hidden = false;
      return;
    }
    // обновлятор недоступен (политика, нет прав, сборка без обновлятора): только сайт
    const manualOnly = !ready && !TaboraUpdate.updatesPossible;
    const primary = this.html("button", { class: "primary", type: "button" }, ready ? tt`Перезапустить и обновить` : manualOnly ? tt`Скачать с сайта` : tt`Обновить@@браузер`);
    primary.addEventListener("click", () => {
      if (TaboraUpdate.readyForRestart) {
        TaboraUpdate.restart();
      } else if (manualOnly) {
        this.go(TaboraUpdate.manualUrl);
      } else {
        TaboraUpdate.check({ force: true }).catch(() => {});
      }
    });
    const later = this.html("button", { class: "ghost", type: "button" }, tt`Позже`);
    later.addEventListener("click", () => TaboraUpdate.snooze(24));
    const notes = TaboraUpdate.channel?.notesUrl ? this.html("button", { class: "linkish", type: "button" }, tt`Что нового`) : null;
    notes?.addEventListener("click", () => this.go(TaboraUpdate.channel.notesUrl));
    b.replaceChildren(
      this.markSvg(),
      h("div", { class: "text" }, null, [
        h("b", {}, tt`Доступна версия ${TaboraUpdate.channel?.version || ""}`),
        h("span", {}, ready ? tt`Скачано и готово к установке. Вкладки восстановятся после перезапуска.` : TaboraUpdate.statusText()),
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
    const { TaboraUpdate } = this.updateMod();
    const S = ChromeUtils.importESModule("resource://gre/modules/AppUpdater.sys.mjs").AppUpdater.STATUS;
    let w = this.upd.wall;
    if (!w) {
      w = h("div", { id: "tabora-update-wall", role: "dialog", "aria-modal": "true", hidden: "true" });
      document.getElementById("browser").append(w);
      this.upd.wall = w;
    }
    const ready = TaboraUpdate.readyForRestart;
    const busy = [S.CHECKING, S.DOWNLOADING, S.STAGING, S.DOWNLOAD_AND_INSTALL].includes(TaboraUpdate.status);
    const failed = [S.DOWNLOAD_FAILED, S.CHECKING_FAILED, S.INTERNAL_ERROR].includes(TaboraUpdate.status);
    const p = TaboraUpdate.progress;
    const pct = p && p.total > 0 ? Math.round((p.done / p.total) * 100) : ready ? 100 : null;
    // выход есть всегда: «Скачать с сайта» и «Выйти»; «Повторить», пока ничего не идёт
    const action = ready
      ? this.html("button", { class: "primary", type: "button" }, tt`Перезапустить и установить`)
      : busy
        ? null
        : this.html("button", { class: "primary", type: "button" }, tt`Повторить`);
    action?.addEventListener("click", () => (TaboraUpdate.readyForRestart ? TaboraUpdate.restart() : TaboraUpdate.check({ force: true }).catch(() => {})));
    const manual = this.html("button", { class: "linkish", type: "button" }, tt`Скачать с сайта`);
    manual.addEventListener("click", () => {
      this.updateWallHide(); // страница загрузки должна быть видна; стена вернётся при следующей проверке
      this.go(TaboraUpdate.manualUrl);
    });
    const quit = this.html("button", { class: "linkish", type: "button" }, tt`Выйти из браузера`);
    quit.addEventListener("click", () => Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit));
    const ch = TaboraUpdate.channel;
    w.replaceChildren(
      h("div", { class: "card" }, null, [
        this.markSvg("wall-mark"),
        h("h2", {}, tt`Обязательное обновление до ${ch?.version || tt`новой версии`}`),
        h("p", { class: "why" }, tt`Версия ${TaboraUpdate.currentVersion || ""} больше не поддерживается${ch?.minimum ? tt`: минимально допустимая ${ch.minimum}` : ""}. Работа продолжится после установки. Вкладки и данные сохранятся.`),
        ch?.notes ? h("p", { class: "notes" }, ch.notes) : null,
        h("div", { class: "bar", "aria-hidden": "true" }, null, [h("i", { style: `width:${pct ?? 6}%`, class: pct === null ? "indeterminate" : "" })]),
        h("p", { class: `state${failed ? " failed" : ""}` }, TaboraUpdate.statusText()),
        h("div", { class: "actions" }, null, [quit, manual, action].filter(Boolean)),
      ].filter(Boolean))
    );
    w.hidden = false;
  },

  updateWallHide() {
    if (this.upd.wall) {
      this.upd.wall.hidden = true;
    }
  },
});
