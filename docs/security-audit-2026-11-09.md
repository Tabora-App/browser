# Tabora security audit, November 9, 2026

Six independent reviews (wallet; vault, passwords and 2FA; shell, mail and account; updates and supply
chain; the Hetzner server; engine patches and preferences). Findings of critical and high severity were re-verified against the code
by hand.

## Status after fixes (November 9, 2026)

All critical, high, medium and low findings are fixed, except those listed below. Verified on a full build:
an end-to-end test in the browser (add-on signing is mandatory, selfxss 0, the update address comes only from the default branch,
a site cannot load shell code, the agent does not open file:/about:/chrome:, actors only on http(s),
locking the vault closes passwords and is not lifted on its own, codes have migrated, weakening the wallet without the password
is forbidden, an unknown price requires the password, mail is closed without a sign-in); the server was checked from outside (only
22, 25, 443, 465, 587, 993 are open; the bare IP rejects TLS; login by key only, the root password is locked).
GitHub: secret scanning and push protection for secrets, Dependabot, main without force-push and deletion,
the `release` environment only from main with the owner's approval, the Actions token read-only by default.
Additionally found and closed during the fixes: the agent could attach any file from disk to a site's form through
`<input type=file>`; the `tools/dev_inject.py` script killed all Tabora processes through pkill (removed).

Remains open or needs the owner:
- Safe Browsing: a Google Safe Browsing / Web Risk key is needed (`~/.config/tabora/safebrowsing.key`, in CI the secret
  `SAFEBROWSING_API_KEY`); without it phishing and malicious downloads are not checked.
- Signing keys: set a password on both NSS databases (`certutil -W`), move the secondary database
  `~/.config/tabora/mar-keys-secondary` to encrypted media; create the `TABORA_MAR_KEYS` secret for CI
  only in the `release` environment.
- Wallet: swaps through the Uniswap Universal Router, aggregators and Solana programs outside the allowlist are shown
  as undecoded (dangerous); decoding of their commands is needed.
- Agent: ordinary visible fields and non-submit buttons on the current site are filled in and clicked without asking; protection against
  leakage through a filled-in field relies on marking the data as untrusted.
- Passwords: while the vault is unlocked, the storage key lives in Rust memory; Firefox password sync does not work while
  the vault is locked.
- Account: the server endpoints (prelogin, upgrade, recovery, reset with a signature) need to be implemented in tabora-server
  according to the contract from `Account.sys.mjs`.
- Server: TLS, the tunnel and DNS are enabled after the domain is purchased; TLSA (DANE) and CAA are not published.
- Old installations from the November 8 dmg will not accept new MARs (Mozilla updater): one reinstall is needed.

## Critical

1. **The AI agent performs privileged actions at a page's direction.** `agent.js:52,97-108,375-385`,
   `tabora.js:2152-2158` (`looksLikeUrl` lets through `about:`, `chrome:`, `file:`, `moz-extension:`),
   `drawer.js:129-137` (the TaboraMedia actor without `matches`/`remoteTypes`), `TaboraMediaChild.sys.mjs:13-30`.
   Tools run without confirmation; `open_url` opens a tab with the system principal.
   Page text can tell the agent to open `file:///…/.ssh/id_ed25519`, read it and send it to its own server,
   to click and fill in about:config, to read codes from mail, history and other tabs.
   Fix: `open_url` only http(s) with a content principal; `matches` http(s) and an
   `isContentPrincipal` check for the actor; user confirmation for navigating to a new origin, submitting forms, reading mail,
   history and other tabs, `save_login`; pass tab titles and tool output to the model as data.
2. **Shell injection in `release.yml:60`.** `${{ inputs.notes }}` and `${{ inputs.minimum }}` are substituted into
   the script text, next to the unpacked MAR keys and a `GH_TOKEN` with `contents: write`. Anyone who can start the workflow
   steals the signing keys and ships a malicious update to all clients.
   Fix: inputs through `env:` and `"$NOTES"`, validation of `minimum` with a regular expression.
