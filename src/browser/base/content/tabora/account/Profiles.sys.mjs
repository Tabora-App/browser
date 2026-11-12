import { tt } from "chrome://tabora/content/i18n/I18n.sys.mjs";
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Аккаунты на этом компьютере. У каждого аккаунта Tabora свой профиль браузера: свои вкладки,
 * история, куки, сейф, кошелёк и почта. Между профилями ничего не передаётся: второй аккаунт —
 * это второй каталог профиля и второй экземпляр браузера.
 *
 * Профили одной группы лежат рядом, в одном каталоге (root — родитель текущего профиля):
 *   root/tabora-profiles.json       список участников: { version, profiles: [{ dir, addedAt }] }
 *   root/<dir>/tabora-profile.json  карточка профиля: адрес аккаунта, цвет, выполнен ли вход
 * Карточку пишет только экземпляр, работающий с этим профилем (и тот, кто профиль создаёт),
 * список меняется лишь при добавлении и удалении аккаунта: общий файл не становится местом
 * гонок между экземплярами. Профиль, которого в списке нет, чужих карточек не читает.
 * Имя каталога из списка — одно звено пути внутри root; всё прочитанное из чужих карточек
 * считается недоверенным текстом.
 *
 * Запуск и переключение — средствами движка: второй экземпляр приложения с --profile, уже
 * запущенный поднимается службой удалённых команд (её ключ — путь профиля). Служба профилей
 * Firefox (browser.profiles.enabled) выключена и здесь не используется. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Account: "chrome://tabora/content/account/Account.sys.mjs",
  AppConstants: "resource://gre/modules/AppConstants.sys.mjs",
});

const REGISTRY = "tabora-profiles.json";
const CARD = "tabora-profile.json";
const AVATAR_PREF = "tabora.account.avatarColor";
const ACCOUNT_TOPIC = "tabora-account-changed";
const STEPS = ["welcome", "register", "login"];
const NAME_RE = /^[a-z0-9._-]{0,32}$/;
const EMAIL_RE = /^[a-z0-9._-]{1,64}@[a-z0-9.-]{1,80}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
// флаг движка: уже запущенный экземпляр поднимает своё окно и не открывает новое
const ACTIVATE_FLAG = "--profiles-activate";

// Настройки окружения, которые новый профиль получает от текущего, если их задал пользователь:
// сервер аккаунтов, язык, тема и доступ дочерних процессов к исходникам в сборке разработчика.
// Данные аккаунта и ключи сюда не входят.
const INHERIT_PREFS = [
  "tabora.account.server",
  "tabora.account.domain",
  "intl.locale.requested",
  "layout.css.prefers-color-scheme.content-override",
  "security.sandbox.content.mac.testing_read_path1",
  "security.sandbox.content.mac.testing_read_path2",
  "security.sandbox.content.mac.testing_read_path3",
  "security.sandbox.content.mac.testing_read_path4",
];

function fail(text, code) {
  return Object.assign(new Error(text), { code });
}

function notFound(e) {
  return DOMException.isInstance(e) && e.name === "NotFoundError";
}

function cleanPending(p) {
  if (!p || typeof p !== "object" || !STEPS.includes(p.step)) {
    return null;
  }
  const name = typeof p.name === "string" && NAME_RE.test(p.name) ? p.name : "";
  return { step: p.step, name };
}

function cleanCard(c) {
  if (!c || typeof c !== "object" || c.version !== 1) {
    return null;
  }
  return {
    version: 1,
    email: typeof c.email === "string" && EMAIL_RE.test(c.email) ? c.email : null,
    color: typeof c.color === "string" && COLOR_RE.test(c.color) ? c.color.toLowerCase() : null,
    signedIn: c.signedIn === true,
    createdAt: typeof c.createdAt === "string" ? c.createdAt.slice(0, 40) : null,
    pending: cleanPending(c.pending),
  };
}

