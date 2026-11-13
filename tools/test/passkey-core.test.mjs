// The cryptographic part of passkeys (src/browser/base/content/tabora/vault/PasskeyCore.sys.mjs),
// checked the way a site checks an authenticator: the attestation object is decoded, the public
// key is taken from it and the signature of an assertion is verified with it by Node's own
// crypto, not by the code under test.
//   node tools/test/passkey-core.test.mjs
import { createHash, createPublicKey, verify } from "node:crypto";
import { AAGUID, cbor, createCredential, derSignature, signAssertion } from "../../src/browser/base/content/tabora/vault/PasskeyCore.sys.mjs";

let passed = 0;
let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? passed++ : failed++;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${ok ? "" : `\n     got:      ${JSON.stringify(got)}\n     expected: ${JSON.stringify(want)}`}`);
}

/** A small CBOR decoder: enough for an attestation object and a COSE key. */
function decode(bytes, at = 0) {
  const major = bytes[at] >> 5;
  const info = bytes[at] & 31;
  let n = info;
  let next = at + 1;
  if (info === 24) {
    n = bytes[next++];
  } else if (info === 25) {
    n = (bytes[next] << 8) | bytes[next + 1];
    next += 2;
  } else if (info === 26) {
    n = bytes[next] * 0x1000000 + ((bytes[next + 1] << 16) | (bytes[next + 2] << 8) | bytes[next + 3]);
    next += 4;
  }
  if (major === 0) return [n, next];
  if (major === 1) return [-1 - n, next];
  if (major === 2) return [bytes.subarray(next, next + n), next + n];
  if (major === 3) return [new TextDecoder().decode(bytes.subarray(next, next + n)), next + n];
  if (major === 4) {
    const list = [];
    for (let i = 0; i < n; i++) {
      const [v, after] = decode(bytes, next);
      list.push(v);
      next = after;
    }
    return [list, next];
  }
  if (major === 5) {
    const map = new Map();
    for (let i = 0; i < n; i++) {
      const [k, afterKey] = decode(bytes, next);
      const [v, afterValue] = decode(bytes, afterKey);
      map.set(k, v);
      next = afterValue;
    }
    return [map, next];
  }
  throw new Error("unexpected CBOR");
}

const hex = bytes => Buffer.from(bytes).toString("hex");
const sha = text => new Uint8Array(createHash("sha256").update(text).digest());
const b64url = bytes => Buffer.from(bytes).toString("base64url");

/* ---- CBOR and DER by themselves ---- */

check("CBOR: integers, bytes, text, arrays and maps as RFC 8949 has them", [
  hex(cbor(0)), hex(cbor(23)), hex(cbor(24)), hex(cbor(500)), hex(cbor(-1)), hex(cbor(-7)), hex(cbor(-25)), hex(cbor("none")), hex(cbor(Uint8Array.of(1, 2, 3))), hex(cbor([1, [2, 3]])), hex(cbor(new Map([[1, 2], ["a", new Map()]]))),
], ["00", "17", "1818", "1901f4", "20", "26", "3818", "646e6f6e65", "43010203", "8201820203", "a201026161a0"]);
const big = new Uint8Array(300).fill(7);
check("CBOR: a byte string longer than 255 bytes has a two-byte length", [hex(cbor(big).subarray(0, 3)), cbor(big).length], ["59012c", 303]);

const p1363 = new Uint8Array(64);
p1363[31] = 1; // r = 1: leading zeros are dropped
p1363[32] = 0x80; // s has its top bit set: a zero is put in front
p1363[63] = 5;
check("DER: leading zeros are dropped, a number with the top bit set gets a zero in front", hex(derSignature(p1363)), `3026020101022100${"80".padEnd(62, "0")}05`);

/* ---- a new passkey ---- */

const rpId = "example.com";
const made = await createCredential({ rpId });
const [att] = decode(made.attestationObject);
const authData = att.get("authData");
check("attestation object: format none, an empty statement, the same authenticator data", [att.get("fmt"), att.get("attStmt").size, hex(authData) === hex(made.authenticatorData), [...att.keys()]], ["none", 0, true, ["fmt", "attStmt", "authData"]]);
check("authenticator data: hash of the site's ID, flags (present, verified, can be backed up, is backed up, attested), counter zero", [hex(authData.subarray(0, 32)) === hex(sha(rpId)), authData[32], hex(authData.subarray(33, 37))], [true, 0x5d, "00000000"]);
const idLen = (authData[53] << 8) | authData[54];
const credentialId = authData.subarray(55, 55 + idLen);
const [cose, coseEnd] = decode(authData, 55 + idLen);
check("attested data: this authenticator's model ID, a 32-byte credential ID, then the key and nothing after it", [hex(authData.subarray(37, 53)) === hex(AAGUID), idLen, hex(credentialId) === hex(made.credentialId), coseEnd === authData.length, hex(authData.subarray(55 + idLen)) === hex(made.publicKey)], [true, 32, true, true, true]);
check("the key is an ES256 key on P-256: type EC2, algorithm -7, curve 1, two 32-byte coordinates, in this order", [[...cose.keys()], cose.get(1), cose.get(3), cose.get(-1), cose.get(-2).length, cose.get(-3).length], [[1, 3, -1, -2, -3], 2, -7, 1, 32, 32]);

/* ---- an assertion, verified the way a site does it ---- */

const publicKey = createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64url(cose.get(-2)), y: b64url(cose.get(-3)) }, format: "jwk" });
const clientDataHash = sha(JSON.stringify({ type: "webauthn.get", challenge: "abc", origin: "https://example.com" }));
const signed = await signAssertion({ rpId, clientDataHash, privateKey: made.privateKey });
const verifies = (s, hash = clientDataHash) => verify("sha256", Buffer.concat([s.authenticatorData, hash]), { key: publicKey, dsaEncoding: "der" }, s.signature);
check("assertion: 37 bytes of authenticator data (site, flags without the attested bit, counter zero)", [signed.authenticatorData.length, hex(signed.authenticatorData.subarray(0, 32)) === hex(sha(rpId)), signed.authenticatorData[32], hex(signed.authenticatorData.subarray(33))], [37, true, 0x1d, "00000000"]);
check("the signature is verified with the key from the attestation; another challenge or changed data is not", [verifies(signed), verifies(signed, sha("another")), verify("sha256", Buffer.concat([sha("other.example"), signed.authenticatorData.subarray(32), clientDataHash]), { key: publicKey, dsaEncoding: "der" }, signed.signature)], [true, false, false]);
let all = true;
for (let i = 0; i < 40; i++) {
  all &&= verifies(await signAssertion({ rpId, clientDataHash, privateKey: made.privateKey }));
}
check("forty signatures in a row are all verified (DER of any r and s)", all, true);
const noUv = await signAssertion({ rpId, clientDataHash, privateKey: made.privateKey, userVerified: false });
const noSync = await signAssertion({ rpId, clientDataHash, privateKey: made.privateKey, backedUp: false });
check("flags follow the request: not verified, not backed up now (it still can be)", [noUv.authenticatorData[32], noSync.authenticatorData[32], verifies(noUv), verifies(noSync)], [0x19, 0x0d, true, true]);

/* ---- different every time, strict about its input ---- */

const other = await createCredential({ rpId });
check("every passkey has its own ID and its own key", [hex(other.credentialId) !== hex(made.credentialId), hex(other.privateKey) !== hex(made.privateKey), hex(other.publicKey) !== hex(made.publicKey)], [true, true, true]);
const otherSigned = await signAssertion({ rpId, clientDataHash, privateKey: other.privateKey });
check("a signature made with another key is not verified with this one", verifies(otherSigned), false);
const refuses = async fn => {
  try {
    await fn();
    return false;
  } catch (e) {
    return true;
  }
};
check("a client data hash of a wrong length and a damaged key are refused", [await refuses(() => signAssertion({ rpId, clientDataHash: new Uint8Array(31), privateKey: made.privateKey })), await refuses(() => signAssertion({ rpId, clientDataHash, privateKey: made.privateKey.subarray(0, 40) }))], [true, true]);

console.log(`\ntotal: ${passed} of ${passed + failed}`);
process.exit(failed ? 1 : 0);
