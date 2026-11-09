/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Сейф Tabora: один случайный ключ K (256 бит), которым шифруются пароли сайтов
 * (Rust-хранилище Firefox), секреты одноразовых кодов и кэш почты. Сам K лежит в файле
 * tabora-vault.json только в обёртках:
 *   - os: через хранилище ключей системы (Keychain на macOS, nsIOSKeyStore) — тихая
 *     разблокировка на этом компьютере;
 *   - pw: AES-GCM ключом Argon2id(мастер-пароль) — для переноса на другой компьютер;
 *   - rk: ключом из ключа восстановления.
 * Блок check позволяет убедиться, что распакован именно K. Открытый K существует
 * только в памяти, пока сейф разблокирован. Пароли и секреты модуль не хранит:
 * он выдаёт производные ключи другим модулям и перешифровывает их данные при смене K
 * (registerRekey). Повреждённый файл не заменяется молча: он переносится в сторону,
 * а пользователь выбирает, как восстановиться. */

const C = ChromeUtils.importESModule("chrome://tabora/content/wallet/vendor/crypto.sys.mjs");
const { randomBytes, base64, utf8ToBytes, hmac, sha256 } = C;
const { OSKeyStore } = ChromeUtils.importESModule("resource://gre/modules/OSKeyStore.sys.mjs");
const { argon2idAsync } = ChromeUtils.importESModule("chrome://tabora/content/vault/Kdf.sys.mjs");
const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

const FILE = () => PathUtils.join(PathUtils.profileDir, "tabora-vault.json");
const BACKUP = () => PathUtils.join(PathUtils.profileDir, "tabora-vault.json.bak");
const GUARD_FILE = () => PathUtils.join(PathUtils.profileDir, "tabora-auth-guard.json");
const KDF = { t: 3, m: 65536, p: 1, dkLen: 32 }; // Argon2id: 64 МБ, 3 прохода
const CHECK = "tabora-vault-v1";
const MIN_PASSWORD = 6;
const RK_INFO = "tabora-vault-recovery-v1";
const RK_ACCOUNT_INFO = "tabora-account-recovery-v1";
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
// Модули, чьи данные зашифрованы подключами сейфа. Перед сменой ключа они загружаются,
// чтобы успеть подписаться на перешифровку (см. registerRekey).
const REKEY_MODULES = ["chrome://tabora/content/vault/Otp.sys.mjs", "chrome://tabora/content/mail/MailStore.sys.mjs"];
// Файлы, зашифрованные ключом сейфа: при осознанном создании нового сейфа после
// повреждения они переносятся в сторону, а не перезаписываются.
const DEPENDENT_FILES = ["logins.db", "logins.db-wal", "logins.db-shm", "tabora-otp.json", "tabora-otp.json.bak", "tabora-mail.json"];

/** Ключ восстановления: 20 случайных байт, показывается как 8 групп по 4 символа Base32. */
function rkFormat(bytes) {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = ((value << 8) | b) >>> 0;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
      value &= (1 << bits) - 1;
    }
  }
  return out.match(/.{1,4}/g).join("-");
}

function rkParse(text) {
  const clean = String(text || "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/0/g, "O").replace(/1/g, "L").replace(/8/g, "B");
  if (clean.length !== 32 || /[^A-Z2-7]/.test(clean)) {
    throw new Error("Ключ восстановления: 32 символа в 8 группах по 4");
  }
  const out = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    value = ((value << 5) | B32.indexOf(ch)) >>> 0;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }
  return Uint8Array.from(out);
}

function rkDerive(rk) {
  return hmac(sha256, rk, utf8ToBytes(RK_INFO));
}

function wipe(...arrays) {
  for (const a of arrays) {
    if (a && a.fill) {
      a.fill(0);
    }
  }
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function subkeyOf(key, info) {
  return hmac(sha256, key, utf8ToBytes(`tabora-vault/${info}`));
}

function jwkOf(bytes) {
  const b64url = base64.encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return JSON.stringify({ kty: "oct", k: b64url, kid: "tabora-passwords" });
}

async function aesKey(raw) {
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encrypt(raw, plaintext) {
  const iv = randomBytes(12);
  const key = await aesKey(raw);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
  return { iv: base64.encode(iv), ct: base64.encode(ct) };
}

async function decrypt(raw, box) {
  const key = await aesKey(raw);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64.decode(box.iv) }, key, base64.decode(box.ct)));
}

async function deriveKey(password, salt, kdf) {
  const t = Number(kdf?.t);
  const m = Number(kdf?.m);
  const p = Number(kdf?.p);
  const dkLen = Number(kdf?.dkLen);
  // параметры приходят из файла: вне границ это повреждение или попытка подвесить браузер
  if (!(t >= 1 && t <= 10) || !(m >= 8192 && m <= 1 << 20) || !(p >= 1 && p <= 4) || dkLen !== 32 || !(salt?.length >= 8)) {
    throw new Error("Файл сейфа повреждён: параметры KDF вне допустимых границ");
  }
  return argon2idAsync(utf8ToBytes(password.normalize("NFKC")), salt, { t, m, p, dkLen });
}

function checkPasswordLength(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD) {
    throw new Error(`Мастер-пароль не короче ${MIN_PASSWORD} символов`);
  }
}

/* ---------- стойкость пароля ---------- */

