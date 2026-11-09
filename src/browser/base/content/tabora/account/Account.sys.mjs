/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Аккаунт Tabora: вход по адресу почты Tabora и одному паролю, который одновременно
 * является мастер-паролем сейфа. Из пароля на устройстве выводятся два независимых
 * значения: ключ сейфа (обёртка pw в tabora-vault.json, никуда не уходит) и хеш входа
 * (Argon2id 64 МБ, 3 прохода — не слабее KDF сейфа — с солью из адреса, затем HMAC),
 * который отправляется на сервер. Сервер по хешу входа ключ сейфа восстановить не может.
 *
 * Сброс забытого пароля требует доказательства владения ключом восстановления: при
 * создании ключа на сервере регистрируется производный от него ключ проверки, а запрос
 * сброса подписывается HMAC(ключ проверки, email|newLoginHash|nonce) с одноразовым nonce.
 *
 * Бэкенд подменяемый: пока сервер не задан (pref tabora.account.server пуст), работает
 * локальный режим — аккаунт хранится на этом компьютере в tabora-account-local.json,
 * все окна и проверки настоящие. Контракт HTTP-бэкенда описан в HttpBackend. */

const C = ChromeUtils.importESModule("chrome://tabora/content/wallet/vendor/crypto.sys.mjs");
const { randomBytes, base64, utf8ToBytes, bytesToHex, hexToBytes, hmac, sha256 } = C;
const { Vault, passwordStrength, checkNewPassword } = ChromeUtils.importESModule("chrome://tabora/content/vault/Vault.sys.mjs");
const { argon2idAsync } = ChromeUtils.importESModule("chrome://tabora/content/vault/Kdf.sys.mjs");
const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

const FILE = () => PathUtils.join(PathUtils.profileDir, "tabora-account.json");
const LOCAL_FILE = () => PathUtils.join(PathUtils.profileDir, "tabora-account-local.json");
const DOMAIN_PREF = "tabora.account.domain";
const SERVER_PREF = "tabora.account.server";
const FIRSTRUN_PREF = "tabora.account.firstRunDone";
const MIN_PASSWORD = Vault.MIN_PASSWORD;
// Хеш входа: версия 2 не слабее KDF сейфа (64 МБ, 3 прохода), иначе перебор по хешу с
// сервера был бы дешевле перебора по файлу сейфа. Версия 1 (16 МБ, 2 прохода) — только
// для входа в аккаунты, созданные раньше: после первого успешного входа хеш заменяется.
const AUTH_KDF = { 1: { t: 2, m: 16384, p: 1, dkLen: 32 }, 2: { t: 3, m: 65536, p: 1, dkLen: 32 } };
const AUTH_SALT = { 1: "tabora-auth|", 2: "tabora-auth-v2|" };
const KDF_CURRENT = 2;
const RESET_NONCE_TTL = 5 * 60000;

export { passwordStrength };

/** Пароль аккаунта: не короче 6 символов и не «слабый» (оценка показывается в окнах). */
export function checkPassword(password) {
  return checkNewPassword(password);
}

function wipe(a) {
  if (a && a.fill) {
    a.fill(0);
  }
}

