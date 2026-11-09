/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Обработка запросов сайтов к кошельку (из актора TaboraWallet).
 * EVM: EIP-1193 (eth_requestAccounts, eth_sendTransaction, personal_sign, eth_signTypedData_v4,
 * wallet_switchEthereumChain, wallet_watchAsset и чтение через наши ноды).
 * TRON: подмножество TronLink. Solana: Wallet Standard.
 * Любая подпись проходит через лист подтверждения с паролем. Разрешения хранятся по origin. */

const EVM_READ_METHODS = new Set([
  "eth_call", "eth_getBalance", "eth_blockNumber", "eth_estimateGas", "eth_gasPrice", "eth_getTransactionReceipt",
  "eth_getTransactionByHash", "eth_getCode", "eth_getLogs", "eth_feeHistory", "eth_maxPriorityFeePerGas",
  "eth_getTransactionCount", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getStorageAt", "eth_sendRawTransaction",
  "eth_getBlockTransactionCountByNumber", "eth_syncing", "net_listening", "eth_protocolVersion",
]);

Object.assign(Tabora, {
  _walletQueue: Promise.resolve(),

  /** Точка входа из TaboraWalletParent. Запросы выстраиваются в очередь: один лист за раз. */
  _walletPending: new Set(),
  _walletNoticeAt: new Map(),

  /** Уведомление не чаще раза в минуту на origin: сайт не должен спамить всплывашками. */
  walletNoticeRate(origin, text) {
    const last = this._walletNoticeAt.get(origin) || 0;
    if (Date.now() - last > 60000) {
      this._walletNoticeAt.set(origin, Date.now());
      this.notice(text);
    }
  },

  _walletCooldown: new Map(), // origin → время, до которого нужен свежий клик (после отказа)
  _walletReads: new Map(), // origin → { n, at } лимит запросов чтения

  /** Ключ лимитов: базовый домен верхнего документа, чтобы поддомены и фреймы не обходили лимит. */
  walletRateKey(req) {
    try {
      return Services.eTLD.getBaseDomainFromHost(String(req.topHost || req.host).replace(/:\d+$/, ""));
    } catch (e) {
      return req.origin;
    }
  },

  /** Запрос жив, пока документ-отправитель не ушёл (навигация) и вкладка не закрыта. */
  walletRequestAlive(req) {
    try {
      if (!req.browsingContext || !req.actor || req.browsingContext.currentWindowGlobal !== req.actor.manager) {
        return false;
      }
      const browser = req.browsingContext.top?.embedderElement;
      const tab = browser && gBrowser.getTabForBrowser(browser);
      return !tab || tab.isConnected;
    } catch (e) {
      return false;
    }
  },

  /** Привязка листа к вкладке и документу запроса. */
  walletGuard(req) {
    let tab = null;
    try {
      const browser = req.browsingContext?.top?.embedderElement;
      tab = browser && gBrowser.getTabForBrowser(browser);
    } catch (e) {}
    return { tab, alive: () => this.walletRequestAlive(req) };
  },

  walletHandleRequest(req) {
    const needsUi = !this.walletIsReadOnly(req);
    if (!needsUi) {
      // чтение через нашу ноду: не больше 60 запросов за 10 с на базовый домен
      const rk = this.walletRateKey(req);
      if (this._walletReads.size > 500) {
        this._walletReads.clear();
      }
      const r = this._walletReads.get(rk) || { n: 0, at: Date.now() };
      if (Date.now() - r.at > 10000) {
        r.n = 0;
        r.at = Date.now();
      }
      if (++r.n > 60) {
        this._walletReads.set(rk, r);
        return Promise.reject(this.wErr(-32005, "Слишком много запросов"));
      }
      this._walletReads.set(rk, r);
      return this.walletDispatch(req);
    }
    if (this._walletPending.has(req.origin)) {
      return Promise.reject(this.wErr(-32002, "Предыдущий запрос этого сайта ещё ожидает ответа"));
    }
    if (!req.userInteracted) {
      return Promise.reject(this.wErr(4001, "Сначала взаимодействуйте со страницей: запрос без действия пользователя отклонён"));
    }
    // после отказа следующий запрос требует свежего клика (transient activation)
    if ((this._walletCooldown.get(req.origin) || 0) > Date.now() && !req.transient) {
      return Promise.reject(this.wErr(4001, "Запрос отклонён: нажмите на странице, чтобы отправить новый"));
    }
    this._walletPending.add(req.origin);
    const run = async () => {
      try {
        // ждём активную вкладку ДО очереди: фоновая страница не блокирует другие сайты
        await this.walletFocusRequest(req);
        if (!/^wallet_(switch|add)EthereumChain$/.test(req.method)) {
          // разблокировку тоже ждём ДО очереди: один сайт у заблокированного кошелька не держит остальных
          await this.walletEnsureUnlocked(req);
        }
        if (!this.walletRequestAlive(req)) {
          throw this.wErr(4001, "Страница запроса закрыта или перешла на другой адрес");
        }
        if (this._walletQueueSize >= 4) {
          throw this.wErr(-32002, "Кошелёк занят другими запросами");
        }
        this._walletQueueSize = (this._walletQueueSize || 0) + 1;
        const job = async () => {
          try {
            await this.walletSheetFree();
            return await this.walletDispatch(req);
          } finally {
            this._walletQueueSize--;
          }
        };
        const p = this._walletQueue.then(job, job);
        this._walletQueue = p.catch(() => {});
        return await p;
      } catch (e) {
        if (e?.code === 4001) {
          this._walletCooldown.set(req.origin, Date.now() + 30000);
        }
        throw e;
      } finally {
        this._walletPending.delete(req.origin);
      }
    };
    return run();
  },

  walletIsReadOnly(req) {
    const m = req.method;
    if (req.chain === "evm") {
      return m === "tabora_state" || m === "eth_accounts" || m === "eth_chainId" || m === "net_version" || m === "web3_clientVersion" || m === "wallet_getPermissions" || EVM_READ_METHODS.has(m);
    }
    if (req.chain === "tron") {
      return ["tabora_state", "tron_getBalance", "tron_getAccount", "tron_getTransactionInfo", "tron_getCurrentBlock", "tron_buildSendTrx", "tron_triggerSmartContract"].includes(m);
    }
    if (req.chain === "sol") {
      return m === "tabora_state" || m === "sol_connectSilent" || m === "sol_disconnect";
    }
    return false;
  },

  wErr(code, message) {
    return Object.assign(new Error(message), { code });
  },

  /** Разрешение для сайта по цепочке; { accounts, walletId, index, chainId } */
  walletPerm(req) {
    const { WalletStore } = this.walletStore();
    return WalletStore.permissionFor(req.origin, req.chain);
  },

  walletPermAddress(req, chainId) {
    const { WalletStore } = this.walletStore();
    const perm = this.walletPerm(req);
    if (!perm) {
      return null;
    }
    const wallet = WalletStore.wallets.find(w => w.id === perm.walletId);
    const account = wallet?.accounts.find(a => a.index === perm.index);
    return account?.addresses[chainId] || null;
  },

  walletEmit(req, chain, event, payload) {
    // всем вкладкам этого origin
    for (const tab of gBrowser.tabs) {
      const bc = tab.linkedBrowser?.browsingContext;
      if (!bc) {
        continue;
      }
      try {
        const principal = tab.linkedBrowser.contentPrincipal;
        if (principal?.origin !== req.origin) {
          continue;
        }
        bc.currentWindowGlobal?.getActor("TaboraWallet")?.emit(chain, event, payload);
      } catch (e) {}
    }
  },

  /** Убедиться, что кошелёк есть и разблокирован; при необходимости открыть панель и дождаться. */
  async walletEnsureUnlocked(req) {
    const { WalletStore } = this.walletStore();
    await WalletStore.ready();
    if (!WalletStore.exists) {
      this.openDrawer("wallet");
      this.walletNoticeRate(req.origin, `${req.host} запрашивает кошелёк. Сначала создайте его.`);
      throw this.wErr(4100, "Кошелёк не создан");
    }
    if (WalletStore.unlocked) {
      return;
    }
    if (WalletStore.passwordless) {
      try {
        await WalletStore.unlock("");
        return;
      } catch (e) {}
    }
    this.wallet.view = "main";
    this.openDrawer("wallet");
    this.walletNoticeRate(req.origin, `${req.host} запрашивает кошелёк. Разблокируйте его, чтобы продолжить.`);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        Services.obs.removeObserver(obs, WalletStore.TOPIC);
        reject(this.wErr(4001, "Кошелёк не разблокирован"));
      }, 120000);
      const obs = (s, t, what) => {
        if (WalletStore.unlocked) {
          clearTimeout(timer);
          Services.obs.removeObserver(obs, WalletStore.TOPIC);
          resolve();
        }
      };
      Services.obs.addObserver(obs, WalletStore.TOPIC);
    });
  },

  /** Лист показывается только когда вкладка запроса активна: фоновая страница не может выдернуть себя наверх. */
  async walletFocusRequest(req) {
    let tab = null;
    try {
      const browser = req.browsingContext?.top?.embedderElement;
      tab = browser && gBrowser.getTabForBrowser(browser);
    } catch (e) {}
    if (tab && tab !== gBrowser.selectedTab) {
      this.walletNoticeRate(req.origin, `${req.host} ждёт подтверждения в кошельке: откройте вкладку`);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          gBrowser.tabContainer.removeEventListener("TabSelect", onSelect);
          reject(this.wErr(4001, "Вкладка не была открыта"));
        }, 5 * 60 * 1000);
        const onSelect = () => {
          if (gBrowser.selectedTab === tab) {
            clearTimeout(timer);
            gBrowser.tabContainer.removeEventListener("TabSelect", onSelect);
            resolve();
          }
          if (!tab.isConnected) {
            clearTimeout(timer);
            gBrowser.tabContainer.removeEventListener("TabSelect", onSelect);
            reject(this.wErr(4001, "Вкладка закрыта"));
          }
        };
        gBrowser.tabContainer.addEventListener("TabSelect", onSelect);
      });
    }
    if (tab && !tab.isConnected) {
      throw this.wErr(4001, "Вкладка закрыта");
    }
  },

  originInfo(req, perm) {
    const note = perm ? `подключён ${this.relativeTime(perm.at)}` : "первое подключение";
    const topHost = req.topHost && req.topHost !== req.host ? req.topHost : null;
    const lookalike = this.wLookalike(req.host) || (topHost ? this.wLookalike(topHost) : null);
    return { host: req.host, secure: req.secure, url: req.origin + "/", note, topHost, lookalike };
  },

  /** Популярные dApp и сервисы: подключение с похожего, но другого домена — признак фишинга. */
  KNOWN_DAPPS: [
    "uniswap.org", "opensea.io", "metamask.io", "pancakeswap.finance", "curve.fi", "aave.com", "lido.fi", "1inch.io", "1inch.com",
    "sushi.com", "compound.finance", "blur.io", "looksrare.org", "magiceden.io", "jup.ag", "raydium.io", "orca.so", "phantom.app",
    "tronscan.org", "tronlink.org", "sun.io", "sunswap.com", "justlend.org", "etherscan.io", "basescan.org", "arbiscan.io",
    "polygonscan.com", "solscan.io", "ens.domains", "rarible.com", "zora.co", "stargate.finance", "across.to", "polymarket.com",
    "coinbase.com", "binance.com", "kraken.com", "revoke.cash", "debank.com", "zapper.xyz", "gmx.io", "dydx.exchange",
    "hyperliquid.xyz", "pump.fun", "tensor.trade", "marinade.finance", "eigenlayer.xyz", "balancer.fi", "cow.fi", "paraswap.io",
    "matcha.xyz", "safe.global", "rabby.io", "arbitrum.io", "base.org", "optimism.io", "layerzero.network", "wormhole.com",
    "lifi.fi", "jumper.exchange", "relay.link", "morpho.org", "pendle.finance", "ethena.fi", "etherfi.org", "blast.io",
    "phantom.com", "curve.finance", "magiceden.us", "binance.us",
  ],

  /** Похож ли домен сайта на известный, не являясь им: смешанные алфавиты, punycode, опечатка, другой TLD,
   * известное имя внутри чужого домена. Возвращает текст предупреждения или null. */
  wLookalike(hostPort) {
    const host = String(hostPort || "").toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
    if (!host || /^[\d.]+$|^\[/.test(host) || host === "localhost" || host.endsWith(".localhost")) {
      return null;
    }
    this._lookalikeCache ||= new Map();
    if (this._lookalikeCache.has(host)) {
      return this._lookalikeCache.get(host);
    }
    let base = host;
    let suffix = "";
    let unicode = host;
    try {
      base = Services.eTLD.getBaseDomainFromHost(host);
      suffix = Services.eTLD.getPublicSuffixFromHost(host);
    } catch (e) {
      return null;
    }
    try {
      unicode = Cc["@mozilla.org/network/idn-service;1"].getService(Ci.nsIIDNService).convertACEtoUTF8(host);
    } catch (e) {}
    let result = null;
    if (!this.KNOWN_DAPPS.includes(base)) {
      // скелет: похожие символы других алфавитов и цифры → латиница
      const map = { а: "a", б: "b", в: "b", е: "e", ё: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x", і: "i", ї: "i", ј: "j", ѕ: "s", ԁ: "d", ɡ: "g", ո: "n", ս: "u", α: "a", ο: "o", ρ: "p", ν: "v", τ: "t", ι: "i", κ: "k", υ: "u", χ: "x", "0": "o", "1": "l", "3": "e", "5": "s", "|": "l", ı: "i" };
      const skeleton = s => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/./gu, ch => map[ch] ?? ch).replace(/rn/g, "m").replace(/vv/g, "w").replace(/i/g, "l").replace(/[-_]/g, "");
      let uBase = base;
      try {
        uBase = Cc["@mozilla.org/network/idn-service;1"].getService(Ci.nsIIDNService).convertACEtoUTF8(base);
      } catch (e) {}
      const uSuffix = uBase.endsWith("." + suffix) ? suffix : uBase.split(".").slice(-suffix.split(".").length).join(".");
      const label = uBase.slice(0, uBase.length - uSuffix.length - 1);
      const sub = unicode.slice(0, Math.max(0, unicode.length - uBase.length - 1));
      const L = skeleton(label);
      const scripts = ["Latin", "Cyrillic", "Greek", "Armenian"].filter(s => new RegExp(`\\p{Script=${s}}`, "u").test(label));
      const distance = (a, b) => {
        const d = Array.from({ length: b.length + 1 }, (_, i) => i);
        for (let i = 1; i <= a.length; i++) {
          let prev = d[0];
          d[0] = i;
          for (let j = 1; j <= b.length; j++) {
            const t = d[j];
            d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
            prev = t;
          }
        }
        return d[b.length];
      };
      for (const known of this.KNOWN_DAPPS) {
        const kLabel = known.split(".")[0];
        const K = skeleton(kLabel);
        const long = K.length >= 5;
        if (L === K || (long && distance(L, K) <= (K.length >= 8 ? 2 : 1)) || (long && L.includes(K)) || (long && skeleton(sub).includes(K))) {
          result = `Адрес сайта похож на ${known}, но это другой домен (${unicode !== host ? `${unicode} · ${host}` : base}). Так выглядят фишинговые копии: проверьте адрес в строке браузера.`;
          break;
        }
      }
      if (!result && scripts.length > 1) {
        result = `В имени сайта смешаны алфавиты (${scripts.join(" + ")}): ${unicode} записан как ${host}. Так подделывают известные адреса.`;
      }
    }
    if (this._lookalikeCache.size > 300) {
      this._lookalikeCache.clear();
    }
    this._lookalikeCache.set(host, result);
    return result;
  },

  /** Sign-In with Ethereum/Solana: домен в сообщении обязан совпадать с сайтом, который просит подпись
   * (не с верхним документом: фрейм не должен получать вход за родительский сайт). */
  wSiweCheck(text, req) {
    const m = /^([^\s]+) wants you to sign in with your (Ethereum|Solana) account:/m.exec(text);
    if (!m) {
      return null;
    }
    const domain = m[1].toLowerCase().replace(/^https?:\/\//, "").replace(/:\d+$/, "");
    const host = String(req.host || "").toLowerCase().replace(/:\d+$/, "");
    const uriLine = /^URI:\s*(\S+)/m.exec(text);
    let uriHost = null;
    try {
      uriHost = uriLine ? new URL(uriLine[1]).hostname.toLowerCase() : null;
    } catch (e) {}
    const ok = domain === host && (!uriHost || uriHost === host);
    return ok ? null : `Это запрос входа (Sign-In) для сайта «${domain}», а подписать просит ${req.host}. Такой подписью можно войти в ваш аккаунт на том сайте. Отклоните, если вы сейчас не на ${domain}.`;
  },

  /** Текст от сайта для показа: невидимые/RTL-символы экранируются. */
  wSafe(text) {
    const { WalletSigner } = this.walletSigner();
    return WalletSigner.safeText(text);
  },

  relativeTime(iso) {
    const d = (Date.now() - new Date(iso).getTime()) / 60000;
    if (d < 2) {
      return "только что";
    }
    if (d < 60) {
      return `${Math.round(d)} мин назад`;
    }
    if (d < 60 * 48) {
      return `${Math.round(d / 60)} ч назад`;
    }
    return `${Math.round(d / 1440)} дн. назад`;
  },

  /* ---- Подключение --------------------------------------------------------- */

  async walletConnectSheet(req, chainLabel, evmChainId = "ethereum") {
    const { WalletStore } = this.walletStore();
    const h = (t, a, x, c) => this.html(t, a, x, c);
    await this.walletEnsureUnlocked(req);
    await this.walletFocusRequest(req);
    const wallet = WalletStore.activeWallet;
    let account = WalletStore.activeAccount;
    const nativeChain = req.chain === "evm" ? "ethereum" : req.chain === "tron" ? "tron" : "solana";
    const picker = h("button", { class: "w-pick small", type: "button" }, null, [h("span", {}, `${wallet.name} · ${account.name} · ${this.shortAddr(account.addresses[nativeChain])}`), this.wIcon(["m6 9 6 6 6-6"], 11, 2.2)]);
    picker.addEventListener("click", e => {
      const r = e.currentTarget.getBoundingClientRect();
      const items = [];
      for (const w of WalletStore.wallets) {
        for (const a of w.accounts) {
          items.push({ label: `${w.name} · ${a.name}`, hint: this.shortAddr(a.addresses[nativeChain]), checked: w.id === wallet.id && a.index === account.index, run: () => {
            account = a;
            picker.firstChild.textContent = `${w.name} · ${a.name} · ${this.shortAddr(a.addresses[nativeChain])}`;
            picker._wallet = w;
          } });
        }
      }
      this.showMenu(items, r.left, r.bottom + 6);
    });
    picker._wallet = wallet;
    await this.walletConfirm({
      fromSite: true, guard: this.walletGuard(req),
      title: "Подключить сайт",
      badge: chainLabel,
      origin: this.originInfo(req, null),
      summary: ["Сайт увидит адрес и баланс выбранного счёта", "Сможет предлагать транзакции и подписи: каждую вы подтверждаете паролем", "Не сможет ничего отправить без вас"],
      extra: h("label", { class: "w-field" }, null, [h("span", {}, "Счёт"), picker]),
      okLabel: "Подключить",
      cancelLabel: "Отклонить",
      onSign: async pass => {
        const w = picker._wallet;
        await WalletStore.grantPermission(req.origin, req.chain, { walletId: w.id, index: account.index, chainId: req.chain === "evm" ? evmChainId : nativeChain, host: req.host });
      },
    });
    return account;
  },

  /* ---- Маршрутизация --------------------------------------------------------- */

  async walletDispatch(req) {
    const { WalletStore } = this.walletStore();
    await WalletStore.ready();
    this.walletWatchLock();
    if (req.chain === "evm") {
      return this.walletEvm(req);
    }
    if (req.chain === "tron") {
      return this.walletTron(req);
    }
    if (req.chain === "sol") {
      return this.walletSol(req);
    }
    throw this.wErr(4200, "Неизвестная цепочка");
  },

  /* ---- EVM ------------------------------------------------------------------- */

  evmChainOf(req) {
    const { CHAINS } = this.walletStore();
    const perm = this.walletPerm(req);
    const id = perm?.chainId || this._evmTempChain?.[req.origin] || "ethereum";
    return CHAINS[id] ? id : "ethereum";
  },

  evmHexChainId(chainId) {
    return "0x" + this.walletStore().CHAINS[chainId].chainId.toString(16);
  },

  async walletEvm(req) {
    const { WalletStore, CHAINS } = this.walletStore();
    const { WalletSigner, EVM_BY_CHAIN_ID } = this.walletSigner();
    const m = req.method;
    const p = Array.isArray(req.params) ? req.params : req.params ? [req.params] : [];
    const chainId = this.evmChainOf(req);
    const perm = this.walletPerm(req);
    const address = perm && WalletStore.exists ? this.walletPermAddress(req, chainId) : null;
    const accounts = address ? [address] : [];
    // пока кошелёк заблокирован, адрес сайту не отдаём (как MetaMask)
    const visible = WalletStore.unlocked ? accounts : [];

    switch (m) {
      case "tabora_state":
        return { accounts: visible, chainId: this.evmHexChainId(chainId) };
      case "eth_accounts":
        return visible;
      case "eth_chainId":
        return this.evmHexChainId(chainId);
      case "net_version":
        return String(CHAINS[chainId].chainId);
      case "web3_clientVersion":
        return `Tabora/${Services.prefs.getStringPref("tabora.version", "dev")}`;
      case "wallet_getPermissions":
        return visible.length ? [{ parentCapability: "eth_accounts", invoker: req.origin, caveats: [{ type: "restrictReturnedAccounts", value: accounts }] }] : [];
      case "wallet_revokePermissions":
        if (!WalletStore.unlocked) {
          throw this.wErr(4100, "Кошелёк заблокирован");
        }
        await WalletStore.revokePermission(req.origin, "evm");
        this.walletEmit(req, "evm", "accountsChanged", []);
        return null;
      case "eth_requestAccounts":
      case "wallet_requestPermissions": {
        if (accounts.length) {
          const wasLocked = !WalletStore.unlocked;
          await this.walletEnsureUnlocked(req);
          if (wasLocked) {
            this.walletEmit(req, "evm", "accountsChanged", accounts);
          }
          return m === "eth_requestAccounts" ? accounts : [{ parentCapability: "eth_accounts" }];
        }
        const account = await this.walletConnectSheet(req, "EVM", chainId);
        const addr = account.addresses[chainId];
        this.walletEmit(req, "evm", "chainChanged", this.evmHexChainId(chainId));
        this.walletEmit(req, "evm", "accountsChanged", [addr]);
        this.walletEmit(req, "evm", "connect", { chainId: this.evmHexChainId(chainId) });
        return m === "eth_requestAccounts" ? [addr] : [{ parentCapability: "eth_accounts" }];
      }
      case "wallet_switchEthereumChain":
      case "wallet_addEthereumChain": {
        const want = parseInt(p[0]?.chainId, 16);
        const target = EVM_BY_CHAIN_ID[want];
        if (!target) {
          throw this.wErr(4902, `Сеть ${p[0]?.chainName || p[0]?.chainId} пока не поддерживается в Tabora`);
        }
        if (target !== chainId) {
          if (perm) {
            if (!WalletStore.unlocked) {
              throw this.wErr(4100, "Кошелёк заблокирован");
            }
            await this.walletFocusRequest(req);
            await this.walletConfirm({
              fromSite: true, guard: this.walletGuard(req),
              noPassword: true,
              onDisconnect: () => WalletStore.revokePermission(req.origin, req.chain).catch(() => {}),
              title: "Сменить сеть",
              badge: "EVM",
              origin: this.originInfo(req, perm),
              summary: [`Сайт просит переключить сеть: ${CHAINS[chainId].name} → ${CHAINS[target].name}`, "Следующие транзакции и подписи этого сайта будут для новой сети"],
              okLabel: "Переключить",
              cancelLabel: "Отклонить",
              onSign: async () => {
                await WalletStore.grantPermission(req.origin, "evm", { ...perm, chainId: target });
              },
            });
          } else {
            const tmp = (this._evmTempChain ||= {});
            if (Object.keys(tmp).length > 200) {
              for (const k of Object.keys(tmp)) {
                delete tmp[k];
              }
            }
            tmp[req.origin] = target;
          }
          this.walletEmit(req, "evm", "chainChanged", this.evmHexChainId(target));
        }
        return null;
      }
      case "wallet_watchAsset": {
        const opts = p[0]?.options || p[0] || {};
        if ((p[0]?.type || "ERC20") !== "ERC20") {
          throw this.wErr(4200, "Поддерживаются только токены ERC-20");
        }
        await this.walletEnsureUnlocked(req);
        await this.walletFocusRequest(req);
        if (!/^0x[0-9a-fA-F]{40}$/.test(opts.address || "")) {
          throw this.wErr(-32602, "Неверный адрес контракта");
        }
        const info = await WalletStore.tokenInfo(chainId, opts.address);
        const symbol = this.wSafe(String(info.symbol || opts.symbol || "?")).text.slice(0, 12);
        const skeleton = x => String(x).normalize("NFKC").toLowerCase().replace(/[а]/g, "a").replace(/[е]/g, "e").replace(/[о]/g, "o").replace(/[р]/g, "p").replace(/[с]/g, "c").replace(/[т]/g, "t").replace(/[у]/g, "y").replace(/[х]/g, "x").replace(/[і]/g, "i").replace(/[ԁ]/g, "d").replace(/[0]/g, "o").replace(/[1l|]/g, "i").replace(/[$]/g, "s");
        const allKnown = Object.values(CHAINS).flatMap(c => c.tokens || []);
        const known = allKnown.find(t => skeleton(t.symbol) === skeleton(symbol) && (t.address || "").toLowerCase() !== opts.address.toLowerCase()) || (/^(usdt|usdc|dai|eth|btc|sol|trx|pol|wbtc|weth)$/.test(skeleton(symbol)) ? { symbol, address: "" } : null);
        await this.walletConfirm({
          fromSite: true, guard: this.walletGuard(req),
          onDisconnect: () => WalletStore.revokePermission(req.origin, req.chain).catch(() => {}),
          title: "Добавить токен",
          origin: this.originInfo(req, perm),
          summary: [`${symbol} · ${this.wSafe(info.name || "").text} · ${CHAINS[chainId].name}`],
          rows: [["Контракт", opts.address, "mono"], ["Десятичных", String(info.decimals ?? opts.decimals)]],
          warning: known ? `Символ «${symbol}» выглядит как известный токен${known.address ? `, но контракт другой (настоящий: ${this.shortAddr(known.address)})` : ""}. Это может быть подделка: токен будет помечен как непроверенный.` : null,
          danger: !!known,
          okLabel: "Добавить",
          onSign: async pass => {
            await WalletStore.addToken(chainId, { symbol: known ? `${symbol}?` : symbol, address: opts.address, decimals: info.decimals ?? opts.decimals, logo: /^https:\/\//.test(opts.image || "") ? opts.image : null, custom: true });
            this.wallet.balances = {};
          },
        });
        return true;
      }
      case "eth_sendTransaction": {
        if (!accounts.length) {
          throw this.wErr(4100, "Сайт не подключён к кошельку");
        }
        const tx = { ...(p[0] || {}) };
        tx.data = tx.data ?? tx.input ?? "0x";
        delete tx.input;
        if (typeof tx.data !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(tx.data)) {
          throw this.wErr(-32602, "Неверный формат data");
        }
        if (tx.value !== undefined && tx.value !== null && !/^(0x[0-9a-fA-F]{1,64}|\d{1,78})$/.test(String(tx.value))) {
          throw this.wErr(-32602, "Неверный формат value");
        }
        delete tx.nonce; // nonce только от сети: сайт не может подложить отложенную транзакцию
        if (tx.from && tx.from.toLowerCase() !== address.toLowerCase()) {
          throw this.wErr(4100, "Адрес отправителя не совпадает с подключённым");
        }
        if (tx.chainId !== undefined && parseInt(tx.chainId, 16) !== CHAINS[chainId].chainId && Number(tx.chainId) !== CHAINS[chainId].chainId) {
          throw this.wErr(4902, `Транзакция для другой сети (chainId ${tx.chainId}), текущая — ${CHAINS[chainId].name}`);
        }
        if (tx.to && !/^0x[0-9a-fA-F]{40}$/.test(tx.to)) {
          throw this.wErr(-32602, "Неверный адрес получателя");
        }
        await this.walletEnsureUnlocked(req);
        await this.walletFocusRequest(req);
        return this.walletEvmSendTx(req, chainId, address, tx, perm);
      }
      case "personal_sign":
      case "eth_sign": {
        if (!accounts.length) {
          throw this.wErr(4100, "Сайт не подключён к кошельку");
        }
        if (m === "eth_sign") {
          throw this.wErr(4200, "eth_sign отключён как небезопасный. Используйте personal_sign");
        }
        // personal_sign(message, address)
        let [message, who] = p;
        if (typeof who === "string" && /^0x[0-9a-fA-F]{40}$/.test(message) && !/^0x[0-9a-fA-F]{40}$/.test(who)) {
          [message, who] = [who, message];
        }
        if (who && who.toLowerCase() !== address.toLowerCase()) {
          throw this.wErr(4100, "Адрес не совпадает с подключённым");
        }
        await this.walletEnsureUnlocked(req);
        await this.walletFocusRequest(req);
        const safe = this.wSafe(WalletSigner.utf8OrHex(message));
        const text = safe.text;
        const looksLikeTx = /0x[0-9a-fA-F]{64,}/.test(text) && !/\s/.test(text);
        const siwe = this.wSiweCheck(text, req);
        return this.walletConfirm({
          fromSite: true, guard: this.walletGuard(req),
          onDisconnect: () => WalletStore.revokePermission(req.origin, req.chain).catch(() => {}),
          title: "Подпись сообщения",
          badge: "personal_sign",
          origin: this.originInfo(req, perm),
          summary: ["Подпись подтверждает владение адресом. Средства не списываются"],
          details: text,
          detailsLabel: "Сообщение",
          warning: siwe || (looksLikeTx ? "Сообщение похоже на сырые данные транзакции. Подписывайте только если доверяете сайту." : safe.hidden ? `В сообщении ${safe.hidden} скрытых символов (показаны как \\u{…}): сайт может пытаться замаскировать текст.` : null),
          danger: !!siwe || looksLikeTx || safe.hidden > 0,
          okLabel: "Подписать",
          onSign: async pass => {
            const sig = await WalletSigner.withKey(perm.walletId, perm.index, chainId, priv => WalletSigner.evmPersonalSign(message, priv));
            await WalletStore.addActivity({ chain: chainId, kind: "sign", origin: req.host, note: "подпись сообщения" });
            return sig;
          },
        });
      }
      case "eth_signTypedData":
      case "eth_signTypedData_v3":
      case "eth_signTypedData_v4": {
        if (!accounts.length) {
          throw this.wErr(4100, "Сайт не подключён к кошельку");
        }
        let [who, typed] = p;
        if (typeof who !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(who)) {
          [who, typed] = [typed, who];
        }
        if (who && who.toLowerCase() !== address.toLowerCase()) {
          throw this.wErr(4100, "Адрес не совпадает с подключённым");
        }
        const data = typeof typed === "string" ? JSON.parse(typed) : typed;
        if (Array.isArray(data) || !data?.types || !data.primaryType || !data.domain) {
          throw this.wErr(-32602, "Поддерживается только EIP-712 (v3/v4) с types, domain и primaryType");
        }
        const primary = String(data.primaryType);
        const domain = data.domain || {};
        const msg = data.message || {};
        if (domain.chainId !== undefined && Number(domain.chainId) !== CHAINS[chainId].chainId) {
          throw this.wErr(4902, `Данные для другой сети (chainId ${domain.chainId}), текущая — ${CHAINS[chainId].name}`);
        }
        await this.walletEnsureUnlocked(req);
        await this.walletFocusRequest(req);
        const isPermit = /permit/i.test(primary);
        // типы, подпись которых равносильна переводу или произвольному вызову от вашего имени
        const DANGEROUS = {
          TransferWithAuthorization: "перевод токенов по подписи (EIP-3009): средства спишутся без отдельной транзакции",
          ReceiveWithAuthorization: "перевод токенов по подписи (EIP-3009)",
          CancelAuthorization: "отмена авторизации EIP-3009",
          ForwardRequest: "мета-транзакция (ERC-2771): произвольный вызов от вашего имени",
          MetaTransaction: "мета-транзакция: произвольный вызов от вашего имени",
          SafeTx: "транзакция Safe от вашего имени",
          OrderComponents: "ордер на продажу NFT/токенов (Seaport)",
          Order: "ордер на продажу/обмен",
          Delegation: "делегирование прав (EIP-7710)",
          BulkOrder: "пакет ордеров",
          Listing: "листинг на продажу",
        };
        const dangerText = DANGEROUS[primary] || null;
        // белый список: безопасны только вход и голосования без контракта-исполнителя; всё прочее — опасно
        const safeType = !isPermit && !dangerText && this.wTypedSafe(primary, domain, msg);
        const rows = [["Тип", this.wSafe(primary).text.slice(0, 80)], ["Домен", `${this.wSafe(domain.name || "—").text}${domain.version ? " v" + this.wSafe(String(domain.version)).text : ""}`]];
        const knownToken = domain.verifyingContract && (CHAINS[chainId].tokens || []).concat(WalletStore.tokensFor(chainId)).find(t => t.address?.toLowerCase() === String(domain.verifyingContract).toLowerCase());
        if (knownToken) {
          rows.push(["Контракт токена", `${knownToken.symbol}: подпись может распоряжаться этими токенами`, "bad"]);
        }
        if (domain.verifyingContract) {
          rows.push(["Контракт", domain.verifyingContract, "mono"]);
        }
        let warning = null;
        if (isPermit) {
          const P = this.wPermitInfo(chainId, domain, msg);
          const spender = P.spender ? this.wSafe(String(P.spender)).text.slice(0, 100) : null;
          rows.push(["Spender", spender || "—", "mono"], ["Лимит", P.limits.join(" · ") + (P.more ? ` · и ещё ${P.more}` : ""), P.unlimited ? "bad" : ""]);
          if (P.oneTime) {
            rows.push(["Тип разрешения", "разовое списание по подписи (Permit2 SignatureTransfer)"]);
          } else {
            rows.push(["Разрешение действует", P.until.length ? [...new Set(P.until)].join(" · ") : "до отзыва"]);
          }
          if (P.sigUntil) {
            rows.push(["Подпись действительна до", P.sigUntil]);
          }
          warning = `Permit: ${P.oneTime ? "разовое списание" : "разрешение тратить"} токенов${spender ? " для " + this.shortAddr(spender) : ""}${P.unlimited ? " без лимита" : ""}${!P.oneTime && P.until.length ? " до " + P.until[0] : ""}. Это равносильно approve.`;
        }
        if (dangerText) {
          warning = `${primary}: ${dangerText}.${warning ? " " + warning : ""}`;
        }
        if (!safeType && !isPermit && !dangerText) {
          warning = `Неизвестный тип подписи «${this.wSafe(primary).text.slice(0, 60)}»${domain.verifyingContract ? ` для контракта ${this.shortAddr(String(domain.verifyingContract))}` : ""}: кошелёк не знает, что сделает с ней контракт. Так подписывают ордера на продажу NFT и токенов (Blur, LooksRare, 0x) и мета-транзакции. Подписывайте, только если доверяете сайту.`;
        }
        return this.walletConfirm({
          fromSite: true, guard: this.walletGuard(req),
          onDisconnect: () => WalletStore.revokePermission(req.origin, req.chain).catch(() => {}),
          title: "Подпись данных",
          badge: "EIP-712",
          origin: this.originInfo(req, perm),
          summary: [isPermit ? "Сайт просит подписать разрешение на трату токенов" : dangerText ? `Сайт просит подписать: ${dangerText}` : safeType ? "Подпись без распоряжения средствами: вход или голосование" : "Структурированная подпись неизвестного типа: контракт может использовать её для распоряжения вашими активами"],
          rows,
          warning,
          danger: !safeType || !!knownToken,
          details: this.wSafe(JSON.stringify(msg, null, 2)).text,
          detailsLabel: "Сообщение",
          okLabel: "Подписать",
          onSign: async pass => {
            const sig = await WalletSigner.withKey(perm.walletId, perm.index, chainId, priv => WalletSigner.evmSignTyped(data, priv));
            await WalletStore.addActivity({ chain: chainId, kind: "sign", origin: req.host, note: `подпись ${primary}` });
            return sig;
          },
        });
      }
      default:
        if (EVM_READ_METHODS.has(m)) {
          return WalletStore.evm(chainId, m, p);
        }
        throw this.wErr(4200, `Метод ${m} не поддерживается`);
    }
  },

  /** EIP-712 из белого списка: вход и голосования Snapshot без контракта-исполнителя и без полей,
   * похожих на распоряжение активами. Название типа выбирает сайт, поэтому поля проверяются тоже. */
  wTypedSafe(primary, domain, msg) {
    if (domain?.verifyingContract) {
      return false;
    }
    const snapshot = String(domain?.name || "").toLowerCase() === "snapshot" && /^(Vote|Vote2|VoteString|VoteArray|Proposal|CancelProposal|UpdateProposal|Space|Follow|Unfollow|Subscribe|Unsubscribe|Profile|Statement)$/.test(primary);
    const login = /^(Login|SignIn|Signin|Authentication|Auth)$/.test(primary);
    if (!snapshot && !login) {
      return false;
    }
    const risky = /spender|amount|value|token|operator|allowance|allowed|deadline|expir|calldata|^data$|recipient|wad|price|consideration|offer|delegat|nonce|salt|signer|contract|transfer|order|^to$/i;
    const walk = (v, depth) => depth <= 5 && v && typeof v === "object" && Object.keys(v).some(k => risky.test(k) || walk(v[k], depth + 1));
    return !walk(msg, 0);
  },

  /** Срок из Permit: секунды или миллисекунды; 0 у разрешения Permit2 — только текущий блок. */
  wPermitTime(v, allowance = false) {
    if (v === undefined || v === null || v === "") {
      return null;
    }
    let n;
    try {
      n = BigInt(v);
    } catch (e) {
      return this.wSafe(String(v)).text.slice(0, 40);
    }
    if (allowance && n === 0n) {
      return "до конца текущего блока";
    }
    if (n <= 0n) {
      return "срок не указан";
    }
    const ms = n > 10n ** 12n ? n : n * 1000n;
    if (n >= (1n << 48n) - 1n || ms > 4102444800000n) {
      return "бессрочно";
    }
    return new Date(Number(ms)).toLocaleString("ru-RU", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  },

  /** Permit: лимиты, срок разрешения и срок подписи (ERC-2612, DAI, Permit2 AllowanceTransfer и SignatureTransfer). */
  wPermitInfo(chainId, domain, msg) {
    const { WalletStore, CHAINS } = this.walletStore();
    const { WalletSigner } = this.walletSigner();
    const known = (CHAINS[chainId].tokens || []).concat(WalletStore.tokensFor(chainId));
    const tokenOf = a => known.find(t => t.address && t.address.toLowerCase() === String(a || "").toLowerCase());
    const big = v => {
      if (v === undefined || v === null || v === "") {
        return null;
      }
      try {
        return BigInt(v);
      } catch (e) {
        return -1n;
      }
    };
    const items = [];
    if (msg.details !== undefined) {
      for (const d of [].concat(msg.details)) {
        items.push({ token: d?.token, amount: big(d?.amount), until: d?.expiration });
      }
    } else if (msg.permitted !== undefined) {
      for (const p of [].concat(msg.permitted)) {
        items.push({ token: p?.token, amount: big(p?.amount), oneTime: true });
      }
    } else {
      const amount = msg.allowed === true ? (1n << 256n) - 1n : msg.allowed === false ? 0n : big(msg.value ?? msg.amount);
      items.push({ token: domain.verifyingContract, amount });
    }
    let unlimited = false;
    const limits = items.slice(0, 8).map(it => {
      const t = tokenOf(it.token);
      const name = t ? t.symbol : it.token ? this.shortAddr(this.wSafe(String(it.token)).text) : "токен";
      if (it.amount === null || it.amount < 0n) {
        unlimited = true;
        return `${name}: сумма не указана`;
      }
      if (WalletSigner.isUnlimited(it.amount)) {
        unlimited = true;
        return `${name}: без лимита`;
      }
      return `${name}: ${t ? WalletStore.format(it.amount, t.decimals, 6) : `${it.amount} единиц`}`;
    });
    const until = items.filter(it => !it.oneTime && it.until !== undefined && it.until !== null).map(it => this.wPermitTime(it.until, true));
    return {
      spender: msg.spender ?? null,
      limits,
      unlimited,
      until,
      sigUntil: this.wPermitTime(msg.sigDeadline ?? msg.deadline ?? msg.expiry ?? null),
      oneTime: items.some(it => it.oneTime),
      more: Math.max(0, items.length - 8),
    };
  },

  async walletEvmSendTx(req, chainId, address, tx, perm) {
    const { WalletStore, CHAINS } = this.walletStore();
    const { WalletSigner } = this.walletSigner();
    const chain = CHAINS[chainId];
    const prices = await WalletStore.prices();
    const est = await WalletSigner.evmPrepare(chainId, tx, address);
    const value = est.value;
    const decoded = WalletSigner.evmDecode(tx.to, tx.data, value, { chainId });
    const me = address.toLowerCase();
    const fmt = (raw, d = chain.decimals, max = 6) => WalletStore.format(raw, d, max);
    const usd = raw => {
      const u = WalletStore.usdOf(chainId, null, raw, prices);
      return u === null ? "" : ` · ${this.wFmtUsd(u)}`;
    };
    const sh = a => this.shortAddr(a);
    const isMe = a => String(a || "").toLowerCase() === me;
    // токены и балансы по адресу контракта: один запрос на адрес
    const tokenCache = new Map();
    const tokenOf = async addr => {
      const key = String(addr || "").toLowerCase();
      if (!tokenCache.has(key)) {
        let t = (chain.tokens || []).concat(WalletStore.tokensFor(chainId)).find(x => x.address?.toLowerCase() === key) || null;
        if (!t && /^0x[0-9a-f]{40}$/.test(key)) {
          try {
            const info = await WalletStore.tokenInfo(chainId, addr);
            if (info?.symbol && info.decimals !== undefined) {
              t = { symbol: `${this.wSafe(info.symbol).text.slice(0, 12)} (не из списка)`, decimals: info.decimals, address: addr, unverified: true };
            }
          } catch (e) {}
        }
        tokenCache.set(key, t);
      }
      return tokenCache.get(key);
    };
    const balCache = new Map();
    const balanceOf = async tokenAddr => {
      const key = String(tokenAddr).toLowerCase();
      if (!balCache.has(key)) {
        let v = null;
        try {
          const hex = await WalletStore.evm(chainId, "eth_call", [{ to: tokenAddr, data: "0x70a08231" + me.slice(2).padStart(64, "0") }, "latest"]);
          if (/^0x[0-9a-fA-F]{1,64}$/.test(hex || "")) {
            v = BigInt(hex);
          }
        } catch (e) {}
        balCache.set(key, v);
      }
      return balCache.get(key);
    };
    const amountOf = (amount, t, tokenAddr) => (t ? `${fmt(amount, t.decimals, 6)} ${t.symbol}` : `${amount} единиц токена ${sh(tokenAddr)}`);
    const tokUsd = (t, tokenAddr, amount) => WalletStore.usdOf(chainId, t || { address: tokenAddr }, amount, prices);
    const summary = [];
    const warns = new Set();
    let danger = false;
    let tokenUsd = 0; // оценка средств, которыми распоряжается вызов (переводы и разрешения); null — неизвестно
    const addUsd = v => {
      tokenUsd = WalletStore.sumUsd(tokenUsd, v);
    };
    const notToken = addr => {
      danger = true;
      warns.add(`Контракт ${sh(addr)} не отвечает как токен: что сделает этот вызов, неизвестно.`);
    };
    /** Разрешение опасно без лимита, больше баланса или если баланс не удалось узнать. */
    const allowance = async (tokenAddr, t, amount) => {
      if (amount === 0n) {
        return { text: `отзыв разрешения ${t?.symbol || ""}`.trim(), risky: false, revoke: true };
      }
      if (WalletSigner.isUnlimited(amount)) {
        return { text: `все ваши ${t?.symbol || "токены"} без лимита`, risky: true, why: "без лимита" };
      }
      const bal = await balanceOf(tokenAddr);
      if (bal === null) {
        return { text: amountOf(amount, t, tokenAddr), risky: true, why: "баланс токена проверить не удалось" };
      }
      if (amount > bal) {
        return { text: `${amountOf(amount, t, tokenAddr)} (больше вашего баланса ${t ? fmt(bal, t.decimals, 6) : bal})`, risky: true, why: "больше вашего баланса" };
      }
      return { text: amountOf(amount, t, tokenAddr), risky: false };
    };
    let approveRisky = false;
    const explain = async (d, depth) => {
      const pre = depth ? "• " : "";
      switch (d.kind) {
        case "transfer": {
          const t = await tokenOf(tx.to);
          summary.push(`${pre}Перевод ${amountOf(d.amount, t, tx.to)} на ${sh(d.to)}`);
          if (!t) {
            notToken(tx.to);
          }
          addUsd(tokUsd(t, tx.to, d.amount));
          break;
        }
        case "transferFrom": {
          const t = await tokenOf(tx.to);
          summary.push(`${pre}transferFrom ${amountOf(d.amount, t, tx.to)}: ${isMe(d.from) ? "ваш адрес" : sh(d.from)} → ${sh(d.to)}`);
          if (!t) {
            notToken(tx.to);
          }
          if (isMe(d.from)) {
            addUsd(tokUsd(t, tx.to, d.amount));
          }
          break;
        }
        case "approve": {
          const t = await tokenOf(tx.to);
          const a = await allowance(tx.to, t, d.amount);
          summary.push(`${pre}${a.revoke ? a.text[0].toUpperCase() + a.text.slice(1) : `${d.increase ? "Увеличить разрешение тратить" : "Разрешение тратить"} ${a.text}`} для ${sh(d.spender)}`);
          if (!t) {
            notToken(tx.to);
          }
          if (a.risky) {
            danger = true;
            approveRisky ||= depth === 0;
            warns.add(`Разрешение ${a.why}: ${sh(d.spender)} сможет тратить ваши ${t?.symbol || "токены"} в любой момент.${depth === 0 ? " Можно ограничить суммой ниже." : ""}`);
          }
          addUsd(a.risky ? null : tokUsd(t, tx.to, d.amount));
          break;
        }
        case "allowanceDown":
          summary.push(`${pre}Уменьшить разрешение для ${sh(d.spender)}`);
          break;
        case "setApprovalForAll":
          summary.push(`${pre}${d.approved ? `Полный доступ ко ВСЕМ NFT коллекции ${sh(tx.to)} для оператора ${sh(d.operator)}` : `Отзыв доступа оператора ${sh(d.operator)} к коллекции ${sh(tx.to)}`}`);
          if (d.approved) {
            danger = true;
            warns.add("setApprovalForAll: оператор сможет забрать любые NFT этой коллекции в любой момент. Так устроено большинство краж NFT. Подтверждайте только на проверенном маркетплейсе.");
            addUsd(null);
          }
          break;
        case "nftTransfer":
          summary.push(`${pre}Передача NFT #${d.tokenId.toString().slice(0, 24)} коллекции ${sh(tx.to)}: ${sh(d.from)} → ${sh(d.to)}`);
          danger = true;
          warns.add("Передача NFT необратима.");
          addUsd(null);
          break;
        case "wrap":
          summary.push(`${pre}Обёртка ${fmt(value)} ${chain.symbol} в ${d.symbol}`);
          break;
        case "unwrap":
          summary.push(`${pre}Вывод ${fmt(d.amount)} ${d.symbol} в ${chain.symbol}`);
          break;
        case "permit2Approve": {
          const own = !d.owner || isMe(d.owner);
          for (const det of d.details.slice(0, 8)) {
            const t = await tokenOf(det.token);
            const a = own ? await allowance(det.token, t, det.amount) : { text: amountOf(det.amount, t, det.token), risky: false };
            summary.push(`${pre}Permit2${own ? "" : ` (адрес ${sh(d.owner)})`}: ${a.revoke ? a.text : `${sh(d.spender)} сможет тратить ${a.text}`} · срок ${this.wPermitTime(det.expiration, true)}`);
            if (a.risky) {
              danger = true;
              warns.add(`Разрешение Permit2 ${a.why}: ${sh(d.spender)} сможет списывать ваши ${t?.symbol || "токены"} до ${this.wPermitTime(det.expiration, true)}.`);
            }
            addUsd(own ? (a.risky ? null : tokUsd(t, det.token, det.amount)) : 0);
          }
          if (d.details.length > 8) {
            danger = true;
            summary.push(`${pre}…и ещё ${d.details.length - 8} разрешений`);
            addUsd(null);
          }
          break;
        }
        case "permit2Transfer":
          for (const it of d.items.slice(0, 8)) {
            const t = await tokenOf(it.token);
            summary.push(`${pre}Перевод через Permit2 ${amountOf(it.amount, t, it.token)}: ${isMe(it.from) ? "ваш адрес" : sh(it.from)} → ${sh(it.to)}`);
            if (isMe(it.from)) {
              addUsd(tokUsd(t, it.token, it.amount));
            }
          }
          if (d.items.length > 8) {
            danger = true;
            summary.push(`${pre}…и ещё ${d.items.length - 8} переводов`);
            addUsd(null);
          }
          break;
        case "permit2Revoke":
          summary.push(`${pre}${d.nonces ? "Отмена подписей Permit2" : `Отзыв разрешений Permit2 (${d.pairs.length})`}`);
          break;
        case "multicall":
          summary.push(`${pre}Пакет из ${d.calls.length} вызовов контракта ${sh(tx.to)}:`);
          if (!d.calls.length) {
            danger = true;
          }
          for (const c of d.calls.slice(0, 12)) {
            await explain(c, depth + 1);
          }
          if (d.calls.length > 12) {
            danger = true;
            summary.push(`• …и ещё ${d.calls.length - 12}`);
            addUsd(null);
          }
          break;
        case "known":
          summary.push(`${pre}${d.text.slice(0, 300)}`);
          addUsd(null); // сумма обмена в токенах кошельку неизвестна
          break;
        default:
          danger = true;
          summary.push(`${pre}Вызов контракта ${sh(tx.to)} (${d.selector})${!depth && value ? ` с ${fmt(value)} ${chain.symbol}${usd(value)}` : ""}`);
          warns.add(`Кошелёк не может расшифровать вызов ${d.selector}${d.reason ? ` (${d.reason})` : ""}: что сделает контракт ${sh(tx.to)}, неизвестно. Так выглядят и обычные операции сайтов, и кражи: подписывайте, только если доверяете сайту.`);
          addUsd(null);
      }
    };
    if (!tx.to) {
      summary.push("Развёртывание контракта");
      danger = true;
      warns.add("Развёртывание контракта с вашего адреса: кошелёк не может проверить его код.");
      addUsd(null);
    } else if (!decoded) {
      summary.push(`Перевод ${fmt(value)} ${chain.symbol}${usd(value)} на ${sh(tx.to)}`);
      // перевод на контракт исполняет его код (receive/fallback): расшифровать нечего
      let code = null;
      try {
        code = await WalletStore.evm(chainId, "eth_getCode", [tx.to, "latest"]);
      } catch (e) {}
      if (typeof code === "string" && code.length > 2 && !/^0xef0100/i.test(code)) {
        if (chain.wrapped && tx.to.toLowerCase() === chain.wrapped.address.toLowerCase()) {
          summary[0] = `Обёртка ${fmt(value)} ${chain.symbol} в ${chain.wrapped.symbol}`;
        } else {
          danger = true;
          warns.add(`Получатель ${sh(tx.to)} — контракт: монеты получит его код, и что он с ними сделает, неизвестно.`);
        }
      }
    } else {
      await explain(decoded, 0);
    }
    const token = decoded?.kind === "approve" ? await tokenOf(tx.to) : null;
    let extra = null;
    let decodedPlan = null;
    if (approveRisky && token) {
      extra = this.wApproveLimit(tx, token, decoded, plan => {
        decodedPlan = plan;
        const line = extra?.closest?.(".w-sheet-card")?.querySelector(".w-summary-line");
        if (line) {
          line.textContent = plan ? `Разрешение тратить ${plan.label} для ${sh(decoded.spender)}` : summary[0];
        }
      });
    }
    // Вложенная монета показывается всегда: вызов токена с приложенным ETH — классическая маскировка перевода
    const tokenLike = ["transfer", "approve", "transferFrom", "allowanceDown", "unwrap", "setApprovalForAll", "nftTransfer", "permit2Approve", "permit2Transfer", "permit2Revoke"].includes(decoded?.kind);
    const lead = [];
    if (value > 0n && decoded && decoded.kind !== "wrap" && decoded.kind !== "unknown") {
      summary.push(`Плюс к вызову приложено ${fmt(value)} ${chain.symbol}${usd(value)}: эти монеты получит контракт`);
      if (tokenLike) {
        danger = true;
        lead.push(`К вызову токена приложено ${fmt(value)} ${chain.symbol}. Стандартные токены так не работают: монеты уйдут контракту ${sh(tx.to)}.`);
      }
    }
    const rows = [
      ["Сеть", chain.name],
      ...(value > 0n ? [["Сумма", `${fmt(value)} ${chain.symbol}${usd(value)}`, tokenLike ? "bad" : ""]] : []),
      ["Контракт", tx.to ? tx.to : "новый", "mono"],
      ["Комиссия", `≈ ${fmt(est.feeLikely, chain.decimals, 8)} ${chain.symbol}${usd(est.feeLikely)}`],
      ["Максимум", `${fmt(est.fee, chain.decimals, 8)} ${chain.symbol}`, "muted"],
    ];
    if (est.capped?.length) {
      rows.push(["Комиссия от сайта", `завышена (${est.capped.join(", ")}): заменена на сетевую`, "muted"]);
    }
    const feeUsd = WalletStore.usdOf(chainId, null, est.fee, prices);
    if ((feeUsd !== null && feeUsd >= 50) || (value > 0n && est.fee > value)) {
      danger = true;
      lead.unshift(`Комиссия необычно велика: до ${fmt(est.fee, chain.decimals, 8)} ${chain.symbol}${usd(est.fee)}.`);
    }
    const nativeBal = BigInt(await WalletStore.evm(chainId, "eth_getBalance", [address, "latest"]));
    const need = value + est.fee;
    const tail = [];
    if (nativeBal < need) {
      rows.push([`${chain.symbol} на балансе`, `${fmt(nativeBal)} · не хватает`, "bad"]);
      // предупреждение безопасности важнее нехватки средств: не затираем его
      tail.push(`Не хватает ${chain.symbol} на комиссию${value ? " и сумму" : ""}: нужно ещё около ${fmt(need - nativeBal, chain.decimals, 8)} ${chain.symbol}.`);
      danger = true;
    }
    const warning = [...lead, ...warns, ...tail].join(" ") || null;
    const hash = await this.walletConfirm({
      fromSite: true, guard: this.walletGuard(req),
      onDisconnect: () => WalletStore.revokePermission(req.origin, req.chain).catch(() => {}),
      title: "Запрос транзакции",
      badge: "EIP-1193",
      origin: this.originInfo(req, perm),
      summary,
      rows,
      warning,
      danger,
      extra,
      details: `to: ${tx.to || "—"}\nvalue: ${fmt(value)} ${chain.symbol}\ndata: ${tx.data.slice(0, 400)}${tx.data.length > 400 ? "…" : ""}`,
      // оценка суммы для порога пароля: монеты сети, комиссия и токены, которыми распоряжается вызов; неизвестное — выше порога
      usd: WalletStore.sumUsd(WalletStore.usdOf(chainId, null, value + est.fee, prices), tokenUsd),
      okLabel: nativeBal < need ? "Отправить всё равно" : "Подписать и отправить",
      onSign: async pass => {
        let prepared = est.prepared;
        if (decodedPlan?.data) {
          prepared = { ...prepared, data: decodedPlan.data };
        }
        const signed = await WalletSigner.withKey(perm.walletId, perm.index, chainId, priv => WalletSigner.evmSign(prepared, priv));
        const h = await WalletSigner.evmSend(chainId, signed.raw);
        await WalletStore.addActivity({ chain: chainId, kind: "dapp", origin: req.host, hash: h, note: summary[0] });
        const key = `${chainId}:${address}`;
        if (this.wallet.balances[key]) {
          this.wallet.balances[key].at = 0;
        }
        return h;
      },
    });
    this.notice(`Транзакция отправлена · ${req.host}`);
    return hash;
  },

  /** Кнопки лимита для неограниченного approve: подменяют amount в calldata. */
  wApproveLimit(tx, token, decoded, onChange) {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const wrap = h("div", { class: "w-limit" });
    if (!token || token.decimals === undefined || !/^0x095ea7b3[0-9a-fA-F]{128}$/.test(tx.data)) {
      // десятичные неизвестны или calldata нестандартная: лимит предлагать нельзя
      return null;
    }
    const set = (label, amountRaw, pressed) => {
      const b = h("button", { class: "w-chip-btn", type: "button", "aria-pressed": String(pressed) }, label);
      b.addEventListener("click", () => {
        wrap.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", "false"));
        b.setAttribute("aria-pressed", "true");
        onChange(amountRaw === null ? null : { label, data: tx.data.slice(0, 10) + tx.data.slice(10, 74) + amountRaw.toString(16).padStart(64, "0") });
      });
      return b;
    };
    const decimals = token.decimals;
    const presets = [100n, 1000n, 10000n].map(n => n * 10n ** BigInt(decimals));
    wrap.append(...presets.map((raw, i) => set(`${[100, 1000, 10000][i].toLocaleString("ru-RU")} ${token.symbol}`, raw, false)), set("Без лимита", null, true));
    return wrap;
  },

  /* ---- TRON ------------------------------------------------------------------ */

  tronAddrPayload(address) {
    const { WalletSigner } = this.walletSigner();
    return { base58: address, hex: WalletSigner.tronHexAddress(address) };
  },

  async walletTron(req) {
    const { WalletStore } = this.walletStore();
    const { WalletSigner } = this.walletSigner();
    const m = req.method;
    const p = Array.isArray(req.params) ? req.params : req.params ? [req.params] : [];
    const perm = this.walletPerm(req);
    const address = perm && WalletStore.exists ? this.walletPermAddress(req, "tron") : null;
    // пока кошелёк заблокирован, адрес сайту не отдаём (как и в EVM)
    const visible = WalletStore.unlocked ? address : null;
    switch (m) {
      case "tabora_state":
        return { address: visible ? this.tronAddrPayload(visible) : null };
      case "tron_requestAccounts": {
        if (address) {
          await this.walletEnsureUnlocked(req);
          this.walletEmit(req, "tron", "accountsChanged", this.tronAddrPayload(address));
          return { code: 200, message: "ok" };
        }
        const account = await this.walletConnectSheet(req, "TRON");
        this.walletEmit(req, "tron", "accountsChanged", this.tronAddrPayload(account.addresses.tron));
        return { code: 200, message: "ok" };
      }
      case "tron_getBalance": {
        const who = p[0] || visible;
        if (typeof who !== "string" || !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(who)) {
          throw this.wErr(-32602, "Неверный адрес");
        }
        const r = await WalletSigner.tronPost("/wallet/getaccount", { address: who, visible: true });
        return r.balance || 0;
      }
      case "tron_getAccount": {
        const who = p[0] || visible;
        if (typeof who !== "string" || !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(who)) {
          throw this.wErr(-32602, "Неверный адрес");
        }
        return WalletSigner.tronPost("/wallet/getaccount", { address: who, visible: true });
      }
      case "tron_getCurrentBlock":
        return WalletSigner.tronPost("/wallet/getnowblock", {});
      case "tron_getTransactionInfo":
        if (typeof p[0] !== "string" || !/^[0-9a-fA-F]{64}$/.test(p[0])) {
          throw this.wErr(-32602, "Неверный идентификатор транзакции");
        }
        return WalletSigner.tronPost("/wallet/gettransactioninfobyid", { value: p[0] });
      case "tron_buildSendTrx":
        return WalletSigner.tronBuildSendTrx(p[0], p[1], p[2] || visible);
      case "tron_triggerSmartContract":
        return WalletSigner.tronTriggerSmartContract(p[0], p[1], p[2] || {}, p[3] || [], p[4] || visible);
      case "tron_sendRawTransaction": {
        const signed = p[0];
        // через кошелёк уходят только транзакции, подписанные в нём: он не ретранслятор чужих транзакций
        if (!signed?.txID || !this._tronSigned?.has(String(signed.txID).toLowerCase())) {
          throw this.wErr(4100, "Отправлять через кошелёк можно только транзакции, подписанные в нём");
        }
        return WalletSigner.tronBroadcast(signed);
      }
      case "tron_sign": {
        if (!address) {
          throw this.wErr(4100, "Сайт не подключён к кошельку");
        }
        await this.walletEnsureUnlocked(req);
        await this.walletFocusRequest(req);
        const tx = p[0];
        if (typeof tx === "string") {
          // подпись хеша/сообщения (старый API)
          return this.walletConfirm({
            fromSite: true, guard: this.walletGuard(req),
            onDisconnect: () => WalletStore.revokePermission(req.origin, req.chain).catch(() => {}),
            title: "Подпись сообщения",
            badge: "TRON",
            origin: this.originInfo(req, perm),
            summary: ["Подпись подтверждает владение адресом"],
            details: this.wSafe(tx).text,
            detailsLabel: "Сообщение",
            onSign: async pass => {
              return WalletSigner.withKey(perm.walletId, perm.index, "tron", priv => WalletSigner.tronSignMessageV1(tx, priv));
            },
          });
        }
        return this.walletTronSignTx(req, address, tx, perm);
      }
      case "tron_signMessageV2":
      case "tron_signMessage": {
        if (!address) {
          throw this.wErr(4100, "Сайт не подключён к кошельку");
        }
        await this.walletEnsureUnlocked(req);
        await this.walletFocusRequest(req);
        const message = p[0];
        if (typeof message !== "string" || message.length > 65536) {
          throw this.wErr(-32602, "Сообщение должно быть строкой");
        }
        const safeT = this.wSafe(message);
        return this.walletConfirm({
          fromSite: true, guard: this.walletGuard(req),
          onDisconnect: () => WalletStore.revokePermission(req.origin, req.chain).catch(() => {}),
          title: "Подпись сообщения",
          badge: "TRON",
          origin: this.originInfo(req, perm),
          summary: ["Подпись подтверждает владение адресом. Средства не списываются"],
          warning: safeT.hidden ? `В сообщении ${safeT.hidden} скрытых символов (показаны как \\u{…}): сайт может пытаться замаскировать текст.` : null,
          danger: safeT.hidden > 0,
          details: safeT.text,
          detailsLabel: "Сообщение",
          onSign: async pass => {
            const sig = await WalletSigner.withKey(perm.walletId, perm.index, "tron", priv => (m === "tron_signMessageV2" ? WalletSigner.tronSignMessageV2(message, priv) : WalletSigner.tronSignMessageV1(message, priv)));
            await WalletStore.addActivity({ chain: "tron", kind: "sign", origin: req.host, note: "подпись сообщения" });
            return sig;
          },
        });
      }
      default:
        throw this.wErr(4200, `Метод ${m} не поддерживается`);
    }
  },

  async walletTronSignTx(req, address, tx, perm) {
    const { WalletStore, CHAINS } = this.walletStore();
    const { WalletSigner } = this.walletSigner();
    // Показываем только то, что реально подписывается: декодируем raw_data_hex, JSON от сайта не используем
    if (typeof tx?.raw_data_hex !== "string" || !/^[0-9a-fA-F]{20,20000}$/.test(tx.raw_data_hex)) {
      throw this.wErr(-32602, "Транзакция без raw_data_hex");
    }
    let decoded;
    try {
      decoded = WalletSigner.tronDecodeRaw(tx.raw_data_hex);
    } catch (e) {
      throw this.wErr(-32602, `Не удалось разобрать транзакцию: ${e.message}`);
    }
    if (tx.txID) {
      const C = ChromeUtils.importESModule("chrome://tabora/content/wallet/vendor/crypto.sys.mjs");
      const real = C.bytesToHex(C.sha256(C.hexToBytes(tx.raw_data_hex)));
      if (String(tx.txID).toLowerCase() !== real) {
        throw this.wErr(-32602, "txID не совпадает с данными транзакции: запрос отклонён");
      }
    }
    if (decoded.contracts.length !== 1) {
      throw this.wErr(-32602, `Транзакций с ${decoded.contracts.length} контрактами не подписываем`);
    }
    const c = decoded.contracts[0];
    if (c.owner !== address) {
      throw this.wErr(4100, "Владелец транзакции не совпадает с подключённым адресом");
    }
    if (decoded.expiration && decoded.expiration < Date.now()) {
      throw this.wErr(-32602, "Транзакция уже просрочена");
    }
    if (decoded.expiration > Date.now() + 24 * 60 * 60 * 1000) {
      throw this.wErr(-32602, "Срок действия транзакции больше суток: отклонено");
    }
    const type = c.typeName;
    const summary = [];
    const rows = [["Сеть", "TRON"], ["Тип", type]];
    let warning = null;
    let danger = false;
    let tokenUsd = 0; // токены, которыми распоряжается вызов; null — неизвестно (считается выше порога)
    const prices = await WalletStore.prices();
    const trxUsd = sun => {
      const u = WalletStore.usdOf("tron", null, sun, prices);
      return u === null ? "" : ` · ${this.wFmtUsd(u)}`;
    };
    const hexToB58 = hex => {
      try {
        return WalletSigner.tronBase58("41" + hex.slice(2));
      } catch (e) {
        return hex;
      }
    };
    if (c.type === 1) {
      summary.push(`Перевод ${(Number(c.amount) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 })} TRX${trxUsd(c.amount)} на ${this.shortAddr(c.to)}`);
      rows.push(["Куда", c.to, "mono"]);
    } else if (c.type === 31) {
      const to = c.contractAddress;
      const token = CHAINS.tron.tokens.concat(WalletStore.tokensFor("tron")).find(t => t.address === to);
      const d = WalletSigner.evmDecode(to, c.data, 0n);
      const tokUsd = amount => WalletStore.usdOf("tron", token || { address: to }, amount, prices);
      if (d?.kind === "transfer") {
        summary.push(`Перевод ${token ? WalletStore.format(d.amount, token.decimals, 6) + " " + token.symbol : d.amount + " единиц токена"} на ${this.shortAddr(hexToB58(d.to))}`);
        tokenUsd = tokUsd(d.amount);
      } else if (d?.kind === "approve") {
        // «безлимит» — не только огромное число, но и больше баланса; баланс не узнать — тоже опасно
        let why = d.unlimited ? "без лимита" : null;
        if (!why && d.amount > 0n) {
          let bal = null;
          try {
            bal = await WalletSigner.tronTokenBalance(address, to);
          } catch (e) {}
          why = bal === null ? "баланс токена проверить не удалось" : d.amount > bal ? "больше вашего баланса" : null;
        }
        summary.push(`${d.amount === 0n ? "Отзыв разрешения" : `${d.increase ? "Увеличить разрешение тратить" : "Разрешение тратить"} ${d.unlimited ? "все " + (token?.symbol || "токены") : token ? WalletStore.format(d.amount, token.decimals, 6) + " " + token.symbol : d.amount}`} для ${this.shortAddr(hexToB58(d.spender))}`);
        if (why) {
          danger = true;
          warning = `Разрешение ${why}: сайт сможет тратить ваши ${token?.symbol || "токены"} этого вида в любой момент.`;
        }
        tokenUsd = why ? null : tokUsd(d.amount);
      } else if (d?.kind === "allowanceDown") {
        summary.push(`Уменьшить разрешение для ${this.shortAddr(hexToB58(d.spender))}`);
      } else if (d?.kind === "setApprovalForAll") {
        summary.push(d.approved ? `Полный доступ ко ВСЕМ NFT коллекции ${this.shortAddr(to)} для оператора ${this.shortAddr(hexToB58(d.operator))}` : `Отзыв доступа оператора ${this.shortAddr(hexToB58(d.operator))}`);
        if (d.approved) {
          danger = true;
          warning = "setApprovalForAll: оператор сможет забрать любые NFT этой коллекции. Так устроено большинство краж NFT.";
          tokenUsd = null;
        }
      } else {
        // белый список: всё нерасшифрованное — опасно
        summary.push(`Вызов контракта ${this.shortAddr(to)}${d?.selector ? ` (${d.selector})` : ""}${c.callValue ? ` с ${WalletStore.format(c.callValue, 6, 6)} TRX` : ""}`);
        danger = true;
        warning = "Кошелёк не может расшифровать этот вызов контракта: что он сделает, неизвестно. Подписывайте, только если доверяете сайту.";
        tokenUsd = null;
      }
      if (c.callValue > 0n) {
        const trx = `${WalletStore.format(c.callValue, 6, 6)} TRX${trxUsd(c.callValue)}`;
        rows.push(["Вложено TRX", trx, "bad"]);
        if (d && d.kind !== "unknown") {
          summary.push(`Плюс к вызову приложено ${trx}: эти монеты получит контракт`);
          if (["transfer", "approve", "transferFrom", "setApprovalForAll"].includes(d.kind)) {
            danger = true;
            warning = `К вызову токена приложено ${trx}. Стандартные TRC-20 так не работают: TRX уйдут контракту.${warning ? " " + warning : ""}`;
          }
        }
      }
      if (c.callTokenValue > 0n) {
        rows.push(["Вложено TRC-10", `${c.callTokenValue} (id ${c.tokenId})`, "bad"]);
        danger = true;
        tokenUsd = null;
      }
      rows.push(["Контракт", to, "mono"], ["Лимит комиссии", `${(decoded.feeLimit / 1e6).toFixed(2)} TRX`]);
    } else {
      summary.push(`Операция ${type}`);
      warning = "Этот тип операции кошелёк не расшифровывает. Подписывайте только если понимаете, что делаете.";
      danger = true;
    }
    if (c.permissionId) {
      rows.push(["Permission", String(c.permissionId), "bad"]);
      danger = true;
      warning = `${warning ? warning + " " : ""}Используется нестандартное разрешение (permission ${c.permissionId}).`;
    }
    if (decoded.data) {
      rows.push(["Memo", this.wSafe(decoded.data, 200).text]);
    }
    if (decoded.expiration) {
      rows.push(["Действует до", new Date(decoded.expiration).toLocaleString("ru-RU", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short" })]);
    }
    const sig = await this.walletConfirm({
      fromSite: true, guard: this.walletGuard(req),
      onDisconnect: () => WalletStore.revokePermission(req.origin, req.chain).catch(() => {}),
      title: "Запрос подписи",
      badge: "TRON",
      origin: this.originInfo(req, perm),
      summary,
      rows,
      warning,
      danger,
      details: JSON.stringify(c, (k, val) => (typeof val === "bigint" ? val.toString() : val), 2).slice(0, 1500),
      // оценка суммы для порога пароля: TRX перевода или вложенные в вызов плюс токены; неизвестное — выше порога
      usd: WalletStore.sumUsd(WalletStore.usdOf("tron", null, c.type === 1 ? c.amount || 0n : c.type === 31 ? c.callValue || 0n : 0n, prices), c.type === 31 ? tokenUsd : c.type === 1 ? 0 : null),
      okLabel: "Подписать",
      onSign: async pass => {
        const signed = await WalletSigner.withKey(perm.walletId, perm.index, "tron", priv => WalletSigner.tronSignTx({ raw_data_hex: tx.raw_data_hex, visible: tx.visible }, priv));
        (this._tronSigned ||= new Set()).add(signed.txID);
        if (this._tronSigned.size > 500) {
          this._tronSigned.clear();
        }
        await WalletStore.addActivity({ chain: "tron", kind: "dapp", origin: req.host, hash: signed.txID, note: summary[0] });
        return signed;
      },
    });
    return sig;
  },

  /* ---- Solana ---------------------------------------------------------------- */

  solAccountPayload(address, label) {
    const { WalletSigner } = this.walletSigner();
    return { address, publicKey: WalletSigner.solPubkeyBytes(address), label };
  },

  async walletSol(req) {
    const { WalletStore } = this.walletStore();
    const { WalletSigner } = this.walletSigner();
    const m = req.method;
    const p = Array.isArray(req.params) ? req.params : [];
    const perm = this.walletPerm(req);
    const address = perm && WalletStore.exists ? this.walletPermAddress(req, "solana") : null;
    switch (m) {
      case "tabora_state":
        // пока кошелёк заблокирован, адрес сайту не отдаём
        return { account: address && WalletStore.unlocked ? this.solAccountPayload(address, "Tabora") : null };
      case "sol_connectSilent":
        if (!address) {
          throw this.wErr(4001, "Сайт не подключён");
        }
        if (!WalletStore.unlocked) {
          throw this.wErr(4001, "Кошелёк заблокирован: подключитесь заново");
        }
        return { accounts: [this.solAccountPayload(address, "Tabora")] };
      case "sol_connect": {
        if (address) {
          await this.walletEnsureUnlocked(req);
          return { accounts: [this.solAccountPayload(address, "Tabora")] };
        }
        const account = await this.walletConnectSheet(req, "Solana");
        const payload = this.solAccountPayload(account.addresses.solana, account.name);
        this.walletEmit(req, "sol", "accountsChanged", payload);
        return { accounts: [payload] };
      }
      case "sol_disconnect":
        if (!WalletStore.unlocked) {
          // файл не трогаем в заблокированном состоянии: сайту просто сообщаем об отключении
          this.walletEmit(req, "sol", "accountsChanged", null);
          return null;
        }
        await WalletStore.revokePermission(req.origin, "sol");
        this.walletEmit(req, "sol", "accountsChanged", null);
        return null;
      case "sol_signMessage": {
        if (!address) {
          throw this.wErr(4100, "Сайт не подключён к кошельку");
        }
        await this.walletEnsureUnlocked(req);
        await this.walletFocusRequest(req);
        const out = [];
        for (const input of p) {
          const bytes = new Uint8Array(input.message);
          if (bytes.length > 65536) {
            throw this.wErr(-32602, "Сообщение слишком длинное");
          }
          if (WalletSigner.solLooksLikeMessage(bytes)) {
            throw this.wErr(4001, "Сообщение является транзакцией Solana: подпись отклонена");
          }
          let text;
          let binary = false;
          try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch (e) {
            binary = true;
            text = "0x" + Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
          }
          const safe = this.wSafe(text);
          const siws = binary ? null : this.wSiweCheck(safe.text, req);
          const sig = await this.walletConfirm({
            fromSite: true, guard: this.walletGuard(req),
            onDisconnect: () => WalletStore.revokePermission(req.origin, req.chain).catch(() => {}),
            title: "Подпись сообщения",
            badge: "Solana",
            origin: this.originInfo(req, perm),
            summary: [binary ? "Сайт просит подписать двоичные данные, а не текст" : "Подпись подтверждает владение адресом. Средства не списываются"],
            warning: siws || (binary ? "Двоичное сообщение нельзя прочитать. Подписывайте только если точно доверяете сайту." : safe.hidden ? `В сообщении ${safe.hidden} скрытых символов.` : null),
            danger: !!siws || binary || safe.hidden > 0,
            details: safe.text,
            detailsLabel: "Сообщение",
            onSign: async pass => {
              return WalletSigner.withKey(perm.walletId, perm.index, "solana", priv => WalletSigner.solSignMessage(bytes, priv));
            },
          });
          out.push({ signedMessage: Array.from(bytes), signature: Array.from(sig), signatureType: "ed25519" });
        }
        await WalletStore.addActivity({ chain: "solana", kind: "sign", origin: req.host, note: "подпись сообщения" });
        return out;
      }
      case "sol_signTransaction":
      case "sol_signAndSendTransaction": {
        if (!address) {
          throw this.wErr(4100, "Сайт не подключён к кошельку");
        }
        await this.walletEnsureUnlocked(req);
        await this.walletFocusRequest(req);
        const out = [];
        for (const input of p) {
          const bytes = new Uint8Array(input.transaction);
          const signed = await this.walletSolSignTx(req, address, bytes, perm, m === "sol_signAndSendTransaction", input.options || {});
          out.push(signed);
        }
        return out;
      }
      default:
        throw this.wErr(4200, `Метод ${m} не поддерживается`);
    }
  },

  async walletSolSignTx(req, address, bytes, perm, send, options) {
    const { WalletStore } = this.walletStore();
    const { WalletSigner } = this.walletSigner();
    const C = ChromeUtils.importESModule("chrome://tabora/content/wallet/vendor/crypto.sys.mjs");
    if (bytes.length > 1644) {
      throw this.wErr(-32602, "Транзакция больше допустимого размера");
    }
    let parsed;
    try {
      parsed = WalletSigner.solParse(bytes);
    } catch (e) {
      throw this.wErr(-32602, `Не удалось разобрать транзакцию: ${e.message}`);
    }
    const ourIndex = parsed.keys.indexOf(address);
    if (ourIndex === -1 || ourIndex >= parsed.sigCount) {
      throw this.wErr(4100, "Транзакция не требует подписи подключённого адреса");
    }
    const prices = await WalletStore.prices();
    const tokens = WalletStore.tokensFor("solana");
    const desc = WalletSigner.solDescribe(parsed, address, tokens);
    const rows = [["Сеть", "Solana"], ["Ваша роль", desc.feePayer ? "плательщик комиссии и подписант" : `подписант №${ourIndex + 1} из ${parsed.sigCount}`], ["Инструкций", String(parsed.instructions.length)]];
    const summary = [...desc.lines.slice(0, 6)];
    if (desc.lines.length > 6) {
      summary.push(`…и ещё ${desc.lines.length - 6}`);
    }
    let warning = desc.unknown ? `В транзакции ${desc.unknown} ${desc.unknown === 1 ? "программа, которую" : "программ, которые"} кошелёк не расшифровывает: с вашей подписью они могут распоряжаться вашими счетами. Подписывайте, только если доверяете сайту.` : desc.danger ? "В транзакции есть опасные инструкции (approve, смена владельца, закрытие или сжигание). Убедитесь, что это ожидаемо." : null;
    let danger = desc.danger;
    let simUsd = null; // оценка списания для порога пароля по симуляции; null — неизвестно (выше порога)
    // Симуляция: изменение SOL и известных токенов
    try {
      const atas = tokens.map(t => ({ t, ata: WalletSigner.solAta(address, t.mint) }));
      // плюс любые счета из транзакции, которые окажутся нашими токен-счетами (в т. ч. Token-2022 и не-ATA)
      const extra = parsed.keys.filter(k => k !== address && !atas.some(a => a.ata === k)).slice(0, 40);
      const extraInfo = extra.length ? await WalletStore.rpc("solana", { jsonrpc: "2.0", id: 3, method: "getMultipleAccounts", params: [extra, { encoding: "base64" }] }) : { result: { value: [] } };
      const tokenPrograms = [WalletSigner.SOL_TOKEN, WalletSigner.SOL_TOKEN_2022];
      const ours = [];
      (extraInfo.result?.value || []).forEach((acc, i) => {
        if (!acc?.data?.[0] || !tokenPrograms.includes(acc.owner)) {
          return;
        }
        const raw = C.base64.decode(acc.data[0]);
        if (raw.length >= 165 && C.base58.encode(raw.slice(32, 64)) === address) {
          const mint = C.base58.encode(raw.slice(0, 32));
          const t = tokens.find(x => x.mint === mint) || { symbol: `токен ${mint.slice(0, 4)}…${mint.slice(-4)}`, decimals: 0, mint };
          ours.push({ t, ata: extra[i] });
        }
      });
      atas.push(...ours);
      const addresses = [address, ...atas.map(a => a.ata)];
      const [sim, cur] = await Promise.all([
        WalletStore.rpc("solana", { jsonrpc: "2.0", id: 1, method: "simulateTransaction", params: [C.base64.encode(bytes), { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, accounts: { encoding: "base64", addresses } }] }),
        WalletStore.rpc("solana", { jsonrpc: "2.0", id: 2, method: "getMultipleAccounts", params: [addresses, { encoding: "base64" }] }),
      ]);
      const r = sim.result?.value;
      if (r?.err) {
        warning = `Симуляция завершилась ошибкой: ${JSON.stringify(r.err).slice(0, 120)}. Транзакция, скорее всего, не пройдёт.`;
        danger = true;
      } else if (r?.accounts) {
        const tokenAmount = acc => {
          if (!acc?.data?.[0]) {
            return 0n;
          }
          const raw = C.base64.decode(acc.data[0]);
          return raw.length >= 72 ? new DataView(raw.buffer, raw.byteOffset).getBigUint64(64, true) : 0n;
        };
        // смена владельца счёта, делегат или право закрытия у токен-счёта не видны по балансам: сверяем поля после симуляции
        const field = (acc, from, to) => {
          if (!acc?.data?.[0]) {
            return "";
          }
          const raw = C.base64.decode(acc.data[0]);
          return raw.length >= to ? C.bytesToHex(raw.slice(from, to)) : "";
        };
        const authority = [];
        if (cur.result?.value?.[0] && r.accounts[0] && cur.result.value[0].owner !== r.accounts[0].owner) {
          authority.push("у вашего адреса сменится программа-владелец");
        }
        atas.forEach(({ t }, i) => {
          const a = cur.result?.value?.[i + 1];
          const b = r.accounts[i + 1];
          if (!a || !b) {
            return;
          }
          if (field(a, 32, 64) !== field(b, 32, 64)) {
            authority.push(`сменится владелец счёта ${t.symbol}`);
          } else if (field(a, 72, 108) !== field(b, 72, 108) && field(b, 72, 76) !== "00000000") {
            authority.push(`появится делегат у счёта ${t.symbol}`);
          } else if (field(a, 129, 165) !== field(b, 129, 165) && field(b, 129, 133) !== "00000000") {
            authority.push(`сменится право закрытия счёта ${t.symbol}`);
          }
        });
        if (authority.length) {
          danger = true;
          simUsd = null;
          warning = `Симуляция: ${authority.join(", ")}. Так угоняют токены без явного перевода.${warning ? " " + warning : ""}`;
        }
        const before = BigInt(cur.result?.value?.[0]?.lamports || 0);
        const after = BigInt(r.accounts[0]?.lamports || 0);
        const sol = Number(after - before) / 1e9;
        // уменьшение SOL сверх комиссии, не объяснённое описанным переводом SOL — тревога
        if (sol < -0.001 && !desc.lines.some(l => /SOL/.test(l) && /Перевод|Создание/.test(l))) {
          danger = true;
          warning ||= `Баланс SOL уменьшится на ${Math.abs(sol).toLocaleString("en-US", { maximumFractionDigits: 6 })} без явного перевода в инструкциях.`;
        }
        const solUsd = WalletStore.usdOf("solana", null, after - before, prices);
        const deltas = [`${sol >= 0 ? "+" : ""}${sol.toLocaleString("en-US", { maximumFractionDigits: 6 })} SOL${solUsd ? ` (${this.wFmtUsd(solUsd)})` : ""}`];
        if (!authority.length) {
          simUsd = after < before ? solUsd : 0;
        }
        atas.forEach(({ t }, i) => {
          const d = tokenAmount(r.accounts[i + 1]) - tokenAmount(cur.result?.value?.[i + 1]);
          if (d < 0n) {
            simUsd = WalletStore.sumUsd(simUsd, WalletStore.usdOf("solana", t, -d, prices)); // свои и неизвестные токены — без цены
          }
          if (d !== 0n) {
            deltas.push(`${d > 0n ? "+" : "−"}${WalletStore.format(d < 0n ? -d : d, t.decimals, 6)} ${t.symbol}`);
            if (d < 0n && !desc.lines.some(l => l.includes(t.symbol))) {
              danger = true;
            }
          }
        });
        rows.push(["Изменение баланса", deltas.join(" · ")]);
      }
    } catch (e) {
      rows.push(["Симуляция", "недоступна: нода не ответила", "bad"]);
      warning ||= "Не удалось смоделировать транзакцию: изменения баланса неизвестны.";
      danger = true;
    }
    const result = await this.walletConfirm({
      fromSite: true, guard: this.walletGuard(req),
      title: send ? "Запрос транзакции" : "Подпись транзакции",
      badge: "Solana",
      origin: this.originInfo(req, perm),
      summary,
      rows,
      warning,
      danger,
      usd: simUsd,
      details: parsed.keys.map((k, i) => `${i}: ${k}${k === address ? " (вы)" : ""}`).join("\n"),
      detailsLabel: "Аккаунты",
      okLabel: send ? "Подписать и отправить" : "Подписать",
      onSign: async pass => {
        const signed = await WalletSigner.withKey(perm.walletId, perm.index, "solana", priv => WalletSigner.solSignTransaction(bytes, priv, address));
        if (send) {
          const sig = await WalletSigner.solSend(signed, { ...options, skipPreflight: false });
          await WalletStore.addActivity({ chain: "solana", kind: "dapp", origin: req.host, hash: sig, note: summary[0] });
          return { signature: Array.from(C.base58.decode(sig)) };
        }
        await WalletStore.addActivity({ chain: "solana", kind: "sign", origin: req.host, note: "подпись транзакции" });
        return { signedTransaction: Array.from(signed) };
      },
    });
    return result;
  },

  /* ---- Блокировка: сайты узнают о смене состояния ------------------------------ */

  walletWatchLock() {
    if (this._walletLockObs) {
      return;
    }
    const { WalletStore } = this.walletStore();
    this._walletLockObs = (s, t, what) => {
      if (what !== "locked" && what !== "unlocked") {
        return;
      }
      for (const [origin, perms] of Object.entries(WalletStore.permissions)) {
        if (perms.evm) {
          const addr = what === "unlocked" ? this.walletPermAddress({ origin, chain: "evm" }, perms.evm.chainId || "ethereum") : null;
          this.walletEmit({ origin }, "evm", "accountsChanged", addr ? [addr] : []);
        }
        // TRON и Solana: адрес тоже не виден сайту, пока кошелёк заблокирован
        if (perms.tron) {
          const addr = what === "unlocked" ? this.walletPermAddress({ origin, chain: "tron" }, "tron") : null;
          this.walletEmit({ origin }, "tron", "accountsChanged", addr ? this.tronAddrPayload(addr) : null);
        }
        if (perms.sol) {
          const addr = what === "unlocked" ? this.walletPermAddress({ origin, chain: "sol" }, "solana") : null;
          this.walletEmit({ origin }, "sol", "accountsChanged", addr ? this.solAccountPayload(addr, "Tabora") : null);
        }
      }
    };
    Services.obs.addObserver(this._walletLockObs, WalletStore.TOPIC);
  },

  /* ---- Подключённые сайты (настройки) ---------------------------------------- */

  walletSitesCard() {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { WalletStore } = this.walletStore();
    const perms = WalletStore.permissions;
    const origins = Object.keys(perms);
    const card = h("div", { class: "w-group" }, null, [h("b", { class: "w-group-title" }, "Подключённые сайты")]);
    if (!origins.length) {
      card.append(h("p", { class: "w-hint" }, "Пока ни один сайт не подключён. Запросы появятся здесь после подключения."));
      return card;
    }
    for (const origin of origins) {
      const chains = ["evm", "tron", "sol"].filter(c => perms[origin][c]);
      const host = perms[origin][chains[0]]?.host || origin.replace(/^https?:\/\//, "");
      const row = h("div", { class: "w-site" }, null, [
        h("span", { class: "w-origin-icon small" }, null, [h("img", { src: `page-icon:${origin}/`, alt: "" })]),
        h("div", { class: "w-chain-text" }, null, [h("b", {}, host), h("span", { class: "w-sub-line" }, chains.map(c => ({ evm: "EVM", tron: "TRON", sol: "Solana" })[c]).join(" · "))]),
        this.iconButton("", "Отключить сайт", ["M18 6 6 18", "m6 6 12 12"], async () => {
          await WalletStore.revokePermission(origin);
          for (const c of chains) {
            this.walletEmit({ origin }, c, "accountsChanged", c === "evm" ? [] : null);
          }
          this.renderDrawer();
        }, 14),
      ]);
      card.append(row);
    }
    return card;
  },
});
