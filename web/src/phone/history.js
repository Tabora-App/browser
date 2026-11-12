/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* History of visits between the devices of the account. The rules are the ones of the browser on
 * the computer (sync/SyncSources.sys.mjs, collection "history"): every device publishes only its
 * own visits, one record per day ("<device ID>-<yyyymmdd>", the day in UTC) with the pages of the
 * day: address, title, time of the last visit, number of visits. Records of other devices are
 * only read and shown on the "History of other devices" screen; they are never written into the
 * phone's own history. So a page deleted from history on the phone disappears from the phone's
 * records, and nothing comes back from another device by itself.
 *
 * The visits are read from the app's history storage (message "history-list"): private tabs
 * leave nothing there, and the app leaves out downloads, frames and redirects. */

import { pageSetting } from "./tabs.js";

const DAYS = 60;
const DAY_PAGES = 250;
const DAY_BYTES = 48 * 1024;
const DAY_MS = 86400000;
const DAY_RE = /^\d{8}$/;
const SETTING = "tabora.sync.history";

const str = (value, max) => String(value ?? "").slice(0, max);
const dayOf = ms => new Date(ms).toISOString().slice(0, 10).replaceAll("-", "");
const dayStart = day => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(4, 6)) - 1, Number(day.slice(6, 8)));
const firstDay = now => dayOf(now - DAYS * DAY_MS);

function page(p) {
  return p && typeof p.u === "string" && /^https?:\/\/[^/@]+(\/|$)/i.test(p.u) && p.u.length <= 2048 && Number(p.at) > 0
    ? { u: p.u, t: str(p.t, 200), at: Number(p.at), ...(Number(p.n) > 1 ? { n: Math.min(Math.floor(Number(p.n)), 9999) } : {}) }
    : null;
}

/** Visits [{ u, t, at }] → Map day → pages of the day, the latest first, within the limits of a record. */
export function byDay(visits) {
  const days = new Map();
  for (const v of Array.isArray(visits) ? visits : []) {
    const one = page({ u: v?.u, t: v?.t, at: v?.at });
    if (!one) {
      continue;
    }
    const day = dayOf(one.at);
    if (!days.has(day)) {
      days.set(day, new Map());
    }
    const pages = days.get(day);
    const had = pages.get(one.u);
    if (!had) {
      pages.set(one.u, { ...one, n: 1 });
    } else {
      had.n++;
      if (one.at >= had.at) {
        had.at = one.at;
        had.t = one.t || had.t;
      }
    }
  }
  const out = new Map();
  for (const [day, pages] of days) {
    const list = [...pages.values()].sort((a, b) => b.at - a.at).slice(0, DAY_PAGES).map(page);
    // a day that does not fit loses its earliest pages
    while (list.length > 1 && JSON.stringify(list).length > DAY_BYTES) {
      list.splice(Math.ceil(list.length * 0.9));
    }
    out.set(day, list);
  }
  return out;
}

export class History {
  /**
   * @param {{ account: import("../core/account.js").Account, sync: import("../core/sync.js").SyncClient,
   *   bridge: { call(message: object, timeoutMs?: number): Promise<any> },
   *   store: { deviceId(): string, deviceName(): string },
   *   settings?: { get(): boolean, set(on: boolean): void } }} deps
   */
  constructor({ account, sync, bridge, store, settings = pageSetting(SETTING) }) {
    this.account = account;
    this.sync = sync;
    this.bridge = bridge;
    this.store = store;
    this.settings = settings;
    this.error = "";
  }

  get enabled() {
    return this.settings.get();
  }

  set enabled(on) {
    this.settings.set(!!on);
  }

  _mine() {
    const prefix = `${this.store.deviceId()}-`;
    return this.sync.list("history").filter(({ id }) => id.startsWith(prefix));
  }

  /**
   * Bring the phone's records on the server in line with its history.
   * full: the whole window (two months); otherwise only today and yesterday, where the changes are.
   * Returns how many records were written or removed.
   */
  async push({ full = true, now = Date.now() } = {}) {
    if (!this.enabled || !this.account.signedIn) {
      return 0;
    }
    const first = firstDay(now);
    const from = full ? first : dayOf(now - DAY_MS);
    const answer = await this.bridge.call({ type: "history-list", since: dayStart(from) }, 30000);
    if (!answer || !Array.isArray(answer.visits)) {
      this.error = answer?.error || "the app did not answer about history";
      throw Object.assign(new Error(this.error), { code: "history-storage" });
    }
    this.error = "";
    const days = byDay(answer.visits);
    const prefix = `${this.store.deviceId()}-`;
    const name = str(this.store.deviceName(), 80);
    const changes = [];
    for (const [day, pages] of days) {
      if (day < from) {
        continue;
      }
      const had = this.sync.get("history", prefix + day);
      if (!had || JSON.stringify(had.p) !== JSON.stringify(pages)) {
        changes.push({ c: "history", id: prefix + day, data: { name, day, p: pages } });
      }
    }
    // days of the checked range that have no visits any more, and days that left the window
    for (const { id } of this._mine()) {
      const day = id.slice(prefix.length);
      if (day < first || (day >= from && !days.has(day))) {
        changes.push({ c: "history", id, data: null });
      }
    }
    for (let at = 0; at < changes.length; at += 40) {
      await this.sync.write(changes.slice(at, at + 40));
    }
    return changes.length;
  }

  /** Remove the phone's history from the server: history sync is being turned off, or it is a sign-out. */
  async drop() {
    if (!this.account.signedIn) {
      return;
    }
    if (!this.sync.loaded) {
      await this.sync.refresh();
    }
    const mine = this._mine().map(({ id }) => ({ c: "history", id, data: null }));
    for (let at = 0; at < mine.length; at += 40) {
      await this.sync.write(mine.slice(at, at + 40));
    }
  }

  /**
   * Pages visited on other devices, most recent first; one entry per address.
   *
   * @param {{ query?: string, since?: number, limit?: number, now?: number }} [filter]
   * @returns {{ url: string, title: string, at: number, device: string }[]}
   */
  others({ query = "", since = 0, limit = 300, now = Date.now() } = {}) {
    if (!this.enabled) {
      return [];
    }
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const prefix = `${this.store.deviceId()}-`;
    const first = firstDay(now);
    const best = new Map();
    for (const { id, data } of this.sync.list("history")) {
      if (id.startsWith(prefix) || !data || !DAY_RE.test(data.day || "") || data.day < first || !Array.isArray(data.p)) {
        continue;
      }
      const device = str(data.name, 80).trim();
      for (const raw of data.p) {
        const p = page(raw);
        if (!p || p.at < since || (best.get(p.u)?.at || 0) >= p.at) {
          continue;
        }
        if (words.length) {
          const text = `${p.t} ${p.u}`.toLowerCase();
          if (!words.every(w => text.includes(w))) {
            continue;
          }
        }
        best.set(p.u, { url: p.u, title: p.t, at: p.at, device });
      }
    }
    return [...best.values()].sort((a, b) => b.at - a.at).slice(0, limit);
  }
}
