/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Пространства в приложении для телефона. Сами пространства (свои вкладки и свои данные сайтов у
 * каждого) держит приложение; здесь — слияние их списка с набором spaces синхронизации: названия,
 * цвета, значки и порядок общие с компьютером. Правила слияния — merge.js, поведение источника
 * повторяет sync/SyncSources.sys.mjs (spaces).
 *
 * «Личное» есть на каждом устройстве и в аккаунт не записывается. Вкладки и входы на сайтах внутри
 * пространства остаются на устройстве. Пространство, в котором на телефоне открыты вкладки, чужим
 * удалением не стирается: оно остаётся и возвращается в аккаунт. */

import { mergeCollection } from "./merge.js";
import { pageSetting } from "./tabs.js";

const SETTING = "tabora.sync.spaces";
const STATE = "spaces";
const ROUNDS = 4;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ICONS = ["fingerprint", "briefcase", "dollar", "cart", "circle", "gift", "vacation", "food", "fruit", "pet", "tree", "chill", "fence"];
const COLORS = ["blue", "turquoise", "green", "yellow", "orange", "red", "pink", "purple", "toolbar"];

const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");

/** Запись пространства в том виде, в каком её примет приложение; null — запись негодна. */
export function spaceData(id, data) {
  const n = str(data?.n, 60).trim();
  if (!n || id === "personal" || !ID_RE.test(id)) {
    return null;
  }
  const o = Number(data.o);
  return { n, i: ICONS.includes(data.i) ? data.i : "circle", col: COLORS.includes(data.col) ? data.col : "blue", ...(Number.isFinite(o) ? { o } : {}) };
}

export class Spaces {
  /**
   * @param {{ account: import("../core/account.js").Account, sync: import("../core/sync.js").SyncClient,
   *   bridge: import("./bridge.js").Bridge, store: import("./store.js").NativeStore,
   *   settings?: { get(): boolean, set(on: boolean): void } }} deps
   */
  constructor({ account, sync, bridge, store, settings = pageSetting(SETTING) }) {
    this.account = account;
    this.sync = sync;
    this.bridge = bridge;
    this.store = store;
    this.settings = settings;
    this.state = null; // { v, email, gen, shadow, hold, allow }
    this.count = 0;
    this.error = "";
  }

  get enabled() {
    return this.settings.get();
  }

  set enabled(on) {
    this.settings.set(!!on);
  }

  async _load() {
    if (this.state && this.state.email === this.account.email) {
      return this.state;
    }
    const saved = await this.store.loadData(STATE);
    const ok = saved && saved.v === 1 && saved.email === this.account.email && saved.shadow && typeof saved.shadow === "object";
    this.state = ok ? saved : { v: 1, email: this.account.email, gen: null, shadow: {}, hold: null, allow: false };
    return this.state;
  }

  async _save() {
    if (this.state) {
      await this.store.saveData(STATE, this.state);
    }
  }

  /** Забыть слияние (выход из аккаунта, выключение): пространства на телефоне остаются. */
  async forget() {
    this.state = null;
    this.count = 0;
    this.error = "";
    try {
      await this.store.clearData(STATE);
    } catch (e) {}
  }

  async _native(type, extra = {}) {
    const r = await this.bridge.call({ type, ...extra }, 30000);
    if (!r || r.error || r.ok === false) {
      throw Object.assign(new Error(r?.error || "приложение не ответило о пространствах"), { code: "spaces-storage" });
    }
    return r;
  }

  _source() {
    const list = async () => {
      const r = await this._native("spaces-list");
      if (!Array.isArray(r.spaces)) {
        // no answer is not an empty list: taking it for one would delete the account's spaces
        throw Object.assign(new Error("приложение не ответило о пространствах"), { code: "spaces-storage" });
      }
      const out = new Map();
      for (const s of r.spaces) {
        const d = s && spaceData(s.id, s);
        if (d) {
          out.set(s.id, d);
        }
      }
      return out;
    };
    return {
      hashable: d => ({ n: d.n, i: d.i, col: d.col, o: d.o }),
      list,
      apply: async (changes, ctx) => {
        const local = await list();
        const out = [];
        for (const { id, data } of changes) {
          if (!data) {
            if (local.has(id)) {
              out.push({ id, data: null });
            }
            continue;
          }
          const d = spaceData(id, data);
          if (!d) {
            continue;
          }
          // пространство с тем же названием, ещё не сверявшееся, — то же самое пространство:
          // оно получает номер сервера, а вкладки и данные сайтов остаются при нём
          const twin = local.has(id) ? "" : [...local.keys()].find(g => !ctx.synced(g) && !changes.some(c => c.id === g) && local.get(g).n.toLowerCase() === d.n.toLowerCase()) || "";
          if (twin) {
            local.delete(twin);
          }
          local.set(id, d);
          out.push({ id, data: d, ...(twin ? { from: twin } : {}) });
        }
        if (out.length) {
          await this._native("spaces-apply", { changes: out });
        }
        return {};
      },
    };
  }

  /** Слить список пространств телефона с сервером. Клиент синхронизации уже должен быть сверен. */
  async merge() {
    if (!this.enabled || !this.account.signedIn || !this.sync.loaded) {
      return false;
    }
    const state = await this._load();
    if (state.gen !== this.sync.gen) {
      state.shadow = {};
      state.hold = null;
      state.allow = true; // пространств мало: «пропало разом много» к ним не относится
      state.gen = this.sync.gen;
    }
    state.allow = true;
    const src = this._source();
    try {
      for (let round = 0; round < ROUNDS; round++) {
        const result = await mergeCollection({ sync: this.sync, name: "spaces", src, state });
        state.allow = true;
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
}
