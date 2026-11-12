/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Закладки в приложении для телефона. Сами закладки лежат в хранилище закладок приложения (его же
 * показывает экран «Закладки»); здесь — их слияние с набором marks синхронизации: закладки с
 * компьютера появляются на телефоне в папке закладок компьютера, сделанные на телефоне — на
 * компьютере в папке «С телефона». Правила слияния — merge.js, поведение источника повторяет
 * sync/SyncSources.sys.mjs (marks).
 *
 * Запись — закладка, папка или разделитель; порядок детей хранит папка (ch). Четыре корня (меню,
 * панель, «Другие», телефон) есть на каждом устройстве под одними и теми же номерами: у них
 * синхронизируется только порядок детей.
 *
 * Номер новой закладке даёт хранилище телефона, задать его нельзя. Поэтому пришедшая запись
 * получает здешний номер, и ведётся таблица «номер записи ↔ номер в хранилище»; закладка,
 * сделанная на телефоне, уходит на сервер под своим здешним номером. */

import { mergeCollection } from "./merge.js";
import { pageSetting } from "./tabs.js";

const SETTING = "tabora.sync.bookmarks";
const STATE = "marks";
const ROUNDS = 4;
const QUIET_MS = 2 * 60 * 1000; // между попутными сверками (после перемены во вкладках), если на сервере нового нет
const UNFILED = "unfiled_____";
const ROOTS = ["menu________", "toolbar_____", UNFILED, "mobile______"];
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Пригодна ли пришедшая запись: вид, название, родитель, адрес. Как _valid у компьютера. */
export function markValid(id, d) {
  if (!d || ![1, 2, 3].includes(d.k) || typeof d.n !== "string" || d.n.length > 2000 || !ID_RE.test(d.p || "") || d.p === id) {
    return false;
  }
  if (d.k === 1) {
    try {
      return typeof d.u === "string" && d.u.length <= 16384 && !!new URL(d.u);
    } catch (e) {
      return false;
    }
  }
  return d.k !== 2 || (Array.isArray(d.ch) && d.ch.every(g => typeof g === "string"));
}

