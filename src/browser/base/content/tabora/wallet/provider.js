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
  walletHandleRequest(req) {
    const run = () => this.walletDispatch(req);
    const needsUi = !this.walletIsReadOnly(req);
    if (!needsUi) {
      return run();
    }
    const p = this._walletQueue.then(run, run);
    this._walletQueue = p.catch(() => {});
    return p;
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
      this.notice(`${req.host} запрашивает кошелёк. Сначала создайте его.`);
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
    this.notice(`${req.host} запрашивает кошелёк. Разблокируйте его, чтобы продолжить.`);
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

  walletFocusRequest(req) {
    try {
      const browser = req.browsingContext?.top?.embedderElement;
      const tab = browser && gBrowser.getTabForBrowser(browser);
      if (tab && tab !== gBrowser.selectedTab) {
        gBrowser.selectedTab = tab;
      }
    } catch (e) {}
    this.wallet.view = "main";
    this.openDrawer("wallet");
  },

  originInfo(req, perm) {
    const note = perm ? `подключён ${this.relativeTime(perm.at)}` : "первое подключение";
    return { host: req.host, secure: req.secure, url: req.origin + "/", note };
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

  async walletConnectSheet(req, chainLabel) {
    const { WalletStore } = this.walletStore();
    const h = (t, a, x, c) => this.html(t, a, x, c);
    await this.walletEnsureUnlocked(req);
    this.walletFocusRequest(req);
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
      title: "Подключить сайт",
      badge: chainLabel,
      origin: this.originInfo(req, null),
      summary: ["Сайт увидит адрес и баланс выбранного счёта", "Сможет предлагать транзакции и подписи: каждую вы подтверждаете паролем", "Не сможет ничего отправить без вас"],
      extra: h("label", { class: "w-field" }, null, [h("span", {}, "Счёт"), picker]),
      okLabel: "Подключить",
      cancelLabel: "Отклонить",
      onSign: async pass => {
        if (!WalletStore.passwordless) {
          await WalletStore.verifyPassword(pass);
        }
        const w = picker._wallet;
        await WalletStore.grantPermission(req.origin, req.chain, { walletId: w.id, index: account.index, chainId: req.chain === "evm" ? (this.walletPerm(req)?.chainId || "ethereum") : nativeChain, host: req.host });
      },
    });
    return account;
  },

  /* ---- Маршрутизация --------------------------------------------------------- */

  async walletDispatch(req) {
    const { WalletStore } = this.walletStore();
    await WalletStore.ready();
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

    switch (m) {
      case "tabora_state":
        return { accounts, chainId: this.evmHexChainId(chainId) };
      case "eth_accounts":
        return accounts;
      case "eth_chainId":
        return this.evmHexChainId(chainId);
      case "net_version":
        return String(CHAINS[chainId].chainId);
      case "web3_clientVersion":
        return `Tabora/${Services.prefs.getStringPref("tabora.version", "dev")}`;
      case "wallet_getPermissions":
        return accounts.length ? [{ parentCapability: "eth_accounts", invoker: req.origin, caveats: [{ type: "restrictReturnedAccounts", value: accounts }] }] : [];
      case "wallet_revokePermissions":
        await WalletStore.revokePermission(req.origin, "evm");
        this.walletEmit(req, "evm", "accountsChanged", []);
        return null;
      case "eth_requestAccounts":
      case "wallet_requestPermissions": {
        if (accounts.length) {
          await this.walletEnsureUnlocked(req);
          return m === "eth_requestAccounts" ? accounts : [{ parentCapability: "eth_accounts" }];
        }
        const account = await this.walletConnectSheet(req, "EVM");
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
            await WalletStore.grantPermission(req.origin, "evm", { ...perm, chainId: target });
          } else {
            (this._evmTempChain ||= {})[req.origin] = target;
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
        this.walletFocusRequest(req);
        const info = await WalletStore.tokenInfo(chainId, opts.address);
        await this.walletConfirm({
          title: "Добавить токен",
          origin: this.originInfo(req, perm),
          summary: [`${info.symbol || opts.symbol} · ${info.name || ""} · ${CHAINS[chainId].name}`],
          rows: [["Контракт", opts.address, "mono"], ["Десятичных", String(info.decimals ?? opts.decimals)]],
          okLabel: "Добавить",
          onSign: async pass => {
            if (!WalletStore.passwordless) {
              await WalletStore.verifyPassword(pass);
            }
            await WalletStore.addToken(chainId, { symbol: info.symbol || opts.symbol, address: opts.address, decimals: info.decimals ?? opts.decimals, logo: opts.image || null, custom: true });
            this.wallet.balances = {};
          },
        });
        return true;
      }
      case "eth_sendTransaction": {
        if (!accounts.length) {
          throw this.wErr(4100, "Сайт не подключён к кошельку");
        }
        const tx = p[0] || {};
        if (tx.from && tx.from.toLowerCase() !== address.toLowerCase()) {
          throw this.wErr(4100, "Адрес отправителя не совпадает с подключённым");
        }
        await this.walletEnsureUnlocked(req);
        this.walletFocusRequest(req);
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
        this.walletFocusRequest(req);
        const text = WalletSigner.utf8OrHex(message);
        const looksLikeTx = /0x[0-9a-fA-F]{64,}/.test(text) && !/\s/.test(text);
        return this.walletConfirm({
          title: "Подпись сообщения",
          badge: "personal_sign",
          origin: this.originInfo(req, perm),
          summary: ["Подпись подтверждает владение адресом. Средства не списываются"],
          details: text,
          detailsLabel: "Сообщение",
          warning: looksLikeTx ? "Сообщение похоже на сырые данные транзакции. Подписывайте только если доверяете сайту." : null,
          danger: looksLikeTx,
          okLabel: "Подписать",
          onSign: async pass => {
            if (!WalletStore.passwordless) {
              await WalletStore.verifyPassword(pass);
            }
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
        await this.walletEnsureUnlocked(req);
        this.walletFocusRequest(req);
        const primary = data.primaryType || "";
        const domain = data.domain || {};
        const msg = data.message || {};
        const isPermit = /permit/i.test(primary);
        const rows = [["Тип", primary], ["Домен", `${domain.name || "—"}${domain.version ? " v" + domain.version : ""}`]];
        if (domain.chainId && Number(domain.chainId) !== CHAINS[chainId].chainId) {
          rows.push(["Сеть в данных", `chainId ${domain.chainId} · отличается от текущей`, "bad"]);
        }
        if (domain.verifyingContract) {
          rows.push(["Контракт", domain.verifyingContract, "mono"]);
        }
        let warning = null;
        if (isPermit) {
          const spender = msg.spender || msg.details?.spender;
          const value = msg.value || msg.details?.amount;
          const unlimited = value && BigInt(value) >= (1n << 255n) / 2n;
          warning = `Permit: разрешение тратить токены ${spender ? "для " + this.shortAddr(spender) : ""}${unlimited ? " без лимита" : ""}. Это равносильно approve.`;
          rows.push(["Spender", spender || "—", "mono"], ["Лимит", unlimited ? "без лимита" : String(value ?? "—")]);
        }
        return this.walletConfirm({
          title: "Подпись данных",
          badge: "EIP-712",
          origin: this.originInfo(req, perm),
          summary: [isPermit ? "Сайт просит подписать разрешение на трату токенов" : "Структурированная подпись: средства не списываются сразу, но подпись может быть использована контрактом"],
          rows,
          warning,
          danger: isPermit,
          details: JSON.stringify(msg, null, 2),
          detailsLabel: "Сообщение",
          okLabel: "Подписать",
          onSign: async pass => {
            if (!WalletStore.passwordless) {
              await WalletStore.verifyPassword(pass);
            }
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
    const decoded = WalletSigner.evmDecode(tx.to, tx.data || tx.input, tx.value);
    const value = est.value;
    const fmt = (raw, d = chain.decimals, max = 6) => WalletStore.format(raw, d, max);
    const usd = raw => (price ? ` · ${this.wFmtUsd(parseFloat(fmt(raw, chain.decimals, 8)) * price)}` : "");
    const token = (chain.tokens || []).concat(WalletStore.tokensFor(chainId)).find(t => t.address?.toLowerCase() === (tx.to || "").toLowerCase());
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
      summary.push(`Разрешение тратить ${decoded.unlimited ? "все ваши " + (token?.symbol || "токены") : tokenAmount(decoded.amount, token)} для ${this.shortAddr(decoded.spender)}`);
      if (decoded.unlimited) {
        danger = true;
        warning = `Неограниченный approve. Сайт просит право тратить все ваши ${token?.symbol || "токены"} без лимита. Можно ограничить разумной суммой.`;
        extra = this.wApproveLimit(tx, token, decoded, plan => (decodedPlan = plan));
      }
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
    const rows = [
      ["Сеть", chain.name],
      ["Контракт", tx.to ? tx.to : "новый", "mono"],
      ["Комиссия", `≈ ${fmt(est.feeLikely, chain.decimals, 8)} ${chain.symbol}${usd(est.feeLikely)}`],
      ["Максимум", `${fmt(est.fee, chain.decimals, 8)} ${chain.symbol}`, "muted"],
    ];
    const nativeBal = BigInt(await WalletStore.evm(chainId, "eth_getBalance", [address, "latest"]));
    const need = value + est.fee;
    if (nativeBal < need) {
      rows.push([`${chain.symbol} на балансе`, `${fmt(nativeBal)} · не хватает`, "bad"]);
      warning = `Не хватает ${chain.symbol} на комиссию${value ? " и сумму" : ""}: нужно ещё около ${fmt(need - nativeBal, chain.decimals, 8)} ${chain.symbol}.`;
      danger = true;
    }
    const hash = await this.walletConfirm({
      title: "Запрос транзакции",
      badge: "EIP-1193",
      origin: this.originInfo(req, perm),
      summary,
      rows,
      warning,
      danger,
      extra,
      details: `to: ${tx.to || "—"}\nvalue: ${fmt(value)} ${chain.symbol}\ndata: ${(tx.data || "0x").slice(0, 400)}${(tx.data || "").length > 400 ? "…" : ""}`,
      okLabel: nativeBal < need ? "Отправить всё равно" : "Подписать и отправить",
      onSign: async pass => {
        if (!WalletStore.passwordless) {
          await WalletStore.verifyPassword(pass);
        }
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
    const set = (label, amountRaw, pressed) => {
      const b = h("button", { class: "w-chip-btn", type: "button", "aria-pressed": String(pressed) }, label);
      b.addEventListener("click", () => {
        wrap.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", "false"));
        b.setAttribute("aria-pressed", "true");
        onChange(amountRaw === null ? null : { data: tx.data.slice(0, 10) + tx.data.slice(10, 74) + amountRaw.toString(16).padStart(64, "0") });
      });
      return b;
    };
    const decimals = token?.decimals ?? 18;
    const presets = [100n, 1000n, 10000n].map(n => n * 10n ** BigInt(decimals));
    wrap.append(...presets.map((raw, i) => set(`Лимит ${[100, 1000, 10000][i].toLocaleString("ru-RU")}${token ? " " + token.symbol : ""}`, raw, false)), set("Без лимита", null, true));
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
        const r = await WalletSigner.tronPost("/wallet/getaccount", { address: who, visible: true });
        return r.balance || 0;
      }
      case "tron_getAccount":
        return WalletSigner.tronPost("/wallet/getaccount", { address: p[0] || address, visible: true });
      case "tron_getCurrentBlock":
        return WalletSigner.tronPost("/wallet/getnowblock", {});
      case "tron_getTransactionInfo":
        return WalletSigner.tronPost("/wallet/gettransactioninfobyid", { value: p[0] });
      case "tron_buildSendTrx":
        return WalletSigner.tronBuildSendTrx(p[0], p[1], p[2] || address);
      case "tron_triggerSmartContract":
        return WalletSigner.tronTriggerSmartContract(p[0], p[1], p[2] || {}, p[3] || [], p[4] || address);
      case "tron_sendRawTransaction":
        return WalletSigner.tronBroadcast(p[0]);
      case "tron_sign": {
        if (!address) {
          throw this.wErr(4100, "Сайт не подключён к кошельку");
        }
        await this.walletEnsureUnlocked(req);
        this.walletFocusRequest(req);
        const tx = p[0];
        if (typeof tx === "string") {
          // подпись хеша/сообщения (старый API)
          return this.walletConfirm({
            title: "Подпись сообщения",
            badge: "TRON",
            origin: this.originInfo(req, perm),
            summary: ["Подпись подтверждает владение адресом"],
            details: tx,
            detailsLabel: "Сообщение",
            onSign: async pass => {
              if (!WalletStore.passwordless) {
                await WalletStore.verifyPassword(pass);
              }
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
        this.walletFocusRequest(req);
        const message = p[0];
        return this.walletConfirm({
          title: "Подпись сообщения",
          badge: "TRON",
          origin: this.originInfo(req, perm),
          summary: ["Подпись подтверждает владение адресом. Средства не списываются"],
          details: WalletSigner.utf8OrHex(message),
          detailsLabel: "Сообщение",
          onSign: async pass => {
            if (!WalletStore.passwordless) {
              await WalletStore.verifyPassword(pass);
            }
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
    const contract = tx?.raw_data?.contract?.[0];
    const type = contract?.type || "неизвестно";
    const v = contract?.parameter?.value || {};
    const summary = [];
    const rows = [["Сеть", "TRON"], ["Тип", type]];
    let warning = null;
    let danger = false;
    const prices = await WalletStore.prices();
    const trxUsd = sun => (prices.TRX ? ` · ${this.wFmtUsd((Number(sun) / 1e6) * prices.TRX)}` : "");
    const toB58 = hex => {
      try {
        return /^T/.test(hex) ? hex : WalletSigner.tronBase58(hex);
      } catch (e) {
        return hex;
      }
    };
    if (type === "TransferContract") {
      summary.push(`Перевод ${(Number(v.amount) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 })} TRX${trxUsd(v.amount)} на ${this.shortAddr(toB58(v.to_address))}`);
    } else if (type === "TriggerSmartContract") {
      const to = toB58(v.contract_address);
      const token = CHAINS.tron.tokens.concat(WalletStore.tokensFor("tron")).find(t => t.address === to);
      const data = "0x" + (v.data || "");
      const d = WalletSigner.evmDecode(to, data, 0n);
      if (d?.kind === "transfer") {
        summary.push(`Перевод ${token ? WalletStore.format(d.amount, token.decimals, 6) + " " + token.symbol : d.amount + " токена"} на ${this.shortAddr(toB58("41" + d.to.slice(2)))}`);
      } else if (d?.kind === "approve") {
        summary.push(`Разрешение тратить ${d.unlimited ? "все " + (token?.symbol || "токены") : token ? WalletStore.format(d.amount, token.decimals, 6) + " " + token.symbol : d.amount} для ${this.shortAddr(toB58("41" + d.spender.slice(2)))}`);
        if (d.unlimited) {
          danger = true;
          warning = "Неограниченный approve: сайт сможет тратить все токены этого вида.";
        }
      } else {
        summary.push(`Вызов контракта ${this.shortAddr(to)}${v.call_value ? ` с ${Number(v.call_value) / 1e6} TRX` : ""}`);
      }
      rows.push(["Контракт", to, "mono"], ["Лимит комиссии", `${(Number(tx.raw_data.fee_limit || 0) / 1e6).toFixed(2)} TRX`]);
    } else {
      summary.push(`Операция ${type}`);
    }
    const sig = await this.walletConfirm({
      title: "Запрос подписи",
      badge: "TRON",
      origin: this.originInfo(req, perm),
      summary,
      rows,
      warning,
      danger,
      details: JSON.stringify(v, null, 2).slice(0, 1500),
      okLabel: "Подписать",
      onSign: async pass => {
        if (!WalletStore.passwordless) {
          await WalletStore.verifyPassword(pass);
        }
        const signed = await WalletSigner.withKey(perm.walletId, perm.index, "tron", priv => WalletSigner.tronSignTx(tx, priv));
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
        await WalletStore.revokePermission(req.origin, "sol");
        this.walletEmit(req, "sol", "accountsChanged", null);
        return null;
      case "sol_signMessage": {
        if (!address) {
          throw this.wErr(4100, "Сайт не подключён к кошельку");
        }
        await this.walletEnsureUnlocked(req);
        this.walletFocusRequest(req);
        const out = [];
        for (const input of p) {
          const bytes = new Uint8Array(input.message);
          let text;
          try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch (e) {
            text = "0x" + Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
          }
          const sig = await this.walletConfirm({
            title: "Подпись сообщения",
            badge: "Solana",
            origin: this.originInfo(req, perm),
            summary: ["Подпись подтверждает владение адресом. Средства не списываются"],
            details: text,
            detailsLabel: "Сообщение",
            onSign: async pass => {
              if (!WalletStore.passwordless) {
                await WalletStore.verifyPassword(pass);
              }
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
        this.walletFocusRequest(req);
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
    const parsed = WalletSigner.solParse(bytes);
    const prices = await WalletStore.prices();
    const rows = [["Сеть", "Solana"], ["Версия", String(parsed.version)], ["Аккаунтов", String(parsed.keys.length)]];
    const summary = [];
    let warning = null;
    let danger = false;
    // симуляция: изменение баланса SOL
    try {
      const sim = await WalletStore.rpc("solana", { jsonrpc: "2.0", id: 1, method: "simulateTransaction", params: [C.base64.encode(bytes), { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, accounts: { encoding: "base64", addresses: [address] } }] });
      const r = sim.result?.value;
      if (r?.err) {
        warning = `Симуляция завершилась ошибкой: ${JSON.stringify(r.err).slice(0, 120)}. Транзакция, скорее всего, не пройдёт.`;
        danger = true;
      } else if (r?.accounts?.[0]) {
        const after = BigInt(r.accounts[0].lamports || 0);
        const bal = await WalletStore.rpc("solana", { jsonrpc: "2.0", id: 2, method: "getBalance", params: [address] });
        const before = BigInt(bal.result?.value || 0);
        const diff = after - before;
        const sol = Number(diff) / 1e9;
        summary.push(`Изменение баланса: ${sol >= 0 ? "+" : ""}${sol.toLocaleString("en-US", { maximumFractionDigits: 6 })} SOL${prices.SOL ? ` · ${this.wFmtUsd(Math.abs(sol) * prices.SOL)}` : ""}`);
      }
      if (r?.logs?.length) {
        const programs = [...new Set(r.logs.filter(l => l.startsWith("Program ") && l.includes(" invoke [1]")).map(l => l.split(" ")[1]))];
        if (programs.length) {
          rows.push(["Программы", programs.map(x => this.shortAddr(x)).join(", "), "mono"]);
        }
      }
    } catch (e) {
      summary.push("Не удалось смоделировать транзакцию заранее");
    }
    if (!summary.length) {
      summary.push("Транзакция Solana от сайта");
    }
    const result = await this.walletConfirm({
      title: send ? "Запрос транзакции" : "Подпись транзакции",
      badge: "Solana",
      origin: this.originInfo(req, perm),
      summary,
      rows,
      warning,
      danger,
      details: parsed.keys.join("\n"),
      detailsLabel: "Аккаунты",
      okLabel: send ? "Подписать и отправить" : "Подписать",
      onSign: async pass => {
        if (!WalletStore.passwordless) {
          await WalletStore.verifyPassword(pass);
        }
        const signed = await WalletSigner.withKey(perm.walletId, perm.index, "solana", priv => WalletSigner.solSignTransaction(bytes, priv, address));
        if (send) {
          const sig = await WalletSigner.solSend(signed, options);
          await WalletStore.addActivity({ chain: "solana", kind: "dapp", origin: req.host, hash: sig, note: summary[0] });
          return { signature: Array.from(C.base58.decode(sig)) };
        }
        await WalletStore.addActivity({ chain: "solana", kind: "sign", origin: req.host, note: "подпись транзакции" });
        return { signedTransaction: Array.from(signed) };
      },
    });
    return result;
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
