# Contributing

## Local development

Use Node.js 22.12+ (Node 24 is also supported), a Rust toolchain, and an installed, signed-in Codex runtime for agent execution. Native selection capture and replacement currently support macOS only.

```bash
npm ci
npm run tauri dev
```

To preview Studio in a browser:

```bash
npm run dev
```

Open `http://127.0.0.1:1420`. The browser preview cannot capture desktop selections or execute Codex agents; those features require the Tauri shell.

Enable Accessibility under **Settings → Selection → Enable Accessibility**. Development builds are ad-hoc signed, so rebuilding the native executable may require removing its old entry in macOS Accessibility settings and granting access again.

For a persistent installed build, use your Apple signing identity:

```bash
APPLE_SIGNING_IDENTITY="Developer ID Application: Example (TEAMID)" npm run tauri build
```

The bundle hook rejects unsigned macOS bundles. Use `npm run tauri build -- --no-bundle` for a compile-only check. Signing, notarization, and updater setup are documented in the [release guide](docs/RELEASING.md).

## Architecture

React renders Studio and the separate native Context Bar window. Both communicate with the Rust backend through Tauri commands.

| Area | Entry points and responsibilities |
| --- | --- |
| Selection and replacement | `src-tauri/src/platform/`: platform adapter, macOS Accessibility and guarded clipboard fallback; Windows is a placeholder. |
| Context Bar | `src/components/ContextBarWindow.tsx`: selected context, streamed answers, replacement, and follow-ups. |
| Codex | `src-tauri/src/app_server.rs` and `runtime.rs`: runtime discovery, execution, approvals, cancellation, and shutdown. |
| Prompt context | `src/services/promptBuilder.ts`: selection policy, escaping, and context limits. |
| Persistence | `src-tauri/src/persistence.rs` and `src/store/LatchStore.tsx`: shared desktop state and frontend state management. |

Codex owns runtime catalogs, effective configuration, MCP credentials, and Skill discovery. Latch stores agent choices and product preferences. Selecting Skills does not isolate an agent from other Skills allowed by Codex policy.

Studio and the Context Bar share `latch-state.json` in Tauri's application data directory through atomic, revision-checked writes. Local history is limited to 200 runs; disabling it clears Latch's history, independently of Codex history. Browser preview saves require Web Locks support.

## Validation

Run the checks used by CI:

```bash
npm test
npm run build
npm run check:version
cargo check --manifest-path src-tauri/Cargo.toml --locked
cargo test --manifest-path src-tauri/Cargo.toml --locked
```

Automated tests and browser previews cannot verify native Accessibility behavior in third-party apps. For selection, replacement, or Context Bar changes, use a signed macOS build and check the relevant cases below before release.

| Scenario | Expected behavior |
| --- | --- |
| Editable text, including emoji and repeated text | Replacement affects exactly the captured range; a stale or unrelated range is rejected. |
| Browser textarea, contenteditable, and an Electron editor | Capture and replacement work where supported; an unacknowledged edit leaves the answer visible and prevents another automatic attempt. |
| Clipboard changes during capture or replacement | New clipboard content is not overwritten by restoration; previous content is restored after a verified edit when ownership is unchanged. |
| Read-only webpage or PDF, password field, excluded app | Read-only text is copy-only; protected context is not captured. |
| Hover, picker, follow-up cancellation, display edges, mixed display scaling, full-screen Spaces | The bar keeps its target, preserves the answer, and stays within the display work area. |
| Switch app or selection during capture, startup, or replacement | Late work cannot target a newer selection or resurrect a closed run. |
| Real Codex session | Agent permissions and MCP configuration apply; approvals, cancellation, output actions, and shutdown work. |

Replacement must revalidate the original target. A dispatched edit is not proof of success: if acknowledgement is unavailable, report that state and do not automatically retry. Editors without a usable selection or copy operation require manual copy/paste.

## Pull requests and releases

Create short-lived branches from `main` and open pull requests back to `main`. Prefer squash merging and use a Conventional Commit title:

- `fix: preserve the selected editor when replacing text` creates a patch release.
- `feat: add configurable global shortcuts` creates a minor release.
- `feat!: replace the stored agent schema` creates a major release.
- `docs:`, `test:`, `refactor:`, `build:`, and `chore:` do not create a release by themselves.

Release Please maintains a release pull request with synchronized versions and `CHANGELOG.md`. Merging it creates a draft release; GitHub Actions builds, signs, notarizes, verifies, and publishes the universal macOS DMG. See the [release guide](docs/RELEASING.md) for setup and recovery procedures.
