/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Обновления Tabora. Скачивание и установка — штатный обновлятор движка (подписанные
 * MAR-пакеты, проверка подписи нашим сертификатом и версии Tabora, установка при
 * перезапуске). Поверх него — подписанный манифест цели
 * updates/<канал>/<BUILD_TARGET>/manifest.json (формат и выпуск: docs/UPDATES.md):
 *   { "signed": "<JSON-текст>", "signatures": [{ "keyid": "…", "sig": "<Ed25519, base64>" }] }
 * Внутри: версия, минимально допустимая версия, заметки, срок действия и пакет для этой
 * цели (адрес, sha512, размер, buildID). update.xml принимается, только если совпадает
 * с пакетом из манифеста (UpdateService.sys.mjs.patch вызывает filterUpdates).
 * Если текущая версия ниже minimum и обновление действительно можно поставить,
 * обновление обязательное: интерфейс блокируется до установки. Иначе — плашка
 * «Доступна версия». Проверка при запуске и раз в час. */

const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");
const { setTimeout, clearTimeout, setInterval } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AppUpdater: "resource://gre/modules/AppUpdater.sys.mjs",
  UpdateUtils: "resource://gre/modules/UpdateUtils.sys.mjs",
});

const MANIFEST_URL_PREF = "tabora.update.manifestUrl";
const MANUAL_URL_PREF = "app.update.url.manual";
const VERSION_PREF = "tabora.version";
const SNOOZE_PREF = "tabora.update.snoozedUntil";
const LAST_CHECK_PREF = "tabora.update.lastCheck";
const CHECK_INTERVAL = 60 * 60 * 1000;
const MANIFEST_MAX_BYTES = 64 * 1024;
const MANIFEST_CACHE_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 15000;
const MANIFEST_FORMAT = 1;

/** Открытые ключи Ed25519, которыми подписываются манифесты (сырые 32 байта, base64).
 * keyid — первые 16 hex-символов SHA-256 от ключа. Основной ключ лежит рядом с ключом
 * MAR (TABORA_MAR_KEYS_DIR/manifest-ed25519.pem), запасной — в офлайн-хранилище
 * вместе с запасным ключом MAR. Замена ключей — только новой сборкой. */
export const MANIFEST_KEYS = Object.freeze({
  "57b30cbe780889e7": "4yhy0HmBzaoUadS9B/PVfMnRJp9/71H3wfqGF/Bdvws=", // основной
  "3d5a8415043dcc8d": "s20uAJq2h7g0WMgrVhp74MlPJIEPOw0ZMT+0xalHQ8E=", // запасной
});

