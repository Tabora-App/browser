import { tt } from "chrome://tabora/content/i18n/I18n.sys.mjs";
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* The vault as a passkey authenticator. The engine's WebAuthn service asks this one before the
 * system's authenticator and hardware keys (dom/webauthn/nsITaboraPasskeys.idl): by then the
 * engine has checked the site and built the client data, so what is left is what an
 * authenticator does. A request ends in exactly one answer:
 *
 *   created / asserted   the person agreed and proved to be the owner
 *   refused              the person said no, the proof failed, or the request was withdrawn
 *   exists               the site excluded a passkey that the vault already has
 *   pass                 the vault is not the one to answer: the person chose another device,
 *                        the vault has nothing for the site, the site wants a key type the vault
 *                        does not make. The engine then goes on as it would without the vault.
 *
 * Nothing is signed and nothing is saved without two things: a click in the browser's own
 * window (never in the page) and a proof of the owner. The proof is the unlocking of the vault
 * if it was locked, and the system's check (Touch ID or the password of the computer) if it was
 * already open: an open vault alone does not say who is at the keyboard now.
 *
 * One request at a time: a new one withdraws the previous. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Passkeys: "chrome://tabora/content/vault/Passkeys.sys.mjs",
  Vault: "chrome://tabora/content/vault/Vault.sys.mjs",
  Sync: "chrome://tabora/content/sync/Sync.sys.mjs",
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
});

const PREF = "tabora.passkeys.enabled";
const ES256 = -7;

const bytes = list => Uint8Array.from(list || []);

export class PasskeyService {
  QueryInterface = ChromeUtils.generateQI(["nsITaboraPasskeys"]);

  constructor() {
    this.wrappedJSObject = this; // for tests
    this._active = null;
    lazy.Passkeys.ready().catch(e => console.error("Tabora passkeys", e));
  }

  get enabled() {
    try {
      return Services.prefs.getBoolPref(PREF, true) && lazy.Passkeys.allowed;
    } catch (e) {
      return false;
    }
  }

  wantsCreate(rpId, attachment) {
    // a site that asks for a key on another device ("cross-platform") is not offered the vault
    return this.enabled && attachment !== "cross-platform";
  }

  wantsGet(rpId, allowList) {
    if (!this.enabled) {
      return false;
    }
    if (!lazy.Passkeys.loaded) {
      return true; // the file is still being read: get() decides
    }
    return !!lazy.Passkeys.find(rpId, allowList).length;
  }

  create(tid, browsingContextId, origin, rpId, rpName, userId, userName, userDisplayName, coseAlgs, excludeList, requireUserVerification, privateBrowsing, reply) {
    this._begin(tid, browsingContextId, reply, async request => {
      if (coseAlgs.length && !coseAlgs.includes(ES256)) {
        return ["pass"];
      }
      await lazy.Passkeys.ready();
      const shell = this._shell(browsingContextId);
      if (!shell || lazy.Passkeys.loadError) {
        return ["pass"];
      }
      // an empty exclude list excludes nothing (find() with an empty list would mean "any passkey of the site")
      if (excludeList.length && lazy.Passkeys.find(rpId, excludeList).length) {
        // the site is told only after the person saw it: otherwise any page could ask what is kept here
        const seen = await this._ask(request, shell, { kind: "exists", rpId, rpName });
        return [seen.action === "other" ? "pass" : seen.action === "ok" ? "exists" : "refused"];
      }
      const choice = await this._ask(request, shell, { kind: "create", rpId, rpName, userName, userDisplayName });
      if (choice.action === "other") {
        return ["pass"];
      }
      if (choice.action !== "ok" || !(await this._owner(request, tt`сохранить ключ доступа для ${rpId}`))) {
        return ["refused"];
      }
      if (!this._samePage(request)) {
        return ["refused"];
      }
      const made = await lazy.Passkeys.create({ rpId, rpName, userHandle: bytes(userId), userName, displayName: userDisplayName, userVerified: true, backedUp: this._synced() });
      return ["created", Array.from(made.attestationObject), Array.from(made.credentialId)];
    });
  }

