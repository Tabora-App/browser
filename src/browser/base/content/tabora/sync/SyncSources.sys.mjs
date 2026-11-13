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
  Passkeys: "chrome://tabora/content/vault/Passkeys.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  ContextualIdentityService: "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  formAutofillStorage: "resource://autofill/FormAutofillStorage.sys.mjs",
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
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

/* ---- passkeys ------------------------------------------------------------------------------------
 * A record is one passkey of the vault with its private key (vault/Passkeys.sys.mjs); its number
 * is the credential ID, which the site knows it by. A passkey is never edited, only made and
 * deleted, so two computers cannot change one record differently. Two passkeys for one account
 * of one site, made on two computers before they met, are both kept: the site knows both. */

const passkeys = {
  name: "passkeys",

  async available() {
    if (!lazy.Vault.unlocked || !lazy.Passkeys.allowed) {
      return false;
    }
    await lazy.Passkeys.ready();
    return !lazy.Passkeys.loadError;
  },

  async list() {
    const out = new Map();
    for (const e of await lazy.Passkeys.exportAll()) {
      out.set(e.id, { rp: e.rp, rn: e.rn, uh: e.uh, un: e.un, dn: e.dn, c: e.c, k: e.key });
    }
    return out;
  },

  hashable: d => ({ rp: d.rp, rn: d.rn, uh: d.uh, un: d.un, dn: d.dn, k: d.k }),

  async apply(changes) {
    await lazy.Passkeys.applyRemote(
      changes.map(({ id, data }) => ({ id, data: data ? { rp: str(data.rp, 253), rn: str(data.rn, 120), uh: str(data.uh, 88), un: str(data.un, 200), dn: str(data.dn, 200), c: Number(data.c) || 0, key: str(data.k, 600) } : null }))
    );
    return {};
  },

  watch(notify) {
    // what sync itself has just written is not a local change
    Services.obs.addObserver({ observe: (subject, topic, what) => what !== "synced" && notify() }, lazy.Passkeys.TOPIC);
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
 * Каждое устройство (компьютер или телефон) ведёт одну запись — список своих открытых вкладок; чужие
 * записи оно только читает (чтобы показать «вкладки на других устройствах») и никогда не меняет. Приватные окна и
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

  /** Other devices of the account, with or without open tabs: [{ id, name, at }], recent first. */
  devices() {
    const fresh = Date.now() - TABS_STALE_MS;
    return [...this._remote].filter(([, d]) => d.at >= fresh).map(([id, d]) => ({ id, name: d.name, at: d.at })).sort((a, b) => b.at - a.at);
  },

  /** Вкладки других компьютеров: давно не обновлявшиеся списки не показываются. */
  others() {
    const fresh = Date.now() - TABS_STALE_MS;
    return [...this._remote].filter(([, d]) => d.at >= fresh && d.tabs.length).map(([id, d]) => ({ id, ...d })).sort((a, b) => b.at - a.at);
  },
};

/* ---- tabs sent to another device ------------------------------------------------------------
 * "Send to device": every device keeps its own record with the pages it sent lately (its outbox),
 * keyed by its device ID, just like the list of open tabs. A device reads the outboxes of the
 * others, opens the pages addressed to it once and remembers which ones it has opened. Nothing is
 * deleted on the server by the receiver: an item simply expires from the sender's outbox.
 *
 * A page is opened by the shell of a regular (not private) window. While there is no such window
 * the page waits: it is not marked as opened and is tried again on the next pass. */

const SENT_KEEP_MS = 7 * 24 * 3600 * 1000;
const SENT_MAX = 50;
const SENT_SEEN_MAX = 400;

const sentItem = it =>
  it && ID_RE.test(it.id || "") && ID_RE.test(it.to || "") && typeof it.u === "string" && /^https?:\/\//.test(it.u) && it.u.length <= 2048 && Number(it.at) > 0
    ? { id: it.id, to: it.to, u: it.u, t: str(it.t, 200), at: Number(it.at) }
    : null;

const sent = {
  name: "sent",
  _remote: new Map(), // sender's device ID → { name, items }
  _out: [], // what this device sent
  _seen: [], // IDs of items already opened here
  unsaved: false, // the outbox or the list of opened pages changed: Sync saves the copy

  owns(id) {
    return id === lazy.Account.deviceId();
  },

  _own() {
    const fresh = Date.now() - SENT_KEEP_MS;
    this._out = this._out.filter(it => it.at >= fresh).slice(-SENT_MAX);
    return { name: str(lazy.Account.deviceName(), 80), items: this._out };
  },

  async list() {
    this._deliver();
    const out = new Map(this._remote);
    const own = this._own();
    if (own.items.length) {
      out.set(lazy.Account.deviceId(), own);
    }
    return out;
  },

  hashable: d => ({ items: d.items }),

  /** Pages addressed to this device and not opened here yet. */
  _waiting() {
    const me = lazy.Account.deviceId();
    const fresh = Date.now() - SENT_KEEP_MS;
    const out = [];
    for (const [, box] of this._remote) {
      for (const it of box.items) {
        if (it.to === me && it.at >= fresh && !this._seen.includes(it.id)) {
          out.push({ ...it, from: box.name });
        }
      }
    }
    return out.sort((a, b) => a.at - b.at);
  },

  _deliver() {
    const waiting = this._waiting();
    if (!waiting.length) {
      return;
    }
    const shell = lazy.BrowserWindowTracker.getTopWindow({ private: false })?.Tabora;
    if (!shell?.openSentTab) {
      return;
    }
    for (const it of waiting) {
      try {
        if (shell.openSentTab({ url: it.u, title: it.t, from: it.from }) === false) {
          continue;
        }
      } catch (e) {
        console.error("Tabora sync: sent tab", e);
        continue;
      }
      this._seen.push(it.id);
      this.unsaved = true;
    }
    this._seen = this._seen.slice(-SENT_SEEN_MAX);
  },

  async apply(changes, { first = false } = {}) {
    for (const { id, data } of changes) {
      if (this.owns(id)) {
        continue;
      }
      if (data && Array.isArray(data.items)) {
        this._remote.set(id, { name: str(data.name, 80), items: data.items.map(sentItem).filter(Boolean).slice(-SENT_MAX) });
      } else {
        this._remote.delete(id);
      }
    }
    if (first) {
      // sync has just been turned on here: pages sent before that are not opened in a heap
      this._seen = [...this._seen, ...this._waiting().map(it => it.id)].slice(-SENT_SEEN_MAX);
    } else {
      this._deliver();
    }
    return {};
  },

  dump() {
    return { remote: [...this._remote], out: this._out, seen: this._seen };
  },

  restore(saved) {
    for (const [id, data] of Array.isArray(saved?.remote) ? saved.remote : []) {
      if (ID_RE.test(id) && data && Array.isArray(data.items) && !this.owns(id)) {
        this._remote.set(id, { name: str(data.name, 80), items: data.items.map(sentItem).filter(Boolean) });
      }
    }
    this._out = (Array.isArray(saved?.out) ? saved.out : []).map(sentItem).filter(Boolean);
    this._seen = (Array.isArray(saved?.seen) ? saved.seen : []).filter(id => ID_RE.test(id || "")).slice(-SENT_SEEN_MAX);
  },

  /** Put a page into this device's outbox for the device `to`. Returns the item's ID, or "" if
   * the page cannot be sent (not a site, or the device is this one). */
  send(to, url, title) {
    const item = sentItem({ id: `s${Date.now().toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`, to, u: url, t: title || "", at: Date.now() });
    if (!item || to === lazy.Account.deviceId()) {
      return "";
    }
    this._out.push(item);
    this.unsaved = true;
    return item.id;
  },

  /** Take back a page that did not reach the server. */
  unsend(id) {
    this._out = this._out.filter(it => it.id !== id);
    this.unsaved = true;
  },
};

/* ---- history of visits ------------------------------------------------------------------------
 * Every device publishes only its own visits, one record per day ("<device ID>-<yyyymmdd>", the
 * day in UTC): the pages of the day with the time of the last visit and the number of visits.
 * Records of other devices are only read. They are shown in "History" next to the local visits,
 * under the device's name, and are never written into this computer's history database. So a
 * page deleted from history here disappears from this computer's records, and nothing comes
 * back from another device by itself. Private windows leave no history, so they are not here. */

const HIST_DAYS = 60;
const HIST_DAY_PAGES = 250;
const HIST_DAY_BYTES = 48 * 1024;
const DAY_MS = 86400000;
// visits that are not pages a person opened: embedded content, downloads, frames
const HIST_SKIP_TYPES = "4, 7, 8";
const HIST_DAY_RE = /^\d{8}$/;

const histDay = ms => new Date(ms).toISOString().slice(0, 10).replaceAll("-", "");
const histDayStart = day => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(4, 6)) - 1, Number(day.slice(6, 8)));
const histFirstDay = (now = Date.now()) => histDay(now - HIST_DAYS * DAY_MS);

