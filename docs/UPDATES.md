# Tabora updates

## How it works

Downloading and installation are done by the engine's stock updater: a full MAR package, signature verification,
installation on restart (staging in the background). There is no downloader of our own. On top of it there are three levels of verification.

### 1. Package (MAR) — verified by the updater

- **Signature.** The MAR is signed with Tabora's RSA key (`tools/release.py` → `signmar`). The public
  certificates `release_primary.der` and `release_secondary.der` from `src/toolkit/mozapps/update/updater/`
  are embedded into the updater instead of Mozilla's certificates. Their SHA-256 hashes are pinned in `tools/build.py`
  (`MAR_CERT_SHA256`): `import`, `build`, `package` and `release.py` stop if the files in `src/`
  have been replaced (for example, through a PR).
- **Channel.** `MAR_CHANNEL_ID=tabora-release` (`configs/common/mozconfig`): the updater rejects a package
  from another channel.
- **Tabora version.** The MAR records the product version = `displayVersion` from `browser.json`
  (not the Firefox version). The updater compares it with the Tabora version built into it at build time
  (`TABORA_APP_VERSION`: `browser/moz.configure.patch`, `updater-common.build.patch`, `updater.cpp.patch`),
  and does not install a package with a version lower than the installed one — even if it is built on the same Firefox version
  and correctly signed. Therefore `displayVersion` is raised with every release; `release.py` will not allow
  releasing a version lower than or equal to the one already published for this platform (except with `--replace`).
- **Build check before release.** `build.py package` and `release.py` check the packaged
  app: `updater.app/…/org.mozilla.updater` and `Library/LaunchServices/org.mozilla.updater`
  (Linux: `updater`) contain the bytes of both our DER files, `UpdateSettings.framework` (Linux: `update-settings.ini`)
  contains `tabora-release`, `application.ini` has no Mozilla address, `tabora.version` in omni.ja matches
  `browser.json`. Any mismatch stops the release. To check manually:
  `python3 tools/release.py check`.

### 2. Metadata — the signed target manifest

For each target (channel + `%BUILD_TARGET%`, for example `release/Darwin_aarch64-gcc3`) there is a separate file
`updates/<channel>/<target>/manifest.json`:

```json
{
  "signed": "{\"channel\":\"release\",\"expires\":\"2027-02-07T12:00:00Z\",\"format\":1,\"issued\":\"2026-11-09T12:00:00Z\",…}",
  "signatures": [{ "keyid": "57b30cbe780889e7", "sig": "<Ed25519, base64>" }]
}
```

`signed` is JSON text; the Ed25519 signature is computed over its UTF-8 bytes (no canonicalization). Fields:
`format` (1), `channel`, `target`, `version`, `minimum` (`0.0.0` — nothing is mandatory), `notes` (up to 2000
characters), `notesUrl` (https), `published` (date), `issued` (signing time, UTC; grows with every
signature), `expires` (UTC, by default `issued` + 90 days, at most 366), `update` — the package for this
target: `url` (https), `sha512`, `size`, `buildID`, `appVersion`.

- The client (`TaboraUpdate.sys.mjs`) verifies the signature with the public keys from `MANIFEST_KEYS` (primary and
  secondary; replaced only by a new build), then the fields: the `X.Y.Z` version format, lengths, https,
  `minimum ≤ version`, matching channel and target, `issued` and `expires`. Text with lone surrogates
  is rejected (otherwise the signature would match a different text).
- **Validity period.** An expired manifest (`now > expires`) is rejected entirely: no updates
  are installed from it, and mandatory status is not turned on. A manifest with `issued` more than a day in the future is not
  accepted either. An already verified record in memory is valid only until its `expires`.
- **Rollback protection.** The client stores the largest `issued` it has seen in the profile preference
  `tabora.update.manifestIssued.<channel>.<target>` (and in session memory) and rejects a manifest with a smaller
  value — including a correctly signed old one with a previous version or `minimum`. A value from
  the profile that is more than a day in the future is considered corrupted and is ignored (corruption "forward" will not disable
  updates forever; within a day — until the next signature). Therefore every signature (`manifest`,
  `refresh`) sets `issued` strictly greater than the previous one.
