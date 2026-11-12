import { tt } from "chrome://tabora/content/i18n/I18n.sys.mjs";
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Источники синхронизации (sync/Sync.sys.mjs): что на этом компьютере считается записью набора и
 * как запись с другого компьютера ложится сюда. Источник отдаёт записи простыми объектами и
 * умеет применить список изменений; слияние, шифрование и защита от потери данных — в Sync.
 *
 *   list()                 → Map(номер записи → данные)
 *   apply(changes, ctx)    изменения с сервера: [{ id, data | null }] (null — запись удалена);
 *                          ctx.synced(id) — запись уже сверялась на этом компьютере;
 *                          ответ { dirty: [id] } — записи, чью здешнюю версию надо отправить
 *   hashable(data)         что считается содержимым записи (времена и служебные поля в сравнение
 *                          не идут)
 *   newer(local, remote)   при изменении с обеих сторон: true — остаётся здешняя версия
 *   owns(id)               запись ведёт этот компьютер (чужие он только читает)
 *   watch(notify)          сообщать о локальных изменениях
 *
 * Данные с сервера расшифрованы ключом аккаунта, то есть пришли с компьютера того же владельца,
 * но перед записью всё равно проверяются: повреждённая запись не должна ломать хранилище. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Account: "chrome://tabora/content/account/Account.sys.mjs",
  Vault: "chrome://tabora/content/vault/Vault.sys.mjs",
  Otp: "chrome://tabora/content/vault/Otp.sys.mjs",
  base32Encode: "chrome://tabora/content/vault/Otp.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  ContextualIdentityService: "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
const warn = (what, e) => console.error(`Tabora sync: ${what}`, e);

/* ---- пароли сайтов ------------------------------------------------------------------------------ */

/** Номер записи по номеру пароля в хранилище: «{uuid}» без скобок, короткие номера как есть. */
function loginId(guid) {
  const m = /^\{([0-9a-fA-F-]{36})\}$/.exec(guid || "");
  const id = m ? m[1] : guid;
  return ID_RE.test(id || "") ? id : "";
}

function loginValid(id, d) {
  return (
    !!d && typeof d.o === "string" && /^[a-z][a-z0-9+.-]*:\/\/[^\s]{1,300}$/i.test(d.o) && typeof d.u === "string" && d.u.length <= 512 &&
    typeof d.p === "string" && d.p.length >= 1 && d.p.length <= 4096 && (d.f === null || typeof d.f === "string") && (d.r === null || typeof d.r === "string") &&
    (d.f === null) !== (d.r === null) && loginId(d.g) === id
  );
}

