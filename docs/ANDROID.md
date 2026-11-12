# Tabora for Android

The Android app is built from the same Firefox source tree as the desktop browser: the GeckoView
engine and the `mobile/android/fenix` app. Our changes live in the same place as all the others:
in `src/` (a mirror of the engine tree, `tools/build.py import`).

Status: a browser named Tabora with a built-in ad blocker and without Mozilla services;
sign-in to a Tabora account (with a password or with a QR code from a computer), sync of tabs, bookmarks and
site passwords with the other devices of the account, sign-in codes (the second step on websites) with autofill,
account mail, spaces (each has its own tabs and its own site sign-ins). The app has no wallet yet.

## What is changed

| What | Where |
| --- | --- |
| Package name `app.tabora.browser`, no shared user with Firefox, `tabora://` links | `src/mobile/android/fenix/app/build.gradle.patch`, `src/release/AndroidManifest.xml.patch`, `src/release/res/xml/shortcuts.xml.patch` |
| Name in UI strings ("Firefox" → "Tabora" in all translations) | `rebrand_android_strings` in `tools/build.py` — in place, only for the android target |
| Icon, splash screen, notification mark, mark and wordmark on the start page | `src/mobile/android/fenix/app/src/{main,release}/res/…`; drawn by `tools/android/assets.py` |
| Images with the fox and the Firefox logo (banners, empty screens, errors) — the Tabora mark of the same size | the `MASCOTS` list in `tools/android/assets.py` |
| Theme colors: a neutral background and a lime/olive accent instead of the purple palette | `NovaColors.kt.patch`, `nova_colors.xml.patch` (only the palette numbers change), `colors.xml.patch` |
| Ad blocker switch in settings | `preferences.xml.patch`, `SettingsFragment.kt.patch`, strings — `res/values*/tabora_strings.xml` |
| Names for the engine (error pages) | `src/mobile/android/branding/tabora/` |
| Ad blocker — the same modules as on desktop | `src/mobile/shared/tabora/jar.mn`, started in `GeckoViewStartup.sys.mjs.patch` |
| Tabora account: sign-in, tab sync, sign-in codes with autofill | the `web/src/phone` module (built into `assets/extensions/tabora`), `…/fenix/tabora/*.kt`, patches to `Core.kt`, `HomeActivity.kt`, `nav_graph.xml`, `preferences.xml`, `SettingsFragment.kt`, `tabstray/…`, `components/menu/…` |
| Start page shortcuts | `src/main/res/raw/default_shortcuts.json`, `default_pinned_shortcuts.json` |

### Ad blocker and engine languages

The blocker starts together with the engine, before the first window, and immediately compiles rules from the lists
in the profile. While they are being compiled (fractions of a second), page requests wait for a decision: the first page
after launch — a link from another app, a restored tab — already opens without
ads. To check: `am force-stop`, then open by link a page that immediately requests an ad
address — the very first request must be cancelled. On the very first launch there are no lists yet: they
are downloaded right away, and blocking turns on a few seconds later.

Russian, Ukrainian and Spanish are bundled into the engine (`res/multilocale.txt`): the app language
determines the format of dates and numbers on pages and the language of the engine's internal pages. The standard strings of
pages themselves ("Submit Query", "Browse…", field validation messages) stay English in any
language — Firefox for Android works the same way: the engine takes them from the shared English set.

### Tabora account and sync

Account sign-in and sync run in a built-in module — an engine extension that
the app installs itself at startup (`assets/extensions/tabora`). The module is built from the same
code as the web app (`web/src/core`: sign-in, key derivation from the password, the account data key, the sync
client) and its own part, `web/src/phone`; the build is `tools/web/build-phone.mjs`, called by
`tools/build.py import` (and `tools/android/local.sh setup`). The built module is not in the repository.
The module has two permissions: communication with the app and requests to the account server; it is not
accessible to other pages.

What lives where:

- **The "Tabora account" screen** (Settings, first item) — the module page `index.html` inside an app
  screen (`TaboraAccountFragment`): sign-in, sign-up, the second step, password reset; after sign-in —
  sync switches (tabs, sign-in codes, site passwords, bookmarks), sync status, sign-out.
- **The sign-in** (the session token and the account data key) is stored not in the page's storage but by the app:
  in `SecureAbove22Preferences`, encrypted with a key from the Android keystore
  (`TaboraAccount.kt`). The sign-in never ends on its own; signing out erases the record and removes the phone's
  tab list from the server.
