/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Аккаунт Tabora в приложении для телефона: вход и синхронизация. Работает в фоновой странице
 * встроенного модуля всё время, пока запущено приложение; экраны модуля (аккаунт, коды) берут
 * этот же объект и ничего своего не хранят.
 *
 * Синхронизируются вкладки, коды входа, пароли сайтов, закладки и список пространств — каждое
 * включается отдельно. Записи остальных наборов аккаунта модуль не расшифровывает и в памяти не
 * держит. Пароли, закладки и пространства лежат у приложения; модуль сливает их с сервером
 * (logins.js, marks.js, spaces.js).
 *
 * Сверка с сервером: сразу после входа и запуска, через несколько секунд после перемены во
 * вкладках телефона, по просьбе приложения (открыли список вкладок) и раз в десять минут.
 * При сбое связи повторы идут реже и реже; вход при этом не теряется.
 *
 * Копия расшифрованных данных лежит у приложения (зашифрованной ключом из хранилища ключей
 * Android): коды и вкладки других устройств видны сразу после запуска и без сети. */

import { Account } from "../core/account.js";
import { SyncClient } from "../core/sync.js";
import { t } from "../core/i18n.js";
import { Codes } from "./codes.js";
import { History } from "./history.js";
import { Logins } from "./logins.js";
import { Marks } from "./marks.js";
import { SentTabs } from "./sent.js";
import { Spaces } from "./spaces.js";
import { TabSync } from "./tabs.js";

const QUIET_MS = 5000; // пауза после перемены во вкладках перед сверкой
const PERIOD_MS = 10 * 60 * 1000;
const RETRY_MS = [30_000, 120_000, 600_000];
const SAVE_MS = 1500; // пауза перед записью копии данных: перемены приходят пачкой
const CACHE = "sync";

export class Service {
  /**
   * @param {{ bridge: import("./bridge.js").Bridge, store: import("./store.js").NativeStore,
   *   api: import("../core/api.js").Api, settings?: { tabs?: { get(): boolean, set(on: boolean): void }, codes?: { get(): boolean, set(on: boolean): void }, logins?: { get(): boolean, set(on: boolean): void } },
   *   fillTestOrigin?: string }} deps
   *   fillTestOrigin — адрес проверочной страницы, которой автоввод разрешён без https (только в
   *   сборке для проверок; в выпуске пусто).
   */
  constructor({ bridge, store, api, settings = {}, fillTestOrigin = "" }) {
    this.bridge = bridge;
    this.store = store;
    this.api = api;
    this.fillTestOrigin = fillTestOrigin;
    this.account = new Account({ api, store, deviceName: () => store.deviceName() });
    this.sync = new SyncClient(this.account, { only: [] });
    this.tabs = new TabSync({ account: this.account, sync: this.sync, store, ...(settings.tabs ? { settings: settings.tabs } : {}) });
    this.codes = new Codes({ account: this.account, sync: this.sync, ...(settings.codes ? { settings: settings.codes } : {}) });
    this.logins = new Logins({ account: this.account, sync: this.sync, bridge, store, ...(settings.logins ? { settings: settings.logins } : {}) });
    this.marks = new Marks({ account: this.account, sync: this.sync, bridge, store, ...(settings.marks ? { settings: settings.marks } : {}) });
    this.spaces = new Spaces({ account: this.account, sync: this.sync, bridge, store, ...(settings.spaces ? { settings: settings.spaces } : {}) });
    this.history = new History({ account: this.account, sync: this.sync, bridge, store, ...(settings.history ? { settings: settings.history } : {}) });
    // "Send to device" is a part of tab sync: it is on and off together with it
    this.sent = new SentTabs({ account: this.account, sync: this.sync, bridge, store, enabled: () => this.tabs.enabled });
    /** Данные синхронизации стёрли с сервера с другого устройства: синхронизация здесь выключена. */
    this.erased = false;
    this._listeners = new Set();
    this._timer = null;
    this._period = null;
    this._saveTimer = null;
    this._running = null;
    this._queued = null;
    this._full = true; // следующая сверка полная; попутная (после перемены во вкладках) закладки читает реже
    this._fails = 0;
    this._sent = "";
    this._dirty = false;
    this._starting = true;
    this._stopped = false;
    /** Готовность: сохранённый вход и копия данных прочитаны. Экраны ждут её перед показом. */
    this.ready = this._start();
  }

  async _start() {
    this.bridge.onMessage(message => this._fromApp(message));
    this.account.subscribe(what => this._onAccount(what));
    this.sync.subscribe(what => {
      if (what === "data") {
        this._dirty = true;
        this._saveSoon();
      }
      this._changed();
    });
    await this.store.init();
    this.bridge.connect();
    this.sync.setOnly(this._wanted());
    await this.account.restore();
    if (this.account.signedIn) {
      const saved = await this.store.loadData(CACHE);
      if (saved && this.sync.restore(saved)) {
        this._dirty = false;
      }
    }
    this._starting = false;
    this._period = setInterval(() => this.soon(0), PERIOD_MS);
    this._changed();
    this.soon(0);
  }

