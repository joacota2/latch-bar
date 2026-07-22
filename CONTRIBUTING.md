# Contributing

Create short-lived branches from `main` and open pull requests back to `main`. Prefer squash merging and give the pull request a Conventional Commit title so automated releases can determine the next version:

- `fix: preserve the selected editor when replacing text` creates a patch release.
- `feat: add configurable global shortcuts` creates a minor release.
- `feat!: replace the stored agent schema` creates a major release.
- `docs:`, `test:`, `refactor:`, `build:`, and `chore:` do not create a release by themselves.

The `main` branch should always pass `npm test`, `npm run build`, `npm run check:version`, and `cargo check --manifest-path src-tauri/Cargo.toml --locked`.

Release Please maintains a release pull request containing the synchronized Node, Tauri, and Rust versions plus `CHANGELOG.md`. Merging that pull request creates a draft GitHub Release. The release workflow then builds, signs, notarizes, verifies, and publishes the universal macOS DMG automatically.
