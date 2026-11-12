/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Шифрование писем (OpenPGP) в веб-версии. Правила те же, что в браузере Tabora (mail/Pgp.sys.mjs):
 * письма между адресами Tabora шифруются и подписываются, ключ получателя берётся из каталога
 * ключей сервера, свои письма несут открытый ключ в заголовке Autocrypt.
 *
 * Отличие от браузера: веб-версия не ведёт своей записной книжки чужих ключей. Ключи адресов
 * Tabora она каждый раз берёт из каталога; ключей внешних адресов у неё нет, поэтому письмо на
 * внешний адрес отсюда уходит открытым, а подпись внешнего отправителя остаётся непроверенной. */

import { b64, fromB64 } from "./bytes.js";
import { armorBody, pgpCall } from "./pgp.js";
import { t } from "./i18n.js";

const DIRECTORY_FRESH_MS = 10 * 60 * 1000;
const clean = address => String(address || "").trim().toLowerCase();

function fail(message, code = "pgp") {
  return Object.assign(new Error(message), { code });
}

function armorKey(base64) {
  return `-----BEGIN PGP PUBLIC KEY BLOCK-----\n\n${base64.replace(/(.{64})/g, "$1\n").trim()}\n-----END PGP PUBLIC KEY BLOCK-----\n`;
}

/** z-base-32 от SHA-1 имени ящика: имя записи в каталоге ключей (WKD). */
async function directoryHash(local) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(local)));
  const abc = "ybndrfg8ejkmcpqxot1uwisza345h769";
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const b of digest) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += abc[(acc >> bits) & 31];
    }
    acc &= (1 << bits) - 1;
  }
  return bits ? out + abc[(acc << (5 - bits)) & 31] : out;
}

export class MailPgp {
  /** @param {import("./account.js").Account} account */
  constructor(account) {
    this.account = account;
    this.peers = new Map(); // адрес → { publicKey, keyId, subkeyIds, fingerprint, at } | { missing: true, at }
    this._own = null;
  }

  get ready() {
    return this.account.keys?.state === "ok" && !!this.account.keys.privateKey;
  }

  /** Свой ключ: { address, publicKey, privateKey, keyId, subkeyIds, fingerprint } или null. */
  async own() {
    const k = this.account.keys;
    if (!this.ready) {
      return null;
    }
    if (this._own?.fingerprint === k.fingerprint) {
      return this._own;
    }
    const { keys } = await pgpCall("info", { armored: k.publicKey });
    const info = keys?.[0];
    if (!info) {
      return null;
    }
    this._own = { address: clean(this.account.email), publicKey: k.publicKey, privateKey: k.privateKey, keyId: info.keyId, subkeyIds: info.subkeyIds || [], fingerprint: info.fingerprint };
    return this._own;
  }

  /** Ключи адресов Tabora из каталога. Чужие домены пропускаются: их ключей у веб-версии нет. */
  async lookup(addresses) {
    const own = clean(this.account.email);
    const now = Date.now();
    const todo = [...new Set((addresses || []).map(clean))].filter(a => {
      const [local, host, extra] = a.split("@");
      const k = this.peers.get(a);
      return local && host === this.account.domain && extra === undefined && a !== own && !(k && now - k.at < DIRECTORY_FRESH_MS);
    });
    await Promise.all(todo.slice(0, 20).map(async a => {
      try {
        const local = a.split("@")[0];
        const bytes = await this.account.api.directoryKey(local, await directoryHash(local));
        if (!bytes) {
          this.peers.set(a, { missing: true, at: now });
          return;
        }
        const armored = armorKey(b64(bytes));
        const { keys } = await pgpCall("info", { armored });
        const info = keys?.[0];
        if (!info || info.revoked || info.expired || !info.canEncrypt || (info.emails.length && !info.emails.includes(a))) {
          this.peers.set(a, { missing: true, at: now });
          return;
        }
        this.peers.set(a, { publicKey: info.armored, keyId: info.keyId, subkeyIds: info.subkeyIds || [], fingerprint: info.fingerprint, at: now });
      } catch (e) {
        // каталог недоступен: не запоминаем промах, следующий запрос спросит снова
      }
    }));
  }

  _peer(address) {
    const k = this.peers.get(clean(address));
    return k && !k.missing ? k : null;
  }

