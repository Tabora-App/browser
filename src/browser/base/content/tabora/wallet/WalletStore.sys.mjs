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
const C = ChromeUtils.importESModule("chrome://tabora/content/wallet/vendor/crypto.sys.mjs");
const { argon2idAsync } = ChromeUtils.importESModule("chrome://tabora/content/vault/Kdf.sys.mjs");
const { sha256, keccak_256, hmac, sha512, argon2id, randomBytes, bytesToHex, hexToBytes, utf8ToBytes, secp256k1, ed25519, bip39, wordlistEnglish, HDKey, base58, base58check, base64, btc } = C;

const FILE = () => PathUtils.join(PathUtils.profileDir, "tabora-wallet.json");
const KDF = { t: 3, m: 65536, p: 1, dkLen: 32 }; // Argon2id: 64 МБ памяти, 3 прохода (старые файлы хранят свои параметры)
const LOGIN_ORIGIN = "chrome://tabora-wallet";
// Старые места хранения: автоблокировка и ноды теперь в подписанном файле, настройки профиля читаются только до переноса
const AUTOLOCK_PREF = "tabora.wallet.autolockMinutes";
const NODES_PREF = "tabora.wallet.nodes";
const DEFAULT_AUTOLOCK = 15;
const STABLE = /^(USDT|USDC|DAI)$/;
const b58check = base58check(sha256);
export const qrcodegen = C.qrcodegen;

const LOGO = name => `chrome://tabora/content/wallet/logos/${name}.png`;

