/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Passkeys kept in the vault. A record of tabora-passkeys.json is one passkey: the site (its
 * relying party ID and name), the account on it (user handle, name, display name), the
 * credential ID and the private key. Everything but the key is kept in the clear, so that the
 * browser can tell whether it has a passkey for a site without opening the vault; the private
 * key is encrypted with a key of the vault (Vault.subkey("passkeys")).
 *
 * The site, the credential ID and the user handle are also written inside the encrypted part
 * next to the key and compared when it is opened: a record whose clear fields were changed in
 * the file is refused, so a key cannot be made to answer for another site or account.
 *
 * Passkeys belong to the Tabora account of this profile: without a sign-in nothing is given out
 * or changed. The cryptography itself is PasskeyCore.sys.mjs; who asks the person and when is
 * PasskeyService.sys.mjs. */

import { createCredential, signAssertion } from "chrome://tabora/content/vault/PasskeyCore.sys.mjs";

const { Vault, writeJsonVerified } = ChromeUtils.importESModule("chrome://tabora/content/vault/Vault.sys.mjs");

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Account: "chrome://tabora/content/account/Account.sys.mjs",
});

const FILE = () => PathUtils.join(PathUtils.profileDir, "tabora-passkeys.json");
const BACKUP = () => PathUtils.join(PathUtils.profileDir, "tabora-passkeys.json.bak");
const INFO = "passkeys";
const MAX = 1000;
const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const RP_RE = /^[a-z0-9.-]{1,253}$/;
const HANDLE_RE = /^[A-Za-z0-9_-]{0,88}$/; // a user handle is at most 64 bytes