- **Stale information.** If the server serves an expired manifest, the verified one has expired, or
  there has been no valid manifest for more than 14 days (`tabora.update.manifestOkAt.<channel>.<target>`), the "About" window
  shows "Update information is out of date…" in any updater state (including "no updates"),
  and a red banner appears at the bottom of the window with the buttons "Open website", "Check again",
  "Later". Manifests must be re-signed at least once per validity period, even without a release:
  `python3 tools/release.py refresh` and a push of `updates/`.
- `update.xml` (`updates/<channel>/<target>/update.xml`) is not signed itself. Before parsing, UpdateService
  (`UpdateService.sys.mjs.patch`) leaves in `<update>` only the attributes `taboraVersion`,
  `appVersion`, `buildID`, and in `<patch>` — `type`, `URL`, `size`, `hashFunction`, `hashValue`
  (`sanitizeUpdateElement`): `actions`, `openURL`, `promptWaitTime`, `detailsURL`, `name`, `unsupported`
  and any others never reach the updater. Then only an `<update>` with a single complete
  patch is accepted, and only if it matches `update` from the verified manifest: `taboraVersion`, `buildID`, `appVersion`,
  the package address, size and sha512. `displayVersion`, `type` (`minor`), the notes address and the update name
  are filled in from the manifest. An update whose Tabora version is not higher than the installed one is discarded. Without
  a valid manifest there are no updates.
- **Package sha512.** After the download, `Downloader._verifyDownload` computes the SHA-512 of the file and compares it with
  the patch's `hashValue` (it equals `update.sha512` from the signed manifest); on a mismatch the file
  is deleted; a patch without sha512 is not accepted. So the package is verified even before it is handed to the updater
  (which separately verifies the MAR signature).
- `updates/channel.json` is the old shared manifest for builds made before this scheme. Their updater does not accept
  our packages (old certificates), so `release.py` writes only the version and notes there and
  does not raise `minimum`: old copies see the new version and are installed from the website, but are not blocked.

### 3. Addresses

`tabora.update.url` (the update.xml template) and `tabora.update.manifestUrl` (the manifest template) are read
only from **default preferences** (`Services.prefs.getDefaultBranch("")`): a value set by
the user, in about:config or user.js, has no effect. https only; a response from another host
(a redirect) is not accepted. `%CHANNEL%` in both addresses is filled in by `TaboraUpdate.fixChannel`:
it is `app.update.channel` from default preferences, without the user's `app.partner.*` values, which
the stock `UpdateUtils.UpdateChannel` would append to the address. The address from `application.ini` is not used at all (it now holds
`https://tabora.app/…` instead of aus5.mozilla.org, `updateHost` in `browser.json`); there is no fallback address.
The `AppUpdateURL` policy is honored only if it is https, and it still goes through the comparison with the manifest.

### Mandatory update

If the current version is lower than `minimum` from a verified, unexpired manifest, the update is mandatory, but
the wall screen is shown only if: the manifest has a package for this target with a version ≥ `minimum`; updates are not
disabled by policy; there is an updater and permission to install (`canUsuallyApplyUpdates`); the stock updater
has not answered "no updates", "manual only", "system not supported". Otherwise — a banner, with
a "Download from website" button when the updater is unavailable. The wall always has "Download from website"
(the address `app.update.url.manual`, https only, from default preferences), "Try again", "Quit"; ⌘Q / Ctrl+Q
work, and the wall's buttons are reachable from the keyboard.

### Interface

`src/browser/base/content/tabora/update/`: optional — a banner at the bottom of the window "Version … is available ·
Later · Update/Restart", a reminder once a day; mandatory — a screen over the window with progress;
stale information — a red banner (see above), "Later" hides it for a day.
A check runs 8 s after startup and once an hour; manually — in the "About" window.

## Keys

Keys are kept **outside the repository**:

| What | Where (default) | Variable |
|---|---|---|
| Primary MAR key (NSS: cert9.db, key4.db, pkcs11.txt) and the manifest key `manifest-ed25519.pem` | `~/.config/tabora/mar-keys` | `TABORA_MAR_KEYS_DIR` |
| Secondary MAR key and secondary manifest key | `~/.config/tabora/mar-keys-secondary` | `TABORA_MAR_SECONDARY_KEYS_DIR` |
| Password of the NSS database and the PEM (if set) | — | `TABORA_MAR_KEYS_PASSWORD_FILE` |

