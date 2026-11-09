/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Провайдер кошелька Tabora для веб-страниц.
 * EVM: window.ethereum (EIP-1193) и анонс EIP-6963. TRON: window.tronLink / window.tronWeb
 * (подмножество API TronLink). Solana: Wallet Standard (wallet-standard:register-wallet).
 * Все объекты создаются в компартменте страницы через Cu.cloneInto/exportFunction;
 * приватных данных здесь нет: каждый запрос уходит в родительский процесс,
 * где пользователь подтверждает действие. */

const ICON = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="18" fill="#c8f25a"/><circle cx="32" cy="32" r="11" fill="#0b0c0e"/></svg>');
const UUID = "7f2b4a1e-6c3d-4a2f-9b1e-5c0a7ab0ra11";

export class TaboraWalletChild extends JSWindowActorChild {
  handleEvent(event) {
    if (event.type === "DOMWindowCreated") {
      this.inject();
    }
  }

  receiveMessage(message) {
    if (message.name === "TaboraWallet:Event") {
      this.dispatch(message.data.chain, message.data.event, message.data.payload);
    }
  }

  get page() {
    return this.contentWindow?.wrappedJSObject;
  }

  /** Вызов в родителя, обёрнутый в Promise страницы. */
  pagePromise(chain, method, params, transform = null) {
    const page = this.page;
    let safeParams = null;
    try {
      safeParams = params === undefined ? [] : JSON.parse(JSON.stringify(params));
    } catch (e) {
      safeParams = [];
    }
    return new page.Promise(
      Cu.exportFunction((resolve, reject) => {
        let activation = { active: false, been: false };
        try {
          const ua = this.contentWindow.navigator.userActivation;
          activation = { active: !!ua.isActive, been: !!ua.hasBeenActive };
        } catch (e) {}
        this.sendQuery("TaboraWallet:Request", { chain, method, params: safeParams, activation }).then(
          result => resolve(Cu.cloneInto(transform ? transform(result) : result === undefined ? null : result, page)),
          err => {
            const e = new page.Error(err?.message || String(err));
            Cu.waiveXrays(e).code = err?.code || -32603;
            if (err?.data !== undefined) {
              Cu.waiveXrays(e).data = Cu.cloneInto(err.data, page);
            }
            reject(e);
          }
        );
      }, page)
    );
  }

  inject() {
    const win = this.contentWindow;
    if (!win || !/^https?:$/.test(win.location?.protocol || "")) {
      return;
    }
    const page = this.page;
    if (!page || this._injected) {
      return;
    }
    this._injected = true;
    this.listeners = { evm: new Map(), tron: new Map(), sol: new Map() };
    this.state = { evm: { accounts: [], chainId: "0x1" }, tron: { address: null }, sol: { account: null } };
    try {
      this.injectEvm();
    } catch (e) {
      console.error("Tabora wallet inject evm", e);
    }
    try {
      this.injectTron();
    } catch (e) {
      console.error("Tabora wallet inject tron", e);
    }
    try {
      this.injectSolana();
    } catch (e) {
      console.error("Tabora wallet inject solana", e);
    }
  }

  on(chain, event, fn) {
    const map = this.listeners[chain];
    if (!map.has(event)) {
      map.set(event, new Set());
    }
    map.get(event).add(fn);
  }

  off(chain, event, fn) {
    this.listeners[chain]?.get(event)?.delete(fn);
  }