const logins = {
  name: "logins",

  async available() {
    return lazy.Vault.unlocked && Services.prefs.getBoolPref("tabora.vault.passwords", true);
  },

  async _all() {
    await Services.logins.initializationPromise;
    return Services.logins.getAllLogins();
  },

  async list() {
    const out = new Map();
    for (const l of await this._all()) {
      const id = loginId(l.guid);
      if (id && l.password) {
        out.set(id, {
          g: l.guid, o: l.origin, f: l.formActionOrigin ?? null, r: l.httpRealm ?? null, u: l.username || "", p: l.password,
          uf: l.usernameField || "", pf: l.passwordField || "", c: l.timeCreated || 0, t: l.timePasswordChanged || 0,
        });
      }
    }
    return out;
  },

  hashable: d => ({ o: d.o, f: d.f, r: d.r, u: d.u, p: d.p }),
  newer: (a, b) => (a.t || 0) > (b.t || 0),

  _info(d) {
    const info = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
    info.init(d.o, d.f, d.r, d.u, d.p, str(d.uf, 200), str(d.pf, 200));
    info.QueryInterface(Ci.nsILoginMetaInfo);
    info.guid = d.g;
    info.timeCreated = Number(d.c) || Date.now();
    info.timePasswordChanged = Number(d.t) || Date.now();
    return info;
  },

  async apply(changes) {
    const all = await this._all();
    const byId = new Map(all.map(l => [loginId(l.guid), l]));
    const same = (l, d) => l.origin === d.o && (l.formActionOrigin ?? null) === d.f && (l.httpRealm ?? null) === d.r && (l.username || "") === d.u;
    const dirty = [];
    for (const { id, data } of changes) {
      try {
        const cur = byId.get(id);
        if (!data) {
          if (cur) {
            await Services.logins.removeLoginAsync(cur);
            byId.delete(id);
          }
          continue;
        }
        if (!loginValid(id, data)) {
          continue;
        }
        let d = data;
        if (cur && same(cur, d)) {
          if (cur.password !== d.p) {
            const bag = Cc["@mozilla.org/hash-property-bag;1"].createInstance(Ci.nsIWritablePropertyBag);
            bag.setProperty("password", d.p);
            bag.setProperty("timePasswordChanged", Number(d.t) || Date.now());
            await Services.logins.modifyLoginAsync(cur, bag);
          }
          continue;
        }
        if (cur) {
          await Services.logins.removeLoginAsync(cur); // тот же номер, другой сайт или имя: запись заменяется
          byId.delete(id);
        }
        // тот же сайт и то же имя, сохранённые на двух компьютерах до синхронизации: остаётся одна
        // запись с номером сервера и более свежим паролем
        const twin = [...byId.values()].find(l => same(l, d));
        if (twin) {
          if ((twin.timePasswordChanged || 0) > (Number(d.t) || 0) && twin.password !== d.p) {
            d = { ...d, p: twin.password, t: twin.timePasswordChanged };
            dirty.push(id);
          }
          await Services.logins.removeLoginAsync(twin);
          byId.delete(loginId(twin.guid));
        }
        byId.set(id, await Services.logins.addLoginAsync(this._info(d)));
      } catch (e) {
        warn(tt`пароль ${id} не применён`, e);
      }
    }
    return { dirty };
  },

  watch(notify) {
    Services.obs.addObserver({ observe: (s, t, what) => what !== "hostSavingDisabled" && what !== "hostSavingEnabled" && notify() }, "passwordmgr-storage-changed");
  },
};

/* ---- коды входа ---------------------------------------------------------------------------------- */

const otp = {
  name: "otp",

  async available() {
    if (!lazy.Vault.unlocked || !lazy.Otp.allowed) {
      return false;
    }
    await lazy.Otp.ready();
    return !lazy.Otp.loadError;
  },

  async list() {
    const out = new Map();
    for (const e of lazy.Otp.list()) {
      if (!e.valid || !ID_RE.test(e.id)) {
        continue; // запись с неверной подписью не синхронизируется: ей нельзя доверять и здесь
      }
      try {
        const secret = await lazy.Otp.secretOf(e.id);
        out.set(e.id, {
          i: e.issuer || "", a: e.account || "", s: lazy.base32Encode(secret), al: e.algorithm, d: e.digits, p: e.period,
          w: (e.sites || []).map(s => ({ host: s.host, sub: !!s.sub })), c: e.createdAt || "",
        });
      } catch (err) {}
    }
    return out;
  },

  hashable: d => ({ i: d.i, a: d.a, s: d.s, al: d.al, d: d.d, p: d.p, w: d.w }),

  async apply(changes) {
    const Otp = lazy.Otp;
    for (const { id, data } of changes) {
      try {
        const cur = Otp.list().find(e => e.id === id);
        if (!data) {
          if (cur) {
            await Otp.remove(id);
          }
          continue;
        }
        const fields = { id, issuer: str(data.i, 48), account: str(data.a, 96), secret: str(data.s, 512), algorithm: str(data.al, 8), digits: Number(data.d), period: Number(data.p), sites: Array.isArray(data.w) ? data.w : [], createdAt: str(data.c, 40) };
        if (cur) {
          const secret = lazy.base32Encode(await Otp.secretOf(id));
          if (secret === fields.secret && cur.algorithm === fields.algorithm && cur.digits === fields.digits && cur.period === fields.period) {
            await Otp.update(id, { issuer: fields.issuer, account: fields.account, sites: fields.sites });
            continue;
          }
          await Otp.remove(id); // секрет или параметры другие: запись заменяется целиком
        }
        // тот же код, добавленный на двух компьютерах до синхронизации: остаётся запись с номером сервера
        for (const e of Otp.list()) {
          if (e.id !== id && (e.issuer || "") === fields.issuer && (e.account || "") === fields.account && lazy.base32Encode(await Otp.secretOf(e.id).catch(() => new Uint8Array())) === fields.secret) {
            await Otp.remove(e.id);
          }
        }
        await Otp.add(fields);
      } catch (e) {
        warn(tt`код ${id} не применён`, e);
      }
    }
    return {};
  },

  watch(notify) {
    Services.obs.addObserver({ observe: () => notify() }, lazy.Otp.TOPIC);
  },
};

