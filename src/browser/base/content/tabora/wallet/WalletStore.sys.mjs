/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Кошелёк Tabora: одна seed-фраза (BIP-39) на EVM, Bitcoin, Solana и TRON.
 * Хранилище: tabora-wallet.json в профиле. Секрет (фраза) зашифрован AES-256-GCM
 * ключом из Argon2id(пароль). Без пароля ключ лежит в менеджере паролей Firefox
 * (режим помечен как небезопасный). Публичные адреса хранятся открыто, чтобы
 * показывать балансы в заблокированном состоянии. Приватные ключи выводятся
 * только на время подписи и обнуляются. */

const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
const C = ChromeUtils.importESModule("chrome://browser/content/tabora/wallet/vendor/crypto.sys.mjs");
const { sha256, keccak_256, hmac, sha512, argon2id, randomBytes, bytesToHex, hexToBytes, utf8ToBytes, secp256k1, ed25519, bip39, wordlistEnglish, HDKey, base58, base58check, base64, btc } = C;

const FILE = () => PathUtils.join(PathUtils.profileDir, "tabora-wallet.json");
const KDF = { t: 3, m: 32768, p: 1, dkLen: 32 }; // Argon2id: 32 МБ памяти, 3 прохода
const LOGIN_ORIGIN = "chrome://tabora-wallet";
const AUTOLOCK_PREF = "tabora.wallet.autolockMinutes";
const NODES_PREF = "tabora.wallet.nodes";
const b58check = base58check(sha256);
export const qrcodegen = C.qrcodegen;

const LOGO = name => `chrome://browser/content/tabora/wallet/logos/${name}.png`;