  /** Остановить службу (в проверках): таймеры сняты и больше не заводятся. */
  stop() {
    this._stopped = true;
    clearTimeout(this._timer);
    clearTimeout(this._saveTimer);
    clearInterval(this._period);
  }

  /** Наборы синхронизации, которые нужны при нынешних настройках. */
  _wanted() {
    return [this.tabs.enabled && "tabs", this.tabs.enabled && "sent", this.codes.enabled && "otp", this.logins.enabled && "logins", this.marks.enabled && "marks", this.spaces.enabled && "spaces", this.history.enabled && "history"].filter(Boolean);
  }

  /* ---- события ---- */

  _fromApp(message) {
    if (message.type === "tabs") {
      if (this.tabs.setLocal(message.tabs)) {
        this.soon(QUIET_MS, { full: false });
      }
    } else if (message.type === "sync") {
      this.soon(0);
    } else if (message.type === "send-tab") {
      this._sendTab(message);
    }
  }

  /** The app asks to send pages to devices of the account ("Share" → "Send to device"). The
   * answer goes back by the channel: { type: "sent-result", rid, ok, count }. */
  _sendTab(message) {
    // one at a time: each request adds to the same record
    this._sending = (this._sending || Promise.resolve()).then(async () => {
      let count = 0;
      let ok = true;
      try {
        const pages = (Array.isArray(message.pages) ? message.pages : []).slice(0, 20);
        for (const to of (Array.isArray(message.to) ? message.to : []).slice(0, 10)) {
          count += await this.sent.send(String(to), pages);
        }
      } catch (e) {
        ok = false;
      }
      this.bridge.post({ type: "sent-result", rid: message.rid, ok: ok && count > 0, count });
    });
  }

  _onAccount(what) {
    if (what === "signed-in") {
      this._fails = 0;
      if (!this._starting) {
        // a sign-in made now, not the saved one read at start: pages sent before it are not opened
        this.sent.skipExisting();
        this.soon(0);
      }
    } else if (what === "signed-out" || what === "expired") {
      clearTimeout(this._timer);
      clearTimeout(this._saveTimer);
      this.sync.reset();
      this.codes.forget();
      this.logins.forget();
      this.marks.forget();
      this.spaces.forget();
      this.sent.forget();
      this.history.error = "";
      this.erased = false;
      this._dirty = false;
      this._fails = 0;
      this.store.clearData(CACHE).catch(() => {});
    }
    this._changed();
  }

  /* ---- копия данных у приложения ---- */

