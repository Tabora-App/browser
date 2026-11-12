# Interface languages

Tabora is available in Russian, English, Ukrainian and Spanish. The language is taken from the system (the website and the web app
take it from the visitor's browser); for any other language English is shown.

The source language is Russian: strings are written in code in Russian, and the other languages have
"Russian string → translation" dictionaries. The dictionary key is the Russian string itself; there are no separate identifiers.

| Where | How a string is marked | Dictionaries | Who chooses the language |
| --- | --- | --- | --- |
| Browser shell (`src/browser/base/content/tabora`) | ``tt`…` `` from `i18n/I18n.sys.mjs` | `i18n/<lang>.json` → `tabora/i18n/<lang>.json` | the browser's interface language |
| Web app (`web/`) | ``t`…` `` from `src/core/i18n.js` | `i18n/<lang>.json` | the browser's language, the choice on the sign-in screen |
| Server (the server repository, Tabora-App/server) | plain strings, translated on output (`src/i18n.rs` there) | `i18n/<lang>.json` in the server repository | the request's `Accept-Language`, the account language for emails |
| Website (the site repository, Tabora-App/site: `pages/index.html`) | a Russian page template | `i18n/<lang>.json` in the site repository | the address `/ru/`, `/en/`, `/uk/`, `/es/`; "/" — by `Accept-Language` |
| Android (`src/mobile/android`) | `tabora_strings.xml` resources | `values-<lang>/` | the phone's language |
| Account in the Android app (`web/src/phone`) | ``t`…` ``, as in the web app | `i18n/<lang>.json` | the app language; after a change — from the next launch |
| The engine itself (menus, settings, error pages) | Fluent | firefox-l10n, the list in `browser.json` (`locales`) | the system language |

## Browser shell

- ``tt`Отмена` `` (Cancel) — a string; ``tt`Письмо от ${name}` `` (Message from …) — with a substitution (in the dictionary: `Письмо от {0}`).
- `ttForm(n, tt`письмо|письма|писем`)` (message/messages) — the word form for a number: in the dictionary each language has as many
  forms as it needs (English and Spanish — two, Ukrainian — three).
- `ttr(text)` — translation of text that arrived ready-made: messages from the server and from code shared with the web app
  (password strength estimation, message parsing, OpenPGP — that code is not tagged, so that the copies match letter for letter).
- Strings in page markup (`mail.html`, `downloads.html`, `about.xhtml`) are translated by
  `translateDocument(document)` on load.
- Dates and numbers — `ttLocale()`.
- One Russian word can be two different words in another language. Such a place is marked with a meaning at the end
  of the string: ``tt`Открыть@@сейф` `` (Unlock), ``tt`Вставить@@буфер` `` (Paste),
  ``tt`Отменить@@действие` `` (Undo). The mark is part of the key and never reaches the screen.
- Logic must not depend on the text of a string: compare codes and flags, not messages.

The language of Tabora strings is the browser's interface language (`intl.locale.requested` is empty, that is, "same as
the system"; it is changed in "Settings → Languages", after a restart). For checks, the language of Tabora strings
can be set with the `tabora.lang` preference (`en`, `uk`, `es`).

## New string

1. Write it in Russian with the tag. To tag the strings in a new file:
   `node tools/i18n/wrap.mjs --write --tag=tt --import-spec=chrome://tabora/content/i18n/I18n.sys.mjs <file>`
   (for window scripts — `--script`, for the web app — `--import=web/src/core/i18n.js`).
2. `node tools/i18n/extract.mjs <desktop|web> --todo` — the list of untranslated strings in
   `.build/i18n-todo-<set>.json`. Server strings have their own tool: `tools/i18n.mjs` in the server
   repository (Tabora-App/server).
3. Translate and accept: `node tools/i18n/merge.mjs <en|uk|es> <file.json>` — checks the substitutions
   and the number of word forms.
4. `node tools/i18n/desktop.mjs` — rebuild the shell dictionaries (they are committed; `--check` tells
   if they are stale). `node tools/i18n/prune.mjs` removes strings that are no longer in the code.
5. `node tools/i18n/extract.mjs <set> --strict` does not let untranslated strings through; the web app deployment
   and the website build do this themselves.

## New language

Add the language code to `LANGS` (`tools/i18n/catalog.mjs`, `I18n.sys.mjs`, `web/src/core/i18n.js`,
`src/i18n.rs` in the server repository), the order of number forms to `FORMS`, the dictionaries `i18n/<lang>.json`,
`i18n/<lang>.json` in the server repository (Tabora-App/server), `i18n/<lang>.json` in the site repository
(Tabora-App/site), the engine language to `browser.json` and
the Android resources (`docs/ANDROID.md`).
