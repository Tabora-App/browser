/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Аккаунт Tabora: вход по адресу почты Tabora и одному паролю, который одновременно
 * является мастер-паролем сейфа. Из пароля на устройстве выводятся два независимых
 * значения: ключ сейфа (обёртка pw в tabora-vault.json, никуда не уходит) и хеш входа
 * (Argon2id 64 МБ, 3 прохода — не слабее KDF сейфа — с солью из адреса, затем HMAC),
 * который отправляется на сервер. Сервер по хешу входа ключ сейфа восстановить не может.
 *
 * Сброс забытого пароля требует доказательства владения ключом восстановления. Из ключа
 * восстановления детерминированно выводится пара Ed25519; при создании ключа на сервере
 * регистрируется только открытый ключ, а запрос сброса подписывается закрытым:
 * Ed25519("tabora-reset-v2|email|newLoginHash|nonce") с одноразовым nonce. Утечка базы сервера
 * подделать сброс не позволяет. Аккаунты, зарегистрировавшие прежний общий ключ HMAC,
 * переводятся при первом сбросе или при создании нового ключа восстановления.
 *
 * Бэкенд подменяемый: пока сервер не задан (pref tabora.account.server пуст), работает
 * локальный режим — аккаунт хранится на этом компьютере в tabora-account-local.json,
 * все окна и проверки настоящие. Контракт HTTP-бэкенда описан в HttpBackend. Аккаунт,
 * созданный в локальном режиме, подключается к серверу под тем же адресом (linkToServer).
 *
 * Вместе с сессией сервер выдаёт доступ к ящику: пароль приложения этого устройства для
 * IMAP и SMTP. Он хранится в tabora-account.json зашифрованным подключом сейфа и отзывается
 * сервером при выходе.
 *
 * Аккаунт и профиль браузера связаны один к одному: первый аккаунт, созданный или вошедший в
 * профиле, остаётся его единственным владельцем, другой аккаунт живёт в своём профиле
 * (account/Profiles.sys.mjs). Сейф, кошелёк, коды и почта принадлежат аккаунту: пока вход не
 * выполнен, сейф не открывается ни связкой ключей, ни паролем (vaultAccess), остальное
 * проверяет signedIn. */

const C = ChromeUtils.importESModule("chrome://tabora/content/wallet/vendor/crypto.sys.mjs");
const { randomBytes, base64, utf8ToBytes, bytesToHex, hexToBytes, hmac, sha256, ed25519 } = C;
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
const KDF_SEEN_PREF = "tabora.account.kdfSeen"; // версии хеша входа, уже использованные на этом устройстве
const VERIFIER_RE = /^ed25519:[0-9a-f]{64}$/;
const MAIL_INFO = "mail-access"; // подключ сейфа, которым зашифрован доступ к ящику

function bound(text, extra = {}) {
  return Object.assign(new Error(text), { code: "profile-bound", ...extra });
}

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

/** Прежняя подпись запроса сброса общим ключом HMAC (его знал и сервер). Только для
 * аккаунтов, зарегистрировавших ключ проверки по-старому: один раз, вместе с переводом. */
function legacyResetProof(authKey, email, newLoginHash, nonce) {
  return bytesToHex(hmac(sha256, authKey, utf8ToBytes(`${email}|${newLoginHash}|${nonce}`)));
}

/** Сообщение, которое подписывается ключом Ed25519 из ключа восстановления. */
function resetMessage(email, newLoginHash, nonce) {
  return utf8ToBytes(`tabora-reset-v2|${email}|${newLoginHash}|${nonce}`);
}

/** Ключ проверки для сервера: только открытый ключ Ed25519. */
function verifierOf(publicKey) {
  return `ed25519:${bytesToHex(publicKey)}`;
}

/** Проверка подписи сброса открытым ключом (то, что обязан делать сервер). */
function verifyResetProof(verifier, email, newLoginHash, nonce, proof) {
  try {
    return VERIFIER_RE.test(verifier) && /^[0-9a-f]{128}$/.test(String(proof || "")) && ed25519.verify(hexToBytes(proof), resetMessage(email, newLoginHash, nonce), hexToBytes(verifier.slice(8)));
  } catch (e) {
    return false;
  }
}

/* ---------- бэкенды ---------- */

