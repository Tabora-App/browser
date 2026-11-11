/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Операции OpenPGP (их выполняет рабочий поток, см. pgp.worker.js). Библиотека OpenPGP.js (LGPL, без изменений, та же версия,
 * что в браузере Tabora) работает отдельно от страницы: у потока нет доступа к документу, а сети
 * ему не даёт политика содержимого. Операции перенесены без изменений из
 * src/browser/base/content/tabora/mail/pgp/host.mjs (их сверяет tools/web/test/parity.mjs).
 *
 * Обмен: { id, method, args } → { id, ok: true, value } либо { id, ok: false, error }. Двоичные
 * данные передаются в Base64. Письма шифруются и подписываются как двоичные данные: текстовый
 * режим OpenPGP меняет концы строк, и подпись части письма перестала бы сходиться. */

import * as openpgp from "openpgp";

const HASH = { 8: "sha256", 9: "sha384", 10: "sha512", 11: "sha224", 12: "sha3-256", 14: "sha3-512" };

function encode64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function decode64(text) {
  const bin = atob(String(text || ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

async function publicKeys(list) {
  const out = [];
  for (const armored of list || []) {
    for (const key of await openpgp.readKeys({ armoredKeys: armored })) {
      out.push(key.isPrivate() ? key.toPublic() : key);
    }
  }
  return out;
}

/** Сведения о ключе: по ним оболочка решает, можно ли шифровать этому человеку. */
async function describe(key) {
  const pub = key.isPrivate() ? key.toPublic() : key;
  let expires = null;
  try {
    const t = await pub.getExpirationTime();
    expires = t instanceof Date ? t.toISOString() : null;
  } catch (e) {}
  const can = async fn => {
    try {
      await fn();
      return true;
    } catch (e) {
      return false;
    }
  };
  return {
    fingerprint: pub.getFingerprint(),
    keyId: pub.getKeyID().toHex(),
    subkeyIds: pub.getSubkeys().map(s => s.getKeyID().toHex()),
    created: pub.getCreationTime().toISOString(),
    expires,
    expired: !!expires && new Date(expires) < new Date(),
    revoked: await pub.isRevoked().catch(() => false),
    algorithm: pub.getAlgorithmInfo(),
    users: pub.getUserIDs().slice(0, 16),
    emails: pub.users.map(u => u.userID?.email || "").filter(Boolean).map(e => e.toLowerCase()).slice(0, 16),
    canEncrypt: await can(() => pub.getEncryptionKey()),
    canSign: await can(() => pub.getSigningKey()),
    private: key.isPrivate(),
    armored: pub.armor(),
  };
}

/** Итог проверки подписей: valid true — верна, false — неверна, null — ключа подписавшего нет. */
async function verdicts(signatures) {
  const out = [];
  for (const s of signatures || []) {
    const v = { keyId: s.keyID.toHex(), valid: null, created: null, error: "" };
    try {
      await s.verified;
      v.valid = true;
      const sig = await s.signature;
      v.created = sig.packets[0]?.created?.toISOString?.() || null;
    } catch (e) {
      const text = String(e?.message || e);
      v.valid = /could not find signing key/i.test(text) ? null : false;
      v.error = text.slice(0, 200);
    }
    out.push(v);
  }
  return out;
}

export const API = {
  async ping() {
    return { version: openpgp.config.versionString || "" };
  },

  /** Новый ключ: Ed25519 для подписи и Curve25519 для шифрования в формате, который читают
   * GnuPG, Thunderbird и остальные (ключи версии 4). */
  async generate({ name = "", email }) {
    const userIDs = [name ? { name, email } : { email }];
    const { privateKey, publicKey } = await openpgp.generateKey({ type: "ecc", curve: "curve25519Legacy", userIDs, format: "armored" });
    return { privateKey, publicKey, info: await describe(await openpgp.readKey({ armoredKey: publicKey })) };
  },

  async info({ armored }) {
    const keys = await openpgp.readKeys({ armoredKeys: armored });
    return { keys: await Promise.all(keys.map(describe)) };
  },

  async encrypt({ data, recipients, signer = "" }) {
    const encryptionKeys = await publicKeys(recipients);
    if (!encryptionKeys.length) {
      throw new Error("нет ключей получателей");
    }
    const signingKeys = signer ? await openpgp.readPrivateKey({ armoredKey: signer }) : undefined;
    const armored = await openpgp.encrypt({ message: await openpgp.createMessage({ binary: decode64(data) }), encryptionKeys, signingKeys, format: "armored" });
    return { armored };
  },

  async decrypt({ armored, keys, verifiers = [] }) {
    const message = await openpgp.readMessage({ armoredMessage: armored });
    const decryptionKeys = await Promise.all((keys || []).map(k => openpgp.readPrivateKey({ armoredKey: k })));
    const r = await openpgp.decrypt({ message, decryptionKeys, verificationKeys: await publicKeys(verifiers), format: "binary" });
    return { data: encode64(r.data), signatures: await verdicts(r.signatures), recipients: message.getEncryptionKeyIDs().map(id => id.toHex()) };
  },

  /** Кому зашифровано письмо (номера ключей): чтобы сказать, почему оно не открывается. */
  async recipients({ armored }) {
    const message = await openpgp.readMessage({ armoredMessage: armored });
    return { recipients: message.getEncryptionKeyIDs().map(id => id.toHex()) };
  },

  /** Отсоединённая подпись (multipart/signed). */
  async sign({ data, signer }) {
    const signingKeys = await openpgp.readPrivateKey({ armoredKey: signer });
    const signature = await openpgp.sign({ message: await openpgp.createMessage({ binary: decode64(data) }), signingKeys, detached: true, format: "armored" });
    const packet = (await openpgp.readSignature({ armoredSignature: signature })).packets[0];
    return { signature, hash: HASH[packet.hashAlgorithm] || "sha512" };
  },

  async verify({ data, signature, verifiers = [] }) {
    const r = await openpgp.verify({
      message: await openpgp.createMessage({ binary: decode64(data) }),
      signature: await openpgp.readSignature({ armoredSignature: signature }),
      verificationKeys: await publicKeys(verifiers),
    });
    return { signatures: await verdicts(r.signatures) };
  },
};
