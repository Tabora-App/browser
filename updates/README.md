# Tabora updates

- `<channel>/<build target>/manifest.json` — the signed (Ed25519) target manifest: the latest version,
  the minimum allowed version (below it the update is mandatory; `0.0.0` — not mandatory), notes, the signing
  time (`issued`: the client will not accept a manifest older than one it has already seen), the validity period (`expires`:
  an expired manifest is rejected) and the package for this platform (address, sha512, size, buildID).
- `<channel>/<build target>/update.xml` — the manifest of the engine's stock updater (a full MAR in GitHub Releases).
  The client accepts it only if it matches the package from `manifest.json`.
- `channel.json` — the shared manifest for old builds (before signed manifests); `minimum` in it is not raised.

The files are created by `tools/release.py` after the build is packaged (do not edit them by hand: the signature will no longer match,
and `release.py` will refuse to extend or use such a manifest); the validity period is extended by
`tools/release.py refresh` (it changes only `issued` and `expires`). Packages are signed with the Tabora key (outside the repository,
`TABORA_MAR_KEYS_DIR`); the public certificates are in `src/toolkit/mozapps/update/updater/`. The client reads
the manifests from GitHub raw addresses taken from default preferences (`tabora.update.manifestUrl`, `tabora.update.url`).
Details: `docs/UPDATES.md`.