function prefLine(name) {
  const type = Services.prefs.getPrefType(name);
  let value;
  if (type === Services.prefs.PREF_STRING) {
    value = JSON.stringify(Services.prefs.getStringPref(name));
  } else if (type === Services.prefs.PREF_INT) {
    value = String(Services.prefs.getIntPref(name));
  } else if (type === Services.prefs.PREF_BOOL) {
    value = String(Services.prefs.getBoolPref(name));
  } else {
    return null;
  }
  return `user_pref(${JSON.stringify(name)}, ${value});`;
}

export const Profiles = {
  TOPIC: "tabora-profiles-changed",
  _queue: Promise.resolve(),
  _started: false,
  _launching: new Map(), // каталог → когда запросили запуск: пока экземпляр поднимается, второй не нужен

  /** Имя каталога текущего профиля. */
  get dir() {
    return PathUtils.filename(PathUtils.profileDir);
  },

  /** Каталог, в котором лежат профили группы. */
  get root() {
    return PathUtils.parent(PathUtils.profileDir);
  },

  notify() {
    Services.obs.notifyObservers(null, this.TOPIC);
  },

  /** Путь профиля по имени каталога; имя должно быть одним звеном пути внутри root. */
  _path(dir) {
    if (typeof dir !== "string" || !dir || dir.length > 255 || dir === "." || dir === ".." || /[/\\\0]/.test(dir)) {
      throw fail(tt`Недопустимое имя профиля`, "bad-dir");
    }
    const path = PathUtils.join(this.root, dir);
    if (PathUtils.parent(path) !== this.root || PathUtils.filename(path) !== dir) {
      throw fail(tt`Недопустимое имя профиля`, "bad-dir");
    }
    return path;
  },

  _valid(dir) {
    try {
      this._path(dir);
      return true;
    } catch (e) {
      return false;
    }
  },

  /** Операции со списком в пределах одного экземпляра идут по очереди. */
  _serial(fn) {
    const p = this._queue.then(fn, fn);
    this._queue = p.catch(() => {});
    return p;
  },

  async _registry() {
    try {
      const d = await IOUtils.readJSON(PathUtils.join(this.root, REGISTRY));
      if (d?.version === 1 && Array.isArray(d.profiles)) {
        const seen = new Set();
        const profiles = [];
        for (const p of d.profiles.slice(0, 64)) {
          if (p && this._valid(p.dir) && !seen.has(p.dir)) {
            seen.add(p.dir);
            profiles.push({ dir: p.dir, addedAt: typeof p.addedAt === "string" ? p.addedAt.slice(0, 40) : null });
          }
        }
        return { version: 1, profiles };
      }
    } catch (e) {
      if (!notFound(e)) {
        console.error("Tabora profiles: список аккаунтов не читается", e);
      }
    }
    return { version: 1, profiles: [] };
  },

  async _writeRegistry(reg) {
    const file = PathUtils.join(this.root, REGISTRY);
    await IOUtils.writeJSON(file, reg, { tmpPath: `${file}.tmp`, flush: true });
    await IOUtils.setPermissions(file, 0o600).catch(() => {});
  },

  async _card(dir) {
    try {
      return cleanCard(await IOUtils.readJSON(PathUtils.join(this._path(dir), CARD)));
    } catch (e) {
      return null;
    }
  },

  async _writeCard(dir, card) {
    const file = PathUtils.join(this._path(dir), CARD);
    await IOUtils.writeJSON(file, card, { tmpPath: `${file}.tmp`, flush: true });
    await IOUtils.setPermissions(file, 0o600).catch(() => {});
  },

  async _isDir(path) {
    try {
      return (await IOUtils.stat(path)).type === "directory";
    } catch (e) {
      return false;
    }
  },

  async _isMember() {
    return (await this._registry()).profiles.some(p => p.dir === this.dir);
  },

  _color() {
    const c = Services.prefs.getStringPref(AVATAR_PREF, "");
    return COLOR_RE.test(c) ? c.toLowerCase() : null;
  },

  /** Следить за аккаунтом этого профиля и держать его карточку свежей. Вызывается при запуске. */
  start() {
    if (this._started) {
      return;
    }
    this._started = true;
    const sync = () => this.syncCard().catch(e => console.error("Tabora profiles: карточка профиля не записана", e));
    Services.obs.addObserver(sync, ACCOUNT_TOPIC);
    Services.prefs.addObserver(AVATAR_PREF, sync);
    sync();
  },

  /** Карточка текущего профиля: что видят о нём остальные аккаунты этого компьютера. Профиль
   * вне списка карточку не ведёт. Отметка pending живёт, пока в новом профиле не решили, что
   * делать с аккаунтом (создали, вошли или отказались). */
  syncCard() {
    return this._serial(async () => {
      if (!(await this._isMember())) {
        return;
      }
      await lazy.Account.ready();
      const prior = await this._card(this.dir);
      const email = lazy.Account.email || null;
      const card = {
        version: 1,
        email,
        color: this._color(),
        signedIn: lazy.Account.signedIn,
        createdAt: prior?.createdAt || new Date().toISOString(),
        pending: !email && !lazy.Account.firstRunDone ? prior?.pending || null : null,
      };
      if (prior && JSON.stringify(prior) === JSON.stringify(card)) {
        return;
      }
      await this._writeCard(this.dir, card);
      this.notify();
    });
  },

  /** С чего начать в только что добавленном профиле: { step, name } или null. */
  async pending() {
    return (await this._isMember()) ? (await this._card(this.dir))?.pending || null : null;
  },

  /** Аккаунты этого компьютера, текущий первым: [{ dir, current, email, color, signedIn, fresh }].
   * fresh — профиль добавлен, но аккаунт в нём ещё не создан. */
  async list() {
    const reg = await this._registry();
    const member = reg.profiles.some(p => p.dir === this.dir);
    await lazy.Account.ready();
    const out = [{ dir: this.dir, current: true, email: lazy.Account.email, color: this._color() || "", signedIn: lazy.Account.signedIn, fresh: false }];
    if (!member) {
      return out;
    }
    for (const { dir } of reg.profiles) {
      if (dir === this.dir) {
        continue;
      }
      if (!(await this._isDir(this._path(dir)))) {
        continue; // каталог удалили мимо браузера
      }
      const card = await this._card(dir);
      out.push({ dir, current: false, email: card?.email || "", color: card?.color || "", signedIn: !!card?.signedIn, fresh: !!card && !card.email && !!card.pending });
    }
    return out;
  },

  /** Новый профиль для ещё одного аккаунта. Если прошлое добавление не довели до конца, его
   * профиль используется снова. Возвращает имя каталога. */
  create({ step = "welcome", name = "" } = {}) {
    return this._serial(async () => {
      const pending = cleanPending({ step, name: String(name || "").toLowerCase() }) || { step: "welcome", name: "" };
      const reg = await this._registry();
      const now = new Date().toISOString();
      for (const p of reg.profiles) {
        if (p.dir === this.dir) {
          continue;
        }
        const card = await this._card(p.dir);
        if (card && !card.email && card.pending) {
          await this._writeCard(p.dir, { ...card, pending });
          return p.dir;
        }
      }
      let dir = "";
      for (let i = 0; i < 8 && !dir; i++) {
        const salt = Array.from(crypto.getRandomValues(new Uint8Array(8)), b => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
        if (!(await IOUtils.exists(this._path(`${salt}.account`)))) {
          dir = `${salt}.account`;
        }
      }
      if (!dir) {
        throw fail(tt`Не удалось выбрать каталог для нового профиля`, "no-dir");
      }
      const path = this._path(dir);
      await IOUtils.makeDirectory(path, { permissions: 0o700, ignoreExisting: false });
      try {
        await this._writeCard(dir, { version: 1, email: null, color: null, signedIn: false, createdAt: now, pending });
        const lines = INHERIT_PREFS.filter(n => Services.prefs.prefHasUserValue(n)).map(prefLine).filter(Boolean);
        if (lines.length) {
          const prefs = PathUtils.join(path, "prefs.js");
          await IOUtils.writeUTF8(prefs, `${lines.join("\n")}\n`);
          await IOUtils.setPermissions(prefs, 0o600).catch(() => {});
        }
        // каталоги, удалённые мимо браузера, из списка выпадают
        const alive = [];
        for (const p of reg.profiles) {
          if (p.dir !== this.dir && (await this._isDir(this._path(p.dir)))) {
            alive.push(p);
          }
        }
        const own = reg.profiles.find(p => p.dir === this.dir) || { dir: this.dir, addedAt: now };
        reg.profiles = [own, ...alive, { dir, addedAt: now }];
        await this._writeRegistry(reg);
      } catch (e) {
        await IOUtils.remove(path, { recursive: true, ignoreAbsent: true }).catch(() => {});
        throw e;
      }
      this.syncCard().catch(e => console.error("Tabora profiles: карточка профиля не записана", e));
      this.notify();
      return dir;
    });
  },

  _remote() {
    return Cc["@mozilla.org/remote;1"].getService(Ci.nsIRemoteService);
  },

  _exec(args) {
    const exe = Services.dirsvc.get("XREExeF", Ci.nsIFile);
    if (lazy.AppConstants.platform === "macosx") {
      const bundle = exe.parent.parent.parent;
      if (bundle.path.endsWith(".app")) {
        Cc["@mozilla.org/widget/macdocksupport;1"].getService(Ci.nsIMacDockSupport).launchAppBundle(bundle, ["-foreground", ...args], { addsToRecentItems: false });
        return;
      }
    }
    const process = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
    process.init(exe);
    process.runw(false, args, args.length);
  },

  /** Открыть окно аккаунта: поднять уже запущенный экземпляр или запустить новый.
   * Возвращает "current" | "activated" | "launched" | "launching" (запуск уже запрошен). */
  async open(dir) {
    const path = this._path(dir);
    if (dir === this.dir) {
      return "current";
    }
    const reg = await this._registry();
    if (!reg.profiles.some(p => p.dir === dir) || !reg.profiles.some(p => p.dir === this.dir)) {
      throw fail(tt`Этого аккаунта нет в списке компьютера`, "unknown");
    }
    if (!(await this._isDir(path))) {
      throw fail(tt`Профиль этого аккаунта удалён с компьютера`, "missing");
    }
    try {
      this._remote().sendCommandLine(path, [ACTIVATE_FLAG], true);
      this._launching.delete(dir);
      return "activated";
    } catch (e) {
      // экземпляра с этим профилем нет: запускаем
    }
    if (Date.now() - (this._launching.get(dir) || 0) < 15000) {
      return "launching";
    }
    this._launching.set(dir, Date.now());
    this._exec(["--profile", path]);
    return "launched";
  },

  /** Удалить с компьютера профиль другого аккаунта вместе со всеми его данными. Работающий
   * профиль не удаляется: его каталог заперт своим экземпляром. */
  remove(dir) {
    return this._serial(async () => {
      const path = this._path(dir);
      if (dir === this.dir) {
        throw fail(tt`Профиль, в котором вы работаете, удаляется из окна другого аккаунта`, "current");
      }
      const reg = await this._registry();
      if (!reg.profiles.some(p => p.dir === dir) || !reg.profiles.some(p => p.dir === this.dir)) {
        throw fail(tt`Этого аккаунта нет в списке компьютера`, "unknown");
      }
      const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      file.initWithPath(path);
      if (file.exists()) {
        if (file.isSymlink() || !file.isDirectory() || !(await IOUtils.exists(PathUtils.join(path, CARD)))) {
          throw fail(tt`Каталог не похож на профиль Tabora: удалите его вручную`, "not-profile");
        }
        try {
          await Cc["@mozilla.org/toolkit/profile-service;1"].getService(Ci.nsIToolkitProfileService).removeProfileFilesByPath(file, null, 0);
        } catch (e) {
          throw fail(tt`Этот аккаунт сейчас открыт в другом окне. Закройте его окно и повторите`, "in-use");
        }
        await IOUtils.remove(path, { recursive: true, ignoreAbsent: true }).catch(() => {});
      }
      reg.profiles = reg.profiles.filter(p => p.dir !== dir);
      await this._writeRegistry(reg);
      this.notify();
    });
  },
};
