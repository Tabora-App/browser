# Tabora security audit, round two (after fixes 58baa9f..5af4608)

Six independent reviews of the same areas, with the task of bypassing the round-one fixes and finding the bugs they
introduced and what was missed. There are no critical bypasses; open findings are below. The agents' tests:
`scratchpad/audit2-{wallet,vault,shell,updates}/` of the current session.

## High

1. **Vault: a damaged file is replaced with a new key on the second launch.** `vault/Vault.sys.mjs:357-361,390,618-622`.
   After the move to `.corrupt-*`, the next launch sees "no file", `ensureForPasswords` creates a new K, `_save`
   overwrites `.bak`. The same for codes: `vault/Otp.sys.mjs:410-418,432-434,529-540`.
   Fix: when the file is missing and `.bak`/`.corrupt-*`/`logins.db`/`tabora-otp.json` exists, stay in
   the corrupt state; do not overwrite `.bak` with a key that has a different `check`.
2. **Vault: `lock()` during key operations.** `Vault.sys.mjs:1066-1072` (outside `_exclusive`), `930,948,989,1262-1270`.
   Locking during Argon2 in `changePassword`/`setPassword` wraps a zero key; in `rotateKey` it removes
   the lock or encrypts with a zero subkey. Fix: `lock()` through `_exclusive`, copies of keys for the handlers.
3. **Wallet: a "known" swap hides the recipient.** `wallet/WalletSigner.sys.mjs:244-252`, `provider.js:1039-1042`.
   Uniswap V2/V3, Kyber with a foreign `to`/`recipient` are shown as an ordinary swap without `danger`.
   Fix: the recipient must be the user's own address, otherwise dangerous; flag a zero `amountOutMin`.
4. **Agent: the permission is broader than the action.** `agent.js:847` (the `mail` key is shared by `find_code` and `inbox`), `:774` (history),
   `:608,1013-1016,502` (data from past turns goes to the same origin through `open_url`/`fill_form` without asking).
   Fix: a permission key with the action and the argument; after reading untrusted content, any action with
   data (a URL with a new query/path, field values from tool results) requires confirmation.
5. **macOS: the app is not signed.** No Developer ID, hardened runtime, notarization; resources are not sealed,
   `omni.ja`/`policies.json` can be replaced and code injected. An Apple Developer account is needed (the owner).
6. **The tabora.app domain is hard-coded into the build and not purchased** (`app.update.url.manual`, `tabora.url.*`, `tabora.account.domain`,
   application.ini). Buy it before any distribution (the owner).
7. **Server: there are no backups**; restoring from a snapshot would leave the server without network and login (cloud-init is disabled,
   netplan is bound to the MAC, the root password is locked).

## Medium

- Updates: the manifest validity period is not checked, an old signed manifest is accepted
  (`update/TaboraUpdate.sys.mjs:172-175,245,363-365,409-417`); `release.py refresh`/`manifest` re-sign
  unverified contents of `updates/` (`tools/release.py:623-633,568-582`); the sha512 of the downloaded file is not compared;
  unsigned update.xml attributes; `%CHANNEL%` depends on `app.partner.*`.
- Agent: the `ask_user` button counts as a user message (`agent.js:1168,375`); `nav:<origin>` is approved once
  per turn, redirects are not checked (`:609,756`); bypass of `list_tabs` through `switch_tab` and `bookmarks add`
  (`:625-635,797-803`); clicks and input on a trusted site without asking (SPA); the card truncates the address to 160 characters.
- Vault/account: the attempt counter is reset by signing in to someone else's account (`account/Account.sys.mjs:594,478-480`) and can
  lock the owner out on a clock shift (`Vault.sys.mjs:262-282`); writes without `flush`; the HMAC of code metadata is removed
  by deleting `macs` (`Otp.sys.mjs:469,489-491`); `setPassword` without owner verification through sign-in
  (`Account.sys.mjs:484-491`); the verification key on the server equals the reset signing key (`:66-68,205-209`).
- Wallet: bypass of the address recomputation (`WalletStore.sys.mjs:722-762,200-210`: empty `good`, substituting `check` as
  the seed, no AAD); bypass of the poisoning protection (`send.js:146-154`, `WalletStore.sys.mjs:1481-1483,1722-1739`: incoming
  counterparties are "known", dust < 1e-8 gives NaN); rollback to the v2 `check` (`:508-518,704-710`).
- Build: the local dmg is not a release one (crashreporter to Mozilla, devtools.chrome, remote debugging, a dirty tree);
  Safe Browsing without a key sends download data to Google; Mozilla/Google channels (system addons, GMP, ASRouter,
  captive portal, region, UITour permissions).
- Server: the tabora-server API key can change any user's password (check whether it can change the administrator's);
  fail2ban counts 401 without authorization, and `recidive` bans port 22 (the owner can be banned); no monitoring;
  data is not encrypted (`encryptionAtRest: Disabled`).
- GitHub: 33 commits are not pushed (the old workflow is in effect); signing keys without a password, the secondary one next to them.

## Low

Wallet: the password threshold applies to each operation separately, multicall removes `danger`, `removeLoginKey` before `save`
(`WalletStore.sys.mjs:952`), unknown System/Token instructions in Solana, the port in SIWE, `wLookalike`.
Agent: links in the model's reply, `close_tabs` 3 at a time, `el.click()` is trusted, hidden text is read, `target_origin`
comes from the content process. Shell: `moveTabToSpace` with the system principal (`tabora.js:755-757`), the TaboraVault actor without
`remoteTypes`, `cookieBannerHandled` without rate limiting. Vault: `resumeRekey` without the passwords handler
(`Vault.sys.mjs:1291`), all migrated code records have `sub: true`. Server: `AllowTcpForwarding no` breaks access to
the panel as described in the README, no `postmaster@`, `setup-tunnel.sh:54` without `type=CNAME`, `/var/www/tabora.app` is owned by
www-data, the privileged logins map is 644. Build: Mozilla's Team ID in Info.plist, `app.update.interval` twice.
CI: `sign` takes scripts from the build commit, the release tag is on HEAD of main, the vendors' verify.sh is not called in CI.