- **Phone tabs → other devices:** the app passes the open tabs to the module (no
  private tabs, only http and https addresses, at most 200); the module encrypts the list with the account key and
  puts it on the server as a single record under the phone's device ID — in the same form as the desktop browser.
- **Tabs of other devices → phone:** the module gives the app the decrypted lists; they
  are shown on the last page of the tab list (`TaboraSyncedTabsIntegration`): a native app
  screen formerly used by Mozilla sync. Without a sign-in it shows an invitation to sign in.
- A sync runs: after sign-in and at startup, a few seconds after a change in tabs, when the
  tab list is opened and every ten minutes. On desktop, sync is on from the moment of account
  sign-in; it is turned off there too: "Settings → Account → Sync".
- The module decrypts only those account collections that it uses and that are turned on on the
  account screen (tabs, codes, site passwords, bookmarks); the others never reach the phone in
  plaintext.
- **Bookmarks** are merged with the app's bookmark storage in both directions (`web/src/phone/marks.js`,
  the behavior mirrors `marks` from `sync/SyncSources.sys.mjs`): desktop bookmarks appear on
  the "Bookmarks" screen in the "Desktop Bookmarks" folder (menu, toolbar, "Other"), those made on
  the phone appear on desktop in the "From phone" folder. The four roots are shared; only their
  order is synced. A new bookmark gets its ID from the phone's storage, so the module keeps a
  "record ID ↔ storage ID" table; an identical bookmark created both there and here before a sync
  (or before signing in again) remains a single one. The bookmark tree is read on a full sync (startup,
  return to the app, the tab list, "Sync now", every ten minutes); after a change
  in tabs — only if the server has something new or two minutes have passed.
- **Site passwords** are merged with the app's password storage in both directions (`web/src/phone/logins.js`,
  merge rules — `merge.js`, the same as on desktop): a password from the computer is filled in on
  the site on the phone, one saved on the phone appears on the computer. If many passwords disappear
  from the phone at once, the deletions are not sent until the person decides what to do with them.
- **Spaces** — each has its own tabs and its own site data (sign-ins, cookies), as on
  desktop. The engine can keep a tab's site data separate (the tab's "context"); the
  app lacked only the list of spaces and the interface:
  - the list and the current space — `tabora/TaboraSpaces.kt`; "Personal" always exists and lives without
    a context (it holds all earlier tabs), the others come from the account (`web/src/phone/spaces.js`,
    the `spaces` collection: names, colors, icons, order). A space's ID in the account and the context on
    the phone are different things: a context never parts with its space;
  - tab rules — `TaboraSpacesMiddleware`: a new tab opens in the current
    space, a tab opened from a link — in the space of the tab it came from (for windows that the page
    itself opens, `GeckoEngineSession` is patched), the space of the selected tab becomes
    current, closing the last tab of a space leaves the person in it on the home screen,
    "Close all tabs" closes the tabs of the current space;
  - the switcher — a row above the regular tabs in the tab list (`TaboraSpacesRow.kt`); the tab
    list, the counter on the toolbar, swipe switching and the tab strip show only the current
    space. Tab storage and restoration still see all tabs: the common list of
    tabs is left untouched so that an empty space does not erase the saved tabs of the others;
  - private tabs do not belong to spaces; a space with open tabs is not erased by a
    deletion made on another device.
  - spaces are managed in the same row: the last chip creates a space (name, color, icon: the
    same set as on the desktop, `TaboraSpaceIcons.kt`), a long press opens the menu of a space
    (edit, move left or right, delete). Deleting closes the tabs of the space and erases the site
    data kept for it; every change is carried to the account right away.
- **Mail** — the "Tabora Mail" screen (main menu, shortcut on the home screen), the module page
  `mail.html`: the same code as the web app, with the same sign-in as sync. Messages with
  HTML layout are shown in frames without scripts, third-party images load only on a button press, a link from
  a message opens in a regular tab.
- **Sign-in with a QR code.** On the sign-in screen the "Sign in with QR code" button opens the app's scanner
  (`QrScanActivity`, launched by `TaboraAccount.scanQr`); the code is shown by the desktop browser:
  "Settings → Account → Sync → Sign in on a phone". The phone and the computer show
  the same six-digit verification code, the person allows the sign-in on the computer, and on the phone
  sees the account address and confirms the sign-in. The account data key arrives encrypted with the shared
  secret of the two devices (X25519, `web/src/core/pair.js` — a copy of `account/Pair.sys.mjs`); the server
  only relays messages and issues the session (`src/pair.rs` in the server repository, Tabora-App/server). The app does
  not parse the scanned text: a `tabora://pair` link from another app or from a page does not start a sign-in —
  only the scanner opened by the person on the sign-in screen does.
