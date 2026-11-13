/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Bank card numbers are bound to the vault.
 *
 * The engine keeps the number of a saved card encrypted with a key from the system keychain
 * (toolkit/modules/OSKeyStore.sys.mjs): whoever can run the browser under this user of the
 * computer can have it filled in. Here that ciphertext is encrypted once more, with a key of the
 * vault, so a card number can be read only while the vault is open: not after "Lock", not
 * without the account's password or the keychain entry of the vault. The rest of a card (the
 * last four digits, the expiry, the name) is kept by the engine as before.
 *
 * OSKeyStore calls wrap() on what it has encrypted and unwrap() on what it is asked to decrypt;
 * nothing else in the engine knows about it. A number saved before this appeared is read as it
 * is and bound at the next unlock. When the vault's key is changed, the numbers are bound again
 * with the new key. With the vault locked, the unlock form is shown and the caller waits. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Vault: "chrome://tabora/content/vault/Vault.sys.mjs",
  formAutofillStorage: "resource://autofill/FormAutofillStorage.sys.mjs",
});

const PREFIX = "tv1:";
const CARD_FIELDS = ["billingAddressGUID", "cc-name", "cc-number", "cc-exp-month", "cc-exp-year", "cc-type"];
const INFO = "cards";
const BOX_RE = /^[A-Za-z0-9+/=]{1,64}\.[A-Za-z0-9+/=]{1,4096}$/;

export const CardKey = {
  _started: false,
  _busy: null,

  /** Whether a stored ciphertext is already bound to the vault. */
  bound(text) {
    return typeof text === "string" && text.startsWith(PREFIX);
  },

  async _open() {
    await lazy.Vault.ready();
    if (!lazy.Vault.unlocked) {
      // the unlock form is shown; a refusal or no answer leaves the number unread
      await lazy.Vault.requestUnlock("cards").catch(() => false);
    }
    if (!lazy.Vault.unlocked) {
      throw Components.Exception("The vault is locked", Cr.NS_ERROR_ABORT);
    }
  },

  /** The keychain's ciphertext of a card number → the same, encrypted with the vault's key. */
  async wrap(osCipher) {
    await this._open();
    const box = await lazy.Vault.encrypt(INFO, new TextEncoder().encode(String(osCipher)));
    return `${PREFIX}${box.iv}.${box.ct}`;
  },

  /** What wrap() gave → the keychain's ciphertext. A text that was never bound is returned as it is. */
  async unwrap(text) {
    if (!this.bound(text)) {
      return text;
    }
    const body = text.slice(PREFIX.length);
    if (!BOX_RE.test(body)) {
      throw Components.Exception("A damaged card record", Cr.NS_ERROR_FAILURE);
    }
    await this._open();
    const [iv, ct] = body.split(".");
    return new TextDecoder().decode(await lazy.Vault.decrypt(INFO, { iv, ct }));
  },

  /**
   * Bind the saved cards to the vault's current key: the ones that are not bound yet, or all of
   * them (force) after the key was changed. The record is written by the storage itself: it
   * decrypts the number and encrypts it again, which goes through unwrap() and wrap().
   * Returns how many cards were written.
   */
  rebindAll({ force = false } = {}) {
    this._busy = (this._busy || Promise.resolve()).catch(() => {}).then(async () => {
      if (!lazy.Vault.unlocked) {
        return 0;
      }
      await lazy.formAutofillStorage.initialize();
      const cards = lazy.formAutofillStorage.creditCards;
      let written = 0;
      for (const card of await cards.getAll()) {
        if (!card["cc-number-encrypted"] || (!force && this.bound(card["cc-number-encrypted"]))) {
          continue;
        }
        try {
          const raw = await cards.get(card.guid, { rawData: true });
          if (raw?.["cc-number"] && !/[*•]/.test(raw["cc-number"])) {
            // only the card's own fields: the storage refuses a record that carries its service ones
            const fields = Object.fromEntries(CARD_FIELDS.filter(name => raw[name] !== undefined).map(name => [name, raw[name]]));
            await cards.update(card.guid, fields);
            written++;
          }
        } catch (e) {
          // a number that cannot be read (the keychain entry is gone) stays as it is
          console.error("Tabora cards: a card is not bound to the vault", e);
        }
      }
      return written;
    });
    return this._busy;
  },

  /** Start: bind what is not bound at every unlock, and bind anew when the vault's key changes. */
  init() {
    if (this._started) {
      return;
    }
    this._started = true;
    Services.obs.addObserver((subject, topic, what) => {
      if (what === "unlocked") {
        this.rebindAll().catch(e => console.error("Tabora cards", e));
      }
    }, lazy.Vault.TOPIC);
    lazy.Vault.registerRekey(INFO, async () => {
      // the new key is already the vault's key, and decryption still accepts the former one
      await this.rebindAll({ force: true });
    });
    if (lazy.Vault.unlocked) {
      this.rebindAll().catch(e => console.error("Tabora cards", e));
    }
  },
};
