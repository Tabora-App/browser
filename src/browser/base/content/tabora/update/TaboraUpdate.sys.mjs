/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Обновления Tabora. Скачивание и установка — штатный обновлятор движка (подписанные
 * MAR-пакеты, проверка подписи нашим сертификатом, установка при перезапуске).
 * Поверх него — манифест канала channel.json на GitHub:
 *   { "release": { "version": "0.2.0", "minimum": "0.1.5", "notes": "…", "notesUrl": "…", "published": "2026-11-20" } }
 * Если текущая версия Tabora ниже minimum, обновление обязательное: интерфейс блокируется
 * до установки. Иначе — плашка «Доступна версия». Проверка при запуске и раз в час. */

const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");
const { setTimeout, clearTimeout, setInterval } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AppUpdater: "resource://gre/modules/AppUpdater.sys.mjs",
  UpdateUtils: "resource://gre/modules/UpdateUtils.sys.mjs",
});

const CHANNEL_URL_PREF = "tabora.update.channelUrl";
const SNOOZE_PREF = "tabora.update.snoozedUntil";
const LAST_CHECK_PREF = "tabora.update.lastCheck";
const CHECK_INTERVAL = 60 * 60 * 1000;

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

export const TaboraUpdate = {
  TOPIC: "tabora-update-changed",
  channel: null, // запись канала из channel.json
  manifestError: null,
  appUpdater: null,
  status: null, // AppUpdater.STATUS.*
  progress: null, // { done, total }
  _timer: null,
  _started: false,

  get currentVersion() {
    return Services.prefs.getStringPref("tabora.version", "") || AppConstants.MOZ_APP_VERSION_DISPLAY;
  },

  get channelName() {
    return lazy.UpdateUtils.UpdateChannel || "release";
  },

  /** Есть ли версия новее текущей по манифесту. */
  get available() {
    return !!this.channel?.version && compareVersions(this.channel.version, this.currentVersion) > 0;
  },

  /** Обязательное: текущая версия ниже минимально допустимой. */
  get mandatory() {
    return !!this.channel?.minimum && compareVersions(this.currentVersion, this.channel.minimum) < 0;
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

  /** Полная проверка: манифест канала, затем штатный обновлятор. */
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

  async fetchManifest() {
    const url = Services.prefs.getStringPref(CHANNEL_URL_PREF, "");
    if (!url) {
      this.manifestError = "адрес канала не задан";
      return null;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`, { cache: "no-store", credentials: "omit", redirect: "follow", signal: ctrl.signal });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json = await res.json();
      const entry = json?.[this.channelName] || json?.release || null;
      if (!entry || typeof entry.version !== "string") {
        throw new Error("в манифесте нет записи канала");
      }
      this.channel = {
        version: entry.version,
        minimum: typeof entry.minimum === "string" ? entry.minimum : null,
        notes: String(entry.notes || "").slice(0, 2000),
        notesUrl: /^https:\/\//.test(entry.notesUrl || "") ? entry.notesUrl : null,
        published: entry.published || null,
      };
      this.manifestError = null;
    } catch (e) {
      this.manifestError = e.message || String(e);
    } finally {
      clearTimeout(timer);
    }
    return this.channel;
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
        return "Установлена последняя версия";
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
        return this.manifestError ? `Манифест канала недоступен: ${this.manifestError}` : this.available ? `Доступна версия ${this.channel.version}` : "Установлена последняя версия";
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