const te = new TextEncoder();
const td = new TextDecoder();
export const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const fromB64url = text => Uint8Array.from(atob(String(text).replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
const text = (value, max) => String(value ?? "").replace(/[\p{Cf}\p{Cc}\u2028\u2029]/gu, "").trim().slice(0, max);

function wipe(bytes) {
  bytes?.fill?.(0);
}

/** A record as it may be kept: fields of the right shape, or null. */
function clean(e) {
  if (!e || !ID_RE.test(e.id || "") || !RP_RE.test(e.rp || "") || !HANDLE_RE.test(e.uh ?? "") || typeof e.k?.iv !== "string" || typeof e.k?.ct !== "string") {
    return null;
  }
  return { id: e.id, rp: e.rp, rn: text(e.rn, 120), uh: e.uh || "", un: text(e.un, 200), dn: text(e.dn, 200), c: Number(e.c) || 0, u: Number(e.u) || 0, k: { iv: e.k.iv, ct: e.k.ct } };
}

export const Passkeys = {
  TOPIC: "tabora-passkeys-changed",
  _entries: null,
  _loading: null,
  _queue: Promise.resolve(),
  loadError: "",

  notify(what = "changed") {
    Services.obs.notifyObservers(null, this.TOPIC, what);
  },

  /** Passkeys belong to the account: without a sign-in they are neither shown nor used. */
  get allowed() {
    return !!lazy.Account.signedIn;
  },

  /** The file has been read. */
  get loaded() {
    return !!this._entries;
  },

  ready() {
    this._loading ||= this._load();
    return this._loading;
  },

  async _load() {
    let data = null;
    try {
      data = await IOUtils.readJSON(FILE());
    } catch (e) {
      if (!(DOMException.isInstance(e) && e.name === "NotFoundError")) {
        // an unreadable file is not replaced by an empty one: the copy is tried, and writing stops
        try {
          data = await IOUtils.readJSON(BACKUP());
        } catch (e2) {
          this.loadError = e.message || String(e);
        }
      }
    }
    this._entries = (Array.isArray(data?.entries) ? data.entries : []).map(clean).filter(Boolean).slice(0, MAX);
  },

  _serial(fn) {
    const run = this._queue.then(fn, fn);
    this._queue = run.catch(() => {});
    return run;
  },

  async _write() {
    if (this.loadError) {
      throw new Error(`the passkeys file is damaged: ${this.loadError}`);
    }
    const data = { v: 1, entries: this._entries };
    await writeJsonVerified(FILE(), data);
    try {
      await IOUtils.writeJSON(BACKUP(), data, { tmpPath: `${BACKUP()}.tmp`, flush: true });
      await IOUtils.setPermissions(BACKUP(), 0o600);
    } catch (e) {
      console.error("Tabora passkeys: the copy is not written", e);
    }
  },

  /* ---- reading (no vault needed) ---- */

  /** Loaded passkeys without their keys; an empty list until loaded and without a sign-in. */
  list() {
    return this.allowed && this._entries ? this._entries.map(({ k, ...rest }) => ({ ...rest })) : [];
  },

  /**
   * Passkeys for a site. With a list of allowed credential IDs (Uint8Arrays), only those of the list.
   */
  find(rpId, allowList = []) {
    const allowed = allowList.length ? new Set(allowList.map(b64url)) : null;
    return this.list().filter(e => e.rp === rpId && (!allowed || allowed.has(e.id)));
  },

  /* ---- keys (the vault must be open) ---- */

  async _seal(entry, privateKey) {
    const inner = te.encode(JSON.stringify({ k: b64url(privateKey), id: entry.id, rp: entry.rp, uh: entry.uh }));
    try {
      return await Vault.encrypt(INFO, inner);
    } finally {
      wipe(inner);
    }
  },

  /** The private key (PKCS #8) of a record; refused if its clear fields do not match the sealed ones. */
  async _open(entry) {
    const plain = await Vault.decrypt(INFO, entry.k);
    try {
      const inner = JSON.parse(td.decode(plain));
      if (inner.id !== entry.id || inner.rp !== entry.rp || (inner.uh || "") !== entry.uh) {
        throw new Error("the passkey record was changed in the file");
      }
      return fromB64url(inner.k);
    } finally {
      wipe(plain);
    }
  },

  /**
   * Make a passkey for an account on a site and keep it. A passkey for the same site and user
   * handle is replaced: an authenticator keeps one per account.
   *
   * @returns {Promise<{ credentialId: Uint8Array, attestationObject: Uint8Array }>}
   */
  create({ rpId, rpName = "", userHandle, userName = "", displayName = "", userVerified = true, backedUp = true }) {
    return this._serial(async () => {
      await this.ready();
      Vault.requireUnlocked();
      if (!this.allowed) {
        throw new Error("no account");
      }
      // not `instanceof`: the bytes may come from another global of the browser
      if (!RP_RE.test(rpId || "") || !ArrayBuffer.isView(userHandle) || userHandle.BYTES_PER_ELEMENT !== 1 || userHandle.length > 64) {
        throw new Error("a request that cannot be kept");
      }
      const made = await createCredential({ rpId, userVerified, backedUp });
      try {
        const entry = { id: b64url(made.credentialId), rp: rpId, rn: text(rpName, 120), uh: b64url(userHandle), un: text(userName, 200), dn: text(displayName, 200), c: Date.now(), u: 0 };
        entry.k = await this._seal(entry, made.privateKey);
        const rest = this._entries.filter(e => !(e.rp === entry.rp && e.uh === entry.uh));
        if (rest.length >= MAX) {
          throw new Error("too many passkeys");
        }
        const before = this._entries;
        this._entries = [...rest, entry];
        try {
          await this._write();
        } catch (e) {
          this._entries = before;
          throw e;
        }
        this.notify("added");
        return { credentialId: made.credentialId, attestationObject: made.attestationObject };
      } finally {
        wipe(made.privateKey);
      }
    });
  },

  /**
   * Sign an assertion with a kept passkey.
   *
   * @returns {Promise<{ authenticatorData: Uint8Array, signature: Uint8Array, credentialId: Uint8Array, userHandle: Uint8Array }>}
   */
  async sign({ id, rpId, clientDataHash, userVerified = true, backedUp = true }) {
    await this.ready();
    Vault.requireUnlocked();
    const entry = this.allowed ? this._entries.find(e => e.id === id && e.rp === rpId) : null;
    if (!entry) {
      throw new Error("no such passkey");
    }
    const privateKey = await this._open(entry);
    try {
      const signed = await signAssertion({ rpId, clientDataHash, privateKey, userVerified, backedUp });
      this._touch(id);
      return { ...signed, credentialId: fromB64url(entry.id), userHandle: fromB64url(entry.uh) };
    } finally {
      wipe(privateKey);
    }
  },

  _touch(id) {
    this._serial(async () => {
      const entry = this._entries.find(e => e.id === id);
      if (entry) {
        entry.u = Date.now();
        await this._write();
      }
    }).catch(e => console.error("Tabora passkeys", e));
  },

  /** Delete a passkey. The site still has its public half: the account there is not touched. */
  remove(id) {
    return this._serial(async () => {
      await this.ready();
      if (!this.allowed || !this._entries.some(e => e.id === id)) {
        return false;
      }
      const before = this._entries;
      this._entries = before.filter(e => e.id !== id);
      try {
        await this._write();
      } catch (e) {
        this._entries = before;
        throw e;
      }
      this.notify("removed");
      return true;
    });
  },

  /* ---- for sync: whole records with their keys (the vault must be open) ---- */

  /** Every passkey with its private key: [{ id, rp, rn, uh, un, dn, c, key }], key is PKCS #8 in base64url. */
  async exportAll() {
    await this.ready();
    Vault.requireUnlocked();
    const out = [];
    for (const e of this.allowed ? this._entries : []) {
      const key = await this._open(e);
      try {
        out.push({ id: e.id, rp: e.rp, rn: e.rn, uh: e.uh, un: e.un, dn: e.dn, c: e.c, key: b64url(key) });
      } finally {
        wipe(key);
      }
    }
    return out;
  },

  /**
   * Take passkeys that came from another device: [{ id, data }], data is a record of exportAll()
   * without id, or null to delete. A record with the same ID is replaced.
   */
  applyRemote(changes) {
    return this._serial(async () => {
      await this.ready();
      Vault.requireUnlocked();
      if (!this.allowed) {
        return;
      }
      const next = new Map(this._entries.map(e => [e.id, e]));
      for (const { id, data } of changes) {
        if (!data) {
          next.delete(id);
          continue;
        }
        let key = null;
        try {
          key = fromB64url(data.key);
          const entry = { id, rp: data.rp, rn: text(data.rn, 120), uh: data.uh || "", un: text(data.un, 200), dn: text(data.dn, 200), c: Number(data.c) || Date.now(), u: next.get(id)?.u || 0 };
          if (!ID_RE.test(id) || !RP_RE.test(entry.rp || "") || !HANDLE_RE.test(entry.uh) || key.length < 100 || key.length > 400) {
            continue;
          }
          // a key that does not sign is not kept: the record would only pretend to be a passkey
          await signAssertion({ rpId: entry.rp, clientDataHash: new Uint8Array(32), privateKey: key });
          entry.k = await this._seal(entry, key);
          next.set(id, entry);
        } catch (e) {
          console.error(`Tabora passkeys: a record from another device is not taken (${id})`, e);
        } finally {
          wipe(key);
        }
      }
      const before = this._entries;
      this._entries = [...next.values()].slice(0, MAX);
      try {
        await this._write();
      } catch (e) {
        this._entries = before;
        throw e;
      }
      this.notify("synced");
    });
  },
};

/* The vault's key was changed: private keys are encrypted again with the new subkey. The file is
 * written whole, a repeated call is safe. */
Vault.registerRekey(INFO, async ctx => {
  await Passkeys.ready();
  if (!Passkeys._entries.length) {
    return;
  }
  await Passkeys._serial(async () => {
    const entries = [];
    for (const e of Passkeys._entries) {
      const plain = await ctx.decryptOld(INFO, e.k);
      try {
        entries.push({ ...e, k: await ctx.encryptNew(INFO, plain) });
      } finally {
        wipe(plain);
      }
    }
    Passkeys._entries = entries;
    await Passkeys._write();
  });
});
