/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Аккаунт Tabora: вход по адресу почты Tabora и одному паролю, который одновременно
 * является мастер-паролем сейфа. Из пароля на устройстве выводятся два независимых
 * значения: ключ сейфа (обёртка pw в tabora-vault.json, никуда не уходит) и хеш входа
 * (Argon2id от пароля с солью из адреса, затем HMAC), который отправляется на сервер.
 * Сервер по хешу входа ключ сейфа восстановить не может.
 *
 * Бэкенд подменяемый: пока сервер не задан (pref tabora.account.server пуст), работает
 * локальный режим — аккаунт хранится на этом компьютере в tabora-account-local.json,
 * все окна и проверки настоящие. Контракт HTTP-бэкенда описан в HttpBackend. */

const C = ChromeUtils.importESModule("chrome://browser/content/tabora/wallet/vendor/crypto.sys.mjs");
const { argon2id, randomBytes, base64, utf8ToBytes, bytesToHex, hmac, sha256 } = C;
const { Vault } = ChromeUtils.importESModule("chrome://browser/content/tabora/vault/Vault.sys.mjs");

const FILE = () => PathUtils.join(PathUtils.profileDir, "tabora-account.json");
const LOCAL_FILE = () => PathUtils.join(PathUtils.profileDir, "tabora-account-local.json");
const DOMAIN_PREF = "tabora.account.domain";
const SERVER_PREF = "tabora.account.server";
const FIRSTRUN_PREF = "tabora.account.firstRunDone";
const MIN_PASSWORD = 6;
// Argon2id для хеша входа легче, чем у сейфа: сервер хеширует ещё раз, а главный барьер — обёртка сейфа
const AUTH_KDF = { t: 2, m: 16384, p: 1, dkLen: 32 };

const COMMON = new Set(["password1234", "passwordpassword", "123456789012", "qwertyuiop12", "qwertyuiopas", "1234567890ab", "administrator", "iloveyou1234", "welcome12345", "letmein12345", "sunshine1234", "princess1234", "football1234", "baseball1234", "superman1234", "trustno1trustno1", "passw0rdpassw0rd", "qwerty123456", "1q2w3e4r5t6y", "zaq12wsxcde3", "abcdefghijkl", "aaaaaaaaaaaa", "123123123123", "111111111111", "000000000000"]);

function wipe(a) {
  if (a && a.fill) {
    a.fill(0);
  }
}

/** Оценка стойкости 0..4 и причина: без тяжёлых библиотек, но ловит худшее. */
export function passwordStrength(password) {
  const p = String(password || "");
  if (!p) {
    return { score: 0, label: "введите пароль" };
  }
  if (p.length < MIN_PASSWORD) {
    return { score: 0, label: `не короче ${MIN_PASSWORD} символов` };
  }
  const lower = p.toLowerCase();
  if (COMMON.has(lower) || /^(.)\1+$/.test(p)) {
    return { score: 0, label: "слишком распространённый" };
  }
  if (/^(?:0123|1234|2345|3456|4567|5678|6789|abcd|bcde|qwer|wert|erty|asdf|sdfg|zxcv)/i.test(p) && /^[a-z0-9]+$/i.test(p) && p.length < 12) {
    return { score: 1, label: "похож на последовательность" };
  }
  const classes = [/[a-zа-яё]/.test(p), /[A-ZА-ЯЁ]/.test(p), /\d/.test(p), /[^\p{L}\p{N}]/u.test(p)].filter(Boolean).length;
  const unique = new Set(p).size;
  let score = 1;
  if (p.length >= 10 && classes >= 2 && unique >= 6) {
    score = 2;
  }
  if (p.length >= 12 && classes >= 3 && unique >= 8) {
    score = 3;
  }
  if ((p.length >= 16 && classes >= 3) || (p.length >= 20 && unique >= 10)) {
    score = 4;
  }
  return { score, label: ["слабый", "слабый", "средний", "хороший", "отличный"][score] };
}

export function checkPassword(password) {
  const s = passwordStrength(password);
  if (s.score === 0) {
    throw new Error(`Пароль: ${s.label}`);
  }
  return s;
}

/* ---------- бэкенды ---------- */

/** Локальный режим: без сервера. Хранит только хеш от хеша входа с солью. */
class LocalBackend {
  get name() {
    return "local";
  }

  async _load() {
    try {
      const d = await IOUtils.readJSON(LOCAL_FILE());
      return d && d.version === 1 ? d : { version: 1, users: {} };
    } catch (e) {
      return { version: 1, users: {} };
    }
  }