function histPage(p) {
  return p && typeof p.u === "string" && /^https?:\/\/[^/@]+(\/|$)/i.test(p.u) && p.u.length <= 2048 && Number(p.at) > 0
    ? { u: p.u, t: str(p.t, 200), at: Number(p.at), ...(Number(p.n) > 1 ? { n: Math.min(Math.floor(Number(p.n)), 9999) } : {}) }
    : null;
}

const history = {
  name: "history",
  noHold: true, // clearing history removes many records at once, and that is what was asked for
  ownFile: true, // the copy of other devices' history is too large for the common state file
  _remote: new Map(), // record ID → { name, day, p }
  _own: null, // Map day → record of this computer; null: read anew
  _dirty: new Set(), // days of this computer to read anew

  owns(id) {
    return id.startsWith(`${lazy.Account.deviceId()}-`);
  },

  /** Pages this computer visited from `since` to `until` (ms), by day: Map day → [page]. */
  async _read(since, until) {
    const db = await lazy.PlacesUtils.promiseDBConnection();
    const rows = await db.executeCached(
      `SELECT p.url AS url, p.title AS title, MAX(v.visit_date) AS last, COUNT(*) AS n
       FROM moz_historyvisits v JOIN moz_places p ON p.id = v.place_id
       WHERE v.visit_date >= :since AND v.visit_date < :until AND p.hidden = 0
         AND v.visit_type NOT IN (${HIST_SKIP_TYPES})
       GROUP BY CAST(v.visit_date / ${DAY_MS * 1000} AS INTEGER), p.id`,
      { since: since * 1000, until: until * 1000 }
    );
    const days = new Map();
    for (const row of rows) {
      const page = histPage({ u: row.getResultByName("url"), t: row.getResultByName("title") || "", at: Math.floor(row.getResultByName("last") / 1000), n: row.getResultByName("n") });
      if (!page) {
        continue;
      }
      const day = histDay(page.at);
      if (!days.has(day)) {
        days.set(day, []);
      }
      days.get(day).push(page);
    }
    for (const [day, pages] of days) {
      pages.sort((a, b) => b.at - a.at);
      pages.splice(HIST_DAY_PAGES);
      // a day that does not fit loses its earliest pages
      while (pages.length > 1 && JSON.stringify(pages).length > HIST_DAY_BYTES) {
        pages.splice(Math.ceil(pages.length * 0.9));
      }
      days.set(day, pages);
    }
    return days;
  },

  async list() {
    const now = Date.now();
    const first = histFirstDay(now);
    if (!this._own) {
      this._dirty.clear();
      this._own = await this._read(histDayStart(first), now + DAY_MS);
    } else if (this._dirty.size) {
      const dirty = [...this._dirty];
      this._dirty.clear();
      for (const day of dirty) {
        const pages = (await this._read(histDayStart(day), histDayStart(day) + DAY_MS)).get(day);
        if (pages?.length) {
          this._own.set(day, pages);
        } else {
          this._own.delete(day);
        }
      }
    }
    const me = lazy.Account.deviceId();
    const name = str(lazy.Account.deviceName(), 80);
    const out = new Map();
    for (const [day, pages] of this._own) {
      if (day >= first) {
        out.set(`${me}-${day}`, { name, day, p: pages });
      }
    }
    return out;
  },

  hashable: d => ({ day: d.day, p: d.p }),

  async apply(changes) {
    const first = histFirstDay();
    for (const { id, data } of changes) {
      if (this.owns(id)) {
        continue; // this computer's records are made from its own history, never the other way
      }
      if (data && HIST_DAY_RE.test(data.day || "") && data.day >= first && Array.isArray(data.p)) {
        this._remote.set(id, { name: str(data.name, 80), day: data.day, p: data.p.map(histPage).filter(Boolean).slice(0, HIST_DAY_PAGES * 2) });
      } else {
        this._remote.delete(id);
      }
    }
    return {};
  },

  dump() {
    const first = histFirstDay();
    return { remote: [...this._remote].filter(([, d]) => d.day >= first) };
  },

  restore(saved) {
    const first = histFirstDay();
    for (const [id, d] of Array.isArray(saved?.remote) ? saved.remote : []) {
      if (ID_RE.test(id) && !this.owns(id) && d && HIST_DAY_RE.test(d.day || "") && d.day >= first && Array.isArray(d.p)) {
        this._remote.set(id, { name: str(d.name, 80), day: d.day, p: d.p.map(histPage).filter(Boolean) });
      }
    }
  },

  /** The group was turned off: other devices' history is no longer kept here. */
  forget() {
    this._remote.clear();
  },

  watch(notify) {
    PlacesObservers.addListener(["page-visited", "page-title-changed", "page-removed", "history-cleared"], events => {
      for (const e of events) {
        if (e.type === "page-visited") {
          this._dirty.add(histDay(e.visitTime));
        } else if (e.type === "page-title-changed") {
          this._dirty.add(histDay(Date.now()));
        } else {
          this._own = null;
        }
      }
      notify();
    });
  },

  /**
   * Pages visited on other devices, most recent first; one entry per address.
   *
   * @param {{ query?: string, since?: number, limit?: number }} [filter] words of `query` are
   *   looked for in the title and the address; `since` is a time in ms.
   * @returns {{ url: string, title: string, at: number, device: string }[]}
   */
  others({ query = "", since = 0, limit = 300 } = {}) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const first = histFirstDay();
    const best = new Map();
    for (const rec of this._remote.values()) {
      if (rec.day < first) {
        continue;
      }
      for (const page of rec.p) {
        if (page.at < since || (best.get(page.u)?.at || 0) >= page.at) {
          continue;
        }
        if (words.length) {
          const text = `${page.t} ${page.u}`.toLowerCase();
          if (!words.every(w => text.includes(w))) {
            continue;
          }
        }
        best.set(page.u, { url: page.u, title: page.t, at: page.at, device: rec.name });
      }
    }
    return [...best.values()].sort((a, b) => b.at - a.at).slice(0, limit);
  },
};