- **A copy of the data** (codes and tabs of other devices) is kept by the app in the same protected
  storage as the sign-in: after startup they are visible immediately and without a network. Signing out erases it.

**Sign-in codes** (the second step on websites) — the same records as in the vault of the desktop browser (the
`otp` sync collection); the code calculation is the same code (`web/src/core/otp.js`, checked against
`vault/Otp.sys.mjs` by the `parity` check):

- **The "Sign-in codes" screen** (main menu, Settings, account screen) — the module page `codes.html`:
  a list with a countdown, copy on tap, adding by key, by an `otpauth://` link,
  by a photo of a QR code, by transfer from Google Authenticator and from Aegis and 2FAS files, editing sites, deletion.
  Changes go to the account right away and appear on the computer.
- **Autofill.** On every https page a small module script runs (`web/src/phone/fill.js`):
  it notices a code field (the detection rules and insertion methods are ported from
  `actors/TaboraVaultChild.sys.mjs`) and, if a code is linked to the site, shows a
  "Fill in the code" button under the field. The site is determined by the document address reported by the engine; a field in a frame
  of another site gets no button; a code is bound to the exact host (subdomains — only if
  the record allows it). The button lives in a closed shadow tree and fires only on a real
  tap; the code itself reaches the page after the tap, the secret — never.
- **Owner confirmation.** Before showing the codes screen and before filling in, the app asks for
  a fingerprint, face or screen lock code (`BiometricPrompt` in `TaboraAccount.kt`); the confirmation
  is remembered for five minutes. If the phone has no screen lock, there is nothing to confirm with and access is open —
  saved passwords in the app behave the same way.
- The module page is not given the camera: a QR code is photographed with the phone's system camera (file chooser)
  and recognized in the module.

The engine starts extension background pages only after the first page is opened; so that the module
also works on the home screen, the startup signal is sent a few seconds after start
(`GeckoViewStartup.sys.mjs.patch`).

Messages between the module and the app are described in `web/src/phone/bridge.js`. The app returns the reply to a module
request as a JSON string: the engine does not accept an object in a reply.

### What is not sent to Mozilla

- Engine: no crash reporter and no telemetry (`configs/android/mozconfig`); Glean
  upload from the engine is turned off by the same patch as on desktop.
- App: `TELEMETRY` and `CRASH_REPORTING` are turned off at build time (`build.gradle.patch`) — data
  collection services, Adjust and install source attribution do not start; data submission is
  off by default (`Settings.kt.patch`); crash reports are neither collected nor offered
  (`Analytics.kt.patch`).
- Mozilla experiments and remote changes (Nimbus) are not loaded; the bundled list is empty
  (`NimbusSetup.kt.patch`, `initial_experiments.json`).
- The first screen with Mozilla's terms is not shown (`FeatureFlags.kt.patch`).
- Recommendations and promotional content on the start page and sponsored shortcuts are turned off
  (`nimbus.fml.yaml.patch`, `Settings.kt.patch`).
- Notifications via Firebase do not work: the build has no Firebase configuration.
- Engine preferences (`src/mobile/android/app/geckoview-prefs.js.patch`): telemetry, captive
  portal detection, country detection, sending the add-on list and Mozilla VPN are turned off —
  the same decisions as in `configs/prefs/release.js` for desktop.

### What is removed from the interface

