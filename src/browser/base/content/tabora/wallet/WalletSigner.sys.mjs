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

  /** Подпись транзакции: txID всегда считается из raw_data_hex; чужой txID не принимается. */
  tronSignTx(tx, priv) {
    if (typeof tx?.raw_data_hex !== "string" || !/^[0-9a-fA-F]+$/.test(tx.raw_data_hex)) {
      throw new Error("Транзакция без raw_data_hex");
    }
    const txID = bytesToHex(sha256(hexToBytes(tx.raw_data_hex)));
    if (tx.txID && String(tx.txID).toLowerCase() !== txID) {
      throw new Error("txID не совпадает с raw_data_hex: транзакция подменена");
    }
    const signature = this.tronRecoverableSig(hexToBytes(txID), priv);
    return { ...tx, txID, raw_data: this.tronRawToJson(this.tronDecodeRaw(tx.raw_data_hex)), signature: [...(tx.signature || []), signature] };
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
    if (bytes.length !== 32) {
      throw new Error("Для старой подписи TRON нужен хеш из 32 байт");
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
    throw new Error("Неверный адрес TRON");
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
          throw new Error("protobuf: обрыв");
        }
        const b = buf[o++];
        v |= BigInt(b & 0x7f) << shift;
        shift += 7n;
        if (!(b & 0x80)) {
          return v;
        }
      }
      throw new Error("protobuf: varint слишком длинный");
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
          throw new Error("protobuf: длина за границей");
        }
        fields.push({ field, wt, value: buf.slice(o, o + len) });
        o += len;
      } else if (wt === 1) {
        fields.push({ field, wt, value: buf.slice(o, o + 8) });
        o += 8;
      } else if (wt === 5) {
        fields.push({ field, wt, value: buf.slice(o, o + 4) });
        o += 4;
      } else {
        throw new Error(`protobuf: неизвестный тип поля ${wt}`);
      }
    }
    return fields;
  },

  TRON_TYPES: { 0: "AccountCreateContract", 1: "TransferContract", 2: "TransferAssetContract", 4: "VoteWitnessContract", 11: "FreezeBalanceContract", 12: "UnfreezeBalanceContract", 13: "WithdrawBalanceContract", 31: "TriggerSmartContract", 54: "FreezeBalanceV2Contract", 55: "UnfreezeBalanceV2Contract", 57: "DelegateResourceContract", 58: "UnDelegateResourceContract" },

  /** Декодирует Transaction.raw из hex: именно это и подписывается. */
  tronDecodeRaw(hex) {
    const raw = this.pbDecode(hexToBytes(String(hex).replace(/^0x/, "")));
    const one = (fields, n) => fields.find(f => f.field === n)?.value;
    const out = {
      refBlockBytes: one(raw, 1) ? bytesToHex(one(raw, 1)) : "",
      refBlockHash: one(raw, 4) ? bytesToHex(one(raw, 4)) : "",
      expiration: Number(one(raw, 8) ?? 0n),
      timestamp: Number(one(raw, 14) ?? 0n),
      feeLimit: Number(one(raw, 18) ?? 0n),
      data: one(raw, 10) ? new TextDecoder().decode(one(raw, 10)) : "",
      contracts: [],
    };
    for (const c of raw.filter(f => f.field === 11)) {
      const cf = this.pbDecode(c.value);
      const type = Number(one(cf, 1) ?? 0n);
      const anyBytes = one(cf, 2);
      const any = anyBytes ? this.pbDecode(anyBytes) : [];
      const typeUrl = one(any, 1) ? new TextDecoder().decode(one(any, 1)) : "";
      const pf = one(any, 2) ? this.pbDecode(one(any, 2)) : [];
      const addr = v => (v && v.length === 21 ? b58check.encode(v) : v ? bytesToHex(v) : null);
      const entry = { type, typeName: this.TRON_TYPES[type] || typeUrl.split(".").pop() || `type ${type}`, permissionId: Number(one(cf, 5) ?? 0n) };
      if (type === 1) {
        entry.owner = addr(one(pf, 1));
        entry.to = addr(one(pf, 2));
        entry.amount = one(pf, 3) ?? 0n;
      } else if (type === 2) {
        entry.assetName = one(pf, 1) ? new TextDecoder().decode(one(pf, 1)) : "";
        entry.owner = addr(one(pf, 2));
        entry.to = addr(one(pf, 3));
        entry.amount = one(pf, 4) ?? 0n;
      } else if (type === 31) {
        entry.owner = addr(one(pf, 1));
        entry.contractAddress = addr(one(pf, 2));
        entry.callValue = one(pf, 3) ?? 0n;
        entry.data = one(pf, 4) ? "0x" + bytesToHex(one(pf, 4)) : "0x";
      } else {
        entry.owner = addr(one(pf, 1));
        entry.raw = anyBytes ? bytesToHex(anyBytes) : "";
      }
      out.contracts.push(entry);
    }
    return out;
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
      throw new Error("TRON: нода не вернула блок");
    }
    if (Math.abs(Date.now() - timestamp) > 10 * 60 * 1000) {
      throw new Error("TRON: нода отдаёт устаревший блок");
    }
    return { refBlockBytes: number.toString(16).padStart(16, "0").slice(12, 16), refBlockHash: b.blockID.slice(16, 32), timestamp };
  },

  /** Локальная сборка Transaction.raw: ref-блок берём у ноды, всё остальное — наше. */
  async tronBuildRaw(contract, { feeLimit = 0 } = {}) {
    const block = await this.tronNowBlock();
    let param;
    let type;
    let name;
    if (contract.kind === "transfer") {
      type = 1;
      name = "TransferContract";
      param = this.pbConcat([this.pbBytes(1, this.tronAddrBytes(contract.owner)), this.pbBytes(2, this.tronAddrBytes(contract.to)), this.pbUint(3, contract.amount)]);
    } else if (contract.kind === "trigger") {
      type = 31;
      name = "TriggerSmartContract";
      param = this.pbConcat([
        this.pbBytes(1, this.tronAddrBytes(contract.owner)),
        this.pbBytes(2, this.tronAddrBytes(contract.contractAddress)),
        this.pbUint(3, contract.callValue || 0),
        this.pbBytes(4, hexToBytes(String(contract.data).replace(/^0x/, ""))),
      ]);
    } else {
      throw new Error("Неизвестный тип контракта");
    }
    const any = this.pbConcat([this.pbBytes(1, utf8ToBytes(`type.googleapis.com/protocol.${name}`)), this.pbBytes(2, param)]);
    const contractMsg = this.pbConcat([this.pbUint(1, type), this.pbBytes(2, any)]);
    const now = Date.now();
    const raw = this.pbConcat([
      this.pbBytes(1, hexToBytes(block.refBlockBytes)),
      this.pbBytes(4, hexToBytes(block.refBlockHash)),
      this.pbUint(8, block.timestamp + 60 * 1000),
      this.pbBytes(11, contractMsg),
      this.pbUint(14, now),
      this.pbUint(18, feeLimit),
    ]);
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
      throw new Error(sim.result?.message ? new TextDecoder().decode(hexToBytes(sim.result.message)) : "контракт отклонил вызов");
    }
    return BigInt(sim.energy_used || 65000);
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
    if (this.solLooksLikeMessage(bytes)) {
      throw new Error("Сообщение является транзакцией Solana: подпись отклонена");
    }
    return ed25519.sign(bytes, priv);
  },

  SOL_LIMITS: { sigs: 16, keys: 256, ixs: 128, accounts: 256 },

  /** Разбор Message (без подписей). Бросает при нарушении формата или лимитов. */
  solParseMessage(bytes, offset = 0) {
    let o = offset;
    const need = n => {
      if (o + n > bytes.length) {
        throw new Error("Solana: обрыв данных");
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
          throw new Error("Solana: длина слишком велика");
        }
      }
      if (len > max) {
        throw new Error("Solana: превышен лимит");
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
      throw new Error("Solana: неверный заголовок");
    }
    const keysLen = compact(this.SOL_LIMITS.keys);
    if (keysLen < numRequired || keysLen < numReadonlySigned + numRequired) {
      throw new Error("Solana: заголовок не согласуется с ключами");
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
        throw new Error("Solana: обрыв данных");
      }
      const b = bytes[o++];
      sigCount |= (b & 0x7f) << (size * 7);
      size++;
      if (!(b & 0x80)) {
        break;
      }
      if (size > 2) {
        throw new Error("Solana: слишком много подписей");
      }
    }
    if (sigCount < 1 || sigCount > this.SOL_LIMITS.sigs || o + sigCount * 64 > bytes.length) {
      throw new Error("Solana: неверное число подписей");
    }
    const sigStart = o;
    o += sigCount * 64;
    const msgStart = o;
    const msg = this.solParseMessage(bytes, msgStart);
    if (msg.numRequired !== sigCount) {
      throw new Error("Solana: число подписей не совпадает с заголовком");
    }
    if (msg.end !== bytes.length) {
      throw new Error("Solana: лишние данные после сообщения");
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
      throw new Error("Транзакция не требует подписи этого адреса");
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
    const short = a => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "?");
    const key = i => (i < parsed.keys.length ? parsed.keys[i] : null);
    const name = i => {
      const k = key(i);
      return k === ourAddress ? "ваш адрес" : k ? short(k) : "адрес из таблицы";
    };
    const u64 = (d, off) => new DataView(d.buffer, d.byteOffset).getBigUint64(off, true);
    const fmt = (raw, dec) => WalletStore.format(raw, dec, 6);
    for (const ix of parsed.instructions) {
      const p = ix.program;
      const d = ix.data;
      if (p === this.SOL_COMPUTE) {
        continue;
      }
      if (p === this.SOL_SYSTEM && d.length >= 4) {
        const tag = new DataView(d.buffer, d.byteOffset).getUint32(0, true);
        if (tag === 2 && d.length >= 12) {
          lines.push(`Перевод ${fmt(u64(d, 4), 9)} SOL: ${name(ix.accounts[0])} → ${name(ix.accounts[1])}`);
        } else if (tag === 0 || tag === 3) {
          lines.push(`Создание счёта${d.length >= 12 ? ` · ${fmt(u64(d, 4), 9)} SOL` : ""}`);
        } else if (tag === 1) {
          lines.push("System: смена владельца счёта (Assign)");
          danger = true;
        } else {
          lines.push(`System: инструкция ${tag}`);
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
          lines.push(`Перевод токена: ${u64(d, 1)} единиц со счёта ${name(ix.accounts[0])} → ${name(ix.accounts[1])}`);
        } else if (tag === 12 && d.length >= 10) {
          const t = tok(ix.accounts[1]);
          lines.push(`Перевод ${t ? `${fmt(u64(d, 1), t.decimals)} ${t.symbol}` : `${fmt(u64(d, 1), d[9])} токена ${short(key(ix.accounts[1]))}`} → владелец счёта ${name(ix.accounts[2])}`);
        } else if (tag === 4 || tag === 13) {
          const t = tag === 13 ? tok(ix.accounts[1]) : null;
          lines.push(`Approve: делегат ${name(ix.accounts[tag === 13 ? 2 : 1])} сможет тратить ${t ? `${fmt(u64(d, 1), t.decimals)} ${t.symbol}` : `${u64(d, 1)} единиц токена`}`);
          danger = true;
        } else if (tag === 6) {
          lines.push("SetAuthority: смена владельца токен-счёта");
          danger = true;
        } else if (tag === 9) {
          lines.push(`CloseAccount: закрытие токен-счёта, остаток уйдёт на ${name(ix.accounts[1])}`);
          danger = true;
        } else if (tag === 8 || tag === 15) {
          lines.push("Burn: сжигание токенов");
          danger = true;
        } else if (tag === 5) {
          lines.push("Revoke: отзыв делегата");
        } else if (tag === 7 || tag === 14) {
          lines.push("MintTo: выпуск токенов");
        } else {
          lines.push(`Token: инструкция ${tag}`);
        }
        continue;
      }
      if (p === this.SOL_ATA) {
        lines.push("Создание токен-счёта (ATA)");
        continue;
      }
      lines.push(`Программа ${p ? short(p) : "из таблицы"}: ${ix.data.length} байт данных`);
    }
    if (parsed.lookups) {
      lines.push(`Часть адресов берётся из ${parsed.lookups} таблиц(ы): их нельзя проверить заранее`);
    }
    return { lines, danger, feePayer: parsed.keys[0] === ourAddress };
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

  /** Экранирует невидимые и управляющие направлением символы (RTL, zero-width) для показа. */
  safeText(text) {
    let hidden = 0;
    const out = String(text).replace(/[\p{Cf}\u2028\u2029]/gu, ch => {
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