  get(tid, browsingContextId, origin, rpId, allowList, clientDataHash, requireUserVerification, privateBrowsing, reply) {
    this._begin(tid, browsingContextId, reply, async request => {
      await lazy.Passkeys.ready();
      const found = lazy.Passkeys.find(rpId, allowList);
      const shell = this._shell(browsingContextId);
      if (!found.length || !shell) {
        return ["pass"];
      }
      const choice = await this._ask(request, shell, { kind: "get", rpId, rpName: found[0].rn, accounts: found.map(e => ({ id: e.id, userName: e.un, userDisplayName: e.dn })) });
      if (choice.action === "other") {
        return ["pass"];
      }
      const picked = found.find(e => e.id === choice.id) || (found.length === 1 ? found[0] : null);
      if (choice.action !== "ok" || !picked || !(await this._owner(request, tt`войти на ${rpId} с ключом доступа`))) {
        return ["refused"];
      }
      if (!this._samePage(request)) {
        return ["refused"];
      }
      const signed = await lazy.Passkeys.sign({ id: picked.id, rpId, clientDataHash: bytes(clientDataHash), userVerified: true, backedUp: this._synced() });
      return ["asserted", Array.from(signed.authenticatorData), Array.from(signed.credentialId), Array.from(signed.signature), Array.from(signed.userHandle)];
    });
  }

  cancel(tid) {
    if (this._active?.tid === tid) {
      this._active.withdraw();
    }
  }

  /* ---- inside ---- */

  /** Run a request to its single answer. `work` returns [the reply's method, ...its arguments]. */
  _begin(tid, browsingContextId, reply, work) {
    this._active?.withdraw();
    const request = { tid, done: false, close: null, browsingContextId, page: this._pageOf(browsingContextId) };
    const settle = (method, ...args) => {
      if (request.done) {
        return;
      }
      request.done = true;
      if (this._active === request) {
        this._active = null;
      }
      try {
        reply[method](...args);
      } catch (e) {
        console.error("Tabora passkeys: the answer was not taken", e);
      }
    };
    request.withdraw = () => {
      try {
        request.close?.();
      } catch (e) {}
      settle("refused");
    };
    this._active = request;
    work(request).then(
      answer => settle(...answer),
      e => {
        console.error("Tabora passkeys", e);
        settle("refused");
      }
    );
  }

  /** The document that is shown in a browsing context now (0 if none). */
  _pageOf(browsingContextId) {
    try {
      return BrowsingContext.get(browsingContextId)?.currentWindowGlobal?.innerWindowId || 0;
    } catch (e) {
      return 0;
    }
  }

  /** The page that asked is still there: nothing is made or signed for a page that has left
   * while its owner was being checked. */
  _samePage(request) {
    return !request.done && (!request.page || this._pageOf(request.browsingContextId) === request.page);
  }

  /** The browser window of the page that asks: its shell shows the question. */
  _shell(browsingContextId) {
    let win = null;
    try {
      win = BrowsingContext.get(browsingContextId)?.top?.embedderElement?.ownerGlobal;
    } catch (e) {}
    if (!win?.Tabora?.passkeyPrompt) {
      win = lazy.BrowserWindowTracker.getTopWindow();
    }
    return win?.Tabora?.passkeyPrompt ? win.Tabora : null;
  }

  /** Ask the person in the browser's window. → { action: "ok" | "other" | "cancel", id? } */
  async _ask(request, shell, question) {
    if (request.done) {
      return { action: "cancel" };
    }
    const shown = shell.passkeyPrompt(question);
    request.close = shown.close;
    try {
      return await shown.answer;
    } finally {
      request.close = null;
    }
  }

  /** The proof of the owner; false if it was not given or the request is over. */
  async _owner(request, reason) {
    if (request.done) {
      return false;
    }
    const Vault = lazy.Vault;
    await Vault.ready();
    let proved = false;
    if (!Vault.unlocked) {
      // the person unlocks the vault now: that is the proof
      proved = !!(await Vault.requestUnlock("passkeys").catch(() => false)) && Vault.unlocked;
    } else {
      proved = await this._confirm(reason);
    }
    return proved && !request.done && Vault.unlocked;
  }

  /** The system's check of the owner (replaced in tests: the system's dialog cannot be answered there). */
  _confirm(reason) {
    return lazy.Vault.confirmOwner(reason);
  }

  /** Whether passkeys are being synced now: the "backed up" flag of a passkey says it to the site. */
  _synced() {
    try {
      return !!lazy.Sync.enabled && lazy.Sync.groupOn("passkeys");
    } catch (e) {
      return false;
    }
  }
}