`release.py` refuses to work with a database inside the repository or with a directory accessible to other
users (the directory needs `chmod 700` and the files `600`).

- **Password.** signmar supports a password-protected NSS database: without `TABORA_MAR_KEYS_PASSWORD_FILE` it asks for
  the password in the terminal; in CI the password is supplied from a secret through a file. To set the password (once, both databases):
  ```sh
  DYLD_LIBRARY_PATH=engine/obj-darwin-aarch64/dist/bin engine/obj-darwin-aarch64/dist/bin/certutil -W -d sql:$HOME/.config/tabora/mar-keys
  DYLD_LIBRARY_PATH=engine/obj-darwin-aarch64/dist/bin engine/obj-darwin-aarch64/dist/bin/certutil -W -d sql:$HOME/.config/tabora/mar-keys-secondary
  # the manifest PEM key — with the same password:
  openssl pkcs8 -topk8 -v2 aes-256-cbc -in ~/.config/tabora/mar-keys/manifest-ed25519.pem -out /tmp/m.pem && mv /tmp/m.pem ~/.config/tabora/mar-keys/manifest-ed25519.pem && chmod 600 ~/.config/tabora/mar-keys/manifest-ed25519.pem
  ```
- **The secondary key is offline.** The `mar-keys-secondary` directory is needed only if the primary key is lost or
  compromised (`release.py … --key secondary`). Keep it off this machine: on encrypted media
  (for example, an encrypted APFS image or VeraCrypt) in two physical locations, with a password; after moving it,
  delete the copy from the disk. It is not needed in CI and is not put into secrets.
- **Losing both keys** means that installed copies will not accept new packages: only a reinstall
  from the website.
- **CI.** Secrets of the `release` environment: `TABORA_MAR_KEYS` = `tar -cz -C ~/.config/tabora mar-keys | base64`
  (the primary directory only), and with a password — `TABORA_MAR_KEYS_PASSWORD`.
- **Changing the manifest key**: generate a new Ed25519 key, add its public key to `MANIFEST_KEYS`
  (`TaboraUpdate.sys.mjs`), release a build, and only once it has spread — sign with the new key.
  `release.py` checks that the key signing the manifest is embedded in the client.

## Releasing a version

### Locally (macOS)

1. Raise `displayVersion` in `browser.json`, build and package:
   `python3 tools/build.py import && python3 tools/build.py build && python3 tools/build.py package`
   (package checks the updater), or take the packaged app from the **Build** workflow
   (`tabora-app-<platform>.tar` → `engine/obj-*/dist/tabora/Tabora.app`).
2. Sign and notarize: `tools/sign_macos.sh` → `.build/signed/Tabora.app` and the dmg.
3. `python3 tools/release.py publish --app .build/signed/Tabora.app --notes "What's new"` — builds the MAR
   from the **signed** app (symbolic links are not dereferenced and are forbidden),
   signs it with the primary key, verifies the signature against the DER from `src/`, the channel and the version in the MAR, writes
   `manifest.json`, `update.xml`, `channel.json`, creates the `vX.Y.Z` release on GitHub with the MAR and the signed dmg (the tag is
   on the current commit, if it has already been pushed to GitHub).
4. Commit and push `updates/`: only after that do clients see the update. To make
   an update mandatory after the fact: `python3 tools/release.py manifest --minimum X.Y.Z` and a push.

**The macOS package is made from the signed app, and only from it.** After a full update the app on
disk must be exactly the app that was signed and notarized, otherwise its signature no longer verifies
(`codesign --verify --deep --strict`: "a sealed resource is missing or invalid") and macOS can refuse to
open it. Three things follow, and `release.py` enforces them:

- an unsigned macOS app is refused (`--unsigned` exists for checks only);
- `precomplete` is not regenerated for a signed app: it is a sealed resource, the one written at
  packaging time stays;
- the stock packaging scripts keep `ChannelPrefs.framework` and `UpdateSettings.framework` from the
  installed version (`add-if-not`, so that one Firefox build can serve several channels). Both are signed
  code sealed into the app's signature, so `release.py` packs with a copy of the scripts in which they
  are replaced like any other file. Tabora has one channel per build, nothing is lost.

