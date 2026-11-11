/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Встроенный блокировщик рекламы: отменяет запросы к рекламным и следящим серверам и прячет
 * рекламные блоки на страницах. Правила — общедоступные списки фильтров (EasyList, RU AdList,
 * EasyPrivacy, список Питера Лоу); разбор и сопоставление — shield/ShieldEngine.sys.mjs.
 *
 * Чего блокировщик не делает: не выполняет на страницах никакого кода из списков и не
 * переписывает ответы серверов — только отменяет запросы и добавляет стили «не показывать».
 * Поэтому испорченный или подменённый список может в худшем случае что-то лишнее спрятать или
 * не загрузить, но не может ничего внедрить в страницу.
 *
 * Запросы. Родительский процесс видит каждый HTTP-запрос до отправки (http-on-modify-request).
 * Проверяются только запросы страниц во вкладках: запросы самого браузера (почта, кошелёк,
 * сервер аккаунтов, обновления) не трогаются. Переход на страницу не блокируется никогда —
 * только то, что страница подгружает.
 *
 * Стили. Общие правила скрытия (их тысячи) собраны в одну таблицу стилей; её текст раздаётся
 * процессам страниц через общую память, и каждый процесс разбирает её один раз. Свои правила
 * сайта приходят документу отдельным небольшим листом (actors/TaboraShieldChild).
 *
 * Списки. Лежат в профиле (tabora-shield/), обновляются по сроку из своего заголовка (от суток
 * до недели) условным запросом. Загрузка списка сообщает его серверу только адрес компьютера,
 * как любой запрос; какие сайты посещает пользователь, наружу не уходит: сопоставление идёт
 * здесь. Сайт, на котором блокировка мешает, вносится в исключения. */

import { Engine, TYPE, hideSheet, listExpiry } from "chrome://tabora/content/shield/ShieldEngine.sys.mjs";

const { setTimeout, clearTimeout, setInterval } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

const PREF = "tabora.shield.";
const DIR = () => PathUtils.join(PathUtils.profileDir, "tabora-shield");
const SHARED = "tabora-shield";
const CHECK_MS = 3 * 3600 * 1000;
const RETRY_MS = 30 * 60 * 1000; // неудавшаяся загрузка списка повторяется не раньше
const MAX_LIST = 40 * 1024 * 1024;
const MAX_PAGES = 400;

export const LISTS = [
  { id: "easylist", title: "EasyList", note: "Реклама на сайтах всего мира", kind: "ads", url: "https://easylist.to/easylist/easylist.txt" },
  { id: "ruadlist", title: "RU AdList", note: "Реклама на русскоязычных сайтах", kind: "ads", url: "https://easylist-downloads.adblockplus.org/advblock.txt" },
  { id: "easyprivacy", title: "EasyPrivacy", note: "Счётчики посещений и трекеры", kind: "privacy", url: "https://easylist.to/easylist/easyprivacy.txt" },
  { id: "lowe", title: "Список Питера Лоу", note: "Рекламные и следящие серверы", kind: "ads", url: "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=1&mimetype=plaintext" },
];

const CP = Ci.nsIContentPolicy;
const TYPE_BITS = new Map([
  [CP.TYPE_SCRIPT, TYPE.script], [CP.TYPE_IMAGE, TYPE.image], [CP.TYPE_IMAGESET, TYPE.image], [CP.TYPE_STYLESHEET, TYPE.stylesheet], [CP.TYPE_OBJECT, TYPE.object],
  [CP.TYPE_SUBDOCUMENT, TYPE.subdocument], [CP.TYPE_PING, TYPE.ping], [CP.TYPE_BEACON, TYPE.ping], [CP.TYPE_CSP_REPORT, TYPE.ping], [CP.TYPE_XMLHTTPREQUEST, TYPE.xhr],
  [CP.TYPE_FETCH, TYPE.xhr], [CP.TYPE_FONT, TYPE.font], [CP.TYPE_MEDIA, TYPE.media], [CP.TYPE_WEBSOCKET, TYPE.websocket],
]);

const idle = () => new Promise(resolve => ChromeUtils.idleDispatch(resolve, { timeout: 120 }));

function baseDomain(host) {
  try {
    return Services.eTLD.getBaseDomainFromHost(host);
  } catch (e) {
    return host; // адрес из цифр, localhost
  }
}

