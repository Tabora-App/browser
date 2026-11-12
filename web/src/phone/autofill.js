/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Autofill addresses and bank cards in the phone app. The records live in the app's autofill
 * storage (it fills them into forms); here they are merged with the sync collections "addresses"
 * and "cards". The rules of the merge are merge.js, the records are the ones of the browser on
 * the computer (sync/SyncSources.sys.mjs): { f: fields, c: created, m: changed }, the fields
 * under the names of the HTML autocomplete attribute. A card is its number, expiry and
 * cardholder's name; the security code is stored nowhere and is dropped from what arrives.
 *
 * The app's storage gives records its own IDs, so a table "record ID ↔ ID in the storage" is
 * kept. The same address or card saved both here and there before sync stays as one record. */

import { uuid } from "../core/bytes.js";
import { mergeCollection } from "./merge.js";
import { pageSetting } from "./tabs.js";

const ROUNDS = 4;
const MAX = 400;
const ADDRESS_FIELDS = ["name", "organization", "street-address", "address-level3", "address-level2", "address-level1", "postal-code", "country", "tel", "email"];

/** Fields of an address as they may be stored: known names, short strings. Null if nothing is left. */
export function addressFields(f) {
  const out = {};
  for (const name of ADDRESS_FIELDS) {
    const v = typeof f?.[name] === "string" ? f[name].trim().slice(0, name === "street-address" ? 500 : 200) : "";
    if (v) {
      out[name] = v;
    }
  }
  if (out.country && !/^[A-Za-z]{2}$/.test(out.country)) {
    delete out.country;
  }
  return Object.keys(out).length ? out : null;
}

/** Fields of a card: a number of 12–19 digits is required; month, year and name are optional. */
export function cardFields(f) {
  const number = String(f?.["cc-number"] ?? "").replace(/[\s-]/g, "");
  if (!/^\d{12,19}$/.test(number)) {
    return null;
  }
  const out = { "cc-number": number };
  const name = typeof f["cc-name"] === "string" ? f["cc-name"].trim().slice(0, 200) : "";
  if (name) {
    out["cc-name"] = name;
  }
  const month = Number(f["cc-exp-month"]);
  if (Number.isInteger(month) && month >= 1 && month <= 12) {
    out["cc-exp-month"] = month;
  }
  const year = Number(f["cc-exp-year"]);
  if (Number.isInteger(year) && year >= 2000 && year <= 2100) {
    out["cc-exp-year"] = year;
  }
  if (typeof f["cc-type"] === "string" && /^[a-z]{1,20}$/.test(f["cc-type"])) {
    out["cc-type"] = f["cc-type"];
  }
  return out;
}

const sameFields = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

/** What differs between the two kinds: the collection, the setting, the checks. */
export const ADDRESSES = {
  name: "addresses", setting: "tabora.sync.addresses", on: true, clean: addressFields, same: sameFields,
  hashable: f => f,
};
export const CARDS = {
  // the card's network is worked out from the number by every storage itself and is not a part of the content
  name: "cards", setting: "tabora.sync.cards", on: false, clean: cardFields, same: (a, b) => a["cc-number"] === b["cc-number"],
  hashable: ({ "cc-type": _type, ...rest }) => rest,
};

export class Autofill {
  /**
   * @param {{ account: import("../core/account.js").Account, sync: import("../core/sync.js").SyncClient,
   *   bridge: import("./bridge.js").Bridge, store: import("./store.js").NativeStore,
   *   kind: typeof ADDRESSES, settings?: { get(): boolean, set(on: boolean): void } }} deps
   */
  constructor({ account, sync, bridge, store, kind, settings = pageSetting(kind.setting, kind.on) }) {
    this.account = account;
    this.sync = sync;
    this.bridge = bridge;
    this.store = store;
    this.kind = kind;
    this.settings = settings;
    this.state = null; // { v, email, gen, shadow, map: { record ID: ID in the storage }, hold, allow }
    this.count = 0;
    this.error = "";
  }

  get enabled() {
    return this.settings.get();
  }

  set enabled(on) {
    this.settings.set(!!on);
  }

  /** Many records disappeared at once: { missing, of }; the deletions wait for the person's decision. */
  get hold() {
    return this.state?.hold || null;
  }

  async _load() {
    if (this.state && this.state.email === this.account.email) {
      return this.state;
    }
    const saved = await this.store.loadData(this.kind.name);
    const ok = saved && saved.v === 1 && saved.email === this.account.email && saved.shadow && typeof saved.shadow === "object" && saved.map && typeof saved.map === "object";
    this.state = ok ? saved : { v: 1, email: this.account.email, gen: null, shadow: {}, map: {}, hold: null, allow: false };
    return this.state;
  }

  async _save() {
    if (this.state) {
      await this.store.saveData(this.kind.name, this.state);
    }
  }

  /** Forget the merge (sign-out, turning off): the records stay on the phone. */
  async forget() {
    this.state = null;
    this.count = 0;
    this.error = "";
    try {
      await this.store.clearData(this.kind.name);
    } catch (e) {}
  }