function sameHex(a, b) {
  a = String(a || "");
  b = String(b || "");
  if (a.length !== b.length || !a.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Подпись запроса сброса: доказывает владение ключом восстановления, не раскрывая его. */
function resetProof(authKey, email, newLoginHash, nonce) {
  return bytesToHex(hmac(sha256, authKey, utf8ToBytes(`${email}|${newLoginHash}|${nonce}`)));
}

/* ---------- бэкенды ---------- */

/** Локальный режим: без сервера. Хранит только хеш от хеша входа с солью и ключ проверки
 * ключа восстановления; проверки те же, что обязан делать сервер. */
class LocalBackend {
  get name() {
    return "local";
  }

  async _load() {
    try {
      const d = await IOUtils.readJSON(LOCAL_FILE());
      return d && d.version === 1 && d.users && typeof d.users === "object" ? d : { version: 1, users: {} };
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

  _check(u, loginHash) {
    return !!u && sameHex(u.verifier, this._verifier(loginHash, u.salt));
  }

  async checkName(email) {
    const d = await this._load();
    return !d.users[email];
  }

  /** Какой версией KDF считать хеш входа для этого адреса. */
  async prelogin({ email }) {
    const d = await this._load();
    return { kdf: d.users[email]?.kdf || (d.users[email] ? 1 : KDF_CURRENT) };
  }

  async register({ email, loginHash, kdf, deviceId, deviceName }) {
    const d = await this._load();
    if (d.users[email]) {
      throw new Error("Такой адрес уже занят");
    }
    const salt = base64.encode(randomBytes(16));
    const userId = `u${Date.now().toString(36)}${bytesToHex(randomBytes(4))}`;
    d.users[email] = { userId, salt, verifier: this._verifier(loginHash, salt), kdf, createdAt: new Date().toISOString(), devices: { [deviceId]: { name: deviceName, at: Date.now() } } };
    await this._save(d);
    return { userId, session: { token: `local-${userId}`, expiresAt: null } };
  }

  async login({ email, loginHash, deviceId, deviceName }) {
    const d = await this._load();
    const u = d.users[email];
    if (!this._check(u, loginHash)) {
      throw Object.assign(new Error("Неверный адрес или пароль"), { code: "bad-credentials" });
    }
    u.devices ||= {};
    u.devices[deviceId] = { name: deviceName, at: Date.now() };
    await this._save(d);
    return { userId: u.userId, session: { token: `local-${u.userId}`, expiresAt: null }, kdf: u.kdf || 1 };
  }

  /** Замена хеша входа на версию с тяжёлым KDF (после успешного входа старым). */
  async upgradeLogin({ email, oldLoginHash, newLoginHash, kdf }) {
    const d = await this._load();
    const u = d.users[email];
    if (!this._check(u, oldLoginHash)) {
      throw Object.assign(new Error("Неверный пароль"), { code: "bad-credentials" });
    }
    u.salt = base64.encode(randomBytes(16));
    u.verifier = this._verifier(newLoginHash, u.salt);
    u.kdf = kdf;
    await this._save(d);
    return true;
  }

  async changePassword({ email, oldLoginHash, newLoginHash, kdf }) {
    const d = await this._load();
    const u = d.users[email];
    if (!this._check(u, oldLoginHash)) {
      throw Object.assign(new Error("Неверный текущий пароль"), { code: "bad-credentials" });
    }
    u.salt = base64.encode(randomBytes(16));
    u.verifier = this._verifier(newLoginHash, u.salt);
    u.kdf = kdf;
    await this._save(d);
    return true;
  }

  /** Ключ проверки ключа восстановления (hex) или null — ключ отозван. */
  async setRecovery({ email, recoveryVerifier }) {
    const d = await this._load();
    const u = d.users[email];
    if (!u) {
      throw new Error("Аккаунт не найден на этом компьютере");
    }
    u.recovery = recoveryVerifier ? { verifier: recoveryVerifier, at: new Date().toISOString() } : null;
    await this._save(d);
    return true;
  }

  /** Одноразовый nonce для запроса сброса (действует 5 минут). Для неизвестного адреса тоже
   * выдаётся, чтобы ответ не раскрывал, есть ли такой аккаунт. */
  async resetChallenge({ email }) {
    const d = await this._load();
    const nonce = bytesToHex(randomBytes(16));
    const u = d.users[email];
    if (u) {
      u.resetNonce = { value: nonce, exp: Date.now() + RESET_NONCE_TTL };
      await this._save(d);
    }
    return { nonce };
  }

  /** Сброс пароля: только с подписью ключом проверки ключа восстановления.
   * legacyVaultProof — аккаунт создан до появления ключа проверки, а ключ восстановления
   * только что открыл сейф на этом же компьютере; ключ проверки регистрируется заодно. */
  async resetPassword({ email, nonce, recoveryProof, newLoginHash, kdf, newRecoveryVerifier = null, legacyVaultProof = false }) {
    const d = await this._load();
    const u = d.users[email];
    if (!u) {
      throw new Error("Аккаунт не найден на этом компьютере");
    }
    const n = u.resetNonce;
    delete u.resetNonce; // nonce одноразовый, даже при ошибке
    await this._save(d);
    if (!n || n.value !== nonce || Date.now() > n.exp) {
      throw Object.assign(new Error("Запрос сброса устарел: повторите"), { code: "bad-nonce" });
    }
    if (u.recovery?.verifier) {
      const expected = resetProof(hexToBytes(u.recovery.verifier), email, newLoginHash, nonce);
      if (!sameHex(expected, recoveryProof)) {
        throw Object.assign(new Error("Ключ восстановления не подходит к этому аккаунту"), { code: "bad-proof" });
      }
    } else if (!(legacyVaultProof && newRecoveryVerifier)) {
      throw Object.assign(new Error("Для аккаунта не зарегистрирован ключ восстановления"), { code: "no-recovery" });
    }
    u.salt = base64.encode(randomBytes(16));
    u.verifier = this._verifier(newLoginHash, u.salt);
    u.kdf = kdf;
    if (newRecoveryVerifier) {
      u.recovery = { verifier: newRecoveryVerifier, at: new Date().toISOString() };
    }
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
 *  GET  /v1/account/available?email=…                                          → { available }
 *  GET  /v1/account/prelogin?email=…                                           → { kdf }  (1 — старый хеш, 2 — текущий)
 *  POST /v1/account/register  { email, loginHash, kdf, deviceId, deviceName } → { userId, session: { token, expiresAt } }
 *  POST /v1/account/login     { email, loginHash, deviceId, deviceName }      → { userId, session, kdf } | 409 { needsDeviceConfirm }
 *  POST /v1/account/upgrade   { oldLoginHash, newLoginHash, kdf }  (Bearer)   → {}   замена хеша версии 1 на 2
 *  POST /v1/account/password  { oldLoginHash, newLoginHash, kdf }  (Bearer)   → {}
 *  POST /v1/account/recovery  { recoveryVerifier | null }          (Bearer)   → {}   ключ проверки ключа восстановления
 *  POST /v1/account/reset/challenge { email }                                  → { nonce }  одноразовый, 5 минут
 *  POST /v1/account/reset     { email, nonce, recoveryProof, newLoginHash, kdf } → {}
 *       recoveryProof = hex(HMAC-SHA256(recoveryVerifier, `${email}|${newLoginHash}|${nonce}`)); сервер
 *       обязан проверить подпись, срок и одноразовость nonce, иначе одного адреса хватило бы для захвата почты
 *  POST /v1/account/logout    (Bearer)                                         → {}
 *  GET  /v1/account/devices   (Bearer)                                         → [{ id, name, at }]
 * Сервер хранит только хеш от loginHash со своей солью и ключ проверки ключа восстановления;
 * пароль и ключ сейфа он никогда не видит. Счётчик неудачных входов сервер ведёт сам. */
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
        throw Object.assign(new Error(json.message || `Сервер: HTTP ${res.status}`), { code: json.code || (res.status === 401 ? "bad-credentials" : `http-${res.status}`), status: res.status });
      }
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  async checkName(email) {
    return (await this._call("GET", `/v1/account/available?email=${encodeURIComponent(email)}`)).available !== false;
  }

  async prelogin({ email }) {
    try {
      const r = await this._call("GET", `/v1/account/prelogin?email=${encodeURIComponent(email)}`);
      return { kdf: Number(r.kdf) === 1 ? 1 : KDF_CURRENT };
    } catch (e) {
      if (e.status === 404) {
        return { kdf: KDF_CURRENT };
      }
      throw e;
    }
  }

  register(data) {
    return this._call("POST", "/v1/account/register", data);
  }

  login(data) {
    return this._call("POST", "/v1/account/login", data);
  }

  upgradeLogin({ session, oldLoginHash, newLoginHash, kdf }) {
    return this._call("POST", "/v1/account/upgrade", { oldLoginHash, newLoginHash, kdf }, session?.token);
  }

  changePassword({ session, oldLoginHash, newLoginHash, kdf }) {
    return this._call("POST", "/v1/account/password", { oldLoginHash, newLoginHash, kdf }, session?.token);
  }

  setRecovery({ session, recoveryVerifier }) {
    return this._call("POST", "/v1/account/recovery", { recoveryVerifier }, session?.token);
  }

  resetChallenge({ email }) {
    return this._call("POST", "/v1/account/reset/challenge", { email });
  }

  resetPassword({ email, nonce, recoveryProof, newLoginHash, kdf }) {
    return this._call("POST", "/v1/account/reset", { email, nonce, recoveryProof, newLoginHash, kdf });
  }

  logout({ session }) {
    return this._call("POST", "/v1/account/logout", {}, session?.token);
  }

  devices({ session }) {
    return this._call("GET", "/v1/account/devices", null, session?.token);
  }
}

/* ---------- аккаунт ---------- */

export const Account = {
  TOPIC: "tabora-account-changed",
  MIN_PASSWORD,
  data: null,
  _loaded: false,

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

  async save(what = "changed") {
    if (!this.data) {
      await IOUtils.remove(FILE(), { ignoreAbsent: true });
    } else {
      this.data.updatedAt = new Date().toISOString();
      await IOUtils.writeJSON(FILE(), this.data, { tmpPath: FILE() + ".tmp" });
      try {
        await IOUtils.setPermissions(FILE(), 0o600);
      } catch (e) {}
    }
    this.notify(what);
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

  /** Хеш входа: Argon2id(пароль, соль из адреса) → HMAC. Независим от ключа сейфа.
   * Считается в рабочем потоке: 64 МБ в главном потоке заморозили бы окно. */
  async loginHash(email, password, kdf = KDF_CURRENT) {
    const params = AUTH_KDF[kdf];
    if (!params) {
      throw new Error("Неизвестная версия хеша входа");
    }
    const salt = sha256(utf8ToBytes(`${AUTH_SALT[kdf]}${email}`)).slice(0, 16);
    const k = await argon2idAsync(utf8ToBytes(String(password).normalize("NFKC")), salt, params);
    try {
      return bytesToHex(hmac(sha256, k, utf8ToBytes("login")));
    } finally {
      wipe(k);
    }
  },

  /** Сейф принимает пароль аккаунта как мастер-пароль: задаёт его, если не задан, иначе сверяет.
   * Пароль уже принят сервером, поэтому стойкость здесь не перепроверяется (старые аккаунты). */
  async _syncVaultPassword(password) {
    await Vault.ready();
    if (Vault.state === "corrupt") {
      throw new Error("Файл сейфа повреждён: восстановите его в разделе «Коды» и войдите снова");
    }
    if (!Vault.exists) {
      await Vault.create({ password, checkStrength: false });
      return;
    }
    if (Vault.hasPassword) {
      const mismatch = () => {
        throw Object.assign(new Error("Сейф этого компьютера защищён другим паролем. Введите его ниже, чтобы передать сейф этому аккаунту."), { code: "vault-mismatch" });
      };
      // пароль аккаунта уже проверен сервером: несовпадение с сейфом — не подбор
      if (Vault.unlocked) {
        await Vault.verifyPassword(password, { count: false }).catch(mismatch);
      } else {
        await Vault.unlockWithPassword(password, { count: false }).catch(e => (e.code === "bad-password" ? mismatch() : Promise.reject(e)));
      }
      return;
    }
    if (!Vault.unlocked) {
      // вход — действие пользователя: после явной блокировки спросим Touch ID
      await Vault.unlock({ user: true });
    }
    if (!Vault.unlocked) {
      throw new Error("Сейф заблокирован: разблокируйте его и повторите");
    }
    await Vault.setPassword(password, { checkStrength: false });
  },

  async checkName(input) {
    const email = this.normalizeEmail(input);
    const free = await this.backend.checkName(email);
    return { email, free };
  },

  /** Регистрация. Возвращает { email, recoveryKey }: ключ восстановления создаётся сразу и
   * регистрируется на сервере, интерфейс показывает его один раз. */
  async register(nameInput, password) {
    await this.ready();
    if (this.signedIn) {
      throw new Error("Вы уже вошли в аккаунт");
    }
    const email = this.normalizeEmail(nameInput);
    checkPassword(password);
    await Vault.ready();
    if (Vault.exists && Vault.hasPassword) {
      await Vault.verifyPassword(password).catch(e => {
        throw e.code === "locked-out" ? e : new Error("Пароль аккаунта должен совпадать с мастер-паролем сейфа этого компьютера");
      });
    }
    const loginHash = await this.loginHash(email, password, KDF_CURRENT);
    const r = await this.backend.register({ email, loginHash, kdf: KDF_CURRENT, deviceId: this.deviceId(), deviceName: this.deviceName() });
    await this._syncVaultPassword(password);
    this.data = { version: 1, email, userId: r.userId, session: r.session, server: this.serverUrl || null, kdf: KDF_CURRENT, createdAt: new Date().toISOString(), lastLoginAt: new Date().toISOString() };
    await this.save("signed-in");
    this.markFirstRunDone();
    let recoveryKey = null;
    try {
      recoveryKey = await this.createRecoveryKey({ password });
    } catch (e) {
      console.error("Tabora account: ключ восстановления не создан", e);
    }
    return { email, recoveryKey };
  },

  /** Новый ключ восстановления сейфа с регистрацией ключа проверки на сервере. Если прежний
   * ключ был, сейф меняет K (см. Vault.createRecoveryKey), поэтому нужен мастер-пароль. */
  async createRecoveryKey({ password = null } = {}) {
    const text = await Vault.createRecoveryKey({ password });
    await this.registerRecoveryKey(text);
    return text;
  },

  /** Сообщить серверу ключ проверки для ключа восстановления (null — ключ отозван). */
  async registerRecoveryKey(text) {
    await this.ready();
    if (!this.signedIn) {
      return false;
    }
    let recoveryVerifier = null;
    if (text) {
      const k = Vault.recoveryAuthKey(text);
      recoveryVerifier = bytesToHex(k);
      wipe(k);
    }
    try {
      await this.backend.setRecovery({ email: this.email, session: this.data.session, recoveryVerifier });
      this.data.recoveryRegisteredAt = recoveryVerifier ? new Date().toISOString() : null;
      await this.save();
      return true;
    } catch (e) {
      console.error("Tabora account: ключ проверки не зарегистрирован", e);
      return false;
    }
  },

  /** Вход в другой аккаунт на этом компьютере: сейф перепривязывается к новому паролю
   * (нужен прежний мастер-пароль). K при этом меняется, а ключ восстановления выдаётся новый:
   * прежний пароль и прежний ключ восстановления больше ничего не открывают. */
  async _rebindVault(vaultPassword, password) {
    await Vault.verifyPassword(vaultPassword).catch(e => {
      throw e.code === "locked-out" ? e : new Error("Неверный мастер-пароль сейфа");
    });
    if (!Vault.unlocked) {
      await Vault.unlockWithPassword(vaultPassword);
    }
    return Vault.rotateKey({ password, reason: "rebind", recovery: "new" });
  },

  async login(emailInput, password, { vaultPassword = null } = {}) {
    await this.ready();
    await Vault.guard.check();
    const email = this.normalizeEmail(emailInput);
    if (!password) {
      throw new Error("Введите пароль");
    }
    const deviceId = this.deviceId();
    const deviceName = this.deviceName();
    const { kdf } = await this.backend.prelogin({ email });
    const loginHash = await this.loginHash(email, password, kdf);
    let r;
    try {
      r = await this.backend.login({ email, loginHash, deviceId, deviceName });
    } catch (e) {
      if (e.code === "bad-credentials") {
        await Vault.guard.fail();
      }
      throw e;
    }
    await Vault.guard.success();
    let usedKdf = Number(r.kdf) || kdf;
    if (usedKdf < KDF_CURRENT) {
      // аккаунт создан со слабым хешем входа: заменяем его сразу после успешного входа
      try {
        const newLoginHash = await this.loginHash(email, password, KDF_CURRENT);
        await this.backend.upgradeLogin({ email, session: r.session, oldLoginHash: loginHash, newLoginHash, kdf: KDF_CURRENT });
        usedKdf = KDF_CURRENT;
      } catch (e) {
        console.error("Tabora account: хеш входа не обновлён, повторим при следующем входе", e);
      }
    }
    let rebound = null;
    try {
      await this._syncVaultPassword(password);
    } catch (e) {
      if (e.code === "vault-mismatch" && vaultPassword) {
        rebound = await this._rebindVault(vaultPassword, password);
      } else {
        throw e;
      }
    }
    this.data = { version: 1, email, userId: r.userId, session: r.session, server: this.serverUrl || null, kdf: usedKdf, createdAt: this.data?.email === email ? this.data.createdAt : new Date().toISOString(), lastLoginAt: new Date().toISOString() };
    await this.save("signed-in");
    this.markFirstRunDone();
    let recoveryKey = null;
    if (rebound) {
      recoveryKey = rebound.recoveryKey;
      await this.registerRecoveryKey(recoveryKey);
    }
    return { email, rebound: !!rebound, recoveryKey, rekeyComplete: rebound ? rebound.complete : true };
  },

  /** Смена пароля аккаунта и мастер-пароля сейфа вместе. rotate: true — заодно сменить ключ
   * сейфа K и перешифровать данные; тогда прежний ключ восстановления заменяется новым,
   * он возвращается в { recoveryKey }. */
  async changePassword(oldPassword, newPassword, { rotate = false } = {}) {
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
      await Vault.verifyPassword(oldPassword).catch(e => {
        throw e.code === "locked-out" ? e : new Error("Неверный текущий пароль");
      });
    } else {
      await Vault.guard.check();
    }
    const { kdf } = await this.backend.prelogin({ email: this.email });
    const [oldLoginHash, newLoginHash] = await Promise.all([this.loginHash(this.email, oldPassword, kdf), this.loginHash(this.email, newPassword, KDF_CURRENT)]);
    try {
      await this.backend.changePassword({ session: this.data.session, email: this.email, oldLoginHash, newLoginHash, kdf: KDF_CURRENT });
    } catch (e) {
      if (e.code === "bad-credentials") {
        await Vault.guard.fail();
      }
      throw e;
    }
    let result = { recoveryKey: null, complete: true };
    if (Vault.hasPassword) {
      if (!Vault.unlocked) {
        await Vault.unlockWithPassword(oldPassword);
      }
      result = await Vault.changePassword(oldPassword, newPassword, { rotate });
    } else {
      await this._syncVaultPassword(newPassword);
      if (rotate) {
        result = await Vault.rotateKey({ password: newPassword, reason: "password" });
      }
    }
    if (result.recoveryKey) {
      await this.registerRecoveryKey(result.recoveryKey);
    }
    this.data.kdf = KDF_CURRENT;
    this.data.passwordChangedAt = new Date().toISOString();
    await this.save();
    return result;
  },

  /** Забытый пароль: сейф открывается ключом восстановления, сервер получает подпись запроса
   * производным от него ключом и одноразовым nonce; затем новый пароль задаётся и аккаунту,
   * и сейфу. */
  async resetPasswordWithRecovery(recoveryKey, newPassword) {
    await this.ready();
    if (!this.email) {
      throw new Error("На этом компьютере нет аккаунта");
    }
    checkPassword(newPassword);
    await Vault.ready();
    await Vault.unlockWithRecoveryKey(recoveryKey);
    const newLoginHash = await this.loginHash(this.email, newPassword, KDF_CURRENT);
    const authKey = Vault.recoveryAuthKey(recoveryKey);
    try {
      const { nonce } = await this.backend.resetChallenge({ email: this.email });
      const recoveryProof = resetProof(authKey, this.email, newLoginHash, String(nonce || ""));
      await this.backend.resetPassword({
        email: this.email,
        nonce,
        recoveryProof,
        newLoginHash,
        kdf: KDF_CURRENT,
        // только локальный режим: аккаунт старше ключа проверки, а ключ восстановления
        // только что открыл сейф здесь же — регистрируем ключ проверки заодно
        newRecoveryVerifier: this.isLocalMode ? bytesToHex(authKey) : undefined,
        legacyVaultProof: this.isLocalMode,
      });
    } finally {
      wipe(authKey);
    }
    await Vault.setPassword(newPassword);
    this.data.kdf = KDF_CURRENT;
    this.data.passwordChangedAt = new Date().toISOString();
    await this.save();
    return true;
  },

  /** Выход: сессия удаляется, сейф блокируется (пароли сайтов и коды закрываются до
   * разблокировки пользователем), почта перестаёт открываться. */
  async logout() {
    await this.ready();
    if (!this.data) {
      Vault.lock();
      return;
    }
    try {
      await this.backend.logout({ session: this.data.session });
    } catch (e) {}
    this.data.session = null;
    await this.save("signed-out");
    Vault.lock();
  },

  async devices() {
    await this.ready();
    if (!this.data) {
      return [];
    }
    return this.backend.devices({ email: this.email, session: this.data.session });
  },
};
