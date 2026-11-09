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
    return { host: req.host, secure: req.secure, url: req.origin + "/", note, topHost: req.topHost && req.topHost !== req.host ? req.topHost : null };
  },

  /** Sign-In with Ethereum/Solana: домен в сообщении обязан совпадать с сайтом,
   * иначе подпись можно переиграть для входа в ваш аккаунт на другом сайте. */
  wSiweCheck(text, req) {
    const m = /^([^\s]+) wants you to sign in with your (Ethereum|Solana) account:/m.exec(text);
    if (!m) {
      return null;
    }
    const domain = m[1].toLowerCase().replace(/^https?:\/\//, "").replace(/:\d+$/, "");
    const hosts = [req.host, req.topHost].filter(Boolean).map(h => String(h).toLowerCase().replace(/:\d+$/, ""));
    const uriLine = /^URI:\s*(\S+)/m.exec(text);
    let uriHost = null;
    try {
      uriHost = uriLine ? new URL(uriLine[1]).hostname.toLowerCase() : null;
    } catch (e) {}
    const ok = hosts.includes(domain) && (!uriHost || hosts.includes(uriHost));
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
        const rows = [["Тип", primary], ["Домен", `${this.wSafe(domain.name || "—").text}${domain.version ? " v" + this.wSafe(String(domain.version)).text : ""}`]];
        const knownToken = domain.verifyingContract && (CHAINS[chainId].tokens || []).concat(WalletStore.tokensFor(chainId)).find(t => t.address?.toLowerCase() === String(domain.verifyingContract).toLowerCase());
        if (knownToken) {
          rows.push(["Контракт токена", `${knownToken.symbol}: подпись может распоряжаться этими токенами`, "bad"]);
        }
        if (domain.verifyingContract) {
          rows.push(["Контракт", domain.verifyingContract, "mono"]);
        }
        let warning = null;
        const when = v => (v ? new Date(Number(v) * (Number(v) > 1e12 ? 1 : 1000)).toLocaleString("ru-RU", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : null);
        if (isPermit) {
          const details = Array.isArray(msg.details) ? msg.details : msg.details ? [msg.details] : [msg];
          const spender = msg.spender || details[0]?.spender;
          const parts = [];
          let unlimitedAny = false;
          for (const d of details) {
            const value = d.value ?? d.amount;
            const unlimited = d.allowed === true || (value !== undefined && value !== null && BigInt(value) >= (1n << 128n) - 1n);
            unlimitedAny ||= unlimited;
            parts.push(`${d.token ? this.shortAddr(d.token) + ": " : ""}${unlimited ? "без лимита" : String(value ?? "—")}`);
          }
          const deadline = when(msg.deadline || msg.expiry || msg.sigDeadline || details[0]?.expiration);
          warning = `Permit: разрешение тратить токены${spender ? " для " + this.shortAddr(spender) : ""}${unlimitedAny ? " без лимита" : ""}${deadline ? " до " + deadline : ""}. Это равносильно approve.`;
          rows.push(["Spender", spender || "—", "mono"], ["Лимит", parts.join(" · ")]);
          if (deadline) {
            rows.push(["Действует до", deadline]);
          }
        }
        if (dangerText) {
          warning = `${primary}: ${dangerText}.${warning ? " " + warning : ""}`;
        }
        return this.walletConfirm({
          fromSite: true, guard: this.walletGuard(req),
          onDisconnect: () => WalletStore.revokePermission(req.origin, req.chain).catch(() => {}),
          title: "Подпись данных",
          badge: "EIP-712",
          origin: this.originInfo(req, perm),
          summary: [isPermit ? "Сайт просит подписать разрешение на трату токенов" : dangerText ? `Сайт просит подписать: ${dangerText}` : "Структурированная подпись: средства не списываются сразу, но подпись может быть использована контрактом"],
          rows,
          warning,
          danger: isPermit || !!dangerText || !!knownToken,
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

  async walletEvmSendTx(req, chainId, address, tx, perm) {
    const { WalletStore, CHAINS } = this.walletStore();
    const { WalletSigner } = this.walletSigner();
    const chain = CHAINS[chainId];
    const prices = await WalletStore.prices();
    const price = prices[chain.symbol] || 0;
    const est = await WalletSigner.evmPrepare(chainId, tx, address);
    const decoded = WalletSigner.evmDecode(tx.to, tx.data, tx.value);
    const value = est.value;
    const fmt = (raw, d = chain.decimals, max = 6) => WalletStore.format(raw, d, max);
    const usd = raw => (price ? ` · ${this.wFmtUsd(WalletStore.toNumber(raw, chain.decimals) * price)}` : "");
    let token = (chain.tokens || []).concat(WalletStore.tokensFor(chainId)).find(t => t.address?.toLowerCase() === (tx.to || "").toLowerCase());
    if (!token && decoded && ["transfer", "approve", "transferFrom"].includes(decoded.kind)) {
      try {
        const info = await WalletStore.tokenInfo(chainId, tx.to);
        if (info?.symbol && info.decimals !== undefined) {
          token = { symbol: `${this.wSafe(info.symbol, 12).text} (не из списка)`, decimals: info.decimals, address: tx.to, unverified: true };
        }
      } catch (e) {}
    }
    const tokenAmount = (amount, t) => (t ? `${fmt(amount, t.decimals, 6)} ${t.symbol}` : `${amount} единиц токена ${this.shortAddr(tx.to)}`);
    const summary = [];
    let warning = null;
    let danger = false;
    let extra = null;
    let decodedPlan = null;
    if (!tx.to) {
      summary.push("Развёртывание контракта");
    } else if (!decoded) {
      summary.push(`Перевод ${fmt(value)} ${chain.symbol}${usd(value)} на ${this.shortAddr(tx.to)}`);
    } else if (decoded.kind === "transfer") {
      summary.push(`Перевод ${tokenAmount(decoded.amount, token)} на ${this.shortAddr(decoded.to)}`);
    } else if (decoded.kind === "approve") {
      summary.push(`${decoded.increase ? "Увеличить разрешение тратить" : "Разрешение тратить"} ${decoded.unlimited ? "все ваши " + (token?.symbol || "токены") : tokenAmount(decoded.amount, token)} для ${this.shortAddr(decoded.spender)}`);
      if (decoded.unlimited) {
        danger = true;
        warning = `Неограниченный approve. Сайт просит право тратить все ваши ${token?.symbol || "токены"} без лимита. Можно ограничить разумной суммой.`;
        extra = this.wApproveLimit(tx, token, decoded, plan => {
          decodedPlan = plan;
          const line = extra?.closest?.(".w-sheet-card")?.querySelector(".w-summary-line");
          if (line) {
            line.textContent = plan ? `Разрешение тратить ${plan.label} для ${this.shortAddr(decoded.spender)}` : summary[0];
          }
        });
      }
    } else if (decoded.kind === "setApprovalForAll") {
      summary.push(decoded.approved ? `Полный доступ ко ВСЕМ NFT коллекции ${this.shortAddr(tx.to)} для оператора ${this.shortAddr(decoded.operator)}` : `Отзыв доступа оператора ${this.shortAddr(decoded.operator)} к коллекции ${this.shortAddr(tx.to)}`);
      if (decoded.approved) {
        danger = true;
        warning = "setApprovalForAll: оператор сможет забрать любые NFT этой коллекции в любой момент. Так устроено большинство краж NFT. Подтверждайте только на проверенном маркетплейсе.";
      }
    } else if (decoded.kind === "nftTransfer") {
      summary.push(`Передача NFT #${decoded.tokenId.toString().slice(0, 24)} коллекции ${this.shortAddr(tx.to)}: ${this.shortAddr(decoded.from)} → ${this.shortAddr(decoded.to)}`);
      danger = true;
      warning = "Передача NFT необратима.";
    } else if (decoded.kind === "transferFrom") {
      summary.push(`transferFrom ${tokenAmount(decoded.amount, token)}: ${this.shortAddr(decoded.from)} → ${this.shortAddr(decoded.to)}`);
    } else if (decoded.kind === "withdraw") {
      summary.push(`Вывод ${fmt(decoded.amount)} из обёрнутой монеты`);
    } else if (decoded.kind === "deposit") {
      summary.push(`Обёртка ${fmt(value)} ${chain.symbol}`);
    } else if (decoded.kind === "known") {
      summary.push(decoded.text.slice(0, 300));
    } else {
      summary.push(`Вызов контракта ${this.shortAddr(tx.to)} (${decoded.selector})${value ? ` с ${fmt(value)} ${chain.symbol}${usd(value)}` : ""}`);
    }
    // Вложенная монета показывается всегда: вызов токена с приложенным ETH — классическая маскировка перевода
    const tokenLike = ["transfer", "approve", "transferFrom", "withdraw", "setApprovalForAll", "nftTransfer"].includes(decoded?.kind);
    if (value > 0n && decoded && decoded.kind !== "deposit" && decoded.kind !== "unknown") {
      summary.push(`Плюс к вызову приложено ${fmt(value)} ${chain.symbol}${usd(value)}: эти монеты получит контракт`);
      if (tokenLike) {
        danger = true;
        warning = `К вызову токена приложено ${fmt(value)} ${chain.symbol}. Стандартные токены так не работают: монеты уйдут контракту ${this.shortAddr(tx.to)}.${warning ? " " + warning : ""}`;
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
    const feeUsd = price ? WalletStore.toNumber(est.fee, chain.decimals) * price : 0;
    if (feeUsd >= 50 || (value > 0n && est.fee > value)) {
      danger = true;
      warning = `Комиссия необычно велика: до ${fmt(est.fee, chain.decimals, 8)} ${chain.symbol}${usd(est.fee)}.${warning ? " " + warning : ""}`;
    }
    const nativeBal = BigInt(await WalletStore.evm(chainId, "eth_getBalance", [address, "latest"]));
    const need = value + est.fee;
    if (nativeBal < need) {
      rows.push([`${chain.symbol} на балансе`, `${fmt(nativeBal)} · не хватает`, "bad"]);
      // предупреждение безопасности важнее нехватки средств: не затираем его
      warning = `${warning ? warning + " " : ""}Не хватает ${chain.symbol} на комиссию${value ? " и сумму" : ""}: нужно ещё около ${fmt(need - nativeBal, chain.decimals, 8)} ${chain.symbol}.`;
      danger = true;
    }
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
      // оценка суммы в долларах для порога пароля: монеты сети плюс стейблкоины в calldata
      usd: (() => {
        let u = price ? WalletStore.toNumber(value + est.fee, chain.decimals) * price : 0;
        if (token && /^(USDT|USDC|DAI)$/i.test(token.symbol) && decoded?.amount !== undefined) {
          try {
            u += Number(decoded.amount) / 10 ** token.decimals;
          } catch (e) {}
        }
        return u;
      })(),
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
    switch (m) {
      case "tabora_state":
        return { address: address ? this.tronAddrPayload(address) : null };
      case "tron_requestAccounts": {
        if (address) {
          await this.walletEnsureUnlocked(req);
          return { code: 200, message: "ok" };
        }
        const account = await this.walletConnectSheet(req, "TRON");
        this.walletEmit(req, "tron", "accountsChanged", this.tronAddrPayload(account.addresses.tron));
        return { code: 200, message: "ok" };
      }
      case "tron_getBalance": {
        const who = p[0] || address;
        if (typeof who !== "string" || !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(who)) {
          throw this.wErr(-32602, "Неверный адрес");
        }
        const r = await WalletSigner.tronPost("/wallet/getaccount", { address: who, visible: true });
        return r.balance || 0;
      }
      case "tron_getAccount": {
        const who = p[0] || address;
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
        return WalletSigner.tronBuildSendTrx(p[0], p[1], p[2] || address);
      case "tron_triggerSmartContract":
        return WalletSigner.tronTriggerSmartContract(p[0], p[1], p[2] || {}, p[3] || [], p[4] || address);
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
      const C = ChromeUtils.importESModule("chrome://browser/content/tabora/wallet/vendor/crypto.sys.mjs");
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
    const prices = await WalletStore.prices();
    const trxUsd = sun => (prices.TRX ? ` · ${this.wFmtUsd((Number(sun) / 1e6) * prices.TRX)}` : "");
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
      if (d?.kind === "transfer") {
        summary.push(`Перевод ${token ? WalletStore.format(d.amount, token.decimals, 6) + " " + token.symbol : d.amount + " единиц токена"} на ${this.shortAddr(hexToB58(d.to))}`);
      } else if (d?.kind === "approve") {
        summary.push(`Разрешение тратить ${d.unlimited ? "все " + (token?.symbol || "токены") : token ? WalletStore.format(d.amount, token.decimals, 6) + " " + token.symbol : d.amount} для ${this.shortAddr(hexToB58(d.spender))}`);
        if (d.unlimited) {
          danger = true;
          warning = "Неограниченный approve: сайт сможет тратить все токены этого вида.";
        }
      } else if (d?.kind === "setApprovalForAll") {
        summary.push(d.approved ? `Полный доступ ко ВСЕМ NFT коллекции ${this.shortAddr(to)} для оператора ${this.shortAddr(hexToB58(d.operator))}` : `Отзыв доступа оператора ${this.shortAddr(hexToB58(d.operator))}`);
        if (d.approved) {
          danger = true;
          warning = "setApprovalForAll: оператор сможет забрать любые NFT этой коллекции. Так устроено большинство краж NFT.";
        }
      } else {
        summary.push(`Вызов контракта ${this.shortAddr(to)}${c.callValue ? ` с ${WalletStore.format(c.callValue, 6, 6)} TRX` : ""}`);
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
      // оценка суммы для порога пароля: TRX перевода или вложенные в вызов плюс стейблкоины TRC-20
      usd: (() => {
        let u = prices.TRX ? (Number(c.type === 1 ? c.amount || 0n : c.callValue || 0n) / 1e6) * prices.TRX : 0;
        if (c.type === 31) {
          const token = CHAINS.tron.tokens.concat(WalletStore.tokensFor("tron")).find(t => t.address === c.contractAddress);
          const d = WalletSigner.evmDecode(c.contractAddress, c.data, 0n);
          if (token && /^(USDT|USDC)$/i.test(token.symbol) && d?.amount !== undefined) {
            u += Number(d.amount) / 10 ** token.decimals;
          }
        }
        return u;
      })(),
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
        return { account: address ? this.solAccountPayload(address, "Tabora") : null };
      case "sol_connectSilent":
        if (!address) {
          throw this.wErr(4001, "Сайт не подключён");
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
    const C = ChromeUtils.importESModule("chrome://browser/content/tabora/wallet/vendor/crypto.sys.mjs");
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
    let warning = desc.danger ? "В транзакции есть опасные инструкции (approve, смена владельца, закрытие или сжигание). Убедитесь, что это ожидаемо." : null;
    let danger = desc.danger;
    let simUsd = 0; // оценка списания для порога пароля: SOL и стейблкоины по симуляции
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
        const before = BigInt(cur.result?.value?.[0]?.lamports || 0);
        const after = BigInt(r.accounts[0]?.lamports || 0);
        const sol = Number(after - before) / 1e9;
        // уменьшение SOL сверх комиссии, не объяснённое описанным переводом SOL — тревога
        if (sol < -0.001 && !desc.lines.some(l => /SOL/.test(l) && /Перевод|Создание/.test(l))) {
          danger = true;
          warning ||= `Баланс SOL уменьшится на ${Math.abs(sol).toLocaleString("en-US", { maximumFractionDigits: 6 })} без явного перевода в инструкциях.`;
        }
        const deltas = [`${sol >= 0 ? "+" : ""}${sol.toLocaleString("en-US", { maximumFractionDigits: 6 })} SOL${prices.SOL ? ` (${this.wFmtUsd(Math.abs(sol) * prices.SOL)})` : ""}`];
        simUsd = sol < 0 ? Math.abs(sol) * (prices.SOL || 0) : 0;
        atas.forEach(({ t }, i) => {
          const d = tokenAmount(r.accounts[i + 1]) - tokenAmount(cur.result?.value?.[i + 1]);
          if (d < 0n && /^(USDT|USDC)$/i.test(t.symbol)) {
            simUsd += Number(-d) / 10 ** t.decimals;
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