/* ---- закладки ------------------------------------------------------------------------------------
 * Запись — закладка, папка или разделитель. Порядок детей хранит папка (ch), поэтому перестановка
 * меняет одну запись. Четыре корня есть на каждом компьютере: у них синхронизируется только порядок. */

const KIND = { "text/x-moz-place": 1, "text/x-moz-place-container": 2, "text/x-moz-place-separator": 3 };

const marks = {
  name: "marks",

  roots() {
    const b = lazy.PlacesUtils.bookmarks;
    return [b.menuGuid, b.toolbarGuid, b.unfiledGuid, b.mobileGuid];
  },

  async list() {
    const out = new Map();
    const walk = (node, parent) => {
      const k = KIND[node.type];
      if (!k || !ID_RE.test(node.guid)) {
        return;
      }
      const data = parent ? { p: parent, k, n: node.title || "", c: Math.round((node.dateAdded || 0) / 1000), t: Math.round((node.lastModified || 0) / 1000) } : { k: 2, root: true };
      if (k === 1) {
        data.u = node.uri || "";
      }
      if (k === 2) {
        data.ch = (node.children || []).filter(c => KIND[c.type] && ID_RE.test(c.guid)).map(c => c.guid);
      }
      out.set(node.guid, data);
      (node.children || []).forEach(c => walk(c, node.guid));
    };
    for (const root of this.roots()) {
      const tree = await lazy.PlacesUtils.promiseBookmarksTree(root);
      if (tree) {
        walk(tree, null);
      }
    }
    return out;
  },

  hashable: d => (d.root ? { k: 2, root: true, ch: d.ch || [] } : { p: d.p, k: d.k, n: d.n, u: d.u, ch: d.ch }),
  newer: (a, b) => (a.t || 0) > (b.t || 0),

  _valid(id, d) {
    if (!d || ![1, 2, 3].includes(d.k) || typeof d.n !== "string" || d.n.length > 2000 || !ID_RE.test(d.p || "") || d.p === id) {
      return false;
    }
    if (d.k === 1) {
      try {
        return d.u.length <= 16384 && !!new URL(d.u);
      } catch (e) {
        return false;
      }
    }
    return d.k !== 2 || (Array.isArray(d.ch) && d.ch.every(g => typeof g === "string"));
  },

  async apply(changes, ctx) {
    const B = lazy.PlacesUtils.bookmarks;
    const roots = this.roots();
    const TYPE = { 1: B.TYPE_BOOKMARK, 2: B.TYPE_FOLDER, 3: B.TYPE_SEPARATOR };
    const local = await this.list();
    const byId = new Map(changes.map(c => [c.id, c]));
    const done = new Set();
    const date = ms => new Date(Number(ms) > 0 ? Number(ms) : Date.now());

    const upsert = async (id, depth = 0) => {
      if (done.has(id) || depth > 60) {
        return;
      }
      done.add(id);
      const d = byId.get(id)?.data;
      if (!d || roots.includes(id) || d.root || !this._valid(id, d)) {
        return;
      }
      // сначала родитель, если он тоже пришёл и здесь его ещё нет
      if (!local.has(d.p) && byId.get(d.p)?.data) {
        await upsert(d.p, depth + 1);
      }
      const parent = local.has(d.p) && local.get(d.p).k === 2 ? d.p : B.unfiledGuid; // родителя нет: пока в «Другие»
      const cur = local.get(id);
      if (cur) {
        if (cur.k !== d.k) {
          return; // вид записи не меняется: закладка не становится папкой
        }
        const upd = {};
        if (cur.n !== d.n) {
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
          upd.parentGuid = parent;
          upd.index = B.DEFAULT_INDEX;
        }
        if (Object.keys(upd).length) {
          await B.update({ guid: id, ...upd, lastModified: date(d.t) });
          local.set(id, { ...cur, n: d.n, u: d.u, p: parent });
        }
        return;
      }
      // близнец: такая же запись в той же папке, ещё не сверявшаяся (заведена на обоих
      // компьютерах до синхронизации — например, закладки по умолчанию). Остаётся одна.
      let index = B.DEFAULT_INDEX;
      const twinId = [...local.keys()].find(g => {
        const t = local.get(g);
        return g !== id && !t.root && t.p === parent && t.k === d.k && t.n === d.n && (d.k !== 1 || t.u === d.u) && !ctx.synced(g) && !byId.has(g);
      });
      const twin = twinId ? await B.fetch(twinId) : null;
      if (twin) {
        index = twin.index;
      }
      const added = date(d.c);
      const created = await B.insert({ guid: id, parentGuid: parent, type: TYPE[d.k], ...(d.k !== 3 ? { title: d.n } : {}), ...(d.k === 1 ? { url: d.u } : {}), index, dateAdded: added, lastModified: new Date(Math.max(added.getTime(), date(d.t).getTime())) });
      local.set(id, { p: parent, k: d.k, n: d.n, u: d.u, ch: d.k === 2 ? [] : undefined });
      if (twin && created) {
        if (d.k === 2) {
          // содержимое прежней папки переезжает в новую и там сверяется с пришедшим
          for (const [g, t] of local) {
            if (t.p === twinId) {
              await B.update({ guid: g, parentGuid: id, index: B.DEFAULT_INDEX });
              t.p = id;
            }
          }
        }
        await B.remove(twinId);
        local.delete(twinId);
      }
    };

    for (const { id, data } of changes) {
      if (data) {
        try {
          await upsert(id);
        } catch (e) {
          warn(tt`закладка ${id} не применена`, e);
        }
      }
    }

    // порядок детей: как на сервере; чего там нет (здешние новые) — в конце, в прежнем порядке
    const dirty = [];
    for (const { id, data } of changes) {
      if (!data || data.k !== 2 || !Array.isArray(data.ch) || !local.has(id)) {
        continue;
      }
      try {
        const tree = await lazy.PlacesUtils.promiseBookmarksTree(id);
        const now = (tree?.children || []).map(c => c.guid);
        const have = new Set(now);
        const order = [...data.ch.filter(g => have.has(g)), ...now.filter(g => !data.ch.includes(g))];
        if (order.length > 1 && order.join() !== now.join()) {
          await B.reorder(id, order);
        }
        if (order.join() !== data.ch.join()) {
          dirty.push(id); // здесь в папке есть своё: на сервер уйдёт объединённый порядок
        }
      } catch (e) {
        warn(tt`порядок в папке ${id} не применён`, e);
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
    const removals = changes.filter(c => !c.data && local.has(c.id) && !roots.includes(c.id)).sort((a, b) => depth(b.id) - depth(a.id));
    const removing = new Set(removals.map(c => c.id));
    for (const { id } of removals) {
      try {
        const node = local.get(id);
        if (node.k === 2) {
          for (const [g, t] of local) {
            if (t.p === id && !removing.has(g)) {
              await B.update({ guid: g, parentGuid: local.has(node.p) ? node.p : B.unfiledGuid, index: B.DEFAULT_INDEX });
              t.p = node.p;
            }
          }
        }
        await B.remove(id);
        local.delete(id);
      } catch (e) {
        warn(tt`закладка ${id} не удалена`, e);
      }
    }
    return { dirty };
  },

  watch(notify) {
    PlacesObservers.addListener(["bookmark-added", "bookmark-removed", "bookmark-moved", "bookmark-title-changed", "bookmark-url-changed"], () => notify());
  },
};

/* ---- пространства -------------------------------------------------------------------------------
 * Пространство — контейнер браузера плюс запись в списке tabora.spaces. Номер контейнера у каждого
 * компьютера свой и не синхронизируется; «Личное» (вкладки без контейнера) есть везде. */

const SPACES_PREF = "tabora.spaces";
const ICONS = ["fingerprint", "briefcase", "dollar", "cart", "circle", "gift", "vacation", "food", "fruit", "pet", "tree", "chill", "fence"];
const COLORS = ["blue", "turquoise", "green", "yellow", "orange", "red", "pink", "purple", "toolbar"];

const spaces = {
  name: "spaces",

  _read() {
    try {
      const list = JSON.parse(Services.prefs.getStringPref(SPACES_PREF, "[]"));
      return Array.isArray(list) ? list.filter(s => s && typeof s.id === "string") : [];
    } catch (e) {
      return [];
    }
  },

  _write(list) {
    Services.prefs.setStringPref(SPACES_PREF, JSON.stringify(list));
  },

  async list() {
    let list = this._read();
    // пространство, заведённое как контейнер вне Tabora, названо по номеру контейнера (ctx-7), а он
    // у каждого компьютера свой: перед первой отправкой оно получает собственный номер
    if (list.some(s => /^ctx-\d+$/.test(s.id))) {
      list = list.map(s => {
        if (!/^ctx-\d+$/.test(s.id)) {
          return s;
        }
        const id = `space-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
        if (Services.prefs.getStringPref("tabora.spaces.active", "") === s.id) {
          Services.prefs.setStringPref("tabora.spaces.active", id);
        }
        return { ...s, id };
      });
      this._write(list);
      Services.obs.notifyObservers(null, "tabora-sync-applied", "spaces");
    }
    const out = new Map();
    list.forEach((s, o) => {
      if (s.userContextId !== 0 && s.id !== "personal" && ID_RE.test(s.id)) {
        out.set(s.id, { n: s.name || "", i: s.icon || "circle", col: s.color || "blue", o });
      }
    });
    return out;
  },

  _inUse(userContextId) {
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      if (win.gBrowser?.tabs.some(t => t.userContextId === userContextId)) {
        return true;
      }
    }
    return false;
  },

  async apply(changes, ctx) {
    const cis = lazy.ContextualIdentityService;
    const known = new Set(cis.getPublicIdentities().map(i => i.userContextId));
    const list = this._read();
    for (const { id, data } of changes) {
      try {
        const at = list.findIndex(s => s.id === id);
        if (!data) {
          // пространство с открытыми вкладками не удаляется: вкладки остались бы без пространства
          if (at >= 0 && list[at].userContextId !== 0 && !this._inUse(list[at].userContextId)) {
            if (known.has(list[at].userContextId)) {
              cis.remove(list[at].userContextId);
            }
            list.splice(at, 1);
          }
          continue;
        }
        const name = str(data.n, 60).trim();
        const icon = ICONS.includes(data.i) ? data.i : "circle";
        const color = COLORS.includes(data.col) ? data.col : "blue";
        if (!name || id === "personal") {
          continue;
        }
        if (at >= 0) {
          const s = list[at];
          if (s.name !== name || s.icon !== icon || s.color !== color) {
            if (known.has(s.userContextId)) {
              cis.update(s.userContextId, name, icon, color);
            }
            Object.assign(s, { name, icon, color });
          }
          s._o = Number(data.o);
          continue;
        }
        // пространство с тем же названием, ещё не сверявшееся, — то же самое пространство
        const twin = list.find(s => s.userContextId !== 0 && !ctx.synced(s.id) && !changes.some(c => c.id === s.id) && (s.name || "").toLowerCase() === name.toLowerCase());
        if (twin) {
          if (Services.prefs.getStringPref("tabora.spaces.active", "") === twin.id) {
            Services.prefs.setStringPref("tabora.spaces.active", id);
          }
          Object.assign(twin, { id, _o: Number(data.o) });
          continue;
        }
        const identity = cis.create(name, icon, color);
        list.push({ id, name, icon, color, userContextId: identity.userContextId, _o: Number(data.o) });
      } catch (e) {
        warn(tt`пространство ${id} не применено`, e);
      }
    }
    // порядок: пришедшие встают на свои места, остальные держат прежний
    const rest = list.filter(s => s.userContextId === 0 || s.id === "personal");
    const others = list.filter(s => !rest.includes(s)).map((s, i) => ({ s, key: Number.isFinite(s._o) ? s._o : i + 0.5 }));
    others.sort((a, b) => a.key - b.key);
    const next = [...rest, ...others.map(x => x.s)].map(({ _o, ...s }) => s);
    this._write(next);
    return {};
  },

  watch(notify) {
    Services.prefs.addObserver(SPACES_PREF, () => notify());
  },
};

/* ---- ярлыки стартовой страницы ------------------------------------------------------------------- */

const DIAL_PREF = "tabora.start.dial";

const start = {
  name: "start",

  async list() {
    const out = new Map();
    try {
      const s = JSON.parse(Services.prefs.getStringPref(DIAL_PREF, "{}"));
      const pinned = Array.isArray(s.pinned) ? s.pinned : [];
      const hidden = Array.isArray(s.hidden) ? s.hidden : [];
      if (pinned.length || hidden.length) {
        out.set("dial", { pinned, hidden });
      }
    } catch (e) {}
    return out;
  },

  async apply(changes) {
    const dial = changes.find(c => c.id === "dial");
    if (!dial?.data) {
      return {}; // удаление ярлыков здесь ничего не стирает
    }
    const clean = list => (Array.isArray(list) ? list : []).filter(x => (typeof x === "string" && x.length <= 2048) || (x && typeof x === "object" && JSON.stringify(x).length <= 4096));
    Services.prefs.setStringPref(DIAL_PREF, JSON.stringify({ pinned: clean(dial.data.pinned).slice(0, 48), hidden: clean(dial.data.hidden).slice(0, 200) }));
    return {};
  },

  watch(notify) {
    Services.prefs.addObserver(DIAL_PREF, () => notify());
  },
};

/* ---- открытые вкладки ----------------------------------------------------------------------------
 * Каждый компьютер ведёт одну запись — список своих открытых вкладок; чужие записи он только
 * читает (чтобы показать «вкладки с других компьютеров») и никогда не меняет. Приватные окна и
 * служебные страницы в список не попадают. */

const MAX_TABS = 200;
const TABS_STALE_MS = 21 * 24 * 3600 * 1000;

const tabs = {
  name: "tabs",
  _remote: new Map(),

  owns(id) {
    return id === lazy.Account.deviceId();
  },

  _own() {
    const list = [];
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      if (!win.gBrowser || lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
        continue;
      }
      for (const tab of win.gBrowser.tabs) {
        const url = tab.linkedBrowser?.currentURI?.spec || "";
        if (/^https?:\/\//.test(url) && url.length <= 2048 && list.length < MAX_TABS) {
          list.push({ t: str(tab.label || "", 200), u: url, ...(tab.pinned ? { p: 1 } : {}) });
        }
      }
    }
    return { name: str(lazy.Account.deviceName(), 80), at: Date.now(), tabs: list };
  },

  async list() {
    const out = new Map(this._remote);
    out.set(lazy.Account.deviceId(), this._own());
    return out;
  },

  hashable: d => ({ name: d.name, tabs: d.tabs }),

  async apply(changes) {
    for (const { id, data } of changes) {
      if (this.owns(id)) {
        continue;
      }
      if (data && Array.isArray(data.tabs)) {
        this._remote.set(id, {
          name: str(data.name, 80) || tt`Компьютер`, at: Number(data.at) || 0,
          tabs: data.tabs.filter(t => t && /^https?:\/\//.test(t.u || "")).slice(0, MAX_TABS).map(t => ({ t: str(t.t, 200), u: str(t.u, 2048), ...(t.p ? { p: 1 } : {}) })),
        });
      } else {
        this._remote.delete(id);
      }
    }
    return {};
  },

  dump() {
    return { remote: [...this._remote] };
  },

  restore(saved) {
    for (const [id, data] of Array.isArray(saved?.remote) ? saved.remote : []) {
      if (ID_RE.test(id) && data && Array.isArray(data.tabs) && !this.owns(id)) {
        this._remote.set(id, data);
      }
    }
  },

  /** Вкладки других компьютеров: давно не обновлявшиеся списки не показываются. */
  others() {
    const fresh = Date.now() - TABS_STALE_MS;
    return [...this._remote].filter(([, d]) => d.at >= fresh && d.tabs.length).map(([id, d]) => ({ id, ...d })).sort((a, b) => b.at - a.at);
  },
};

export const SOURCES = { logins, otp, marks, spaces, start, tabs };