export class Marks {
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
    this.state = null; // { v, email, gen, shadow, map: { номер записи: номер в хранилище }, hold, allow }
    this.count = 0;
    this.error = "";
    this._at = 0;
  }

  get enabled() {
    return this.settings.get();
  }

  set enabled(on) {
    this.settings.set(!!on);
  }

  /** Пропало разом много закладок: { missing, of } — удаления не отправлены, ждут решения человека. */
  get hold() {
    return this.state?.hold || null;
  }

  /* ---- состояние слияния (лежит у приложения в защищённом хранилище) ---- */

  async _load() {
    if (this.state && this.state.email === this.account.email) {
      return this.state;
    }
    const saved = await this.store.loadData(STATE);
    const ok = saved && saved.v === 1 && saved.email === this.account.email && saved.shadow && typeof saved.shadow === "object" && saved.map && typeof saved.map === "object";
    this.state = ok ? saved : { v: 1, email: this.account.email, gen: null, shadow: {}, map: {}, hold: null, allow: false };
    return this.state;
  }

  async _save() {
    if (this.state) {
      await this.store.saveData(STATE, this.state);
    }
  }

  /** Забыть слияние (выход из аккаунта, выключение): закладки в хранилище телефона остаются. */
  async forget() {
    this.state = null;
    this.count = 0;
    this.error = "";
    this._at = 0;
    try {
      await this.store.clearData(STATE);
    } catch (e) {}
  }

  /* ---- хранилище закладок приложения ---- */

  async _native(type, extra = {}) {
    const r = await this.bridge.call({ type, ...extra }, 60000);
    if (!r || r.error || r.ok === false) {
      throw Object.assign(new Error(r?.error || "хранилище закладок не ответило"), { code: "marks-storage" });
    }
    return r;
  }

  _source(state) {
    const guidOf = id => state.map[id] || id;

    /** Дерево хранилища записями набора: номера хранилища заменены номерами записей. */
    const list = async () => {
      const r = await this._native("marks-tree");
      if (!Array.isArray(r.nodes)) {
        // no answer is not an empty storage: taking it for one would delete the account's bookmarks
        throw Object.assign(new Error("хранилище закладок не ответило"), { code: "marks-storage" });
      }
      const nodes = r.nodes.filter(n => n && [1, 2, 3].includes(n.k) && ID_RE.test(n.g || ""));
      const present = new Set(nodes.map(n => n.g));
      for (const id of Object.keys(state.map)) {
        if (!present.has(state.map[id])) {
          delete state.map[id]; // закладку удалили на телефоне: её номер в таблице больше не нужен
        }
      }
      const back = new Map(Object.entries(state.map).map(([id, guid]) => [guid, id]));
      const idOf = guid => back.get(guid) || guid;
      const out = new Map();
      for (const n of nodes) {
        const children = () => (Array.isArray(n.ch) ? n.ch.filter(g => present.has(g)).map(idOf) : []);
        if (n.p === null || n.p === undefined) {
          if (ROOTS.includes(n.g)) {
            out.set(n.g, { k: 2, root: true, ch: children() });
          }
          continue;
        }
        const d = { p: idOf(n.p), k: n.k, n: typeof n.n === "string" ? n.n : "", c: Number(n.c) || 0, t: Number(n.t) || 0 };
        if (n.k === 1) {
          d.u = typeof n.u === "string" ? n.u : "";
        }
        if (n.k === 2) {
          d.ch = children();
        }
        out.set(idOf(n.g), d);
      }
      return out;
    };

    const apply = async (changes, ctx) => {
      const local = await list();
      const byId = new Map(changes.map(c => [c.id, c]));
      const done = new Set();

      const upsert = async (id, depth = 0) => {
        if (done.has(id) || depth > 60) {
          return;
        }
        done.add(id);
        const d = byId.get(id)?.data;
        if (!d || ROOTS.includes(id) || d.root || !markValid(id, d)) {
          return;
        }
        // сначала родитель, если он тоже пришёл и здесь его ещё нет
        if (!local.has(d.p) && byId.get(d.p)?.data) {
          await upsert(d.p, depth + 1);
        }
        const parent = local.has(d.p) && local.get(d.p).k === 2 ? d.p : UNFILED; // родителя нет: пока в «Другие»
        const cur = local.get(id);
        if (cur) {
          if (cur.k !== d.k) {
            return; // вид записи не меняется: закладка не становится папкой
          }
          const upd = {};
          if (d.k !== 3 && cur.n !== d.n) {
            upd.title = d.n;
          }
          if (d.k === 1 && cur.u !== d.u) {
            upd.url = d.u;
          }
          if (cur.p !== parent) {
            // папку нельзя перенести внутрь самой себя
            for (let up = parent, i = 0; up && i < 100; up = local.get(up)?.p, i++) {
              if (up === id) {
                return;
              }
            }
            upd.parent = guidOf(parent);
          }
          if (Object.keys(upd).length) {
            await this._native("marks-update", { guid: guidOf(id), ...upd });
            local.set(id, { ...cur, n: d.n, u: d.u, p: parent });
          }
          return;
        }
        // близнец: такая же запись в той же папке, ещё не сверявшаяся (заведена и там и здесь до
        // синхронизации или до повторного входа). Остаётся одна — здешняя под номером сервера.
        const twinId = [...local.keys()].find(g => {
          const t = local.get(g);
          return g !== id && !t.root && t.p === parent && t.k === d.k && t.n === d.n && (d.k !== 1 || t.u === d.u) && !ctx.synced(g) && !byId.has(g);
        });
        if (twinId) {
          const guid = guidOf(twinId);
          delete state.map[twinId];
          state.map[id] = guid;
          const twin = local.get(twinId);
          local.delete(twinId);
          local.set(id, twin);
          for (const v of local.values()) {
            if (v.p === twinId) {
              v.p = id;
            }
            if (v.ch) {
              v.ch = v.ch.map(g => (g === twinId ? id : g));
            }
          }
          return;
        }
        const added = await this._native("marks-add", { parent: guidOf(parent), kind: d.k, title: d.k === 3 ? "" : d.n, url: d.k === 1 ? d.u : "" });
        if (typeof added.guid === "string" && ID_RE.test(added.guid)) {
          state.map[id] = added.guid;
          local.set(id, { p: parent, k: d.k, n: d.n, u: d.u, ch: d.k === 2 ? [] : undefined });
        }
      };

      for (const { id, data } of changes) {
        if (data) {
          try {
            await upsert(id);
          } catch (e) {
            console.error(`Tabora: закладка ${id} не применена`, e);
          }
        }
      }

      // порядок детей: как на сервере; чего там нет (здешние новые) — в конце, в прежнем порядке
      const dirty = [];
      const folders = changes.filter(c => c.data && c.data.k === 2 && Array.isArray(c.data.ch) && local.has(c.id));
      const tree = folders.length ? await list() : null;
      for (const { id, data } of folders) {
        try {
          const want = [...new Set(data.ch.filter(g => typeof g === "string"))];
          const now = tree.get(id)?.ch || [];
          const have = new Set(now);
          const order = [...want.filter(g => have.has(g)), ...now.filter(g => !want.includes(g))];
          if (order.length > 1 && order.join() !== now.join()) {
            await this._native("marks-order", { parent: guidOf(id), order: order.map(guidOf) });
          }
          if (order.join() !== data.ch.join()) {
            dirty.push(id); // здесь в папке есть своё: на сервер уйдёт объединённый порядок
          }
        } catch (e) {
          console.error(`Tabora: порядок в папке ${id} не применён`, e);
        }
      }

      // удаления: сначала самые глубокие; дети папки, которых удаление не касается, поднимаются выше
      const depth = id => {
        let n = 0;
        for (let up = local.get(id)?.p; up && n < 100; up = local.get(up)?.p) {
          n++;
        }
        return n;
      };
      const removals = changes.filter(c => !c.data && local.has(c.id) && !ROOTS.includes(c.id)).sort((a, b) => depth(b.id) - depth(a.id));
      const removing = new Set(removals.map(c => c.id));
      for (const { id } of removals) {
        try {
          const node = local.get(id);
          if (node.k === 2) {
            for (const [g, t] of local) {
              if (t.p === id && !removing.has(g)) {
                await this._native("marks-update", { guid: guidOf(g), parent: guidOf(local.has(node.p) ? node.p : UNFILED) });
                t.p = node.p;
              }
            }
          }
          await this._native("marks-delete", { guid: guidOf(id) });
          local.delete(id);
          delete state.map[id];
        } catch (e) {
          console.error(`Tabora: закладка ${id} не удалена`, e);
        }
      }
      return { dirty };
    };

    return {
      hashable: d => (d.root ? { k: 2, root: true, ch: d.ch || [] } : { p: d.p, k: d.k, n: d.n, u: d.u, ch: d.ch }),
      newer: (a, b) => (a.t || 0) > (b.t || 0),
      list,
      apply,
    };
  }

  /* ---- слияние ---- */

  /** Есть ли на сервере записи новее того, что здесь уже сверено. */
  _news(state) {
    const newer = (id, rev) => !state.shadow[id] || state.shadow[id][0] < rev;
    return this.sync.list("marks").some(r => newer(r.id, r.rev)) || this.sync.tombstones("marks").some(([id, rev]) => state.shadow[id] && state.shadow[id][0] < rev);
  }

  /**
   * Слить закладки телефона с сервером. Клиент синхронизации уже должен быть сверен (sync.refresh).
   * full: false — попутная сверка (после перемены во вкладках): если на сервере нового нет, дерево
   * закладок читается не чаще раза в две минуты.
   */
  async merge({ full = true } = {}) {
    if (!this.enabled || !this.account.signedIn || !this.sync.loaded) {
      return false;
    }
    const state = await this._load();
    if (state.gen !== this.sync.gen) {
      // данные на сервере начаты заново: прежняя тень к ним не относится, сливаем как в первый раз
      state.shadow = {};
      state.hold = null;
      state.allow = false;
      state.gen = this.sync.gen;
    } else if (!full && this._at && Date.now() - this._at < QUIET_MS && !this._news(state)) {
      return false;
    }
    const src = this._source(state);
    try {
      for (let round = 0; round < ROUNDS; round++) {
        const result = await mergeCollection({ sync: this.sync, name: "marks", src, state });
        await this._save();
        if (result.clean) {
          break;
        }
        await this.sync.refresh();
      }
      this.count = [...(await src.list()).values()].filter(d => d.k === 1).length;
      this.error = "";
      this._at = Date.now();
      return true;
    } catch (e) {
      await this._save().catch(() => {});
      this.error = e.message || String(e);
      throw e;
    }
  }

  /**
   * Что делать с закладками, пропавшими с телефона разом: "delete" — удалить их и на остальных
   * устройствах, "restore" — вернуть их на телефон с сервера.
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
          delete state.shadow[id]; // запись придёт с сервера как новая
          delete state.map[id];
        }
      }
    }
    state.hold = null;
    await this._save();
  }
}
