# Architecture

## Decisions

| Question | Decision | Why |
|---|---|---|
| Engine | Firefox (Gecko), our own build tool on top of mach | The interface is HTML/CSS/JS, a build takes 1.5-2 hours on a laptop, macOS can be built on Linux |
| Interface | Entirely our own | Sidebar with spaces and tabs, sections for mail, passwords, codes and the wallet, agent panel |
| Account and sync | Our own account server; data is encrypted on the device | The server stores only what it cannot read. One account is one browser profile |
| Mobile | Android on GeckoView (Firefox for Android), iPhone on WebKit (Firefox for iOS) | Store requirements; the account code is shared with the web app |
| Release builds | GitHub Actions on Blacksmith Linux runners, macOS cross-compilation | One pipeline for all platforms |

## Layers

1. **Engine**: Firefox, changed as little as possible. It is updated by changing the version in
   `browser.json`; our changes are patches and new files in `src/`.
2. **Shell** (`src/browser/base/content/tabora/`): sidebar, spaces, sleeping tabs, start page,
   settings. Privileged JS, CSS, XHTML.
3. **Account** (`account/`): sign-in, devices, two-factor protection, recovery key. The password
   never leaves the device: a login hash and a separate wrapping key are derived from it.
4. **Vault** (`vault/`): saved passwords and sign-in codes, encrypted with keys of the account.
   Codes are filled into site forms by a page actor. Numbers of saved bank cards are bound to
   the vault too: the engine encrypts them with a key from the system keychain, and that
   ciphertext is encrypted once more with a key of the vault (`vault/CardKey.sys.mjs`), so a
   card number is readable only while the vault is open.
   Passkeys are kept here as well. The engine's WebAuthn service (`dom/webauthn`) asks the vault
   before the system's authenticator and hardware keys through a small scriptable interface
   (`nsITaboraPasskeys.idl`); the vault's side is `vault/PasskeyService.sys.mjs` (who is asked and
   when), `vault/Passkeys.sys.mjs` (the encrypted store) and `vault/PasskeyCore.sys.mjs` (key
   pairs, attestation objects and signatures; tested under Node in `tools/test`).
5. **Mail** (`mail/`): the `@tabora.app` mailbox over JMAP, external mailboxes over IMAP and SMTP,
   aliases, OpenPGP. Mail from outside is rendered in a separate content process without scripts.
6. **Wallet** (`wallet/`): keys are derived from the recovery phrase on the device; the phrase is
   never synced. Transactions are decoded and shown before signing.
7. **Agent** (`agent.js`): a shell module with access to pages through JSWindowActor. It plans
   steps, fills in forms, creates aliases, reads codes from the built-in mail, and waits for the
   user's confirmation before submitting forms.
8. **Ad blocker** (`shield/`): our own filter engine for Adblock Plus syntax. It cancels requests
   to ad and tracker hosts and hides page elements; the same engine is loaded into the Android app.
9. **Sync** (`sync/`): passwords, codes, bookmarks, spaces, start page shortcuts and open tabs are
   stored on the account server as records encrypted with a key derived from the account's data
   key. Merge rules are written so that a merge mistake cannot cost data. "Send to device" lives in
   the same storage: each device keeps a record with the pages it sent lately, the addressee
   opens a page once and remembers it. History is synced the same way, per device: a device
   publishes only its own visits of the last two months (a record per day), reads the records of
   the others and shows them in "History" under the device's name without writing them into its
   own history database. Deleting a page from history removes it from the device's records;
   turning history sync off removes them all. Autofill addresses and bank cards are synced from
   the engine's autofill storage while the vault is open; cards only after the person turns
   that on, and the card's security code is never stored or sent. A fixed list of settings
   (theme, language, the ad blocker and its exceptions, the sections of the side panel and the
   like) is merged setting by setting, the later change winning; only names of the list with
   values that pass its check are ever applied. Each computer also publishes the list of its
   extensions; the others show it and open an extension's catalog page, installing nothing.
10. **Web app and Android account module** (`web/`): the same account, sync and mail code
    (`web/src/core`) runs in the web app and, as a built-in extension, inside the Android app.

The account server and the infrastructure are in
[Tabora-App/server](https://github.com/Tabora-App/server), the iPhone app in
[Tabora-App/ios](https://github.com/Tabora-App/ios).