export const CHAINS = {
  ethereum: { id: "ethereum", logo: LOGO("ethereum"), name: "Ethereum", symbol: "ETH", kind: "evm", chainId: 1, decimals: 18, dust: 0.0001, color: "#8a92ff", path: "m/44'/60'/0'/0/{i}",
    nodes: ["https://ethereum-rpc.publicnode.com", "https://cloudflare-eth.com", "https://rpc.ankr.com/eth", "https://eth.llamarpc.com"],
    explorer: "https://etherscan.io/address/", history: "https://eth.blockscout.com",
    tokens: [{ symbol: "USDT", logo: LOGO("usdt"), address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 }, { symbol: "USDC", logo: LOGO("usdc"), address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 }, { symbol: "DAI", logo: LOGO("dai"), address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", decimals: 18 }] },
  base: { id: "base", logo: LOGO("base"), name: "Base", symbol: "ETH", kind: "evm", chainId: 8453, decimals: 18, dust: 0.0001, color: "#4f7bff", path: "m/44'/60'/0'/0/{i}", sameAs: "ethereum",
    nodes: ["https://base-rpc.publicnode.com", "https://mainnet.base.org", "https://base.llamarpc.com"], explorer: "https://basescan.org/address/", history: "https://base.blockscout.com",
    tokens: [{ symbol: "USDC", logo: LOGO("usdc"), address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 }, { symbol: "USDT", logo: LOGO("usdt"), address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", decimals: 6 }] },
  arbitrum: { id: "arbitrum", logo: LOGO("arbitrum"), name: "Arbitrum", symbol: "ETH", kind: "evm", chainId: 42161, decimals: 18, dust: 0.0001, color: "#6fb6ff", path: "m/44'/60'/0'/0/{i}", sameAs: "ethereum",
    nodes: ["https://arbitrum-one-rpc.publicnode.com", "https://arb1.arbitrum.io/rpc"], explorer: "https://arbiscan.io/address/", history: "https://arbitrum.blockscout.com",
    tokens: [{ symbol: "USDT", logo: LOGO("usdt"), address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6 }, { symbol: "USDC", logo: LOGO("usdc"), address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 }] },
  polygon: { id: "polygon", logo: LOGO("polygon"), name: "Polygon", symbol: "POL", kind: "evm", chainId: 137, decimals: 18, dust: 0.5, color: "#c39bff", path: "m/44'/60'/0'/0/{i}", sameAs: "ethereum",
    nodes: ["https://polygon-bor-rpc.publicnode.com", "https://polygon-rpc.com"], explorer: "https://polygonscan.com/address/", history: "https://polygon.blockscout.com",
    tokens: [{ symbol: "USDT", logo: LOGO("usdt"), address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6 }, { symbol: "USDC", logo: LOGO("usdc"), address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6 }] },
  bitcoin: { id: "bitcoin", logo: LOGO("bitcoin"), name: "Bitcoin", symbol: "BTC", kind: "btc", decimals: 8, dust: 0.00001, color: "#ff9f5a", path: "m/84'/0'/0'/0/{i}",
    nodes: ["https://mempool.space/api", "https://blockstream.info/api"], explorer: "https://mempool.space/address/" },
  solana: { id: "solana", logo: LOGO("solana"), name: "Solana", symbol: "SOL", kind: "sol", decimals: 9, dust: 0.003, color: "#5ee0d0", path: "m/44'/501'/{i}'/0'",
    nodes: ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com", "https://rpc.ankr.com/solana"], explorer: "https://solscan.io/account/",
    tokens: [{ symbol: "USDC", logo: LOGO("usdc"), mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 }, { symbol: "USDT", logo: LOGO("usdt"), mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6 }] },
  tron: { id: "tron", logo: LOGO("tron"), name: "TRON", symbol: "TRX", kind: "tron", decimals: 6, dust: 1, color: "#ff7b7b", path: "m/44'/195'/0'/0/{i}",
    nodes: ["https://api.trongrid.io", "https://api.tronstack.io", "https://tron-rpc.publicnode.com/jsonrpc"], explorer: "https://tronscan.org/#/address/",
    tokens: [{ symbol: "USDT", logo: LOGO("usdt"), address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", decimals: 6 }, { symbol: "USDC", logo: LOGO("usdc"), address: "TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8", decimals: 6 }] },
};
export const CHAIN_ORDER = ["ethereum", "base", "arbitrum", "polygon", "bitcoin", "solana", "tron"];

/* ---------- утилиты ---------- */

function toChecksumAddress(addr) {
  const hex = addr.toLowerCase().replace(/^0x/, "");
  const hash = bytesToHex(keccak_256(utf8ToBytes(hex)));
  let out = "0x";
  for (let i = 0; i < hex.length; i++) {
    out += parseInt(hash[i], 16) >= 8 ? hex[i].toUpperCase() : hex[i];
  }
  return out;
}

function evmAddressFromPriv(priv) {
  const pub = secp256k1.getPublicKey(priv, false).slice(1);
  return toChecksumAddress("0x" + bytesToHex(keccak_256(pub).slice(-20)));
}

function tronAddressFromPriv(priv) {
  const pub = secp256k1.getPublicKey(priv, false).slice(1);
  const body = keccak_256(pub).slice(-20);
  const payload = new Uint8Array(21);
  payload[0] = 0x41;
  payload.set(body, 1);
  return b58check.encode(payload);
}

/** SLIP-10 для ed25519: только усиленные шаги. */
function slip10Ed25519(seed, path) {
  let I = hmac(sha512, utf8ToBytes("ed25519 seed"), seed);
  let key = I.slice(0, 32);
  let chain = I.slice(32);
  const parts = path.replace(/^m\//, "").split("/");
  for (const p of parts) {
    const index = (parseInt(p.replace("'", ""), 10) | 0x80000000) >>> 0;
    const data = new Uint8Array(1 + 32 + 4);
    data[0] = 0;
    data.set(key, 1);
    new DataView(data.buffer).setUint32(33, index, false);
    I = hmac(sha512, chain, data);
    key = I.slice(0, 32);
    chain = I.slice(32);
  }
  return key;
}

/** Сигнал отмены по таймауту (в sys.mjs нет AbortSignal.timeout). */
function timeoutSignal(ms) {
  const c = new AbortController();
  setTimeout(() => c.abort(new Error(`таймаут ${ms / 1000} с`)), ms);
  return c.signal;
}

/** Каноничный JSON (ключи отсортированы) для HMAC открытой части файла. */
function canonical(value) {
  if (Array.isArray(value)) {
    return "[" + value.map(canonical).join(",") + "]";
  }
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
  }
  return JSON.stringify(value);
}

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

async function decrypt(raw, iv, ct) {
  const key = await aesKey(raw);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64.decode(iv) }, key, base64.decode(ct)));
}

function deriveKey(password, salt, kdf) {
  return argon2id(utf8ToBytes(password.normalize("NFKC")), salt, { t: kdf.t, m: kdf.m, p: kdf.p, dkLen: kdf.dkLen });
}

async function loginKey(create) {
  const logins = await Services.logins.searchLoginsAsync({ origin: LOGIN_ORIGIN });
  const found = logins.find(l => l.username === "vault-key");
  if (found) {
    return base64.decode(found.password);
  }
  if (!create) {
    return null;
  }
  const raw = randomBytes(32);
  const info = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
  info.init(LOGIN_ORIGIN, null, "Tabora Wallet", "vault-key", base64.encode(raw), "", "");
  await Services.logins.addLoginAsync(info);
  return raw;
}

/* ---------- хранилище ---------- */

export const WalletStore = {
  TOPIC: "tabora-wallet-changed",
  data: null, // файл: публичная часть + зашифрованные фразы
  _key: null, // мастер-ключ AES, пока разблокирован
  _timer: null,
  _loaded: false,

  async ready() {
    if (this._loaded) {
      return this.data;
    }
    try {
      this.data = await IOUtils.readJSON(FILE());
    } catch (e) {
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

  get passwordless() {
    return !!this.data?.passwordless;
  },

  get wallets() {
    return this.data?.wallets || [];
  },

  get activeWallet() {
    return this.wallets.find(w => w.id === this.data?.active?.wallet) || this.wallets[0] || null;
  },

  get activeAccount() {
    const w = this.activeWallet;
    return w ? w.accounts.find(a => a.index === (this.data.active?.account ?? 0)) || w.accounts[0] : null;
  },

  setActive(walletId, accountIndex = 0) {
    this.data.active = { wallet: walletId, account: accountIndex };
    return this.save();
  },

  notify(what = "changed") {
    Services.obs.notifyObservers(null, this.TOPIC, what);
  },

  /** HMAC открытой части файла на мастер-ключе: защита адресов, разрешений и токенов от подмены. */
  computeMac(data = this.data) {
    const { mac, ...rest } = data;
    return bytesToHex(hmac(sha256, this._key, utf8ToBytes(canonical(rest))));
  },

  tampered: false,

  /** Пользователь подтвердил, что правки файла сделаны им: подписываем текущее содержимое. */
  async acceptFile() {
    this.tampered = false;
    await this.save();
  },

  verifyMac() {
    if (!this.data?.mac) {
      this.tampered = false; // старый файл без подписи: подпишем при следующем сохранении
      return true;
    }
    const ok = this.computeMac() === this.data.mac;
    this.tampered = !ok;
    return ok;
  },

  async save() {
    if (this._key && !this.tampered) {
      this.data.mac = this.computeMac();
    }
    await IOUtils.writeJSON(FILE(), this.data, { tmpPath: FILE() + ".tmp" });
    try {
      await IOUtils.setPermissions(FILE(), 0o600);
    } catch (e) {}
    this.notify();
  },

  generateMnemonic(words = 12) {
    return bip39.generateMnemonic(wordlistEnglish, words === 24 ? 256 : 128);
  },

  normalize(phrase) {
    return phrase.trim().toLowerCase().split(/\s+/).join(" ");
  },

  validateMnemonic(phrase) {
    return bip39.validateMnemonic(this.normalize(phrase), wordlistEnglish);
  },

  wordlist() {
    return wordlistEnglish;
  },

  /** Первичная настройка: пароль (или без него) и первая фраза. */
  async create({ mnemonic, password, name = "Кошелёк 1" }) {
    const passwordless = !password;
    const salt = randomBytes(16);
    const raw = passwordless ? await loginKey(true) : deriveKey(password, salt, KDF);
    this.data = {
      v: 2,
      createdAt: new Date().toISOString(),
      passwordless,
      kdf: passwordless ? null : { alg: "argon2id", salt: base64.encode(salt), ...KDF },
      check: await encrypt(raw, utf8ToBytes("tabora-wallet-check")),
      wallets: [],
      active: null,
      settings: { hiddenChains: [] },
    };
    this._key = raw;
    await this.addWallet({ mnemonic, name });
    this.armAutolock();
    this.notify("unlocked");
    return this.activeWallet;
  },

  /** Добавить ещё один кошелёк по фразе (кошелёк должен быть разблокирован). */
  async addWallet({ mnemonic, name }) {
    if (!this.unlocked) {
      throw new Error("Кошелёк заблокирован");
    }
    const phrase = this.normalize(mnemonic);
    if (!this.validateMnemonic(phrase)) {
      throw new Error("Фраза не проходит проверку BIP-39");
    }
    const seed = bip39.mnemonicToSeedSync(phrase);
    const fingerprint = bytesToHex(sha256(HDKey.fromMasterSeed(seed).publicKey)).slice(0, 8);
    if (this.wallets.some(w => w.fingerprint === fingerprint)) {
      wipe(seed);
      throw new Error("Этот кошелёк уже добавлен");
    }
    // в сейфе и фраза (для показа), и seed (для подписи: его можно обнулить в памяти)
    const plain = utf8ToBytes(JSON.stringify({ mnemonic: phrase, seed: bytesToHex(seed) }));
    const vault = await encrypt(this._key, plain);
    wipe(plain);
    const wallet = {
      id: `w${Date.now().toString(36)}`,
      name: name || `Кошелёк ${this.wallets.length + 1}`,
      fingerprint,
      createdAt: new Date().toISOString(),
      words: phrase.split(" ").length,
      vault,
      accounts: [{ index: 0, name: "Адрес 1", addresses: this.deriveAll(seed, 0) }],
    };
    wipe(seed);
    this.data.wallets.push(wallet);
    this.data.active = { wallet: wallet.id, account: 0 };
    await this.save();
    this.touch();
    return wallet;
  },

  /** Новый адрес (следующий индекс деривации) в кошельке. */
  async addAccount(walletId, name) {
    const wallet = this.wallets.find(w => w.id === walletId);
    if (!wallet) {
      throw new Error("Кошелёк не найден");
    }
    const phrase = await this.mnemonicOf(wallet);
    const seed = bip39.mnemonicToSeedSync(phrase);
    const index = Math.max(-1, ...wallet.accounts.map(a => a.index)) + 1;
    const account = { index, name: name || `Адрес ${index + 1}`, addresses: this.deriveAll(seed, index) };
    wipe(seed);
    wallet.accounts.push(account);
    this.data.active = { wallet: wallet.id, account: index };
    await this.save();
    this.touch();
    return account;
  },

  async renameWallet(walletId, name) {
    const w = this.wallets.find(x => x.id === walletId);
    if (w && name.trim()) {
      w.name = name.trim();
      await this.save();
    }
  },

  async renameAccount(walletId, index, name) {
    const a = this.wallets.find(x => x.id === walletId)?.accounts.find(x => x.index === index);
    if (a && name.trim()) {
      a.name = name.trim();
      await this.save();
    }
  },

  async removeWallet(walletId, password) {
    await this.verifyPassword(password);
    this.data.wallets = this.wallets.filter(w => w.id !== walletId);
    if (this.data.active?.wallet === walletId) {
      this.data.active = this.wallets[0] ? { wallet: this.wallets[0].id, account: 0 } : null;
    }
    await this.save();
  },

  async masterKey(password) {
    await this.ready();
    if (!this.data) {
      throw new Error("Кошелька нет");
    }
    const raw = this.data.passwordless ? await loginKey(false) : deriveKey(password || "", base64.decode(this.data.kdf.salt), this.data.kdf);
    if (!raw) {
      throw new Error("Ключ хранилища не найден");
    }
    try {
      const plain = await decrypt(raw, this.data.check.iv, this.data.check.ct);
      wipe(plain);
    } catch (e) {
      wipe(raw);
      throw new Error("Неверный пароль");
    }
    return raw;
  },

  async unlock(password) {
    const raw = await this.masterKey(password);
    this._key = raw;
    this.verifyMac();
    if (!this.data.mac) {
      await this.save();
    }
    this.armAutolock();
    this.notify("unlocked");
  },

  lock() {
    wipe(this._key);
    this._key = null;
    clearTimeout(this._timer);
    this.notify("locked");
  },

  armAutolock() {
    clearTimeout(this._timer);
    const minutes = Services.prefs.getIntPref(AUTOLOCK_PREF, 15);
    if (minutes > 0) {
      this._timer = setTimeout(() => this.lock(), minutes * 60 * 1000);
    }
  },

  touch() {
    if (this._key) {
      this.armAutolock();
    }
  },

  async mnemonicOf(wallet) {
    if (!this.unlocked) {
      throw new Error("Кошелёк заблокирован");
    }
    const plain = await decrypt(this._key, wallet.vault.iv, wallet.vault.ct);
    const { mnemonic } = JSON.parse(new TextDecoder().decode(plain));
    wipe(plain);
    return mnemonic;
  },

  /** Seed BIP-39 (64 байта) для подписи; вызывающий обязан обнулить. Старые сейфы дополняются seed. */
  async seedOf(wallet) {
    if (!this.unlocked) {
      throw new Error("Кошелёк заблокирован");
    }
    const plain = await decrypt(this._key, wallet.vault.iv, wallet.vault.ct);
    const parsed = JSON.parse(new TextDecoder().decode(plain));
    wipe(plain);
    if (parsed.seed) {
      return hexToBytes(parsed.seed);
    }
    const seed = bip39.mnemonicToSeedSync(parsed.mnemonic);
    try {
      const upgraded = utf8ToBytes(JSON.stringify({ mnemonic: parsed.mnemonic, seed: bytesToHex(seed) }));
      wallet.vault = await encrypt(this._key, upgraded);
      wipe(upgraded);
      await this.save();
    } catch (e) {}
    return seed;
  },

  /** Фраза для показа: повторная проверка пароля обязательна. */
  async revealMnemonic(walletId, password) {
    await this.verifyPassword(password);
    const wallet = this.wallets.find(w => w.id === walletId);
    return this.mnemonicOf(wallet);
  },

  async verifyPassword(password) {
    if (!this.unlocked) {
      throw new Error("Кошелёк заблокирован");
    }
    if (this.data.passwordless) {
      return true;
    }
    const raw = await this.masterKey(password);
    wipe(raw);
    this.touch();
    return true;
  },

  /** Смена пароля: перешифровываем все фразы новым мастер-ключом. */
  async changePassword(oldPassword, newPassword) {
    await this.verifyPassword(oldPassword);
    const vaults = [];
    for (const w of this.wallets) {
      const plain = await decrypt(this._key, w.vault.iv, w.vault.ct);
      vaults.push(plain);
    }
    const passwordless = !newPassword;
    const salt = randomBytes(16);
    const raw = passwordless ? await loginKey(true) : deriveKey(newPassword, salt, KDF);
    this.data.check = await encrypt(raw, utf8ToBytes("tabora-wallet-check"));
    for (let i = 0; i < this.wallets.length; i++) {
      this.wallets[i].vault = await encrypt(raw, vaults[i]);
      wipe(vaults[i]);
    }
    this.data.passwordless = passwordless;
    this.data.kdf = passwordless ? null : { alg: "argon2id", salt: base64.encode(salt), ...KDF };
    wipe(this._key);
    this._key = raw;
    await this.save();
  },

  async destroy(password) {
    await this.verifyPassword(password);
    this.lock();
    try {
      await IOUtils.remove(FILE());
    } catch (e) {}
    this.data = null;
    this.notify("destroyed");
  },

  /* ---------- деривация ---------- */

  pathFor(chain, index) {
    return chain.path.replace("{i}", String(index));
  },

  deriveAll(seed, index = 0) {
    const root = HDKey.fromMasterSeed(seed);
    const out = {};
    for (const id of CHAIN_ORDER) {
      const chain = CHAINS[id];
      if (chain.sameAs) {
        out[id] = out[chain.sameAs];
        continue;
      }
      const path = this.pathFor(chain, index);
      if (chain.kind === "evm") {
        const k = root.derive(path);
        out[id] = evmAddressFromPriv(k.privateKey);
        k.wipePrivateData();
      } else if (chain.kind === "btc") {
        const k = root.derive(path);
        out[id] = btc.p2wpkh(k.publicKey).address;
        k.wipePrivateData();
      } else if (chain.kind === "tron") {
        const k = root.derive(path);
        out[id] = tronAddressFromPriv(k.privateKey);
        k.wipePrivateData();
      } else if (chain.kind === "sol") {
        const key = slip10Ed25519(seed, path);
        out[id] = base58.encode(ed25519.getPublicKey(key));
        wipe(key);
      }
    }
    root.wipePrivateData();
    return out;
  },

  /** Приватный ключ сети для аккаунта на время подписи. Вызывающий обязан обнулить результат. */
  async privateKeyFor(walletId, index, chainId) {
    const wallet = this.wallets.find(w => w.id === walletId);
    if (!wallet) {
      throw new Error("Кошелёк не найден");
    }
    const chain = CHAINS[chainId];
    const seed = await this.seedOf(wallet);
    const path = this.pathFor(chain, index);
    let key;
    if (chain.kind === "sol") {
      key = slip10Ed25519(seed, path);
    } else {
      const root = HDKey.fromMasterSeed(seed);
      const k = root.derive(path);
      key = new Uint8Array(k.privateKey);
      k.wipePrivateData();
      root.wipePrivateData();
    }
    wipe(seed);
    this.touch();
    return key;
  },

  /* ---------- узлы ---------- */

  nodesFor(chainId) {
    let saved = {};
    try {
      saved = JSON.parse(Services.prefs.getStringPref(NODES_PREF, "{}"));
    } catch (e) {}
    const chain = CHAINS[chainId];
    const list = saved[chainId]?.list?.length ? saved[chainId].list : chain.nodes;
    const index = Math.min(saved[chainId]?.index || 0, list.length - 1);
    return { list, index, url: list[index] };
  },

  /** Нода допустима только по https (http — лишь для localhost). */
  validateNodeUrl(url) {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      throw new Error("Это не адрес");
    }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) || u.hostname.endsWith(".localhost");
    if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) {
      throw new Error("Нода должна быть по https (http допустим только для localhost)");
    }
    return u.href.replace(/\/$/, "");
  },

  setNodes(chainId, list, index, { quiet = false } = {}) {
    list = list.map(u => this.validateNodeUrl(u));
    let saved = {};
    try {
      saved = JSON.parse(Services.prefs.getStringPref(NODES_PREF, "{}"));
    } catch (e) {}
    saved[chainId] = { list, index };
    Services.prefs.setStringPref(NODES_PREF, JSON.stringify(saved));
    delete this._nodeOverride[chainId];
    if (!quiet) {
      this.notify("nodes");
    }
  },

  _nodeOverride: {},

  /** Запрос к ноде. Без forced url перебираем список с активной ноды и запоминаем рабочую до перезапуска. */
  async rpc(chainId, body, path = "", { tryAll = true, url: forced = null } = {}) {
    const { list, index: saved } = this.nodesFor(chainId);
    const index = this._nodeOverride[chainId] ?? saved;
    let lastError = null;
    const attempts = forced ? 1 : tryAll ? list.length : 1;
    for (let step = 0; step < attempts; step++) {
      const i = (index + step) % list.length;
      const url = forced || list[i];
      try {
        const res = await fetch(url + path, {
          signal: timeoutSignal(12000),
          method: body ? "POST" : "GET",
          headers: body ? { "Content-Type": "application/json" } : {},
          body: body ? JSON.stringify(body) : undefined,
        });
        if (!res.ok) {
          throw new Error(`${new URL(url).host}: HTTP ${res.status}`);
        }
        const json = await res.json();
        if (!forced && i !== index) {
          this._nodeOverride[chainId] = i;
        }
        return json;
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError || new Error("нода недоступна");
  },

  async evm(chainId, method, params, opts = {}) {
    const json = await this.rpc(chainId, { jsonrpc: "2.0", id: 1, method, params }, "", opts);
    if (json.error) {
      throw new Error(json.error.message || "RPC error");
    }
    return json.result;
  },

  /** TRON: нода REST (TronGrid) или JSON-RPC (…/jsonrpc). */
  tronIsJsonRpc(url) {
    return /\/jsonrpc\/?$/.test(url);
  },

  tronHex(address) {
    const raw = b58check.decode(address); // 0x41 + 20 байт
    return "0x" + bytesToHex(raw.slice(1));
  },

  /* ---------- разрешения сайтов ---------- */

  permissionFor(origin, chain) {
    return this.data?.permissions?.[origin]?.[chain] || null;
  },

  async grantPermission(origin, chain, grant) {
    this.data.permissions ||= {};
    this.data.permissions[origin] ||= { since: new Date().toISOString() };
    this.data.permissions[origin][chain] = { ...grant, at: new Date().toISOString() };
    await this.save();
  },

  async revokePermission(origin, chain) {
    if (!this.data?.permissions?.[origin]) {
      return;
    }
    if (chain) {
      delete this.data.permissions[origin][chain];
    }
    if (!chain || !["evm", "tron", "sol"].some(c => this.data.permissions[origin][c])) {
      delete this.data.permissions[origin];
    }
    await this.save();
  },

  get permissions() {
    return this.data?.permissions || {};
  },

  /* ---------- контакты ---------- */

  /** Ключ адресной книги для сети: все EVM-сети делят один адрес. */
  contactKey(chainId) {
    return CHAINS[chainId]?.kind === "evm" ? "evm" : chainId;
  },

  get contacts() {
    return this.data?.contacts || [];
  },

  async addContact({ name, addresses, note = "" }) {
    const clean = Object.fromEntries(Object.entries(addresses || {}).filter(([, v]) => v && String(v).trim()).map(([k, v]) => [k, String(v).trim()]));
    if (!name?.trim() || !Object.keys(clean).length) {
      throw new Error("Нужны имя и хотя бы один адрес");
    }
    this.data.contacts ||= [];
    const contact = { id: `c${Date.now().toString(36)}`, name: name.trim().slice(0, 40), addresses: clean, note: String(note || "").slice(0, 200), at: new Date().toISOString() };
    this.data.contacts.push(contact);
    await this.save();
    return contact;
  },

  async updateContact(id, patch) {
    const c = this.contacts.find(x => x.id === id);
    if (!c) {
      throw new Error("Контакт не найден");
    }
    if (patch.name !== undefined) {
      c.name = String(patch.name).trim().slice(0, 40) || c.name;
    }
    if (patch.addresses) {
      c.addresses = Object.fromEntries(Object.entries(patch.addresses).filter(([, v]) => v && String(v).trim()).map(([k, v]) => [k, String(v).trim()]));
    }
    if (patch.note !== undefined) {
      c.note = String(patch.note).slice(0, 200);
    }
    await this.save();
  },

  async removeContact(id) {
    this.data.contacts = this.contacts.filter(x => x.id !== id);
    await this.save();
  },

  /** Контакт по адресу в сети (регистр для EVM не важен). */
  contactFor(chainId, address) {
    if (!address) {
      return null;
    }
    const key = this.contactKey(chainId);
    const a = String(address).toLowerCase();
    return this.contacts.find(c => (c.addresses[key] || "").toLowerCase() === a) || null;
  },

  /** Контакты, у которых есть адрес для этой сети. */
  contactsFor(chainId) {
    const key = this.contactKey(chainId);
    return this.contacts.filter(c => c.addresses[key]).map(c => ({ ...c, address: c.addresses[key] }));
  },

  /* ---------- история операций ---------- */

  get activity() {
    return this.data?.activity || [];
  },

  async addActivity(entry) {
    this.data.activity ||= [];
    this.data.activity.unshift({ ...entry, at: new Date().toISOString() });
    this.data.activity = this.data.activity.slice(0, 200);
    await this.save();
  },

  /* ---------- токены ---------- */

  tokensFor(chainId) {
    const chain = CHAINS[chainId];
    const custom = this.data?.settings?.customTokens?.[chainId] || [];
    const hidden = new Set(this.data?.settings?.hiddenTokens?.[chainId] || []);
    const key = t => (t.address || t.mint || "").toLowerCase();
    const all = [...(chain.tokens || []), ...custom.filter(c => !(chain.tokens || []).some(t => key(t) === key(c)))];
    return all.filter(t => !hidden.has(key(t)));
  },

  async addToken(chainId, token) {
    this.data.settings.customTokens ||= {};
    const list = (this.data.settings.customTokens[chainId] ||= []);
    const key = (token.address || token.mint || "").toLowerCase();
    if (!key) {
      throw new Error("Нужен адрес контракта");
    }
    if (!list.some(t => (t.address || t.mint || "").toLowerCase() === key)) {
      list.push({ symbol: token.symbol, decimals: token.decimals, address: token.address, mint: token.mint, custom: true });
    }
    if (this.data.settings.hiddenTokens?.[chainId]) {
      this.data.settings.hiddenTokens[chainId] = this.data.settings.hiddenTokens[chainId].filter(k => k !== key);
    }
    await this.save();
  },

  async hideToken(chainId, token) {
    const key = (token.address || token.mint || "").toLowerCase();
    this.data.settings.hiddenTokens ||= {};
    const list = (this.data.settings.hiddenTokens[chainId] ||= []);
    if (!list.includes(key)) {
      list.push(key);
    }
    if (this.data.settings.customTokens?.[chainId]) {
      this.data.settings.customTokens[chainId] = this.data.settings.customTokens[chainId].filter(t => (t.address || t.mint || "").toLowerCase() !== key);
    }
    await this.save();
  },

  decodeAbiString(hex) {
    if (!hex || hex === "0x") {
      return "";
    }
    const data = hexToBytes(hex.slice(2));
    if (data.length === 32) {
      return new TextDecoder().decode(data).replace(/\0+$/, "");
    }
    const offset = Number(BigInt("0x" + bytesToHex(data.slice(0, 32))));
    const len = Number(BigInt("0x" + bytesToHex(data.slice(offset, offset + 32))));
    return new TextDecoder().decode(data.slice(offset + 32, offset + 32 + len));
  },

  /** Метаданные токена по адресу контракта: символ, имя, знаки. */
  async tokenInfo(chainId, address) {
    const chain = CHAINS[chainId];
    if (chain.kind === "evm" || chain.kind === "tron") {
      let to = address;
      let opts = {};
      if (chain.kind === "tron") {
        const { list } = this.nodesFor(chainId);
        const url = list.find(u => this.tronIsJsonRpc(u));
        if (!url) {
          throw new Error("Нужна JSON-RPC нода TRON");
        }
        to = this.tronHex(address);
        opts = { url };
      }
      const [symbol, name, decimals] = await Promise.all([
        this.evm(chainId, "eth_call", [{ to, data: "0x95d89b41" }, "latest"], opts),
        this.evm(chainId, "eth_call", [{ to, data: "0x06fdde03" }, "latest"], opts),
        this.evm(chainId, "eth_call", [{ to, data: "0x313ce567" }, "latest"], opts),
      ]);
      if (!decimals || decimals === "0x") {
        throw new Error("По этому адресу нет токена");
      }
      return { symbol: this.decodeAbiString(symbol) || "TOKEN", name: this.decodeAbiString(name), decimals: Number(BigInt(decimals)), address };
    }
    if (chain.kind === "sol") {
      const r = await this.rpc(chainId, { jsonrpc: "2.0", id: 1, method: "getTokenSupply", params: [address] });
      if (!r.result) {
        throw new Error("По этому адресу нет SPL-токена");
      }
      return { symbol: "", name: "", decimals: r.result.value.decimals, mint: address };
    }
    throw new Error("В этой сети нет токенов");
  },

  /* ---------- балансы ---------- */

  format(raw, decimals, max = 6) {
    const s = BigInt(raw).toString().padStart(decimals + 1, "0");
    const int = s.slice(0, s.length - decimals) || "0";
    const frac = s.slice(s.length - decimals).slice(0, max).replace(/0+$/, "");
    return frac ? `${int}.${frac}` : int;
  },

  async balance(chainId, address = this.activeAccount?.addresses?.[chainId]) {
    const chain = CHAINS[chainId];
    if (!address) {
      return null;
    }
    const out = { chain: chainId, address, native: "0", tokens: [] };
    if (chain.kind === "evm") {
      const wei = await this.evm(chainId, "eth_getBalance", [address, "latest"]);
      out.native = this.format(BigInt(wei), chain.decimals);
      await Promise.all(this.tokensFor(chainId).map(async t => {
        try {
          const data = "0x70a08231" + address.slice(2).toLowerCase().padStart(64, "0");
          const hex = await this.evm(chainId, "eth_call", [{ to: t.address, data }, "latest"]);
          const v = BigInt(hex === "0x" ? 0 : hex);
          out.tokens.push({ symbol: t.symbol, logo: t.logo, amount: this.format(v, t.decimals, 2), raw: v.toString(), decimals: t.decimals, address: t.address, custom: !!t.custom });
        } catch (e) {}
      }));
    } else if (chain.kind === "btc") {
      const info = await this.rpc(chainId, null, `/address/${address}`);
      const sats = BigInt(info.chain_stats.funded_txo_sum - info.chain_stats.spent_txo_sum + info.mempool_stats.funded_txo_sum - info.mempool_stats.spent_txo_sum);
      out.native = this.format(sats, 8, 8);
    } else if (chain.kind === "sol") {
      const r = await this.rpc(chainId, { jsonrpc: "2.0", id: 1, method: "getBalance", params: [address] });
      out.native = this.format(BigInt(r.result?.value || 0), 9);
      try {
        const t = await this.rpc(chainId, { jsonrpc: "2.0", id: 2, method: "getTokenAccountsByOwner", params: [address, { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }, { encoding: "jsonParsed" }] });
        const held = new Map((t.result?.value || []).map(acc => [acc.account.data.parsed.info.mint, acc.account.data.parsed.info]));
        for (const known of this.tokensFor(chainId)) {
          const info = held.get(known.mint);
          out.tokens.push({ symbol: known.symbol, logo: known.logo, amount: info ? info.tokenAmount.uiAmountString : "0", raw: info?.tokenAmount.amount || "0", mint: known.mint, decimals: known.decimals, custom: !!known.custom });
        }
      } catch (e) {}
    } else if (chain.kind === "tron") {
      const { list, index: saved } = this.nodesFor(chainId);
      const index = this._nodeOverride[chainId] ?? saved;
      let lastError = null;
      for (let step = 0; step < list.length; step++) {
        const i = (index + step) % list.length;
        const url = list[i];
        try {
          out.tokens = [];
          if (this.tronIsJsonRpc(url)) {
            const hex = this.tronHex(address);
            const sun = await this.evm(chainId, "eth_getBalance", [hex, "latest"], { url });
            out.native = this.format(BigInt(sun), 6);
            for (const t of this.tokensFor(chainId)) {
              try {
                const data = "0x70a08231" + hex.slice(2).padStart(64, "0");
                const v = BigInt((await this.evm(chainId, "eth_call", [{ to: this.tronHex(t.address), data }, "latest"], { url })) || 0);
                out.tokens.push({ symbol: t.symbol, logo: t.logo, amount: this.format(v, t.decimals, 2), raw: v.toString(), decimals: t.decimals, address: t.address, custom: !!t.custom });
              } catch (e) {}
            }
          } else {
            const r = await this.rpc(chainId, null, `/v1/accounts/${address}`, { url });
            const acc = r.data?.[0];
            out.native = this.format(BigInt(acc?.balance || 0), 6);
            const held = new Map();
            for (const entry of acc?.trc20 || []) {
              for (const [contract, amount] of Object.entries(entry)) {
                held.set(contract, String(amount));
              }
            }
            for (const known of this.tokensFor(chainId)) {
              const raw = held.get(known.address) || "0";
              out.tokens.push({ symbol: known.symbol, logo: known.logo, amount: this.format(BigInt(raw), known.decimals, 2), raw, decimals: known.decimals, address: known.address, custom: !!known.custom });
            }
          }
          if (i !== index) {
            this._nodeOverride[chainId] = i;
          }
          lastError = null;
          break;
        } catch (e) {
          lastError = e;
        }
      }
      if (lastError) {
        throw lastError;
      }
    }
    return out;
  },

  async prices() {
    if (this._prices && Date.now() - this._prices.at < 120000) {
      return this._prices.data;
    }
    try {
      const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum,bitcoin,solana,tron,polygon-ecosystem-token&vs_currencies=usd");
      const j = await res.json();
      const data = { ETH: j.ethereum?.usd, BTC: j.bitcoin?.usd, SOL: j.solana?.usd, TRX: j.tron?.usd, POL: j["polygon-ecosystem-token"]?.usd, USDT: 1, USDC: 1, DAI: 1 };
      this._prices = { at: Date.now(), data };
      return data;
    } catch (e) {
      return this._prices?.data || {};
    }
  },

  /* ---------- история из сети ---------- */

  /** Операции по адресу из публичных источников, нормализованные и очищенные от спама.
   * entry: { id, hash, chain, at, dir: in|out|self, amount, symbol, logo, counterparty, usd, status, kind } */
  async history(chainId, address = this.activeAccount?.addresses?.[chainId], prices = {}) {
    const chain = CHAINS[chainId];
    if (!address) {
      return { items: [], hidden: 0 };
    }
    const known = new Map(this.tokensFor(chainId).map(t => [(t.address || t.mint).toLowerCase(), t]));
    const raw = [];
    const me = address.toLowerCase();
    const dirOf = (from, to) => (from?.toLowerCase() === me && to?.toLowerCase() === me ? "self" : from?.toLowerCase() === me ? "out" : "in");
    if (chain.kind === "evm" && chain.history) {
      const get = async path => {
        const res = await fetch(`${chain.history}/api/v2/addresses/${address}${path}`, { signal: timeoutSignal(15000) });
        if (!res.ok) {
          throw new Error(`${new URL(chain.history).host}: HTTP ${res.status}`);
        }
        return (await res.json()).items || [];
      };
      const [txs, transfers] = await Promise.all([get("/transactions").catch(() => []), get("/token-transfers?type=ERC-20").catch(() => [])]);
      for (const t of txs.slice(0, 30)) {
        const value = BigInt(t.value || 0);
        if (value === 0n && !t.to?.hash) {
          continue;
        }
        raw.push({ hash: t.hash, at: Date.parse(t.timestamp), dir: dirOf(t.from?.hash, t.to?.hash), from: t.from?.hash, to: t.to?.hash, rawAmount: value, decimals: chain.decimals, symbol: chain.symbol, logo: chain.logo, kind: "native", status: t.status === "ok" ? "ok" : t.status === null ? "pending" : "failed", scam: t.from?.is_scam || (t.from?.reputation && t.from.reputation !== "ok"), call: value === 0n && t.method ? t.method : null });
      }
      for (const t of transfers.slice(0, 40)) {
        const token = known.get((t.token?.address || t.token?.address_hash || "").toLowerCase());
        raw.push({ hash: t.tx_hash || t.transaction_hash, at: Date.parse(t.timestamp), dir: dirOf(t.from?.hash, t.to?.hash), from: t.from?.hash, to: t.to?.hash, rawAmount: BigInt(t.total?.value || 0), decimals: Number(t.total?.decimals ?? token?.decimals ?? 18), symbol: token?.symbol || t.token?.symbol || "?", logo: token?.logo || null, kind: "token", known: !!token, status: "ok", scam: t.from?.is_scam || (t.from?.reputation && t.from.reputation !== "ok") || t.token?.reputation === "scam" });
      }
    } else if (chain.kind === "btc") {
      const txs = await this.rpc(chainId, null, `/address/${address}/txs`);
      for (const t of txs.slice(0, 30)) {
        const inMine = t.vin.filter(v => v.prevout?.scriptpubkey_address === address).reduce((n, v) => n + BigInt(v.prevout.value), 0n);
        const outMine = t.vout.filter(v => v.scriptpubkey_address === address).reduce((n, v) => n + BigInt(v.value), 0n);
        const delta = outMine - inMine;
        const dir = inMine > 0n ? (outMine > 0n && delta >= 0n ? "self" : "out") : "in";
        const other = dir === "in" ? t.vin.find(v => v.prevout?.scriptpubkey_address && v.prevout.scriptpubkey_address !== address)?.prevout.scriptpubkey_address : t.vout.find(v => v.scriptpubkey_address && v.scriptpubkey_address !== address)?.scriptpubkey_address;
        raw.push({ hash: t.txid, at: t.status?.confirmed ? t.status.block_time * 1000 : Date.now(), dir, from: dir === "in" ? other : address, to: dir === "in" ? address : other, rawAmount: delta < 0n ? -delta - (dir === "out" ? BigInt(t.fee || 0) : 0n) : delta, decimals: 8, symbol: "BTC", logo: chain.logo, kind: "native", status: t.status?.confirmed ? "ok" : "pending", fee: BigInt(t.fee || 0) });
      }
    } else if (chain.kind === "sol") {
      const sigs = await this.rpc(chainId, { jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress", params: [address, { limit: 12 }] });
      const list = sigs.result || [];
      const txs = await Promise.all(list.map(sg => this.rpc(chainId, { jsonrpc: "2.0", id: 2, method: "getTransaction", params: [sg.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }] }).then(r => r.result).catch(() => null)));
      txs.forEach((tx, i) => {
        const sg = list[i];
        if (!tx) {
          return;
        }
        const keys = tx.transaction.message.accountKeys.map(k => k.pubkey || k);
        const idx = keys.indexOf(address);
        const failed = !!tx.meta?.err;
        const at = (tx.blockTime || sg.blockTime || 0) * 1000;
        if (idx !== -1) {
          const delta = BigInt(tx.meta.postBalances[idx]) - BigInt(tx.meta.preBalances[idx]);
          const fee = idx === 0 ? BigInt(tx.meta.fee || 0) : 0n;
          const amount = delta < 0n ? -delta - fee : delta;
          if (amount !== 0n || (delta < 0n && !tx.meta.postTokenBalances?.length)) {
            const other = keys.find((k, j) => j !== idx && !/^(11111111111111111111111111111111|ComputeBudget|Tokenkeg|ATokenGP)/.test(k));
            raw.push({ hash: sg.signature, at, dir: delta < 0n ? "out" : "in", from: delta < 0n ? address : other, to: delta < 0n ? other : address, rawAmount: amount, decimals: 9, symbol: "SOL", logo: chain.logo, kind: "native", status: failed ? "failed" : "ok" });
          }
        }
        const pre = new Map((tx.meta.preTokenBalances || []).filter(b => b.owner === address).map(b => [b.mint, BigInt(b.uiTokenAmount.amount)]));
        for (const b of tx.meta.postTokenBalances || []) {
          if (b.owner !== address) {
            continue;
          }
          const d = BigInt(b.uiTokenAmount.amount) - (pre.get(b.mint) || 0n);
          pre.delete(b.mint);
          if (d === 0n) {
            continue;
          }
          const token = known.get(b.mint.toLowerCase());
          raw.push({ hash: sg.signature, at, dir: d < 0n ? "out" : "in", rawAmount: d < 0n ? -d : d, decimals: b.uiTokenAmount.decimals, symbol: token?.symbol || "?", logo: token?.logo || null, kind: "token", known: !!token, status: failed ? "failed" : "ok", from: d < 0n ? address : null, to: d < 0n ? null : address });
        }
        for (const [mint, amount] of pre) {
          const token = known.get(mint.toLowerCase());
          raw.push({ hash: sg.signature, at, dir: "out", rawAmount: amount, decimals: token?.decimals ?? 0, symbol: token?.symbol || "?", logo: token?.logo || null, kind: "token", known: !!token, status: failed ? "failed" : "ok", from: address, to: null });
        }
      });
    } else if (chain.kind === "tron") {
      const base = this.nodesFor(chainId).list.find(u => !this.tronIsJsonRpc(u)) || "https://api.trongrid.io";
      const get = async path => {
        const res = await fetch(`${base}/v1/accounts/${address}${path}`, { signal: timeoutSignal(15000) });
        if (!res.ok) {
          throw new Error(`TRON: HTTP ${res.status}`);
        }
        return (await res.json()).data || [];
      };
      const [txs, trc20] = await Promise.all([get("/transactions?limit=30&only_confirmed=true").catch(() => []), get("/transactions/trc20?limit=40&only_confirmed=true").catch(() => [])]);
      const b58 = hex => {
        try {
          return b58check.encode(hexToBytes(hex));
        } catch (e) {
          return hex;
        }
      };
      for (const t of txs) {
        const c = t.raw_data?.contract?.[0];
        const v = c?.parameter?.value || {};
        const ok = t.ret?.[0]?.contractRet === "SUCCESS";
        if (c?.type === "TransferContract") {
          const from = b58(v.owner_address);
          const to = b58(v.to_address);
          raw.push({ hash: t.txID, at: t.block_timestamp, dir: dirOf(from, to), from, to, rawAmount: BigInt(v.amount || 0), decimals: 6, symbol: "TRX", logo: chain.logo, kind: "native", status: ok ? "ok" : "failed" });
        } else if (c && b58(v.owner_address) === address && c.type !== "TriggerSmartContract") {
          raw.push({ hash: t.txID, at: t.block_timestamp, dir: "out", from: address, to: null, rawAmount: 0n, decimals: 6, symbol: "TRX", logo: chain.logo, kind: "native", status: ok ? "ok" : "failed", call: c.type.replace(/Contract$/, "") });
        }
      }
      for (const t of trc20) {
        if (t.type !== "Transfer") {
          continue;
        }
        const token = known.get((t.token_info?.address || "").toLowerCase());
        raw.push({ hash: t.transaction_id, at: t.block_timestamp, dir: dirOf(t.from, t.to), from: t.from, to: t.to, rawAmount: BigInt(t.value || 0), decimals: Number(t.token_info?.decimals ?? token?.decimals ?? 6), symbol: token?.symbol || t.token_info?.symbol || "?", logo: token?.logo || null, kind: "token", known: !!token, status: "ok" });
      }
    }
    return this.filterHistory(chainId, raw, prices);
  },

  /** Фильтр спама и нормализация. Скрываем: входящие неизвестные токены, пыль (< $0.01),
   * нулевые переводы, «отравление адреса», помеченных скамеров, неудачные входящие. */
  filterHistory(chainId, raw, prices) {
    const chain = CHAINS[chainId];
    const items = [];
    let hidden = 0;
    const seen = new Set();
    for (const r of raw) {
      const amount = this.format(r.rawAmount, r.decimals, 8);
      const price = prices[r.symbol] ?? (/^(USDT|USDC|DAI)$/.test(r.symbol) ? 1 : null);
      const usd = price === null ? null : parseFloat(amount) * price;
      const incoming = r.dir === "in";
      let spam = false;
      if (r.scam) {
        spam = true;
      } else if (incoming && r.kind === "token" && !r.known) {
        spam = true; // неизвестный токен «подарком»
      } else if (incoming && r.rawAmount === 0n) {
        spam = true; // нулевой перевод (отравление адреса)
      } else if (incoming && ((usd !== null && usd < 0.5) || (r.kind === "native" && chain.dust && parseFloat(amount) < chain.dust))) {
        spam = true; // пыль (в т. ч. «отравление адреса» мелкими суммами), даже если курс не загрузился
      } else if (incoming && r.status === "failed") {
        spam = true;
      } else if (incoming && r.kind === "token" && /^(USDT|USDC|DAI)$/.test(r.symbol) && usd !== null && usd < 0.5 && r.decimals >= 6) {
        spam = true; // «1 USDT» от неизвестного — классическое отравление с мелкой суммой
      }
      if (spam) {
        hidden++;
        continue;
      }
      const id = `${chainId}:${r.hash}:${r.kind}:${r.symbol}:${r.dir}`;
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      items.push({ id, hash: r.hash, chain: chainId, chainName: chain.name, chainLogo: chain.logo, at: r.at || 0, dir: r.dir, amount, symbol: r.symbol, logo: r.logo || chain.logo, counterparty: incoming ? r.from : r.to, usd, status: r.status, kind: r.kind, call: r.call || null });
    }
    items.sort((a, b) => b.at - a.at);
    return { items, hidden };
  },

  /** Самопроверка деривации на эталонной фразе BIP-39 (для тестов). */
  selfTest() {
    const phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const seed = bip39.mnemonicToSeedSync(phrase);
    const a = { 0: this.deriveAll(seed, 0), 1: this.deriveAll(seed, 1) };
    wipe(seed);
    return a;
  },
};