const COMMON = new Set(["password", "password1", "password12", "password123", "password1234", "passwordpassword", "qwerty", "qwerty12", "qwerty123", "qwerty123456", "qwertyuiop", "qwertyuiop12", "qwertyuiopas", "123456", "1234567", "12345678", "123456789", "1234567890", "123456789012", "1234567890ab", "111111", "000000", "123123", "123123123123", "111111111111", "000000000000", "abc123", "abcdef", "abcdefghijkl", "aaaaaaaaaaaa", "iloveyou", "iloveyou1234", "admin", "admin123", "administrator", "welcome", "welcome1", "welcome12345", "letmein", "letmein12345", "monkey", "dragon", "sunshine", "sunshine1234", "princess", "princess1234", "football", "football1234", "baseball", "baseball1234", "superman", "superman1234", "trustno1", "trustno1trustno1", "passw0rd", "passw0rdpassw0rd", "1q2w3e4r", "1q2w3e4r5t6y", "zaq12wsx", "zaq12wsxcde3", "пароль", "пароль123", "йцукен", "qazwsx", "master", "tabora", "tabora123"]);
const SEQUENCES = ["0123456789", "abcdefghijklmnopqrstuvwxyz", "qwertyuiop", "asdfghjkl", "zxcvbnm", "йцукенгшщзхъ", "фывапролджэ", "ячсмитьбю", "абвгдеёжзийклмнопрстуфхцчшщъыьэюя", "1qaz2wsx3edc", "qazwsxedc"];
const WORDS = ["password", "passw0rd", "qwerty", "admin", "letmein", "welcome", "iloveyou", "пароль", "tabora", "login", "master"];

/** Оценка стойкости 0..4: 0 — не принимается вовсе, 1 — слабый (тоже не принимается). Оценка
 * считает примерную энтропию по алфавиту и длине и штрафует распространённые шаблоны:
 * последовательности, повторы, годы, известные слова. */
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
  let pool = 0;
  if (/[a-z]/.test(p)) {
    pool += 26;
  }
  if (/[A-Z]/.test(p)) {
    pool += 26;
  }
  if (/[а-яё]/.test(p)) {
    pool += 33;
  }
  if (/[А-ЯЁ]/.test(p)) {
    pool += 33;
  }
  if (/\d/.test(p)) {
    pool += 10;
  }
  if (/[^\p{L}\p{N}]/u.test(p)) {
    pool += 33;
  }
  if (/[^a-zA-Zа-яёА-ЯЁ\d\x20-\x7e]/.test(p)) {
    pool += 40; // прочие буквы
  }
  let bits = p.length * Math.log2(Math.max(pool, 10));
  const unique = new Set(p).size;
  if (unique < p.length / 2) {
    bits *= 0.6;
  }
  if (/^(.{1,4})\1+.?$/.test(p)) {
    bits *= 0.4; // повтор короткого куска: abcabcabc
  }
  let reason = "";
  for (const seq of SEQUENCES) {
    for (let i = 0; i + 4 <= seq.length; i++) {
      const chunk = seq.slice(i, i + 4);
      if (lower.includes(chunk) || lower.includes([...chunk].reverse().join(""))) {
        bits -= 10;
        reason = "похож на последовательность";
        i = seq.length;
      }
    }
  }
  if (/(19|20)\d\d/.test(p)) {
    bits -= 6;
  }
  for (const w of WORDS) {
    if (lower.includes(w)) {
      bits -= 15;
      reason ||= "содержит распространённое слово";
      break;
    }
  }
  let score = 1;
  if (bits >= 32) {
    score = 2;
  }
  if (bits >= 45) {
    score = 3;
  }
  if (bits >= 64) {
    score = 4;
  }
  return { score, label: score === 1 && reason ? `слабый: ${reason}` : ["слабый", "слабый", "средний", "хороший", "отличный"][score] };
}

/** Новый пароль: не короче 6 символов и не «слабый». */
export function checkNewPassword(password) {
  const s = passwordStrength(password);
  if (s.score < 2) {
    throw new Error(`Пароль: ${s.label}. Добавьте длины, цифр или знаков`);
  }
  return s;
}

/* ---------- счётчик неудачных попыток ---------- */

/** Неверные пароли считаются во всех проверках (вход, разблокировка, смена пароля, перепривязка)
 * и хранятся в файле: перезапуск браузера паузу не снимает. После трёх ошибок пауза 5 с,
 * затем удваивается до 15 минут. */
const Guard = {
  _d: null,

  async _load() {
    if (!this._d) {
      let d = {};
      try {
        d = (await IOUtils.readJSON(GUARD_FILE())) || {};
      } catch (e) {}
      this._d = { failures: Number(d.failures) || 0, lockedUntil: Number(d.lockedUntil) || 0, lastAt: Number(d.lastAt) || 0 };
    }
    return this._d;
  },

  async _save() {
    try {
      await IOUtils.writeJSON(GUARD_FILE(), this._d, { tmpPath: GUARD_FILE() + ".tmp" });
      await IOUtils.setPermissions(GUARD_FILE(), 0o600);
    } catch (e) {
      console.error("Tabora vault: счётчик попыток не сохранён", e);
    }
  },

  delayFor(failures) {
    return failures < 3 ? 0 : Math.min(15 * 60000, 5000 * 2 ** (failures - 3));
  },

  async check() {
    const d = await this._load();
    const now = Date.now();
    let until = d.lockedUntil;
    if (now < d.lastAt) {
      // часы перевели назад: пауза отсчитывается от текущего момента
      until = Math.max(until, now + this.delayFor(d.failures));
    }
    if (now < until) {
      const s = Math.ceil((until - now) / 1000);
      const wait = s >= 120 ? `${Math.ceil(s / 60)} мин` : `${s} с`;
      throw Object.assign(new Error(`Слишком много неверных попыток: подождите ${wait}`), { code: "locked-out", retryAt: until });
    }
  },

  async fail() {
    const d = await this._load();
    d.failures++;
    d.lastAt = Date.now();
    d.lockedUntil = d.lastAt + this.delayFor(d.failures);
    await this._save();
  },

  async success() {
    const d = await this._load();
    if (d.failures || d.lockedUntil) {
      d.failures = 0;
      d.lockedUntil = 0;
      await this._save();
    }
  },
};

