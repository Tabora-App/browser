/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Сейф Tabora: один случайный ключ K (256 бит), которым шифруются пароли сайтов
 * (Rust-хранилище Firefox) и секреты одноразовых кодов. Сам K лежит в файле
 * tabora-vault.json только в обёртках:
 *   - os: через хранилище ключей системы (Keychain на macOS, nsIOSKeyStore) — тихая
 *     разблокировка на этом компьютере;
 *   - pw: AES-GCM ключом Argon2id(мастер-пароль) — для переноса на другой компьютер.
 * Блок check позволяет убедиться, что распакован именно K. Открытый K существует
 * только в памяти, пока сейф разблокирован. Пароли и секреты модуль не хранит:
 * он выдаёт ключ (или производные ключи) другим модулям. */

const C = ChromeUtils.importESModule("chrome://browser/content/tabora/wallet/vendor/crypto.sys.mjs");
const { argon2id, randomBytes, base64, utf8ToBytes, hmac, sha256 } = C;
const { OSKeyStore } = ChromeUtils.importESModule("resource://gre/modules/OSKeyStore.sys.mjs");

const FILE = () => PathUtils.join(PathUtils.profileDir, "tabora-vault.json");
const KDF = { t: 3, m: 65536, p: 1, dkLen: 32 }; // Argon2id: 64 МБ, 3 прохода
const CHECK = "tabora-vault-v1";
const MIN_PASSWORD = 8;

function wipe(...arrays) {
  for (const a of arrays) {
    if (a && a.fill) {
      a.fill(0);
    }
  }
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

function deriveKey(password, salt, kdf) {
  const t = Number(kdf?.t);
  const m = Number(kdf?.m);
  const p = Number(kdf?.p);
  const dkLen = Number(kdf?.dkLen);
  // параметры приходят из файла: вне границ это повреждение или попытка подвесить браузер
  if (!(t >= 1 && t <= 10) || !(m >= 8192 && m <= 1 << 20) || !(p >= 1 && p <= 4) || dkLen !== 32 || !(salt?.length >= 8)) {
    throw new Error("Файл сейфа повреждён: параметры KDF вне допустимых границ");
  }
  return argon2id(utf8ToBytes(password.normalize("NFKC")), salt, { t, m, p, dkLen });
}

function checkPassword(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD) {
    throw new Error(`Мастер-пароль не короче ${MIN_PASSWORD} символов`);
  }
}

