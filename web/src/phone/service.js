/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Аккаунт Tabora в приложении для телефона: вход и синхронизация. Работает в фоновой странице
 * встроенного модуля всё время, пока запущено приложение; экран аккаунта (main.js) берёт этот же
 * объект и ничего своего не хранит.
 *
 * Сверка с сервером: сразу после входа и запуска, через несколько секунд после перемены во
 * вкладках телефона, по просьбе приложения (открыли список вкладок) и раз в десять минут.
 * При сбое связи повторы идут реже и реже; вход при этом не теряется. */

import { Account } from "../core/account.js";
import { SyncClient } from "../core/sync.js";
import { t } from "../core/i18n.js";
import { TabSync } from "./tabs.js";

const QUIET_MS = 5000; // пауза после перемены во вкладках перед сверкой
const PERIOD_MS = 10 * 60 * 1000;
const RETRY_MS = [30_000, 120_000, 600_000];

export class Service {
  /**
   * @param {{ bridge: import("./bridge.js").Bridge, store: import("./store.js").NativeStore,
   *   api: import("../core/api.js").Api, settings?: { get(): boolean, set(on: boolean): void } }} deps
   */
  constructor({ bridge, store, api, settings }) {
    this.bridge = bridge;
    this.store = store;
    this.api = api;
    this.account = new Account({ api, store, deviceName: () => store.deviceName() });
    this.sync = new SyncClient(this.account);
    this.tabs = new TabSync({ account: this.account, sync: this.sync, store, ...(settings ? { settings } : {}) });
    this._listeners = new Set();
    this._timer = null;
    this._period = null;
    this._running = null;
    this._again = false;
    this._fails = 0;
    this._sent = "";
    /** Готовность: сохранённый вход прочитан. Экран аккаунта ждёт её перед показом. */
    this.ready = this._start();
  }

  async _start() {
    this.bridge.onMessage(message => this._fromApp(message));
    this.account.subscribe(what => this._onAccount(what));
    this.sync.subscribe(() => this._changed());
    await this.store.init();
    this.bridge.connect();
    await this.account.restore();
    this._period = setInterval(() => this.soon(0), PERIOD_MS);
    this._changed();
  }

  /** Остановить таймеры (в проверках). */
  stop() {
    clearTimeout(this._timer);
    clearInterval(this._period);
  }

  /* ---- события ---- */

  _fromApp(message) {
    if (message.type === "tabs") {
      if (this.tabs.setLocal(message.tabs)) {
        this.soon(QUIET_MS);
      }
    } else if (message.type === "sync") {
      this.soon(0);
    }
  }

  _onAccount(what) {
    if (what === "signed-in") {
      this._fails = 0;
      this.soon(0);
    } else if (what === "signed-out" || what === "expired") {
      clearTimeout(this._timer);
      this.sync.reset();
      this._fails = 0;
    }
    this._changed();
  }

  /* ---- сверка ---- */

  soon(ms = 0) {
    if (!this.account.signedIn) {
      return;
    }
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.run().catch(() => {}), ms);
  }

  /** Сверить сейчас. Одновременных сверок не бывает: просьба во время сверки ставит следующую. */
  run() {
    if (this._running) {
      this._again = true;
      return this._running;
    }
    this._running = this._run().finally(() => {
      this._running = null;
      if (this._again) {
        this._again = false;
        this.soon(QUIET_MS);
      }
    });
    return this._running;
  }

  async _run() {
    if (!this.account.signedIn || !this.tabs.enabled) {
      return;
    }
    try {
      if (!this.account.keys?.dataKey) {
        await this.account.refreshKeys();
      }
      await this.sync.refresh();
      await this.tabs.push();
      this._fails = 0;
    } catch (e) {
      if (e.code !== "session-expired" && e.code !== "signed-out" && e.code !== "sync-key") {
        this._fails++;
        this.soon(RETRY_MS[Math.min(this._fails, RETRY_MS.length) - 1]);
      }
    } finally {
      this._changed();
    }
  }

  /* ---- действия экрана аккаунта ---- */

  /** Включить или выключить синхронизацию вкладок. Выключение убирает список телефона с сервера. */
  async setTabs(on) {
    if (!on) {
      await this.tabs.drop();
    }
    this.tabs.enabled = !!on;
    this._changed();
    if (on) {
      this.soon(0);
    }
  }

  /** Выход: список вкладок телефона убирается с сервера, сессия завершается, вход стирается. */
  async signOut() {
    if (this.tabs.enabled) {
      try {
        await this.tabs.drop();
      } catch (e) {
        // нет связи: список останется у других устройств, пока не устареет
      }
    }
    await this.account.signOut();
  }

  /* ---- состояние ---- */

  state() {
    const a = this.account;
    const signedIn = a.signedIn && !a._held;
    return {
      signedIn,
      email: signedIn ? a.email : "",
      keys: a.keys?.state || "none",
      tabsOn: this.tabs.enabled,
      status: this.sync.status,
      error: this.sync.error,
      at: this.sync.at,
      devices: signedIn && this.tabs.enabled ? this.tabs.others() : [],
    };
  }

  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _changed() {
    const s = this.state();
    for (const fn of [...this._listeners]) {
      try {
        fn(s);
      } catch (e) {
        // экран аккаунта закрыли, не отписавшись: его функция больше не вызывается
        console.error(e);
        this._listeners.delete(fn);
      }
    }
    const message = {
      type: "state", signedIn: s.signedIn, email: s.email, tabsOn: s.tabsOn, status: s.status, at: s.at,
      devices: s.devices.map(d => ({ id: d.id, name: d.name || t`Другое устройство`, at: d.at, tabs: d.tabs.map(x => ({ t: x.t, u: x.u })) })),
    };
    const mark = JSON.stringify(message);
    if (mark !== this._sent) {
      this._sent = mark;
      this.bridge.post(message);
    }
  }
}