  dispatch(chain, event, payload) {
    const page = this.page;
    if (!page) {
      return;
    }
    if (chain === "evm") {
      if (event === "accountsChanged") {
        this.state.evm.accounts = payload || [];
        if (this.evmProvider) {
          Cu.waiveXrays(this.evmProvider).selectedAddress = payload?.[0] || null;
        }
      }
      if (event === "chainChanged") {
        this.state.evm.chainId = payload;
        if (this.evmProvider) {
          Cu.waiveXrays(this.evmProvider).chainId = payload;
          Cu.waiveXrays(this.evmProvider).networkVersion = String(parseInt(payload, 16));
        }
      }
    }
    if (chain === "tron" && event === "accountsChanged") {
      this.state.tron.address = payload?.base58 || null;
      if (this.tronWeb) {
        const tw = Cu.waiveXrays(this.tronWeb);
        tw.defaultAddress = Cu.cloneInto(payload ? { base58: payload.base58, hex: payload.hex, name: "Tabora" } : { base58: false, hex: false }, page);
        tw.ready = !!payload;
        Cu.waiveXrays(this.tronLink).ready = !!payload;
      }
      try {
        page.postMessage(Cu.cloneInto({ message: { action: payload ? "setAccount" : "disconnect", data: { address: payload?.base58 || "" } }, isTronLink: true }, page), "*");
      } catch (e) {}
    }
    if (chain === "sol" && event === "accountsChanged") {
      this.state.sol.account = payload;
      if (this.solWallet) {
        Cu.waiveXrays(this.solWallet).accounts = Cu.cloneInto(payload ? [this.solAccount(payload)] : [], page);
      }
      event = "change";
      payload = { accounts: payload ? [this.solAccount(payload)] : [] };
    }
    for (const fn of this.listeners[chain]?.get(event) || []) {
      try {
        fn(Cu.cloneInto(payload, page));
      } catch (e) {}
    }
  }

  /* ---------- EVM ---------- */

  injectEvm() {
    const page = this.page;
    const self = this;
    const provider = Cu.cloneInto(
      {
        isTabora: true,
        isMetaMask: false,
        chainId: "0x1",
        networkVersion: "1",
        selectedAddress: null,
        request(args) {
          const a = args ? JSON.parse(JSON.stringify(args)) : {};
          return self.pagePromise("evm", a.method, a.params);
        },
        enable() {
          return self.pagePromise("evm", "eth_requestAccounts", []);
        },
        isConnected() {
          return true;
        },
        on(event, fn) {
          self.on("evm", String(event), fn);
        },
        addListener(event, fn) {
          self.on("evm", String(event), fn);
        },
        once(event, fn) {
          const wrap = payload => {
            self.off("evm", String(event), wrap);
            fn(payload);
          };
          self.on("evm", String(event), wrap);
        },
        removeListener(event, fn) {
          self.off("evm", String(event), fn);
        },
        off(event, fn) {
          self.off("evm", String(event), fn);
        },
        removeAllListeners(event) {
          if (event) {
            self.listeners.evm.delete(String(event));
          } else {
            self.listeners.evm.clear();
          }
        },
        send(methodOrPayload, paramsOrCallback) {
          // устаревшие формы: send(method, params) → Promise; send(payload, cb)
          if (typeof methodOrPayload === "string") {
            return self.pagePromise("evm", methodOrPayload, paramsOrCallback);
          }
          const payload = JSON.parse(JSON.stringify(methodOrPayload));
          const p = self.pagePromise("evm", payload.method, payload.params);
          if (typeof paramsOrCallback === "function") {
            p.then(
              result => paramsOrCallback(null, Cu.cloneInto({ id: payload.id, jsonrpc: "2.0", result }, page)),
              error => paramsOrCallback(error, null)
            );
            return undefined;
          }
          return p;
        },
        sendAsync(payload, cb) {
          const p = JSON.parse(JSON.stringify(payload));
          self.pagePromise("evm", p.method, p.params).then(
            result => cb(null, Cu.cloneInto({ id: p.id, jsonrpc: "2.0", result }, page)),
            error => cb(error, null)
          );
        },
      },
      page,
      { cloneFunctions: true, wrapReflectors: true }
    );
    this.evmProvider = provider;
    if (!("ethereum" in page)) {
      try {
        Object.defineProperty(page, "ethereum", { value: provider, configurable: true, writable: true, enumerable: false });
      } catch (e) {
        page.ethereum = provider;
      }
    }
    // EIP-6963
    const info = Cu.cloneInto({ uuid: UUID, name: "Tabora Wallet", icon: ICON, rdns: "app.tabora.wallet" }, page);
    const detail = new page.Object();
    Cu.waiveXrays(detail).info = info;
    Cu.waiveXrays(detail).provider = provider;
    page.Object.freeze(detail);
    const announce = () => {
      const init = new page.Object();
      Cu.waiveXrays(init).detail = detail;
      page.dispatchEvent(new page.CustomEvent("eip6963:announceProvider", init));
    };
    this.contentWindow.addEventListener("eip6963:requestProvider", announce);
    announce();
    // Актуальное состояние (аккаунты уже подключённого сайта)
    this.sendQuery("TaboraWallet:Request", { chain: "evm", method: "tabora_state", params: [] }).then(state => {
      if (state?.accounts?.length) {
        this.dispatch("evm", "chainChanged", state.chainId);
        this.dispatch("evm", "accountsChanged", state.accounts);
        this.dispatch("evm", "connect", { chainId: state.chainId });
      }
    }).catch(() => {});
  }