function validBox(b) {
  return !!b && typeof b === "object" && typeof b.iv === "string" && typeof b.ct === "string";
}

/** Пустая строка, если файл сейфа похож на настоящий, иначе причина. */
function validate(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "файл не похож на сейф";
  }
  if (data.version !== 1) {
    return "неизвестная версия файла";
  }
  if (!validBox(data.check)) {
    return "нет проверочного блока";
  }
  if (!(data.os?.ct || validBox(data.pw) || validBox(data.rk))) {
    return "нет ни одной обёртки ключа";
  }
  return "";
}

Services.obs.addObserver(() => Vault._onQuit(), "quit-application-granted");

export const Vault = {
  TOPIC: "tabora-vault-changed",
  MIN_PASSWORD,
  passwordStrength,
  checkNewPassword,
  guard: Guard,
  data: null, // файл: обёртки ключа и настройки, секретов здесь нет
  state: "unknown", // absent | ok | corrupt
  corrupt: null, // { reason, movedTo, backup, salvage, unreadable } для повреждённого файла
  needsPassword: false, // перешифровке паролей из-под основного пароля Firefox нужен мастер-пароль
  passwordsMode: null, // vault | nss — каким ключом сейчас зашифровано хранилище паролей
  _key: null, // K, пока сейф разблокирован
  _prevKey: null, // прежний K, пока смена ключа не завершена
  _explicitLock: false, // заблокирован пользователем: тихая разблокировка запрещена до его действия
  _loaded: false,
  _loading: null,
  _unlocking: null,
  _queue: Promise.resolve(),
  _waiters: [],
  _rekeyHooks: new Map(),

  async ready() {
    if (this._loaded) {
      return this.data;
    }
    if (!this._loading) {
      this._loading = this._load().finally(() => {
        this._loading = null;
      });
    }
    await this._loading;
    return this.data;
  },

  async _load() {
    let raw;
    try {
      raw = await IOUtils.readUTF8(FILE());
    } catch (e) {
      if (e.name === "NotFoundError") {
        this.data = null;
        this.state = "absent";
        this._loaded = true;
        return;
      }
      // файл есть, но не читается (права, диск): не трогаем его и не создаём новый
      console.error("Tabora vault: файл сейфа не читается", e);
      this.data = null;
      this.state = "corrupt";
      this.corrupt = { reason: `файл не читается (${e.message})`, unreadable: true, movedTo: null, backup: await this._readBackup(), salvage: null };
      this._loaded = true;
      return;
    }
    let data = null;
    let reason;
    try {
      data = JSON.parse(raw);
      reason = validate(data);
    } catch (e) {
      reason = "файл не разбирается как JSON";
    }
    if (!reason) {
      this.data = data;
      this.state = "ok";
      this._loaded = true;
      return;
    }
    // Повреждён: переносим в сторону и ждём решения пользователя. Новый ключ молча не
    // создаём, иначе пароли и коды под прежним ключом стали бы нечитаемыми навсегда.
    console.error(`Tabora vault: файл сейфа повреждён: ${reason}`);
    let movedTo = null;
    try {
      movedTo = `${FILE()}.corrupt-${stamp()}`;
      await IOUtils.move(FILE(), movedTo, { noOverwrite: true });
      await IOUtils.setPermissions(movedTo, 0o600).catch(() => {});
    } catch (e) {
      console.error("Tabora vault: повреждённый файл не перенесён", e);
      movedTo = null;
    }
    const salvage = data && typeof data === "object" ? { rk: validBox(data.rk) ? data.rk : null, check: validBox(data.check) ? data.check : null } : null;
    this.data = null;
    this.state = "corrupt";
    this.corrupt = { reason, movedTo, backup: await this._readBackup(), salvage, unreadable: false };
    this._loaded = true;
  },

  async _readBackup() {
    try {
      const b = await IOUtils.readJSON(BACKUP());
      return validate(b) ? null : b;
    } catch (e) {
      return null;
    }
  },

  get exists() {
    return !!this.data;
  },

  get unlocked() {
    return !!this._key;
  },

  get hasPassword() {
    return !!this.data?.pw;
  },

  get hasOsKey() {
    return !!this.data?.os;
  },

  /** Тихая разблокировка через систему разрешена настройкой (по умолчанию да). */
  get osUnlockEnabled() {
    return this.data?.settings?.osUnlock !== false;
  },

  /** Сейф заблокирован пользователем: открыть его можно только его действием. */
  get explicitlyLocked() {
    return this._explicitLock && !this._key;
  },

  /** Смена ключа начата, но не все данные перешифрованы. */
  get rekeyPending() {
    return !!this.data?.prev;
  },

  get waiting() {
    return this._waiters.length > 0;
  },

  notify(what = "changed") {
    Services.obs.notifyObservers(null, this.TOPIC, what);
  },

  requireUnlocked() {
    if (!this._key) {
      throw new Error("Сейф заблокирован");
    }
  },

  /** Изменения файла и ключа выполняются строго по очереди: иначе, например, два
   * одновременных создания сейфа дали бы два разных K, и пароли под первым пропали бы. */
  _exclusive(fn) {
    const run = this._queue.then(fn, fn);
    this._queue = run.catch(() => {});
    return run;
  },

  async _save() {
    this.data.rev = (this.data.rev || 0) + 1;
    this.data.updatedAt = new Date().toISOString();
    await IOUtils.writeJSON(FILE(), this.data, { tmpPath: FILE() + ".tmp" });
    try {
      await IOUtils.setPermissions(FILE(), 0o600);
    } catch (e) {}
    // копия того же содержимого: если основной файл повредят, сейф восстановится из неё
    try {
      await IOUtils.writeJSON(BACKUP(), this.data, { tmpPath: BACKUP() + ".tmp" });
      await IOUtils.setPermissions(BACKUP(), 0o600);
    } catch (e) {
      console.error("Tabora vault: запасная копия не записана", e);
    }
    this.notify();
  },

  save() {
    return this._save();
  },

  /* ---------- создание и обёртки ---------- */

  async _wrapOs(key) {
    try {
      return { ct: await OSKeyStore.encrypt(base64.encode(key)) };
    } catch (e) {
      console.error("Tabora vault: OSKeyStore недоступен", e);
      return null;
    }
  },

  /** reauth: false — тихо; строка — системная проверка (Touch ID или пароль macOS) с этим текстом. */
  async _unwrapOs(box, reauth = false) {
    const text = await OSKeyStore.decrypt(box.ct, "tabora-vault", reauth);
    return base64.decode(text);
  },

  async _wrapPassword(key, password) {
    checkPasswordLength(password);
    const salt = randomBytes(16);
    const raw = await deriveKey(password, salt, KDF);
    try {
      return { kdf: { alg: "argon2id", salt: base64.encode(salt), ...KDF }, ...(await encrypt(raw, key)) };
    } finally {
      wipe(raw);
    }
  },

  async _unwrapPassword(box, password) {
    const raw = await deriveKey(String(password ?? ""), base64.decode(box.kdf.salt), box.kdf);
    try {
      return await decrypt(raw, box);
    } catch (e) {
      throw Object.assign(new Error("Неверный мастер-пароль"), { code: "bad-password" });
    } finally {
      wipe(raw);
    }
  },

  async _verify(key, check = this.data?.check) {
    try {
      const plain = await decrypt(key, check);
      const ok = new TextDecoder().decode(plain) === CHECK;
      wipe(plain);
      return ok;
    } catch (e) {
      return false;
    }
  },

  _adopt(key) {
    wipe(this._key);
    this._key = key;
    this._explicitLock = false;
    wipe(this._prevKey);
    this._prevKey = null;
    const waiters = this._waiters;
    this._waiters = [];
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.resolve(true);
    }
    this.notify("unlocked");
    if (this.rekeyPending) {
      this._prev().catch(e => console.error("Tabora vault: прежний ключ не читается", e));
      // прошлая смена ключа не завершилась: доделываем, когда все модули успеют подписаться
      setTimeout(() => this.resumeRekey().catch(e => console.error("Tabora vault: перешифровка не завершена", e)), 2000);
    }
  },

  /** Ждёт разблокировки. timeoutMs — сколько ждать; cancellable — можно отменить из интерфейса
   * (cancelWaiting). При выходе из браузера ожидание отклоняется, чтобы не держать остановку. */
  waitUnlocked({ timeoutMs = 0, cancellable = false } = {}) {
    if (this.unlocked) {
      return Promise.resolve(true);
    }
    return new Promise((resolve, reject) => {
      const w = { resolve, reject, cancellable, timer: null };
      if (timeoutMs) {
        w.timer = setTimeout(() => {
          this._waiters = this._waiters.filter(x => x !== w);
          reject(Object.assign(new Error("Сейф не разблокирован"), { code: "timeout" }));
          this.notify("waiting-done");
        }, timeoutMs);
      }
      this._waiters.push(w);
    });
  },

  /** Модулю нужен ключ (например, хранилищу паролей после блокировки): просим интерфейс
   * показать разблокировку и ждём. Сам сейф при этом не открывается. */
  async requestUnlock(reason = "passwords", { timeoutMs = 60000 } = {}) {
    await this.ready();
    if (this.unlocked) {
      return true;
    }
    const p = this.waitUnlocked({ timeoutMs, cancellable: true });
    this.waitingReason = reason;
    this.notify("waiting");
    return p;
  },

  cancelWaiting() {
    const keep = [];
    for (const w of this._waiters) {
      if (w.cancellable) {
        clearTimeout(w.timer);
        w.reject(Object.assign(new Error("Разблокировка отменена"), { code: "cancelled" }));
      } else {
        keep.push(w);
      }
    }
    this._waiters = keep;
    this.notify("waiting-done");
  },

  _onQuit() {
    const waiters = this._waiters;
    this._waiters = [];
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.reject(new Error("Браузер закрывается"));
    }
  },

  /* ---------- пароли сайтов (Rust-хранилище Firefox) ---------- */

  /** Ключ для хранилища паролей в формате JWK, который принимает статический менеджер ключей
   * app-services logins (kty oct, 32 байта). Сейф при необходимости создаётся сам: без
   * мастер-пароля, только под связкой ключей системы. Повреждённый файл сейфа здесь не
   * заменяется: хранилище ждёт, пока пользователь выберет восстановление. */
  async ensureForPasswords() {
    await this.ready();
    if (this.state === "absent") {
      await this._exclusive(() => (this.exists || this.state !== "absent" ? null : this._create({})));
    }
    if (!this.unlocked && this.exists) {
      await this.unlock();
    }
    if (!this.unlocked) {
      // интерфейс покажет просьбу ввести мастер-пароль или выбрать восстановление:
      // сразу, если окно уже есть, или при загрузке окна по флагу waiting
      const p = this.waitUnlocked();
      this.waitingReason = this.state === "corrupt" ? "corrupt" : "startup";
      this.notify(this.state === "corrupt" ? "corrupt" : "waiting");
      await p;
    }
    return this.passwordsKeyJwk();
  },

  passwordsKeyJwk() {
    const k = this.subkey("passwords");
    try {
      return jwkOf(k);
    } finally {
      wipe(k);
    }
  },

  /** Ключ хранилища паролей от прежнего K, пока смена ключа не завершена (иначе null). */
  async prevPasswordsKeyJwk() {
    const prev = await this._prev();
    if (!prev) {
      return null;
    }
    const k = subkeyOf(prev, "passwords");
    try {
      return jwkOf(k);
    } finally {
      wipe(k);
    }
  },

  /** Перешифровке паролей из-под основного пароля Firefox нужен мастер-пароль сейфа:
   * интерфейс попросит его задать (иначе защита паролей молча ослабла бы). */
  requestPasswordForMigration() {
    this.needsPassword = true;
    this.notify("need-password");
  },

  /** Новый сейф: ключ K, обёртка системы и, если задан, мастер-пароль. checkStrength: false —
   * пароль уже принят раньше (пароль существующего аккаунта), проверяется только длина. */
  async create({ password = "", checkStrength = true } = {}) {
    return this._exclusive(async () => {
      await this.ready();
      if (this.state === "corrupt") {
        throw new Error("Файл сейфа повреждён: выберите восстановление или создайте новый сейф осознанно");
      }
      if (this.exists) {
        throw new Error("Сейф уже создан");
      }
      return this._create({ password, checkStrength });
    });
  },

  async _create({ password = "", checkStrength = true } = {}) {
    if (password) {
      if (checkStrength) {
        checkNewPassword(password);
      } else {
        checkPasswordLength(password);
      }
    }
    const key = randomBytes(32);
    const data = {
      version: 1,
      createdAt: new Date().toISOString(),
      rev: 0,
      settings: { osUnlock: true },
      check: await encrypt(key, utf8ToBytes(CHECK)),
      os: await this._wrapOs(key),
      pw: password ? await this._wrapPassword(key, password) : null,
    };
    if (!data.os && !data.pw) {
      wipe(key);
      throw new Error("Хранилище ключей системы недоступно: задайте мастер-пароль");
    }
    this.data = data;
    this.state = "ok";
    await this._save();
    if (password) {
      this._passwordSet();
    }
    this._adopt(key);
    return true;
  },

  _passwordSet() {
    if (this.needsPassword) {
      this.needsPassword = false;
      this.notify("password-set");
    }
  },

  /* ---------- повреждённый файл ---------- */

  /** Восстановить из запасной копии (tabora-vault.json.bak). */
  async restoreBackup() {
    return this._exclusive(async () => {
      const backup = this.corrupt?.backup;
      if (this.state !== "corrupt" || !backup) {
        throw new Error("Запасной копии сейфа нет");
      }
      this.data = backup;
      this.state = "ok";
      this.corrupt = null;
      await this._save();
      this.notify("restored");
    }).then(() => this.unlock());
  },

  /** Восстановить ключом восстановления: обёртка rk берётся из запасной копии или уцелевшей
   * части повреждённого файла. Мастер-пароль после этого задаётся заново. */
  async recoverCorrupt(text) {
    return this._exclusive(async () => {
      const c = this.corrupt;
      const box = c?.backup?.rk || c?.salvage?.rk;
      if (this.state !== "corrupt" || !box) {
        throw new Error("Обёртка ключа восстановления не сохранилась: восстановить этим способом нельзя");
      }
      const rk = rkParse(text);
      const k = rkDerive(rk);
      let key;
      try {
        key = await decrypt(k, box);
      } catch (e) {
        throw new Error("Неверный ключ восстановления");
      } finally {
        wipe(k, rk);
      }
      const check = c.backup?.check || c.salvage?.check;
      if (check && !(await this._verify(key, check))) {
        wipe(key);
        throw new Error("Ключ восстановления от другого сейфа");
      }
      const base = c.backup ? { ...c.backup } : { version: 1, createdAt: new Date().toISOString(), rev: 0, settings: { osUnlock: true }, rk: box, pw: null };
      base.check = check || (await encrypt(key, utf8ToBytes(CHECK)));
      base.os = base.settings?.osUnlock !== false ? await this._wrapOs(key) : null;
      this.data = base;
      this.state = "ok";
      this.corrupt = null;
      await this._save();
      this._adopt(key);
      return true;
    });
  },

  /** Осознанно начать заново: новый K. Файлы под прежним ключом (пароли, коды, почта)
   * не удаляются, а переносятся в сторону с пометкой vault-lost: если прежний файл сейфа
   * найдётся, их можно будет вернуть. */
  async startOverAfterCorrupt() {
    return this._exclusive(async () => {
      if (this.state !== "corrupt") {
        throw new Error("Сейф не повреждён");
      }
      const tag = `vault-lost-${stamp()}`;
      for (const name of DEPENDENT_FILES) {
        const path = PathUtils.join(PathUtils.profileDir, name);
        try {
          if (await IOUtils.exists(path)) {
            await IOUtils.move(path, `${path}.${tag}`, { noOverwrite: true });
          }
        } catch (e) {
          console.error(`Tabora vault: ${name} не перенесён`, e);
        }
      }
      Services.prefs.setBoolPref("tabora.vault.passwordsRekeyed", true);
      this.state = "absent";
      this.corrupt = null;
      this.notify("reset"); // модули сбрасывают данные в памяти
      return this._create({});
    });
  },

  /* ---------- разблокировка ---------- */

  /** Разблокировка через хранилище ключей системы. Без user — тихо; после явной блокировки
   * тихо не открывается. С user: true — системная проверка (Touch ID или пароль macOS).
   * Возвращает true, если удалось. */
  async unlock({ user = false, prompt = "разблокировать сейф Tabora" } = {}) {
    await this.ready();
    if (this.unlocked) {
      return true;
    }
    if (!this.exists || !this.data.os || !this.osUnlockEnabled) {
      return false;
    }
    if (this._explicitLock && !user) {
      return false;
    }
    if (!this._unlocking || user) {
      const attempt = (async () => {
        try {
          const key = await this._unwrapOs(this.data.os, user && OSKeyStore.canReauth() ? prompt : false);
          if (!(await this._verify(key))) {
            wipe(key);
            console.error("Tabora vault: ключ из хранилища системы не подходит к сейфу");
            return false;
          }
          if (!this.unlocked) {
            this._adopt(key);
          } else {
            wipe(key);
          }
          return true;
        } catch (e) {
          if (e.result !== Cr.NS_ERROR_ABORT) {
            console.error("Tabora vault: разблокировка через систему не удалась", e);
          }
          return false;
        } finally {
          if (this._unlocking === attempt) {
            this._unlocking = null;
          }
        }
      })();
      this._unlocking = attempt;
    }
    return this._unlocking;
  },

  /** Разблокировка мастер-паролем; на новом компьютере заодно создаёт обёртку системы.
   * count: false — не считать ошибку попыткой подбора (см. verifyPassword). */
  async unlockWithPassword(password, { count = true } = {}) {
    await this.ready();
    if (!this.exists) {
      throw new Error(this.state === "corrupt" ? "Файл сейфа повреждён" : "Сейф не создан");
    }
    if (!this.data.pw) {
      throw new Error("Мастер-пароль не задан: сейф открывается только на этом компьютере");
    }
    if (count) {
      await Guard.check();
    }
    let key;
    try {
      key = await this._unwrapPassword(this.data.pw, password);
    } catch (e) {
      if (count && e.code === "bad-password") {
        await Guard.fail();
      }
      throw e;
    }
    if (count) {
      await Guard.success();
    }
    if (!(await this._verify(key))) {
      wipe(key);
      throw new Error("Файл сейфа повреждён");
    }
    if (this.unlocked) {
      wipe(key);
      return true;
    }
    this._adopt(key);
    if (!this.data.os && this.osUnlockEnabled) {
      await this._exclusive(async () => {
        const os = await this._wrapOs(this._key);
        if (os) {
          this.data.os = os;
          await this._save();
        }
      });
    }
    return true;
  },

  /** Проверка мастер-пароля без разблокировки. count: false — не считать ошибку попыткой
   * подбора (например, когда сверяем пароль только что вошедшего аккаунта с сейфом). */
  async verifyPassword(password, { count = true } = {}) {
    await this.ready();
    if (!this.data?.pw) {
      throw new Error("Мастер-пароль не задан");
    }
    if (count) {
      await Guard.check();
    }
    let key;
    try {
      key = await this._unwrapPassword(this.data.pw, password);
    } catch (e) {
      if (count && e.code === "bad-password") {
        await Guard.fail();
      }
      throw e;
    }
    wipe(key);
    if (count) {
      await Guard.success();
    }
    return true;
  },

  /** Задать или заменить мастер-пароль (без смены K). Новый пароль проверяется на стойкость;
   * checkStrength: false — пароль уже принят раньше (пароль существующего аккаунта). */
  async setPassword(password, { checkStrength = true } = {}) {
    if (checkStrength) {
      checkNewPassword(password);
    } else {
      checkPasswordLength(password);
    }
    return this._exclusive(async () => {
      this.requireUnlocked();
      this.data.pw = await this._wrapPassword(this._key, password);
      await this._save();
      this._passwordSet();
    });
  },

  /** Сменить мастер-пароль. rotate: true — заодно сменить K и перешифровать все данные
   * (если пароль мог узнать кто-то ещё). Возвращает { recoveryKey } — новый ключ
   * восстановления, если прежний был и его пришлось заменить при смене K. */
  async changePassword(oldPassword, newPassword, { rotate = false } = {}) {
    this.requireUnlocked();
    checkNewPassword(newPassword);
    await this.verifyPassword(oldPassword);
    if (rotate) {
      return this.rotateKey({ password: newPassword, reason: "password" });
    }
    await this._exclusive(async () => {
      this.requireUnlocked();
      this.data.pw = await this._wrapPassword(this._key, newPassword);
      await this._save();
    });
    return { recoveryKey: null, complete: true };
  },

  /* ---------- ключ восстановления ---------- */

  get hasRecoveryKey() {
    return !!this.data?.rk;
  },

  get recoveryKeyCreatedAt() {
    return this.data?.rk?.createdAt || null;
  },

  /** Ключ для доказательства владения ключом восстановления на сервере аккаунта (не
   * связан с обёрткой сейфа: по нему K не получить). */
  recoveryAuthKey(text) {
    const rk = rkParse(text);
    try {
      return hmac(sha256, rk, utf8ToBytes(RK_ACCOUNT_INFO));
    } finally {
      wipe(rk);
    }
  },

  /** Новый ключ восстановления. Если прежний был, он отменяется сменой K (данные
   * перешифровываются), поэтому при мастер-пароле его нужно передать: им же
   * заворачивается новый K. Возвращает строку для записи: показывается один раз. */
  async createRecoveryKey({ password = null } = {}) {
    this.requireUnlocked();
    if (this.data.rk) {
      const r = await this.rotateKey({ password, reason: "recovery", recovery: "new" });
      return r.recoveryKey;
    }
    return this._exclusive(async () => {
      this.requireUnlocked();
      const rk = randomBytes(20);
      const k = rkDerive(rk);
      try {
        this.data.rk = { ...(await encrypt(k, this._key)), createdAt: new Date().toISOString() };
      } finally {
        wipe(k);
      }
      await this._save();
      const text = rkFormat(rk);
      wipe(rk);
      return text;
    });
  },

  /** Отзыв ключа восстановления: K меняется, данные перешифровываются, поэтому старый
   * ключ (и любые копии файла сейфа с его обёрткой) больше ничего не открывает. */
  async revokeRecoveryKey({ password = null } = {}) {
    this.requireUnlocked();
    if (!this.data.rk) {
      return { complete: true };
    }
    return this.rotateKey({ password, reason: "recovery-revoked", recovery: "none" });
  },

  /** Разблокировка ключом восстановления (мастер-пароль забыт); затем интерфейс просит задать новый пароль. */
  async unlockWithRecoveryKey(text) {
    await this.ready();
    if (!this.exists) {
      throw new Error(this.state === "corrupt" ? "Файл сейфа повреждён" : "Сейф не создан");
    }
    if (!this.data.rk) {
      throw new Error("Ключ восстановления для этого сейфа не создавался");
    }
    const rk = rkParse(text);
    const k = rkDerive(rk);
    let key;
    try {
      key = await decrypt(k, this.data.rk);
    } catch (e) {
      throw new Error("Неверный ключ восстановления");
    } finally {
      wipe(k, rk);
    }
    if (!(await this._verify(key))) {
      wipe(key);
      throw new Error("Файл сейфа повреждён");
    }
    if (this.unlocked) {
      wipe(key);
    } else {
      this._adopt(key);
    }
    if (!this.data.os && this.osUnlockEnabled) {
      await this._exclusive(async () => {
        const os = await this._wrapOs(this._key);
        if (os) {
          this.data.os = os;
          await this._save();
        }
      });
    }
    return true;
  },

  /** Тихая разблокировка: выключить (ключ только по мастер-паролю) или включить обратно. */
  async setOsUnlock(enabled) {
    return this._exclusive(async () => {
      this.requireUnlocked();
      if (!enabled && !this.data.pw) {
        throw new Error("Сначала задайте мастер-пароль, иначе сейф будет не открыть");
      }
      this.data.settings ||= {};
      this.data.settings.osUnlock = !!enabled;
      this.data.os = enabled ? await this._wrapOs(this._key) : null;
      await this._save();
    });
  },

  /** Явная блокировка: ключи стираются из памяти, хранилище паролей закрывается (см. патч
   * storage-rust), и до действия пользователя (Touch ID или пароль) сейф сам не откроется. */
  lock() {
    this._explicitLock = true;
    wipe(this._key, this._prevKey);
    this._key = null;
    this._prevKey = null;
    this.notify("locked");
  },

  /* ---------- смена ключа K ---------- */

  /**
   * Подписка модуля на смену K. Контракт обработчика:
   *   async fn(ctx) — вызывается ПОСЛЕ того, как новый K записан в файл сейфа (прежний K
   *   хранится там же под новым, пока перешифровка не завершится).
   *   ctx.reason            "password" | "recovery" | "recovery-revoked" | "rebind" | "resume";
   *   ctx.decryptOld(info, box) → Uint8Array — расшифровка подключом прежнего K (данные,
   *                         уже перешифрованные прошлой попыткой, расшифруются новым);
   *   ctx.encryptNew(info, bytes) → box — шифрование подключом нового K;
   *   ctx.subkeyOld(info), ctx.subkeyNew(info) → Uint8Array (копии, затереть после использования);
   *   ctx.jwkOld(info), ctx.jwkNew(info) → JWK для хранилища паролей.
   * Обработчик сам атомарно сохраняет свои данные и должен быть идемпотентным: при ошибке
   * его вызовут снова при следующей разблокировке (reason "resume"). Пока смена не
   * завершена, Vault.decrypt умеет расшифровывать и прежним ключом.
   * required: true — смена ключа не считается завершённой без успеха этого обработчика.
   * Модули без подписки (или с ошибкой в необязательном обработчике) теряют данные под
   * прежним K: после смены их нужно запросить у пользователя заново.
   * Подписка с тем же именем заменяет прежнюю. Возвращает функцию отписки.
   */
  registerRekey(name, fn, { required = false } = {}) {
    const entry = { fn, required };
    this._rekeyHooks.set(name, entry);
    return () => {
      if (this._rekeyHooks.get(name) === entry) {
        this._rekeyHooks.delete(name);
      }
    };
  },

  async _prev() {
    if (!this.data?.prev || !this._key) {
      return null;
    }
    if (!this._prevKey) {
      this._prevKey = await decrypt(this._key, this.data.prev);
    }
    return this._prevKey;
  },

  /** Модули с данными под ключом сейфа должны успеть подписаться до смены ключа. */
  async _prepareRekeyParticipants() {
    for (const url of REKEY_MODULES) {
      try {
        ChromeUtils.importESModule(url);
      } catch (e) {
        console.error(`Tabora vault: ${url} не загружен`, e);
      }
    }
    if (Services.prefs.getBoolPref("tabora.vault.passwords", false) && Services.prefs.getBoolPref("signon.storage.rust.enabled", false)) {
      // хранилище паролей подписывается при инициализации
      let timer;
      await Promise.race([
        Promise.resolve(Services.logins.initializationPromise).catch(() => {}),
        new Promise(resolve => {
          timer = setTimeout(resolve, 15000);
        }),
      ]);
      clearTimeout(timer);
      if (this.passwordsMode === "vault" && !this._rekeyHooks.has("passwords")) {
        throw new Error("Хранилище паролей не готово к смене ключа: повторите позже");
      }
    }
  },

  async _runRekeyHooks(reason, oldKey, newKey) {
    const sub = (key, info) => subkeyOf(key, info);
    const ctx = {
      reason,
      decryptOld: async (info, box) => {
        const ko = sub(oldKey, info);
        try {
          return await decrypt(ko, box);
        } catch (e) {
          const kn = sub(newKey, info);
          try {
            return await decrypt(kn, box);
          } finally {
            wipe(kn);
          }
        } finally {
          wipe(ko);
        }
      },
      encryptNew: async (info, bytes) => {
        const kn = sub(newKey, info);
        try {
          return await encrypt(kn, bytes);
        } finally {
          wipe(kn);
        }
      },
      subkeyOld: info => sub(oldKey, info),
      subkeyNew: info => sub(newKey, info),
      jwkOld: info => {
        const k = sub(oldKey, info);
        try {
          return jwkOf(k);
        } finally {
          wipe(k);
        }
      },
      jwkNew: info => {
        const k = sub(newKey, info);
        try {
          return jwkOf(k);
        } finally {
          wipe(k);
        }
      },
    };
    let ok = true;
    for (const [name, h] of [...this._rekeyHooks]) {
      try {
        await h.fn(ctx);
      } catch (e) {
        console.error(`Tabora vault: перешифровка «${name}» не удалась`, e);
        if (h.required) {
          ok = false;
        }
      }
    }
    return ok;
  },

  /**
   * Сменить K: новый ключ, новые обёртки (система, мастер-пароль, по желанию новый ключ
   * восстановления), затем перешифровка всех подписанных модулей.
   *   password — мастер-пароль, которым завернуть новый K (обязателен, если пароль задан;
   *              при перепривязке к другому аккаунту — пароль нового аккаунта);
   *   recovery — "new" (новый ключ восстановления), "none" (без него) или "auto"
   *              (новый, если прежний был: старый отменяется вместе с прежним K).
   * Возвращает { recoveryKey, complete }.
   */
  async rotateKey({ password = null, reason = "manual", recovery = "auto" } = {}) {
    if (password) {
      checkPasswordLength(password);
    }
    if (this.rekeyPending) {
      await this.resumeRekey();
      if (this.rekeyPending) {
        throw new Error("Предыдущая смена ключа ещё не завершена: повторите позже");
      }
    }
    await this._prepareRekeyParticipants();
    return this._exclusive(async () => {
      this.requireUnlocked();
      if (this.data.pw && !password) {
        throw new Error("Для смены ключа нужен мастер-пароль");
      }
      const oldKey = this._key.slice();
      const newKey = randomBytes(32);
      const before = this.data;
      let rkText = null;
      try {
        const data = JSON.parse(JSON.stringify(before));
        data.check = await encrypt(newKey, utf8ToBytes(CHECK));
        data.os = this.osUnlockEnabled ? await this._wrapOs(newKey) : null;
        if (before.os && this.osUnlockEnabled && !data.os) {
          throw new Error("Хранилище ключей системы недоступно: ключ не сменён");
        }
        data.pw = password ? await this._wrapPassword(newKey, password) : null;
        const wantRk = recovery === "new" || (recovery === "auto" && !!before.rk);
        if (wantRk) {
          const rk = randomBytes(20);
          const k = rkDerive(rk);
          try {
            data.rk = { ...(await encrypt(k, newKey)), createdAt: new Date().toISOString() };
          } finally {
            wipe(k);
          }
          rkText = rkFormat(rk);
          wipe(rk);
        } else {
          data.rk = null;
        }
        if (!data.os && !data.pw && !data.rk) {
          throw new Error("Без связки ключей и мастер-пароля новый ключ было бы не открыть");
        }
        // прежний K остаётся под новым, пока все данные не перешифрованы (точка невозврата — запись файла)
        data.prev = { ...(await encrypt(newKey, oldKey)), at: new Date().toISOString(), reason };
        this.data = data;
        await this._save();
      } catch (e) {
        this.data = before;
        wipe(oldKey, newKey);
        throw e;
      }
      wipe(this._key);
      this._key = newKey;
      wipe(this._prevKey);
      this._prevKey = oldKey;
      if (password) {
        this._passwordSet();
      }
      this.notify("rekeying");
      const complete = await this._runRekeyHooks(reason, oldKey, newKey);
      if (complete) {
        await this._finishRekey();
      }
      this.notify("rekeyed");
      return { recoveryKey: rkText, complete };
    });
  },

  async _finishRekey() {
    delete this.data.prev;
    await this._save();
    wipe(this._prevKey);
    this._prevKey = null;
  },

  /** Доделать прерванную смену ключа (вызывается при разблокировке). */
  async resumeRekey() {
    if (!this.rekeyPending || !this.unlocked) {
      return;
    }
    await this._prepareRekeyParticipants().catch(e => console.error("Tabora vault", e));
    await this._exclusive(async () => {
      if (!this.rekeyPending || !this.unlocked) {
        return;
      }
      const oldKey = (await this._prev()).slice();
      const newKey = this._key.slice();
      try {
        if (await this._runRekeyHooks("resume", oldKey, newKey)) {
          await this._finishRekey();
          this.notify("rekeyed");
        }
      } finally {
        wipe(oldKey, newKey);
      }
    });
  },

  /* ---------- ключи и шифрование для других модулей ---------- */

  /** Производный ключ для подсистемы: пароли, коды, почта. Компрометация одного не раскрывает K. */
  subkey(info) {
    this.requireUnlocked();
    return subkeyOf(this._key, info);
  },

  /** Подключ прежнего K, пока смена ключа не завершена и прежний K уже загружен (иначе null). */
  prevSubkey(info) {
    return this._key && this._prevKey && this.rekeyPending ? subkeyOf(this._prevKey, info) : null;
  },

  async encrypt(info, bytes) {
    const k = this.subkey(info);
    try {
      return await encrypt(k, bytes);
    } finally {
      wipe(k);
    }
  },

  /** Расшифровка подключом. Пока смена ключа не завершена, данные под прежним K тоже читаются. */
  async decrypt(info, box) {
    const k = this.subkey(info);
    try {
      return await decrypt(k, box);
    } catch (e) {
      const prev = await this._prev().catch(() => null);
      if (!prev) {
        throw e;
      }
      const pk = subkeyOf(prev, info);
      try {
        return await decrypt(pk, box);
      } finally {
        wipe(pk);
      }
    } finally {
      wipe(k);
    }
  },
};