  /** Можно ли зашифровать письмо этим получателям: { possible, missing }. */
  async plan(addresses) {
    const list = [...new Set((addresses || []).map(clean).filter(Boolean))];
    const mine = await this.own();
    if (!mine || !list.length) {
      return { possible: false, missing: list };
    }
    await this.lookup(list);
    const missing = list.filter(a => a !== mine.address && !this._peer(a));
    return { possible: !missing.length, missing };
  }

  /** Зашифровать и подписать байты части письма для получателей и для себя. Возвращает броню. */
  async encrypt(bytes, addresses) {
    const mine = await this.own();
    if (!mine) {
      throw fail(t`Ключ шифрования аккаунта на этом устройстве закрыт`);
    }
    const keys = [mine.publicKey];
    await this.lookup(addresses);
    for (const a of [...new Set((addresses || []).map(clean).filter(Boolean))]) {
      if (a === mine.address) {
        continue;
      }
      const k = this._peer(a);
      if (!k) {
        throw fail(t`Нет ключа получателя ${a}: письмо нельзя зашифровать`, "no-key");
      }
      keys.push(k.publicKey);
    }
    const r = await pgpCall("encrypt", { data: b64(bytes), recipients: keys, signer: mine.privateKey });
    if (typeof r.armored !== "string" || !r.armored.startsWith("-----BEGIN PGP MESSAGE-----")) {
      throw fail(t`Письмо не зашифровано`);
    }
    return r.armored;
  }

  _signer(keyId, mine) {
    const has = k => k.keyId === keyId || (k.subkeyIds || []).includes(keyId);
    if (mine && has(mine)) {
      return { address: mine.address };
    }
    for (const [address, k] of this.peers) {
      if (!k.missing && has(k)) {
        return { address };
      }
    }
    return null;
  }

  /** Итог проверки подписи письма от from: { state: valid | other | invalid | unknown | none, address }. */
  _verdict(signatures, from, mine) {
    const list = Array.isArray(signatures) ? signatures.filter(s => s && typeof s === "object") : [];
    if (!list.length) {
      return { state: "none" };
    }
    const sender = clean(from);
    let best = { state: "unknown" };
    for (const s of list) {
      const who = /^[0-9a-f]{16}$/.test(s.keyId || "") ? this._signer(s.keyId, mine) : null;
      if (s.valid === false && who) {
        return { state: "invalid", ...who };
      }
      if (s.valid === true && who) {
        const verdict = { state: !sender || who.address === sender ? "valid" : "other", ...who };
        if (verdict.state === "valid") {
          return verdict;
        }
        best = verdict;
      }
    }
    return best;
  }

  async _verifiers(from, mine) {
    await this.lookup([from]);
    const keys = mine ? [mine.publicKey] : [];
    const peer = this._peer(from);
    if (peer) {
      keys.push(peer.publicKey);
    }
    return keys;
  }

  /** Расшифровать броню письма от from: { bytes, signature }. Ошибка с кодом "locked" (ключ закрыт),
   * "no-key" (зашифровано не нам) или "pgp". */
  async decrypt(armored, { from = "" } = {}) {
    const mine = await this.own();
    if (!mine) {
      throw fail(t`Ключ шифрования аккаунта на этом устройстве закрыт`, "locked");
    }
    let r;
    try {
      r = await pgpCall("decrypt", { armored: String(armored), keys: [mine.privateKey], verifiers: await this._verifiers(from, mine) });
    } catch (e) {
      const noKey = /no decryption key|session key decryption failed/i.test(e.message || "");
      throw fail(noKey ? t`Письмо зашифровано не для этого аккаунта` : t`Письмо не расшифровано: оно повреждено или зашифровано неизвестным способом`, noKey ? "no-key" : "pgp");
    }
    if (typeof r.data !== "string") {
      throw fail(t`Письмо не расшифровано`);
    }
    return { bytes: fromB64(r.data), signature: this._verdict(r.signatures, from, mine) };
  }

  /** Проверить отсоединённую подпись части письма от from. */
  async verify(bytes, signature, from) {
    try {
      const mine = await this.own();
      const r = await pgpCall("verify", { data: b64(bytes), signature: String(signature), verifiers: await this._verifiers(from, mine) });
      return this._verdict(r.signatures, from, mine);
    } catch (e) {
      return { state: "unknown" };
    }
  }

  /** Значение заголовка Autocrypt для своих писем или "". */
  async autocryptHeader() {
    const mine = await this.own();
    const body = mine ? armorBody(mine.publicKey) : "";
    return body ? `addr=${mine.address}; prefer-encrypt=mutual; keydata=${body}` : "";
  }
}