  _saveSoon() {
    if (this._stopped) {
      return;
    }
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.saveNow().catch(() => {}), SAVE_MS);
  }

  /** Записать копию данных сейчас, если она менялась. */
  async saveNow() {
    clearTimeout(this._saveTimer);
    if (!this._dirty || !this.account.signedIn || !this.sync.loaded) {
      return;
    }
    this._dirty = false;
    try {
      await this.store.saveData(CACHE, this.sync.snapshot());
    } catch (e) {
      this._dirty = true; // приложение не приняло запись: попробуем при следующей перемене
    }
  }

  /* ---- сверка ---- */

  soon(ms = 0, { full = true } = {}) {
    if (!this.account.signedIn || this._stopped) {
      return;
    }
    if (full) {
      this._full = true;
    }
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.run({ full: false }).catch(() => {}), ms);
  }

  /** Сверить сейчас. Одновременных сверок не бывает: просьба во время сверки ставит следующую. */
  /** Сверить сейчас. full: false — попутная сверка, если полной никто не просил (см. soon). */
  run({ full = true } = {}) {
    if (full) {
      this._full = true;
    }
    if (this._running) {
      // сверка уже идёт и могла начаться до перемены, ради которой просят эту: сразу после неё
      // пройдёт ещё одна — общая для всех, кто попросил за это время
      this._queued ||= this._running.then(() => {
        this._queued = null;
        return this.run({ full: false });
      });
      return this._queued;
    }
    const all = this._full;
    this._full = false;
    this._running = this._run(all).finally(() => {
      this._running = null;
    });
    return this._running;
  }

  async _run(full = true) {
    if (!this.account.signedIn || !this._wanted().length) {
      return;
    }
    try {
      if (!this.account.keys?.dataKey) {
        await this.account.refreshKeys();
      }
      await this.sync.refresh();
      await this.tabs.push();
      await this.sent.deliver();
      await this.logins.merge();
      await this.marks.merge({ full });
      await this.spaces.merge().catch(e => {
        if (e.code !== "spaces-storage") {
          throw e; // приложение не ответило о пространствах — остальное сверено, ошибка видна на экране аккаунта
        }
      });
      await this.history.push({ full }).catch(e => {
        if (e.code !== "history-storage") {
          throw e; // the app did not answer about history: the rest is in sync, the error is on the account screen
        }
      });
      this._fails = 0;
    } catch (e) {
      if (e.code === "sync-erased") {
        await this._erased();
      } else if (e.code !== "session-expired" && e.code !== "signed-out" && e.code !== "sync-key") {
        this._fails++;
        this._full = this._full || full; // несостоявшаяся полная сверка остаётся полной при повторе
        this.soon(RETRY_MS[Math.min(this._fails, RETRY_MS.length) - 1], { full: false });
      }
    } finally {
      this._changed();
    }
  }

  /** Данные стёрли с сервера с другого устройства («Стереть с сервера»): заливать свои обратно
   * нельзя. Синхронизация на телефоне выключается; пароли и вкладки на самом телефоне остаются
   * как были, пока человек не включит синхронизацию снова. */
  async _erased() {
    this.tabs.enabled = false;
    this.codes.enabled = false;
    this.logins.enabled = false;
    await this.logins.forget();
    this.marks.enabled = false;
    await this.marks.forget();
    this.spaces.enabled = false;
    await this.spaces.forget();
    this.history.enabled = false;
    this.sync.reset();
    this.sync.setOnly([]);
    this.erased = true;
    this._dirty = false;
    await this.store.clearData(CACHE).catch(() => {});
  }

  /* ---- действия экранов ---- */

  /** Включить или выключить синхронизацию вкладок. Выключение убирает список телефона с сервера. */
  async setTabs(on) {
    if (!on) {
      await this.tabs.drop();
      await this.sent.drop();
    }
    this.tabs.enabled = !!on;
    this._applyWanted(on);
  }

  /** Включить или выключить коды входа на этом телефоне. Выключение стирает их здесь; на сервере
   * и других устройствах они остаются. */
  async setCodes(on) {
    this.codes.enabled = !!on;
    this._applyWanted(on);
  }

  /** Включить или выключить синхронизацию паролей сайтов. Выключение ничего не стирает: пароли
   * остаются и в хранилище телефона, и в аккаунте. */
  async setLogins(on) {
    this.logins.enabled = !!on;
    if (!on) {
      await this.logins.forget();
    }
    this._applyWanted(on);
  }

  /** Решение о паролях, пропавших с телефона разом: "delete" или "restore" (см. logins.js). */
  async resolveLoginsHold(what) {
    await this.logins.resolveHold(what);
    this._changed();
    this.soon(0);
  }

  async setMarks(on) {
    this.marks.enabled = !!on;
    if (!on) {
      await this.marks.forget();
    }
    this._applyWanted(on);
  }

  /** Turn history sync on or off. Turning it off removes the phone's history from the server;
   * the history of other devices is no longer kept on the phone. */
  async setHistory(on) {
    if (!on) {
      await this.history.drop();
    }
    this.history.enabled = !!on;
    this._applyWanted(on);
  }

  async setSpaces(on) {
    this.spaces.enabled = !!on;
    if (!on) {
      await this.spaces.forget();
    }
    this._applyWanted(on);
  }

  async resolveMarksHold(what) {
    await this.marks.resolveHold(what);
    this._changed();
    this.soon(0);
  }

  _applyWanted(on) {
    if (on) {
      this.erased = false;
    }
    const again = this.sync.setOnly(this._wanted());
    this._dirty = true;
    this._saveSoon();
    this._changed();
    if (on || again) {
      this.soon(0);
    }
  }

  /** Попросить человека подтвердить, что телефон в его руках: отпечаток, лицо или код блокировки.
   * Недавнее подтверждение приложение помнит и повторно не спрашивает. */
  async unlock() {
    const r = await this.bridge.call({ type: "auth" });
    return !!r.ok;
  }

  /* ---- автоввод кода на странице сайта (скрипт fill.js) ---- */

  /** Хост страницы, приславшей сообщение, или "": коды выдаются только документу https того же
   * сайта, что и вкладка. Адрес берётся из сведений движка об отправителе, а не из сообщения. */
  _pageHost(sender) {
    try {
      const url = new URL(sender?.url || "");
      if (url.protocol !== "https:" && !(this.fillTestOrigin && url.origin === this.fillTestOrigin)) {
        return "";
      }
      if (sender.frameId && sender.tab?.url && new URL(sender.tab.url).host !== url.host) {
        return "";
      }
      return url.hostname.toLowerCase();
    } catch (e) {
      return "";
    }
  }

  /**
   * Сообщение от скрипта автоввода:
   *   { type: "otp-field" }      → { entries: [{ id, label }], text } — какие коды привязаны к сайту
   *                                 (без секретов и самих кодов);
   *   { type: "otp-fill", id }   → { code } после подтверждения владельца телефона, иначе { error }.
   */
  async fromPage(message, sender) {
    const host = this._pageHost(sender);
    if (!host || !message || typeof message !== "object") {
      return {};
    }
    await this.ready;
    const text = { fill: t`Вставить код`, failed: t`Код не вставлен` };
    if (message.type === "otp-field") {
      const entries = this.codes.forHost(host).map(e => ({ id: e.id, label: [e.issuer, e.account].filter(Boolean).join(", ") }));
      return { entries, text };
    }
    if (message.type === "otp-fill") {
      const entry = this.codes.forHost(host).find(e => e.id === message.id);
      if (!entry) {
        return { error: text.failed };
      }
      if (!(await this.unlock())) {
        return { error: t`Не подтверждено` };
      }
      try {
        return { code: (await this.codes.code(entry.id)).code };
      } catch (e) {
        return { error: text.failed };
      }
    }
    return {};
  }

  /** Открыть экран модуля в приложении: "account", "codes" или "history". */
  open(page) {
    this.bridge.post({ type: "open", page });
  }

  /** Open a site in an ordinary tab of the app (a page from the history of other devices). */
  openUrl(url) {
    if (/^https?:\/\//i.test(url || "")) {
      this.bridge.post({ type: "open-url", url });
    }
  }

  /** Открыть сканер QR-кодов приложения. Текст кода или пустая строка, если сканер закрыли. */
  async scanQr() {
    if (this.fillTestOrigin) {
      // проверочная сборка: код подкладывает проверочный сервер, камера эмулятору не нужна
      try {
        const res = await fetch(`${this.fillTestOrigin}/qr.txt`, { cache: "no-store", credentials: "omit" });
        const text = res.ok ? (await res.text()).trim() : "";
        if (text) {
          return text.slice(0, 512);
        }
      } catch (e) {}
    }
    const r = await this.bridge.call({ type: "qr-scan" }, 180000);
    if (r.denied) {
      throw Object.assign(new Error(t`Чтобы считать код, разрешите Tabora доступ к камере в настройках телефона`), { code: "no-camera" });
    }
    return typeof r.text === "string" ? r.text.slice(0, 512) : "";
  }

  /** Выход: список вкладок телефона убирается с сервера, сессия завершается, вход и копия данных стираются. */
  async signOut() {
    if (this.tabs.enabled) {
      try {
        await this.tabs.drop();
        await this.sent.drop();
      } catch (e) {
        // нет связи: список останется у других устройств, пока не устареет
      }
    }
    if (this.history.enabled) {
      try {
        await this.history.drop();
      } catch (e) {
        // no connection: the phone's history stays with the other devices until it grows old
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
      codesOn: this.codes.enabled,
      codes: signedIn ? this.codes.list().length : 0,
      loginsOn: this.logins.enabled,
      logins: signedIn && this.logins.enabled ? this.logins.count : 0,
      loginsHold: signedIn ? this.logins.hold : null,
      loginsError: this.logins.error,
      marksOn: this.marks.enabled,
      marks: signedIn && this.marks.enabled ? this.marks.count : 0,
      marksHold: signedIn ? this.marks.hold : null,
      marksError: this.marks.error,
      spacesOn: this.spaces.enabled,
      spaces: signedIn && this.spaces.enabled ? this.spaces.count : 0,
      spacesError: this.spaces.error,
      erased: this.erased,
      status: this.sync.status,
      error: this.sync.error,
      at: this.sync.at,
      loaded: this.sync.loaded,
      devices: signedIn && this.tabs.enabled ? this.tabs.others() : [],
      targets: signedIn && this.tabs.enabled ? this.sent.targets() : [],
      historyOn: this.history.enabled,
      historyError: this.history.error,
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
        // экран закрыли, не отписавшись: его функция больше не вызывается
        console.error(e);
        this._listeners.delete(fn);
      }
    }
    const message = {
      type: "state", signedIn: s.signedIn, email: s.email, tabsOn: s.tabsOn, codesOn: s.codesOn, codes: s.codes, loginsOn: s.loginsOn, status: s.status, at: s.at,
      devices: s.devices.map(d => ({ id: d.id, name: d.name || t`Другое устройство`, at: d.at, tabs: d.tabs.map(x => ({ t: x.t, u: x.u })) })),
      // devices a page can be sent to ("Share" → "Send to device")
      targets: s.targets.map(d => ({ id: d.id, name: d.name || t`Другое устройство` })),
      // the app shows the "History of other devices" row on its history screen
      historyOn: s.historyOn,
    };
    const mark = JSON.stringify(message);
    if (mark !== this._sent) {
      this._sent = mark;
      this.bridge.post(message);
    }
  }
}