/** Локальный режим: без сервера. Хранит только хеш от хеша входа с солью и открытый ключ
 * проверки ключа восстановления; проверки те же, что обязан делать сервер. */
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
    await IOUtils.writeJSON(LOCAL_FILE(), d, { tmpPath: LOCAL_FILE() + ".tmp", flush: true });
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

  /** Ключ проверки ключа восстановления ("ed25519:<открытый ключ hex>") или null — ключ
   * отозван. Общий секрет прежней схемы больше не принимается. */
  async setRecovery({ email, recoveryVerifier }) {
    const d = await this._load();
    const u = d.users[email];
    if (!u) {
      throw new Error("Аккаунт не найден на этом компьютере");
    }
    if (recoveryVerifier && !VERIFIER_RE.test(recoveryVerifier)) {
      throw new Error("Ключ проверки должен быть открытым ключом Ed25519");
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

  /** Сброс пароля: только с подписью Ed25519, которая проверяется открытым ключом.
   * Аккаунт с ключом проверки прежней схемы (общий ключ HMAC) один раз принимает прежнюю
   * подпись legacyRecoveryProof и тут же переводится на открытый ключ newRecoveryVerifier.
   * legacyVaultProof — аккаунт создан до появления ключа проверки, а ключ восстановления
   * только что открыл сейф на этом же компьютере; ключ проверки регистрируется заодно. */
  async resetPassword({ email, nonce, recoveryProof, legacyRecoveryProof = null, newLoginHash, kdf, newRecoveryVerifier = null, legacyVaultProof = false }) {
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
    const badProof = () => Object.assign(new Error("Ключ восстановления не подходит к этому аккаунту"), { code: "bad-proof" });
    const current = u.recovery?.verifier || "";
    const modern = VERIFIER_RE.test(current);
    const upgrade = newRecoveryVerifier && VERIFIER_RE.test(newRecoveryVerifier) ? newRecoveryVerifier : null;
    if (modern) {
      if (!verifyResetProof(current, email, newLoginHash, nonce, recoveryProof)) {
        throw badProof();
      }
    } else if (current) {
      // прежняя схема: общий ключ HMAC. Принимается, только если заодно приходит открытый
      // ключ, подпись которым тоже верна: после этого сброса общий ключ больше не действует
      let expected = "";
      try {
        expected = legacyResetProof(hexToBytes(current), email, newLoginHash, nonce);
      } catch (e) {}
      if (!sameHex(expected, legacyRecoveryProof) || !upgrade || !verifyResetProof(upgrade, email, newLoginHash, nonce, recoveryProof)) {
        throw badProof();
      }
    } else if (!(legacyVaultProof && upgrade && verifyResetProof(upgrade, email, newLoginHash, nonce, recoveryProof))) {
      throw Object.assign(new Error("Для аккаунта не зарегистрирован ключ восстановления"), { code: "no-recovery" });
    }
    u.salt = base64.encode(randomBytes(16));
    u.verifier = this._verifier(newLoginHash, u.salt);
    u.kdf = kdf;
    if (!modern && upgrade) {
      u.recovery = { verifier: upgrade, at: new Date().toISOString() };
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

  // ящик и алиасы выдаёт только сервер
  async mailPassword() {
    throw Object.assign(new Error("Почта работает после подключения аккаунта к серверу"), { code: "local-mode" });
  }

  async aliases() {
    return [];
  }

  async aliasCreate() {
    throw Object.assign(new Error("Алиасы работают после подключения аккаунта к серверу"), { code: "local-mode" });
  }

  async aliasUpdate() {
    throw Object.assign(new Error("Алиасы работают после подключения аккаунта к серверу"), { code: "local-mode" });
  }

  async aliasDelete() {
    throw Object.assign(new Error("Алиасы работают после подключения аккаунта к серверу"), { code: "local-mode" });
  }
}

/** Сервер Tabora: JSON по HTTPS. Контракт:
 *  GET  /v1/account/available?email=…                                          → { available }
 *  GET  /v1/account/prelogin?email=…                                           → { kdf }  (1 — старый хеш, 2 — текущий)
 *  POST /v1/account/register  { email, loginHash, kdf, deviceId, deviceName } → { userId, session: { token, expiresAt } }
 *  POST /v1/account/login     { email, loginHash, deviceId, deviceName }      → { userId, session, kdf } | 409 { needsDeviceConfirm }
 *  POST /v1/account/upgrade   { oldLoginHash, newLoginHash, kdf }  (Bearer)   → {}   замена хеша версии 1 на 2
 *  POST /v1/account/password  { oldLoginHash, newLoginHash, kdf }  (Bearer)   → {}
 *  POST /v1/account/recovery  { recoveryVerifier | null }          (Bearer)   → {}   ключ проверки ключа восстановления:
 *       "ed25519:" + hex(открытый ключ, 32 байта); закрытый ключ сервер не получает никогда
 *  POST /v1/account/reset/challenge { email }                                  → { nonce }  одноразовый, 5 минут
 *  POST /v1/account/reset     { email, nonce, recoveryProof, newLoginHash, kdf, legacyRecoveryProof?, newRecoveryVerifier? } → {}
 *       recoveryProof = hex(Ed25519(`tabora-reset-v2|${email}|${newLoginHash}|${nonce}`)); сервер обязан проверить
 *       подпись открытым ключом, срок и одноразовость nonce, иначе одного адреса хватило бы для захвата почты.
 *       Аккаунт с ключом проверки прежней схемы (hex общего ключа HMAC без префикса): сервер проверяет
 *       legacyRecoveryProof = hex(HMAC-SHA256(старый ключ, `${email}|${newLoginHash}|${nonce}`)) И подпись
 *       recoveryProof открытым ключом newRecoveryVerifier, после чего заменяет ключ проверки на newRecoveryVerifier.
 *       Если ключ проверки уже "ed25519:", поля legacyRecoveryProof и newRecoveryVerifier игнорируются.
 *  POST /v1/account/logout    (Bearer)                                         → {}
 *  GET  /v1/account/devices   (Bearer)                                         → [{ id, name, at }]
 * Сервер хранит только хеш от loginHash со своей солью и ключ проверки ключа восстановления;
 * пароль и ключ сейфа он никогда не видит. Счётчик неудачных входов сервер ведёт сам.
 * Почта (server/README.md): register и login возвращают ещё mail = { address, login, password,
 * imap: { host, port, security }, smtp: {…} } — пароль приложения этого устройства;
 *  POST   /v1/mail/password     (Bearer)                    → { mail }   новый взамен прежнего
 *  GET    /v1/mail/aliases      (Bearer)                    → [{ id, address, site, space, by, on, created }]
 *  POST   /v1/mail/aliases      { site?, space?, by? }      → алиас
 *  PATCH  /v1/mail/aliases/:id  { on?, site?, space? }      → алиас
 *  DELETE /v1/mail/aliases/:id                              → {}
 * Ответ 401 с кодом session-expired означает, что сервер сессию больше не признаёт. */
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
        const error = Object.assign(new Error(json.message || `Сервер: HTTP ${res.status}`), { code: json.code || (res.status === 401 ? "bad-credentials" : `http-${res.status}`), status: res.status });
        if (error.code === "session-expired" && token) {
          Account._sessionExpired(token).catch(() => {});
        }
        throw error;
      }
      return json;
    } catch (e) {
      if (e.name === "AbortError" || e.name === "TypeError") {
        // нет сети, сервер не отвечает, истекло ожидание
        throw Object.assign(new Error("Сервер Tabora не отвечает. Проверьте соединение и повторите"), { code: "offline" });
      }
      if (e.name === "SyntaxError") {
        throw Object.assign(new Error("Сервер Tabora ответил непонятно. Повторите позже"), { code: "bad-response" });
      }
      throw e;
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

  resetPassword({ email, nonce, recoveryProof, legacyRecoveryProof, newRecoveryVerifier, newLoginHash, kdf }) {
    return this._call("POST", "/v1/account/reset", { email, nonce, recoveryProof, legacyRecoveryProof: legacyRecoveryProof || undefined, newRecoveryVerifier, newLoginHash, kdf });
  }

  logout({ session }) {
    return this._call("POST", "/v1/account/logout", {}, session?.token);
  }

  devices({ session }) {
    return this._call("GET", "/v1/account/devices", null, session?.token);
  }

  mailPassword({ session }) {
    return this._call("POST", "/v1/mail/password", {}, session?.token);
  }

  aliases({ session }) {
    return this._call("GET", "/v1/mail/aliases", null, session?.token);
  }

  aliasCreate({ session, site, space, by }) {
    return this._call("POST", "/v1/mail/aliases", { site, space, by }, session?.token);
  }

  aliasUpdate({ session, id, on, site, space }) {
    return this._call("PATCH", `/v1/mail/aliases/${encodeURIComponent(id)}`, { on, site, space }, session?.token);
  }

  aliasDelete({ session, id }) {
    return this._call("DELETE", `/v1/mail/aliases/${encodeURIComponent(id)}`, null, session?.token);
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

  /** Аккаунт этого компьютера создан без сервера (или на другом сервере) и на нынешнем не
   * зарегистрирован: почта и вход с других компьютеров не работают, пока его не подключат. */
  get needsServerLink() {
    return !this.isLocalMode && !!this.data?.email && (this.data.server || null) !== this.serverUrl;
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

  /** Можно ли открывать сейф. В профиле с аккаунтом — только после входа; вход, подключение к
   * серверу и сброс пароля открывают его сами (_entering). В профиле без аккаунта сейф служит
   * одному хранилищу паролей сайтов и открывается как раньше. */
  get vaultAccess() {
    return !this.data?.email || this.signedIn || this._enterDepth > 0;
  },

  _enterDepth: 0,

  /** Операция, которая открывает сейф до того, как сессия сохранена. Если она не довела до
   * входа, сейф закрывается обратно. */
  async _entering(fn) {
    this._enterDepth++;
    try {
      return await fn();
    } finally {
      this._enterDepth--;
      if (!this._enterDepth && !this.vaultAccess) {
        await Vault.lock();
      }
    }
  },

  get email() {
    return this.data?.email || "";
  },

  get firstRunDone() {
    return Services.prefs.getBoolPref(FIRSTRUN_PREF, false);
  },

  markFirstRunDone() {
    if (!this.firstRunDone) {
      Services.prefs.setBoolPref(FIRSTRUN_PREF, true);
      this.notify("first-run");
    }
  },

  notify(what = "changed") {
    Services.obs.notifyObservers(null, this.TOPIC, what);
  },

  async save(what = "changed") {
    if (!this.data) {
      await IOUtils.remove(FILE(), { ignoreAbsent: true });
    } else {
      this.data.updatedAt = new Date().toISOString();
      await IOUtils.writeJSON(FILE(), this.data, { tmpPath: FILE() + ".tmp", flush: true });
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
  /** Этап долгой операции для интерфейса (кнопка показывает, что сейчас происходит). */
  onStep: null,

  _step(text) {
    try {
      this.onStep?.(text);
    } catch (e) {}
  },

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

  _kdfKey(email) {
    return bytesToHex(sha256(utf8ToBytes(`tabora-kdf-seen|${email}`))).slice(0, 16);
  },

  _kdfSeenMap() {
    try {
      const m = JSON.parse(Services.prefs.getStringPref(KDF_SEEN_PREF, "") || "{}");
      return m && typeof m === "object" && !Array.isArray(m) ? m : {};
    } catch (e) {
      return {};
    }
  },

  /** Наименьшая допустимая версия хеша входа для адреса: та, что уже использовалась на этом
   * устройстве. Ответ prelogin (его может подменить сервер или тот, кто между) не может
   * заставить посчитать и отправить более слабый хеш того же пароля. */
  _kdfFloor(email) {
    const seen = Number(this._kdfSeenMap()[this._kdfKey(email)]) || 0;
    const own = this.data?.email === email ? Number(this.data.kdf) || 0 : 0;
    return Math.min(KDF_CURRENT, Math.max(seen, own, 1));
  },

  _noteKdf(email, kdf) {
    try {
      const m = this._kdfSeenMap();
      const key = this._kdfKey(email);
      if ((Number(m[key]) || 0) >= kdf) {
        return;
      }
      delete m[key];
      m[key] = kdf;
      const keys = Object.keys(m);
      for (const k of keys.slice(0, Math.max(0, keys.length - 32))) {
        delete m[k]; // не больше 32 адресов, самые старые вытесняются
      }
      Services.prefs.setStringPref(KDF_SEEN_PREF, JSON.stringify(m));
    } catch (e) {
      console.error("Tabora account: версия хеша входа не запомнена", e);
    }
  },

  /** Версия хеша входа для адреса: ответ сервера, но не ниже уже использованной здесь. */
  async _kdfFor(email) {
    const { kdf } = await this.backend.prelogin({ email });
    return Math.max(Number(kdf) === 1 ? 1 : KDF_CURRENT, this._kdfFloor(email));
  },

  /** Системная проверка владельца перед тем, как задать мастер-пароль существующему сейфу
   * без пароля: иначе любой, кто сел за открытый браузер, вошёл бы в свой аккаунт и получил
   * пароль от чужого сейфа (и возможность унести его файл). */
  async _confirmVaultOwner() {
    if (!(await Vault.confirmOwner("задать мастер-пароль сейфа Tabora"))) {
      throw Object.assign(new Error("Сейф этого компьютера уже создан. Чтобы задать ему пароль аккаунта, подтвердите, что вы владелец компьютера (Touch ID или пароль системы)"), { code: "owner-check" });
    }
    if (!Vault.unlocked) {
      // проверку системы только что прошли: открываем без второго запроса
      await Vault.unlock({ user: true, reauth: false });
    }
    if (!Vault.unlocked) {
      throw new Error("Сейф заблокирован: разблокируйте его и повторите");
    }
  },

  /** Сейф принимает пароль аккаунта как мастер-пароль: задаёт его, если не задан, иначе сверяет.
   * Пароль уже принят сервером, поэтому стойкость здесь не перепроверяется (старые аккаунты).
   * Сверка с сейфом считается попыткой подбора мастер-пароля, как любая другая: свой аккаунт
   * на сервере не даёт перебирать пароль чужого сейфа без пауз. ownerConfirmed — системную
   * проверку владельца вызывающий уже провёл (_confirmVaultOwner). */
  async _syncVaultPassword(password, { ownerConfirmed = false } = {}) {
    await Vault.ready();
    if (Vault.state === "corrupt") {
      throw new Error("Файл сейфа повреждён или утрачен: восстановите его в разделе «Коды» и войдите снова");
    }
    if (!Vault.exists) {
      await Vault.create({ password, checkStrength: false });
      return;
    }
    if (Vault.hasPassword) {
      const mismatch = e => {
        if (e.code !== "bad-password") {
          throw e;
        }
        throw Object.assign(new Error("Сейф этого профиля защищён прежним паролем. Введите его ниже: сейф перейдёт на пароль аккаунта."), { code: "vault-mismatch" });
      };
      if (Vault.unlocked) {
        await Vault.verifyPassword(password).catch(mismatch);
      } else {
        await Vault.unlockWithPassword(password).catch(mismatch);
      }
      return;
    }
    if (!ownerConfirmed || !Vault.unlocked) {
      await this._confirmVaultOwner();
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
  register(nameInput, password) {
    return this._entering(() => this._register(nameInput, password));
  },

  async _register(nameInput, password) {
    await this.ready();
    if (this.signedIn) {
      throw new Error("Вы уже вошли в аккаунт");
    }
    if (this.data?.email) {
      throw bound(`В этом профиле уже есть аккаунт ${this.data.email}. Другой аккаунт создаётся в отдельном профиле: «Добавить аккаунт»`);
    }
    const email = this.normalizeEmail(nameInput);
    checkPassword(password);
    await Vault.ready();
    if (Vault.state === "corrupt") {
      throw new Error("Файл сейфа повреждён или утрачен: восстановите его в разделе «Коды» и повторите");
    }
    let ownerConfirmed = false;
    if (Vault.exists && Vault.hasPassword) {
      await Vault.verifyPassword(password).catch(e => {
        throw e.code === "locked-out" ? e : new Error("В этом профиле уже есть сейф с мастер-паролем. Введите его как пароль аккаунта");
      });
    } else if (Vault.exists) {
      // до обращения к серверу: отказ от проверки не должен оставлять занятый адрес без аккаунта здесь
      await this._confirmVaultOwner();
      ownerConfirmed = true;
    }
    this._step("Защищаем пароль");
    const loginHash = await this.loginHash(email, password, KDF_CURRENT);
    this._step("Создаём аккаунт");
    const r = await this.backend.register({ email, loginHash, kdf: KDF_CURRENT, deviceId: this.deviceId(), deviceName: this.deviceName() });
    this._step("Готовим сейф");
    this._noteKdf(email, KDF_CURRENT);
    await this._syncVaultPassword(password, { ownerConfirmed });
    this.data = { version: 1, email, userId: r.userId, session: r.session, server: this.serverUrl || null, kdf: KDF_CURRENT, createdAt: new Date().toISOString(), lastLoginAt: new Date().toISOString() };
    await this._setMailAccess(r.mail);
    await this.save("signed-in");
    this.markFirstRunDone();
    let recoveryKey = null;
    try {
      this._step("Создаём ключ восстановления");
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

  /** Ключ проверки на сервере зарегистрирован по прежней схеме (общий ключ HMAC): перевести
   * на открытый ключ можно только с самим ключом восстановления, а он нигде не хранится —
   * поэтому интерфейс предлагает создать новый ключ восстановления. */
  get recoveryNeedsUpgrade() {
    return !!this.data?.recoveryRegisteredAt && this.data.recoveryScheme !== "ed25519";
  },

  /** Сообщить серверу ключ проверки для ключа восстановления (null — ключ отозван): только
   * открытый ключ Ed25519, выведенный из ключа восстановления. */
  async registerRecoveryKey(text) {
    await this.ready();
    if (!this.signedIn) {
      return false;
    }
    let recoveryVerifier = null;
    if (text) {
      const signer = Vault.recoverySigner(text);
      recoveryVerifier = verifierOf(signer.publicKey);
      wipe(signer.seed);
    }
    try {
      await this.backend.setRecovery({ email: this.email, session: this.data.session, recoveryVerifier });
      this.data.recoveryRegisteredAt = recoveryVerifier ? new Date().toISOString() : null;
      this.data.recoveryScheme = recoveryVerifier ? "ed25519" : null;
      delete this.data.recoveryOffServer;
      await this.save();
      return true;
    } catch (e) {
      console.error("Tabora account: ключ проверки не зарегистрирован", e);
      return false;
    }
  },

  /** Сейф переходит на пароль аккаунта (нужен прежний мастер-пароль): пароль аккаунта сменили
   * на другом компьютере либо первый аккаунт входит в профиль, где сейф уже был. K при этом
   * меняется, а ключ восстановления выдаётся новый: прежний пароль и прежний ключ восстановления
   * больше ничего не открывают. Другому аккаунту сейф не передаётся (см. login). */
  async _rebindVault(vaultPassword, password) {
    await Vault.verifyPassword(vaultPassword).catch(e => {
      throw e.code === "locked-out" ? e : new Error("Неверный мастер-пароль сейфа");
    });
    if (!Vault.unlocked) {
      await Vault.unlockWithPassword(vaultPassword);
    }
    return Vault.rotateKey({ password, reason: "rebind", recovery: "new" });
  },

  /** Аккаунт, созданный на этом компьютере без сервера, регистрируется на сервере под тем же
   * адресом. Пароль — пароль аккаунта, он же мастер-пароль сейфа: его принимает сейф (это и
   * проверка владельца), сервер получает только хеш входа. Если адрес на сервере уже есть и
   * пароль подходит (аккаунт подключили с другого компьютера), выполняется обычный вход.
   * Ключ восстановления сервер узнаёт только при создании нового: прежний по-прежнему
   * открывает сейф, но сбросить им пароль аккаунта нельзя (recoveryOffServer). */
  linkToServer(password) {
    return this._entering(() => this._linkToServer(password));
  },

  async _linkToServer(password) {
    await this.ready();
    if (this.isLocalMode) {
      throw new Error("Сервер Tabora не задан");
    }
    const email = this.email;
    if (!email) {
      throw new Error("На этом компьютере нет аккаунта");
    }
    if (!password) {
      throw new Error("Введите пароль");
    }
    await Vault.ready();
    await Vault.guard.check();
    if (!Vault.exists || !Vault.hasPassword) {
      throw new Error("У сейфа этого компьютера нет пароля. Задайте его: «Аккаунт» → «Безопасность» → «Сменить пароль»");
    }
    await Vault.verifyPassword(password).catch(e => {
      throw e.code === "locked-out" ? e : Object.assign(new Error("Неверный пароль"), { code: "bad-credentials" });
    });
    if (!Vault.unlocked) {
      await Vault.unlockWithPassword(password);
    }
    this._step("Защищаем пароль");
    const loginHash = await this.loginHash(email, password, KDF_CURRENT);
    this._step("Подключаем к серверу");
    const device = { deviceId: this.deviceId(), deviceName: this.deviceName() };
    let r;
    let created = true;
    try {
      r = await this.backend.register({ email, loginHash, kdf: KDF_CURRENT, ...device });
    } catch (e) {
      if (e.code !== "taken") {
        throw e;
      }
      created = false;
      r = await this.backend.login({ email, loginHash, ...device }).catch(e2 => {
        if (e2.code === "bad-credentials") {
          throw Object.assign(new Error(`Адрес ${email} на сервере уже занят другим человеком. Этот аккаунт останется только на компьютере; аккаунт с другим именем добавляется отдельно: «Добавить аккаунт»`), { code: "taken" });
        }
        throw e2;
      });
    }
    this._noteKdf(email, KDF_CURRENT);
    const prior = this.data;
    const now = new Date().toISOString();
    this.data = { version: 1, email, userId: r.userId, session: r.session, server: this.serverUrl, kdf: KDF_CURRENT, createdAt: prior.createdAt || now, lastLoginAt: now, linkedAt: now };
    if (created) {
      // сервер новый для этого аккаунта: ключа проверки у него нет
      this.data.recoveryOffServer = !!Vault.recoveryKeyCreatedAt;
    } else if (prior.recoveryRegisteredAt) {
      this.data.recoveryRegisteredAt = prior.recoveryRegisteredAt;
      this.data.recoveryScheme = prior.recoveryScheme || null;
    }
    await this._setMailAccess(r.mail);
    await this.save("signed-in");
    this.markFirstRunDone();
    return { email, created, mail: !!this.data.mailAccess, recoveryOffServer: !!this.data.recoveryOffServer };
  },

  /* ---- доступ к ящику --------------------------------------------------------------- */

  /** Запомнить выданный сервером доступ к ящику (нужен открытый сейф). Без записи на диск:
   * вызывающий сохраняет аккаунт сам. */
  async _setMailAccess(mail) {
    if (!this.data || !mail || !mail.password) {
      return;
    }
    if (!Vault.unlocked) {
      return; // запросим у сервера заново, когда сейф откроют (mailAccess)
    }
    const bytes = utf8ToBytes(JSON.stringify(mail));
    try {
      this.data.mailAccess = await Vault.encrypt(MAIL_INFO, bytes);
    } finally {
      wipe(bytes);
    }
  },

  /** Доступ к ящику аккаунта: { address, login, password, imap, smtp } или null (нет входа,
   * сейф закрыт, локальный режим). Если сохранённого доступа нет или он не читается, у сервера
   * запрашивается новый пароль приложения: прежний при этом перестаёт действовать. */
  async mailAccess({ refresh = false } = {}) {
    await this.ready();
    if (!this.signedIn || this.isLocalMode || this.needsServerLink || !Vault.unlocked) {
      return null;
    }
    if (!refresh && this.data.mailAccess) {
      try {
        const bytes = await Vault.decrypt(MAIL_INFO, this.data.mailAccess);
        try {
          return JSON.parse(new TextDecoder().decode(bytes));
        } finally {
          wipe(bytes);
        }
      } catch (e) {
        console.error("Tabora account: сохранённый доступ к почте не читается, запрашиваем новый", e);
      }
    }
    if (!this._mailRefresh) {
      this._mailRefresh = (async () => {
        const r = await this.backend.mailPassword({ session: this.data.session });
        await this._setMailAccess(r.mail);
        await this.save();
        return r.mail || null;
      })().finally(() => {
        this._mailRefresh = null;
      });
    }
    return this._mailRefresh;
  },

  /** Сервер больше не признаёт сессию (выход с другого устройства, сброс или смена пароля там):
   * здесь аккаунт тоже считается вышедшим, а сейф закрывается до следующего входа. */
  async _sessionExpired(token) {
    await this.ready();
    if (!this.data?.session || this.data.session.token !== token) {
      return;
    }
    this.data.session = null;
    delete this.data.mailAccess;
    await this.save("signed-out");
    await Vault.lock();
  },

  login(emailInput, password, opts = {}) {
    return this._entering(() => this._login(emailInput, password, opts));
  },

  async _login(emailInput, password, { vaultPassword = null } = {}) {
    await this.ready();
    await Vault.guard.check();
    const email = this.normalizeEmail(emailInput);
    if (this.data?.email && this.data.email !== email) {
      // сейф и данные этого профиля принадлежат его аккаунту и другому не передаются
      throw bound(`Этот профиль принадлежит аккаунту ${this.data.email}. Аккаунт ${email} открывается в своём профиле: «Добавить аккаунт»`, { email });
    }
    if (!password) {
      throw new Error("Введите пароль");
    }
    if (this.needsServerLink && this.data.email === email && !vaultPassword) {
      // аккаунт этого компьютера ещё не на сервере: вход его и подключает
      const linked = await this._linkToServer(password);
      return { email, rebound: false, recoveryKey: null, rekeyComplete: true, recoveryNeedsUpgrade: this.recoveryNeedsUpgrade, linked: linked.created };
    }
    const deviceId = this.deviceId();
    const deviceName = this.deviceName();
    this._step("Проверяем пароль");
    const kdf = await this._kdfFor(email);
    const loginHash = await this.loginHash(email, password, kdf);
    this._step("Входим в аккаунт");
    let r;
    try {
      r = await this.backend.login({ email, loginHash, deviceId, deviceName });
    } catch (e) {
      if (e.code === "bad-credentials") {
        await Vault.guard.fail();
      }
      throw e;
    }
    // Счётчик попыток здесь не сбрасывается: успешный вход в аккаунт на сервере ничего не
    // говорит о пароле сейфа этого компьютера. Сбросит его только пароль, подошедший к сейфу.
    let usedKdf = Math.max(Number(r.kdf) || kdf, kdf);
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
    this._noteKdf(email, usedKdf);
    this._step("Открываем сейф");
    let rebound = null;
    await Vault.ready();
    if (vaultPassword && Vault.exists && Vault.hasPassword) {
      // Владелец назвал пароль сейфа: сначала проверяется он (это и есть попытка), и только
      // после этого пароль аккаунта сверяется с сейфом без счёта — владение уже доказано.
      await Vault.verifyPassword(vaultPassword).catch(e => {
        throw e.code === "bad-password" ? new Error("Неверный мастер-пароль сейфа") : e;
      });
      const same = password === vaultPassword || (await Vault.verifyPassword(password, { count: false }).then(() => true, e => (e.code === "bad-password" ? false : Promise.reject(e))));
      if (same) {
        if (!Vault.unlocked) {
          await Vault.unlockWithPassword(password);
        }
      } else {
        rebound = await this._rebindVault(vaultPassword, password);
      }
    } else {
      await this._syncVaultPassword(password);
    }
    await Vault.guard.success(); // пароль подошёл к сейфу (или сейф привязан после проверки владельца)
    const prior = this.data?.email === email ? this.data : null;
    this.data = { version: 1, email, userId: r.userId, session: r.session, server: this.serverUrl || null, kdf: usedKdf, createdAt: prior ? prior.createdAt : new Date().toISOString(), lastLoginAt: new Date().toISOString() };
    if (prior?.recoveryRegisteredAt && !rebound) {
      // тот же аккаунт: сведения о ключе проверки на сервере сохраняются (см. recoveryNeedsUpgrade)
      this.data.recoveryRegisteredAt = prior.recoveryRegisteredAt;
      this.data.recoveryScheme = prior.recoveryScheme || null;
    }
    if (prior?.recoveryOffServer && !rebound) {
      this.data.recoveryOffServer = true;
    }
    await this._setMailAccess(r.mail);
    await this.save("signed-in");
    this.markFirstRunDone();
    let recoveryKey = null;
    if (rebound) {
      recoveryKey = rebound.recoveryKey;
      await this.registerRecoveryKey(recoveryKey);
    }
    return { email, rebound: !!rebound, recoveryKey, rekeyComplete: rebound ? rebound.complete : true, recoveryNeedsUpgrade: this.recoveryNeedsUpgrade };
  },

  /** Смена пароля аккаунта и мастер-пароля сейфа вместе. rotate: true — заодно сменить ключ
   * сейфа K и перешифровать данные; тогда прежний ключ восстановления заменяется новым,
   * он возвращается в { recoveryKey }. */
  async changePassword(oldPassword, newPassword, { rotate = false } = {}) {
    await this.ready();
    this._step(rotate ? "Меняем пароль и ключ сейфа" : "Меняем пароль");
    if (!this.signedIn) {
      throw new Error("Вы не вошли в аккаунт");
    }
    checkPassword(newPassword);
    if (oldPassword === newPassword) {
      throw new Error("Новый пароль совпадает с текущим");
    }
    await Vault.ready();
    let ownerConfirmed = false;
    if (Vault.hasPassword) {
      await Vault.verifyPassword(oldPassword).catch(e => {
        throw e.code === "locked-out" ? e : new Error("Неверный текущий пароль");
      });
    } else {
      await Vault.guard.check();
      if (Vault.exists) {
        // сейфу без пароля задаётся пароль: проверка владельца до обращения к серверу
        await this._confirmVaultOwner();
        ownerConfirmed = true;
      }
    }
    const kdf = await this._kdfFor(this.email);
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
      await this._syncVaultPassword(newPassword, { ownerConfirmed });
      if (rotate) {
        result = await Vault.rotateKey({ password: newPassword, reason: "password" });
      }
    }
    if (result.recoveryKey) {
      await this.registerRecoveryKey(result.recoveryKey);
    }
    this._noteKdf(this.email, KDF_CURRENT);
    this.data.kdf = KDF_CURRENT;
    this.data.passwordChangedAt = new Date().toISOString();
    await this.save();
    return result;
  },

  /** Забытый пароль: сейф открывается ключом восстановления, сервер получает запрос с
   * одноразовым nonce, подписанный ключом Ed25519 из ключа восстановления (у сервера только
   * открытый ключ); затем новый пароль задаётся и аккаунту, и сейфу. Аккаунт с ключом
   * проверки прежней схемы этим же запросом переводится на открытый ключ. */
  resetPasswordWithRecovery(recoveryKey, newPassword) {
    return this._entering(() => this._resetPasswordWithRecovery(recoveryKey, newPassword));
  },

  async _resetPasswordWithRecovery(recoveryKey, newPassword) {
    await this.ready();
    this._step("Проверяем ключ восстановления");
    if (!this.email) {
      throw new Error("На этом компьютере нет аккаунта");
    }
    checkPassword(newPassword);
    await Vault.ready();
    await Vault.unlockWithRecoveryKey(recoveryKey);
    const newLoginHash = await this.loginHash(this.email, newPassword, KDF_CURRENT);
    const signer = Vault.recoverySigner(recoveryKey);
    const legacyKey = this.data.recoveryScheme === "ed25519" ? null : Vault.recoveryAuthKey(recoveryKey);
    try {
      const { nonce } = await this.backend.resetChallenge({ email: this.email });
      const n = String(nonce || "");
      await this.backend.resetPassword({
        email: this.email,
        nonce,
        recoveryProof: bytesToHex(signer.sign(resetMessage(this.email, newLoginHash, n))),
        // прежняя схема: подпись общим ключом принимается один раз, вместе с переводом на
        // открытый ключ; если аккаунт уже переведён, сервер эти поля игнорирует
        legacyRecoveryProof: legacyKey ? legacyResetProof(legacyKey, this.email, newLoginHash, n) : null,
        newRecoveryVerifier: verifierOf(signer.publicKey),
        newLoginHash,
        kdf: KDF_CURRENT,
        // только локальный режим: аккаунт старше ключа проверки, а ключ восстановления
        // только что открыл сейф на этом же компьютере — регистрируем ключ проверки заодно
        legacyVaultProof: this.isLocalMode,
      });
    } finally {
      wipe(signer.seed);
      wipe(legacyKey);
    }
    await Vault.setPassword(newPassword);
    this._noteKdf(this.email, KDF_CURRENT);
    this.data.recoveryRegisteredAt ||= new Date().toISOString();
    this.data.recoveryScheme = "ed25519";
    this.data.kdf = KDF_CURRENT;
    this.data.passwordChangedAt = new Date().toISOString();
    if (!this.isLocalMode) {
      // сервер после сброса завершил все сессии и отозвал доступ к почте
      this.data.session = null;
      delete this.data.mailAccess;
    }
    await this.save();
    if (!this.signedIn) {
      // сброс заканчивается входом: без него сейф закрылся бы обратно
      await this._login(this.email, newPassword);
    }
    return true;
  },

  /** Выход: сессия удаляется, сейф блокируется. Пароли сайтов, коды, кошелёк и почта закрыты
   * до следующего входа в этот же аккаунт: профиль остаётся за ним. */
  async logout() {
    await this.ready();
    if (!this.data) {
      await Vault.lock();
      return;
    }
    try {
      await this.backend.logout({ session: this.data.session });
    } catch (e) {}
    this.data.session = null;
    delete this.data.mailAccess; // сервер отозвал пароль приложения этого устройства
    await this.save("signed-out");
    await Vault.lock(); // если идёт операция с ключом, блокировка применится сразу после неё
  },

  async devices() {
    await this.ready();
    if (!this.data) {
      return [];
    }
    return this.backend.devices({ email: this.email, session: this.data.session });
  },

  /* ---- алиасы (хранит сервер) ---------------------------------------------------------- */

  _session() {
    if (!this.signedIn) {
      throw Object.assign(new Error("Войдите в аккаунт Tabora"), { code: "signed-out" });
    }
    return this.data.session;
  },

  async aliases() {
    await this.ready();
    return this.needsServerLink ? [] : this.backend.aliases({ session: this._session() });
  },

  async aliasCreate({ site = "", space = "", by = "manual" } = {}) {
    await this.ready();
    return this.backend.aliasCreate({ session: this._session(), site, space, by });
  },

  async aliasUpdate(id, patch) {
    await this.ready();
    return this.backend.aliasUpdate({ session: this._session(), id, ...patch });
  },

  async aliasDelete(id) {
    await this.ready();
    return this.backend.aliasDelete({ session: this._session(), id });
  },
};

/* Смена ключа сейфа: сохранённый доступ к ящику перешифровывается новым подключом. Не
 * обязательна: если не удалась, доступ запрашивается у сервера заново (mailAccess). */
Vault.registerRekey(MAIL_INFO, async ({ decryptOld, encryptNew }) => {
  await Account.ready();
  const box = Account.data?.mailAccess;
  if (!box) {
    return;
  }
  const bytes = await decryptOld(MAIL_INFO, box);
  try {
    Account.data.mailAccess = await encryptNew(MAIL_INFO, bytes);
    await Account.save();
  } finally {
    wipe(bytes);
  }
});
