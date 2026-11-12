/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Pages sent between the devices of the account ("Send to device"). The rules are the ones of the
 * browser on the computer (sync/SyncSources.sys.mjs, collection "sent"): every device keeps one
 * record under its own ID with the pages it sent during the last week (its outbox); a device
 * reads the records of the others, opens what is addressed to it once and remembers what it has
 * opened. Nothing is deleted by the receiver.
 *
 * It belongs to tab sync: with tabs turned off nothing is sent and nothing is opened.
 *
 * The app opens the page (message "sent-open") and answers whether it did; until then the page
 * stays unopened and is offered again on the next pass. After a sign-in, the pages that were
 * already lying there are not opened: they were sent before this phone joined. */

const KEEP_MS = 7 * 24 * 3600 * 1000;
const STALE_MS = 21 * 24 * 3600 * 1000; // same as for lists of tabs: a device silent for longer is not offered
const MAX = 50;
const SEEN_MAX = 400;
const STATE = "sent";
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const str = (value, max) => String(value ?? "").slice(0, max);

function item(it) {
  return it && ID_RE.test(it.id || "") && ID_RE.test(it.to || "") && typeof it.u === "string" && /^https?:\/\//i.test(it.u) && it.u.length <= 2048 && Number(it.at) > 0
    ? { id: it.id, to: it.to, u: it.u, t: str(it.t, 200), at: Number(it.at) }
    : null;
}

const items = list => (Array.isArray(list) ? list : []).map(item).filter(Boolean).slice(-MAX);

export class SentTabs {
  /**
   * @param {{ account: import("../core/account.js").Account, sync: import("../core/sync.js").SyncClient,
   *   bridge: { call(message: object, timeoutMs?: number): Promise<any> },
   *   store: { deviceId(): string, deviceName(): string, loadData(name: string): Promise<any>, saveData(name: string, value: any): Promise<void>, clearData(name: string): Promise<void> },
   *   enabled: () => boolean }} deps
   */
  constructor({ account, sync, bridge, store, enabled }) {
    this.account = account;
    this.sync = sync;
    this.bridge = bridge;
    this.store = store;
    this._enabled = enabled;
    this.state = null; // { v, email, seen: [id], skip }
  }

  get enabled() {
    return this._enabled();
  }

  async _load() {
    if (this.state && this.state.email === this.account.email) {
      return this.state;
    }
    const saved = await this.store.loadData(STATE);
    const ok = saved && saved.v === 1 && saved.email === this.account.email && Array.isArray(saved.seen);
    this.state = ok ? saved : { v: 1, email: this.account.email, seen: [], skip: false };
    return this.state;
  }

  async _save() {
    if (this.state) {
      await this.store.saveData(STATE, this.state);
    }
  }

  /** A sign-in has just happened: what is already lying in the outboxes is not to be opened. */
  async skipExisting() {
    this.state = { v: 1, email: this.account.email, seen: [], skip: true };
    await this._save().catch(() => {});
  }

  /** Sign-out: the list of opened pages is no longer needed. */
  async forget() {
    this.state = null;
    try {
      await this.store.clearData(STATE);
    } catch (e) {}
  }

  /** Devices a page can be sent to: [{ id, name }], recently active first. They are the devices
   * that publish their list of tabs, so a device with tab sync turned off is not offered. */
  targets(now = Date.now()) {
    const own = this.store.deviceId();
    return this.sync.list("tabs")
      .filter(({ id, data }) => id !== own && data && Array.isArray(data.tabs) && Number(data.at) >= now - STALE_MS)
      .map(({ id, data }) => ({ id, name: str(data.name, 80).trim(), at: Number(data.at) }))
      .sort((a, b) => b.at - a.at)
      .map(({ id, name }) => ({ id, name }));
  }

  _waiting(seen, now) {
    const own = this.store.deviceId();
    const out = [];
    for (const { id, data } of this.sync.list("sent")) {
      if (id === own || !data) {
        continue;
      }
      for (const it of items(data.items)) {
        if (it.to === own && it.at >= now - KEEP_MS && !seen.includes(it.id)) {
          out.push({ ...it, from: str(data.name, 80).trim() });
        }
      }
    }
    return out.sort((a, b) => a.at - b.at);
  }

  /** Open the pages addressed to this phone. Returns how many were opened. */
  async deliver(now = Date.now()) {
    if (!this.enabled || !this.account.signedIn || !this.sync.loaded) {
      return 0;
    }
    const state = await this._load();
    const waiting = this._waiting(state.seen, now);
    if (state.skip) {
      state.skip = false;
      state.seen = [...state.seen, ...waiting.map(it => it.id)].slice(-SEEN_MAX);
      await this._save();
      return 0;
    }
    let opened = 0;
    for (const it of waiting) {
      const r = await this.bridge.call({ type: "sent-open", url: it.u, title: it.t, from: it.from }, 15000);
      if (!r || r.ok !== true) {
        break; // the app cannot open pages now: the rest waits for the next pass, in the same order
      }
      state.seen.push(it.id);
      opened++;
    }
    if (opened) {
      state.seen = state.seen.slice(-SEEN_MAX);
      await this._save();
    }
    return opened;
  }

  /** Send pages to a device of the account. Resolves once they are on the server; throws if the
   * server could not be reached (nothing is kept for later then).
   *
   * @param {string} to the device's ID
   * @param {{ url: string, title?: string }[]} pages
   * @returns {Promise<number>} how many pages were sent (only sites are)
   */
  async send(to, pages, now = Date.now()) {
    if (!this.enabled || !this.account.signedIn) {
      throw Object.assign(new Error("tab sync is off"), { code: "sent-off" });
    }
    const own = this.store.deviceId();
    if (!this.sync.loaded) {
      await this.sync.refresh();
    }
    const add = (Array.isArray(pages) ? pages : [])
      .map((p, i) => item({ id: `s${now.toString(36)}${i.toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`, to, u: p?.url, t: p?.title || "", at: now }))
      .filter(Boolean)
      .slice(0, MAX);
    if (!add.length || to === own) {
      return 0;
    }
    for (let attempt = 0; ; attempt++) {
      const mine = this.sync.get("sent", own);
      const kept = items(mine?.items).filter(it => it.at >= now - KEEP_MS);
      try {
        await this.sync.put("sent", own, { name: str(this.store.deviceName(), 80), items: [...kept, ...add].slice(-MAX) });
        return add.length;
      } catch (e) {
        // the record under our ID was changed not by us (a sign-in from a copy of the phone's
        // data): the client has already fetched its fresh version, we add our pages to it
        if (e.code !== "conflict" || attempt) {
          throw e;
        }
      }
    }
  }

  /** Remove this phone's outbox from the server: tab sync is being turned off, or it is a sign-out. */
  async drop() {
    if (!this.account.signedIn) {
      return;
    }
    if (!this.sync.loaded) {
      await this.sync.refresh();
    }
    const own = this.store.deviceId();
    if (this.sync.get("sent", own)) {
      await this.sync.remove("sent", own);
    }
  }
}