  async _save(d) {
    await IOUtils.writeJSON(LOCAL_FILE(), d, { tmpPath: LOCAL_FILE() + ".tmp" });
    try {
      await IOUtils.setPermissions(LOCAL_FILE(), 0o600);
    } catch (e) {}
  }

  _verifier(loginHash, salt) {
    return bytesToHex(hmac(sha256, base64.decode(salt), utf8ToBytes(loginHash)));
  }

  async checkName(email) {
    const d = await this._load();
    return !d.users[email];
  }

  async register({ email, loginHash, deviceId, deviceName }) {
    const d = await this._load();
    if (d.users[email]) {
      throw new Error("Такой адрес уже занят");
    }
    const salt = base64.encode(randomBytes(16));
    const userId = `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    d.users[email] = { userId, salt, verifier: this._verifier(loginHash, salt), createdAt: new Date().toISOString(), devices: { [deviceId]: { name: deviceName, at: Date.now() } } };
    await this._save(d);
    return { userId, session: { token: `local-${userId}`, expiresAt: null } };
  }

  async login({ email, loginHash, deviceId, deviceName }) {
    const d = await this._load();
    const u = d.users[email];
    if (!u || u.verifier !== this._verifier(loginHash, u.salt)) {
      throw Object.assign(new Error("Неверный адрес или пароль"), { code: "bad-credentials" });
    }
    u.devices ||= {};
    u.devices[deviceId] = { name: deviceName, at: Date.now() };
    await this._save(d);
    return { userId: u.userId, session: { token: `local-${u.userId}`, expiresAt: null } };
  }

  async changePassword({ email, oldLoginHash, newLoginHash }) {
    const d = await this._load();
    const u = d.users[email];
    if (!u || u.verifier !== this._verifier(oldLoginHash, u.salt)) {
      throw Object.assign(new Error("Неверный текущий пароль"), { code: "bad-credentials" });
    }
    u.salt = base64.encode(randomBytes(16));
    u.verifier = this._verifier(newLoginHash, u.salt);
    await this._save(d);
    return true;
  }

  /** Сброс пароля после входа по ключу восстановления сейфа: ключ доказывает владение данными. */
  async resetPassword({ email, newLoginHash }) {
    const d = await this._load();
    const u = d.users[email];
    if (!u) {
      throw new Error("Аккаунт не найден на этом компьютере");
    }
    u.salt = base64.encode(randomBytes(16));
    u.verifier = this._verifier(newLoginHash, u.salt);
    await this._save(d);
    return true;
  }

  async logout() {
    return true;
  }

  async devices({ email }) {
    const d = await this._load();
    return Object.entries(d.users[email]?.devices || {}).map(([id, v]) => ({ id, ...v }));
  }
}

/** Сервер Tabora: JSON по HTTPS. Контракт:
 *  POST /v1/account/register  { email, loginHash, deviceId, deviceName }      → { userId, session: { token, expiresAt } }
 *  POST /v1/account/login     { email, loginHash, deviceId, deviceName }      → { userId, session } | 409 { needsDeviceConfirm }
 *  POST /v1/account/password  { oldLoginHash, newLoginHash }  (Bearer token)  → {}
 *  POST /v1/account/reset     { email, recoveryProof, newLoginHash }          → {}
 *  POST /v1/account/logout    (Bearer token)                                  → {}
 *  GET  /v1/account/devices   (Bearer token)                                  → [{ id, name, at }]
 *  GET  /v1/account/available?email=…                                          → { available }
 * Сервер хранит только хеш от loginHash со своей солью и никогда не видит пароль и ключ сейфа. */
class HttpBackend {
  constructor(base) {
    this.base = base.replace(/\/+$/, "");
  }

  get name() {
    return "http";
  }

  async _call(method, path, body, token) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(this.base + path, {
        method,
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        credentials: "omit",
        redirect: "error",
        signal: ctrl.signal,
      });
      const text = await res.text();
      const json = text ? JSON.parse(text) : {};
      if (!res.ok) {
        throw Object.assign(new Error(json.message || `Сервер: HTTP ${res.status}`), { code: json.code || `http-${res.status}`, status: res.status });
      }
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  async checkName(email) {
    return (await this._call("GET", `/v1/account/available?email=${encodeURIComponent(email)}`)).available !== false;
  }

  register(data) {
    return this._call("POST", "/v1/account/register", data);
  }

  login(data) {
    return this._call("POST", "/v1/account/login", data);
  }

  changePassword({ session, oldLoginHash, newLoginHash }) {
    return this._call("POST", "/v1/account/password", { oldLoginHash, newLoginHash }, session?.token);
  }

  resetPassword({ email, recoveryProof, newLoginHash }) {
    return this._call("POST", "/v1/account/reset", { email, recoveryProof, newLoginHash });
  }

  logout({ session }) {
    return this._call("POST", "/v1/account/logout", {}, session?.token);
  }

  devices({ session }) {
    return this._call("GET", "/v1/account/devices", null, session?.token);
  }
}

const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

/* ---------- аккаунт ---------- */

export const Account = {
  TOPIC: "tabora-account-changed",
  MIN_PASSWORD,
  data: null,
  _loaded: false,
  _failures: 0,
  _lockedUntil: 0,

  get domain() {
    return Services.prefs.getStringPref(DOMAIN_PREF, "tabora.app");
  },

  get serverUrl() {
    return Services.prefs.getStringPref(SERVER_PREF, "");
  },

  get backend() {
    const url = this.serverUrl;
    if (!this._backend || this._backendUrl !== url) {
      this._backend = /^https:\/\//.test(url) ? new HttpBackend(url) : new LocalBackend();
      this._backendUrl = url;
    }
    return this._backend;
  },

  get isLocalMode() {
    return this.backend.name === "local";
  },

  async ready() {
    if (this._loaded) {
      return this.data;
    }
    try {
      this.data = await IOUtils.readJSON(FILE());
      if (!this.data || this.data.version !== 1) {
        this.data = null;
      }
    } catch (e) {
      this.data = null;
    }
    this._loaded = true;
    return this.data;
  },

  get signedIn() {
    return !!this.data?.session;
  },

  get email() {
    return this.data?.email || "";
  },

  get firstRunDone() {
    return Services.prefs.getBoolPref(FIRSTRUN_PREF, false);
  },

  markFirstRunDone() {
    Services.prefs.setBoolPref(FIRSTRUN_PREF, true);
  },

  notify(what = "changed") {
    Services.obs.notifyObservers(null, this.TOPIC, what);
  },

  async save() {
    if (!this.data) {
      await IOUtils.remove(FILE(), { ignoreAbsent: true });
    } else {
      this.data.updatedAt = new Date().toISOString();
      await IOUtils.writeJSON(FILE(), this.data, { tmpPath: FILE() + ".tmp" });
      try {
        await IOUtils.setPermissions(FILE(), 0o600);
      } catch (e) {}
    }
    this.notify();
  },

  deviceId() {
    let id = Services.prefs.getStringPref("tabora.account.deviceId", "");
    if (!id) {
      id = bytesToHex(randomBytes(12));
      Services.prefs.setStringPref("tabora.account.deviceId", id);
    }
    return id;
  },

  deviceName() {
    try {
      return Cc["@mozilla.org/network/dns-service;1"].getService(Ci.nsIDNSService).myHostName || "Mac";
    } catch (e) {
      return "Mac";
    }
  },

  /** Имя почты → полный адрес; принимает и полный адрес своего домена. */
  normalizeEmail(input) {
    let s = String(input || "").trim().toLowerCase();
    if (s.includes("@")) {
      const [name, dom] = s.split("@");
      if (dom !== this.domain) {
        throw new Error(`Адрес должен быть в домене ${this.domain}`);
      }
      s = name;
    }
    if (!/^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])?$/.test(s) || /[._-]{2}/.test(s)) {
      throw new Error("Имя: 2–32 символа, латиница, цифры, точка, дефис или подчёркивание");
    }
    return `${s}@${this.domain}`;
  },

  /** Хеш входа: Argon2id(пароль, соль из адреса) → HMAC. Независим от ключа сейфа. */
  async loginHash(email, password) {
    const salt = sha256(utf8ToBytes(`tabora-auth|${email}`)).slice(0, 16);
    const k = argon2id(utf8ToBytes(String(password).normalize("NFKC")), salt, AUTH_KDF);
    try {
      return bytesToHex(hmac(sha256, k, utf8ToBytes("login")));
    } finally {
      wipe(k);
    }
  },

  _checkLockout() {
    if (Date.now() < this._lockedUntil) {
      throw new Error(`Слишком много попыток: подождите ${Math.ceil((this._lockedUntil - Date.now()) / 1000)} с`);
    }
  },

  _onFailure() {
    this._failures++;
    if (this._failures >= 3) {
      this._lockedUntil = Date.now() + Math.min(60000, 2 ** (this._failures - 3) * 5000);
    }
  },

  /** Сейф принимает пароль аккаунта как мастер-пароль: задаёт его, если не задан, иначе сверяет. */
  async _syncVaultPassword(password) {
    await Vault.ready();
    if (!Vault.exists) {
      await Vault.create({ password });
      return;
    }
    if (Vault.hasPassword) {
      await Vault.verifyPassword(password).catch(() => {
        throw new Error("Пароль аккаунта должен совпадать с мастер-паролем сейфа этого компьютера");
      });
      if (!Vault.unlocked) {
        await Vault.unlockWithPassword(password);
      }
      return;
    }
    if (!Vault.unlocked) {
      await Vault.unlock();
    }
    if (!Vault.unlocked) {
      throw new Error("Сейф заблокирован: разблокируйте его и повторите");
    }
    await Vault.setPassword(password);
  },

  async checkName(input) {
    const email = this.normalizeEmail(input);
    const free = await this.backend.checkName(email);
    return { email, free };
  },

  async register(nameInput, password) {
    await this.ready();
    if (this.signedIn) {
      throw new Error("Вы уже вошли в аккаунт");
    }
    const email = this.normalizeEmail(nameInput);
    checkPassword(password);
    await Vault.ready();
    if (Vault.exists && Vault.hasPassword) {
      await Vault.verifyPassword(password).catch(() => {
        throw new Error("Пароль аккаунта должен совпадать с мастер-паролем сейфа этого компьютера");
      });
    }
    const loginHash = await this.loginHash(email, password);
    const r = await this.backend.register({ email, loginHash, deviceId: this.deviceId(), deviceName: this.deviceName() });
    await this._syncVaultPassword(password);
    this.data = { version: 1, email, userId: r.userId, session: r.session, server: this.serverUrl || null, createdAt: new Date().toISOString(), lastLoginAt: new Date().toISOString() };
    await this.save();
    this.markFirstRunDone();
    return { email };
  },

  async login(emailInput, password) {
    await this.ready();
    this._checkLockout();
    const email = this.normalizeEmail(emailInput);
    if (!password) {
      throw new Error("Введите пароль");
    }
    const loginHash = await this.loginHash(email, password);
    let r;
    try {
      r = await this.backend.login({ email, loginHash, deviceId: this.deviceId(), deviceName: this.deviceName() });
    } catch (e) {
      if (e.code === "bad-credentials") {
        this._onFailure();
      }
      throw e;
    }
    this._failures = 0;
    await this._syncVaultPassword(password);
    this.data = { version: 1, email, userId: r.userId, session: r.session, server: this.serverUrl || null, createdAt: this.data?.createdAt || new Date().toISOString(), lastLoginAt: new Date().toISOString() };
    await this.save();
    this.markFirstRunDone();
    return { email };
  },

  async changePassword(oldPassword, newPassword) {
    await this.ready();
    if (!this.signedIn) {
      throw new Error("Вы не вошли в аккаунт");
    }
    checkPassword(newPassword);
    if (oldPassword === newPassword) {
      throw new Error("Новый пароль совпадает с текущим");
    }
    await Vault.ready();
    if (Vault.hasPassword) {
      await Vault.verifyPassword(oldPassword).catch(() => {
        throw new Error("Неверный текущий пароль");
      });
    }
    const [oldLoginHash, newLoginHash] = await Promise.all([this.loginHash(this.email, oldPassword), this.loginHash(this.email, newPassword)]);
    await this.backend.changePassword({ session: this.data.session, email: this.email, oldLoginHash, newLoginHash });
    if (Vault.hasPassword) {
      if (!Vault.unlocked) {
        await Vault.unlockWithPassword(oldPassword);
      }
      await Vault.changePassword(oldPassword, newPassword);
    } else {
      await this._syncVaultPassword(newPassword);
    }
    this.data.passwordChangedAt = new Date().toISOString();
    await this.save();
    return true;
  },

  /** Забытый пароль: сейф открыт ключом восстановления, задаём новый пароль и аккаунту, и сейфу. */
  async resetPasswordWithRecovery(recoveryKey, newPassword) {
    await this.ready();
    if (!this.email) {
      throw new Error("На этом компьютере нет аккаунта");
    }
    checkPassword(newPassword);
    await Vault.ready();
    await Vault.unlockWithRecoveryKey(recoveryKey);
    const newLoginHash = await this.loginHash(this.email, newPassword);
    await this.backend.resetPassword({ email: this.email, recoveryProof: null, newLoginHash });
    await Vault.setPassword(newPassword);
    this.data.passwordChangedAt = new Date().toISOString();
    await this.save();
    return true;
  },

  async logout() {
    await this.ready();
    if (!this.data) {
      return;
    }
    try {
      await this.backend.logout({ session: this.data.session });
    } catch (e) {}
    this.data.session = null;
    await this.save();
  },

  async devices() {
    await this.ready();
    if (!this.data) {
      return [];
    }
    return this.backend.devices({ email: this.email, session: this.data.session });
  },
};
