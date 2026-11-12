import { tt } from "chrome://tabora/content/i18n/I18n.sys.mjs";
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Подписи и отправка: EVM (EIP-1559, personal_sign, EIP-712), TRON (транзакции и сообщения),
 * Solana (сообщения и транзакции). Приватный ключ приходит из WalletStore.privateKeyFor
 * и обнуляется здесь сразу после подписи. */

const { setTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
const C = ChromeUtils.importESModule("chrome://tabora/content/wallet/vendor/crypto.sys.mjs");
const { WalletStore, CHAINS } = ChromeUtils.importESModule("chrome://tabora/content/wallet/WalletStore.sys.mjs");
const { sha256, keccak_256, secp256k1, ed25519, bytesToHex, hexToBytes, utf8ToBytes, base58, base58check, base64, EthTransaction, ethPersonal, ethSignTyped, ethDecodeData } = C;
const b58check = base58check(sha256);

const wipe = a => a?.fill?.(0);
const hex0x = b => "0x" + bytesToHex(b);
const toBig = v => (typeof v === "bigint" ? v : v === undefined || v === null || v === "" ? 0n : BigInt(v));

export const EVM_BY_CHAIN_ID = Object.fromEntries(Object.values(CHAINS).filter(c => c.kind === "evm").map(c => [c.chainId, c.id]));

export const WalletSigner = {
  /* ---------- EVM ---------- */

  /** Дозаполняем транзакцию: nonce, газ, комиссии EIP-1559. Возвращает поля BigInt и оценку комиссии. */
  async evmPrepare(chainId, tx, from) {
    const chain = CHAINS[chainId];
    const [nonceHex, block, priorityHex] = await Promise.all([
      tx.nonce !== undefined ? Promise.resolve(tx.nonce) : WalletStore.evm(chainId, "eth_getTransactionCount", [from, "pending"]),
      WalletStore.evm(chainId, "eth_getBlockByNumber", ["latest", false]),
      WalletStore.evm(chainId, "eth_maxPriorityFeePerGas", []).catch(() => "0x59682f00"), // 1.5 gwei
    ]);
    const baseFee = toBig(block?.baseFeePerGas || "0x0");
    const netPriority = toBig(priorityHex);
    const netMax = baseFee * 2n + netPriority;
    let priority = tx.maxPriorityFeePerGas ? toBig(tx.maxPriorityFeePerGas) : netPriority;
    let maxFee = tx.maxFeePerGas ? toBig(tx.maxFeePerGas) : tx.gasPrice ? toBig(tx.gasPrice) : netMax;
    const capped = [];
    // Комиссию назначает кошелёк, а не сайт: завышенный приоритет целиком уходит валидатору
    if (priority > netPriority * 3n + 1_000_000_000n) {
      capped.push(tt`приоритет`);
      priority = netPriority;
    }
    if (maxFee > netMax * 3n) {
      capped.push(tt`максимум`);
      maxFee = netMax;
    }
    if (maxFee < baseFee) {
      maxFee = netMax; // иначе транзакция не попадёт в блок
    }
    let estimated = null;
    try {
      const est = await WalletStore.evm(chainId, "eth_estimateGas", [{ from, to: tx.to, value: tx.value || "0x0", data: tx.data || tx.input || "0x" }]);
      estimated = (toBig(est) * 120n) / 100n;
    } catch (e) {
      if (!(tx.gas || tx.gasLimit)) {
        throw e;
      }
    }
    let gasLimit = estimated;
    if (tx.gas || tx.gasLimit) {
      gasLimit = toBig(tx.gas || tx.gasLimit);
      if (estimated !== null && gasLimit > estimated * 3n && gasLimit > 500_000n) {
        capped.push(tt`лимит газа`);
        gasLimit = estimated;
      }
    }
    const value = toBig(tx.value || 0);
    const prepared = {
      type: "eip1559",
      chainId: BigInt(chain.chainId),
      nonce: toBig(nonceHex),
      to: tx.to,
      value,
      data: tx.data || tx.input || "0x",
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: priority > maxFee ? maxFee : priority,
      gasLimit,
    };
    return { prepared, fee: gasLimit * maxFee, feeLikely: gasLimit * (baseFee + priority), baseFee, value, capped };
  },

  evmSign(prepared, priv) {
    const tx = EthTransaction.prepare(prepared);
    const signed = tx.signBy(priv);
    return { raw: signed.toHex(), hash: signed.hash ? "0x" + signed.hash : null };
  },

  async evmSend(chainId, raw) {
    return WalletStore.evm(chainId, "eth_sendRawTransaction", [raw]);
  },

  evmPersonalSign(message, priv) {
    // message: hex 0x… (байты) или строка
    const bytes = typeof message === "string" && /^0x[0-9a-fA-F]*$/.test(message) ? hexToBytes(message.slice(2)) : utf8ToBytes(String(message));
    return ethPersonal.sign(bytes, priv);
  },

  evmSignTyped(typed, priv) {
    const data = typeof typed === "string" ? JSON.parse(typed) : typed;
    return ethSignTyped(data, priv);
  },

  /** Permit2 (Uniswap): один адрес во всех EVM-сетях. */
  PERMIT2: "0x000000000022d473030f116ddee9f6b43ac78ba3",

  /** «Фактически без лимита»: 2^96−1 и больше (USDC/Uniswap-стиль) либо сумма, недостижимая для любого токена. */
  isUnlimited(amount) {
    return amount >= (1n << 96n) - 1n || amount >= 10n ** 30n;
  },

  /** Строгое чтение аргументов ABI: длина, чистые старшие байты адресов и ширина чисел проверяются. */
  abiReader(hex) {
    if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2) {
      throw new Error(tt`abi: не hex`);
    }
    const count = Math.floor(hex.length / 64);
    const word = i => {
      if (!Number.isInteger(i) || i < 0 || i >= count) {
        throw new Error(tt`abi: данных меньше, чем нужно`);
      }
      return hex.slice(i * 64, (i + 1) * 64);
    };
    const num = i => BigInt("0x" + word(i));
    const uint = (i, bits = 256) => {
      const v = num(i);
      if (v >> BigInt(bits)) {
        throw new Error(tt`abi: число шире типа`);
      }
      return v;
    };
    const addr = i => {
      const w = word(i);
      if (!/^0{24}/.test(w)) {
        throw new Error(tt`abi: неверный адрес`);
      }
      return "0x" + w.slice(24);
    };
    const bool = i => {
      const v = num(i);
      if (v > 1n) {
        throw new Error(tt`abi: неверный bool`);
      }
      return v === 1n;
    };
    /** Смещение в байтах → номер слова (смещения кратны 32 и не выходят за данные). */
    const offset = (i, base = 0) => {
      const v = num(i);
      if (v % 32n || v / 32n >= BigInt(count)) {
        throw new Error(tt`abi: неверное смещение`);
      }
      return base + Number(v / 32n);
    };
    /** bytes по номеру слова с длиной. */
    const bytesAt = w => {
      const len = num(w);
      if (len > BigInt(hex.length)) {
        throw new Error(tt`abi: длина за границей`);
      }
      const start = (w + 1) * 64;
      const end = start + Number(len) * 2;
      if (end > hex.length) {
        throw new Error(tt`abi: длина за границей`);
      }
      return hex.slice(start, end);
    };
    const length = (w, max) => {
      const n = num(w);
      if (n > BigInt(max)) {
        throw new Error(tt`abi: слишком много элементов`);
      }
      return Number(n);
    };
    return { count, word, num, uint, addr, bool, offset, bytesAt, length };
  },

  /** Человекочитаемый разбор calldata по белому списку. Всё, что не распознано строго, — kind "unknown":
   * лист показывает такой вызов как опасный. opts.chainId — сеть EVM (WETH, Permit2, известные контракты). */
  evmDecode(to, data, value, { chainId = null, depth = 0 } = {}) {
    if (!data || data === "0x") {
      return null;
    }
    const sel = data.slice(0, 10).toLowerCase();
    const unknown = (reason = null) => ({ kind: "unknown", selector: sel, reason });
    if (!/^0x[0-9a-fA-F]{8}/.test(data)) {
      return unknown(tt`данные короче селектора`);
    }
    const target = String(to || "").toLowerCase();
    try {
      const a = this.abiReader(data.slice(10));
      if (sel === "0xa9059cbb") {
        return { kind: "transfer", to: a.addr(0), amount: a.uint(1) };
      }
      if (sel === "0x095ea7b3" || sel === "0x39509351") {
        const amount = a.uint(1);
        return { kind: "approve", spender: a.addr(0), amount, unlimited: this.isUnlimited(amount), increase: sel === "0x39509351" };
      }
      if (sel === "0xa457c2d7") {
        return { kind: "allowanceDown", spender: a.addr(0), amount: a.uint(1) };
      }
      if (sel === "0x23b872dd") {
        return { kind: "transferFrom", from: a.addr(0), to: a.addr(1), amount: a.uint(2) };
      }
      if (sel === "0xa22cb465") {
        return { kind: "setApprovalForAll", operator: a.addr(0), approved: a.bool(1) };
      }
      if (sel === "0x42842e0e" || sel === "0xb88d4fde") {
        return { kind: "nftTransfer", from: a.addr(0), to: a.addr(1), tokenId: a.uint(2) };
      }
      // обёртка монеты — только у WETH этой сети: deposit()/withdraw() есть у любого контракта
      const wrapped = chainId && CHAINS[chainId]?.wrapped;
      if (wrapped && target === wrapped.address.toLowerCase()) {
        if (sel === "0xd0e30db0") {
          return { kind: "wrap", symbol: wrapped.symbol };
        }
        if (sel === "0x2e1a7d4d") {
          return { kind: "unwrap", amount: a.uint(0), symbol: wrapped.symbol };
        }
      }
      if (chainId && CHAINS[chainId]?.kind === "evm" && target === this.PERMIT2) {
        const p2 = this.permit2Decode(sel, a);
        if (p2) {
          return p2;
        }
      }
      // multicall на том же контракте: вложенные вызовы исполняются от вашего имени (delegatecall)
      if (sel === "0xac9650d8" || sel === "0x5ae401dc" || sel === "0x1f0464d1") {
        if (depth > 0) {
          return unknown(tt`вложенный multicall`);
        }
        const head = sel === "0xac9650d8" ? 0 : 1;
        const arr = a.offset(head);
        const n = a.length(arr, 32);
        const calls = [];
        for (let i = 0; i < n; i++) {
          const el = a.offset(arr + 1 + i, arr + 1);
          calls.push(this.evmDecode(to, "0x" + a.bytesAt(el), 0n, { chainId, depth: depth + 1 }) || unknown(tt`пустой вызов`));
        }
        return { kind: "multicall", calls, deadline: sel === "0x5ae401dc" ? a.uint(0) : null };
      }
    } catch (e) {
      return unknown(e.message);
    }
    // роутеры из вендорной библиотеки: только mainnet, точное совпадение адреса и функция из белого списка;
    // вложенные вызовы multicall этого же роутера разбираются так же
    if (chainId === "ethereum" && depth <= 1 && this.SWAP_ROUTERS[target]) {
      return this.swapDecode(target, data, value) || unknown(tt`функция роутера вне белого списка`);
    }
    return unknown();
  },

  /* Роутеры обмена, которые расшифровывает вендорный декодер. self/sender — адреса-заглушки в поле получателя:
   * у SwapRouter V3 address(0) означает сам роутер (результат ждёт unwrapWETH9/sweepToken в том же multicall);
   * у SwapRouter02 и Universal Router это address(2) = роутер и address(1) = msg.sender. Заглушка действует только
   * у того роутера, где она объявлена: у остальных такой адрес — обычный чужой получатель. */
  SWAP_ROUTERS: {
    "0x7a250d5630b4cf539739df2c5dacb4c659f2488d": { name: "Uniswap V2", funcs: "v2", self: [], sender: [] },
    "0xe592427a0aece92de3edee1f18e0157c05861564": { name: "Uniswap V3", funcs: "v3", self: ["0x0000000000000000000000000000000000000000"], sender: [] },
    "0x9aab3f75489902f3a48495025729a0af77d4b11e": { name: "Kyber", funcs: "kyber", self: [], sender: [] },
  },
  ROUTER02_SENDER: "0x0000000000000000000000000000000000000001",
  ROUTER02_SELF: "0x0000000000000000000000000000000000000002",

  /* Белый список функций: где лежит получатель (to), минимум к получению (min) или точная сумма (out), что отдаётся (in).
   * Функция роутера вне списка или без извлечённого получателя считается нерасшифрованной (опасной). */
  SWAP_FUNCS: (() => {
    const exactIn = { role: "swap", to: "to", in: "amountIn", min: "amountOutMin", path: "path" };
    const exactOut = { role: "swap", to: "to", inMax: "amountInMax", out: "amountOut", path: "path" };
    const liq = { role: "liquidity", to: "to" };
    const permit = { role: "permit" };
    return {
      v2: {
        swapExactETHForTokens: { ...exactIn, in: null, inNative: true },
        swapExactETHForTokensSupportingFeeOnTransferTokens: { ...exactIn, in: null, inNative: true },
        swapETHForExactTokens: { ...exactOut, inMax: null, inNative: true },
        swapExactTokensForETH: exactIn,
        swapExactTokensForETHSupportingFeeOnTransferTokens: exactIn,
        swapExactTokensForTokens: exactIn,
        swapExactTokensForTokensSupportingFeeOnTransferTokens: exactIn,
        swapTokensForExactETH: exactOut,
        swapTokensForExactTokens: exactOut,
        addLiquidity: liq,
        addLiquidityETH: liq,
        removeLiquidity: liq,
        removeLiquidityETH: liq,
        removeLiquidityETHSupportingFeeOnTransferTokens: liq,
        removeLiquidityWithPermit: liq,
        removeLiquidityETHWithPermit: liq,
        removeLiquidityETHWithPermitSupportingFeeOnTransferTokens: liq,
      },
      v3: {
        exactInputSingle: { role: "swap", to: "recipient", in: "amountIn", min: "amountOutMinimum", tokenIn: "tokenIn", tokenOut: "tokenOut" },
        exactInput: { role: "swap", to: "recipient", in: "amountIn", min: "amountOutMinimum", pathBytes: "path" },
        exactOutputSingle: { role: "swap", to: "recipient", inMax: "amountInMaximum", out: "amountOut", tokenIn: "tokenIn", tokenOut: "tokenOut" },
        exactOutput: { role: "swap", to: "recipient", inMax: "amountInMaximum", out: "amountOut", pathBytes: "path", reversed: true },
        unwrapWETH9: { role: "sweep", to: "recipient", min: "amountMinimum" },
        unwrapWETH9WithFee: { role: "sweep", to: "recipient", min: "amountMinimum", feeTo: "feeRecipient", feeBips: "feeBips" },
        sweepToken: { role: "sweep", to: "recipient", min: "amountMinimum", tokenOut: "token" },
        sweepTokenWithFee: { role: "sweep", to: "recipient", min: "amountMinimum", tokenOut: "token", feeTo: "feeRecipient", feeBips: "feeBips" },
        refundETH: { role: "refund" },
        selfPermit: permit,
        selfPermitIfNecessary: permit,
        selfPermitAllowed: permit,
        selfPermitAllowedIfNecessary: permit,
      },
      kyber: {
        trade: { role: "swap", to: "destAddress", in: "srcAmount", min: "minConversionRate", minIsRate: true, tokenIn: "src", tokenOut: "dest", feeTo: "platformWallet" },
        tradeWithHint: { role: "swap", to: "destAddress", in: "srcAmount", min: "minConversionRate", minIsRate: true, tokenIn: "src", tokenOut: "dest", feeTo: "walletId" },
        tradeWithHintAndFee: { role: "swap", to: "destAddress", in: "srcAmount", min: "minConversionRate", minIsRate: true, tokenIn: "src", tokenOut: "dest", feeTo: "platformWallet", feeBips: "platformFeeBps" },
      },
    };
  })(),

  /** Вызов роутера обмена: расшифровка вендорным декодером плюс получатель и минимум к получению.
   * null — расшифровать строго не удалось (вызывающий покажет вызов как опасный). */
  swapDecode(target, data, value) {
    const router = this.SWAP_ROUTERS[target];
    let d;
    try {
      d = ethDecodeData(target, data, toBig(value || 0));
    } catch (e) {
      return null;
    }
    const spec = d && !Array.isArray(d) && typeof d.name === "string" && Object.hasOwn(this.SWAP_FUNCS[router.funcs], d.name) ? this.SWAP_FUNCS[router.funcs][d.name] : null;
    if (!spec) {
      return null;
    }
    const v = d.value && typeof d.value === "object" ? d.value : {};
    const isAddr = a => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
    const addr = k => (k && isAddr(v[k]) ? v[k].toLowerCase() : null);
    const num = k => (k && typeof v[k] === "bigint" ? v[k] : null);
    const out = {
      kind: "swap", role: spec.role, router: router.name, fn: d.name,
      text: typeof d.hint === "string" && d.hint ? d.hint : d.name,
      recipient: null, recipientIs: null,
      amountIn: num(spec.in), amountInMax: num(spec.inMax), minOut: num(spec.min), amountOut: num(spec.out),
      exactOut: !!spec.out, minIsRate: !!spec.minIsRate, inNative: !!spec.inNative,
      tokenIn: addr(spec.tokenIn), tokenOut: addr(spec.tokenOut),
      feeRecipient: addr(spec.feeTo), feeBips: num(spec.feeBips),
    };
    if (spec.path) {
      const path = Array.isArray(v[spec.path]) ? v[spec.path] : [];
      if (path.length < 2 || !path.every(isAddr)) {
        return null;
      }
      out.tokenIn = path[0].toLowerCase();
      out.tokenOut = path[path.length - 1].toLowerCase();
    }
    if (spec.pathBytes) {
      const b = v[spec.pathBytes];
      // путь V3: адрес (20) + [комиссия (3) + адрес (20)]…
      if (!(b instanceof Uint8Array) || b.length < 43 || (b.length - 20) % 23) {
        return null;
      }
      const ends = [hex0x(b.slice(0, 20)), hex0x(b.slice(-20))];
      [out.tokenIn, out.tokenOut] = spec.reversed ? ends.reverse() : ends;
    }
    if (spec.role === "refund" || spec.role === "permit") {
      out.recipientIs = "sender"; // refundETH возвращает остаток отправителю, selfPermit ничего не переводит
      return out;
    }
    // получатель обязан извлечься, а минимум/сумма — быть на месте: иначе вызов не считается расшифрованным
    const to = addr(spec.to);
    if (!to || (spec.role === "swap" && out.minOut === null && out.amountOut === null) || (spec.role === "sweep" && out.minOut === null)) {
      return null;
    }
    out.recipient = to;
    out.recipientIs = router.self.includes(to) ? "router" : router.sender.includes(to) ? "sender" : "address";
    return out;
  },

  /** Минимум к получению, при котором обмен пройдёт по любому курсу. */
  swapTinyMin(v) {
    return v !== null && v !== undefined && v <= 1000n;
  },

  /** Проверка обмена (одного вызова или пакета multicall роутера): получатель обязан быть адресом пользователя.
   * Возвращает { danger, lines, rows, warns }: строки для листа подтверждения. */
  evmSwapReview(decoded, me) {
    const mine = a => !!a && String(a).toLowerCase() === String(me || "").toLowerCase();
    const calls = (decoded?.kind === "multicall" ? decoded.calls : [decoded]).filter(c => c?.kind === "swap");
    const lines = [];
    const rows = [];
    const warns = new Set();
    let danger = false;
    let own = false;
    let held = 0; // обмены, результат которых остался на роутере и пока не забран
    let heldLoose = false; // …и минимум у них не задан
    const noMin = tt`Минимум к получению не задан (ноль или ничтожная сумма): обмен пройдёт по любому курсу, и разницу заберут боты (сэндвич-атака). Обычные сайты обмена так не делают.`;
    for (const c of calls) {
      if (c.role === "refund" || c.role === "permit") {
        continue;
      }
      const loose = c.role !== "liquidity" && !c.exactOut && this.swapTinyMin(c.minOut);
      if (c.recipientIs === "router") {
        if (c.role === "sweep") {
          danger = true;
          warns.add(tt`Вывод с роутера отправляет средства на сам роутер: забрать их сможет кто угодно.`);
        } else {
          held++;
          heldLoose ||= loose;
        }
      } else if (c.recipientIs === "sender" || (c.recipientIs === "address" && mine(c.recipient))) {
        own = true;
        if (c.role === "sweep") {
          if (held && heldLoose && this.swapTinyMin(c.minOut)) {
            warns.add(noMin);
          }
          held = 0;
          heldLoose = false;
        } else if (loose) {
          warns.add(noMin);
        }
      } else {
        danger = true;
        lines.push(tt`Получатель: чужой адрес ${c.recipient}`);
        rows.push([tt`Получатель`, tt`чужой адрес ${c.recipient}`, "bad"]);
        warns.add(tt`Результат операции получит не ваш адрес, а ${c.recipient}. Сайты обмена отправляют результат вам: так выглядит кража через подменённого получателя.`);
        if (loose) {
          warns.add(noMin);
        }
      }
      if (c.feeRecipient && !/^0x0{40}$/.test(c.feeRecipient) && !mine(c.feeRecipient)) {
        lines.push(tt`Комиссия посредника${c.feeBips !== null ? ` ${Number(c.feeBips) / 100}%` : ""} уходит на ${c.feeRecipient}`);
        if (c.feeBips !== null && c.feeBips > 100n) {
          danger = true;
          warns.add(tt`Комиссия посредника больше 1% от суммы обмена.`);
        }
      }
    }
    if (held) {
      danger = true;
      warns.add(tt`Результат обмена остаётся на контракте роутера и в этой транзакции не забирается на ваш адрес: его сможет забрать кто угодно.`);
    }
    if (!calls.length) {
      danger = true; // проверять нечего: получателя нет
    } else if (own && !rows.length) {
      lines.push(tt`Получатель: ваш адрес`);
      rows.push([tt`Получатель`, tt`ваш адрес`]);
    }
    return { danger, lines, rows, warns: [...warns] };
  },

  /** Вызовы Permit2 от вашего адреса: approve, permit (single/batch), transferFrom, lockdown, invalidateNonces. */
  permit2Decode(sel, a) {
    const detail = w => ({ token: a.addr(w), amount: a.uint(w + 1, 160), expiration: a.uint(w + 2, 48), nonce: a.uint(w + 3, 48) });
    if (sel === "0x87517c45") {
      const amount = a.uint(2, 160);
      return { kind: "permit2Approve", details: [{ token: a.addr(0), amount, expiration: a.uint(3, 48) }], spender: a.addr(1) };
    }
    if (sel === "0x2b67b570") {
      // permit(owner, PermitSingle{details{token,amount,expiration,nonce}, spender, sigDeadline}, signature)
      return { kind: "permit2Approve", owner: a.addr(0), details: [detail(1)], spender: a.addr(5), sigDeadline: a.uint(6), viaPermit: true };
    }
    if (sel === "0x2a2d80d1") {
      // permit(owner, PermitBatch{details[], spender, sigDeadline}, signature)
      const t = a.offset(1);
      const arr = a.offset(t, t);
      const n = a.length(arr, 32);
      const details = [];
      for (let i = 0; i < n; i++) {
        details.push(detail(arr + 1 + i * 4));
      }
      return { kind: "permit2Approve", owner: a.addr(0), details, spender: a.addr(t + 1), sigDeadline: a.uint(t + 2), viaPermit: true };
    }
    if (sel === "0x36c78516") {
      return { kind: "permit2Transfer", items: [{ from: a.addr(0), to: a.addr(1), amount: a.uint(2, 160), token: a.addr(3) }] };
    }
    if (sel === "0x0d58b1db") {
      const arr = a.offset(0);
      const n = a.length(arr, 32);
      const items = [];
      for (let i = 0; i < n; i++) {
        const w = arr + 1 + i * 4;
        items.push({ from: a.addr(w), to: a.addr(w + 1), amount: a.uint(w + 2, 160), token: a.addr(w + 3) });
      }
      return { kind: "permit2Transfer", items };
    }
    if (sel === "0xcc53287f") {
      const arr = a.offset(0);
      const n = a.length(arr, 64);
      const pairs = [];
      for (let i = 0; i < n; i++) {
        pairs.push({ token: a.addr(arr + 1 + i * 2), spender: a.addr(arr + 2 + i * 2) });
      }
      return { kind: "permit2Revoke", pairs };
    }
    if (sel === "0x65d9723c") {
      return { kind: "permit2Revoke", pairs: [{ token: a.addr(0), spender: a.addr(1) }], nonces: true };
    }
    return null;
  },

  /* ---------- TRON ---------- */

  tronNodes() {
    const { list, index } = WalletStore.nodesFor("tron");
    const rest = list.filter(u => !WalletStore.tronIsJsonRpc(u));
    const start = Math.max(0, rest.indexOf(list[index]));
    return rest.length ? [...rest.slice(start), ...rest.slice(0, start)] : ["https://api.trongrid.io"];
  },

  tronNode() {
    return this.tronNodes()[0];
  },

  /** REST-запрос к TRON с перебором нод и повтором при 429. */
  _tronCooldown: new Map(), // нода → время, до которого её не трогаем после 429

  async tronPost(path, body) {
    let lastError = null;
    const nodes = this.tronNodes();
    const live = nodes.filter(n => (this._tronCooldown.get(n) || 0) < Date.now());
    for (const node of live.length ? live : nodes) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await WalletStore.fetchJson(node + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, { timeout: 12000 });
        } catch (e) {
          // network: нода не ответила или ответила ошибкой — в отличие от отказа самого контракта
          lastError = Object.assign(new Error(`TRON ${e.message}`), { network: true });
          if (/HTTP 429/.test(e.message)) {
            if (attempt < 2) {
              await new Promise(r => setTimeout(r, 1200 * (attempt + 1)));
              continue;
            }
            this._tronCooldown.set(node, Date.now() + 20000);
          }
          break;
        }
      }
    }
    throw lastError || Object.assign(new Error(tt`TRON: нода недоступна`), { network: true });
  },

  tronRecoverableSig(hash, priv) {
    const sig = secp256k1.sign(hash, priv);
    const bytes = new Uint8Array(65);
    bytes.set(sig.toCompactRawBytes(), 0);
    bytes[64] = (sig.recovery ?? 0) + 27;
    return bytesToHex(bytes);
  },

  /** Подпись транзакции: txID всегда считается из raw_data_hex; чужой txID не принимается. */
  tronSignTx(tx, priv) {
    if (typeof tx?.raw_data_hex !== "string" || !/^[0-9a-fA-F]+$/.test(tx.raw_data_hex)) {
      throw new Error(tt`Транзакция без raw_data_hex`);
    }
    const txID = bytesToHex(sha256(hexToBytes(tx.raw_data_hex)));
    if (tx.txID && String(tx.txID).toLowerCase() !== txID) {
      throw new Error(tt`txID не совпадает с raw_data_hex: транзакция подменена`);
    }
    const signature = this.tronRecoverableSig(hexToBytes(txID), priv);
    return { ...tx, txID, raw_data: this.tronRawToJson(this.tronDecodeRaw(tx.raw_data_hex)), signature: [...(tx.signature || []), signature] };
  },

  tronSignMessageV2(message, priv) {
    // как в TronWeb: строка хешируется как UTF-8 (даже если выглядит как hex), байты — как есть
    const bytes = Array.isArray(message) ? Uint8Array.from(message) : utf8ToBytes(String(message));
    const prefix = utf8ToBytes(`\x19TRON Signed Message:\n${bytes.length}`);
    const all = new Uint8Array(prefix.length + bytes.length);
    all.set(prefix, 0);
    all.set(bytes, prefix.length);
    return "0x" + this.tronRecoverableSig(keccak_256(all), priv);
  },

  tronSignMessageV1(hexMessage, priv) {
    const bytes = hexToBytes(String(hexMessage).replace(/^0x/, ""));
    if (bytes.length !== 32) {
      throw new Error(tt`Для старой подписи TRON нужен хеш из 32 байт`);
    }
    const prefix = utf8ToBytes("\x19TRON Signed Message:\n32");
    const all = new Uint8Array(prefix.length + bytes.length);
    all.set(prefix, 0);
    all.set(bytes, prefix.length);
    return "0x" + this.tronRecoverableSig(keccak_256(all), priv);
  },

  tronHexAddress(base58Addr) {
    return bytesToHex(b58check.decode(base58Addr));
  },

  tronBase58(hexAddr) {
    return b58check.encode(hexToBytes(hexAddr.replace(/^0x/, "")));
  },

  tronAddrBytes(addr) {
    if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(addr)) {
      return b58check.decode(addr);
    }
    const hex = String(addr).replace(/^0x/, "");
    if (/^41[0-9a-fA-F]{40}$/.test(hex)) {
      return hexToBytes(hex);
    }
    throw new Error(tt`Неверный адрес TRON`);
  },

  /** Баланс TRC-20 через ноду (для проверки «approve больше баланса»). */
  async tronTokenBalance(owner, contract) {
    const r = await this.tronPost("/wallet/triggerconstantcontract", { owner_address: owner, contract_address: contract, function_selector: "balanceOf(address)", parameter: this.abiEncodeParam("address", owner), visible: true });
    const hex = r?.constant_result?.[0];
    if (typeof hex !== "string" || !/^[0-9a-fA-F]{1,64}$/.test(hex)) {
      throw new Error(tt`TRON: нода не вернула баланс токена`);
    }
    return BigInt("0x" + hex);
  },

  async tronBroadcast(signed) {
    const r = await this.tronPost("/wallet/broadcasttransaction", signed);
    if (r.result !== true) {
      throw new Error(r.message ? new TextDecoder().decode(hexToBytes(r.message)) : r.code || "broadcast failed");
    }
    return { result: true, txid: signed.txID, transaction: signed };
  },

  /* --- protobuf: минимальный кодек для Transaction.raw --- */

  pbVarint(n) {
    let v = BigInt(n);
    const out = [];
    while (v >= 0x80n) {
      out.push(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    out.push(Number(v));
    return new Uint8Array(out);
  },

  pbField(field, wt, payload) {
    const key = this.pbVarint((field << 3) | wt);
    const out = new Uint8Array(key.length + payload.length);
    out.set(key, 0);
    out.set(payload, key.length);
    return out;
  },

  pbBytes(field, bytes) {
    const len = this.pbVarint(bytes.length);
    const body = new Uint8Array(len.length + bytes.length);
    body.set(len, 0);
    body.set(bytes, len.length);
    return this.pbField(field, 2, body);
  },

  pbUint(field, n) {
    return BigInt(n) === 0n ? new Uint8Array(0) : this.pbField(field, 0, this.pbVarint(n));
  },

  pbConcat(parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  },

  /** Разбор protobuf-сообщения в список полей { field, wt, value } (value: bigint или Uint8Array). */
  pbDecode(buf) {
    const fields = [];
    let o = 0;
    const varint = () => {
      let v = 0n;
      let shift = 0n;
      for (let i = 0; i < 10; i++) {
        if (o >= buf.length) {
          throw new Error(tt`protobuf: обрыв`);
        }
        const b = buf[o++];
        v |= BigInt(b & 0x7f) << shift;
        shift += 7n;
        if (!(b & 0x80)) {
          if (v > 0xffffffffffffffffn) {
            throw new Error(tt`protobuf: varint больше 64 бит`);
          }
          return v;
        }
      }
      throw new Error(tt`protobuf: varint слишком длинный`);
    };
    while (o < buf.length) {
      const key = varint();
      const field = Number(key >> 3n);
      const wt = Number(key & 7n);
      if (wt === 0) {
        fields.push({ field, wt, value: varint() });
      } else if (wt === 2) {
        const len = Number(varint());
        if (o + len > buf.length) {
          throw new Error(tt`protobuf: длина за границей`);
        }
        fields.push({ field, wt, value: buf.slice(o, o + len) });
        o += len;
      } else if (wt === 1) {
        if (o + 8 > buf.length) {
          throw new Error(tt`protobuf: обрыв fixed64`);
        }
        fields.push({ field, wt, value: buf.slice(o, o + 8) });
        o += 8;
      } else if (wt === 5) {
        if (o + 4 > buf.length) {
          throw new Error(tt`protobuf: обрыв fixed32`);
        }
        fields.push({ field, wt, value: buf.slice(o, o + 4) });
        o += 4;
      } else {
        throw new Error(tt`protobuf: неизвестный тип поля ${wt}`);
      }
    }
    return fields;
  },

  TRON_TYPES: { 0: "AccountCreateContract", 1: "TransferContract", 2: "TransferAssetContract", 4: "VoteWitnessContract", 11: "FreezeBalanceContract", 12: "UnfreezeBalanceContract", 13: "WithdrawBalanceContract", 31: "TriggerSmartContract", 54: "FreezeBalanceV2Contract", 55: "UnfreezeBalanceV2Contract", 57: "DelegateResourceContract", 58: "UnDelegateResourceContract" },

  /** Строгий доступ к полям: singular-поле ровно один раз, неизвестных полей нет. */
  pbStrict(fields, allowed, repeated = []) {
    const seen = new Set();
    for (const f of fields) {
      if (!allowed.includes(f.field)) {
        throw new Error(tt`Транзакция содержит неизвестное поле ${f.field}: отклонено`);
      }
      if (!repeated.includes(f.field)) {
        if (seen.has(f.field)) {
          throw new Error(tt`Поле ${f.field} повторяется: транзакция неоднозначна, отклонено`);
        }
        seen.add(f.field);
      }
    }
    return n => fields.find(f => f.field === n)?.value;
  },

  /** Декодирует Transaction.raw из hex: именно это и подписывается.
   * Разбор строгий, а после разбора байты пересобираются каноническим кодеком и
   * сравниваются с исходными: любая нестандартная кодировка отклоняется. */
  tronDecodeRaw(hex) {
    const bytes = hexToBytes(String(hex).replace(/^0x/, ""));
    const raw = this.pbDecode(bytes);
    // Transaction.raw: 1 ref_block_bytes, 3 ref_block_num, 4 ref_block_hash, 8 expiration, 10 data, 11 contract (repeated), 14 timestamp, 18 fee_limit
    const one = this.pbStrict(raw, [1, 3, 4, 8, 10, 11, 14, 18], [11]);
    const i64 = v => {
      if (v !== undefined && v !== null && v > 0x7fffffffffffffffn) {
        throw new Error(tt`Значение поля вне диапазона int64: отклонено`);
      }
      return v;
    };
    const num = v => {
      i64(v);
      if (v > 9007199254740991n) {
        throw new Error(tt`Значение поля слишком велико: отклонено`);
      }
      return Number(v ?? 0n);
    };
    const out = {
      refBlockBytes: one(1) ? bytesToHex(one(1)) : "",
      refBlockNum: i64(one(3)) ?? null,
      refBlockHash: one(4) ? bytesToHex(one(4)) : "",
      expiration: num(one(8) ?? 0n),
      timestamp: num(one(14) ?? 0n),
      feeLimit: num(one(18) ?? 0n),
      data: one(10) ? new TextDecoder().decode(one(10)) : "",
      dataBytes: one(10) || null,
      contracts: [],
    };
    for (const c of raw.filter(f => f.field === 11)) {
      const cf = this.pbDecode(c.value);
      const cOne = this.pbStrict(cf, [1, 2, 5]); // type, parameter, Permission_id
      const type = Number(cOne(1) ?? 0n);
      const anyBytes = cOne(2);
      if (!anyBytes) {
        throw new Error(tt`Контракт без параметров`);
      }
      const any = this.pbDecode(anyBytes);
      const aOne = this.pbStrict(any, [1, 2]);
      const typeUrl = aOne(1) ? new TextDecoder().decode(aOne(1)) : "";
      const pf = this.pbDecode(aOne(2) || new Uint8Array(0));
      const addr = v => {
        if (!v || v.length !== 21 || v[0] !== 0x41) {
          throw new Error(tt`Адрес в транзакции имеет неверный формат`);
        }
        return b58check.encode(v);
      };
      const entry = { type, typeName: this.TRON_TYPES[type] || `type ${type}`, permissionId: Number(cOne(5) ?? 0n), typeUrl };
      if (type === 1) {
        const pOne = this.pbStrict(pf, [1, 2, 3]);
        entry.owner = addr(pOne(1));
        entry.to = addr(pOne(2));
        entry.amount = i64(pOne(3)) ?? 0n;
      } else if (type === 31) {
        const pOne = this.pbStrict(pf, [1, 2, 3, 4, 5, 6]);
        entry.owner = addr(pOne(1));
        entry.contractAddress = addr(pOne(2));
        entry.callValue = i64(pOne(3)) ?? 0n;
        entry.data = pOne(4) ? "0x" + bytesToHex(pOne(4)) : "0x";
        entry.callTokenValue = i64(pOne(5)) ?? 0n;
        entry.tokenId = i64(pOne(6)) ?? 0n;
      } else {
        throw new Error(tt`Операция ${entry.typeName} не поддерживается кошельком`);
      }
      if (entry.typeUrl !== `type.googleapis.com/protocol.${entry.typeName}`) {
        throw new Error(tt`Тип контракта не совпадает с описанием`);
      }
      out.contracts.push(entry);
    }
    if (!out.contracts.length) {
      throw new Error(tt`Транзакция без контрактов`);
    }
    // Каноническая пересборка: байты обязаны совпасть с исходными
    const canon = this.tronEncodeRaw(out);
    if (bytesToHex(canon) !== bytesToHex(bytes)) {
      throw new Error(tt`Нестандартная кодировка транзакции: отклонено`);
    }
    return out;
  },

  /** Канонический кодек Transaction.raw из декодированного представления (поля по возрастанию номеров). */
  tronEncodeRaw(d) {
    const parts = [];
    if (d.refBlockBytes) {
      parts.push(this.pbBytes(1, hexToBytes(d.refBlockBytes)));
    }
    if (d.refBlockNum !== null && d.refBlockNum !== undefined) {
      parts.push(this.pbUint(3, d.refBlockNum));
    }
    if (d.refBlockHash) {
      parts.push(this.pbBytes(4, hexToBytes(d.refBlockHash)));
    }
    parts.push(this.pbUint(8, d.expiration || 0));
    if (d.dataBytes && d.dataBytes.length) {
      parts.push(this.pbBytes(10, d.dataBytes));
    }
    for (const c of d.contracts) {
      let param;
      if (c.type === 1) {
        param = this.pbConcat([this.pbBytes(1, this.tronAddrBytes(c.owner)), this.pbBytes(2, this.tronAddrBytes(c.to)), this.pbUint(3, c.amount || 0)]);
      } else if (c.type === 31) {
        param = this.pbConcat([
          this.pbBytes(1, this.tronAddrBytes(c.owner)),
          this.pbBytes(2, this.tronAddrBytes(c.contractAddress)),
          this.pbUint(3, c.callValue || 0),
          c.data && c.data !== "0x" ? this.pbBytes(4, hexToBytes(c.data.slice(2))) : new Uint8Array(0),
          this.pbUint(5, c.callTokenValue || 0),
          this.pbUint(6, c.tokenId || 0),
        ]);
      } else {
        throw new Error(tt`Неизвестный тип контракта`);
      }
      const any = this.pbConcat([this.pbBytes(1, utf8ToBytes(`type.googleapis.com/protocol.${c.typeName}`)), this.pbBytes(2, param)]);
      parts.push(this.pbBytes(11, this.pbConcat([this.pbUint(1, c.type), this.pbBytes(2, any), this.pbUint(5, c.permissionId || 0)])));
    }
    parts.push(this.pbUint(14, d.timestamp || 0));
    parts.push(this.pbUint(18, d.feeLimit || 0));
    return this.pbConcat(parts);
  },

  /** raw_data в формате TronWeb (для сайтов и для нашей истории), построенный из декодированного hex. */
  tronRawToJson(d) {
    return {
      ref_block_bytes: d.refBlockBytes,
      ref_block_hash: d.refBlockHash,
      expiration: d.expiration,
      timestamp: d.timestamp,
      ...(d.feeLimit ? { fee_limit: d.feeLimit } : {}),
      contract: d.contracts.map(c => {
        const value = { owner_address: c.owner ? this.tronHexAddress(c.owner) : undefined };
        if (c.type === 1) {
          Object.assign(value, { to_address: this.tronHexAddress(c.to), amount: Number(c.amount) });
        } else if (c.type === 31) {
          Object.assign(value, { contract_address: this.tronHexAddress(c.contractAddress), data: c.data.slice(2), ...(c.callValue ? { call_value: Number(c.callValue) } : {}) });
        }
        return { type: c.typeName, parameter: { value, type_url: `type.googleapis.com/protocol.${c.typeName}` } };
      }),
    };
  },

  async tronNowBlock() {
    const b = await this.tronPost("/wallet/getnowblock", {});
    const number = b.block_header?.raw_data?.number;
    const timestamp = b.block_header?.raw_data?.timestamp;
    if (!b.blockID || !number || !timestamp) {
      throw new Error(tt`TRON: нода не вернула блок`);
    }
    if (Math.abs(Date.now() - timestamp) > 10 * 60 * 1000) {
      throw new Error(tt`TRON: нода отдаёт устаревший блок`);
    }
    return { refBlockBytes: number.toString(16).padStart(16, "0").slice(12, 16), refBlockHash: b.blockID.slice(16, 32), timestamp };
  },

  /** Локальная сборка Transaction.raw: ref-блок берём у ноды, всё остальное — наше. */
  async tronBuildRaw(contract, { feeLimit = 0 } = {}) {
    const block = await this.tronNowBlock();
    const c = contract.kind === "transfer"
      ? { type: 1, typeName: "TransferContract", owner: contract.owner, to: contract.to, amount: BigInt(contract.amount), permissionId: 0 }
      : { type: 31, typeName: "TriggerSmartContract", owner: contract.owner, contractAddress: contract.contractAddress, callValue: BigInt(contract.callValue || 0), data: "0x" + String(contract.data).replace(/^0x/, ""), callTokenValue: 0n, tokenId: 0n, permissionId: 0 };
    const d = { refBlockBytes: block.refBlockBytes, refBlockNum: null, refBlockHash: block.refBlockHash, expiration: block.timestamp + 60 * 1000, dataBytes: null, contracts: [c], timestamp: Date.now(), feeLimit };
    const raw = this.tronEncodeRaw(d);
    const raw_data_hex = bytesToHex(raw);
    const txID = bytesToHex(sha256(raw));
    return { visible: true, txID, raw_data: this.tronRawToJson(this.tronDecodeRaw(raw_data_hex)), raw_data_hex };
  },

  tronBuildSendTrx(to, amountSun, from) {
    return this.tronBuildRaw({ kind: "transfer", owner: from, to, amount: BigInt(amountSun) });
  },

  async tronTriggerSmartContract(contract, selector, options, params, issuer) {
    const enc = (params || []).map(p => this.abiEncodeParam(p.type, p.value)).join("");
    const sig = bytesToHex(keccak_256(utf8ToBytes(selector))).slice(0, 8);
    const feeLimit = Number(options?.feeLimit || 100000000);
    const tx = await this.tronBuildRaw({ kind: "trigger", owner: issuer, contractAddress: contract, data: sig + enc, callValue: options?.callValue || 0 }, { feeLimit });
    // Формат ответа как у ноды: { result: { result: true }, transaction }
    return { result: { result: true }, transaction: tx };
  },

  /** Оценка энергии через ноду (только для отображения комиссии). */
  async tronEstimateEnergy(owner, contractAddress, selector, parameterHex) {
    const sim = await this.tronPost("/wallet/triggerconstantcontract", { owner_address: owner, contract_address: contractAddress, function_selector: selector, parameter: parameterHex, visible: true });
    if (sim.result?.result === false || sim.result?.message) {
      throw new Error(sim.result?.message ? new TextDecoder().decode(hexToBytes(sim.result.message)) : tt`контракт отклонил вызов`);
    }
    return BigInt(sim.energy_used || 65000);
  },

  abiEncodeParam(type, value) {
    if (type === "address") {
      let hex = /^T/.test(value) ? this.tronHexAddress(value).slice(2) : String(value).replace(/^0x/, "");
      if (hex.length === 42 && hex.startsWith("41")) {
        hex = hex.slice(2);
      }
      if (!/^[0-9a-fA-F]{40}$/.test(hex)) {
        throw new Error(tt`Неверный адрес в параметрах`);
      }
      return hex.padStart(64, "0");
    }
    const intMatch = /^(u?)int(\d*)$/.exec(type);
    if (intMatch) {
      const unsigned = !!intMatch[1];
      const bits = BigInt(intMatch[2] || "256");
      if (bits < 8n || bits > 256n || bits % 8n !== 0n) {
        throw new Error(tt`Неверная ширина типа ${type}`);
      }
      let v = toBig(value);
      const max = unsigned ? (1n << bits) - 1n : (1n << (bits - 1n)) - 1n;
      const min = unsigned ? 0n : -(1n << (bits - 1n));
      if (v < min || v > max) {
        throw new Error(tt`Значение вне диапазона ${type}`);
      }
      if (v < 0n) {
        v = (1n << 256n) + v;
      }
      return v.toString(16).padStart(64, "0");
    }
    if (type === "bool") {
      if (![true, false, 1, 0, "true", "false", "1", "0"].includes(value)) {
        throw new Error(tt`bool: допустимы только true/false`);
      }
      return (value === true || value === 1 || value === "true" || value === "1" ? "1" : "0").padStart(64, "0");
    }
    if (/^bytes32$/.test(type)) {
      const hex = String(value).replace(/^0x/, "");
      if (!/^([0-9a-fA-F]{2}){1,32}$/.test(hex)) {
        throw new Error(tt`bytes32: нужен hex до 32 байт`);
      }
      return hex.padEnd(64, "0");
    }
    throw new Error(tt`Тип ${type} пока не поддержан`);
  },

  /* ---------- Solana ---------- */

  solSignMessage(bytes, priv) {
    if (this.solLooksLikeMessage(bytes)) {
      throw new Error(tt`Сообщение является транзакцией Solana: подпись отклонена`);
    }
    return ed25519.sign(bytes, priv);
  },

  SOL_LIMITS: { sigs: 16, keys: 256, ixs: 128, accounts: 256 },

  /** Разбор Message (без подписей). Бросает при нарушении формата или лимитов. */
  solParseMessage(bytes, offset = 0) {
    let o = offset;
    const need = n => {
      if (o + n > bytes.length) {
        throw new Error(tt`Solana: обрыв данных`);
      }
    };
    const compact = (max) => {
      let len = 0;
      let size = 0;
      for (;;) {
        need(1);
        const b = bytes[o++];
        len |= (b & 0x7f) << (size * 7);
        size++;
        if (!(b & 0x80)) {
          break;
        }
        if (size > 3) {
          throw new Error(tt`Solana: длина слишком велика`);
        }
      }
      if (len > max) {
        throw new Error(tt`Solana: превышен лимит`);
      }
      return len;
    };
    let version = "legacy";
    need(1);
    if (bytes[o] & 0x80) {
      version = bytes[o] & 0x7f;
      o++;
    }
    need(3);
    const numRequired = bytes[o];
    const numReadonlySigned = bytes[o + 1];
    const numReadonlyUnsigned = bytes[o + 2];
    o += 3;
    if (numRequired < 1 || numRequired > this.SOL_LIMITS.sigs) {
      throw new Error(tt`Solana: неверный заголовок`);
    }
    const keysLen = compact(this.SOL_LIMITS.keys);
    if (keysLen < numRequired || keysLen < numReadonlySigned + numRequired) {
      throw new Error(tt`Solana: заголовок не согласуется с ключами`);
    }
    need(keysLen * 32);
    const keys = [];
    for (let i = 0; i < keysLen; i++) {
      keys.push(base58.encode(bytes.slice(o, o + 32)));
      o += 32;
    }
    need(32);
    const blockhash = base58.encode(bytes.slice(o, o + 32));
    o += 32;
    const ixCount = compact(this.SOL_LIMITS.ixs);
    const instructions = [];
    for (let i = 0; i < ixCount; i++) {
      need(1);
      const programIndex = bytes[o++];
      const accCount = compact(this.SOL_LIMITS.accounts);
      need(accCount);
      const accounts = Array.from(bytes.slice(o, o + accCount));
      o += accCount;
      const dataLen = compact(bytes.length);
      need(dataLen);
      const data = bytes.slice(o, o + dataLen);
      o += dataLen;
      instructions.push({ programIndex, program: keys[programIndex] || null, accounts, data });
    }
    let lookups = 0;
    if (version !== "legacy") {
      lookups = compact(64);
      for (let i = 0; i < lookups; i++) {
        need(32);
        o += 32;
        const w = compact(256);
        need(w);
        o += w;
        const r = compact(256);
        need(r);
        o += r;
      }
    }
    return { version, numRequired, numReadonlySigned, numReadonlyUnsigned, keys, blockhash, instructions, lookups, end: o };
  },

  /** Полная транзакция: подписи + Message. */
  solParse(bytes) {
    let o = 0;
    let sigCount = 0;
    let size = 0;
    for (;;) {
      if (o >= bytes.length) {
        throw new Error(tt`Solana: обрыв данных`);
      }
      const b = bytes[o++];
      sigCount |= (b & 0x7f) << (size * 7);
      size++;
      if (!(b & 0x80)) {
        break;
      }
      if (size > 2) {
        throw new Error(tt`Solana: слишком много подписей`);
      }
    }
    if (sigCount < 1 || sigCount > this.SOL_LIMITS.sigs || o + sigCount * 64 > bytes.length) {
      throw new Error(tt`Solana: неверное число подписей`);
    }
    const sigStart = o;
    o += sigCount * 64;
    const msgStart = o;
    const msg = this.solParseMessage(bytes, msgStart);
    if (msg.numRequired !== sigCount) {
      throw new Error(tt`Solana: число подписей не совпадает с заголовком`);
    }
    if (msg.end !== bytes.length) {
      throw new Error(tt`Solana: лишние данные после сообщения`);
    }
    return { sigCount, sigStart, msgStart, message: bytes.slice(msgStart), ...msg };
  },

  /** Похожи ли байты на Message транзакции (то, что подписывается при отправке). */
  solLooksLikeMessage(bytes) {
    try {
      const m = this.solParseMessage(bytes, 0);
      return m.end === bytes.length && m.keys.length > 0;
    } catch (e) {
      return false;
    }
  },

  solSignTransaction(bytes, priv, address) {
    const parsed = this.solParse(bytes);
    const index = parsed.keys.indexOf(address);
    if (index === -1 || index >= parsed.sigCount) {
      throw new Error(tt`Транзакция не требует подписи этого адреса`);
    }
    const sig = ed25519.sign(parsed.message, priv);
    const out = new Uint8Array(bytes);
    out.set(sig, parsed.sigStart + index * 64);
    return out;
  },

  SOL_TOKEN_2022: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  SOL_COMPUTE: "ComputeBudget111111111111111111111111111111",

  /** Человекочитаемое описание инструкций. tokens: [{ mint, symbol, decimals }]. */
  solDescribe(parsed, ourAddress, tokens = []) {
    const lines = [];
    let danger = false;
    let unknown = 0; // программы, которые кошелёк не расшифровывает: с вашей подписью они могут через CPI сделать что угодно с вашими счетами
    // Сколько списаний с вашего адреса инструкции называют явно: симуляция сверяет с этим фактическое изменение
    // баланса, чтобы мелкий перевод-приманка не прикрывал крупное списание.
    let solOut = 0n; // лампорты: переводы и создание счетов за ваш счёт
    let ataCreates = 0; // токен-счета (ATA), создаваемые за ваш счёт
    let plainTokenOut = 0n; // Transfer без указания mint с вашей подписью: токен неизвестен
    const tokenOut = new Map(); // mint → сырая сумма переводов TransferChecked с вашей подписью
    const ours = i => key(i) === ourAddress;
    const short = a => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "?");
    const key = i => (i < parsed.keys.length ? parsed.keys[i] : null);
    const name = i => {
      const k = key(i);
      return k === ourAddress ? tt`ваш адрес` : k ? short(k) : tt`адрес из таблицы`;
    };
    const u64 = (d, off) => new DataView(d.buffer, d.byteOffset).getBigUint64(off, true);
    const fmt = (raw, dec) => WalletStore.format(raw, dec, 6);
    for (const ix of parsed.instructions) {
      try {
      const p = ix.program;
      const d = ix.data;
      if (p === this.SOL_COMPUTE) {
        continue;
      }
      if (p === this.SOL_SYSTEM && d.length >= 4) {
        const tag = new DataView(d.buffer, d.byteOffset).getUint32(0, true);
        if (tag === 2 && d.length >= 12) {
          lines.push(tt`Перевод ${fmt(u64(d, 4), 9)} SOL: ${name(ix.accounts[0])} → ${name(ix.accounts[1])}`);
          if (ours(ix.accounts[0])) {
            solOut += u64(d, 4);
          }
        } else if (tag === 0 && d.length >= 12) {
          lines.push(tt`Создание счёта · ${fmt(u64(d, 4), 9)} SOL`);
          if (ours(ix.accounts[0])) {
            solOut += u64(d, 4);
          }
        } else if (tag === 3) {
          lines.push(tt`Создание счёта с seed`);
        } else if (tag === 1 || tag === 10) {
          lines.push(tt`System: смена владельца счёта (Assign)`);
          danger = true;
        } else if (tag === 4) {
          lines.push(tt`Durable nonce: подпись можно будет исполнить позже, в любой момент`);
          danger = true;
        } else if (tag === 5 || tag === 7) {
          lines.push(tag === 5 ? tt`Вывод из nonce-счёта` : tt`Смена владельца nonce-счёта`);
          danger = true;
        } else if (tag === 11) {
          lines.push(tt`Перевод SOL со счёта по seed`);
          danger = true;
        } else {
          lines.push(tt`System: инструкция ${tag}, кошелёк её не расшифровывает`);
          danger = true;
          unknown++;
        }
        continue;
      }
      if ((p === this.SOL_TOKEN || p === this.SOL_TOKEN_2022) && d.length >= 1) {
        const tag = d[0];
        const tok = mintIndex => {
          const mint = key(mintIndex);
          return tokens.find(t => t.mint === mint);
        };
        if (tag === 3 && d.length >= 9) {
          lines.push(tt`Перевод токена: ${u64(d, 1)} единиц со счёта ${name(ix.accounts[0])} → ${name(ix.accounts[1])}`);
          if (ours(ix.accounts[2])) {
            plainTokenOut += u64(d, 1);
          }
        } else if (tag === 12 && d.length >= 10) {
          const t = tok(ix.accounts[1]);
          const mint = key(ix.accounts[1]);
          if (mint && ours(ix.accounts[3])) {
            tokenOut.set(mint, (tokenOut.get(mint) || 0n) + u64(d, 1));
          }
          lines.push(tt`Перевод ${t ? `${fmt(u64(d, 1), t.decimals)} ${t.symbol}` : tt`${fmt(u64(d, 1), d[9])} токена ${short(key(ix.accounts[1]))}`} со счёта ${name(ix.accounts[0])} на токен-счёт ${name(ix.accounts[2])}`);
        } else if ((tag === 4 || tag === 13) && d.length >= 9) {
          const t = tag === 13 ? tok(ix.accounts[1]) : null;
          lines.push(tt`Approve: делегат ${name(ix.accounts[tag === 13 ? 2 : 1])} сможет тратить ${t ? `${fmt(u64(d, 1), t.decimals)} ${t.symbol}` : tt`${u64(d, 1)} единиц токена`}`);
          danger = true;
        } else if (tag === 6) {
          lines.push(tt`SetAuthority: смена владельца токен-счёта`);
          danger = true;
        } else if (tag === 9) {
          lines.push(tt`CloseAccount: закрытие токен-счёта, остаток уйдёт на ${name(ix.accounts[1])}`);
          danger = true;
        } else if (tag === 8 || tag === 15) {
          lines.push(tt`Burn: сжигание токенов`);
          danger = true;
        } else if (tag === 5) {
          lines.push(tt`Revoke: отзыв делегата`);
        } else if (tag === 7 || tag === 14) {
          lines.push(tt`MintTo: выпуск токенов`);
        } else if (tag === 38) {
          lines.push(tt`WithdrawExcessLamports: вывод SOL с токен-счёта`);
          danger = true;
        } else if (tag === 1 || tag === 16 || tag === 18) {
          lines.push(tt`Инициализация токен-счёта`);
        } else if (tag === 17) {
          lines.push(tt`SyncNative: синхронизация обёрнутого SOL`);
        } else {
          // прочие инструкции Token и расширения Token-2022 (комиссии, хуки, конфиденциальные переводы) не разбираются
          lines.push(tt`Token: инструкция ${tag}, кошелёк её не расшифровывает`);
          danger = true;
          unknown++;
        }
        continue;
      }
      if (p === this.SOL_ATA) {
        lines.push(tt`Создание токен-счёта (ATA)`);
        if (ours(ix.accounts[0])) {
          ataCreates++;
        }
        continue;
      }
      if (p === this.SOL_MEMO || p === this.SOL_MEMO_V1) {
        lines.push(`Memo: ${this.safeText(new TextDecoder().decode(d), 80).text}`);
        continue;
      }
      danger = true;
      unknown++;
      lines.push(tt`Программа ${p ? short(p) : tt`из таблицы адресов`}: ${ix.data.length} байт данных, не расшифрована`);
      } catch (e) {
        lines.push(tt`Инструкция с некорректными данными (${ix.program ? short(ix.program) : tt`программа из таблицы`})`);
        danger = true;
      }
    }
    if (parsed.lookups) {
      danger = true;
      lines.push(tt`Часть адресов берётся из ${parsed.lookups} таблиц(ы): их нельзя проверить заранее`);
    }
    return { lines, danger, unknown, feePayer: parsed.keys[0] === ourAddress, solOut, ataCreates, plainTokenOut, tokenOut };
  },

  SOL_MEMO: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  SOL_MEMO_V1: "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",

  async solSend(bytes, options = {}) {
    const r = await WalletStore.rpc("solana", { jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [base64.encode(bytes), { encoding: "base64", skipPreflight: !!options.skipPreflight, preflightCommitment: options.preflightCommitment || "confirmed", maxRetries: options.maxRetries }] });
    if (r.error) {
      throw new Error(r.error.message || "sendTransaction failed");
    }
    return r.result; // base58 signature
  },

  async solLatestBlockhash() {
    const r = await WalletStore.rpc("solana", { jsonrpc: "2.0", id: 1, method: "getLatestBlockhash", params: [{ commitment: "finalized" }] });
    return r.result.value.blockhash;
  },

  SOL_SYSTEM: "11111111111111111111111111111111",
  SOL_TOKEN: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  SOL_ATA: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",

  /** Associated Token Account: PDA от [owner, tokenProgram, mint] в программе ATA. */
  solAta(owner, mint, program = this.SOL_TOKEN) {
    const seeds = [base58.decode(owner), base58.decode(program), base58.decode(mint)];
    const programId = base58.decode(this.SOL_ATA);
    const marker = utf8ToBytes("ProgramDerivedAddress");
    for (let bump = 255; bump >= 0; bump--) {
      const parts = [...seeds, new Uint8Array([bump]), programId, marker];
      const buf = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let o = 0;
      for (const p of parts) {
        buf.set(p, o);
        o += p.length;
      }
      const hash = sha256(buf);
      let onCurve = true;
      try {
        ed25519.ExtendedPoint.fromHex(hash);
      } catch (e) {
        onCurve = false;
      }
      if (!onCurve) {
        return base58.encode(hash);
      }
    }
    throw new Error(tt`ATA не найден`);
  },

  /** Сборка legacy-сообщения: feePayer первым, затем остальные подписанты, writable, readonly. */
  solCompile(feePayer, instructions, blockhash) {
    const meta = new Map(); // pubkey → { signer, writable }
    const touch = (k, signer, writable) => {
      const m = meta.get(k) || { signer: false, writable: false };
      m.signer ||= signer;
      m.writable ||= writable;
      meta.set(k, m);
    };
    touch(feePayer, true, true);
    for (const ix of instructions) {
      touch(ix.programId, false, false);
      for (const k of ix.keys) {
        touch(k.pubkey, k.isSigner, k.isWritable);
      }
    }
    const all = [...meta.entries()].filter(([k]) => k !== feePayer);
    const sw = all.filter(([, m]) => m.signer && m.writable).map(([k]) => k);
    const sr = all.filter(([, m]) => m.signer && !m.writable).map(([k]) => k);
    const uw = all.filter(([, m]) => !m.signer && m.writable).map(([k]) => k);
    const ur = all.filter(([, m]) => !m.signer && !m.writable).map(([k]) => k);
    const keys = [feePayer, ...sw, ...sr, ...uw, ...ur];
    const header = new Uint8Array([1 + sw.length + sr.length, sr.length, ur.length]);
    const compact = n => (n < 128 ? new Uint8Array([n]) : new Uint8Array([(n & 0x7f) | 0x80, n >> 7]));
    const parts = [header, compact(keys.length), ...keys.map(k => base58.decode(k)), base58.decode(blockhash), compact(instructions.length)];
    for (const ix of instructions) {
      const idx = ix.keys.map(k => keys.indexOf(k.pubkey));
      parts.push(new Uint8Array([keys.indexOf(ix.programId)]), compact(idx.length), new Uint8Array(idx), compact(ix.data.length), ix.data);
    }
    const message = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      message.set(p, o);
      o += p.length;
    }
    const sigCount = header[0];
    const tx = new Uint8Array(1 + 64 * sigCount + message.length);
    tx[0] = sigCount;
    tx.set(message, 1 + 64 * sigCount);
    return tx;
  },

  /** Программа токена: только Token и Token-2022 (владельца mint сообщает RPC, ему на слово не верим). */
  solTokenProgram(program) {
    if (program !== this.SOL_TOKEN && program !== this.SOL_TOKEN_2022) {
      throw new Error(tt`Mint принадлежит неизвестной программе: перевод такого токена не поддерживается`);
    }
    return program;
  },

  /** Перевод SPL: при необходимости создаём ATA получателя (idempotent), затем TransferChecked. */
  solBuildTokenTransfer({ from, to, mint, amount, blockhash, program = this.SOL_TOKEN, fromAta, toAta, createAta, decimals }) {
    program = this.solTokenProgram(program);
    // адреса счетов пересчитываем сами: план мог прийти с подменёнными ATA
    if ((fromAta && fromAta !== this.solAta(from, mint, program)) || (toAta && toAta !== this.solAta(to, mint, program))) {
      throw new Error(tt`Счёт токена не совпадает с адресом: пересчитайте перевод`);
    }
    fromAta ||= this.solAta(from, mint, program);
    toAta ||= this.solAta(to, mint, program);
    const ixs = [];
    if (createAta) {
      ixs.push({
        programId: this.SOL_ATA,
        keys: [
          { pubkey: from, isSigner: true, isWritable: true },
          { pubkey: toAta, isSigner: false, isWritable: true },
          { pubkey: to, isSigner: false, isWritable: false },
          { pubkey: mint, isSigner: false, isWritable: false },
          { pubkey: this.SOL_SYSTEM, isSigner: false, isWritable: false },
          { pubkey: program, isSigner: false, isWritable: false },
        ],
        data: new Uint8Array([1]),
      });
    }
    const data = new Uint8Array(10);
    data[0] = 12;
    new DataView(data.buffer).setBigUint64(1, BigInt(amount), true);
    data[9] = decimals;
    ixs.push({
      programId: program,
      keys: [
        { pubkey: fromAta, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: toAta, isSigner: false, isWritable: true },
        { pubkey: from, isSigner: true, isWritable: false },
      ],
      data,
    });
    return this.solCompile(from, ixs, blockhash);
  },

  /** Перевод SOL: собираем legacy-транзакцию SystemProgram.transfer вручную. */
  solBuildTransfer(from, to, lamports, blockhash) {
    const data = new Uint8Array(12);
    new DataView(data.buffer).setUint32(0, 2, true);
    new DataView(data.buffer).setBigUint64(4, BigInt(lamports), true);
    return this.solCompile(from, [{ programId: this.SOL_SYSTEM, keys: [{ pubkey: from, isSigner: true, isWritable: true }, { pubkey: to, isSigner: false, isWritable: true }], data }], blockhash);
  },

  /* ---------- Служебное ---------- */

  async withKey(walletId, index, chainId, fn) {
    const priv = await WalletStore.privateKeyFor(walletId, index, chainId);
    try {
      return await fn(priv);
    } finally {
      wipe(priv);
    }
  },

  hexPriv(priv) {
    return "0x" + bytesToHex(priv);
  },

  /** Экранирует невидимые и управляющие направлением символы (RTL, zero-width) для показа. */
  safeText(text, max = 4000) {
    let hidden = 0;
    let str = String(text);
    if (str.length > max) {
      str = str.slice(0, max) + "…";
    }
    const out = str.replace(/[\p{Cf}\u2028\u2029]|[\p{Cc}&&[^\n\t]]/gv, ch => {
      hidden++;
      return `\\u{${ch.codePointAt(0).toString(16)}}`;
    });
    return { text: out, hidden };
  },

  utf8OrHex(message) {
    if (typeof message === "string" && /^0x[0-9a-fA-F]*$/.test(message)) {
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(hexToBytes(message.slice(2)));
        if (/^[\x20-\x7e\s -￿]*$/.test(text)) {
          return text;
        }
      } catch (e) {}
    }
    return String(message);
  },

  hex0x,
  toBig,
  solPubkeyBytes(address) {
    return Array.from(base58.decode(address));
  },
};