At the end `release.py` unpacks the package and compares it with the app file by file. To check a
package by hand, apply it to a copy of an older release with that release's own updater (the staged
update lives next to the package, not inside the app):

```sh
P=/tmp/patch; A=/tmp/Tabora.app            # A: a copy of an older release, P: an empty directory
ditto "$A/Contents/MacOS/updater.app" "$P/updater.app"; cp tabora-X.Y.Z-….complete.mar "$P/update.mar"
printf 'pending\n' > "$P/update.status"
"$P/updater.app/Contents/MacOS/org.mozilla.updater" 3 "$P" "$A" "$P/Updated.app" first -1         # stage
"$P/updater.app/Contents/MacOS/org.mozilla.updater" 3 "$P" "$A" "$P/Updated.app" first 0/replace  # replace
cat "$P/update.status"                      # succeeded
codesign --verify --deep --strict "$A" && spctl -a -vv "$A" && diff -rq "$A" .build/signed/Tabora.app
```

`release.py` rules for files already in `updates/` (they can be changed by a commit, so by
themselves they are not trusted):

- the previous `manifest.json` is used only if its signature is verified with the `MANIFEST_KEYS` keys and
  its channel and target match the directory; otherwise `mar`, `manifest`, `publish` and `refresh` stop
  (restore the file from git, or delete it if the target is being released anew);
- `--minimum`: without the flag, `minimum` is taken from the verified previous manifest (a line is printed
  about this), and on the first release of a target — `0.0.0`, that is, the update is not mandatory. Only
  an explicit `--minimum` makes it mandatory; a decrease is printed as a warning;
- `--notes`: without the flag, notes are inherited only when re-signing the same version; for a new version — empty;
- a version lower than the one already released is not signed (a rollback manifest);
- `refresh` first verifies the signatures of all manifests (if even one is not verified, none
  is re-signed), changes only `issued` and `expires`, and prints what changed.

GitHub releases are **immutable** (immutable releases are enabled in the repository): after publication, the release
files and the tag cannot be replaced or deleted. Re-releasing the same version (`--replace`) into
a published release is impossible — raise `displayVersion`. Consequence: all platforms of one version
must be uploaded before the release is published; currently one target is released (`Darwin_aarch64-gcc3`); for
several targets, publication will have to be split (a shared draft → publication after the last target).

### In CI

The CI flow below signs the package but cannot sign the app: the Developer ID key is not in CI. It is
therefore usable for Linux targets only; a macOS update is released locally (see above) until the app
itself is signed in CI.

1. The **Build** workflow (main branch, `ubuntu-24.04` runner) → the `tabora-<platform>` artifact with the dmg and
   `tabora-app-<platform>.tar` (the packaged app for the MAR). Before the build,
   the reproducibility of the vendor bundles is verified (`tools/wallet-vendor/verify.sh`, `tools/vault-vendor/verify.sh`);
   the lightweight **Verify vendor bundles** workflow does the same on push to main and in PRs (no secrets,
   `contents: read`). A build on Blacksmith is fine for checking, but not for release.
2. The **Release** workflow (from main only) with the ID of that run:
   - `verify` — checks the inputs (minimum `^[0-9]+\.[0-9]+\.[0-9]+$`, notes up to 2000) and, through
     `gh api`, that the run is a successful Build from main of this repository, the commit is part of main, the artifact
     exists, all jobs of the run (in all attempts) ran on GitHub runners (`runner_group_name`
     "GitHub Actions", labels `ubuntu-24.04`/`ubuntu-24.04-arm`), and the release of this version is not published yet;
   - `sign` (environment `release`) — the scripts (`tools/release.py`, `tools/build.py`), the MAR certificates and
     `MANIFEST_KEYS` are taken from the **current main** (the commit from which Release was started), and from the build
     commit — only the Tabora version and the version/hash of the Firefox sources (they are substituted into `browser.json`);
     it builds signmar from the Firefox sources and the system NSS, unpacks the app without links,
     builds and signs the MAR, writes the manifests; binaries from the artifact are not executed, the keys are kept
     in `$RUNNER_TEMP` with mode 600 and deleted at the end. If the certificates in main have changed since
     the build, the app check stops the release (a new build is needed);
   - `publish` (no keys) — prepares the commit with this target's manifests and checks that it applies onto
     the current main (`fetch`, `rebase`, `push --dry-run`); creates a **draft** release with the tag on
     the build commit (`--target <head_sha>`; an existing version tag must point to the same commit);
     pushes the manifests to main (up to three attempts with rebase); if the push fails, the draft is deleted; after
     the push the release is published and it is verified that the tag is on the build commit. If publication
     fails after the push, the job fails with the hint `gh release edit vX.Y.Z --draft=false`.
   All inputs are passed to scripts only through `env:`. Without `minimum` the update is not mandatory.
