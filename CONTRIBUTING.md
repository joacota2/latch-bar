# Contributing

## License

Unless you explicitly state otherwise, contributions intentionally submitted for inclusion in Latch Bar are licensed under the [Apache License, Version 2.0](LICENSE), as described in Section 5 of that license. You retain copyright in your contributions.

Preserve applicable third-party license and attribution notices when adding or updating dependencies, code, or assets.

Only submit material you have the right to contribute. Identify the source and license of copied code or assets. After dependency changes, run `npm run licenses:generate` and `npm run licenses:check`, and commit the reviewed notices, manifest, and source archives. Asset changes also require a provenance review and updated asset hashes; see [the attribution guide](docs/THIRD_PARTY.md). Fork distributions should follow the [brand policy](docs/BRAND.md).

## Development and releases

Create short-lived branches from `main` and open pull requests back to `main`. Prefer squash merging and give the pull request a Conventional Commit title so automated releases can determine the next version:

- `fix: preserve the selected editor when replacing text` creates a patch release.
- `feat: add configurable global shortcuts` creates a minor release.
- `feat!: replace the stored agent schema` creates a major release.
- `docs:`, `test:`, `refactor:`, `build:`, and `chore:` do not create a release by themselves.

The `main` branch should always pass `npm test`, `npm run build`, `npm run check:version`, `npm run licenses:check`, and `cargo check --manifest-path src-tauri/Cargo.toml --locked`. Attribution tooling and its tests require Python 3.11 or newer.

Release Please maintains a release pull request containing the synchronized Node, Tauri, and Rust versions plus `CHANGELOG.md`. Merging that pull request creates a draft GitHub Release. The release workflow then builds, signs, notarizes, verifies, and publishes the universal macOS DMG automatically.