/* ---- addresses and bank cards (form autofill) --------------------------------------------------
 * The records of the engine's autofill storage: an address (name, organization, street, city,
 * region, postal code, country, phone, e-mail) and a bank card (number, expiry, cardholder's
 * name). The card's security code is not stored by the browser and so never gets here. A record
 * is { f: fields, c: created, m: changed }; the record ID is the storage's own ID.
 *
 * Both are synced only while the vault is open, like passwords. The engine keeps card numbers
 * encrypted with a key from the system keychain; they are decrypted for a sync pass and go to
 * the server inside the record, encrypted like everything else. */

const AUTOFILL_MAX = 400; // records of a kind
const ADDRESS_FIELDS = ["name", "organization", "street-address", "address-level3", "address-level2", "address-level1", "postal-code", "country", "tel", "email"];
const CARD_FIELDS = ["cc-name", "cc-number", "cc-exp-month", "cc-exp-year", "cc-type"];

/** Fields of an address as they may be stored: known names, short strings. Null if nothing is left. */
function addressFields(f) {
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
function cardFields(f) {
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

function autofillSource(name, collection, clean, sameThing, content = f => f) {
  return {
    name,

    async available() {
      return lazy.Vault.unlocked;
    },

    async _coll() {
      await lazy.formAutofillStorage.initialize();
      return lazy.formAutofillStorage[collection];
    },

    async list() {
      const out = new Map();
      for (const rec of await (await this._coll()).getAll({ rawData: true })) {
        const f = ID_RE.test(rec.guid || "") ? clean(rec) : null;
        if (!f && collection === "creditCards") {
          // The storage could not read the card's number (the vault was locked meanwhile) and
          // gave its mask. Taking that for "no such card" would delete the card everywhere.
          throw new Error("card numbers cannot be read now");
        }
        if (f && out.size < AUTOFILL_MAX) {
          out.set(rec.guid, { f, c: rec.timeCreated || 0, m: rec.timeLastModified || 0 });
        }
      }
      return out;
    },

    hashable: d => content(d.f),
    newer: (a, b) => (a.m || 0) > (b.m || 0),

    async apply(changes) {
      const coll = await this._coll();
      const local = new Map((await coll.getAll({ rawData: true })).map(rec => [rec.guid, rec]));
      for (const { id, data } of changes) {
        try {
          if (!data) {
            if (local.has(id)) {
              coll.remove(id);
              local.delete(id);
            }
            continue;
          }
          const f = clean(data.f);
          if (!f) {
            continue;
          }
          if (local.has(id)) {
            await coll.update(id, f, false);
            continue;
          }
          // the same address or card saved on two devices before sync: one record stays, under the server's ID
          const twin = [...local.values()].find(rec => sameThing(clean(rec), f));
          if (twin) {
            coll.changeGUID(twin.guid, id);
            local.delete(twin.guid);
            await coll.update(id, f, false);
          } else {
            coll.changeGUID(await coll.add(f), id);
          }
          local.set(id, { guid: id, ...f });
        } catch (e) {
          warn(`${name} ${id}`, e);
        }
      }
      return {};
    },

    watch(notify) {
      Services.obs.addObserver(
        { observe: (subject, topic, what) => what !== "notifyUsed" && subject?.wrappedJSObject?.collectionName === collection && notify() },
        "formautofill-storage-changed"
      );
    },
  };
}

const sameFields = (a, b) => !!a && !!b && JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
const addresses = autofillSource("addresses", "addresses", addressFields, sameFields);
// the card's network is worked out from the number by every storage itself and is not a part of the content
const cards = autofillSource("cards", "creditCards", cardFields, (a, b) => !!a && !!b && a["cc-number"] === b["cc-number"], ({ "cc-type": _type, ...rest }) => rest);

/* ---- settings ---------------------------------------------------------------------------------
 * A fixed list of settings that describe the person rather than the computer: theme, language,
 * the ad blocker and its exceptions, cookie banners, mail notifications, the sections of the side
 * panel and a few of the engine's. Window layout, the vault, the wallet, keys and addresses of
 * servers are not here. One record, "desktop", shared by the computers of the account:
 * { p: { name: value | null }, t: { name: time of the change } }; null means "as by default".
 *
 * Settings are merged one by one: the later change of a setting wins, whichever computer made
 * it. A setting that was changed before this computer joined has the time 1 and gives way to any
 * change made later. Only names of the list and values that pass its check are ever applied. */

const PREFS_TIMES = "tabora.sync.prefs.times";
const jsonList = (max, each) => v => {
  try {
    const list = JSON.parse(v);
    return v.length <= max && (list === null || (Array.isArray(list) && list.every(each)));
  } catch (e) {
    return false;
  }
};
const word = x => typeof x === "string" && /^[a-z0-9_-]{1,40}$/.test(x);
const host = x => typeof x === "string" && /^[a-z0-9.-]{1,255}$/i.test(x);
const SYNCED_PREFS = {
  "layout.css.prefers-color-scheme.content-override": ["int", v => v >= 0 && v <= 2],
  "tabora.lang": ["string", v => /^(|ru|en|uk|es)$/.test(v)],
  "tabora.user.name": ["string", v => v.length <= 80],
  "tabora.account.avatarColor": ["string", v => /^(|#[0-9a-f]{6})$/i.test(v)],
  "tabora.shield.enabled": ["bool"],
  "tabora.shield.youtube": ["bool"],
  "tabora.shield.lists": ["string", v => /^[a-z0-9,_-]{0,300}$/.test(v)],
  "tabora.shield.allow": ["string", jsonList(40000, host)],
  "tabora.cookies.banners": ["string", v => /^(reject|accept|off)$/.test(v)],
  "tabora.cookies.notify": ["bool"],
  "tabora.tabs.sleepAfterMinutes": ["int", v => v >= 0 && v <= 10080],
  "tabora.mail.notify": ["bool"],
  "tabora.mail.suggest": ["bool"],
  "tabora.drawer.sections": ["string", jsonList(2000, word)],
  "tabora.drawer.removed": ["string", jsonList(2000, word)],
  "tabora.drawer.pinned": ["string", v => v.length <= 200],
  "tabora.dock.items": ["string", v => /^[a-z0-9,_ -]{0,400}$/.test(v)],
  "tabora.agent.model": ["string", v => /^[A-Za-z0-9._:-]{0,100}$/.test(v)],
  "browser.startup.page": ["int", v => v >= 0 && v <= 3],
  "browser.search.suggest.enabled": ["bool"],
  "browser.tabs.warnOnClose": ["bool"],
  "browser.ctrlTab.sortByRecentlyUsed": ["bool"],
  "browser.translations.automaticallyPopup": ["bool"],
  "media.autoplay.default": ["int", v => v >= 0 && v <= 5],
  "signon.rememberSignons": ["bool"],
  "signon.autofillForms": ["bool"],
  "extensions.formautofill.addresses.enabled": ["bool"],
  "extensions.formautofill.creditCards.enabled": ["bool"],
  "privacy.globalprivacycontrol.enabled": ["bool"],
  "general.autoScroll": ["bool"],
  "layout.spellcheckDefault": ["int", v => v >= 0 && v <= 2],
};

const prefs = {
  name: "prefs",
  _applying: false,
  _times: null,

  /** A value of the list that may be applied: of the right type and passing the check. null: reset. */
  _ok(name, value) {
    const [type, check] = SYNCED_PREFS[name] || [];
    if (!type) {
      return false;
    }
    if (value === null) {
      return true;
    }
    const typed = type === "bool" ? typeof value === "boolean" : type === "int" ? Number.isInteger(value) : typeof value === "string";
    return typed && (!check || check(value));
  },

  _read(name) {
    if (!Services.prefs.prefHasUserValue(name)) {
      return null;
    }
    const [type] = SYNCED_PREFS[name];
    try {
      return type === "bool" ? Services.prefs.getBoolPref(name) : type === "int" ? Services.prefs.getIntPref(name) : Services.prefs.getStringPref(name);
    } catch (e) {
      return null;
    }
  },

  _write(name, value) {
    const [type] = SYNCED_PREFS[name];
    if (value === null) {
      Services.prefs.clearUserPref(name);
    } else if (type === "bool") {
      Services.prefs.setBoolPref(name, value);
    } else if (type === "int") {
      Services.prefs.setIntPref(name, value);
    } else {
      Services.prefs.setStringPref(name, value);
    }
  },

  /** Times of the changes: { name: ms }. The first time, every setting the person has changed gets the time 1. */
  times() {
    if (!this._times) {
      let saved = null;
      try {
        saved = JSON.parse(Services.prefs.getStringPref(PREFS_TIMES, "null"));
      } catch (e) {}
      if (saved && typeof saved === "object") {
        this._times = Object.fromEntries(Object.entries(saved).filter(([name, at]) => SYNCED_PREFS[name] && Number(at) > 0));
      } else {
        this._times = Object.fromEntries(Object.keys(SYNCED_PREFS).filter(name => Services.prefs.prefHasUserValue(name)).map(name => [name, 1]));
        this._saveTimes();
      }
    }
    return this._times;
  },

  _saveTimes() {
    Services.prefs.setStringPref(PREFS_TIMES, JSON.stringify(this._times));
  },

  async list() {
    const t = this.times();
    const p = {};
    for (const name of Object.keys(t)) {
      const value = this._read(name);
      // a value that does not pass the check is not offered to the other computers
      p[name] = this._ok(name, value) ? value : null;
    }
    return Object.keys(t).length ? new Map([["desktop", { p, t: { ...t } }]]) : new Map();
  },

  hashable: d => ({ p: d.p, t: d.t }),

  async apply(changes) {
    const change = changes.find(c => c.id === "desktop");
    const theirs = change?.data;
    if (!theirs || typeof theirs.p !== "object" || typeof theirs.t !== "object") {
      return {}; // the record was removed elsewhere: the settings here stay, and it goes up again
    }
    const t = this.times();
    let mine = false;
    this._applying = true;
    try {
      for (const name of Object.keys(SYNCED_PREFS)) {
        const at = Number(theirs.t?.[name]) || 0;
        const here = t[name] || 0;
        if (at > here && name in theirs.p && this._ok(name, theirs.p[name])) {
          this._write(name, theirs.p[name]);
          t[name] = at;
        } else if (here > at) {
          mine = true; // changed here later (or not known there at all): the merged record goes up
        }
      }
    } finally {
      this._applying = false;
      this._saveTimes();
    }
    return mine ? { dirty: ["desktop"] } : {};
  },

  watch(notify) {
    const observer = {
      observe: (subject, topic, name) => {
        if (!this._applying && SYNCED_PREFS[name]) {
          this.times()[name] = Date.now();
          this._saveTimes();
          notify();
        }
      },
    };
    for (const name of Object.keys(SYNCED_PREFS)) {
      Services.prefs.addObserver(name, observer);
    }
  },
};

/* ---- extensions -------------------------------------------------------------------------------
 * Every computer publishes the list of extensions the person has installed on it (one record
 * under its device ID): ID, name, version. The other computers only show the list and offer to
 * open the extension's page in the catalog; nothing is installed by itself. */

const ADDONS_MAX = 300;
const addonItem = a =>
  a && typeof a.id === "string" && a.id.length <= 255 && /^[\x21-\x7e]+$/.test(a.id) ? { id: a.id, n: str(a.n, 120), v: str(a.v, 40), ...(a.off ? { off: 1 } : {}) } : null;

const addons = {
  name: "addons",
  _remote: new Map(), // device ID → { name, list }

  owns(id) {
    return id === lazy.Account.deviceId();
  },

  /** Extensions the person installed here: not the browser's own, not themes, not temporary ones. */
  async _mine() {
    const all = await lazy.AddonManager.getAddonsByTypes(["extension"]);
    return all
      .filter(a => !a.isSystem && !a.isBuiltin && !a.hidden && !a.temporarilyInstalled)
      .map(a => addonItem({ id: a.id, n: a.name, v: a.version, off: !a.isActive }))
      .filter(Boolean)
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, ADDONS_MAX);
  },

  async list() {
    return new Map([[lazy.Account.deviceId(), { name: str(lazy.Account.deviceName(), 80), list: await this._mine() }]]);
  },

  hashable: d => ({ list: d.list }),

  async apply(changes) {
    for (const { id, data } of changes) {
      if (this.owns(id)) {
        continue;
      }
      if (data && Array.isArray(data.list)) {
        this._remote.set(id, { name: str(data.name, 80), list: data.list.map(addonItem).filter(Boolean).slice(0, ADDONS_MAX) });
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
      if (ID_RE.test(id) && !this.owns(id) && data && Array.isArray(data.list)) {
        this._remote.set(id, { name: str(data.name, 80), list: data.list.map(addonItem).filter(Boolean) });
      }
    }
  },

  forget() {
    this._remote.clear();
  },

  watch(notify) {
    const changed = () => notify();
    lazy.AddonManager.addAddonListener({ onInstalled: changed, onUninstalled: changed, onEnabled: changed, onDisabled: changed });
  },

  /** Extensions of the other computers that are not installed here: [{ id, name, devices: [name] }]. */
  async missing() {
    const here = new Set((await this._mine()).map(a => a.id));
    const out = new Map();
    for (const dev of this._remote.values()) {
      for (const a of dev.list) {
        if (!here.has(a.id)) {
          const item = out.get(a.id) || { id: a.id, name: a.n || a.id, devices: [] };
          item.devices.push(dev.name);
          out.set(a.id, item);
        }
      }
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  },
};

export const SOURCES = { logins, otp, passkeys, marks, spaces, start, tabs, sent, history, addresses, cards, prefs, addons };
