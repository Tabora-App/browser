/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Подписи и отправка: EVM (EIP-1559, personal_sign, EIP-712), TRON (транзакции и сообщения),
 * Solana (сообщения и транзакции). Приватный ключ приходит из WalletStore.privateKeyFor
 * и обнуляется здесь сразу после подписи. */

const { setTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
const C = ChromeUtils.importESModule("chrome://browser/content/tabora/wallet/vendor/crypto.sys.mjs");
const { WalletStore, CHAINS } = ChromeUtils.importESModule("chrome://browser/content/tabora/wallet/WalletStore.sys.mjs");
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
    const priority = tx.maxPriorityFeePerGas ? toBig(tx.maxPriorityFeePerGas) : toBig(priorityHex);
    const maxFee = tx.maxFeePerGas ? toBig(tx.maxFeePerGas) : tx.gasPrice ? toBig(tx.gasPrice) : baseFee * 2n + priority;
    let gasLimit;
    if (tx.gas || tx.gasLimit) {
      gasLimit = toBig(tx.gas || tx.gasLimit);
    } else {
      const est = await WalletStore.evm(chainId, "eth_estimateGas", [{ from, to: tx.to, value: tx.value || "0x0", data: tx.data || tx.input || "0x" }]);
      gasLimit = (toBig(est) * 120n) / 100n;
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
    return { prepared, fee: gasLimit * maxFee, feeLikely: gasLimit * (baseFee + priority), baseFee, value };
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

  /** Человекочитаемый разбор calldata: ERC-20 transfer/approve и известные контракты. */
  evmDecode(to, data, value) {
    if (!data || data === "0x") {
      return null;
    }
    const sel = data.slice(0, 10).toLowerCase();
    const word = i => "0x" + data.slice(10 + i * 64, 10 + (i + 1) * 64);
    const addrOf = i => "0x" + word(i).slice(-40);
    const num = i => toBig(word(i));
    const MAX = (1n << 256n) - 1n;
    if (sel === "0xa9059cbb") {
      return { kind: "transfer", to: addrOf(0), amount: num(1) };
    }
    if (sel === "0x095ea7b3") {
      const amount = num(1);
      return { kind: "approve", spender: addrOf(0), amount, unlimited: amount >= MAX / 2n };
    }
    if (sel === "0x23b872dd") {
      return { kind: "transferFrom", from: addrOf(0), to: addrOf(1), amount: num(2) };
    }
    if (sel === "0x2e1a7d4d") {
      return { kind: "withdraw", amount: num(0) };
    }
    if (sel === "0xd0e30db0") {
      return { kind: "deposit" };
    }
    try {
      const d = ethDecodeData(to, data, toBig(value || 0));
      if (d) {
        return { kind: "known", text: typeof d === "string" ? d : JSON.stringify(d, (k, v) => (typeof v === "bigint" ? v.toString() : v)) };
      }
    } catch (e) {}
    return { kind: "unknown", selector: sel };
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
  async tronPost(path, body) {
    let lastError = null;
    for (const node of this.tronNodes()) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await fetch(node + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
          if (res.status === 429 && attempt === 0) {
            await new Promise(r => setTimeout(r, 900));
            continue;
          }
          if (!res.ok) {
            throw new Error(`TRON ${new URL(node).host}: HTTP ${res.status}`);
          }
          return await res.json();
        } catch (e) {
          lastError = e;
          break;
        }
      }
    }
    throw lastError || new Error("TRON: нода недоступна");
  },

  tronRecoverableSig(hash, priv) {
    const sig = secp256k1.sign(hash, priv);
    const bytes = new Uint8Array(65);
    bytes.set(sig.toCompactRawBytes(), 0);
    bytes[64] = (sig.recovery ?? 0) + 27;
    return bytesToHex(bytes);
  },

  tronSignTx(tx, priv) {
    const txID = tx.txID || bytesToHex(sha256(hexToBytes(tx.raw_data_hex)));
    const signature = this.tronRecoverableSig(hexToBytes(txID), priv);
    return { ...tx, txID, signature: [...(tx.signature || []), signature] };
  },

  tronSignMessageV2(message, priv) {
    const bytes = typeof message === "string" && /^0x[0-9a-fA-F]*$/.test(message) ? hexToBytes(message.slice(2)) : utf8ToBytes(String(message));
    const prefix = utf8ToBytes(`\x19TRON Signed Message:\n${bytes.length}`);
    const all = new Uint8Array(prefix.length + bytes.length);
    all.set(prefix, 0);
    all.set(bytes, prefix.length);
    return "0x" + this.tronRecoverableSig(keccak_256(all), priv);
  },

  tronSignMessageV1(hexMessage, priv) {
    const bytes = hexToBytes(String(hexMessage).replace(/^0x/, ""));
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

  async tronBroadcast(signed) {
    const r = await this.tronPost("/wallet/broadcasttransaction", signed);
    if (r.result !== true) {
      throw new Error(r.message ? new TextDecoder().decode(hexToBytes(r.message)) : r.code || "broadcast failed");
    }
    return { result: true, txid: signed.txID, transaction: signed };
  },

  async tronBuildSendTrx(to, amountSun, from) {
    const r = await this.tronPost("/wallet/createtransaction", { to_address: to, owner_address: from, amount: Number(amountSun), visible: true });
    if (r.Error) {
      throw new Error(r.Error);
    }
    return r;
  },

  async tronTriggerSmartContract(contract, selector, options, params, issuer) {
    // params: [{ type, value }] → ABI-кодирование простых типов
    const enc = (params || []).map(p => this.abiEncodeParam(p.type, p.value)).join("");
    const body = {
      owner_address: issuer,
      contract_address: contract,
      function_selector: selector,
      parameter: enc,
      fee_limit: options?.feeLimit || 100000000,
      call_value: options?.callValue || 0,
      visible: true,
    };
    const r = await this.tronPost("/wallet/triggersmartcontract", body);
    if (!r.result?.result) {
      throw new Error(r.result?.message ? new TextDecoder().decode(hexToBytes(r.result.message)) : "triggersmartcontract failed");
    }
    return r;
  },

  abiEncodeParam(type, value) {
    if (type === "address") {
      const hex = /^T/.test(value) ? this.tronHexAddress(value).slice(2) : String(value).replace(/^0x/, "").replace(/^41/, "");
      return hex.padStart(64, "0");
    }
    if (/^u?int\d*$/.test(type)) {
      let v = toBig(value);
      if (v < 0n) {
        v = (1n << 256n) + v;
      }
      return v.toString(16).padStart(64, "0");
    }
    if (type === "bool") {
      return (value ? "1" : "0").padStart(64, "0");
    }
    if (/^bytes32$/.test(type)) {
      return String(value).replace(/^0x/, "").padEnd(64, "0");
    }
    throw new Error(`Тип ${type} пока не поддержан`);
  },

  /* ---------- Solana ---------- */

  solSignMessage(bytes, priv) {
    return ed25519.sign(bytes, priv);
  },

  /** Разбор сериализованной транзакции: подписи, сообщение, ключи. */
  solParse(bytes) {
    let o = 0;
    const readCompact = () => {
      let len = 0;
      let size = 0;
      for (;;) {
        const b = bytes[o++];
        len |= (b & 0x7f) << (size * 7);
        size++;
        if (!(b & 0x80)) {
          break;
        }
      }
      return len;
    };
    const sigCount = readCompact();
    const sigStart = o;
    o += sigCount * 64;
    const msgStart = o;
    let m = o;
    let version = "legacy";
    if (bytes[m] & 0x80) {
      version = bytes[m] & 0x7f;
      m++;
    }
    const numRequired = bytes[m];
    m += 3;
    let p = m;
    let keysLen = 0;
    let size = 0;
    for (;;) {
      const b = bytes[p++];
      keysLen |= (b & 0x7f) << (size * 7);
      size++;
      if (!(b & 0x80)) {
        break;
      }
    }
    const keys = [];
    for (let i = 0; i < keysLen; i++) {
      keys.push(base58.encode(bytes.slice(p + i * 32, p + (i + 1) * 32)));
    }
    return { sigCount, sigStart, msgStart, message: bytes.slice(msgStart), keys, numRequired, version };
  },

  solSignTransaction(bytes, priv, address) {
    const parsed = this.solParse(bytes);
    const index = parsed.keys.indexOf(address);
    if (index === -1 || index >= parsed.sigCount) {
      throw new Error("Транзакция не требует подписи этого адреса");
    }
    const sig = ed25519.sign(parsed.message, priv);
    const out = new Uint8Array(bytes);
    out.set(sig, parsed.sigStart + index * 64);
    return out;
  },

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
    throw new Error("ATA не найден");
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

  /** Перевод SPL: при необходимости создаём ATA получателя (idempotent), затем TransferChecked. */
  solBuildTokenTransfer({ from, to, mint, amount, blockhash, program = this.SOL_TOKEN, fromAta, toAta, createAta, decimals }) {
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