3. Repository settings (done by the owner): the `release` environment with a required reviewer and
   the rule "Deployment branches: main only"; the secrets `TABORA_MAR_KEYS` (and `TABORA_MAR_KEYS_PASSWORD`)
   — as secrets of this environment, not of the repository. If main is protected, allow `github-actions`
   to push to `updates/` (or remove the commit step and push manually). Immutable releases are enabled
   (`gh api repos/Tabora-App/browser/immutable-releases`; to disable — `-X DELETE`).

### Firefox sources

`build.py update` and `download` (when `firefox.sha512` is not pinned) take the hash from `SHA512SUMS` on
archive.mozilla.org and verify its signature with Mozilla's key through gpg. Without gpg this is an error: the hash is not
pinned. A deliberate skip is the global flag `python3 tools/build.py --no-gpg update` (the hash must then
be checked on a machine with gpg before committing).

## Safe Browsing

Without a Google Safe Browsing key, the Google providers do not work (phishing and malicious downloads are not
checked), and a warning is shown in settings. The key is supplied at build time from a file:
`$TABORA_SAFEBROWSING_KEYFILE` or `~/.config/tabora/safebrowsing.key` (`configs/common/mozconfig`), in CI —
from the `SAFEBROWSING_API_KEY` secret.

How to get a key (the owner): Google Cloud Console → a new project → "APIs & Services" → enable
**Safe Browsing API** → "Credentials" → "Create credentials" → API key → restrict the key to this API.
The key ends up in the build in the clear (as with Firefox), so the API restriction is mandatory. For
a commercial product Google has separate terms (Web Risk API); Mozilla uses its key under
an agreement with Google — check the terms before release. To save:
`umask 077; printf '%s' 'KEY' > ~/.config/tabora/safebrowsing.key` and add the secret on GitHub.

## Add-on signing and the Russian interface

Mandatory add-on signing is enabled (`MOZ_REQUIRE_SIGNING` is the default for release; the unsigned
scopes `app,system` are not allowed). Previously it was removed for the sake of a language pack with our branding
(the Mozilla signature becomes invalid when files are replaced). Now the translation is built into the
build itself: `build.py download`/`package` take `ru` from the `mozilla-l10n/firefox-l10n` monorepo at
the revision from `browser/locales/l10n-changesets.json` (a partial checkout in `.build/l10n-central`; the path
is passed with `--with-l10n-base`), and `build.py package` calls `mach package-multi-locale --locales en-US ru`.
Branding for ru is taken from our `browser/branding/release/locales/en-US` (Tabora). In profiles that
had the old unsigned package `langpack-ru@firefox.mozilla.org`, it will become "unverified" and
be disabled; the interface stays Russian from the build itself.

## Migrating from old builds

Builds made before this scheme (the dmg of November 8 and earlier) contain an updater with Mozilla certificates and
`UpdateSettings` without a channel — they will not accept a Tabora MAR (and the package does not
overwrite `UpdateSettings.framework`). They need to be reinstalled once from the new dmg; after that updates go through MAR.

## Verification

- Module: `node` + stubs (signature, fields, manifest expiry and rollback, the attribute allowlist and
  the update.xml filter, addresses only from default preferences); `release.py` — with a temporary Ed25519 key
  (tampering with `updates/`, `refresh`, `minimum`).
- Packaged app: `python3 tools/release.py check`.
- MAR signature: `signmar -T <mar>` (channel, version), `signmar -D src/toolkit/mozapps/update/updater/release_primary.der -v <mar>`.
- An end-to-end installation check is possible only with a packaged app (in a development build
  `canApplyUpdates = false`): install the dmg, release a test version, wait for the banner.
- Vendor bundles: `sh tools/wallet-vendor/verify.sh`, `sh tools/vault-vendor/verify.sh`.