export const Shield = {
  TOPIC: "tabora-shield-changed",
  _engine: null,
  _started: false,
  _state: null, // { lists: { id: { at, etag, expires, size, error, tried } } }
  _allow: null,
  _pages: new Map(), // номер верхнего документа → { off, generichide, ads: Map, privacy: Map, total }
  _version: 0,
  _genericCss: "",
  _customGeneric: new Map(),
  _building: null,
  _updating: null,

  notify(what = "changed") {
    Services.obs.notifyObservers(null, this.TOPIC, what);
  },

  /* ---- настройки ----------------------------------------------------------------------------- */

  get enabled() {
    return Services.prefs.getBoolPref(`${PREF}enabled`, true);
  },

  setEnabled(on) {
    Services.prefs.setBoolPref(`${PREF}enabled`, !!on);
    this._pages.clear();
    if (on && !this._engine) {
      this._load().catch(e => console.error("Tabora shield", e));
    }
    this.notify("settings");
  },

  _listIds() {
    const known = new Set(LISTS.map(l => l.id));
    return Services.prefs.getStringPref(`${PREF}lists`, LISTS.map(l => l.id).join(",")).split(",").filter(id => known.has(id));
  },

  setList(id, on) {
    const ids = new Set(this._listIds());
    if (on) {
      ids.add(id);
    } else {
      ids.delete(id);
    }
    Services.prefs.setStringPref(`${PREF}lists`, LISTS.map(l => l.id).filter(x => ids.has(x)).join(","));
    this.notify("settings");
    this.update().catch(() => {}).then(() => this._rebuild());
  },

  /** Списки для экрана настроек: [{ id, title, note, kind, on, at, size, error }]. */
  lists() {
    const on = new Set(this._listIds());
    return LISTS.map(l => {
      const meta = this._state?.lists?.[l.id] || {};
      return { id: l.id, title: l.title, note: l.note, kind: l.kind, on: on.has(l.id), at: meta.at || 0, size: meta.size || 0, error: meta.error || "" };
    });
  },

  get counts() {
    return this._engine ? this._engine.counts : null;
  },

  get ready() {
    return !!this._engine;
  },

  get busy() {
    return !!(this._building || this._updating);
  },

  /* ---- исключения ---------------------------------------------------------------------------- */

  _allowSet() {
    if (!this._allow) {
      let list = [];
      try {
        list = JSON.parse(Services.prefs.getStringPref(`${PREF}allow`, "[]"));
      } catch (e) {}
      this._allow = new Set((Array.isArray(list) ? list : []).filter(s => typeof s === "string" && s.length <= 255));
    }
    return this._allow;
  },

  allowList() {
    return [...this._allowSet()].sort();
  },

  /** Блокировка на сайте выключена пользователем (сайт — регистрируемый домен). */
  allowed(host) {
    return this._allowSet().has(baseDomain(String(host || "").toLowerCase()));
  },

  setAllowed(host, on) {
    const site = baseDomain(String(host || "").toLowerCase());
    if (!site) {
      return;
    }
    const set = this._allowSet();
    if (on) {
      set.add(site);
    } else {
      set.delete(site);
    }
    Services.prefs.setStringPref(`${PREF}allow`, JSON.stringify([...set].sort().slice(0, 2000)));
    this._pages.clear();
    this.notify("allow");
  },

  /* ---- списки на диске -------------------------------------------------------------------------- */

  async _readState() {
    if (!this._state) {
      try {
        this._state = await IOUtils.readJSON(PathUtils.join(DIR(), "state.json"));
      } catch (e) {}
      if (!this._state || typeof this._state.lists !== "object") {
        this._state = { lists: {} };
      }
    }
    return this._state;
  },

  async _saveState() {
    await IOUtils.makeDirectory(DIR(), { ignoreExisting: true });
    await IOUtils.writeJSON(PathUtils.join(DIR(), "state.json"), this._state, { tmpPath: PathUtils.join(DIR(), "state.json.tmp") });
  },

  /** Скачать списки, у которых вышел срок (force — все включённые). Возвращает число обновлённых. */
  update({ force = false } = {}) {
    this._updating ||= this._update(force).finally(() => {
      this._updating = null;
      this.notify("lists");
    });
    return this._updating;
  },

  async _update(force) {
    const state = await this._readState();
    const on = new Set(this._listIds());
    const now = Date.now();
    let changed = 0;
    this.notify("lists");
    for (const list of LISTS) {
      if (!on.has(list.id)) {
        continue;
      }
      const meta = (state.lists[list.id] ||= {});
      const file = PathUtils.join(DIR(), `${list.id}.txt`);
      const have = meta.at && (await IOUtils.exists(file));
      if (!force && have && now - meta.at < (meta.expires || 2 * 86400000)) {
        continue;
      }
      if (!force && meta.tried && now - meta.tried < RETRY_MS) {
        continue;
      }
      meta.tried = now;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 90000);
      try {
        const res = await fetch(list.url, { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer", headers: have && meta.etag ? { "If-None-Match": meta.etag } : {}, signal: ctrl.signal });
        if (res.status === 304) {
          meta.at = now;
          meta.error = "";
          continue;
        }
        if (!res.ok) {
          throw new Error(`сервер списка ответил ${res.status}`);
        }
        const text = await res.text();
        // страница-заглушка или обрезанный ответ не должны заменить рабочий список
        if (text.length < 2000 || text.length > MAX_LIST || !/^\s*(\[Adblock|!)/.test(text.slice(0, 300)) || text.includes("<html")) {
          throw new Error("ответ не похож на список фильтров");
        }
        await IOUtils.makeDirectory(DIR(), { ignoreExisting: true });
        await IOUtils.writeUTF8(file, text, { tmpPath: `${file}.tmp` });
        Object.assign(meta, { at: now, etag: res.headers.get("ETag") || "", expires: listExpiry(text), size: text.length, error: "" });
        changed++;
      } catch (e) {
        meta.error = e.name === "AbortError" ? "сервер списка не ответил" : e.message || String(e);
      } finally {
        clearTimeout(timer);
      }
    }
    await this._saveState();
    if (changed) {
      await this._rebuild();
    }
    return changed;
  },

  /** Собрать движок из списков на диске. Разбор идёт кусками в свободное время потока. */
  _rebuild() {
    this._building ||= this._build().finally(() => {
      this._building = null;
      this.notify("engine");
    });
    return this._building;
  },

  async _build() {
    const texts = [];
    for (const list of LISTS.filter(l => this._listIds().includes(l.id))) {
      try {
        texts.push([list.kind, await IOUtils.readUTF8(PathUtils.join(DIR(), `${list.id}.txt`))]);
      } catch (e) {}
    }
    if (!texts.length) {
      this._engine = null;
      return;
    }
    // селектор проверяется разбором: негодный не попадает в таблицу стилей
    const css = Services.wm.getMostRecentWindow("navigator:browser")?.CSS;
    const engine = new Engine({ validSelector: css ? s => css.supports(`selector(${s})`) : () => true });
    texts.forEach(([, text]) => engine.scanBadfilters(text));
    for (const [kind, text] of texts) {
      for (const _ of engine.feed(text, { kind, step: 1500 })) {
        await idle();
      }
    }
    this._engine = engine;
    this._pages.clear();
    this._customGeneric.clear();
    this._genericCss = hideSheet([...engine.generic], 20);
    this._version++;
    Services.ppmm.sharedData.set(SHARED, { v: this._version, css: this._genericCss });
    Services.ppmm.sharedData.flush();
  },

  async _load() {
    await this._readState();
    await this._rebuild();
    await this.update();
  },

  /* ---- запросы -------------------------------------------------------------------------------- */

  /** Что известно о странице (верхнем документе вкладки): выключена ли на ней блокировка и
   * счётчики заблокированного. Живёт, пока жив документ: новый документ — новая запись. */
  _page(topGlobal) {
    const id = topGlobal.innerWindowId;
    let page = this._pages.get(id);
    if (!page) {
      const principal = topGlobal.documentPrincipal;
      // не страница сайта (служебная, файл с диска): блокировщик её не касается
      page = { off: true, host: "", generichide: false, elemhide: false, ads: new Map(), privacy: new Map(), total: 0 };
      if (principal?.isContentPrincipal && (principal.schemeIs("https") || principal.schemeIs("http"))) {
        page.host = principal.asciiHost.toLowerCase();
        page.off = this.allowed(page.host);
        if (!page.off && this._engine) {
          // исключения уровня страницы в самих списках: @@…$document, $elemhide, $generichide
          const options = this._engine.pageOptions(topGlobal.documentURI?.spec || `${principal.scheme}://${page.host}/`, page.host);
          page.off = options.document;
          page.elemhide = options.elemhide;
          page.generichide = options.generichide || options.elemhide;
        }
      }
      if (this._pages.size >= MAX_PAGES) {
        this._pages.delete(this._pages.keys().next().value);
      }
      this._pages.set(id, page);
    }
    return page;
  },

  observe(subject) {
    const engine = this._engine;
    if (!engine || !this.enabled) {
      return;
    }
    try {
      const channel = subject.QueryInterface(Ci.nsIHttpChannel);
      const info = channel.loadInfo;
      const type = info.externalContentPolicyType;
      if (type === CP.TYPE_DOCUMENT || type === CP.TYPE_SAVEAS_DOWNLOAD) {
        return; // переход на страницу и скачивание по просьбе пользователя не блокируются
      }
      const context = info.browsingContext || info.workerAssociatedBrowsingContext;
      const topGlobal = context?.top?.currentWindowGlobal;
      if (!topGlobal) {
        return; // запрос не от страницы во вкладке
      }
      const page = this._page(topGlobal);
      if (page.off) {
        return;
      }
      const uri = channel.URI;
      const host = uri.asciiHost.toLowerCase();
      const loader = info.loadingPrincipal;
      const docHost = loader?.isContentPrincipal && loader.asciiHost ? loader.asciiHost.toLowerCase() : page.host;
      const hit = engine.match({ url: uri.spec, host, type: TYPE_BITS.get(type) || TYPE.other, docHost, thirdParty: baseDomain(host) !== baseDomain(docHost) });
      if (!hit) {
        return;
      }
      info.requestBlockingReason = Ci.nsILoadInfo.BLOCKING_REASON_CLASSIFY_BLOCKED_URI;
      channel.cancel(Cr.NS_ERROR_ABORT);
      const bucket = hit.kind === "privacy" ? page.privacy : page.ads;
      bucket.set(host, (bucket.get(host) || 0) + 1);
      page.total++;
    } catch (e) {
      // запрос без нужных сведений (служебный): не наш
    }
  },

  /** Что заблокировано на странице во вкладке: { off, ads: [[хост, число]], privacy: […], total }. */
  statsFor(browser) {
    const global = browser?.browsingContext?.currentWindowGlobal;
    const page = global ? this._pages.get(global.innerWindowId) : null;
    const sorted = map => [...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return page ? { off: page.off, ads: sorted(page.ads), privacy: sorted(page.privacy), total: page.total } : { off: false, ads: [], privacy: [], total: 0 };
  },

  /* ---- стили страниц -------------------------------------------------------------------------- */

  /** Ответ документу (actors/TaboraShieldParent): какие листы скрытия ему применить.
   * { off } — никаких; иначе { v, generic — общий лист из общей памяти, extra — свой вариант
   * общего листа (на сайте часть общих правил отменена), css — правила самого сайта }. */
  styleFor(windowGlobal) {
    const engine = this._engine;
    const principal = windowGlobal.documentPrincipal;
    if (!engine || !this.enabled || !principal?.isContentPrincipal || !(principal.schemeIs("https") || principal.schemeIs("http"))) {
      return { off: true };
    }
    const topGlobal = windowGlobal.browsingContext.top.currentWindowGlobal;
    const page = topGlobal ? this._page(topGlobal) : null;
    if (!page || page.off || page.elemhide) {
      return { off: true };
    }
    const host = principal.asciiHost.toLowerCase();
    const mine = engine.cosmetics(host);
    let generic = !page.generichide;
    let extra = "";
    if (generic && !mine.generic) {
      // на этом сайте часть общих правил отменена: ему собирается свой вариант общего листа
      generic = false;
      extra = this._customGeneric.get(host);
      if (extra === undefined) {
        const off = new Set(mine.off);
        extra = hideSheet([...engine.generic].filter(s => !off.has(s)), 20);
        if (this._customGeneric.size >= 12) {
          this._customGeneric.delete(this._customGeneric.keys().next().value);
        }
        this._customGeneric.set(host, extra);
      }
    }
    return { v: this._version, generic, extra, css: mine.selectors.length ? hideSheet(mine.selectors, 20) : "" };
  },

  /* ---- запуск --------------------------------------------------------------------------------- */

  /** Один раз на процесс: перехват запросов, актор стилей, загрузка и обновление списков. */
  start() {
    if (this._started) {
      return;
    }
    this._started = true;
    Services.obs.addObserver(this, "http-on-modify-request");
    Services.prefs.addObserver(`${PREF}allow`, () => {
      this._allow = null;
      this._pages.clear();
    });
    try {
      ChromeUtils.registerWindowActor("TaboraShield", {
        parent: { esModuleURI: "chrome://tabora/content/actors/TaboraShieldParent.sys.mjs" },
        child: { esModuleURI: "chrome://tabora/content/actors/TaboraShieldChild.sys.mjs", events: { DOMDocElementInserted: { capture: true } } },
        matches: ["https://*/*", "http://*/*"],
        allFrames: true,
        messageManagerGroups: ["browsers"],
        // актору нечего выдать захваченному процессу страницы: на любой запрос он получает
        // только общедоступные правила скрытия для собственного документа этого процесса
        safeForUntrustedWebProcess: true,
        remoteTypes: ["web"],
      });
    } catch (e) {
      // уже зарегистрирован
    }
    setTimeout(() => {
      if (this.enabled) {
        this._load().catch(e => console.error("Tabora shield", e));
      }
    }, 3000);
    setInterval(() => {
      if (this.enabled) {
        this.update().catch(() => {});
      }
    }, CHECK_MS);
  },

  QueryInterface: ChromeUtils.generateQI(["nsIObserver"]),
};