  /* ---------- TRON (подмножество TronLink) ---------- */

  injectTron() {
    const page = this.page;
    const self = this;
    const trx = {
      sign(transaction) {
        return self.pagePromise("tron", "tron_sign", [transaction]);
      },
      signMessageV2(message) {
        return self.pagePromise("tron", "tron_signMessageV2", [message]);
      },
      signMessage(message) {
        return self.pagePromise("tron", "tron_signMessage", [message]);
      },
      sendRawTransaction(signed) {
        return self.pagePromise("tron", "tron_sendRawTransaction", [signed]);
      },
      getBalance(address) {
        return self.pagePromise("tron", "tron_getBalance", [address]);
      },
      getAccount(address) {
        return self.pagePromise("tron", "tron_getAccount", [address]);
      },
      getTransactionInfo(id) {
        return self.pagePromise("tron", "tron_getTransactionInfo", [id]);
      },
      getCurrentBlock() {
        return self.pagePromise("tron", "tron_getCurrentBlock", []);
      },
    };
    const transactionBuilder = {
      sendTrx(to, amount, from) {
        return self.pagePromise("tron", "tron_buildSendTrx", [to, amount, from]);
      },
      triggerSmartContract(contract, fn, options, params, issuer) {
        return self.pagePromise("tron", "tron_triggerSmartContract", [contract, fn, options, params, issuer]);
      },
    };
    const tronWeb = Cu.cloneInto(
      {
        ready: false,
        isTabora: true,
        defaultAddress: { base58: false, hex: false },
        fullNode: { host: "https://api.trongrid.io" },
        solidityNode: { host: "https://api.trongrid.io" },
        eventServer: { host: "https://api.trongrid.io" },
        trx,
        transactionBuilder,
        toSun(v) {
          return String(Math.round(Number(v) * 1e6));
        },
        fromSun(v) {
          return String(Number(v) / 1e6);
        },
        isAddress(a) {
          return typeof a === "string" && /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a);
        },
        request(args) {
          const a = args ? JSON.parse(JSON.stringify(args)) : {};
          return self.pagePromise("tron", a.method, a.params);
        },
        on(event, fn) {
          self.on("tron", String(event), fn);
        },
      },
      page,
      { cloneFunctions: true, wrapReflectors: true }
    );
    const tronLink = Cu.cloneInto(
      {
        ready: false,
        isTabora: true,
        tronWeb,
        request(args) {
          const a = args ? JSON.parse(JSON.stringify(args)) : {};
          return self.pagePromise("tron", a.method, a.params);
        },
        on(event, fn) {
          self.on("tron", String(event), fn);
        },
      },
      page,
      { cloneFunctions: true, wrapReflectors: true }
    );
    Cu.waiveXrays(tronLink).tronWeb = tronWeb;
    this.tronWeb = tronWeb;
    this.tronLink = tronLink;
    if (!("tronLink" in page)) {
      page.tronLink = tronLink;
    }
    if (!("tronWeb" in page)) {
      page.tronWeb = tronWeb;
    }
    this.sendQuery("TaboraWallet:Request", { chain: "tron", method: "tabora_state", params: [] }).then(state => {
      if (state?.address) {
        this.dispatch("tron", "accountsChanged", state.address);
      }
    }).catch(() => {});
  }

  /* ---------- Solana: Wallet Standard ---------- */

  solAccount(acc) {
    return {
      address: acc.address,
      publicKey: new Uint8Array(acc.publicKey),
      chains: ["solana:mainnet"],
      features: ["solana:signTransaction", "solana:signMessage", "solana:signAndSendTransaction"],
      label: acc.label || "Tabora",
      icon: ICON,
    };
  }

  injectSolana() {
    const page = this.page;
    const self = this;
    const bytesOf = v => Array.from(new Uint8Array(v));
    const wallet = Cu.cloneInto(
      {
        version: "1.0.0",
        name: "Tabora Wallet",
        icon: ICON,
        chains: ["solana:mainnet"],
        accounts: [],
        features: {
          "standard:connect": {
            version: "1.0.0",
            connect(input) {
              const silent = !!(input && JSON.parse(JSON.stringify(input)).silent);
              return self.pagePromise("sol", silent ? "sol_connectSilent" : "sol_connect", [], r => ({ accounts: (r?.accounts || []).map(a => self.solAccount(a)) }));
            },
          },
          "standard:disconnect": {
            version: "1.0.0",
            disconnect() {
              return self.pagePromise("sol", "sol_disconnect", []);
            },
          },
          "standard:events": {
            version: "1.0.0",
            on(event, listener) {
              self.on("sol", String(event), listener);
              return Cu.exportFunction(() => self.off("sol", String(event), listener), page);
            },
          },
          "solana:signTransaction": {
            version: "1.0.0",
            supportedTransactionVersions: ["legacy", 0],
            signTransaction(...inputs) {
              const payload = inputs.map(i => ({ transaction: bytesOf(i.transaction), chain: i.chain || "solana:mainnet" }));
              return self.pagePromise("sol", "sol_signTransaction", payload, r => (r || []).map(x => ({ signedTransaction: new Uint8Array(x.signedTransaction) })));
            },
          },
          "solana:signAndSendTransaction": {
            version: "1.0.0",
            supportedTransactionVersions: ["legacy", 0],
            signAndSendTransaction(...inputs) {
              const payload = inputs.map(i => ({ transaction: bytesOf(i.transaction), chain: i.chain || "solana:mainnet", options: i.options ? JSON.parse(JSON.stringify(i.options)) : {} }));
              return self.pagePromise("sol", "sol_signAndSendTransaction", payload, r => (r || []).map(x => ({ signature: new Uint8Array(x.signature) })));
            },
          },
          "solana:signMessage": {
            version: "1.0.0",
            signMessage(...inputs) {
              const payload = inputs.map(i => ({ message: bytesOf(i.message) }));
              return self.pagePromise("sol", "sol_signMessage", payload, r => (r || []).map(x => ({ signedMessage: new Uint8Array(x.signedMessage), signature: new Uint8Array(x.signature), signatureType: x.signatureType })));
            },
          },
        },
      },
      page,
      { cloneFunctions: true, wrapReflectors: true }
    );
    this.solWallet = wallet;
    const register = Cu.exportFunction(api => {
      try {
        Cu.waiveXrays(api).register(wallet);
      } catch (e) {}
    }, page);
    const init = new page.Object();
    Cu.waiveXrays(init).detail = register;
    page.dispatchEvent(new page.CustomEvent("wallet-standard:register-wallet", init));
    this.contentWindow.addEventListener("wallet-standard:app-ready", event => {
      try {
        Cu.waiveXrays(event.detail).register(wallet);
      } catch (e) {}
    });
    this.sendQuery("TaboraWallet:Request", { chain: "sol", method: "tabora_state", params: [] }).then(state => {
      if (state?.account) {
        this.dispatch("sol", "accountsChanged", state.account);
      }
    }).catch(() => {});
  }
}