  async _native(action, extra = {}) {
    const r = await this.bridge.call({ type: `${this.kind.name}-${action}`, ...extra }, 30000);
    if (!r || r.error || r.ok === false) {
      throw Object.assign(new Error(r?.error || "the app's autofill storage did not answer"), { code: "autofill-storage" });
    }
    return r;
  }

  /** Records of the app's storage: [{ guid, f, c, m }] with checked fields. */
  async _all() {
    const r = await this._native("list");
    if (!Array.isArray(r.items)) {
      // no answer is not an empty storage: taking it for one would delete the account's records
      throw Object.assign(new Error("the app's autofill storage did not answer"), { code: "autofill-storage" });
    }
    const out = [];
    for (const it of r.items) {
      const f = it && typeof it.guid === "string" && it.guid ? this.kind.clean(it.f) : null;
      if (f && out.length < MAX) {
        out.push({ guid: it.guid, f, c: Number(it.c) || 0, m: Number(it.m) || 0 });
      }
    }
    return out;
  }

  _source(state) {
    const { clean, same } = this.kind;
    const idOf = guid => Object.keys(state.map).find(id => state.map[id] === guid) || "";
    return {
      hashable: d => this.kind.hashable(d.f),
      newer: (a, b) => (a.m || 0) > (b.m || 0),

      list: async () => {
        const out = new Map();
        for (const rec of await this._all()) {
          let id = idOf(rec.guid);
          if (!id) {
            id = uuid().replaceAll("-", "").slice(0, 12); // saved on the phone: the record gets a new ID, of the length the computer's storage uses
            state.map[id] = rec.guid;
          }
          out.set(id, { f: rec.f, c: rec.c, m: rec.m });
        }
        return out;
      },

      apply: async changes => {
        const byGuid = new Map((await this._all()).map(rec => [rec.guid, rec]));
        const dirty = [];
        for (const { id, data } of changes) {
          try {
            const guid = state.map[id];
            const cur = guid ? byGuid.get(guid) : null;
            if (!data) {
              if (cur) {
                await this._native("delete", { guid });
                byGuid.delete(guid);
              }
              delete state.map[id];
              continue;
            }
            const f = clean(data.f);
            if (!f) {
              continue;
            }
            if (cur) {
              await this._native("update", { guid, f });
              continue;
            }
            // the same address or card saved both here and there before sync: one record stays, under the server's ID
            const twin = [...byGuid.values()].find(rec => same(rec.f, f));
            if (twin) {
              const old = idOf(twin.guid);
              if (old) {
                delete state.map[old]; // the former ID of this record will leave the server too
              }
              state.map[id] = twin.guid;
              if (!sameFields(this.kind.hashable(twin.f), this.kind.hashable(f))) {
                if (twin.m > (Number(data.m) || 0)) {
                  dirty.push(id); // what is here is newer: it goes to the server under the record's ID
                } else {
                  await this._native("update", { guid: twin.guid, f });
                }
              }
              continue;
            }
            const added = await this._native("add", { f });
            if (typeof added.guid === "string" && added.guid) {
              state.map[id] = added.guid;
              byGuid.set(added.guid, { guid: added.guid, f, c: 0, m: 0 });
            }
          } catch (e) {
            console.error(`Tabora: ${this.kind.name} ${id} is not applied`, e);
          }
        }
        return { dirty };
      },
    };
  }

  /** Merge the phone's records with the server. The sync client must already be refreshed. */
  async merge() {
    if (!this.enabled || !this.account.signedIn || !this.sync.loaded) {
      return false;
    }
    const state = await this._load();
    if (state.gen !== this.sync.gen) {
      // the data on the server was started anew: the former shadow does not belong to it
      state.shadow = {};
      state.hold = null;
      state.allow = false;
      state.gen = this.sync.gen;
    }
    const src = this._source(state);
    try {
      for (let round = 0; round < ROUNDS; round++) {
        const result = await mergeCollection({ sync: this.sync, name: this.kind.name, src, state });
        await this._save();
        if (result.clean) {
          break;
        }
        await this.sync.refresh();
      }
      this.count = (await src.list()).size;
      this.error = "";
      return true;
    } catch (e) {
      await this._save().catch(() => {});
      this.error = e.message || String(e);
      throw e;
    }
  }

  /**
   * What to do with the records that disappeared from the phone at once: "delete" removes them
   * from the other devices too, "restore" brings them back to the phone from the server.
   */
  async resolveHold(what) {
    const state = await this._load();
    if (!state.hold) {
      return;
    }
    if (what === "delete") {
      state.allow = true;
    } else {
      const local = await this._source(state).list();
      for (const id of Object.keys(state.shadow)) {
        if (state.shadow[id][1] && state.shadow[id][1] !== "!" && !local.has(id)) {
          delete state.shadow[id]; // the record will come from the server as a new one
          delete state.map[id];
        }
      }
    }
    state.hold = null;
    await this._save();
  }
}
