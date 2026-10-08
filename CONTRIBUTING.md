# Contributing

## License

Unless you explicitly state otherwise, contributions intentionally submitted for inclusion in Latch Bar are licensed under the [Apache License, Version 2.0](LICENSE), as described in Section 5 of that license. You retain copyright in your contributions.

Preserve applicable third-party license and attribution notices when adding or updating dependencies, code, or assets.

Only submit material you have the right to contribute. Identify the source and license of copied code or assets. After dependency changes, run `npm run licenses:generate` and `npm run licenses:check`, and commit the reviewed notices, manifest, and source archives. Asset changes also require a provenance review and updated asset hashes; see [the attribution guide](docs/THIRD_PARTY.md). Fork distributions should follow the [brand policy](docs/BRAND.md).

## Local development

Use Node.js 22.12+ (Node 24 is also supported), a Rust toolchain, and an installed, signed-in Codex runtime for agent execution. Native selection capture and replacement currently support macOS only. Attribution tooling and its tests require Python 3.11 or newer.

```bash
npm ci
npm run tauri dev
```

To preview Studio in a browser:

```bash
npm run dev
```

Open `http://127.0.0.1:1420`. The browser preview cannot capture desktop selections or execute agents; those features require the Tauri shell.

Grant permissions under **Settings → Permissions → Set up permissions**. Development builds are ad-hoc signed, so rebuilding the native executable may require removing its old entry in macOS Accessibility settings and granting access again.

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
| Context Bar | `contextSession.ts` is the pure lifecycle controller; `runtimeEvents.ts` buffers transport events, `approvals.ts` validates disclosure, `outputActions.ts` dispatches output, and `components/context/` renders presentation. `ContextBarWindow.tsx` connects them to native handles. |
| Codex | `src-tauri/src/app_server.rs` and `runtime.rs`: runtime discovery, execution, approvals, cancellation, and shutdown. |
| Prompt context | `src/services/promptBuilder.ts`: selection policy, escaping, and context limits. |
| Persistence | `src-tauri/src/persistence.rs` and `src/store/LatchStore.tsx`: shared desktop state and frontend state management. |

Codex owns runtime catalogs, effective configuration, MCP credentials, and Skill discovery. Latch stores agent choices and product preferences. Selecting Skills does not isolate an agent from other Skills allowed by Codex policy.

Studio and the Context Bar share `latch-state.json` in Tauri's application data directory through atomic, revision-checked writes. Local history is limited to 200 runs; disabling it clears Latch's history, independently of Codex history. Browser preview saves require Web Locks support.

## Validation

Run the checks used by CI:

```bash
npm run format:check
npm run lint
npm test
npx playwright install webkit
npm run test:browser
npm run check:native
npm run build
npm run check:version
npm run licenses:check
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

## Security checks

Report vulnerabilities privately using [SECURITY.md](SECURITY.md). Before submitting, run `gitleaks git . --log-opts="--all" --redact=100`, `npm audit`, and `python3 scripts/audit-dependencies.py` (requires Cargo audit 0.22.2). CI runs these checks on pull requests, pushes to main, and weekly. New or expired Rust advisory exceptions fail the audit; do not add broad ignore rules. Any supported-platform change requires reviewing the advisory policy as well as attribution.

## Reliability and compatibility contracts

Keep macOS 12.0 support and the Safari 15 build target. Syntax transpilation does not polyfill APIs: use the secure UUID helper, load `wicg-inert` before rendering, and keep ordinary focus outlines and reduced-motion status text. Avoid `Object.hasOwn`, `.at()`, and unguarded `crypto.randomUUID`. `replaceAll`, optional chaining, and nullish coalescing are supported by the selected baseline. Browser-only Web Locks persistence is intentionally unavailable on old engines; desktop persistence uses native revision checks.

Every Context Bar operation belongs to a session generation and run. Replacement requires the original editor/process/text and an exact Accessibility range; marker-only editors are copy-only. Never retry an unverified dispatch. Approval IDs preserve number/string identity, stay queued until successfully answered, and are validated again by the native process registry. Unknown permission formats can only be denied or cancelled.

Environment caches are keyed by workspace and profile. Never resolve an agent's Skills against the base catalog or another editor's catalog. Stable Skill identities include source, canonical path, and plugin identity where supplied. Legacy slugs migrate only when unique; missing and ambiguous references block execution. Agent exports are version 2; version 1 and unwrapped imports remain supported. State schema 2 drops previously nonfunctional fields without discarding other user data.

Completed Studio handoffs are native memory only and omit selected text/conversation. Subscribe before reading; acknowledge after the result view mounts. The Context Bar keeps its answer until acknowledgement, with a five-second retryable timeout. Never backfill a temporary answer into history. Reset epochs reject old transfers and writes.

`cargo test` runs a scripted Python app-server through the production pipe driver without Codex, login, or network access. WebKit/axe tests cover keyboard dialogs, compatibility fallbacks, local fonts and contrast. They do not certify macOS Accessibility or an old OS WebKit. See the signed-app release matrix in `docs/RELEASING.md`. Keep mechanical formatting in a separate change from behavior whenever practical. Use `npm run format` and `cargo fmt` locally; CI checks never rewrite files.
