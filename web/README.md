# Tabora web app

Tabora account mail in any browser, including on a phone: https://app.tabora.app.
The web app has only mail and account settings (password, two-factor protection, backup email,
recovery key, devices, deleting the account). Site passwords, sign-in codes, bookmarks and the wallet live in the Tabora
browser: vault secrets do not belong on a page whose code comes from the server every time.

## How the protection works

- **The password never leaves the page.** A login hash (sent to the server) and a wrapping key
  (stays in the browser) are derived from it: Argon2id 64 MB, the same scheme as in the Tabora browser (`src/core/kdf.js`).
- **The page has no mail password.** It reaches the mailbox through the account server with the session token
  (`src/core/jmap.js`; `src/webmail.rs` in the server repository, Tabora-App/server): signing out or ending the session closes the mail immediately,
  and only mail methods are available.
- **Message encryption (OpenPGP) is done on the page.** The private key comes from the server encrypted and
  is unlocked with the account data key, which in turn is unlocked with the wrapping key derived from the password. Messages between Tabora addresses
  are encrypted and signed; a message is assembled right here and leaves as ready-made source
  (`src/core/mail.js`, `src/core/mime.js` — the same code as in the browser).
- **Foreign message HTML** is sanitized and shown in a separate frame without scripts and without network access;
  images from other servers — only on a button press (`src/core/sanitize.js`, `src/views/mail-reader.js`).
- **The session in browser storage is encrypted** with a key that the browser does not hand out even to the page's
  script (`src/core/store.js`).
- **The sign-in never ends on its own.** The session record is in the browser's persistent storage: closing
  the tab, restarting the browser and rebooting the phone do not sign the account out. The page does not
  erase the sign-in either by time or on a storage failure (if the key could not be read, the record stays
  until the next opening) and asks the browser not to evict the site's data. Signing out is possible only
  with the "Sign out" button — or by ending this sign-in from another device (the device list, a password change or
  reset). What the page cannot do: if the person clears the site's data themselves or
  uses a private window, the sign-in disappears together with it.
- **Content policy**: only our own scripts and styles, not a single third-party address
  (`tools/web/headers.mjs`; on the server — `infra/nginx/app-*.inc` in the server repository).
- **Password guessing** runs into the server's limits: per address, per "account + address" pair and per account
  as a whole (`README.md` in the server repository, "Limits").

What the web app cannot do: the page code comes from the server, and whoever controls the server is able
to replace it. An app installed on a computer is protected from this by a signature — that is why
the password vault and the wallet exist only in it.

## Account module for the phone app

The account module for the Android app is built from this same directory: account sign-in,
tab sync and sign-in codes with autofill. It is not a web page: the app installs it inside
itself as a built-in engine extension; no code comes from the server. Shared with the web app — `src/core`
(sign-in, keys, encryption) and the sign-in screen `src/views/auth.js`; its own — `src/phone` (background service,
communication with the app, storing the sign-in in the app, tab tracking, sign-in codes and their screen, the
autofill script `fill.js`), `phone/` (pages and the extension manifest), `src/core/sync.js` (sync
client), `src/core/otp.js` and `codes.js` (code calculation and code records). The web page
has no sync and no codes.
Build — `node tools/web/build-phone.mjs`, logic check — `node test/run.mjs phone`. How the module
is embedded in the app — `docs/ANDROID.md`.

## Deleting the account

Account settings (`#/account`) end with "Delete the account": the password again, the code if
two-step protection is on, and a tick that this cannot be undone. The account is deleted at once
and for good — the mailbox with all its mail, the addresses for sites, the sync data on the
server, the support requests — and every device is signed out. The address is never given to
anyone else. The same request is made by the browser (Settings → Account → Sign out) and by the
phone app (the account screen); the server side is described in the server repository's README.
This page is also the place to send someone who wants the account deleted without the app.

## Support site

https://support.tabora.app is built from this same directory: `support.html`, `src/support`
(entry, sign-in, screens) and `src/styles/support.css`, on top of the shared base (`src/core/api.js`,
`kdf.js`, `store.js`, `i18n.js`, `src/lib`). What it does:

- **With a Tabora account**: the list of one's support requests, a new request with screenshots,
  the conversation, closing and reopening — the same requests as in the browser (Settings →
  Support). Support staff also get the queue of everyone's requests.
- **Without an account**: someone who cannot sign in, or has no account yet, leaves an e-mail
  address. The request reaches support only after the address is confirmed with the link from a
  letter; the same link (`#t=<number>.<secret>`) is the key to the request afterwards. The secret
  stays after `#`, which a browser does not send to a server.
- **The sign-in is narrow.** The page asks the account server for a session of the scope
  `support`: it reaches the support requests and nothing else — not the mail, not the keys, not
  the settings (the server repository, `src/api.rs`: `auth_for`). The page has no code for the
  account's keys: from the password it derives the login hash and discards the rest
  (`src/support/session.js`). What is stored in the browser is the address and the token of that
  narrow session, encrypted as in the web app.
- Conversations are read by support staff and are not encrypted from them; the page says so where
  a person writes. Everything a person or the server sends is put into the page as text.

Build — `node tools/web/build-support.mjs` (→ `.build/support`; only the strings of the site get
into it, one file per language), checks — `node test/run.mjs support` against a local account
server, deployment — `tools/deploy.sh support`. The server side (endpoints, limits, letters) is
described in the server repository's README.

## Build and checks

```sh
cd tools/web && npm ci --ignore-scripts
node build.mjs                    # → .build/web (file names with a hash, build.json with checksums)
node dev.mjs 8770                 # development server with the same headers as the production nginx
node test/run.mjs core parity headers            # without a server
TABORA_API=http://127.0.0.1:7711 TABORA_OUTBOX=… node test/run.mjs account   # local tabora-server
```

`parity` compares the code ported from the browser without changes (password strength estimation, OpenPGP operations,
message parsing) with its source; `headers` — the nginx headers with the development server's headers.
Deployment: `tools/deploy.sh web` (see `infra/README.md` in the server repository, Tabora-App/server).

## Languages

The interface is available in Russian, English, Ukrainian and Spanish. The language is taken from the browser's language
(if it is not one of these four — English); a choice made in settings or on the sign-in screen is remembered.

- The source language is Russian: strings are written in code in Russian and marked with the ``t`…` `` tag
  (`src/core/i18n.js`: `t`, `plural`, `tr`). Translations are in `i18n/<lang>.json` at the repository
  root — "Russian string → translation"; substitutions in them are written as `{0}`, `{1}`.
- The build puts each language's dictionary in a separate file: a person downloads only their own.
- Messages that arrive as ready-made text (the server, workers, code shared with the browser)
  are translated on display through `tr()` — whole or by a pattern with substitutions.
- New string: write it in Russian with ``t`…` ``, then `node tools/i18n/extract.mjs web --todo`
  shows what is missing in the dictionaries; `--strict` (run by the deployment) does not let
  untranslated strings through. To tag the strings in a new file: `node tools/i18n/wrap.mjs --write --import=web/src/core/i18n.js <file>`.
- A local variable must not be named `t`: it would shadow the translation tag (`wrap.mjs` detects this).
