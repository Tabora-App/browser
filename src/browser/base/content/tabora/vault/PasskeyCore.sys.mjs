/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* The cryptographic part of passkeys kept in the vault: what an authenticator does and nothing
 * else. The engine checks the site, builds the client data and talks to the page; this module
 * only makes a key pair and signs.
 *
 *   createCredential → a new ES256 (P-256) key pair, its ID, and the attestation object the page
 *                      gets: format "none", no attestation statement (a passkey that is synced
 *                      has no device to attest).
 *   signAssertion    → authenticator data and a signature over it and the hash of the client
 *                      data.
 *
 * Flags of the authenticator data: the person is present and, when the vault confirmed its
 * owner, verified; the credential can be backed up (it is synced) and whether it is now. The
 * signature counter is always zero, as it should be for a credential that lives on several
 * devices: a counter would make the devices contradict each other.
 *
 * No dependencies on the browser: the module runs under Node as it is, where it is tested
 * (tools/test/passkey-core.test.mjs). */

/** The model identifier of this authenticator: the same in every Tabora. */
export const AAGUID = Uint8Array.from([0x0e, 0x80, 0x35, 0x7d, 0xd6, 0x01, 0x4b, 0x87, 0xe8, 0x53, 0xa6, 0x73, 0x35, 0x8c, 0x50, 0xf0]);

export const FLAG_UP = 0x01; // the person is present
export const FLAG_UV = 0x04; // the person is verified
export const FLAG_BE = 0x08; // the credential can be backed up
export const FLAG_BS = 0x10; // the credential is backed up now
export const FLAG_AT = 0x40; // attested credential data follows

const COSE_ES256 = -7;
const ID_BYTES = 32;

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/* ---- CBOR: only what an attestation object and a COSE key need ---- */

function cborHead(major, n) {
  if (n < 24) {
    return Uint8Array.of((major << 5) | n);
  }
  if (n < 0x100) {
    return Uint8Array.of((major << 5) | 24, n);
  }
  if (n < 0x10000) {
    return Uint8Array.of((major << 5) | 25, n >> 8, n & 0xff);
  }
  return Uint8Array.of((major << 5) | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}

/** Encode an integer, a byte string (Uint8Array), a text string, an array or a Map (in its order). */
export function cbor(value) {
  if (Number.isInteger(value)) {
    return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  }
  if (value instanceof Uint8Array) {
    return concat(cborHead(2, value.length), value);
  }
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    return concat(cborHead(3, bytes.length), bytes);
  }
  if (Array.isArray(value)) {
    return concat(cborHead(4, value.length), ...value.map(cbor));
  }
  if (value instanceof Map) {
    return concat(cborHead(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)]));
  }
  throw new Error("CBOR: a value of a kind that is not used here");
}

/* ---- pieces ---- */

export async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

const fromB64url = text => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));

/** An ECDSA signature as WebCrypto gives it (r and s, 32 bytes each) → ASN.1 DER, as WebAuthn wants it. */
export function derSignature(raw) {
  if (raw.length !== 64) {
    throw new Error("a signature of an unexpected length");
  }
  const int = bytes => {
    let at = 0;
    while (at < bytes.length - 1 && bytes[at] === 0) {
      at++;
    }
    const body = bytes.subarray(at);
    // a leading zero keeps the number positive when its top bit is set
    return body[0] & 0x80 ? concat(Uint8Array.of(0x02, body.length + 1, 0), body) : concat(Uint8Array.of(0x02, body.length), body);
  };
  const r = int(raw.subarray(0, 32));
  const s = int(raw.subarray(32));
  return concat(Uint8Array.of(0x30, r.length + s.length), r, s);
}

function flags({ userVerified, backedUp, attested }) {
  return FLAG_UP | (userVerified ? FLAG_UV : 0) | FLAG_BE | (backedUp ? FLAG_BS : 0) | (attested ? FLAG_AT : 0);
}

/** rpIdHash (32) | flags (1) | signCount (4, always zero). */
async function authDataHead(rpId, bits) {
  return concat(await sha256(new TextEncoder().encode(rpId)), Uint8Array.of(bits), new Uint8Array(4));
}

/**
 * Make a new passkey.
 *
 * @param {{ rpId: string, userVerified?: boolean, backedUp?: boolean }} request
 * @returns {Promise<{ credentialId: Uint8Array, privateKey: Uint8Array, publicKey: Uint8Array,
 *   authenticatorData: Uint8Array, attestationObject: Uint8Array }>}
 *   privateKey is PKCS #8, publicKey is the COSE key; the private key is to be kept by the caller.
 */
export async function createCredential({ rpId, userVerified = true, backedUp = true }) {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const privateKey = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const publicKey = cbor(new Map([[1, 2], [3, COSE_ES256], [-1, 1], [-2, fromB64url(jwk.x)], [-3, fromB64url(jwk.y)]]));
  const credentialId = crypto.getRandomValues(new Uint8Array(ID_BYTES));
  const authenticatorData = concat(
    await authDataHead(rpId, flags({ userVerified, backedUp, attested: true })),
    AAGUID,
    Uint8Array.of(credentialId.length >> 8, credentialId.length & 0xff),
    credentialId,
    publicKey
  );
  const attestationObject = cbor(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authenticatorData]]));
  return { credentialId, privateKey, publicKey, authenticatorData, attestationObject };
}

/**
 * Sign an assertion with a passkey.
 *
 * @param {{ rpId: string, clientDataHash: Uint8Array, privateKey: Uint8Array, userVerified?: boolean, backedUp?: boolean }} request
 *   privateKey is the PKCS #8 that createCredential gave.
 * @returns {Promise<{ authenticatorData: Uint8Array, signature: Uint8Array }>}
 */
export async function signAssertion({ rpId, clientDataHash, privateKey, userVerified = true, backedUp = true }) {
  // not `instanceof`: the bytes may come from another global of the browser
  if (!ArrayBuffer.isView(clientDataHash) || clientDataHash.BYTES_PER_ELEMENT !== 1 || clientDataHash.length !== 32) {
    throw new Error("the hash of the client data must be 32 bytes");
  }
  const key = await crypto.subtle.importKey("pkcs8", privateKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const authenticatorData = await authDataHead(rpId, flags({ userVerified, backedUp, attested: false }));
  const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, concat(authenticatorData, clientDataHash)));
  return { authenticatorData, signature: derSignature(raw) };
}
