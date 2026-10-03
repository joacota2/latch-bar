# Maintaining third-party attribution

The macOS app ships `LICENSE`, `NOTICE`, `THIRD_PARTY_NOTICES.txt`, and the `third-party/` directory in `Contents/Resources`. In Finder, choose **Show Package Contents** to read them. The README also links to these files for source users.

## Regenerate after dependency changes

Requires Python 3.11 or newer, Node.js, and Cargo on `PATH`:

```sh
npm ci
npm run licenses:generate
npm run licenses:check
```

The generator uses both macOS target dependency graphs, production npm packages, locked checksums, and reviewed supplemental license files. It does not run dependency scripts. Package archives may be downloaded from crates.io/npm; verified archives in Cargo's cache or the system temporary directory are reused.

Review the resulting `THIRD_PARTY_NOTICES.txt`, `third-party/manifest.json`, and MPL source archives. All changes are deterministic: there are no timestamps, local paths, or machine-specific paths in generated output. CI checks input/output hashes offline, so dependency changes cannot silently leave stale notices. The generation command requires network access when an archive is not cached.

Input hashes normalize JSON/TOML formatting and omit only Latch Bar's own version fields. Release Please can therefore bump the app version without regenerating unchanged dependency notices. Dependency versions, checksums, and all other metadata remain covered.

When a package omits its notices, add a version-specific entry to `third-party/supplements.json`, preserving its license and notices from a verifiable upstream revision. Store the full text under `third-party/supplemental/` and record its SHA-256 and source URL. Do not invent the copyright owner or silently substitute a generic license. Review any new license expression before extending the generator's approved terms.

MPL source archives are copied unmodified from crates.io and verified against `Cargo.lock`; the manifest records their versions, download URLs, and checksums. If we patch an MPL component, this unmodified-source procedure is no longer sufficient: include the actual modified source and its MPL notices before distributing it. The generator rejects Git/path dependencies until they receive a reviewed attribution procedure.

## Verify a packaged app

```sh
npm run licenses:bundle -- '/path/to/Latch Bar.app'
```

This compares every licensing resource byte-for-byte with the reviewed files, including supplemental notices and source archives. Release CI checks the signed app, the app extracted from the updater archive, and the app mounted read-only from the DMG. Each check runs before release publication; the existing signature and notarization checks also remain in place. Merely compiling the app does not verify packaging.

## Assets and branding

See [PROVENANCE.md](PROVENANCE.md) for ownership evidence and the asset-change review procedure, and [BRAND.md](BRAND.md) for how forks should distinguish themselves from official distributions. These documents do not modify the Apache license or the licenses of dependencies.
