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

export const CHAINS = {
  ethereum: { id: "ethereum", name: "Ethereum", symbol: "ETH", kind: "evm", chainId: 1, decimals: 18, color: "#8a92ff", path: "m/44'/60'/0'/0/{i}",
    nodes: ["https://ethereum-rpc.publicnode.com", "https://cloudflare-eth.com", "https://rpc.ankr.com/eth", "https://eth.llamarpc.com"],
    explorer: "https://etherscan.io/address/",
    tokens: [{ symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 }, { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 }] },
  base: { id: "base", name: "Base", symbol: "ETH", kind: "evm", chainId: 8453, decimals: 18, color: "#4f7bff", path: "m/44'/60'/0'/0/{i}", sameAs: "ethereum",
    nodes: ["https://base-rpc.publicnode.com", "https://mainnet.base.org", "https://base.llamarpc.com"], explorer: "https://basescan.org/address/",
    tokens: [{ symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 }] },
  arbitrum: { id: "arbitrum", name: "Arbitrum", symbol: "ETH", kind: "evm", chainId: 42161, decimals: 18, color: "#6fb6ff", path: "m/44'/60'/0'/0/{i}", sameAs: "ethereum",
    nodes: ["https://arbitrum-one-rpc.publicnode.com", "https://arb1.arbitrum.io/rpc"], explorer: "https://arbiscan.io/address/",
    tokens: [{ symbol: "USDT", address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6 }, { symbol: "USDC", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 }] },
  polygon: { id: "polygon", name: "Polygon", symbol: "POL", kind: "evm", chainId: 137, decimals: 18, color: "#c39bff", path: "m/44'/60'/0'/0/{i}", sameAs: "ethereum",
    nodes: ["https://polygon-bor-rpc.publicnode.com", "https://polygon-rpc.com"], explorer: "https://polygonscan.com/address/",
    tokens: [{ symbol: "USDT", address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6 }, { symbol: "USDC", address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6 }] },
  bitcoin: { id: "bitcoin", name: "Bitcoin", symbol: "BTC", kind: "btc", decimals: 8, color: "#ff9f5a", path: "m/84'/0'/0'/0/{i}",
    nodes: ["https://mempool.space/api", "https://blockstream.info/api"], explorer: "https://mempool.space/address/" },
  solana: { id: "solana", name: "Solana", symbol: "SOL", kind: "sol", decimals: 9, color: "#5ee0d0", path: "m/44'/501'/{i}'/0'",
    nodes: ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com", "https://rpc.ankr.com/solana"], explorer: "https://solscan.io/account/",
    tokens: [{ symbol: "USDC", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 }, { symbol: "USDT", mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6 }] },
  tron: { id: "tron", name: "TRON", symbol: "TRX", kind: "tron", decimals: 6, color: "#ff7b7b", path: "m/44'/195'/0'/0/{i}",
    nodes: ["https://api.trongrid.io", "https://tron-rpc.publicnode.com/jsonrpc"], explorer: "https://tronscan.org/#/address/",
    tokens: [{ symbol: "USDT", address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", decimals: 6 }] },
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

  async save() {
    await IOUtils.writeJSON(FILE(), this.data, { tmpPath: FILE() + ".tmp" });
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
    const plain = utf8ToBytes(JSON.stringify({ mnemonic: phrase }));
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
    const phrases = [];
    for (const w of this.wallets) {
      phrases.push(await this.mnemonicOf(w));
    }
    const passwordless = !newPassword;
    const salt = randomBytes(16);
    const raw = passwordless ? await loginKey(true) : deriveKey(newPassword, salt, KDF);
    this.data.check = await encrypt(raw, utf8ToBytes("tabora-wallet-check"));
    for (let i = 0; i < this.wallets.length; i++) {
      const plain = utf8ToBytes(JSON.stringify({ mnemonic: phrases[i] }));
      this.wallets[i].vault = await encrypt(raw, plain);
      wipe(plain);
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
    const phrase = await this.mnemonicOf(wallet);
    const chain = CHAINS[chainId];
    const seed = bip39.mnemonicToSeedSync(phrase);
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

  setNodes(chainId, list, index, { quiet = false } = {}) {
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
      for (const t of chain.tokens || []) {
        try {
          const data = "0x70a08231" + address.slice(2).toLowerCase().padStart(64, "0");
          const hex = await this.evm(chainId, "eth_call", [{ to: t.address, data }, "latest"]);
          const v = BigInt(hex === "0x" ? 0 : hex);
          if (v > 0n) {
            out.tokens.push({ symbol: t.symbol, amount: this.format(v, t.decimals, 2), raw: v.toString(), decimals: t.decimals, address: t.address });
          }
        } catch (e) {}
      }
    } else if (chain.kind === "btc") {
      const info = await this.rpc(chainId, null, `/address/${address}`);
      const sats = BigInt(info.chain_stats.funded_txo_sum - info.chain_stats.spent_txo_sum + info.mempool_stats.funded_txo_sum - info.mempool_stats.spent_txo_sum);
      out.native = this.format(sats, 8, 8);
    } else if (chain.kind === "sol") {
      const r = await this.rpc(chainId, { jsonrpc: "2.0", id: 1, method: "getBalance", params: [address] });
      out.native = this.format(BigInt(r.result?.value || 0), 9);
      try {
        const t = await this.rpc(chainId, { jsonrpc: "2.0", id: 2, method: "getTokenAccountsByOwner", params: [address, { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }, { encoding: "jsonParsed" }] });
        for (const acc of t.result?.value || []) {
          const info = acc.account.data.parsed.info;
          const known = (chain.tokens || []).find(x => x.mint === info.mint);
          const ui = info.tokenAmount.uiAmountString;
          if (known && parseFloat(ui) > 0) {
            out.tokens.push({ symbol: known.symbol, amount: ui, mint: info.mint, decimals: known.decimals });
          }
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
            for (const t of chain.tokens || []) {
              try {
                const data = "0x70a08231" + hex.slice(2).padStart(64, "0");
                const v = BigInt((await this.evm(chainId, "eth_call", [{ to: this.tronHex(t.address), data }, "latest"], { url })) || 0);
                if (v > 0n) {
                  out.tokens.push({ symbol: t.symbol, amount: this.format(v, t.decimals, 2), raw: v.toString(), decimals: t.decimals, address: t.address });
                }
              } catch (e) {}
            }
          } else {
            const r = await this.rpc(chainId, null, `/v1/accounts/${address}`, { url });
            const acc = r.data?.[0];
            out.native = this.format(BigInt(acc?.balance || 0), 6);
            for (const entry of acc?.trc20 || []) {
              for (const [contract, amount] of Object.entries(entry)) {
                const known = (chain.tokens || []).find(x => x.address === contract);
                if (known && BigInt(amount) > 0n) {
                  out.tokens.push({ symbol: known.symbol, amount: this.format(BigInt(amount), known.decimals, 2), raw: String(amount), decimals: known.decimals, address: contract });
                }
              }
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
      const data = { ETH: j.ethereum?.usd, BTC: j.bitcoin?.usd, SOL: j.solana?.usd, TRX: j.tron?.usd, POL: j["polygon-ecosystem-token"]?.usd, USDT: 1, USDC: 1 };
      this._prices = { at: Date.now(), data };
      return data;
    } catch (e) {
      return this._prices?.data || {};
    }
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