There is nowhere in the app to sign in to a Mozilla account: the sign-in item is removed from settings, the main menu, the tab
list (the "Synced tabs" page), the empty bookmarks screen, "Share" ("Send
to device") and the settings for passwords, cards and addresses. Hidden: "Data collection", "Rate on Google Play",
the labs section, "Remote improvements", the app icon chooser (Firefox icons), Mozilla VPN and page
summaries (requires a Mozilla account). "About" keeps the licenses and the list of libraries.
The built-in "make this your default browser" messages are turned off.

Kotlin edits are made to change as little as possible: a default value, a visibility condition,
a list item. The build runs with "warnings = errors", and it can only be checked on GitHub.

Not done yet (next steps): the label of the current space next to the address bar and opening a
link in another space,
adding a code from an `otpauth://` link on a website page; the "Learn more" links in
settings and "Who might be able to see my activity?" in private mode lead to Mozilla help;
Google libraries (Firebase, Play Services) are part of the app; images of the former Firefox icons
(the icon chooser is hidden, but the files remain inside the app).

## Build

A local build needs a machine with ~40 GB of free space; usually the build runs on GitHub: the
**Android** workflow (`.github/workflows/android.yml`), started manually, about two hours.

```sh
export TARGET_PLATFORM=android TARGET_ARCH=aarch64 BROWSER_RELEASE=1
python3 tools/build.py download
python3 tools/build.py import      # patches, src/ files, the name in UI strings
python3 tools/build.py bootstrap   # Mozilla toolchains, Android SDK, NDK, JDK in ~/.mozbuild
python3 tools/build.py build       # the engine, then the app (gradle fenix:assembleRelease)
python3 tools/build.py package     # checks and dist/tabora-<version>-android-arm64-v8a-unsigned.apk
```

`package` checks the finished file: the package name, no shared user with Firefox, the
engine and the blocker modules present inside `omni.ja`, no foreign signature.

The app version is `displayVersion` from `browser.json` (the same as the desktop browser's).
The build number (versionCode) grows over time on its own.

## Local app build (without the engine)

UI changes do not require rebuilding the engine. `tools/android/local.sh` builds only the
app on top of a ready engine in a few minutes — this is how Kotlin (the build runs with
"warnings = errors") and the look in the emulator are checked:

```sh
tools/android/local.sh setup <file from GitHub>.apk              # the engine from our build
tools/android/local.sh setup geckoview-omni-arm64-v8a-….aar --mozilla   # or a ready Mozilla engine of the same version
tools/android/local.sh build       # the app: engine/obj-android-local/gradle/…/outputs/apk/release/
tools/android/local.sh compile     # only check that Kotlin compiles
```

With the Mozilla engine there is no ad blocker and none of our engine preferences: it is good for looking at
the interface while there is no build of our own. Such a file is never published. For the emulator it
is signed with a separate test key (`TABORA_ANDROID_KEYS_DIR=<directory> tools/android/sign.sh init`),
not with the release key.

### Checking the account with a local server

For checks, the module is built with the address of a local account server; such a build is marked in
`build.json`, and `tools/build.py package` will not let it into a release:

```sh
node tools/web/build-phone.mjs engine/mobile/android/fenix/app/src/main/assets/extensions/tabora \
  --api http://127.0.0.1:7711 --fill-test http://127.0.0.1:8797
tools/android/local.sh build
adb reverse tcp:7711 tcp:7711    # the server on this machine is visible to the emulator as 127.0.0.1
```

`--fill-test` allows code autofill on one test page without https (in a release — https
only). In such a build "Sign in with QR code" first asks the same test
address for the code text (the `qr.txt` file): the emulator's camera cannot capture a real code. If the file is missing,
the regular scanner opens. Owner confirmation is checked in the emulator with a lock code:
`adb shell locksettings set-pin 1234`, and at the end `locksettings clear --old 1234`.

The address must be exactly 127.0.0.1 through `adb reverse`: the module page does not make http requests to `10.0.2.2`
(the page counts as secure). The module logic is checked without an emulator against the same server:
`TABORA_API=http://127.0.0.1:7711 node tools/web/test/run.mjs phone`; a second device for an
end-to-end check — `tools/web/test/tabs-cli.mjs`; QR sign-in — `run.mjs pair`, bookmarks —
`run.mjs marks`, spaces — `run.mjs spaces`.

In a release build the engine console does not go to the log. In the emulator it is enabled by an engine
config file (`adb shell am set-debug-app --persistent app.tabora.browser`, then the file
`/data/local/tmp/app.tabora.browser-geckoview-config.yaml` with `prefs: { geckoview.console.enabled: true,
consoleservice.logcat: true }`); messages of the Kotlin part carry the `TaboraAccount` tag.

## Signing

The build produces an unsigned file; there is no signing key in CI. Signing is done on your own machine:

```sh
tools/android/sign.sh init                       # once: create the key
tools/android/sign.sh dist/tabora-…-unsigned.apk # align, sign, verify
```

Key: `~/.config/tabora/android-keys` (`TABORA_ANDROID_KEYS_DIR`). A phone accepts an update
only with the same signature, so there is one key for the whole life of the app — keep a copy of it separately.

## Checking in the emulator

```sh
adb install -r dist/tabora-…-android-arm64-v8a.apk
adb shell monkey -p app.tabora.browser -c android.intent.category.LAUNCHER 1
```