export const CHAINS = {
  ethereum: { id: "ethereum", logo: LOGO("ethereum"), name: "Ethereum", symbol: "ETH", kind: "evm", chainId: 1, decimals: 18, dust: 0.0001, color: "#8a92ff", path: "m/44'/60'/0'/0/{i}", wrapped: { symbol: "WETH", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" },
    nodes: ["https://ethereum-rpc.publicnode.com", "https://cloudflare-eth.com", "https://rpc.ankr.com/eth", "https://eth.llamarpc.com"],
    explorer: "https://etherscan.io/address/", history: "https://eth.blockscout.com",
    tokens: [{ symbol: "USDT", logo: LOGO("usdt"), address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 }, { symbol: "USDC", logo: LOGO("usdc"), address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 }, { symbol: "DAI", logo: LOGO("dai"), address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", decimals: 18 }] },
  base: { id: "base", logo: LOGO("base"), name: "Base", symbol: "ETH", kind: "evm", chainId: 8453, decimals: 18, dust: 0.0001, color: "#4f7bff", path: "m/44'/60'/0'/0/{i}", sameAs: "ethereum", wrapped: { symbol: "WETH", address: "0x4200000000000000000000000000000000000006" },
    nodes: ["https://base-rpc.publicnode.com", "https://mainnet.base.org", "https://base.llamarpc.com"], explorer: "https://basescan.org/address/", history: "https://base.blockscout.com",
    tokens: [{ symbol: "USDC", logo: LOGO("usdc"), address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 }, { symbol: "USDT", logo: LOGO("usdt"), address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", decimals: 6 }] },
  arbitrum: { id: "arbitrum", logo: LOGO("arbitrum"), name: "Arbitrum", symbol: "ETH", kind: "evm", chainId: 42161, decimals: 18, dust: 0.0001, color: "#6fb6ff", path: "m/44'/60'/0'/0/{i}", sameAs: "ethereum", wrapped: { symbol: "WETH", address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1" },
    nodes: ["https://arbitrum-one-rpc.publicnode.com", "https://arb1.arbitrum.io/rpc"], explorer: "https://arbiscan.io/address/", history: "https://arbitrum.blockscout.com",
    tokens: [{ symbol: "USDT", logo: LOGO("usdt"), address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6 }, { symbol: "USDC", logo: LOGO("usdc"), address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 }] },
  polygon: { id: "polygon", logo: LOGO("polygon"), name: "Polygon", symbol: "POL", kind: "evm", chainId: 137, decimals: 18, dust: 0.5, color: "#c39bff", path: "m/44'/60'/0'/0/{i}", sameAs: "ethereum", wrapped: { symbol: "WPOL", address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270" },
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
  wipe(I);
  const parts = path.replace(/^m\//, "").split("/");
  for (const p of parts) {
    const index = (parseInt(p.replace("'", ""), 10) | 0x80000000) >>> 0;
    const data = new Uint8Array(1 + 32 + 4);
    data[0] = 0;
    data.set(key, 1);
    new DataView(data.buffer).setUint32(33, index, false);
    I = hmac(sha512, chain, data);
    wipe(data);
    wipe(key);
    wipe(chain);
    key = I.slice(0, 32);
    chain = I.slice(32);
    wipe(I);
  }
  wipe(chain);
  return key;
}

/** Сигнал отмены по таймауту (в sys.mjs нет AbortSignal.timeout). */
function timeoutSignal(ms) {
  const c = new AbortController();
  setTimeout(() => c.abort(new Error(`таймаут ${ms / 1000} с`)), ms);
  return c.signal;
}

/** fetch с таймаутом, без редиректов и с лимитом размера ответа: публичная нода не должна уронить браузер. */
async function fetchJson(url, init = {}, { timeout = 12000, maxBytes = 4 << 20, redirect = "error" } = {}) {
  const res = await fetch(url, { ...init, redirect, signal: timeoutSignal(timeout) });
  let host = url;
  try {
    host = new URL(url).host;
  } catch (e) {}
  if (!res.ok) {
    throw new Error(`${host}: HTTP ${res.status}`);
  }
  if (Number(res.headers.get("content-length") || 0) > maxBytes) {
    throw new Error(`${host}: ответ слишком большой`);
  }
  const reader = res.body?.getReader?.();
  if (!reader) {
    const text = await res.text();
    if (text.length > maxBytes) {
      throw new Error(`${host}: ответ слишком большой`);
    }
    return JSON.parse(text);
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.length;
    if (total > maxBytes) {
      reader.cancel().catch(() => {});
      throw new Error(`${host}: ответ слишком большой`);
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    buf.set(c, o);
    o += c.length;
  }
  return JSON.parse(new TextDecoder().decode(buf));
}

/** Текст из сети/контракта: без невидимых и управляющих символов, с лимитом длины. */
function cleanText(text, max = 40) {
  return String(text ?? "").replace(/[\p{Cf}\p{Cc}\u2028\u2029]/gu, "").normalize("NFKC").trim().slice(0, max);
}

/** Число десятичных знаков из недоверенного источника: 0..36, иначе ошибка. */
function safeDecimals(v, fallback = null) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 36) {
    if (fallback !== null) {
      return fallback;
    }
    throw new Error("Недопустимое число десятичных знаков");
  }
  return n;
}

const CHECK_V2 = "tabora-wallet-check";
const CHECK_V3 = "tabora-wallet-check:v3"; // v3: подпись (mac) открытой части обязательна
const CHECK_V4 = "tabora-wallet-check:v4"; // v4: каждый шифроблок привязан к назначению (AAD), блоки не взаимозаменяемы
/** Назначение шифроблока (AAD AES-GCM): check нельзя подставить как seed, seed одного кошелька — другому. */
const AAD = {
  check: "tabora-wallet:check",
  mark: "tabora-wallet:mark",
  vault: id => `tabora-wallet:vault:${id}`,
  seed: id => `tabora-wallet:seed:${id}`,
};
const DUST_USD = 0.5; // входящие дешевле — пыль (отравление адреса мелкими суммами)
const BACKUPS = [".pre-v4.bak", ".before-accept.bak"];

/** Порог пыли монеты сети в базовых единицах (wei, сатоши, лампорты, sun): считается по BigInt, без дробей. */
function dustRaw(chain) {
  if (!chain?.dust) {
    return 0n;
  }
  return BigInt(Math.round(chain.dust * 1e6)) * 10n ** BigInt(Math.max(0, chain.decimals - 6));
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

/** aad — назначение блока (строка) или null для блоков старого формата (до v4). */
function gcm(iv, aad) {
  return aad ? { name: "AES-GCM", iv, additionalData: utf8ToBytes(aad) } : { name: "AES-GCM", iv };
}

async function encrypt(raw, plaintext, aad = null) {
  const iv = randomBytes(12);
  const key = await aesKey(raw);
  const ct = new Uint8Array(await crypto.subtle.encrypt(gcm(iv, aad), key, plaintext));
  return { iv: base64.encode(iv), ct: base64.encode(ct) };
}

async function decrypt(raw, iv, ct, aad = null) {
  const key = await aesKey(raw);
  return new Uint8Array(await crypto.subtle.decrypt(gcm(base64.decode(iv), aad), key, base64.decode(ct)));
}

async function deriveKey(password, salt, kdf) {
  const t = Number(kdf?.t);
  const m = Number(kdf?.m);
  const p = Number(kdf?.p);
  const dkLen = Number(kdf?.dkLen);
  // параметры приходят из файла: вне границ это либо повреждение, либо попытка подвесить браузер
  if (!(t >= 1 && t <= 10) || !(m >= 8192 && m <= 1 << 20) || !(p >= 1 && p <= 4) || dkLen !== 32 || !(salt?.length >= 8)) {
    throw new Error("Файл кошелька повреждён: параметры KDF вне допустимых границ");
  }
  return argon2idAsync(utf8ToBytes(password.normalize("NFKC")), salt, { t, m, p, dkLen });
}

/* Ключ режима «без пароля» в менеджере паролей. Смена ключа идёт в два шага, чтобы сбой между записью файла
 * и записью ключа не оставил кошелёк без ключа: новый ключ сначала кладётся как vault-key-next, после успешной
 * записи файла становится vault-key. При разблокировке пробуются оба. */
const KEY_USER = "vault-key";
const KEY_NEXT = "vault-key-next";

async function loginFind(username) {
  const logins = await Services.logins.searchLoginsAsync({ origin: LOGIN_ORIGIN });
  return logins.find(l => l.username === username) || null;
}

async function loginGet(username) {
  const found = await loginFind(username);
  return found ? base64.decode(found.password) : null;
}

async function loginSet(username, raw) {
  const found = await loginFind(username);
  const value = base64.encode(raw);
  if (found) {
    if (found.password !== value) {
      const n = found.clone();
      n.password = value;
      Services.logins.modifyLogin(found, n);
    }
    return;
  }
  const info = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
  info.init(LOGIN_ORIGIN, null, "Tabora Wallet", username, value, "", "");
  await Services.logins.addLoginAsync(info);
}

async function loginRemove(username) {
  const logins = await Services.logins.searchLoginsAsync({ origin: LOGIN_ORIGIN });
  for (const l of logins) {
    if (l.username === username) {
      Services.logins.removeLogin(l);
    }
  }
}

/** Новый ключ стал основным (файл уже записан этим ключом). */
async function promoteLoginKey(raw) {
  await loginSet(KEY_USER, raw);
  await loginRemove(KEY_NEXT);
}

async function removeLoginKey() {
  for (const name of [KEY_USER, KEY_NEXT]) {
    try {
      await loginRemove(name);
    } catch (e) {}
  }
}

/** Последняя известная ревизия файла: защита от отката к старой, но подписанной копии.
 * Хранится в менеджере паролей (вне файла кошелька). При мастер-пароле Firefox без входа — не трогаем. */
async function getRevMarker() {
  try {
    if (!Services.logins.isLoggedIn) {
      return null;
    }
    const logins = await Services.logins.searchLoginsAsync({ origin: LOGIN_ORIGIN });
    const f = logins.find(l => l.username === "file-rev");
    return f ? Number(f.password) || 0 : null;
  } catch (e) {
    return null;
  }
}

async function setRevMarker(rev) {
  try {
    if (!Services.logins.isLoggedIn) {
      return;
    }
    const logins = await Services.logins.searchLoginsAsync({ origin: LOGIN_ORIGIN });
    const f = logins.find(l => l.username === "file-rev");
    if (f) {
      if (Number(f.password) !== rev) {
        const n = f.clone();
        n.password = String(rev);
        Services.logins.modifyLogin(f, n);
      }
      return;
    }
    const info = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
    info.init(LOGIN_ORIGIN, null, "Tabora Wallet", "file-rev", String(rev), "", "");
    await Services.logins.addLoginAsync(info);
  } catch (e) {}
}

/* ---------- хранилище ---------- */

export const WalletStore = {
  TOPIC: "tabora-wallet-changed",
  fetchJson,
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

  /** Настройки из файла. Пока правки подменённого файла не подтверждены паролем, действуют значения по умолчанию. */
  get settings() {
    return this.tampered ? {} : this.data?.settings || {};
  },

  /** Изменения настроек, контактов и разрешений возможны только в доверенном (подписанном) файле. */
  assertTrusted() {
    if (!this.unlocked) {
      throw new Error("Кошелёк заблокирован");
    }
    if (this.tampered) {
      throw new Error("Файл кошелька изменён вне Tabora: сначала подтвердите правки паролем");
    }
  },

  /** Пароль при подписи: каждый раз (по умолчанию) или только выше порога в долларах (0 — никогда до автоблокировки). */
  get signPassword() {
    const s = this.settings.signPassword;
    const t = Number(s?.thresholdUsd ?? 500);
    return { skip: !!s?.skip, thresholdUsd: Number.isFinite(t) && t >= 0 ? t : 500 };
  },

  /** Ослабление защиты (пароль реже, порог выше, «никогда») требует пароль кошелька. */
  async setSignPassword({ skip, thresholdUsd = 500 }, password) {
    this.assertTrusted();
    const next = { skip: !!skip, thresholdUsd: Math.max(0, Number(thresholdUsd) || 0) };
    const cur = this.signPassword;
    const limit = v => (v > 0 ? v : Infinity); // порог 0 — «никогда»: слабее любого
    if (next.skip && (!cur.skip || limit(next.thresholdUsd) > limit(cur.thresholdUsd))) {
      await this.verifyPassword(password);
    }
    this.data.settings ||= {};
    this.data.settings.signPassword = next;
    await this.save();
  },

  /** Нужен ли пароль для этой подписи: опасные операции и суммы от порога — всегда.
   * usd = null — сумма неизвестна (нет курса, токен вне встроенного списка): считается выше порога. */
  signPasswordNeeded(usd = null, danger = false) {
    if (this.passwordless) {
      return false;
    }
    const s = this.signPassword;
    if (!s.skip || danger || this.tampered) {
      return true;
    }
    if (!(s.thresholdUsd > 0)) {
      return false;
    }
    const n = usd === null || usd === undefined ? NaN : Number(usd);
    // порог накопительный: сумма операций без пароля с последнего ввода пароля не должна его превысить
    return !Number.isFinite(n) || n < 0 || n + this._spentUsd >= s.thresholdUsd;
  },

  _spentUsd: 0, // сколько долларов подписано без пароля с последнего ввода пароля (разблокировка или подпись)

  /** Операция подписана без пароля: её сумма идёт в накопительный счётчик порога. */
  noteSpend(usd) {
    const n = Number(usd);
    // неизвестная сумма без пароля пройти не может; на всякий случай она исчерпывает порог целиком
    this._spentUsd += Number.isFinite(n) && n >= 0 ? n : Infinity;
  },

  /* ---------- оценка в долларах ---------- */

  /** Актив, для которого кошелёк знает цену: монета сети (token === null) или встроенный токен.
   * Свои и неизвестные токены (в том числе undefined) не оцениваются. */
  pricedAsset(chainId, token) {
    const chain = CHAINS[chainId];
    if (!chain) {
      return null;
    }
    if (token === null) {
      return { symbol: chain.symbol, decimals: chain.decimals };
    }
    if (!token || typeof token !== "object") {
      return null;
    }
    const key = String(token.address || token.mint || "").toLowerCase();
    const builtin = key && (chain.tokens || []).find(t => (t.address || t.mint || "").toLowerCase() === key);
    return builtin ? { symbol: builtin.symbol, decimals: builtin.decimals } : null;
  },

  /** Цена единицы в $ или null, если она неизвестна. Встроенные стейблкоины стоят $1 и без ответа API. */
  unitPrice(chainId, token, prices = {}) {
    const a = this.pricedAsset(chainId, token);
    if (!a) {
      return null;
    }
    const p = Number(prices?.[a.symbol]);
    if (Number.isFinite(p) && p > 0) {
      return p;
    }
    return STABLE.test(a.symbol) ? 1 : null;
  },

  /** Сумма в $ по сырому значению; null, если цена неизвестна. Ноль стоит ноль. */
  usdOf(chainId, token, raw, prices = {}) {
    let v;
    try {
      v = BigInt(raw ?? 0);
    } catch (e) {
      return null;
    }
    if (v < 0n) {
      v = -v;
    }
    if (v === 0n) {
      return 0;
    }
    const a = this.pricedAsset(chainId, token);
    const p = this.unitPrice(chainId, token, prices);
    return a && p !== null ? this.toNumber(v, a.decimals) * p : null;
  },

  /** Сумма оценок: любая неизвестная часть делает неизвестной всю сумму. */
  sumUsd(...values) {
    let total = 0;
    for (const v of values) {
      if (v === null || v === undefined || !Number.isFinite(Number(v))) {
        return null;
      }
      total += Number(v);
    }
    return total;
  },

  get unlocked() {
    // проверка по настоящему времени: таймер мог не идти, пока система спала
    if (this._key && this._deadline && Date.now() >= this._deadline) {
      this.lock({ deferNotify: true });
    }
    return !!this._key;
  },

  get passwordless() {
    return !!this.data?.passwordless;
  },

  /** Кошельки, которым можно доверять. У подменённого файла — только те, чьи адреса пересчитаны из seed;
   * если не проверился ни один, адреса из файла не показываются вовсе. */
  get wallets() {
    if (this.unverified) {
      return [];
    }
    const all = Array.isArray(this.data?.wallets) ? this.data.wallets : [];
    return this._bad.size ? all.filter(w => !this._bad.has(w)) : all;
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
    const { mac, ...rest } = JSON.parse(JSON.stringify(data)); // как на диске: без undefined и BigInt
    return bytesToHex(hmac(sha256, this._key, utf8ToBytes(canonical(rest))));
  },

  _macRequired: false, // выставляется при расшифровке check: v3 → подпись обязательна

  tampered: false,
  tamperReason: null, // "mac" — подпись не сошлась, "rollback" — старая копия, "unsigned" — старый файл без подписи

  _addrFixed: 0, // сколько адресов подменённого файла не совпало с фразой
  _bad: new Set(), // кошельки подменённого файла, чей seed не расшифровался: не показываются и не используются
  unverified: false, // ни один кошелёк подменённого файла не проверен: адресов нет, приём и отправка закрыты
  _legacy: false, // файл старого формата (до v4): шифроблоки без AAD; переводится на v4 при разблокировке

  /** Что именно из неподписанной части файла начнёт действовать после подтверждения паролем (для показа пользователю). */
  untrustedContent() {
    const d = this.data || {};
    const s = d.settings && typeof d.settings === "object" ? d.settings : {};
    const lines = [];
    const few = (list, n = 6) => list.slice(0, n).join(", ") + (list.length > n ? ` и ещё ${list.length - n}` : "");
    const contacts = Array.isArray(d.contacts) ? d.contacts : [];
    if (contacts.length) {
      lines.push(`Контакты (${contacts.length}): ${few(contacts.map(c => `${cleanText(c?.name, 24) || "без имени"} → ${Object.values(c?.addresses || {}).map(a => cleanText(a, 64)).join(" / ")}`), 4)}`);
    }
    const sites = Object.keys(d.permissions && typeof d.permissions === "object" ? d.permissions : {});
    if (sites.length) {
      lines.push(`Подключённые сайты (${sites.length}): ${few(sites.map(o => cleanText(o, 60)))}`);
    }
    const nodes = [];
    for (const [id, entry] of Object.entries(s.nodes && typeof s.nodes === "object" ? s.nodes : {})) {
      for (const u of Array.isArray(entry?.list) ? entry.list : []) {
        let builtin = false;
        try {
          builtin = !!CHAINS[id] && this.isBuiltinNode(id, this.validateNodeUrl(u));
        } catch (e) {}
        if (!builtin) {
          nodes.push(`${CHAINS[id]?.name || cleanText(id, 16)}: ${cleanText(u, 80)}`);
        }
      }
    }
    if (nodes.length) {
      lines.push(`Свои ноды (${nodes.length}): ${few(nodes, 4)}`);
    }
    const tokens = [];
    for (const [id, list] of Object.entries(s.customTokens && typeof s.customTokens === "object" ? s.customTokens : {})) {
      for (const t of Array.isArray(list) ? list : []) {
        tokens.push(`${cleanText(t?.symbol, 12) || "?"} (${CHAINS[id]?.name || cleanText(id, 16)}, ${cleanText(t?.address || t?.mint, 64)})`);
      }
    }
    if (tokens.length) {
      lines.push(`Свои токены (${tokens.length}): ${few(tokens, 4)}`);
    }
    if (s.signPassword?.skip) {
      const t = Number(s.signPassword.thresholdUsd ?? 500);
      lines.push(`Пароль при подписи: ${t > 0 ? `только от ${t} $` : "не спрашивать до автоблокировки"}`);
    }
    const lockMin = s.autolockMinutes;
    if (lockMin !== undefined && !(Number.isInteger(lockMin) && lockMin > 0 && lockMin <= DEFAULT_AUTOLOCK)) {
      lines.push(`Автоблокировка: ${lockMin === 0 ? "выключена" : `${cleanText(lockMin, 8)} мин`}`);
    }
    const sent = (Array.isArray(d.activity) ? d.activity : []).filter(a => a?.to);
    if (sent.length) {
      lines.push(`Локальная история: ${sent.length} отправок, их получатели будут считаться знакомыми адресами`);
    }
    if (Array.isArray(s.hiddenChains) && s.hiddenChains.length) {
      lines.push(`Скрытые сети: ${few(s.hiddenChains.map(c => CHAINS[c]?.name || cleanText(c, 16)))}`);
    }
    if (this._bad.size) {
      lines.push(`Кошельков с нечитаемым шифроблоком: ${this._bad.size} — они будут удалены из файла (копия останется рядом: tabora-wallet.json.before-accept.bak)`);
    }
    return lines;
  },

  /** Пользователь подтвердил паролем, что правки файла сделаны им: подписываем текущее содержимое.
   * Адреса к этому моменту уже пересчитаны из seed, поэтому подписываются настоящие. */
  async acceptFile(password) {
    if (!this.unlocked) {
      throw new Error("Кошелёк заблокирован");
    }
    if (this.unverified) {
      throw new Error("Ни один кошелёк файла не удалось проверить по фразе: принять такой файл нельзя. Восстановите кошелёк по seed-фразе.");
    }
    await this.verifyPassword(password);
    await this.backupFile(".before-accept.bak");
    const reason = this.tamperReason;
    if (this._bad.size) {
      // записи без читаемого seed подписывать нельзя: их адреса проверить нечем
      this.data.wallets = this.wallets;
      this._bad = new Set();
      if (!this.data.wallets.some(w => w.id === this.data.active?.wallet)) {
        this.data.active = { wallet: this.data.wallets[0].id, account: 0 };
      }
    }
    this.tampered = false;
    this.tamperReason = null;
    try {
      const known = await getRevMarker();
      this.data.rev = Math.max(Number(this.data.rev) || 0, known || 0);
      // старый формат заодно переводится на v4 (новый ключ, AAD); не вышло — хотя бы подписываем как есть
      if (!this._legacy || !(await this._upgrade(password))) {
        await this.save();
      }
    } catch (e) {
      this.tampered = true;
      this.tamperReason = reason;
      throw e;
    }
    this._addrFixed = 0;
    await this.migrateSettings();
    // знак подлинности из подменённого файла мог подложить тот, кто его правил: выдаём новый
    await this.ensurePhishMark({ fresh: true });
    this.armAutolock();
  },

  /** Копия файла рядом с ним (тот же шифртекст, права 0600) перед необратимой перезаписью. */
  async backupFile(suffix) {
    try {
      if (await IOUtils.exists(FILE())) {
        await IOUtils.copy(FILE(), FILE() + suffix);
        await IOUtils.setPermissions(FILE() + suffix, 0o600);
      }
    } catch (e) {}
  },

  /** Старые копии зашифрованы прежним паролем: после смены пароля и удаления кошелька их быть не должно. */
  async removeBackups() {
    for (const suffix of BACKUPS) {
      try {
        await IOUtils.remove(FILE() + suffix);
      } catch (e) {}
    }
  },

  /** Откат файла к старой подписанной копии: ревизия в файле ниже известной. */
  async verifyRev() {
    if (this.tampered) {
      return false;
    }
    const known = await getRevMarker();
    if (known !== null && (Number(this.data.rev) || 0) < known) {
      this.tampered = true;
      this.tamperReason = "rollback";
    }
    return !this.tampered;
  },

  SIGNED_PREF: "tabora.wallet.fileSigned",

  verifyMac() {
    if (!this.data?.mac) {
      // Файл без подписи допустим только если он никогда не подписывался (старый формат).
      // Если подпись уже была, её отсутствие означает подмену файла.
      this.tampered = this._macRequired || Services.prefs.getBoolPref(this.SIGNED_PREF, false);
      this.tamperReason = this.tampered ? "mac" : null;
      return !this.tampered;
    }
    const ok = this.computeMac() === this.data.mac;
    this.tampered = !ok;
    this.tamperReason = ok ? null : "mac";
    return ok;
  },

  async save() {
    await this._write();
    this.notify();
  },

  /** Запись файла: подпись и ревизия ставятся только доверенному содержимому. */
  async _write() {
    if (!this._key) {
      // Запись без ключа невозможна: иначе подпись файла разойдётся с содержимым.
      throw new Error("Кошелёк заблокирован");
    }
    if (this.unverified) {
      // в памяти нет ни одного проверенного кошелька: запись стёрла бы шифроблоки с диска
      throw new Error("Файл кошелька не удалось проверить: запись запрещена до восстановления");
    }
    if (!this.tampered) {
      this.data.rev = (Number(this.data.rev) || 0) + 1;
      this.data.mac = this.computeMac();
      Services.prefs.setBoolPref(this.SIGNED_PREF, true);
    }
    await IOUtils.writeJSON(FILE(), this.data, { tmpPath: FILE() + ".tmp" });
    try {
      await IOUtils.setPermissions(FILE(), 0o600);
    } catch (e) {}
    if (!this.tampered) {
      setRevMarker(this.data.rev);
    }
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
    const raw = passwordless ? randomBytes(32) : await deriveKey(password, salt, KDF);
    if (passwordless) {
      await removeLoginKey(); // ключ прежнего (удалённого) кошелька не переиспользуется
      await loginSet(KEY_USER, raw);
    }
    this.data = {
      v: 4,
      createdAt: new Date().toISOString(),
      passwordless,
      kdf: passwordless ? null : { alg: "argon2id", salt: base64.encode(salt), ...KDF },
      check: await encrypt(raw, utf8ToBytes(CHECK_V4), AAD.check),
      wallets: [],
      active: null,
      settings: { hiddenChains: [], autolockMinutes: DEFAULT_AUTOLOCK, nodes: {} },
    };
    this._key = raw;
    this._macRequired = true;
    this._legacy = false;
    this.tampered = false;
    this.tamperReason = null;
    this.unverified = false;
    this._bad = new Set();
    this._addrFixed = 0;
    this._spentUsd = 0;
    await this._addWallet({ mnemonic, name });
    await this.ensurePhishMark();
    this.armAutolock();
    this.notify("unlocked");
    return this.activeWallet;
  },

  /** Добавить ещё один кошелёк по фразе: только с паролем (чужая фраза = чужие адреса приёма). */
  async addWallet({ mnemonic, name }, password) {
    this.assertTrusted();
    await this.verifyPassword(password);
    return this._addWallet({ mnemonic, name });
  },

  async _addWallet({ mnemonic, name }) {
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
    // фраза (для показа) и seed (для подписи) лежат в разных шифртекстах:
    // seed расшифровывается сразу в Uint8Array и не проходит через строки JS
    let id = `w${Date.now().toString(36)}`;
    while ((this.data.wallets || []).some(w => w?.id === id)) {
      id += "x"; // идентификатор входит в AAD шифроблоков: он обязан быть уникальным
    }
    const plain = utf8ToBytes(JSON.stringify({ mnemonic: phrase }));
    const vault = await this._seal(plain, AAD.vault(id));
    wipe(plain);
    const vaultSeed = await this._seal(seed, AAD.seed(id));
    const wallet = {
      id,
      name: name || `Кошелёк ${this.wallets.length + 1}`,
      fingerprint,
      createdAt: new Date().toISOString(),
      words: phrase.split(" ").length,
      vault,
      vaultSeed,
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
    // seed сразу байтами: фраза строкой JS здесь не нужна
    const seed = await this.seedOf(wallet);
    let account;
    try {
      const index = Math.max(-1, ...wallet.accounts.map(a => a.index)) + 1;
      account = { index, name: name || `Адрес ${index + 1}`, addresses: this.deriveAll(seed, index) };
    } finally {
      wipe(seed);
    }
    const index = account.index;
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
    this.data.wallets = (this.data.wallets || []).filter(w => w?.id !== walletId);
    if (this.data.active?.wallet === walletId) {
      this.data.active = this.wallets[0] ? { wallet: this.wallets[0].id, account: 0 } : null;
    }
    await this.save();
  },

  /** Версия формата по блоку check: 4 — с AAD, 3 и 2 — старые (без AAD), 0 — ключ не подошёл.
   * Версия лежит внутри шифроблока, поэтому понизить её правкой файла нельзя. */
  async _openCheck(raw) {
    const c = this.data?.check;
    const read = async aad => {
      try {
        const plain = await decrypt(raw, c.iv, c.ct, aad);
        const text = new TextDecoder().decode(plain);
        wipe(plain);
        return text;
      } catch (e) {
        return null;
      }
    };
    if ((await read(AAD.check)) === CHECK_V4) {
      return 4;
    }
    const old = await read(null);
    return old === CHECK_V3 ? 3 : old === CHECK_V2 ? 2 : 0;
  },

  /** Мастер-ключ и версия формата. Состояние не меняет. */
  async _masterKey(password) {
    await this.ready();
    if (!this.data) {
      throw new Error("Кошелька нет");
    }
    if (this.data.passwordless) {
      let seen = false;
      for (const name of [KEY_USER, KEY_NEXT]) {
        const raw = await loginGet(name);
        if (!raw) {
          continue;
        }
        seen = true;
        const ver = raw.length === 32 ? await this._openCheck(raw) : 0;
        if (ver) {
          if (name === KEY_NEXT) {
            await promoteLoginKey(raw).catch(() => {}); // смена ключа оборвалась после записи файла: завершаем
          }
          return { raw, ver };
        }
        wipe(raw);
      }
      throw new Error(seen ? "Неверный пароль" : "Ключ хранилища не найден");
    }
    let raw;
    try {
      raw = await deriveKey(password || "", base64.decode(this.data.kdf?.salt || ""), this.data.kdf);
    } catch (e) {
      if (/KDF/.test(e?.message || "")) {
        throw e;
      }
      throw new Error("Файл кошелька повреждён: параметры KDF вне допустимых границ");
    }
    const ver = await this._openCheck(raw);
    if (!ver) {
      wipe(raw);
      throw new Error("Неверный пароль");
    }
    return { raw, ver };
  },

  async masterKey(password) {
    return (await this._masterKey(password)).raw;
  },

  /** Шифроблок по назначению: в файле v4 — только с AAD, в старом — только без него. */
  _open(blob, aad) {
    return decrypt(this._key, blob?.iv, blob?.ct, this._legacy ? null : aad);
  },

  _seal(plaintext, aad) {
    return encrypt(this._key, plaintext, this._legacy ? null : aad);
  },

  _unlockQueue: null,

  /** Разблокировки идут строго по очереди: параллельный вызов не должен застать файл посреди перевода на новый формат. */
  unlock(password) {
    const run = () => this._unlock(password);
    const p = (this._unlockQueue || Promise.resolve()).then(run, run);
    this._unlockQueue = p.catch(() => {});
    return p;
  },

  async _unlock(password) {
    const { raw, ver } = await this._masterKey(password);
    wipe(this._key);
    this._key = raw;
    this._legacy = ver < 4;
    this._macRequired = ver >= 3;
    this._bad = new Set();
    this.unverified = false;
    this._addrFixed = 0;
    this._spentUsd = 0;
    this.verifyMac();
    await this.verifyRev();
    if (this.tampered) {
      await this.rederiveAddresses();
    } else if (!this.data.mac && ver < 3) {
      // Старый файл без подписи: открытой части верить нечем. Адреса пересчитываются из seed всегда;
      // всё остальное (контакты, ноды, сайты, настройки) начинает действовать только после подтверждения паролем.
      await this.rederiveAddresses();
      if (this.unverified || this._addrFixed || this._bad.size || this.untrustedContent().length) {
        this.tampered = true;
        this.tamperReason = "unsigned";
      } else if (!(await this._upgrade(password, { freshMark: true }))) {
        this._macRequired = true;
        await this.save();
      }
    } else if (ver < 4) {
      // подписанный файл старого формата: новый мастер-ключ (старые блоки check им не расшифровать) и AAD у каждого блока
      await this._upgrade(password);
    } else if (!this.data.mac) {
      await this.save();
    }
    await this.migrateSettings();
    await this.ensurePhishMark();
    this.armAutolock();
    this.notify("unlocked");
  },

  /** Открытый текст всех секретов (для перешифрования). Вызывающий обязан обнулить. */
  async _plainSecrets() {
    const out = [];
    try {
      for (const w of this.data.wallets || []) {
        let phrase = await this._open(w.vault, AAD.vault(w.id));
        let seed;
        if (w.vaultSeed) {
          seed = await this._open(w.vaultSeed, AAD.seed(w.id));
        } else {
          // самый старый сейф: JSON с фразой (и, возможно, seed в hex) — разделяем на фразу и бинарный seed
          const parsed = JSON.parse(new TextDecoder().decode(phrase));
          wipe(phrase);
          seed = parsed.seed ? hexToBytes(parsed.seed) : bip39.mnemonicToSeedSync(parsed.mnemonic);
          phrase = utf8ToBytes(JSON.stringify({ mnemonic: parsed.mnemonic }));
        }
        out.push({ w, phrase, seed });
        if (seed.length !== 64) {
          throw new Error("Seed повреждён: ожидалось 64 байта");
        }
      }
    } catch (e) {
      out.forEach(p => wipe(p.phrase, p.seed));
      throw e;
    }
    return out;
  },

  /** Перешифрование всего файла новым мастер-ключом в формате v4 (AAD). Состояние переключается разом,
   * после неудачной записи возвращается прежнее. mark — текст знака подлинности или null (будет выдан новый). */
  async _rekey(raw, { passwordless, salt, mark }) {
    const secrets = await this._plainSecrets();
    const before = { key: this._key, json: JSON.stringify(this.data), legacy: this._legacy, macRequired: this._macRequired };
    let switched = false;
    try {
      const check = await encrypt(raw, utf8ToBytes(CHECK_V4), AAD.check);
      const blobs = [];
      for (const p of secrets) {
        blobs.push({ vault: await encrypt(raw, p.phrase, AAD.vault(p.w.id)), vaultSeed: await encrypt(raw, p.seed, AAD.seed(p.w.id)) });
      }
      const markEnc = mark ? await encrypt(raw, utf8ToBytes(mark), AAD.mark) : null;
      // дальше без await до записи: остальной код видит либо старое состояние, либо новое
      secrets.forEach((p, i) => {
        p.w.vault = blobs[i].vault;
        p.w.vaultSeed = blobs[i].vaultSeed;
      });
      this.data.v = 4;
      this.data.check = check;
      this.data.passwordless = !!passwordless;
      this.data.kdf = passwordless ? null : { alg: "argon2id", salt: base64.encode(salt), ...KDF };
      this.data.settings ||= {};
      delete this.data.settings.phishMark;
      if (markEnc) {
        this.data.settings.phishMarkEnc = markEnc;
      } else {
        delete this.data.settings.phishMarkEnc;
      }
      this._key = raw;
      this._legacy = false;
      this._macRequired = true;
      switched = true;
      await this._write();
    } catch (e) {
      if (switched) {
        this._key = before.key;
        this.data = JSON.parse(before.json);
        this._legacy = before.legacy;
        this._macRequired = before.macRequired;
      }
      throw e;
    } finally {
      secrets.forEach(p => wipe(p.phrase, p.seed));
    }
    wipe(before.key);
  },

  /** Перевод файла старого формата на v4: новый мастер-ключ (новая соль или новый ключ в менеджере паролей)
   * и AAD у каждого шифроблока. Старые блоки без AAD после этого не принимаются. Копия прежнего файла
   * остаётся рядом до смены пароля. false — перевести не удалось, файл и состояние прежние. */
  async _upgrade(password, { freshMark = false } = {}) {
    if (!this._key || this.tampered || !this._legacy) {
      return false;
    }
    let raw = null;
    try {
      let mark = null;
      const s = this.data.settings || {};
      if (!freshMark && s.phishMarkEnc) {
        try {
          const plain = await this._open(s.phishMarkEnc, AAD.mark);
          mark = new TextDecoder().decode(plain);
          wipe(plain);
        } catch (e) {}
      }
      if (!freshMark && !mark && typeof s.phishMark === "string") {
        mark = cleanText(s.phishMark, 24) || null; // открытый знак подписанного файла самой старой версии
      }
      const passwordless = !!this.data.passwordless;
      const salt = randomBytes(16);
      raw = passwordless ? randomBytes(32) : await deriveKey(password || "", salt, KDF);
      if (passwordless) {
        await loginSet(KEY_NEXT, raw);
      }
      await this.backupFile(".pre-v4.bak");
      await this._rekey(raw, { passwordless, salt, mark });
      if (passwordless) {
        await promoteLoginKey(raw).catch(() => {}); // не вышло — vault-key-next подхватится при следующей разблокировке
      }
      this._phishMark = mark || "";
      this.notify();
      return true;
    } catch (e) {
      if (this._key !== raw) {
        wipe(raw);
      }
      console.error("Tabora Wallet: файл не переведён на формат v4", e);
      return false;
    }
  },

  /** Подменённый файл: адреса приёма и отпечатки пересчитываются из seed (шифроблок без ключа не подделать).
   * В файл ничего не пишется, пока пользователь не подтвердит правки. Кошельки, чей seed не расшифровался,
   * не показываются; если не проверился ни один — адресов нет вообще (unverified). */
  async rederiveAddresses() {
    let fixed = 0;
    let good = 0;
    const bad = new Set();
    const all = Array.isArray(this.data.wallets) ? this.data.wallets : [];
    const ids = new Set();
    for (const wallet of all) {
      let seed;
      try {
        if (!wallet || typeof wallet !== "object" || typeof wallet.id !== "string" || ids.has(wallet.id)) {
          throw new Error("запись кошелька повреждена");
        }
        ids.add(wallet.id);
        seed = await this.seedOf(wallet);
      } catch (e) {
        fixed++; // шифроблок испорчен или подставлен: таким кошельком нельзя ни подписать, ни доверять его адресам
        bad.add(wallet);
        continue;
      }
      try {
        const fingerprint = bytesToHex(sha256(HDKey.fromMasterSeed(seed).publicKey)).slice(0, 8);
        if (wallet.fingerprint !== fingerprint) {
          wallet.fingerprint = fingerprint;
          fixed++;
        }
        const accounts = (Array.isArray(wallet.accounts) ? wallet.accounts : []).filter(a => Number.isInteger(a?.index) && a.index >= 0 && a.index < 0x80000000);
        if (!accounts.length) {
          accounts.push({ index: 0, name: "Адрес 1" });
        }
        for (const a of accounts) {
          const real = this.deriveAll(seed, a.index);
          if (CHAIN_ORDER.some(id => a.addresses?.[id] !== real[id])) {
            fixed++;
          }
          a.addresses = real;
          a.name = cleanText(a.name, 40) || `Адрес ${a.index + 1}`;
        }
        wallet.accounts = accounts;
        wallet.name = cleanText(wallet.name, 40) || "Кошелёк";
        good++;
      } catch (e) {
        fixed++;
        bad.add(wallet);
      } finally {
        wipe(seed);
      }
    }
    this._bad = bad;
    this.unverified = good === 0;
    this._addrFixed = fixed;
  },

  lock({ deferNotify = false } = {}) {
    wipe(this._key);
    this._key = null;
    this._phishMark = "";
    this._spentUsd = 0;
    this._deadline = 0;
    clearTimeout(this._timer);
    if (deferNotify) {
      setTimeout(() => this.notify("locked"), 0); // из геттера: подписчики перерисуют панель уже после текущего кода
    } else {
      this.notify("locked");
    }
  },

  /** Автоблокировка, минут (0 — никогда). Хранится в подписанном файле; старые файлы — из настройки профиля до переноса. */
  get autolockMinutes() {
    const ok = v => Number.isInteger(v) && v >= 0 && v <= 1440;
    const v = this.settings.autolockMinutes;
    if (ok(v)) {
      return v;
    }
    if (this.tampered || this.data?.settings?.autolockMinutes !== undefined) {
      return DEFAULT_AUTOLOCK;
    }
    return this._legacyAutolock();
  },

  /** Настройки профиля меняются через about:config и prefs.js без пароля, поэтому из них берётся только то,
   * что не слабее умолчаний: автоблокировка не длиннее стандартной и встроенные ноды. */
  _legacyAutolock() {
    let v = DEFAULT_AUTOLOCK;
    try {
      v = Services.prefs.getIntPref(AUTOLOCK_PREF, DEFAULT_AUTOLOCK);
    } catch (e) {}
    return Number.isInteger(v) && v > 0 && v <= DEFAULT_AUTOLOCK ? v : DEFAULT_AUTOLOCK;
  },

  _legacyNodes() {
    const clean = {};
    let saved = {};
    try {
      saved = JSON.parse(Services.prefs.getStringPref(NODES_PREF, "{}")) || {};
    } catch (e) {}
    for (const id of Object.keys(CHAINS)) {
      const entry = saved?.[id];
      if (!Array.isArray(entry?.list) || !entry.list.length) {
        continue;
      }
      const valid = entry.list.map(u => {
        try {
          return this.validateNodeUrl(u);
        } catch (e) {
          return null;
        }
      });
      const list = valid.filter(u => u && this.isBuiltinNode(id, u)); // свои ноды — только заново и с паролем
      if (!list.length) {
        continue;
      }
      const chosen = valid[Number(entry.index) | 0];
      clean[id] = { list, index: Math.max(0, list.indexOf(chosen)) };
    }
    return clean;
  },

  /** Удлинение или отключение автоблокировки требует пароль кошелька. */
  async setAutolock(minutes, password) {
    this.assertTrusted();
    minutes = Number(minutes);
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) {
      throw new Error("Недопустимое время автоблокировки");
    }
    const limit = v => (v > 0 ? v : Infinity);
    if (limit(minutes) > limit(this.autolockMinutes)) {
      await this.verifyPassword(password);
    }
    this.data.settings ||= {};
    this.data.settings.autolockMinutes = minutes;
    await this.save();
    this.armAutolock();
  },

  /** Перенос автоблокировки и нод из настроек профиля (их меняют через about:config без пароля) в подписанный файл. */
  async migrateSettings() {
    if (!this._key || this.tampered || !this.data) {
      return;
    }
    const s = (this.data.settings ||= {});
    let changed = false;
    if (s.autolockMinutes === undefined) {
      s.autolockMinutes = this.autolockMinutes;
      changed = true;
    }
    if (s.nodes === undefined) {
      s.nodes = this._legacyNodes();
      changed = true;
    }
    if (changed) {
      await this.save();
    }
  },

  _deadline: 0, // настоящее время автоблокировки (Date.now), 0 — без автоблокировки

  armAutolock() {
    clearTimeout(this._timer);
    const minutes = this.autolockMinutes;
    this._deadline = minutes > 0 ? Date.now() + minutes * 60 * 1000 : 0;
    if (minutes > 0) {
      this._timer = setTimeout(() => this.checkAutolock(), minutes * 60 * 1000);
    }
    this.watchSleep();
  },

  /** Блокировка по настоящему времени: после сна системы таймер мог отстать. */
  checkAutolock() {
    if (!this._key || !this._deadline) {
      return;
    }
    const left = this._deadline - Date.now();
    if (left <= 0) {
      this.lock();
      return;
    }
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.checkAutolock(), Math.max(1000, left));
  },

  watchSleep() {
    if (this._sleepObs) {
      return;
    }
    this._sleepObs = { observe: () => this.checkAutolock() };
    Services.obs.addObserver(this._sleepObs, "wake_notification");
    Services.obs.addObserver(this._sleepObs, "sleep_notification");
  },

  touch() {
    if (this.unlocked) {
      this.armAutolock();
    }
  },

  async mnemonicOf(wallet) {
    if (!this.unlocked) {
      throw new Error("Кошелёк заблокирован");
    }
    const plain = await this._open(wallet.vault, AAD.vault(wallet.id));
    const { mnemonic } = JSON.parse(new TextDecoder().decode(plain));
    wipe(plain);
    return mnemonic;
  },

  /** Seed BIP-39 для подписи: ровно 64 байта, иначе блок считается подставленным. Вызывающий обязан обнулить. */
  async seedOf(wallet) {
    if (!this.unlocked) {
      throw new Error("Кошелёк заблокирован");
    }
    let seed;
    if (wallet.vaultSeed) {
      seed = await this._open(wallet.vaultSeed, AAD.seed(wallet.id)); // сразу байты, без строк
    } else if (this._legacy) {
      // самый старый сейф: JSON с фразой (и, возможно, seed в hex); на отдельный seed его переводит _upgrade
      const plain = await this._open(wallet.vault, AAD.vault(wallet.id));
      const parsed = JSON.parse(new TextDecoder().decode(plain));
      wipe(plain);
      seed = parsed.seed ? hexToBytes(parsed.seed) : bip39.mnemonicToSeedSync(parsed.mnemonic);
    } else {
      throw new Error("У кошелька нет шифроблока seed");
    }
    if (!(seed instanceof Uint8Array) || seed.length !== 64) {
      wipe(seed);
      throw new Error("Seed повреждён: ожидалось 64 байта");
    }
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
    this._spentUsd = 0; // пароль введён: накопительный счётчик порога начинается заново
    this.touch();
    return true;
  },

  /** Смена пароля: все шифроблоки перешифровываются новым мастер-ключом (формат v4, AAD).
   * Ключ в менеджере паролей меняется и удаляется только после успешной записи файла. */
  async changePassword(oldPassword, newPassword) {
    this.assertTrusted();
    await this.verifyPassword(oldPassword);
    const passwordless = !newPassword;
    const salt = randomBytes(16);
    const raw = passwordless ? randomBytes(32) : await deriveKey(newPassword, salt, KDF);
    try {
      if (passwordless) {
        await loginSet(KEY_NEXT, raw); // если менеджер паролей недоступен, файл остаётся нетронутым
      }
      await this._rekey(raw, { passwordless, salt, mark: this._phishMark || null });
    } catch (e) {
      if (this._key !== raw) {
        wipe(raw);
      }
      throw e;
    }
    if (passwordless) {
      await promoteLoginKey(raw).catch(() => {});
    } else {
      await removeLoginKey(); // старый ключ хранилища больше не нужен: файл уже записан новым
    }
    await this.removeBackups(); // копии зашифрованы прежним паролем
    this.notify();
    if (!this._phishMark) {
      await this.ensurePhishMark();
    }
  },

  /** Непроверяемый файл убирается в сторону (не удаляется), чтобы кошелёк можно было создать заново по фразе. */
  async quarantine(password) {
    if (!this.unverified) {
      throw new Error("Файл кошелька проверен: убирать его не нужно");
    }
    await this.verifyPassword(password);
    this.lock();
    await IOUtils.move(FILE(), FILE() + ".unverified.bak");
    this.data = null;
    this.tampered = false;
    this.tamperReason = null;
    this.unverified = false;
    this._bad = new Set();
    this.notify("destroyed");
  },

  async destroy(password) {
    await this.verifyPassword(password);
    this.lock();
    try {
      await IOUtils.remove(FILE());
    } catch (e) {}
    await this.removeBackups();
    this.data = null;
    this.tampered = false;
    this.tamperReason = null;
    this.unverified = false;
    this._bad = new Set();
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

  /** Сохранённые ноды: из подписанного файла; до переноса — из настройки профиля; у подменённого файла — ничего. */
  savedNodes() {
    const s = this.settings.nodes;
    if (s && typeof s === "object") {
      return s;
    }
    if (this.tampered || this.data?.settings?.nodes !== undefined) {
      return {};
    }
    return this._legacyNodes();
  },

  nodesFor(chainId) {
    const saved = this.savedNodes();
    const chain = CHAINS[chainId];
    let list = chain.nodes;
    if (Array.isArray(saved[chainId]?.list) && saved[chainId].list.length) {
      try {
        list = saved[chainId].list.map(u => this.validateNodeUrl(u)); // проверяем при каждом чтении
      } catch (e) {
        list = chain.nodes;
      }
    }
    const index = Math.max(0, Math.min(Number(saved[chainId]?.index) | 0, list.length - 1));
    return { list, index, url: list[index] };
  },

  isBuiltinNode(chainId, url) {
    return CHAINS[chainId].nodes.some(u => this.validateNodeUrl(u) === url);
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

  /** Список нод сети и активная нода. Своя нода (новая в списке или выбранная активной) требует пароль:
   * нода видит ваши адреса и может лгать о балансах, комиссиях и результатах симуляции. */
  async setNodes(chainId, list, index, { quiet = false, password } = {}) {
    this.assertTrusted();
    if (!CHAINS[chainId]) {
      throw new Error("Неизвестная сеть");
    }
    list = list.map(u => this.validateNodeUrl(u));
    index = Number(index);
    if (!list.length || !Number.isInteger(index) || index < 0 || index >= list.length) {
      throw new Error("Неверный выбор ноды");
    }
    const current = new Set(this.nodesFor(chainId).list);
    const weaker = list.some(u => !this.isBuiltinNode(chainId, u) && !current.has(u)) || !this.isBuiltinNode(chainId, list[index]);
    if (weaker) {
      await this.verifyPassword(password);
    }
    const saved = { ...this.savedNodes(), [chainId]: { list, index } };
    this.data.settings ||= {};
    this.data.settings.nodes = saved;
    delete this._nodeOverride[chainId];
    await this.save();
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
        const json = await fetchJson(url + path, {
          method: body ? "POST" : "GET",
          headers: body ? { "Content-Type": "application/json" } : {},
          body: body ? JSON.stringify(body) : undefined,
        });
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

  /** Приватные окна: origin несёт privateBrowsingId. Разрешения таких сайтов живут только в памяти
   * и не попадают в файл, иначе на диске остался бы след посещений из приватного режима. */
  _sessionPerms: {},

  isPrivateOrigin(origin) {
    return /\^(?:[^^]*&)?privateBrowsingId=[1-9]/.test(String(origin));
  },

  watchPrivateExit() {
    if (this._pbObs) {
      return;
    }
    this._pbObs = { observe: () => {
      this._sessionPerms = {};
      this.notify();
    } };
    try {
      Services.obs.addObserver(this._pbObs, "last-pb-context-exited");
    } catch (e) {}
  },

  permissionFor(origin, chain) {
    if (this.tampered) {
      return null; // файл подменён или откатан: сайтам ничего не даём, пока пользователь не подтвердит правки
    }
    if (this.isPrivateOrigin(origin)) {
      return this._sessionPerms[origin]?.[chain] || null;
    }
    return this.data?.permissions?.[origin]?.[chain] || null;
  },

  async grantPermission(origin, chain, grant) {
    this.assertTrusted();
    if (this.isPrivateOrigin(origin)) {
      this._sessionPerms[origin] ||= { since: new Date().toISOString(), session: true };
      this._sessionPerms[origin][chain] = { ...grant, at: new Date().toISOString() };
      this.watchPrivateExit();
      this.notify();
      return;
    }
    this.data.permissions ||= {};
    this.data.permissions[origin] ||= { since: new Date().toISOString() };
    this.data.permissions[origin][chain] = { ...grant, at: new Date().toISOString() };
    await this.save();
  },

  async revokePermission(origin, chain) {
    // запись приватного окна, оставшаяся в файле от прежних версий, отзывается как обычная
    const session = this.isPrivateOrigin(origin) && !this.data?.permissions?.[origin];
    const map = session ? this._sessionPerms : this.data?.permissions;
    if (!map?.[origin]) {
      return;
    }
    if (!session) {
      delete this._sessionPerms[origin];
    }
    if (!this.unlocked) {
      throw new Error("Кошелёк заблокирован: отключение сайта доступно после разблокировки");
    }
    if (chain) {
      delete map[origin][chain];
    }
    if (!chain || !["evm", "tron", "sol"].some(c => map[origin][c])) {
      delete map[origin];
    }
    if (session) {
      this.notify();
      return;
    }
    await this.save();
  },

  /** Все действующие разрешения: из файла и из приватных окон этого сеанса (у последних session: true). */
  get permissions() {
    return { ...(this.data?.permissions || {}), ...this._sessionPerms };
  },

  /* ---------- знак подлинности ---------- */

  /** Три случайных эмодзи, известные только кошельку: показываются на настоящих листах подтверждения. */
  _phishMark: "",

  get phishMark() {
    return this._key ? this._phishMark : "";
  },

  /** Знак хранится зашифрованным: читатель файла профиля его не узнает.
   * fresh — выдать новый знак (после принятия подменённого файла: прежний мог подложить тот, кто правил файл). */
  async ensurePhishMark({ fresh = false } = {}) {
    if (!this.data || !this._key || this.tampered) {
      return;
    }
    this.data.settings ||= {};
    const s = this.data.settings;
    if (!fresh && s.phishMarkEnc) {
      try {
        const plain = await this._open(s.phishMarkEnc, AAD.mark);
        this._phishMark = new TextDecoder().decode(plain);
        wipe(plain);
        return;
      } catch (e) {}
    }
    const pool = ["🦊", "🐙", "🦉", "🐝", "🍀", "🌙", "⚡", "🔥", "🌊", "🍉", "🎈", "🎯", "🧩", "🪐", "🍄", "🦋", "🐢", "🍋", "🧊", "🎲", "🌵", "🐬", "🍇", "🪁"];
    const pick = () => {
      for (;;) {
        const b = randomBytes(1)[0];
        if (b < 240) {
          return pool[b % pool.length]; // 240 = 24 × 10: без смещения
        }
      }
    };
    // открытый знак самой старой версии переносим в шифроблок только из подписанного файла
    const old = !fresh && typeof s.phishMark === "string" ? cleanText(s.phishMark, 24) : "";
    const mark = old || [pick(), pick(), pick()].join(" ");
    s.phishMarkEnc = await this._seal(utf8ToBytes(mark), AAD.mark);
    delete s.phishMark;
    this._phishMark = mark;
    await this.save();
  },

  /* ---------- контакты ---------- */

  /** Ключ адресной книги для сети: все EVM-сети делят один адрес. */
  contactKey(chainId) {
    return CHAINS[chainId]?.kind === "evm" ? "evm" : chainId;
  },

  get contacts() {
    return this.tampered ? [] : this.data?.contacts || [];
  },

  CONTACT_ADDRESS: { evm: /^0x[0-9a-fA-F]{40}$/, bitcoin: /^(bc1[02-9ac-hj-np-z]{11,87}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/, solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, tron: /^T[1-9A-HJ-NP-Za-km-z]{33}$/ },

  cleanAddresses(addresses) {
    const out = {};
    for (const [k, v] of Object.entries(addresses || {})) {
      const value = String(v || "").trim();
      if (!value) {
        continue;
      }
      if (!this.CONTACT_ADDRESS[k] || !this.CONTACT_ADDRESS[k].test(value)) {
        throw new Error(`Адрес для ${k} имеет неверный формат`);
      }
      out[k] = value;
    }
    return out;
  },

  /** Контакт помечает получателя как доверенного: новый контакт и смена адресов требуют пароль. */
  async addContact({ name, addresses, note = "" }, password) {
    this.assertTrusted();
    const clean = this.cleanAddresses(addresses);
    const cleanName = cleanText(name, 40);
    if (!cleanName || !Object.keys(clean).length) {
      throw new Error("Нужны имя и хотя бы один адрес");
    }
    await this.verifyPassword(password);
    this.data.contacts ||= [];
    const contact = { id: `c${Date.now().toString(36)}`, name: cleanName, addresses: clean, note: cleanText(note, 200), at: new Date().toISOString() };
    this.data.contacts.push(contact);
    await this.save();
    return contact;
  },

  async updateContact(id, patch, password) {
    this.assertTrusted();
    const c = this.contacts.find(x => x.id === id);
    if (!c) {
      throw new Error("Контакт не найден");
    }
    let clean = null;
    if (patch.addresses) {
      clean = this.cleanAddresses(patch.addresses);
      if (!Object.keys(clean).length) {
        throw new Error("Нужен хотя бы один адрес");
      }
      if (canonical(clean) !== canonical(c.addresses || {})) {
        await this.verifyPassword(password);
      } else {
        clean = null;
      }
    }
    if (patch.name !== undefined) {
      c.name = cleanText(patch.name, 40) || c.name;
    }
    if (clean) {
      c.addresses = clean;
    }
    if (patch.note !== undefined) {
      c.note = cleanText(patch.note, 200);
    }
    await this.save();
  },

  async removeContact(id) {
    this.assertTrusted();
    this.data.contacts = this.contacts.filter(x => x.id !== id);
    await this.save();
  },

  /** Контакт по адресу в сети (регистр для EVM не важен). */
  contactFor(chainId, address) {
    if (!address) {
      return null;
    }
    const key = this.contactKey(chainId);
    const a = String(address);
    const same = (x, y) => (key === "evm" ? x.toLowerCase() === y.toLowerCase() : x === y);
    return this.contacts.find(c => c.addresses[key] && same(c.addresses[key], a)) || null;
  },

  /** Контакты, у которых есть адрес для этой сети. */
  contactsFor(chainId) {
    const key = this.contactKey(chainId);
    return this.contacts.filter(c => c.addresses[key]).map(c => ({ ...c, address: c.addresses[key] }));
  },

  /* ---------- история операций ---------- */

  get activity() {
    return this.tampered ? [] : this.data?.activity || [];
  },

  async addActivity(entry) {
    if (entry?.private) {
      return; // действия сайтов из приватных окон на диск не пишутся
    }
    this.data.activity ||= [];
    this.data.activity.unshift({ ...entry, at: new Date().toISOString() });
    this.data.activity = this.data.activity.slice(0, 200);
    await this.save();
  },

  /* ---------- токены ---------- */

  /** Сети, скрытые пользователем. */
  get hiddenChains() {
    const list = this.settings.hiddenChains;
    return new Set(Array.isArray(list) ? list : []);
  },

  async setChainHidden(chainId, hide) {
    this.assertTrusted();
    const set = this.hiddenChains;
    if (hide) {
      set.add(chainId);
    } else {
      set.delete(chainId);
    }
    this.data.settings ||= {};
    this.data.settings.hiddenChains = [...set];
    await this.save();
  },

  tokensFor(chainId) {
    const chain = CHAINS[chainId];
    const s = this.settings;
    const custom = Array.isArray(s.customTokens?.[chainId]) ? s.customTokens[chainId] : [];
    const hidden = new Set(Array.isArray(s.hiddenTokens?.[chainId]) ? s.hiddenTokens[chainId] : []);
    const key = t => (t.address || t.mint || "").toLowerCase();
    const all = [...(chain.tokens || []), ...custom.filter(c => !(chain.tokens || []).some(t => key(t) === key(c)))];
    return all.filter(t => !hidden.has(key(t)));
  },

  async addToken(chainId, token) {
    this.assertTrusted();
    token = { ...token, symbol: cleanText(token.symbol, 12) || "TOKEN", decimals: safeDecimals(token.decimals) };
    this.data.settings ||= {};
    this.data.settings.customTokens ||= {};
    const list = (this.data.settings.customTokens[chainId] ||= []);
    const kind = CHAINS[chainId]?.kind;
    const addr = String(token.address || token.mint || "");
    const okAddr = kind === "evm" ? /^0x[0-9a-fA-F]{40}$/.test(addr) : kind === "tron" ? /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(addr) : kind === "sol" ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr) : false;
    if (!okAddr) {
      throw new Error("Неверный адрес контракта токена");
    }
    const key = addr.toLowerCase();
    if (!list.some(t => (t.address || t.mint || "").toLowerCase() === key)) {
      list.push({ symbol: token.symbol, decimals: token.decimals, address: token.address, mint: token.mint, custom: true });
    }
    if (this.data.settings.hiddenTokens?.[chainId]) {
      this.data.settings.hiddenTokens[chainId] = this.data.settings.hiddenTokens[chainId].filter(k => k !== key);
    }
    await this.save();
  },

  async hideToken(chainId, token) {
    this.assertTrusted();
    const key = (token.address || token.mint || "").toLowerCase();
    this.data.settings ||= {};
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
      return { symbol: cleanText(this.decodeAbiString(symbol), 12) || "TOKEN", name: cleanText(this.decodeAbiString(name), 40), decimals: safeDecimals(BigInt(decimals) > 36n ? 99 : Number(BigInt(decimals))), address };
    }
    if (chain.kind === "sol") {
      const r = await this.rpc(chainId, { jsonrpc: "2.0", id: 1, method: "getTokenSupply", params: [address] });
      if (!r.result) {
        throw new Error("По этому адресу нет SPL-токена");
      }
      return { symbol: "", name: "", decimals: safeDecimals(r.result.value.decimals), mint: address };
    }
    throw new Error("В этой сети нет токенов");
  },

  /* ---------- балансы ---------- */

  format(raw, decimals, max = 6) {
    decimals = safeDecimals(decimals);
    const v = BigInt(raw);
    if (v < 0n) {
      return "-" + this.format(-v, decimals, max);
    }
    const s = v.toString().padStart(decimals + 1, "0");
    const int = s.slice(0, s.length - decimals) || "0";
    const frac = s.slice(s.length - decimals).slice(0, max).replace(/0+$/, "");
    if (!frac && int === "0" && v > 0n) {
      return `<0.${"0".repeat(Math.max(0, Math.min(max, decimals) - 1))}1`; // ненулевая сумма не должна выглядеть как 0
    }
    return frac ? `${int}.${frac}` : int;
  },

  /** Число для оценок в валюте (не для точного отображения сумм). */
  toNumber(raw, decimals) {
    return Number(BigInt(raw)) / 10 ** safeDecimals(decimals);
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
      const j = await fetchJson("https://api.coingecko.com/api/v3/simple/price?ids=ethereum,bitcoin,solana,tron,polygon-ecosystem-token&vs_currencies=usd", {}, { timeout: 6000, maxBytes: 64 << 10 });
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
        return (await fetchJson(`${chain.history}/api/v2/addresses/${address}${path}`, {}, { timeout: 15000 })).items || [];
      };
      const [txs, transfers] = await Promise.all([get("/transactions").catch(() => []), get("/token-transfers?type=ERC-20").catch(() => [])]);
      // транзакции, которые подписали вы: «исходящий» перевод токена в чужой транзакции — подделка (transferFrom на 0, событие контракта)
      const signed = new Set(txs.filter(t => t.from?.hash?.toLowerCase() === me).map(t => String(t.hash || "").toLowerCase()));
      for (const t of txs.slice(0, 30)) {
        const value = BigInt(t.value || 0);
        if (value === 0n && !t.to?.hash) {
          continue;
        }
        const dir = dirOf(t.from?.hash, t.to?.hash);
        raw.push({ hash: t.hash, at: Date.parse(t.timestamp), dir, from: t.from?.hash, to: t.to?.hash, rawAmount: value, decimals: chain.decimals, symbol: chain.symbol, logo: chain.logo, kind: "native", status: t.status === "ok" ? "ok" : t.status === null ? "pending" : "failed", scam: t.from?.is_scam || (t.from?.reputation && t.from.reputation !== "ok"), call: value === 0n && dir !== "in" ? cleanText(t.method, 40) || "Вызов контракта" : null, mine: dir !== "in" ? t.from?.hash?.toLowerCase() === me : undefined });
      }
      for (const t of transfers.slice(0, 40)) {
        const token = known.get((t.token?.address || t.token?.address_hash || "").toLowerCase());
        const hash = t.tx_hash || t.transaction_hash;
        raw.push({ hash, at: Date.parse(t.timestamp), dir: dirOf(t.from?.hash, t.to?.hash), from: t.from?.hash, to: t.to?.hash, rawAmount: BigInt(t.total?.value || 0), decimals: safeDecimals(token?.decimals ?? t.total?.decimals ?? 18, 18), symbol: token?.symbol || "?", logo: token?.logo || null, kind: "token", known: !!token, custom: !!token?.custom, status: "ok", scam: t.from?.is_scam || (t.from?.reputation && t.from.reputation !== "ok") || t.token?.reputation === "scam", mine: signed.has(String(hash || "").toLowerCase()) });
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
        // списание без вашей подписи возможно только через делегата (approve): такие «исходящие» не показываем
        const mine = tx.transaction.message.accountKeys.some(k => (k.pubkey || k) === address && k.signer === true);
        const failed = !!tx.meta?.err;
        const at = (tx.blockTime || sg.blockTime || 0) * 1000;
        if (idx !== -1) {
          const delta = BigInt(tx.meta.postBalances[idx]) - BigInt(tx.meta.preBalances[idx]);
          const fee = idx === 0 ? BigInt(tx.meta.fee || 0) : 0n;
          const amount = delta < 0n ? -delta - fee : delta;
          if (amount !== 0n || (delta < 0n && !tx.meta.postTokenBalances?.length)) {
            const other = keys.find((k, j) => j !== idx && !/^(11111111111111111111111111111111|ComputeBudget|Tokenkeg|ATokenGP)/.test(k));
            raw.push({ hash: sg.signature, at, dir: delta < 0n ? "out" : "in", from: delta < 0n ? address : other, to: delta < 0n ? other : address, rawAmount: amount, decimals: 9, symbol: "SOL", logo: chain.logo, kind: "native", status: failed ? "failed" : "ok", mine });
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
          raw.push({ hash: sg.signature, at, dir: d < 0n ? "out" : "in", rawAmount: d < 0n ? -d : d, decimals: safeDecimals(b.uiTokenAmount.decimals, 0), symbol: token?.symbol || "?", logo: token?.logo || null, kind: "token", known: !!token, custom: !!token?.custom, status: failed ? "failed" : "ok", from: d < 0n ? address : null, to: d < 0n ? null : address, mine });
        }
        for (const [mint, amount] of pre) {
          const token = known.get(mint.toLowerCase());
          raw.push({ hash: sg.signature, at, dir: "out", rawAmount: amount, decimals: token?.decimals ?? 0, symbol: token?.symbol || "?", logo: token?.logo || null, kind: "token", known: !!token, custom: !!token?.custom, status: failed ? "failed" : "ok", from: address, to: null, mine });
        }
      });
    } else if (chain.kind === "tron") {
      const base = this.nodesFor(chainId).list.find(u => !this.tronIsJsonRpc(u)) || "https://api.trongrid.io";
      const get = async path => {
        return (await fetchJson(`${base}/v1/accounts/${address}${path}`, {}, { timeout: 15000 })).data || [];
      };
      const [txs, trc20] = await Promise.all([get("/transactions?limit=50&only_confirmed=true").catch(() => []), get("/transactions/trc20?limit=40&only_confirmed=true").catch(() => [])]);
      const b58 = hex => {
        try {
          return b58check.encode(hexToBytes(hex));
        } catch (e) {
          return hex;
        }
      };
      // транзакции, где владелец (подписант) — вы
      const signed = new Set(txs.filter(t => b58(t.raw_data?.contract?.[0]?.parameter?.value?.owner_address || "") === address).map(t => String(t.txID || "").toLowerCase()));
      for (const t of txs.slice(0, 30)) {
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
        raw.push({ hash: t.transaction_id, at: t.block_timestamp, dir: dirOf(t.from, t.to), from: t.from, to: t.to, rawAmount: BigInt(t.value || 0), decimals: safeDecimals(token?.decimals ?? t.token_info?.decimals ?? 6, 6), symbol: token?.symbol || "?", logo: token?.logo || null, kind: "token", known: !!token, custom: !!token?.custom, status: "ok", mine: signed.has(String(t.transaction_id || "").toLowerCase()) });
      }
    }
    return this.filterHistory(chainId, raw, prices);
  },

  /** Фильтр спама и нормализация. Скрываем: неизвестные токены, пыль (дешевле $0.5 или меньше порога сети в базовых
   * единицах), нулевые переводы в любую сторону, «исходящие», которые вы не подписывали (отравление адреса),
   * помеченных скамеров, неудачные входящие. Суммы сравниваются по сырому значению (BigInt): сумма, которую
   * не удалось разобрать или оценить, считается спамом, а не проходит фильтр.
   * suspects — адреса контрагентов скрытых операций: экран отправки предупреждает о них. */
  filterHistory(chainId, raw, prices = {}) {
    const chain = CHAINS[chainId];
    const items = [];
    const suspects = new Set();
    let hidden = 0;
    const seen = new Set();
    const dust = dustRaw(chain);
    for (const r of raw) {
      let value = null; // сырая сумма; null — не разобрана
      let decimals = 0;
      try {
        value = BigInt(r.rawAmount);
        decimals = safeDecimals(r.decimals);
        if (value < 0n) {
          value = null;
        }
      } catch (e) {
        value = null;
      }
      const amount = value === null ? "?" : this.format(value, decimals, 8);
      // цена только по нашим встроенным токенам и монетам сети; свои токены и чужие события — без оценки
      const priced = r.kind === "native" || (r.known && !r.custom);
      const quote = priced ? Number(prices?.[r.symbol] ?? (STABLE.test(r.symbol) ? 1 : NaN)) : NaN;
      const price = Number.isFinite(quote) && quote > 0 ? quote : null;
      const usd = price === null || value === null ? null : this.toNumber(value, decimals) * price;
      const badUsd = usd !== null && !Number.isFinite(usd); // оценка есть, но не число: не доверяем
      const incoming = r.dir === "in";
      let spam = false;
      let poison = false; // признаки отравления адреса: контрагента запоминаем
      if (r.scam) {
        spam = true;
      } else if (r.kind === "token" && !r.known) {
        spam = true; // неизвестный токен в любую сторону: контракт может эмитить любые события от вашего имени
      } else if (value === null || badUsd) {
        spam = poison = true; // сумму не удалось разобрать или оценить: считаем спамом
      } else if (value === 0n && !(r.call && r.dir === "out" && r.mine !== false)) {
        spam = poison = true; // нулевой перевод в любую сторону (отравление адреса); свои вызовы контрактов остаются
      } else if (!incoming && r.mine === false) {
        spam = poison = true; // «исходящий» перевод в транзакции, которую вы не подписывали
      } else if (incoming && ((usd !== null && usd < DUST_USD) || (r.kind === "native" && value < dust))) {
        spam = poison = true; // пыль (в т. ч. «отравление адреса» мелкими суммами), даже если курс не загрузился
      } else if (incoming && r.status === "failed") {
        spam = true;
      }
      if (spam) {
        hidden++;
        const other = incoming ? r.from : r.to;
        if (poison && other && r.dir !== "self") {
          suspects.add(String(other));
        }
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
    return { items, hidden, suspects: [...suspects].slice(0, 200).map(address => ({ chain: chainId, address })) };
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