const VERSION_RE = /^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$/;
const HTTPS_RE = /^https:\/\/[^\/?#@\s\\]+(\/[^\s]*)?$/;

export function isVersion(v) {
  return typeof v === "string" && VERSION_RE.test(v);
}

/** Сравнение версий вида 0.1.10 / 0.2.0-beta.1: по числовым частям, суффикс младше релиза. */
export function compareVersions(a, b) {
  const parse = v => {
    const [core, pre = ""] = String(v || "0").trim().split("-");
    return { nums: core.split(".").map(n => parseInt(n, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] || 0) - (y.nums[i] || 0);
    if (d) {
      return d < 0 ? -1 : 1;
    }
  }
  if (x.pre === y.pre) {
    return 0;
  }
  if (!x.pre) {
    return 1;
  }
  if (!y.pre) {
    return -1;
  }
  return x.pre < y.pre ? -1 : 1;
}

/** Строковая настройка только из ветки по умолчанию (то, что зашито в сборку):
 * значение пользователя, about:config и user.js не учитываются. */
export function defaultPref(name) {
  try {
    return Services.prefs.getDefaultBranch("").getStringPref(name, "");
  } catch (e) {
    return "";
  }
}

/** То же, но только https-адрес; иначе пустая строка. */
export function defaultHttpsPref(name) {
  const value = defaultPref(name);
  return HTTPS_RE.test(value) ? value : "";
}

/** Оба адреса https и на одном хосте (перенаправление на другой хост не принимается). */
export function sameHttpsHost(expected, actual) {
  try {
    const a = new URL(expected);
    const b = new URL(actual);
    return a.protocol === "https:" && b.protocol === "https:" && a.host === b.host;
  } catch (e) {
    return false;
  }
}

function fromBase64(s) {
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

/** Проверка подписи манифеста. Возвращает разобранную подписанную часть или бросает. */
export async function verifyManifestText(text, keys = MANIFEST_KEYS) {
  if (typeof text !== "string" || !text || text.length > MANIFEST_MAX_BYTES) {
    throw new Error("манифест пустой или слишком большой");
  }
  const outer = JSON.parse(text);
  if (!outer || typeof outer.signed !== "string" || !Array.isArray(outer.signatures)) {
    throw new Error("манифест без подписи");
  }
  const data = new TextEncoder().encode(outer.signed);
  for (const s of outer.signatures.slice(0, 4)) {
    const raw = typeof s?.keyid === "string" && Object.hasOwn(keys, s.keyid) ? keys[s.keyid] : null;
    if (!raw || typeof s.sig !== "string" || s.sig.length > 200) {
      continue;
    }
    try {
      const key = await crypto.subtle.importKey("raw", fromBase64(raw), { name: "Ed25519" }, false, ["verify"]);
      if (await crypto.subtle.verify({ name: "Ed25519" }, key, fromBase64(s.sig), data)) {
        return JSON.parse(outer.signed);
      }
    } catch (e) {
      // неверный base64 или ключ — пробуем следующую подпись
    }
  }
  throw new Error("подпись манифеста недействительна");
}

/** Проверка полей подписанной части. Возвращает нормализованную запись канала или бросает. */
export function validateManifest(p, { channel, target }) {
  const fail = msg => {
    throw new Error(msg);
  };
  if (!p || typeof p !== "object" || Array.isArray(p)) {
    fail("пустой манифест");
  }
  if (p.format !== MANIFEST_FORMAT) {
    fail("неизвестный формат манифеста");
  }
  if (p.channel !== channel) {
    fail("манифест другого канала");
  }
  if (p.target !== target) {
    fail("манифест другой платформы");
  }
  if (!isVersion(p.version)) {
    fail("неверная версия в манифесте");
  }
  if (p.minimum != null && !isVersion(p.minimum)) {
    fail("неверная минимальная версия");
  }
  if (p.minimum && compareVersions(p.minimum, p.version) > 0) {
    fail("минимальная версия выше последней");
  }
  if (p.notes != null && (typeof p.notes !== "string" || p.notes.length > 2000)) {
    fail("слишком длинные заметки");
  }
  if (p.notesUrl != null && (typeof p.notesUrl !== "string" || p.notesUrl.length > 512 || !HTTPS_RE.test(p.notesUrl))) {
    fail("адрес заметок не https");
  }
  if (typeof p.published !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(p.published)) {
    fail("неверная дата выпуска");
  }
  const expires = typeof p.expires === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(p.expires) ? Date.parse(p.expires) : NaN;
  if (!Number.isFinite(expires)) {
    fail("неверный срок действия манифеста");
  }
  let update = null;
  if (p.update != null) {
    const u = p.update;
    if (typeof u !== "object" || Array.isArray(u)) {
      fail("неверное описание пакета");
    }
    if (typeof u.url !== "string" || u.url.length > 1024 || !HTTPS_RE.test(u.url)) {
      fail("адрес пакета не https");
    }
    if (typeof u.sha512 !== "string" || !/^[0-9a-f]{128}$/.test(u.sha512)) {
      fail("неверный sha512 пакета");
    }
    if (!Number.isSafeInteger(u.size) || u.size <= 0 || u.size > 4 * 1024 ** 3) {
      fail("неверный размер пакета");
    }
    if (typeof u.buildID !== "string" || !/^\d{14}$/.test(u.buildID)) {
      fail("неверный buildID пакета");
    }
    if (typeof u.appVersion !== "string" || !/^[0-9][0-9a-z.]{0,31}$/.test(u.appVersion)) {
      fail("неверная версия движка пакета");
    }
    update = { url: u.url, sha512: u.sha512, size: u.size, buildID: u.buildID, appVersion: u.appVersion };
  }
  return {
    version: p.version,
    minimum: p.minimum || null,
    notes: p.notes || "",
    notesUrl: p.notesUrl || null,
    published: p.published,
    expires,
    update,
  };
}

export const TaboraUpdate = {
  TOPIC: "tabora-update-changed",
  // для UpdateService.sys.mjs.patch: defineESModuleGetters отдаёт только этот объект
  defaultHttpsPref,
  sameHttpsHost,
  channel: null, // проверенная запись из подписанного манифеста цели
  manifestError: null,
  appUpdater: null,
  status: null, // AppUpdater.STATUS.*
  progress: null, // { done, total }
  _manifestAt: 0,
  _manifestPending: null,
  _timer: null,
  _started: false,

  /** Версия Tabora этой сборки (из настроек по умолчанию; null, если не задана). */
  get currentVersion() {
    const v = defaultPref(VERSION_PREF);
    return isVersion(v) ? v : null;
  },

  get channelName() {
    return lazy.UpdateUtils.UpdateChannel || "release";
  },

  get buildTarget() {
    return `${Services.appinfo.OS}_${lazy.UpdateUtils.ABI}`;
  },

  /** Сайт для ручной загрузки (только https из настроек по умолчанию). */
  get manualUrl() {
    return defaultHttpsPref(MANUAL_URL_PREF) || "https://tabora.app/";
  },

  /** Манифест просрочен: новые сведения об обновлениях не приходят (заморозка версии). */
  get stale() {
    return !!this.channel && Date.now() > this.channel.expires;
  },

  /** Есть ли версия новее текущей по манифесту. */
  get available() {
    const cur = this.currentVersion;
    return !!cur && !!this.channel?.version && compareVersions(this.channel.version, cur) > 0;
  },

  /** Может ли эта установка сама скачать и поставить обновление. */
  get updatesPossible() {
    if (!AppConstants.MOZ_UPDATER) {
      return false;
    }
    try {
      if (Services.policies && !Services.policies.isAllowed("appUpdate")) {
        return false;
      }
      const aus = Cc["@mozilla.org/updates/update-service;1"].getService(Ci.nsIApplicationUpdateService);
      return !aus.disabled && aus.canUsuallyCheckForUpdates && aus.canUsuallyApplyUpdates;
    } catch (e) {
      return false;
    }
  },

  /** Обязательное: текущая версия ниже минимально допустимой, для этой платформы есть
   * пакет не ниже минимальной версии и обновлятор действительно может его поставить. */
  get mandatory() {
    const cur = this.currentVersion;
    const ch = this.channel;
    if (!cur || !ch?.minimum || compareVersions(cur, ch.minimum) >= 0) {
      return false;
    }
    if (!ch.update || compareVersions(ch.version, ch.minimum) < 0) {
      return false;
    }
    if (!this.updatesPossible) {
      return false;
    }
    const S = lazy.AppUpdater.STATUS;
    const blocked = [S.NO_UPDATER, S.UPDATE_DISABLED_BY_POLICY, S.MANUAL_UPDATE, S.UNSUPPORTED_SYSTEM, S.NO_UPDATES_FOUND, S.OTHER_INSTANCE_HANDLING_UPDATES];
    return !blocked.includes(this.status);
  },

  get readyForRestart() {
    return this.status === lazy.AppUpdater.STATUS.READY_FOR_RESTART;
  },

  get snoozed() {
    return Date.now() < Number(Services.prefs.getStringPref(SNOOZE_PREF, "0"));
  },

  notify(what = "changed") {
    Services.obs.notifyObservers(null, this.TOPIC, what);
  },

  /** Запуск: проверка сразу и затем раз в час. Вызывается оболочкой из первого окна. */
  start() {
    if (this._started) {
      return;
    }
    this._started = true;
    setTimeout(() => this.check().catch(() => {}), 8000);
    this._timer = setInterval(() => this.check().catch(() => {}), CHECK_INTERVAL);
  },

  /** Полная проверка: манифест цели, затем штатный обновлятор. */
  async check({ force = false } = {}) {
    await this.fetchManifest();
    if (!this.available && !force) {
      this.notify();
      return;
    }
    await this.runAppUpdater();
    Services.prefs.setStringPref(LAST_CHECK_PREF, String(Date.now()));
    this.notify();
  },

  /** Скачать и проверить манифест цели. При ошибке остаётся последняя проверенная запись. */
  fetchManifest({ maxAge = 0 } = {}) {
    if (maxAge && this._manifestAt && Date.now() - this._manifestAt < maxAge) {
      return Promise.resolve(this.channel);
    }
    if (!this._manifestPending) {
      this._manifestPending = this._fetchManifest().finally(() => {
        this._manifestPending = null;
      });
    }
    return this._manifestPending;
  },

  async _fetchManifest() {
    const template = defaultHttpsPref(MANIFEST_URL_PREF);
    if (!template) {
      this.manifestError = "адрес манифеста не задан";
      return this.channel;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const url = await lazy.UpdateUtils.formatUpdateURL(template);
      const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`, {
        cache: "no-store",
        credentials: "omit",
        redirect: "follow",
        signal: ctrl.signal,
      });
      if (!sameHttpsHost(url, res.url)) {
        throw new Error("ответ с другого адреса");
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const length = Number(res.headers.get("Content-Length") || 0);
      if (length > MANIFEST_MAX_BYTES) {
        throw new Error("манифест слишком большой");
      }
      const payload = await verifyManifestText(await res.text());
      this.channel = validateManifest(payload, { channel: this.channelName, target: this.buildTarget });
      this._manifestAt = Date.now();
      this.manifestError = null;
    } catch (e) {
      this.manifestError = e.name === "AbortError" ? "нет ответа" : e.message || String(e);
    } finally {
      clearTimeout(timer);
    }
    return this.channel;
  },

  /** Совпадает ли <update> из update.xml с пакетом из подписанного манифеста. */
  matchesManifest(update, m = this.channel) {
    if (!m?.update || !update || update.unsupported) {
      return false;
    }
    let taboraVersion = "";
    try {
      taboraVersion = update.getProperty("taboraVersion");
    } catch (e) {
      return false;
    }
    if (taboraVersion !== m.version || update.buildID !== m.update.buildID || update.appVersion !== m.update.appVersion) {
      return false;
    }
    if (!update.patchCount) {
      return false;
    }
    for (let i = 0; i < update.patchCount; i++) {
      const patch = update.getPatchAt(i);
      let hash = "";
      try {
        hash = String(patch.getProperty("hashValue")).toLowerCase();
      } catch (e) {
        return false;
      }
      if (patch.type !== "complete" || patch.URL !== m.update.url || Number(patch.size) !== m.update.size || hash !== m.update.sha512) {
        return false;
      }
    }
    return true;
  },

  /** Фильтр для UpdateService: без проверенного манифеста и без версии Tabora выше
   * текущей обновлений нет; остаются только <update>, совпадающие с манифестом. */
  async filterUpdates(updates) {
    await this.fetchManifest({ maxAge: MANIFEST_CACHE_MS });
    const cur = this.currentVersion;
    const m = this.channel;
    if (!cur || !m?.update || compareVersions(m.version, cur) <= 0) {
      return [];
    }
    return updates.filter(u => this.matchesManifest(u, m));
  },

  /** Штатный обновлятор: проверка, скачивание (автоматически), подготовка к перезапуску. */
  runAppUpdater() {
    if (this.appUpdater && !lazy.AppUpdater.STATUS.isTerminalStatus(this.appUpdater.status) && this.appUpdater.status !== lazy.AppUpdater.STATUS.NEVER_CHECKED) {
      return Promise.resolve(); // уже идёт
    }
    if (!this.appUpdater) {
      this.appUpdater = new lazy.AppUpdater();
      this.appUpdater.addListener((status, ...args) => {
        this.status = status;
        if (status === lazy.AppUpdater.STATUS.DOWNLOADING && args.length >= 2) {
          this.progress = { done: args[0], total: args[1] };
        } else if (status !== lazy.AppUpdater.STATUS.DOWNLOADING) {
          this.progress = null;
        }
        if (status === lazy.AppUpdater.STATUS.DOWNLOAD_AND_INSTALL) {
          this.appUpdater.allowUpdateDownload(); // разрешения не спрашиваем: пользователь выбрал автообновления
        }
        this.notify("status");
      });
    }
    return this.appUpdater.check();
  },

  statusText() {
    const S = lazy.AppUpdater.STATUS;
    switch (this.status) {
      case S.CHECKING:
        return "Проверяем обновления…";
      case S.NO_UPDATES_FOUND:
        return this.available ? `Доступна версия ${this.channel.version}, но пакет для этой системы не найден` : "Установлена последняя версия";
      case S.DOWNLOADING: {
        const p = this.progress;
        if (p && p.total > 0) {
          const mb = n => (n / 1048576).toFixed(1).replace(".", ",");
          return `Скачиваем обновление: ${mb(p.done)} из ${mb(p.total)} МБ`;
        }
        return "Скачиваем обновление…";
      }
      case S.STAGING:
        return "Подготавливаем установку…";
      case S.READY_FOR_RESTART:
        return "Обновление готово, нужен перезапуск";
      case S.DOWNLOAD_FAILED:
        return "Не удалось скачать обновление, попробуем позже";
      case S.CHECKING_FAILED:
        return "Не удалось связаться с сервером обновлений";
      case S.UPDATE_DISABLED_BY_POLICY:
        return "Обновления отключены настройкой";
      case S.NO_UPDATER:
        return "В этой сборке нет обновлятора";
      case S.MANUAL_UPDATE:
        return "Эту версию нужно обновить вручную";
      case S.UNSUPPORTED_SYSTEM:
        return "Система больше не поддерживается";
      case S.INTERNAL_ERROR:
        return "Внутренняя ошибка обновлятора";
      case S.OTHER_INSTANCE_HANDLING_UPDATES:
        return "Обновление ставит другая копия браузера";
      default:
        if (this.stale) {
          return "Сведения об обновлениях устарели: манифест просрочен, проверьте сайт Tabora";
        }
        if (this.manifestError) {
          return `Манифест обновлений недоступен: ${this.manifestError}`;
        }
        return this.available ? `Доступна версия ${this.channel.version}` : "Установлена последняя версия";
    }
  },

  snooze(hours = 24) {
    Services.prefs.setStringPref(SNOOZE_PREF, String(Date.now() + hours * 3600 * 1000));
    this.notify();
  },

  restart() {
    Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit | Ci.nsIAppStartup.eRestart);
  },
};
