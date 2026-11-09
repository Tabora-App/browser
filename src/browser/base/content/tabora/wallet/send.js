/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Отправка из кошелька: выбор актива, адрес, сумма, оценка комиссии с проверкой
 * «хватит ли нативной монеты», подтверждение паролем, подпись и отправка в сеть.
 * Поддержка: EVM (монета и ERC-20), Bitcoin (p2wpkh), Solana (SOL и SPL), TRON (TRX и TRC-20).
 * Плюс общий лист подтверждения (walletConfirm) и история операций. */

Object.assign(Tabora, {
  _walletSigner: null,

  walletSigner() {
    if (!this._walletSigner) {
      this._walletSigner = ChromeUtils.importESModule("chrome://browser/content/tabora/wallet/WalletSigner.sys.mjs");
    }
    return this._walletSigner;
  },

  /* ---- Листы поверх панели (переживают перерисовку) ---------------------- */

  wSheetShow(box) {
    const panel = this.drawer.body.closest(".dpanel") || this.drawer.body.parentNode;
    panel.append(box);
    return box;
  },

  /* ---- Форматы ------------------------------------------------------------ */

  wFmtUsd(n) {
    if (n === null || n === undefined || Number.isNaN(n)) {
      return "";
    }
    if (n > 0 && n < 0.01) {
      return "< $0.01";
    }
    return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  },

  wParseAmount(text, decimals) {
    const s = String(text || "").trim().replace(",", ".");
    if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") {
      return null;
    }
    const [int = "0", frac = ""] = s.split(".");
    if (frac.length > decimals) {
      return null;
    }
    return BigInt(int || "0") * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
  },

  wFmt(raw, decimals, max = 6) {
    return this.walletStore().WalletStore.format(BigInt(raw), decimals, max);
  },

  wTxUrl(chainId, hash) {
    const { CHAINS } = this.walletStore();
    if (!/^(0x)?[0-9a-fA-F]{64}$|^[1-9A-HJ-NP-Za-km-z]{43,88}$/.test(String(hash || ""))) {
      return CHAINS[chainId].explorer.replace(/\/(address|account)\/$|#\/address\/$/, "/");
    }
    const e = CHAINS[chainId].explorer;
    if (chainId === "tron") {
      return e.replace("#/address/", "#/transaction/") + hash;
    }
    if (chainId === "solana") {
      return e.replace("/account/", "/tx/") + hash;
    }
    return e.replace("/address/", "/tx/") + hash;
  },

  /** Проверка адреса для сети. Возвращает { ok, note, danger }. */
  wCheckAddress(chainId, to) {
    const { CHAINS } = this.walletStore();
    const { WalletSigner } = this.walletSigner();
    const chain = CHAINS[chainId];
    const C = this._walletMod ? ChromeUtils.importESModule("chrome://browser/content/tabora/wallet/vendor/crypto.sys.mjs") : null;
    to = String(to || "").trim();
    if (!to) {
      return { ok: false, note: "" };
    }
    const tokenHit = (chain.tokens || []).find(t => (t.address || t.mint || "").toLowerCase() === to.toLowerCase());
    try {
      if (chain.kind === "evm") {
        if (!/^0x[0-9a-fA-F]{40}$/.test(to)) {
          return { ok: false, note: "Адрес EVM: 0x и 40 символов" };
        }
        if (/[a-f]/.test(to.slice(2)) && /[A-F]/.test(to.slice(2)) && !C.ethAddr.isValid(to)) {
          return { ok: false, note: "Контрольная сумма адреса не сходится: проверьте регистр букв" };
        }
      } else if (chain.kind === "tron") {
        const raw = C.base58check(C.sha256).decode(to);
        if (raw.length !== 21 || raw[0] !== 0x41) {
          return { ok: false, note: "Это не адрес TRON" };
        }
      } else if (chain.kind === "sol") {
        if (C.base58.decode(to).length !== 32) {
          return { ok: false, note: "Это не адрес Solana" };
        }
      } else if (chain.kind === "btc") {
        C.btc.Address().decode(to);
        if (!/^(bc1|1|3)/.test(to)) {
          return { ok: false, note: "Нужен адрес основной сети Bitcoin" };
        }
      }
    } catch (e) {
      return { ok: false, note: `Это не адрес ${chain.name}` };
    }
    if (tokenHit) {
      return { ok: true, danger: true, note: `Адрес верный, но это контракт ${tokenHit.symbol}: перевод на него сгорит` };
    }
    void WalletSigner;
    return { ok: true, note: `Адрес ${chain.name} верный` };
  },

  /* ---- Экран «Отправить» -------------------------------------------------- */

  walletSendStart(assetKey) {
    const assets = this.walletAssets();
    const pick = assets.find(a => a.key === assetKey) || assets.find(a => parseFloat(a.amount) > 0) || assets[0];
    this.wallet.send = { asset: pick?.key, to: "", amount: "", fee: null, feeSeq: 0 };
    this.walletGo("send");
  },

  walletSendView() {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { WalletStore, CHAINS } = this.walletStore();
    const s = (this.wallet.send ||= { asset: null, to: "", amount: "" });
    const assets = this.walletAssets();
    const asset = assets.find(a => a.key === s.asset) || assets[0];
    if (!asset) {
      return this.walletMainView();
    }
    const chain = CHAINS[asset.chain];
    const account = WalletStore.activeAccount;
    const decimals = asset.native ? chain.decimals : asset.token.decimals;
    const pending = !!asset.pending;
    if (pending) {
      // балансы ещё не загружены (например, сразу после разблокировки)
      this.walletLoadBalances(this.drawer.seq);
    }
    const available = pending ? null : BigInt(asset.native ? this.wParseAmount(asset.amount, decimals) ?? 0n : asset.token.raw || 0);
    const price = (this.wallet.prices || {})[asset.symbol] || 0;

    const back = this.wButton("Отмена", "ghost small", () => this.walletGo("main"));

    // Актив
    const assetBtn = h("button", { class: "w-asset-pick", type: "button", style: `--c:${asset.color}` }, null, [
      h("span", { class: "w-coin" }, null, [asset.logo ? h("img", { src: asset.logo, alt: "" }) : h("b", {}, asset.symbol[0]), h("i", { class: "w-coin-chain" }, null, asset.chainLogo ? [h("img", { src: asset.chainLogo, alt: "" })] : [])]),
      h("span", { class: "w-asset-pick-text" }, null, [h("b", {}, `${asset.symbol} · ${asset.chainName}`), h("span", {}, pending ? "баланс загружается…" : `доступно ${asset.amount}`)]),
      this.wIcon(["m6 9 6 6 6-6"], 12, 2.2),
    ]);
    assetBtn.addEventListener("click", e => {
      const r = e.currentTarget.getBoundingClientRect();
      this.showMenu(assets.filter(a => !a.pending).map(a => ({
        label: `${a.symbol} · ${a.chainName}`, hint: a.amount, icon: a.logo, checked: a.key === asset.key,
        run: () => { s.asset = a.key; s.fee = null; this.renderDrawer(); },
      })), r.left, r.bottom + 6);
    });

    // Кому
    const to = h("input", { class: "w-input mono", type: "text", spellcheck: "false", autocomplete: "off", placeholder: chain.kind === "evm" ? "0x…" : chain.kind === "tron" ? "T…" : chain.kind === "btc" ? "bc1…" : "Адрес Solana", value: s.to });
    const paste = this.iconButton("", "Вставить", ["M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2", "M9 2h6v4H9z"], async () => {
      try {
        to.value = (await navigator.clipboard.readText()).trim();
        to.dispatchEvent(new Event("input"));
      } catch (e) {}
    }, 14);
    const book = this.iconButton("", "Контакты", ["M4 4h12a2 2 0 0 1 2 2v14H6a2 2 0 0 1-2-2z", "M4 18a2 2 0 0 1 2-2h12", "M8 4v16", "M20 8h1", "M20 12h1"], e => {
      const r = e.currentTarget.getBoundingClientRect();
      const contacts = WalletStore.contactsFor(asset.chain);
      const items = contacts.map(c => ({ label: c.name, hint: this.shortAddr(c.address), run: () => { to.value = c.address; to.dispatchEvent(new Event("input")); } }));
      items.push(...(items.length ? [{ separator: true }] : []), { label: "Новый контакт…", run: () => this.walletContactSheet({ addresses: this.wCheckAddress(asset.chain, to.value).ok ? { [WalletStore.contactKey(asset.chain)]: to.value.trim() } : {} }) });
      this.showMenu(items, r.left, r.bottom + 6);
    }, 14);
    const toNote = h("span", { class: "w-note" });
    const refreshToNote = () => {
      const c = this.wCheckAddress(asset.chain, to.value);
      const contact = c.ok ? WalletStore.contactFor(asset.chain, to.value.trim()) : null;
      toNote.textContent = contact ? `Контакт: ${contact.name} · ${c.note}` : c.note;
      toNote.className = `w-note${c.ok ? (c.danger ? " danger" : " ok") : to.value.trim() ? " bad" : ""}`;
      return c;
    };

    // Сумма
    const amount = h("input", { class: "w-input mono", type: "text", inputmode: "decimal", placeholder: "0", value: s.amount });
    const maxLink = h("button", { class: "w-link small", type: "button" }, pending ? "Всё" : `Всё · ${asset.amount}`);
    const amountNote = h("span", { class: "w-note" });
    const refreshAmountNote = () => {
      const raw = this.wParseAmount(amount.value, decimals);
      if (!amount.value.trim()) {
        amountNote.textContent = "";
        amountNote.className = "w-note";
        return null;
      }
      if (raw === null) {
        amountNote.textContent = `Число, не больше ${decimals} знаков после точки`;
        amountNote.className = "w-note bad";
        return null;
      }
      if (available === null) {
        amountNote.textContent = "Ждём баланс…";
        amountNote.className = "w-note";
        return null;
      }
      if (raw > available) {
        amountNote.textContent = `Больше доступного (${asset.amount})`;
        amountNote.className = "w-note bad";
        return null;
      }
      amountNote.textContent = price ? `≈ ${this.wFmtUsd(parseFloat(amount.value) * price)}` : "";
      amountNote.className = "w-note";
      return raw;
    };

    // Комиссия
    const feeBox = h("div", { class: "w-fee" });
    const warn = h("div", { class: "w-warn", hidden: "true" });
    const submit = this.wButton("Проверить и отправить", "primary", () => this.walletSendConfirm(asset));
    submit.disabled = true;

    let feeTimer = null;
    const update = (recalc = true) => {
      s.to = to.value.trim();
      s.amount = amount.value.trim();
      const c = refreshToNote();
      const raw = refreshAmountNote();
      submit.disabled = true;
      if (recalc) {
        clearTimeout(feeTimer);
        feeTimer = setTimeout(async () => {
          if (!c.ok || raw === null) {
            feeBox.replaceChildren(this.wFeeRows(null));
            warn.hidden = true;
            return;
          }
          const seq = (s.feeSeq = (s.feeSeq || 0) + 1);
          feeBox.replaceChildren(this.wFeeRows({ loading: true }));
          try {
            const fee = await this.walletEstimateFee(asset, s.to, raw);
            if (seq !== s.feeSeq) {
              return;
            }
            s.fee = fee;
            s.raw = raw.toString();
            feeBox.replaceChildren(this.wFeeRows(fee));
            warn.hidden = !fee.warning;
            warn.textContent = fee.warning || "";
            submit.disabled = !fee.ok;
          } catch (e) {
            if (seq !== s.feeSeq) {
              return;
            }
            feeBox.replaceChildren(this.wFeeRows({ error: e.message }));
          }
        }, 350);
      }
    };
    to.addEventListener("input", () => update());
    amount.addEventListener("input", () => update());
    [to, amount].forEach(i => i.addEventListener("keydown", e => e.stopPropagation()));
    maxLink.addEventListener("click", async () => {
      if (available === null) {
        return;
      }
      // для нативной монеты вычитаем комиссию
      let raw = available;
      if (asset.native && this.wCheckAddress(asset.chain, to.value).ok) {
        try {
          const est = await this.walletEstimateFee(asset, to.value.trim(), available, { max: true });
          raw = est.maxSendable ?? available;
        } catch (e) {}
      } else if (asset.native) {
        this.notice("Сначала укажите адрес: максимум зависит от комиссии");
        return;
      }
      amount.value = this.wFmt(raw < 0n ? 0n : raw, decimals, decimals);
      update();
    });
    if (s.to || s.amount) {
      setTimeout(() => update(), 0);
    } else {
      feeBox.append(this.wFeeRows(null));
    }

    return h("div", { class: "w-send" }, null, [
      h("div", { class: "w-flow-head" }, null, [h("b", { class: "w-title" }, "Отправить"), back]),
      h("label", { class: "w-field" }, null, [h("span", {}, "Актив"), assetBtn]),
      h("label", { class: "w-field" }, null, [h("span", {}, "Кому"), h("div", { class: "w-input-row" }, null, [to, book, paste]), toNote]),
      h("label", { class: "w-field" }, null, [h("span", { class: "w-field-head" }, null, [h("span", {}, "Сумма"), maxLink]), h("div", { class: "w-input-row" }, null, [to && amount, h("span", { class: "w-input-suffix" }, asset.symbol)]), amountNote]),
      feeBox,
      warn,
      h("span", { class: "spacer" }),
      submit,
      h("p", { class: "w-hint" }, `С адреса ${account.name} · ${this.shortAddr(account.addresses[asset.chain])}`),
    ]);
  },

  wFeeRows(fee) {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const row = (k, v, cls = "") => h("div", { class: `w-fee-row ${cls}`.trim() }, null, [h("span", {}, k), h("span", { class: "mono" }, v)]);
    if (!fee) {
      return row("Комиссия сети", "укажите адрес и сумму", "muted");
    }
    if (fee.loading) {
      return row("Комиссия сети", "считаем…", "muted");
    }
    if (fee.error) {
      return row("Комиссия сети", `не удалось: ${fee.error}`, "bad");
    }
    const wrap = h("div", {});
    for (const r of fee.rows) {
      wrap.append(row(r[0], r[1], r[2] || ""));
    }
    return wrap;
  },

  /* ---- Оценка комиссии ---------------------------------------------------- */

  /** @returns {{ ok, rows:[k,v,cls][], warning, fee: BigInt(в нативных), plan }} */
  async walletEstimateFee(asset, to, raw, { max = false } = {}) {
    const { WalletStore, CHAINS } = this.walletStore();
    const { WalletSigner } = this.walletSigner();
    const chain = CHAINS[asset.chain];
    const account = WalletStore.activeAccount;
    const from = account.addresses[asset.chain];
    const prices = this.wallet.prices || {};
    const nativePrice = prices[chain.symbol] || 0;
    const nativeBal = this.wallet.balances[`${asset.chain}:${from}`];
    const nativeRaw = nativeBal ? this.wParseAmount(nativeBal.native, chain.decimals) ?? 0n : 0n;
    const usd = (feeRaw, decimals = chain.decimals) => (nativePrice ? ` · ${this.wFmtUsd(WalletStore.toNumber(feeRaw, decimals) * nativePrice)}` : "");
    const fmtFee = (feeRaw, decimals = chain.decimals) => `${this.wFmt(feeRaw, decimals, 8)} ${chain.symbol}${usd(feeRaw, decimals)}`;
    const out = { ok: true, rows: [], warning: "", plan: { chain: asset.chain, from, to, raw: raw.toString(), asset, walletId: WalletStore.activeWallet.id, index: account.index } };

    if (chain.kind === "evm") {
      const tx = asset.native
        ? { to, value: "0x" + raw.toString(16), data: "0x" }
        : { to: asset.token.address, value: "0x0", data: "0xa9059cbb" + to.slice(2).toLowerCase().padStart(64, "0") + raw.toString(16).padStart(64, "0") };
      let est;
      try {
        est = await WalletSigner.evmPrepare(asset.chain, tx, from);
      } catch (e) {
        if (asset.native && /insufficient|exceeds|balance/i.test(e.message)) {
          // оценка газа не прошла из-за суммы: считаем перевод монеты как 21000
          est = await WalletSigner.evmPrepare(asset.chain, { ...tx, gas: "0x5208" }, from);
        } else {
          throw e;
        }
      }
      out.plan.prepared = est.prepared;
      out.fee = est.fee;
      out.maxSendable = nativeRaw - est.fee;
      const need = asset.native ? raw + est.fee : est.fee;
      out.rows.push(["Комиссия сети", `≈ ${fmtFee(est.feeLikely)}`], ["Максимум", fmtFee(est.fee), "muted"], ["Газ", `${est.prepared.gasLimit} · базовая ${this.wFmt(est.baseFee, 9, 3)} gwei`, "muted"]);
      out.rows.push([`${chain.symbol} на комиссию`, `${this.wFmt(nativeRaw, chain.decimals, 6)} ${chain.symbol}${nativeRaw >= need ? "" : " · не хватает"}`, nativeRaw >= need ? "ok" : "bad"]);
      if (nativeRaw < need) {
        out.ok = false;
        out.warning = asset.native
          ? `Сумма вместе с комиссией больше баланса. Доступно к отправке около ${this.wFmt(out.maxSendable > 0n ? out.maxSendable : 0n, chain.decimals, 6)} ${chain.symbol}.`
          : `Для перевода ${asset.symbol} в сети ${chain.name} нужна комиссия в ${chain.symbol}. Пополните адрес примерно на ${this.wFmt(est.fee - nativeRaw, chain.decimals, 6)} ${chain.symbol}.`;
      }
      return out;
    }

    if (chain.kind === "btc") {
      const [utxos, fees] = await Promise.all([WalletStore.rpc("bitcoin", null, `/address/${from}/utxo`), WalletStore.rpc("bitcoin", null, "/v1/fees/recommended")]);
      const suggested = Number(fees.halfHourFee || fees.hourFee || 2);
      const rate = BigInt(Math.min(500, Math.max(1, Math.round(suggested))));
      if (suggested > 500) {
        out.warning = `Нода предлагает ставку ${suggested} сат/vB: ограничили до 500. Проверьте сеть позже.`;
      }
      const sorted = [...utxos].sort((a, b) => b.value - a.value);
      const total = sorted.reduce((n, u) => n + BigInt(u.value), 0n);
      const vsize = (ins, outs) => BigInt(Math.ceil(10.5 + 68 * ins + 31 * outs));
      let chosen = [];
      let sum = 0n;
      let fee = 0n;
      if (max) {
        chosen = sorted;
        fee = vsize(chosen.length, 1) * rate;
        out.maxSendable = total - fee;
        out.fee = fee;
        out.rows.push(["Комиссия сети", fmtFee(fee)]);
        return out;
      }
      for (const u of sorted) {
        chosen.push(u);
        sum += BigInt(u.value);
        fee = vsize(chosen.length, 2) * rate;
        if (sum >= raw + fee) {
          break;
        }
      }
      const change = sum - raw - fee;
      const noChange = change < 546n;
      if (noChange) {
        fee = vsize(chosen.length, 1) * rate;
      }
      out.fee = fee;
      out.plan.utxos = chosen;
      out.plan.rate = rate.toString();
      out.plan.change = noChange ? 0n : change;
      out.maxSendable = total - vsize(sorted.length, 1) * rate;
      out.rows.push(["Комиссия сети", `${fmtFee(fee)} · ${rate} сат/vB`], ["Входов", `${chosen.length} из ${sorted.length}`, "muted"]);
      if (sum < raw + fee) {
        out.ok = false;
        out.warning = `Не хватает на комиссию. Доступно к отправке около ${this.wFmt(out.maxSendable > 0n ? out.maxSendable : 0n, 8, 8)} BTC.`;
        out.rows.push(["BTC на комиссию", `${this.wFmt(total, 8, 8)} BTC · не хватает`, "bad"]);
      }
      if (utxos.some(u => !u.status?.confirmed)) {
        out.warning ||= "Часть средств ещё не подтверждена: перевод может занять больше времени.";
      }
      if (out.ok && raw > 0n && fee * 10n > raw) {
        out.warning = `Комиссия больше 10% от суммы (${this.wFmt(fee, 8, 8)} BTC). Возможно, стоит отправить больше или подождать.`;
      }
      return out;
    }

    if (chain.kind === "sol") {
      const lamportsPerSig = 5000n;
      let rent = 0n;
      let plan = {};
      if (!asset.native) {
        const mintInfo = await WalletStore.rpc("solana", { jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [asset.token.mint, { encoding: "base64" }] });
        const program = mintInfo.result?.value?.owner || "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
        const S = this.walletSigner().WalletSigner;
        const fromAta = S.solAta(from, asset.token.mint, program);
        const toAta = S.solAta(to, asset.token.mint, program);
        const toInfo = await WalletStore.rpc("solana", { jsonrpc: "2.0", id: 2, method: "getAccountInfo", params: [toAta, { encoding: "base64" }] });
        const createAta = !toInfo.result?.value;
        if (createAta) {
          const r = await WalletStore.rpc("solana", { jsonrpc: "2.0", id: 3, method: "getMinimumBalanceForRentExemption", params: [165] });
          rent = BigInt(r.result || 2039280);
        }
        plan = { program, fromAta, toAta, createAta, decimals: asset.token.decimals };
        out.rows.push(["Счёт получателя", createAta ? `создаём · ${this.wFmt(rent, 9, 6)} SOL аренда` : "уже есть", createAta ? "" : "ok"]);
      }
      const fee = lamportsPerSig + rent;
      out.fee = fee;
      out.plan.sol = plan;
      out.maxSendable = nativeRaw - lamportsPerSig;
      const need = asset.native ? raw + fee : fee;
      out.rows.unshift(["Комиссия сети", fmtFee(lamportsPerSig)]);
      out.rows.push(["SOL на комиссию", `${this.wFmt(nativeRaw, 9, 6)} SOL${nativeRaw >= need ? "" : " · не хватает"}`, nativeRaw >= need ? "ok" : "bad"]);
      if (nativeRaw < need) {
        out.ok = false;
        out.warning = asset.native ? "Сумма вместе с комиссией больше баланса SOL." : `Для перевода ${asset.symbol} нужны SOL на комиссию${rent ? " и аренду счёта получателя" : ""}. Пополните адрес примерно на ${this.wFmt(fee - nativeRaw, 9, 6)} SOL.`;
      }
      return out;
    }

    if (chain.kind === "tron") {
      const S = this.walletSigner().WalletSigner;
      // параметры сети меняются редко: кэш на час, чтобы не упираться в лимиты публичных нод
      const paramsP = this._tronParams && Date.now() - this._tronParams.at < 3600000
        ? Promise.resolve(this._tronParams.data)
        : S.tronPost("/wallet/getchainparameters", {}).then(d => {
          this._tronParams = { at: Date.now(), data: d };
          return d;
        }).catch(() => ({ chainParameter: [] }));
      let resourceFailed = false;
      const [res, params, toAcc] = await Promise.all([
        S.tronPost("/wallet/getaccountresource", { address: from, visible: true }).catch(() => {
          resourceFailed = true;
          return {};
        }),
        paramsP,
        S.tronPost("/wallet/getaccount", { address: to, visible: true }).catch(() => null),
      ]);
      const param = key => BigInt(params.chainParameter?.find(p => p.key === key)?.value ?? 0);
      const bandwidthPrice = param("getTransactionFee") || 1000n; // sun за байт
      const energyPrice = param("getEnergyFee") || 420n; // sun за единицу энергии
      const createFee = (param("getCreateNewAccountFeeInSystemContract") || 1000000n) + (param("getCreateAccountFee") || 100000n);
      const freeNet = BigInt((res.freeNetLimit || 0) - (res.freeNetUsed || 0) + (res.NetLimit || 0) - (res.NetUsed || 0));
      const freeEnergy = BigInt((res.EnergyLimit || 0) - (res.EnergyUsed || 0));
      const recipientNew = toAcc ? !toAcc.address : false;
      let fee = 0n;
      if (asset.native) {
        const bytes = 270n;
        const netFee = freeNet >= bytes ? 0n : bytes * bandwidthPrice;
        fee = netFee + (recipientNew ? createFee : 0n);
        out.plan.tron = { kind: "trx" };
        out.rows.push(["Комиссия сети", fee ? `${resourceFailed ? "до " : ""}${fmtFee(fee)}` : "0 TRX · за счёт bandwidth"], ["Bandwidth", resourceFailed ? "нода не ответила · считаем без бесплатной квоты" : `${freeNet} свободно · нужно ${bytes}`, "muted"]);
        if (recipientNew) {
          out.rows.push(["Активация адреса", `${this.wFmt(createFee, 6, 2)} TRX · адрес ещё не активирован`, "muted"]);
        } else if (!toAcc) {
          out.rows.push(["Активация адреса", `не удалось проверить · +${this.wFmt(createFee, 6, 2)} TRX, если адрес новый`, "muted"]);
        }
      } else {
        const contract = asset.token.address;
        const parameter = S.abiEncodeParam("address", to) + S.abiEncodeParam("uint256", raw);
        let energy;
        let energyGuess = false;
        try {
          energy = await S.tronEstimateEnergy(from, contract, "transfer(address,uint256)", parameter);
        } catch (e) {
          if (!/HTTP|таймаут|недоступна/.test(e.message)) {
            throw e; // контракт отклонил вызов: это не сетевая ошибка
          }
          energy = 65000n; // типичный transfer USDT: нода не ответила, берём верхнюю оценку
          energyGuess = true;
        }
        const bytes = 350n;
        const energyFee = (energy > freeEnergy ? energy - freeEnergy : 0n) * energyPrice;
        const netFee = freeNet >= bytes ? 0n : bytes * bandwidthPrice;
        fee = energyFee + netFee;
        out.plan.tron = { kind: "trc20", contract, parameter, feeLimit: Number(energy * energyPrice * 15n / 10n) + 1000000 };
        out.rows.push(["Комиссия сети", `${energyGuess || resourceFailed ? "до" : "≈"} ${fmtFee(fee)}`], ["Энергия", energyGuess ? "нода не ответила · оценка сверху" : `${freeEnergy} из ${res.EnergyLimit || 0} · нужно ${energy}`, "muted"]);
      }
      out.fee = fee;
      out.maxSendable = nativeRaw - fee;
      const need = asset.native ? raw + fee : fee;
      out.rows.push(["TRX на комиссию", `${this.wFmt(nativeRaw, 6, 6)} TRX${nativeRaw >= need ? "" : " · не хватает"}`, nativeRaw >= need ? "ok" : "bad"]);
      if (nativeRaw < need) {
        out.ok = false;
        out.warning = asset.native
          ? "Сумма вместе с комиссией больше баланса TRX."
          : `Для перевода ${asset.symbol} TRC-20 нужны TRX на комиссию. Пополните адрес примерно на ${this.wFmt(fee - nativeRaw + 500000n, 6, 2)} TRX или выберите другую сеть.`;
      }
      return out;
    }
    throw new Error("Сеть не поддержана");
  },

  /* ---- Подтверждение и отправка ------------------------------------------ */

  walletSendConfirm(asset) {
    const { WalletStore, CHAINS } = this.walletStore();
    const s = this.wallet.send;
    const fee = s.fee;
    if (!fee?.ok) {
      return;
    }
    const chain = CHAINS[asset.chain];
    const account = WalletStore.activeAccount;
    const from = account.addresses[asset.chain];
    const decimals = asset.native ? chain.decimals : asset.token.decimals;
    const amountText = this.wFmt(BigInt(fee.plan.raw), decimals, decimals);
    const price = (this.wallet.prices || {})[asset.symbol] || 0;
    const feeRow = fee.rows.find(r => r[0] === "Комиссия сети");
    this.walletConfirm({
      title: "Подтверждение",
      amount: `${amountText} ${asset.symbol}`,
      usd: price ? parseFloat(amountText) * price : 0,
      amountNote: `${price ? `≈ ${this.wFmtUsd(parseFloat(amountText) * price)} · ` : ""}сеть ${chain.name}`,
      rows: [
        ["Откуда", `${account.name} · ${this.shortAddr(from)}`],
        ["Куда", WalletStore.contactFor(asset.chain, fee.plan.to) ? `${WalletStore.contactFor(asset.chain, fee.plan.to).name} · ${fee.plan.to}` : fee.plan.to, "mono"],
        ["Комиссия сети", feeRow ? feeRow[1] : "—"],
        ["Нода", this.hostOf(WalletStore.nodesFor(asset.chain).url)],
      ],
      warning: WalletStore.contactFor(asset.chain, fee.plan.to) ? "Перевод необратим. Получатель из ваших контактов. Подпись выполняется локально, фраза не покидает устройство." : "Перевод необратим. Получатель не в контактах: проверьте первые и последние символы адреса. Подпись выполняется локально, фраза не покидает устройство.",
      okLabel: "Подписать и отправить",
      onSign: async pass => {
        const hash = await this.walletExecuteSend(asset, fee.plan, pass);
        await WalletStore.addActivity({ chain: asset.chain, hash, to: fee.plan.to, amount: amountText, symbol: asset.symbol, from, kind: "send" });
        this.wallet.send = null;
        this.wallet.balances[`${asset.chain}:${from}`] && (this.wallet.balances[`${asset.chain}:${from}`].at = 0);
        this.walletGo("main");
        this.walletToast(`Отправлено ${amountText} ${asset.symbol}`, this.wTxUrl(asset.chain, hash));
      },
    });
  },

  async walletExecuteSend(asset, plan, pass) {
    const { WalletStore, CHAINS } = this.walletStore();
    const { WalletSigner } = this.walletSigner();
    const C = ChromeUtils.importESModule("chrome://browser/content/tabora/wallet/vendor/crypto.sys.mjs");
    const chain = CHAINS[asset.chain];
    // подписываем тем кошельком и счётом, для которых строился план, а не «активным на момент нажатия»
    const wallet = WalletStore.wallets.find(w => w.id === plan.walletId) || WalletStore.activeWallet;
    const account = wallet.accounts.find(a => a.index === plan.index) || WalletStore.activeAccount;
    if (account.addresses[asset.chain] !== plan.from) {
      throw new Error("Счёт отправителя изменился: пересчитайте перевод");
    }
    const raw = BigInt(plan.raw);
    return WalletSigner.withKey(wallet.id, account.index, asset.chain, async priv => {
      if (chain.kind === "evm") {
        const signed = WalletSigner.evmSign(plan.prepared, priv);
        return WalletSigner.evmSend(asset.chain, signed.raw);
      }
      if (chain.kind === "btc") {
        const pub = C.secp256k1.getPublicKey(priv, true);
        const script = C.btc.p2wpkh(pub).script;
        const tx = new C.btc.Transaction();
        for (const u of plan.utxos) {
          tx.addInput({ txid: u.txid, index: u.vout, witnessUtxo: { script, amount: BigInt(u.value) } });
        }
        tx.addOutputAddress(plan.to, raw);
        if (plan.change && BigInt(plan.change) > 0n) {
          tx.addOutputAddress(plan.from, BigInt(plan.change));
        }
        tx.sign(priv);
        tx.finalize();
        const node = WalletStore.nodesFor("bitcoin").url;
        const res = await fetch(node + "/tx", { method: "POST", body: tx.hex });
        const text = await res.text();
        if (!res.ok) {
          throw new Error(text || `HTTP ${res.status}`);
        }
        return text.trim();
      }
      if (chain.kind === "sol") {
        const blockhash = await WalletSigner.solLatestBlockhash();
        const bytes = asset.native
          ? WalletSigner.solBuildTransfer(plan.from, plan.to, raw, blockhash)
          : WalletSigner.solBuildTokenTransfer({ from: plan.from, to: plan.to, mint: asset.token.mint, amount: raw, blockhash, ...plan.sol });
        const signed = WalletSigner.solSignTransaction(bytes, priv, plan.from);
        return WalletSigner.solSend(signed);
      }
      if (chain.kind === "tron") {
        // транзакция собирается локально; у ноды берём только ссылку на блок
        const tx = plan.tron.kind === "trx"
          ? await WalletSigner.tronBuildSendTrx(plan.to, raw, plan.from)
          : await WalletSigner.tronBuildRaw({ kind: "trigger", owner: plan.from, contractAddress: plan.tron.contract, data: "a9059cbb" + plan.tron.parameter, callValue: 0 }, { feeLimit: plan.tron.feeLimit });
        // контроль: то, что подписываем, совпадает с тем, что ввёл пользователь
        const check = WalletSigner.tronDecodeRaw(tx.raw_data_hex).contracts[0];
        const okTarget = plan.tron.kind === "trx" ? check.to === plan.to && check.amount === raw : check.contractAddress === plan.tron.contract && check.data.toLowerCase() === ("0xa9059cbb" + plan.tron.parameter).toLowerCase();
        if (!check || check.owner !== plan.from || !okTarget) {
          throw new Error("Собранная транзакция не совпадает с введёнными данными");
        }
        const signed = WalletSigner.tronSignTx(tx, priv);
        const res = await WalletSigner.tronBroadcast(signed);
        return res.txid;
      }
      throw new Error("Сеть не поддержана");
    });
  },

  /** Общий лист подтверждения с паролем. opts: title, origin{host,secure,icon}, amount, amountNote, summary, rows, warning, details, extra(node), okLabel, onSign(pass). */
  walletConfirm(opts) {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { WalletStore } = this.walletStore();
    return new Promise((resolve, reject) => {
      const pass = this.wField("Пароль кошелька", { type: "password", autocomplete: "off" });
      const err = h("div", { class: "w-error", hidden: "true" });
      let done = false;
      // Защита от кликджекинга и перехвата ввода: кнопка включается через паузу,
      // клики, начатые до показа, игнорируются, Enter работает только после ввода в этом листе.
      const ARM_MS = opts.fromSite ? 900 : 500;
      const needPass = !opts.noPassword && WalletStore.signPasswordNeeded(opts.usd || 0, !!opts.danger);
      const shownAt = Date.now();
      let armed = false;
      let typedHere = false;
      let finish = (fn, v) => {
        if (!done) {
          done = true;
          box.remove();
          fn(v);
        }
      };
      const ok = this.wButton(opts.okLabel || "Подписать", "primary", async e => {
        if (!armed || Date.now() - shownAt < ARM_MS) {
          return;
        }
        if (e && e.detail === 0 && needPass && !typedHere) {
          return; // Enter без ввода пароля в этом листе
        }
        if (opts.guard && !opts.guard.alive()) {
          finish(reject, Object.assign(new Error("Страница запроса закрыта или ушла: запрос отклонён"), { code: 4001 }));
          return;
        }
        ok.disabled = true;
        cancel.disabled = true;
        ok.classList.add("loading");
        try {
          if (needPass) {
            await WalletStore.verifyPassword(pass.input.value); // проверка здесь, обработчики паролю доверяют
          }
          const result = await opts.onSign(pass.input.value);
          finish(resolve, result);
        } catch (e) {
          err.textContent = e.message || String(e);
          err.hidden = false;
          ok.disabled = false;
          cancel.disabled = false;
          ok.classList.remove("loading");
        }
      });
      const cancel = this.wButton(opts.cancelLabel || "Отмена", "ghost", () => finish(reject, Object.assign(new Error("Отклонено пользователем"), { code: 4001 })));
      const rows = (opts.rows || []).map(([k, v, cls]) => h("div", { class: "w-fee-row" }, null, [h("span", {}, k), h("span", { class: cls || "" }, v)]));
      const card = h("div", { class: "w-sheet-card w-confirm" }, null, [
        h("div", { class: "w-flow-head" }, null, [h("b", {}, opts.title || "Подтверждение"), opts.badge ? h("span", { class: "w-chip" }, opts.badge) : null].filter(Boolean)),
        opts.fromSite && WalletStore.phishMark ? h("div", { class: "w-mark", title: "Знак подлинности: его знает только ваш кошелёк, сайт подделать не может" }, null, [h("span", {}, WalletStore.phishMark), h("i", {}, "настоящий лист Tabora")]) : null,
        opts.onDisconnect ? (() => { const b = h("button", { class: "w-link small w-right", type: "button" }, "Отключить сайт и отклонить"); b.addEventListener("click", async () => { await opts.onDisconnect(); finish(reject, Object.assign(new Error("Сайт отключён"), { code: 4001 })); }); return b; })() : null,
        opts.origin ? this.wOriginCard(opts.origin) : null,
        opts.amount ? h("div", { class: "w-confirm-amount" }, null, [h("span", {}, opts.amountLabel || "Отправляете"), h("b", { class: "mono" }, opts.amount), h("span", {}, opts.amountNote || "")]) : null,
        opts.summary ? h("div", { class: "w-confirm-summary" }, null, [h("span", { class: "w-label" }, "Что произойдёт"), ...[].concat(opts.summary).map(t => h("div", { class: "w-summary-line" }, t))]) : null,
        rows.length ? h("div", { class: "w-fee" }, null, rows) : null,
        opts.extra || null,
        opts.warning ? h("div", { class: `w-warn${opts.danger ? " danger" : ""}` }, opts.warning) : null,
        opts.details ? h("details", { class: "w-details" }, null, [h("summary", {}, opts.detailsLabel || "Данные вызова"), h("pre", { class: "mono" }, opts.details)]) : null,
        opts.noPassword ? null : WalletStore.passwordless ? h("p", { class: "w-badge-danger" }, "Без пароля · подпись без подтверждения паролем") : needPass ? pass.wrap : h("p", { class: "w-hint" }, "Пароль не нужен: он введён при разблокировке. Крупные суммы и опасные операции спросят его снова."),
        err,
        h("div", { class: "w-actions" }, null, [cancel, ok]),
      ].filter(Boolean));
      const box = h("div", { class: "w-sheet" }, null, [card]);
      ok.disabled = true;
      ok.classList.add("arming");
      let downAt = 0;
      ok.addEventListener("mousedown", () => { downAt = Date.now(); });
      ok.addEventListener("click", e => {
        if (e.detail !== 0 && (downAt === 0 || downAt - shownAt < ARM_MS)) {
          e.stopImmediatePropagation(); // клик начался до того, как лист «вооружился»
        }
      }, true);
      let moved = !opts.fromSite || needPass;
      setTimeout(() => {
        if (!done) {
          armed = true;
          ok.disabled = !moved;
          ok.classList.remove("arming");
        }
      }, ARM_MS);
      if (!moved) {
        // без пароля: нужно реальное движение указателя внутри листа, иначе «кликер» подпишет вслепую
        card.addEventListener("mousemove", () => {
          moved = true;
          if (armed && !done) {
            ok.disabled = false;
          }
        }, { once: true });
      }
      if (opts.fromSite) {
        if (!this.drawer.open || this.drawer.section !== "wallet") {
          this.openDrawer("wallet"); // экран пользователя не сбрасываем: лист ложится поверх
        }
        // лист сайта живёт не дольше 2 минут, исчезает при блокировке кошелька,
        // при уходе с вкладки запроса и при навигации/закрытии страницы-отправителя
        const ttl = setTimeout(() => finish(reject, Object.assign(new Error("Время ожидания истекло"), { code: 4001 })), 120000);
        const obs = (s, t, what) => {
          if (what === "locked") {
            finish(reject, Object.assign(new Error("Кошелёк заблокирован"), { code: 4001 }));
          }
        };
        Services.obs.addObserver(obs, WalletStore.TOPIC);
        const g = opts.guard;
        const onTab = () => {
          if (g?.tab && gBrowser.selectedTab !== g.tab) {
            finish(reject, Object.assign(new Error("Вкладка запроса переключена: запрос отклонён"), { code: 4001 }));
          }
        };
        gBrowser.tabContainer.addEventListener("TabSelect", onTab);
        const aliveTimer = setInterval(() => {
          if (g && !g.alive()) {
            finish(reject, Object.assign(new Error("Страница запроса закрыта или ушла: запрос отклонён"), { code: 4001 }));
          }
        }, 1000);
        const origFinish = finish;
        finish = (fn, v) => {
          clearTimeout(ttl);
          clearInterval(aliveTimer);
          gBrowser.tabContainer.removeEventListener("TabSelect", onTab);
          try {
            Services.obs.removeObserver(obs, WalletStore.TOPIC);
          } catch (e) {}
          origFinish(fn, v);
        };
      }
      pass.input.addEventListener("input", () => { typedHere = true; });
      pass.input.addEventListener("keydown", e => {
        e.stopPropagation();
        if (e.key === "Enter" && armed && (typedHere || !needPass)) {
          ok.click();
        }
      });
      this.wSheetShow(box);
      box._cancel = () => finish(reject, Object.assign(new Error("Отклонено"), { code: 4001 }));
      if (!opts.fromSite) {
        setTimeout(() => pass.input.focus(), 60);
      } else {
        // запрос сайта не забирает фокус у того, что пользователь делает сейчас
        document.activeElement?.blur?.();
      }
    });
  },

  /** Ждём, пока в панели не останется других листов (пароль, фраза, другой запрос). */
  async walletSheetFree() {
    const panel = () => this.drawer.el?.querySelector(".dpanel");
    for (let i = 0; i < 600; i++) {
      if (!panel()?.querySelector(".w-sheet")) {
        return;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    throw Object.assign(new Error("Кошелёк занят другим действием"), { code: -32002 });
  },

  wOriginCard(origin) {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const icon = h("span", { class: "w-origin-icon" }, null, [h("img", { src: `page-icon:${origin.url || "https://" + origin.host + "/"}`, alt: "" })]);
    icon.firstChild.addEventListener("error", () => icon.replaceChildren(h("b", {}, this.letterOf(origin.host))));
    return h("div", { class: "w-origin" }, null, [
      icon,
      h("div", { class: "w-origin-text" }, null, [h("b", {}, origin.host), h("span", {}, [origin.secure ? "HTTPS" : "без HTTPS · небезопасно", origin.topHost ? `во фрейме на ${origin.topHost}` : null, origin.note].filter(Boolean).join(" · "))]),
    ]);
  },

  walletToast(text, url) {
    this.notice(text);
    if (url) {
      setTimeout(() => this.notice("Открыть в обозревателе: правый клик по операции в «Истории»"), 2500);
    }
  },

  /* ---- История операций --------------------------------------------------- */

  /** Загрузка истории из сетей (кэш 60 с), затем перерисовка вкладки. */
  async walletLoadHistory(force = false) {
    const { WalletStore, CHAIN_ORDER } = this.walletStore();
    const w = this.wallet;
    const account = WalletStore.activeAccount;
    if (!account) {
      return;
    }
    const key = `${WalletStore.activeWallet.id}:${account.index}`;
    if (!force && w.history?.key === key && Date.now() - w.history.at < 60000) {
      return;
    }
    if (w.historyLoading) {
      return;
    }
    w.historyLoading = true;
    const hidden = new Set(WalletStore.data.settings?.hiddenChains || []);
    const prices = w.prices || (await WalletStore.prices());
    const results = await Promise.all(CHAIN_ORDER.filter(id => !hidden.has(id)).map(id => WalletStore.history(id, account.addresses[id], prices).catch(e => ({ items: [], hidden: 0, error: `${id}: ${e.message}` }))));
    w.history = { key, at: Date.now(), items: results.flatMap(r => r.items), hidden: results.reduce((n, r) => n + r.hidden, 0), errors: results.map(r => r.error).filter(Boolean) };
    w.historyLoading = false;
    if (this.drawer.open && this.drawer.section === "wallet" && w.tab === "activity" && w.view === "main") {
      this.renderDrawer();
    }
  },

  walletActivityList() {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { WalletStore, CHAINS } = this.walletStore();
    const w = this.wallet;
    const list = h("div", { class: "w-chains" });
    this.walletLoadHistory();
    const onchain = w.history?.items || [];
    const hashes = new Set(onchain.map(i => i.hash));
    const local = WalletStore.activity.filter(it => !it.hash || !hashes.has(it.hash)).map(it => ({ id: `local:${it.at}`, local: it, at: Date.parse(it.at), chain: it.chain }));
    const items = [...onchain, ...local].sort((a, b) => b.at - a.at).slice(0, 80);
    if (!w.history && !local.length) {
      list.append(h("div", { class: "w-empty" }, "Загружаем операции из сетей…"));
      return list;
    }
    if (!items.length) {
      list.append(h("div", { class: "w-empty" }, w.historyLoading ? "Загружаем операции из сетей…" : "Пока операций нет. Поступления появятся здесь и в уведомлении."));
    }
    // компактная дата: в строке истории рядом с ней должен поместиться адрес контрагента
    const when = ms => {
      const d = new Date(ms);
      const p = n => String(n).padStart(2, "0");
      return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
    };
    for (const it of items) {
      let row;
      if (it.local) {
        const l = it.local;
        const chain = CHAINS[l.chain];
        row = h("div", { class: "w-asset w-activity", style: `--c:${chain?.color || "#888"}` }, null, [
          h("span", { class: "w-coin" }, null, [chain?.logo ? h("img", { src: chain.logo, alt: "" }) : h("b", {}, "?")]),
          h("div", { class: "w-chain-text" }, null, [
            h("b", {}, l.kind === "sign" ? `Подпись · ${l.origin || ""}` : l.kind === "dapp" ? `${l.origin}` : `Отправка ${l.symbol}`),
            h("span", { class: "w-sub-line" }, `${when(it.at)} · ${l.hash ? this.shortAddr(l.hash, 5, 4) : l.note || ""}`),
          ]),
          h("div", { class: "w-chain-bal" }, null, [h("b", { class: "w-native", title: l.amount ? `−${l.amount} ${l.symbol || ""}` : "" }, l.amount ? `−${this.shortAmount(l.amount)}` : ""), h("span", { class: "w-usd" }, l.symbol && l.amount ? l.symbol : "")]),
        ]);
        if (l.hash) {
          this.wActivityMenu(row, l.chain, l.hash);
        }
      } else {
        const chain = CHAINS[it.chain];
        const title = it.call ? `${it.call} · ${it.chainName}` : it.dir === "in" ? `Получено ${it.symbol}` : it.dir === "self" ? `Перевод себе ${it.symbol}` : `Отправка ${it.symbol}`;
        const sign = it.dir === "in" ? "+" : it.dir === "self" ? "" : "−";
        row = h("div", { class: `w-asset w-activity ${it.dir === "in" ? "in" : ""} ${it.status !== "ok" ? "muted" : ""}`.trim(), style: `--c:${chain?.color || "#888"}` }, null, [
          // значок сети только для токенов: у родной монеты он повторял бы большой логотип
          h("span", { class: "w-coin" }, null, [h("img", { src: it.logo, alt: "" }), it.chainLogo && it.chainLogo !== it.logo ? h("i", { class: "w-coin-chain" }, null, [h("img", { src: it.chainLogo, alt: "" })]) : null].filter(Boolean)),
          h("div", { class: "w-chain-text" }, null, [
            h("b", {}, title),
            h("span", { class: "w-sub-line" }, `${when(it.at)} · ${it.status === "pending" ? "ожидает · " : it.status === "failed" ? "ошибка · " : ""}${it.counterparty ? WalletStore.contactFor(it.chain, it.counterparty)?.name || this.shortAddr(it.counterparty, 5, 4) : this.shortAddr(it.hash, 5, 4)}`),
          ]),
          h("div", { class: "w-chain-bal" }, null, [
            h("b", { class: `w-native${this.shortAmount(it.amount).length > 6 ? " long" : ""}`, title: `${sign}${it.amount} ${it.symbol}` }, it.call && it.amount === "0" ? "" : `${sign}${this.shortAmount(it.amount)}`),
            h("span", { class: "w-usd" }, it.usd !== null && it.usd >= 0.01 ? this.wFmtUsd(it.usd) : it.symbol),
          ]),
        ]);
        this.wActivityMenu(row, it.chain, it.hash, it.counterparty);
      }
      list.append(row);
    }
    if (w.history?.hidden) {
      list.append(h("div", { class: "w-hint w-center" }, `Скрыто подозрительных операций: ${w.history.hidden} (пыль, неизвестные токены, нулевые переводы)`));
    }
    if (w.history?.errors?.length) {
      list.append(h("div", { class: "w-hint w-center" }, `Нет связи: ${w.history.errors.map(e => e.split(":")[0]).join(", ")}`));
    }
    const refresh = h("button", { class: "w-link", type: "button" }, w.historyLoading ? "Обновляем…" : "Обновить историю");
    refresh.disabled = !!w.historyLoading;
    refresh.addEventListener("click", () => {
      this.walletLoadHistory(true);
      this.renderDrawer();
    });
    list.append(h("div", { class: "w-zero-toggle" }, null, [refresh]));
    return list;
  },

  wActivityMenu(row, chain, hash, counterparty = null) {
    const { WalletStore } = this.walletStore();
    if (counterparty && !this.wCheckAddress(chain, counterparty).ok) {
      counterparty = null;
    }
    row.addEventListener("click", () => this.openInSpace(this.wTxUrl(chain, hash), true));
    row.addEventListener("contextmenu", e => {
      e.preventDefault();
      const items = [
        { label: "Открыть в обозревателе", run: () => this.openInSpace(this.wTxUrl(chain, hash), true) },
        { label: "Копировать хеш", run: () => this.copyText(hash, "Хеш скопирован") },
      ];
      if (counterparty) {
        const known = WalletStore.contactFor(chain, counterparty);
        items.push({ separator: true }, { label: "Копировать адрес контрагента", run: () => this.copyText(counterparty, "Адрес скопирован") });
        items.push(known ? { label: `Контакт: ${known.name}`, run: () => this.walletContactSheet(known) } : { label: "Сохранить в контакты…", run: () => this.walletContactSheet({ addresses: { [WalletStore.contactKey(chain)]: counterparty } }) });
      }
      this.showMenu(items, e.clientX, e.clientY);
    });
  },

  /* ---- Контакты ---------------------------------------------------------- */

  CONTACT_FIELDS: [["evm", "EVM (Ethereum, Base, Arbitrum, Polygon)", "ethereum"], ["bitcoin", "Bitcoin", "bitcoin"], ["solana", "Solana", "solana"], ["tron", "TRON", "tron"]],

  /** Лист добавления/редактирования контакта. contact: { id?, name?, addresses?, note? } */
  walletContactSheet(contact = {}) {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { WalletStore } = this.walletStore();
    const name = this.wField("Имя", { type: "text", value: contact.name || "", placeholder: "Например, Биржа или Алиса", maxlength: "40" });
    const fields = this.CONTACT_FIELDS.map(([key, label, chainId]) => {
      const f = this.wField(label, { type: "text", class: "w-input mono", value: contact.addresses?.[key] || "", spellcheck: "false", autocomplete: "off" });
      const note = h("span", { class: "w-note" });
      const check = () => {
        const v = f.input.value.trim();
        if (!v) {
          note.textContent = "";
          note.className = "w-note";
          return true;
        }
        const c = this.wCheckAddress(chainId, v);
        note.textContent = c.ok ? "" : c.note;
        note.className = `w-note${c.ok ? " ok" : " bad"}`;
        return c.ok;
      };
      f.input.addEventListener("input", check);
      f.wrap.append(note);
      return { key, f, check };
    });
    const err = h("div", { class: "w-error", hidden: "true" });
    const ok = this.wButton(contact.id ? "Сохранить" : "Добавить", "primary", async () => {
      if (!fields.every(x => x.check())) {
        err.textContent = "Проверьте адреса";
        err.hidden = false;
        return;
      }
      const addresses = Object.fromEntries(fields.map(x => [x.key, x.f.input.value.trim()]));
      try {
        if (contact.id) {
          await WalletStore.updateContact(contact.id, { name: name.input.value, addresses });
        } else {
          await WalletStore.addContact({ name: name.input.value, addresses });
        }
        box.remove();
        this.notice(contact.id ? "Контакт обновлён" : "Контакт добавлен");
        this.renderDrawer();
      } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
      }
    });
    const cancel = this.wButton("Отмена", "ghost", () => box.remove());
    const actions = [cancel, ok];
    if (contact.id) {
      actions.unshift(this.wButton("Удалить", "ghost danger small", async () => {
        await WalletStore.removeContact(contact.id);
        box.remove();
        this.renderDrawer();
      }), h("span", { class: "spacer" }));
    }
    const box = h("div", { class: "w-sheet" }, null, [h("div", { class: "w-sheet-card w-confirm" }, null, [h("b", {}, contact.id ? "Контакт" : "Новый контакт"), name.wrap, ...fields.map(x => x.f.wrap), err, h("div", { class: "w-actions" }, null, actions)])]);
    box.querySelectorAll("input").forEach(i => i.addEventListener("keydown", e => e.stopPropagation()));
    this.wSheetShow(box);
    setTimeout(() => (contact.name ? fields[0].f.input : name.input).focus(), 60);
  },

  /** Карточка «Контакты» в настройках. */
  walletContactsCard() {
    const h = (t, a, x, c) => this.html(t, a, x, c);
    const { WalletStore } = this.walletStore();
    const add = this.iconButton("", "Добавить контакт", ["M12 5v14", "M5 12h14"], () => this.walletContactSheet(), 13);
    const card = h("div", { class: "w-group" }, null, [h("div", { class: "w-group-head" }, null, [h("b", { class: "w-group-title" }, "Контакты"), add])]);
    if (!WalletStore.contacts.length) {
      card.append(h("p", { class: "w-hint" }, "Сохраняйте адреса получателей: на экране отправки их можно выбрать из списка, а в истории будут видны имена."));
      return card;
    }
    const labels = { evm: "EVM", bitcoin: "BTC", solana: "SOL", tron: "TRON" };
    for (const c of WalletStore.contacts) {
      const row = h("button", { class: "w-site w-contact", type: "button" }, null, [
        h("span", { class: "w-origin-icon small" }, null, [h("b", {}, this.letterOf(c.name))]),
        h("div", { class: "w-chain-text" }, null, [h("b", {}, c.name), h("span", { class: "w-sub-line" }, Object.keys(c.addresses).map(k => `${labels[k] || k} ${this.shortAddr(c.addresses[k])}`).join(" · "))]),
        this.wIcon(["m9 18 6-6-6-6"], 14, 2),
      ]);
      row.addEventListener("click", () => this.walletContactSheet(c));
      card.append(row);
    }
    return card;
  },

  /* ---- Фоновое наблюдение: поступления и уведомления ---------------------- */

  walletStartWatch() {
    if (this._walletWatch) {
      return;
    }
    const tick = () => this.walletWatchTick().catch(() => {});
    this._walletWatch = setInterval(tick, 60000);
    setTimeout(tick, 15000);
  },

  async walletWatchTick() {
    const { WalletStore, CHAINS, CHAIN_ORDER } = this.walletStore();
    await WalletStore.ready();
    const account = WalletStore.activeAccount;
    if (!WalletStore.exists || !account) {
      return;
    }
    const w = this.wallet;
    w.seen ||= {};
    const hidden = new Set(WalletStore.data.settings?.hiddenChains || []);
    const prices = await WalletStore.prices();
    w.prices = prices;
    w.pricesAt = Date.now();
    const incoming = [];
    await Promise.all(CHAIN_ORDER.filter(id => !hidden.has(id)).map(async id => {
      const address = account.addresses[id];
      let bal;
      try {
        bal = await WalletStore.balance(id, address);
      } catch (e) {
        return;
      }
      const key = `${id}:${address}`;
      const snapshot = { native: bal.native, tokens: Object.fromEntries((bal.tokens || []).map(t => [(t.address || t.mint || t.symbol).toLowerCase(), t.raw || "0"])) };
      const prev = w.seen[key];
      if (prev) {
        const chain = CHAINS[id];
        if (parseFloat(bal.native) > parseFloat(prev.native) + 1e-12) {
          const delta = parseFloat(bal.native) - parseFloat(prev.native);
          const usd = delta * (prices[chain.symbol] || 0);
          if (!prices[chain.symbol] || usd >= 0.01) {
            incoming.push({ chain, text: `${delta.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${chain.symbol}`, usd });
          }
        }
        for (const t of bal.tokens || []) {
          const before = BigInt(prev.tokens[(t.address || t.mint || t.symbol).toLowerCase()] || "0");
          const now = BigInt(t.raw || "0");
          if (now > before) {
            const delta = WalletStore.format(now - before, t.decimals, 6);
            const usd = t.custom ? 0 : parseFloat(delta) * (prices[t.symbol] || 0);
            const tkey = `${key}:${(t.address || t.mint || t.symbol).toLowerCase()}`;
            w.customNotified ||= {};
            // контракт своего токена может врать в balanceOf: уведомляем не чаще раза в 6 часов
            const throttled = t.custom && Date.now() - (w.customNotified[tkey] || 0) < 6 * 3600 * 1000;
            if ((t.custom && !throttled) || (!t.custom && usd >= 0.5)) {
              if (t.custom) {
                w.customNotified[tkey] = Date.now();
              }
              incoming.push({ chain, text: `${delta} ${t.symbol}${t.custom ? " (свой токен, без оценки)" : ""}`, usd });
            }
          }
        }
      }
      w.seen[key] = snapshot;
      w.balances[key] = { ...bal, at: Date.now() };
    }));
    if (incoming.length) {
      for (const it of incoming) {
        this.walletNotifyIncoming(it);
      }
      this.walletLoadHistory(true);
      this.updateWalletCard?.();
      if (this.drawer.open && this.drawer.section === "wallet" && !w.flow) {
        this.renderDrawer();
      }
    }
  },

  walletNotifyIncoming({ chain, text, usd }) {
    const title = `Пришло ${text}`;
    const body = `${chain.name}${usd ? ` · ${this.wFmtUsd(usd)}` : ""} · кошелёк Tabora`;
    this.notice(`${title} · ${chain.name}`);
    try {
      const alerts = Cc["@mozilla.org/alerts-service;1"].getService(Ci.nsIAlertsService);
      const alert = Cc["@mozilla.org/alert-notification;1"].createInstance(Ci.nsIAlertNotification);
      alert.init(`tabora-wallet-${Date.now()}`, chain.logo, title, body, true, "", null, null, null, null, Services.scriptSecurityManager.getSystemPrincipal(), false, false);
      alerts.showAlert(alert, (subject, topic) => {
        if (topic === "alertclickcallback") {
          window.focus();
          this.wallet.view = "main";
          this.wallet.tab = "activity";
          this.openDrawer("wallet");
        }
      });
    } catch (e) {
      console.warn("wallet alert", e);
    }
  },
});