3. **The built Tabora.app contains an updater with Mozilla certificates.** `dist/Tabora.app/Contents/MacOS/updater.app`
   and the November 8 dmg contain Mozilla's DER, `UpdateSettings.framework` without `tabora-release`; our certificates are only in
   `dist/bin`. A release from this package: our MARs will not be accepted, ones signed by Mozilla will be.
   Fix: a full build and packaging; in `release.py`/`build.py`, a check of the bytes of our certificates and of the channel in
   the packaged updater, failing on a mismatch.

## High

4. **SSH: root logs in with a password** (`sshd -T`: `permitrootlogin yes`, `passwordauthentication yes` from
   `50-cloud-init.conf`); bots brute-force it constantly. The root password also passed through a chat.
   Fix: `/etc/ssh/sshd_config.d/00-tabora.conf` (`PasswordAuthentication no`, `PermitRootLogin
   prohibit-password`, `MaxAuthTries 3`), `passwd -l root`, add to `setup.sh`.
5. **The 2FA code is given out over http and on any subdomain; the host is taken from the page's message.**
   `TaboraVaultChild.sys.mjs:122,137`, `TaboraVaultParent.sys.mjs:16-23`, `vault.js:602,608,727-740`,
   `Otp.sys.mjs:426-428,563-569`. A MITM on `http://x.bank.com` or an XSS on a subdomain gets the bank.com code;
   a compromised content process sends `OtpField{host:"google.com"}` + `OtpAccept` and gets the code without the user;
   focusing an OTP field silently unlocks the vault.
   Fix: https and secure context only; the host from `manager.documentPrincipal` in the parent; the exact origin
   of the record, subdomains only explicitly; insertion only on click with a delay; do not unlock the vault on focus.
6. **Wallet: the signing password is removed without the password and does not trigger when prices fail.**
   `WalletStore.sys.mjs:317-324` (`setSignPassword` checks only `unlocked`), `wallet.js:868-889`
   (auto-lock and nodes too), `WalletStore.sys.mjs:1239-1250` (`prices()` on error `{}` → `usd = 0`),
   `provider.js:779-787,1066-1076,1271-1276`, `send.js:540-544`.
   Fix: changing the signing mode, auto-lock, nodes, `acceptFile`, `addWallet` only with the password;
   an unknown price and tokens outside the list count as above the threshold.
7. **Wallet: dangerous operations are defined by a list of exceptions.** `WalletSigner.sys.mjs:104-146`,
   `provider.js:595-608,646-649,727-736`. Permit2 `approve` (`0x87517c45`), unknown EIP-712 (Blur, LooksRare,
   0x), calls to unknown contracts are not marked as dangerous; `deposit()` is shown as an "ETH wrap" for any
   address and turns off the amount warning.
   Fix: treat everything undecoded and EIP-712 outside the allowlist as dangerous; decode Permit2 and
   multicall; `deposit`/`withdraw` only for the WETH of this network.
