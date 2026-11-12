/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Открытые вкладки между устройствами. Правила те же, что в браузере на компьютере
 * (sync/SyncSources.sys.mjs, набор tabs): каждое устройство ведёт одну запись — список своих
 * вкладок под своим номером; чужие записи только читает и никогда не меняет. Приватные вкладки
 * и служебные страницы в список не попадают (приложение их не присылает, а здесь остаются
 * только адреса http и https). */

const MAX_TABS = 200;
const STALE_MS = 21 * 24 * 3600 * 1000; // давно не обновлявшиеся списки не показываются
const REFRESH_MS = 12 * 3600 * 1000; // запись без перемен освежается, чтобы её не сочли давней
const SETTING = "tabora.sync.tabs";

const str = (value, max) => String(value ?? "").slice(0, max);

function clean(list) {
  return (Array.isArray(list) ? list : [])
    .filter(x => x && typeof x.u === "string" && /^https?:\/\//i.test(x.u) && x.u.length <= 2048)
    .slice(0, MAX_TABS)
    .map(x => ({ t: str(x.t, 200), u: x.u, ...(x.p ? { p: 1 } : {}) }));
}

/** Переключатель в хранилище страницы: включён, пока человек не выключит. С on = false —
 * наоборот: выключен, пока человек не включит. */
export function pageSetting(key, on = true) {
  return {
    get() {
      try {
        const saved = localStorage.getItem(key);
        return saved === null ? on : saved !== "0";
      } catch (e) {
        return on;
      }
    },
    set(on) {
      try {
        localStorage.setItem(key, on ? "1" : "0");
      } catch (e) {}
    },
  };
}

export class TabSync {
  /**
   * @param {{ account: import("../core/account.js").Account, sync: import("../core/sync.js").SyncClient,
   *   store: { deviceId(): string, deviceName(): string }, settings?: { get(): boolean, set(on: boolean): void } }} deps
   */
  constructor({ account, sync, store, settings = pageSetting(SETTING) }) {
    this.account = account;
    this.sync = sync;
    this.store = store;
    this.settings = settings;
    this._local = null; // пока приложение не прислало список, своя запись не трогается
  }

  get enabled() {
    return this.settings.get();
  }

  set enabled(on) {
    this.settings.set(!!on);
  }

  /** Список вкладок телефона от приложения. Возвращает true, если он изменился. */
  setLocal(list) {
    const next = clean(list);
    const changed = JSON.stringify(next) !== JSON.stringify(this._local);
    this._local = next;
    return changed;
  }

  record(now = Date.now()) {
    return { name: str(this.store.deviceName(), 80), at: now, tabs: this._local || [] };
  }

  /** Записать свой список на сервер, если он отличается от того, что там лежит. */
  async push(now = Date.now()) {
    if (!this.enabled || !this.account.signedIn || this._local === null) {
      return false;
    }
    const id = this.store.deviceId();
    const next = this.record(now);
    const mine = this.sync.get("tabs", id);
    const same = mine && JSON.stringify([mine.name, mine.tabs]) === JSON.stringify([next.name, next.tabs]);
    if (same && now - (Number(mine.at) || 0) < REFRESH_MS) {
      return false;
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await this.sync.put("tabs", id, next);
        return true;
      } catch (e) {
        // запись под нашим номером изменили не мы (вход с копии данных телефона): клиент уже
        // подтянул её свежую версию, пишем свой список поверх
        if (e.code !== "conflict" || attempt) {
          throw e;
        }
      }
    }
  }

  /** Убрать свой список с сервера: синхронизацию вкладок выключили или выходят из аккаунта. */
  async drop() {
    if (!this.account.signedIn) {
      return;
    }
    if (!this.sync.loaded) {
      await this.sync.refresh();
    }
    const id = this.store.deviceId();
    if (this.sync.get("tabs", id)) {
      await this.sync.remove("tabs", id);
    }
  }

  /** Вкладки других устройств аккаунта: [{ id, name, at, tabs: [{ t, u }] }], недавние первыми. */
  others(now = Date.now()) {
    const own = this.store.deviceId();
    return this.sync.list("tabs")
      .filter(({ id, data }) => id !== own && data && Array.isArray(data.tabs) && Number(data.at) >= now - STALE_MS)
      .map(({ id, data }) => ({ id, name: str(data.name, 80).trim(), at: Number(data.at), tabs: clean(data.tabs) }))
      .filter(d => d.tabs.length)
      .sort((a, b) => b.at - a.at);
  }
}