export const Vault = {
  TOPIC: "tabora-vault-changed",
  MIN_PASSWORD,
  data: null, // файл: обёртки ключа и настройки, секретов здесь нет
  _key: null, // K, пока сейф разблокирован
  _loaded: false,
  _unlocking: null,

  async ready() {
    if (this._loaded) {
      return this.data;
    }
    try {
      this.data = await IOUtils.readJSON(FILE());
      if (!this.data || this.data.version !== 1 || typeof this.data !== "object") {
        throw new Error("Неизвестный формат файла сейфа");
      }
    } catch (e) {
      if (!(e.name === "NotFoundError")) {
        console.error("Tabora vault", e);
      }
      this.data = null;
    }
    this._loaded = true;
    return this.data;
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

  /** Тихая разблокировка через хранилище ключей системы разрешена настройкой (по умолчанию да). */
  get osUnlockEnabled() {
    return this.data?.settings?.osUnlock !== false;
  },

  notify(what = "changed") {
    Services.obs.notifyObservers(null, this.TOPIC, what);
  },

  requireUnlocked() {
    if (!this._key) {
      throw new Error("Сейф заблокирован");
    }
  },

  async save() {
    this.data.rev = (this.data.rev || 0) + 1;
    this.data.updatedAt = new Date().toISOString();
    await IOUtils.writeJSON(FILE(), this.data, { tmpPath: FILE() + ".tmp" });
    try {
      await IOUtils.setPermissions(FILE(), 0o600);
    } catch (e) {}
    this.notify();
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

  async _unwrapOs(box) {
    const text = await OSKeyStore.decrypt(box.ct, "tabora-vault", false);
    return base64.decode(text);
  },

  async _wrapPassword(key, password) {
    checkPassword(password);
    const salt = randomBytes(16);
    const raw = deriveKey(password, salt, KDF);
    try {
      return { kdf: { alg: "argon2id", salt: base64.encode(salt), ...KDF }, ...(await encrypt(raw, key)) };
    } finally {
      wipe(raw);
    }
  },

  async _unwrapPassword(box, password) {
    const raw = deriveKey(password, base64.decode(box.kdf.salt), box.kdf);
    try {
      return await decrypt(raw, box);
    } catch (e) {
      throw new Error("Неверный мастер-пароль");
    } finally {
      wipe(raw);
    }
  },

  async _verify(key) {
    try {
      const plain = await decrypt(key, this.data.check);
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
    this.notify("unlocked");
  },

  /** Новый сейф: ключ K, обёртка системы и, если задан, мастер-пароль. */
  async create({ password = "" } = {}) {
    await this.ready();
    if (this.exists) {
      throw new Error("Сейф уже создан");
    }
    if (password) {
      checkPassword(password);
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
    await this.save();
    this._adopt(key);
    return true;
  },

  /* ---------- разблокировка ---------- */

  /** Тихая разблокировка через систему. Возвращает true, если удалось. */
  async unlock() {
    await this.ready();
    if (this.unlocked) {
      return true;
    }
    if (!this.exists || !this.data.os || !this.osUnlockEnabled) {
      return false;
    }
    if (!this._unlocking) {
      this._unlocking = (async () => {
        try {
          const key = await this._unwrapOs(this.data.os);
          if (!(await this._verify(key))) {
            wipe(key);
            console.error("Tabora vault: ключ из хранилища системы не подходит к сейфу");
            return false;
          }
          this._adopt(key);
          return true;
        } catch (e) {
          console.error("Tabora vault: разблокировка через систему не удалась", e);
          return false;
        } finally {
          this._unlocking = null;
        }
      })();
    }
    return this._unlocking;
  },

  /** Разблокировка мастер-паролем; на новом компьютере заодно создаёт обёртку системы. */
  async unlockWithPassword(password) {
    await this.ready();
    if (!this.exists) {
      throw new Error("Сейф не создан");
    }
    if (!this.data.pw) {
      throw new Error("Мастер-пароль не задан: сейф открывается только на этом компьютере");
    }
    const key = await this._unwrapPassword(this.data.pw, password);
    if (!(await this._verify(key))) {
      wipe(key);
      throw new Error("Файл сейфа повреждён");
    }
    this._adopt(key);
    if (!this.data.os && this.osUnlockEnabled) {
      this.data.os = await this._wrapOs(key);
      if (this.data.os) {
        await this.save();
      }
    }
    return true;
  },

  async verifyPassword(password) {
    if (!this.data?.pw) {
      throw new Error("Мастер-пароль не задан");
    }
    const key = await this._unwrapPassword(this.data.pw, password);
    wipe(key);
    return true;
  },

  async setPassword(password) {
    this.requireUnlocked();
    this.data.pw = await this._wrapPassword(this._key, password);
    await this.save();
  },

  async changePassword(oldPassword, newPassword) {
    this.requireUnlocked();
    await this.verifyPassword(oldPassword);
    await this.setPassword(newPassword);
  },

  /** Тихая разблокировка: выключить (ключ только по мастер-паролю) или включить обратно. */
  async setOsUnlock(enabled) {
    this.requireUnlocked();
    if (!enabled && !this.data.pw) {
      throw new Error("Сначала задайте мастер-пароль, иначе сейф будет не открыть");
    }
    this.data.settings ||= {};
    this.data.settings.osUnlock = !!enabled;
    this.data.os = enabled ? await this._wrapOs(this._key) : null;
    await this.save();
  },

  lock() {
    wipe(this._key);
    this._key = null;
    this.notify("locked");
  },

  /* ---------- ключи и шифрование для других модулей ---------- */

  /** Производный ключ для подсистемы: пароли, коды. Компрометация одного не раскрывает K. */
  subkey(info) {
    this.requireUnlocked();
    return hmac(sha256, this._key, utf8ToBytes(`tabora-vault/${info}`));
  },

  async encrypt(info, bytes) {
    const k = this.subkey(info);
    try {
      return await encrypt(k, bytes);
    } finally {
      wipe(k);
    }
  },

  async decrypt(info, box) {
    const k = this.subkey(info);
    try {
      return await decrypt(k, box);
    } finally {
      wipe(k);
    }
  },
};