8. **Safe Browsing does not work.** No key (`MOZ_GOOGLE_SAFEBROWSING_API_KEY='no-google-safebrowsing-api-key'`),
   the Google providers are disabled, phishing and malicious downloads are not checked although the checkbox is on.
   Fix: a Safe Browsing key through a CI secret (the owner's decision).
9. **The mandatory add-on signing requirement was removed.** `configs/common/mozconfig:59-61`
   (`MOZ_REQUIRE_SIGNING=`), `release.js:75`. `xpinstall.signatures.required` became an ordinary preference.
   Fix: restore the requirement, build Russian in through multi-locale or an l10n repack.
10. **MAR signing keys and CI.** Both keys are in one NSS database without a password inside the repo tree (`.build/mar-keys`);
    the secret is not bound to an environment with a reviewer; main is not protected; `jlumbroso/free-disk-space@main` and other
    actions are not pinned by SHA; `release.yml` accepts any `build_run_id`; `release.py:100` copies the artifact
    dereferencing links; `tools/wallet-vendor/package-lock.json` is in `.gitignore`, `npm install` runs with scripts.
11. **Rollback and version freeze.** update.xml and channel.json are not signed; downgrade protection compares only
    the Firefox version, and the client trusts the same appVersion with a different buildID; the update address is read from
    a user preference (`UpdateService.sys.mjs.patch:11-14`, `TaboraUpdate.sys.mjs:115-123` without https).
    Fix: a monotonic Tabora build number in the product version; addresses only from the default branch; signed
    manifests with an expiry date.
12. **Password reset without proof.** `Account.sys.mjs:515` sends `recoveryProof: null`. The server must
    require proof of possession of the recovery key; otherwise the email address alone is enough to take over the mailbox.
13. **A repeated `setup.sh` rolls back the TLS and tunnel scheme** (`setup.sh:50,216-220` versus `enable-tls.sh:27-29`):
    it opens port 80, the site is served on the public IP bypassing Cloudflare, and mail's 443 disappears.

## Medium

- Server: the Stalwart admin API is reachable through the public `/jmap` with Basic auth once `mx.conf` is enabled; trust
  in `X-Forwarded-For` (`proxy.inc:4`); Stalwart writes no log, fail2ban does not protect SMTP/IMAP, the nginx jails do not
  read the log files; the Cloudflare token and secrets are visible in `ps` (`setup-tunnel.sh:12,26`, `dns.sh:10`,
  `setup.sh:131`), permissions of `cloudflare.env` are not set, a single token with Tunnel Edit lives forever; `tabora-server` knows
  the full password of the mail administrator; `dns.sh:8` gets the IP through `http://ifconfig.me`; TXT records are only
  added (two SPF records break verification).
- Vault and passwords: "Lock vault" does not lock the password storage (the key stays in Rust, `isLoggedIn` is always
  true); the NSS primary password silently disappears on re-encryption; copies under NSS remain in `logins-backup.json`;
  re-encryption is not atomic (a failure midway = loss of passwords); a damaged `tabora-vault.json` is silently replaced
  with a new key (data loss); K does not change on a password change, on revoking the recovery key or on rebinding to
  another account; secrets are copied without the "sensitive" flag.
- Account: the login hash uses cheap Argon2 (16 MiB) while the password is shared with the vault, minimum 6 characters; signing out does not
  lock the vault, mail opens without a sign-in, the mail cache is not encrypted; the failed attempt counter is in memory.
- Shell: the media drawer loads addresses from pages with the system principal (`TaboraMediaChild.sys.mjs:62`,
  `drawer.js:844-886`).
- Wallet: address poisoning through outgoing zero-value transfers in history; a tampered wallet file is trusted for
  receiving addresses and contacts.
- Updates: a mandatory update without validation of the manifest fields and with no way out when updates are disabled
  by policy; one channel.json for all platforms.
- Preferences: `devtools.selfxss.count=5` (`build.py:354`), the usage-reporting ping is not turned off; Firefox sources and
  language packs are downloaded without hash verification.

## Low

Files under `chrome://browser/content/tabora/` are readable by sites (the browser package with `contentaccessible=yes`) and reveal
Tabora; actors without `matches`; SIWE allows the domain of the top document; TRON and Solana addresses are given out while
the wallet is locked; the Permit2 sheet shows the wrong deadline; the SPL token program is taken from the RPC; the delay of
the signing button is 0.9 s; secrets in memory and the sheet with the phrase after locking; code metadata is not authenticated;
a race in vault creation; page SVG is decoded in the parent process; the click on a cookie banner button is trusted;
the file name is not sanitized when dragging into "Downloads"; a crash when dragging an unknown space;
the agent key in plaintext in prefs; no CSP on mail.html and downloads.html; nginx `server_tokens`, no
default_server, `add_header` cancels security headers; the Stalwart binary is writable by the service; weak
restriction of systemd services; cloudflared and Stalwart do not update themselves; ManageSieve is open unnecessarily.

## What was checked and is sound

No open relay; PostgreSQL is localhost only; the MAR is verified with our key in a correctly built
updater; the wallet origin comes from `documentPrincipal`, HTTPS only; EIP-712, `personal_sign`, TRON and Solana
are parsed strictly; AES-GCM with random nonces, KDF bounds; mail and the shell output text through textContent;
the start page accepts only http(s); `javascript:` is not executed in the system context; the sandbox,
Remote Settings, CRLite, HTTPS-only are untouched.
