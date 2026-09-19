# Implementation audit — 15 September 2026

Audited baseline: `be528fa` on `main`. Scope: the React Studio and Context Bar, shared state, prompt construction, Tauri commands and capabilities, macOS Accessibility/clipboard adapter, Codex discovery and execution, tests, and CI/release configuration. Windows is explicitly unimplemented and is not made functional by this change.

The reported failures have identifiable implementation causes. The largest architectural issue is that selection observation, target identity, window placement, and replacement acknowledgement were treated as interchangeable evidence. They are separate contracts: pointer movement is not a new selection, a matching string is not a unique range, and delivering a paste shortcut is not acknowledgement of an edit.

## Findings and remediation

P1 means potential unintended edits, context disclosure, or violated execution/privacy policy. P2 means broken user behavior or reliability. These are code findings; the table does not claim reproduction in every third-party app.

| Priority | Finding at baseline | Change |
| --- | --- | --- |
| P1 | Replacement had no selection token and direct writes compared only selected text. Identical text at another range could pass. | Every capture has an ID; native replacement checks the ID and retained UTF-16 range when exposed. Successful dispatch consumes the target, preventing repeated edits. |
| P1 | Paste always performed Cmd-C to validate, even with usable AX selected text. Editors without copy support were rejected unnecessarily. | Prefer AX text/range evidence, using guarded copy only when AX text is unavailable. Check retained editor focus, process, and range again before dispatch. |
| P1 | A collapsed or missing selection after paste counted as success. AX setter success also did not establish the expected document contents. | Verify the expected full AX value where available, otherwise the replacement selection. Return `verified: false` when acknowledgement is unavailable, keep the answer visible, and disable repeat dispatch. No retry after an ambiguous write. |
| P1 | Replacement overwrote the clipboard without restoring it. | Snapshot before paste; restore only after verified application and unchanged ownership. An unverified paste leaves the replacement available for delayed consumption/manual use. Clipboard ownership cannot be atomically compared and swapped by NSPasteboard. |
| P1 | `{{selection}}` and other prompt variables bypassed escaping, context switches, and length limits. Title generation also ignored the selection switch. | Apply policy and Unicode character limits before interpolation; escape data, expand in one pass, and respect the same selection policy for titles. This improves data separation, not a guarantee against model prompt injection. |
| P1 | An empty or stale frontend MCP catalog produced no disabling overrides, allowing inherited configurable servers despite an agent's empty selection. | The executing app-server now supplies `config/read` before `thread/start`; native code disables every unselected configured server. Invalid/unavailable configuration prevents starting. The title helper also disables configured MCPs. |
| P1 | `storeHistory` was ignored, and disabling original-selection storage did not remove previously persisted selection messages. | Enforce settings at every write, purge local history when disabled, remove original-selection messages when that option is disabled, and bound retained history to 200 runs. Codex has its own history; responses may quote source content. |
| P2 | Geometry was part of selection identity, AX hit testing followed the current cursor, and initial display used a different width from React. | Use capture identity rather than coordinates for deduplication; hit-test the selection gesture's endpoint; retain geometry for the unchanged target; suspend polling over the bar; size the compact bar before its first display. Recheck interaction state after slow capture. |
| P2 | The Workspaces ellipsis had no handler; both folder buttons only displayed placeholder toasts. | Add a native directory picker, persistent/deduplicated saved folders, Finder reveal, copy path, save/remove saved folder, and agent creation with the fixed path set immediately. Menu supports Escape/outside dismissal and is not clipped by the list. |
| P2 | Ask-each-time and active-app workspace modes silently became projectless runs. Missing fixed/recent paths did too. | Ask for a folder, cancel without starting, report missing paths, and validate fixed directories natively. Active-app mode explicitly asks for a folder because arbitrary apps do not expose a reliable working directory. |
| P2 | Runtime listeners were recreated on state changes, and any early event could claim the starting run. Closing during startup could leave an orphan run. | Keep subscriptions stable through refs, buffer early events until the returned run ID is known, ignore foreign events, and invalidate/stop late starts after cancellation. |
| P2 | Cancelling the follow-up composer unpinned the completed result; failed replacement converted a successful run to an error screen. | Keep results pinned and preserve answer/copy/follow-up actions on replacement errors. Native replacement does not dismiss the bar. |
| P2 | Output action, expected format, and streaming preference were largely ignored. An empty result became replaceable placeholder prose. | Honor copy/replace/open-Studio actions, include expected format in the prompt, respect streaming visibility, and never replace with an empty-result placeholder. Full-access runs remain visibly identified. |
| P2 | Child shutdown killed without waiting; application exit did not drain processes; EOF/startup stalls and unsupported interactive requests could hang UI state. | Reap children on removal/exit, notify on EOF, bound initial startup to 30 seconds, use unique interrupt request IDs, and explicitly reject unsupported server requests instead of leaving them pending. |
| P2 | Slow discovery, startup, and replacement could occupy the command/UI thread. Gesture tracking was not retried after the initial Accessibility grant. | Dispatch those blocking operations to workers and retry gesture installation when trust becomes available. |
| P2 | Saving an agent/run from one window could restore stale settings or agents from its closure; React state updater callbacks performed persistence side effects. | Apply mutations to the latest persisted snapshot outside state updaters. State events reload the latest stored snapshot. This reduces stale overwrites; localStorage is still not a transactional database. |
| P2 | Several controls advertised unsupported behavior or reported success without an operation. | Disable unsupported login/menu-bar, screenshot/clipboard-context, logs and diagnostic controls; make configuration reveal and sample prompt preview functional; report copy/refresh errors; label Codex-managed MCP/Skill availability as read-only. |
| P2 | The locked frontend toolchain had nine reported advisories, including a critical Vitest advisory; CI compiled Rust but did not execute its tests. | Upgrade to patched Vite 7/Vitest 4 tooling and compatible transitive releases, declare the Node requirement, and execute Rust tests in macOS CI. `npm audit` reports zero advisories at validation time. |

## Source map

- Capture/replace contracts: `src-tauri/src/platform/macos.rs` (`capture_selection`, `replace_selection`, `paste_to_target`, `verify_replacement`).
- Window positioning and IPC: `src-tauri/src/platform/mod.rs` (`selection_key`, `start_selection_monitor`, `resize_context_bar`).
- Runtime/permissions: `src-tauri/src/runtime.rs` (`runtime_mcp_overrides`, `start_codex_run_blocking`, `RuntimeProcess::drop`).
- UI lifecycle: `src/components/ContextBarWindow.tsx`; workspace operations: `src/pages/WorkspacesPage.tsx`.
- Context/privacy: `src/services/promptBuilder.ts`, `src/store/LatchStore.tsx`.

## Design assessment

The platform adapter boundary, retained AX references, explicit secure-field/application exclusions, gesture-gated copy fallback, typed IPC, existing parser tests, and default read-only agents are useful foundations. React renders response text without raw HTML injection. Release automation already signs/notarizes the macOS bundle and verifies synchronized versions; this PR does not change that trust setup.

The native adapter remains intentionally conservative. A control must expose direct replacement or affirmative editability before automatic editing is offered. A rejected AX write can fall back to paste only when the original full value and selection are demonstrably unchanged. Missing acknowledgement is surfaced, rather than triggering increasingly destructive fallback sequences. An editor that exposes neither a usable selection nor a working copy operation cannot be reliably captured; use manual copy/paste or Codex directly in that case.

MCP overrides cover configurable servers reported in effective configuration. Codex-managed services and Skills are governed by Codex policy; attaching selected Skills is not an isolation boundary. The UI now states this rather than promising exclusive Skill loading.

## Validation

- All 44 frontend tests pass. The regression suite covers original bar behavior, capture IDs, unknown replacement outcomes, empty completions, early/foreign runtime events, cancellation during startup, configured result actions, prompt escaping/policy/Unicode limits, workspace actions/persistence, and history preferences.
- All 32 native tests pass on macOS arm64. The Rust regression suite covers selection identity, screen-edge positioning, UTF-16 replacement boundaries, stale-ID rejection, gesture classification, effective MCP restrictions, unsupported request handling, discovery parsers, and title generation.
- Required checks: `npm test`, `npm run build`, `npm run check:version`, `cargo test --manifest-path src-tauri/Cargo.toml --locked`, and `cargo check --manifest-path src-tauri/Cargo.toml --locked`.
- Browser visual inspection used a temporary saved-folder fixture to verify the Workspaces menu opens, renders all actions, and is not clipped. Fixture files were removed afterward. Browser UI checks cannot exercise Accessibility or native clipboard delivery.

## Remaining limits and release acceptance

These changes are not evidence that every native editor now supports automatic replacement. Run the following matrix with a **signed** build before publishing a release. Ad-hoc recompilation changes the identity associated with macOS Accessibility permissions; this audit did not grant new OS permissions or run paid Codex turns.

| Scenario | Required observation |
| --- | --- |
| TextEdit/plain editable input, including emoji and repeated text | Replacement affects exactly the captured range; an unrelated range is rejected; old clipboard is restored after verified application. |
| Browser textarea/contenteditable and an Electron editor | AX-first validation works when copy is unavailable; ignored or unacknowledged paste leaves a visible result and no automatic second attempt. |
| Read-only webpage/PDF, password field, excluded application | Read-only text is preview/copy only; protected context is not captured. |
| Compact hover, picker, follow-up cancel, display edges, Retina/non-Retina and full-screen Spaces | No hover-driven relocation or result dismissal; deliberate expansions remain inside the display work area. |
| Switch app/selection while capturing, starting, or replacing | Late work cannot target a newer selection or resurrect a closed run. |
| Signed app with a real Codex session | Base/named profiles apply their own MCP inventory; approvals, cancellation, output actions, and shutdown complete correctly. |

Further architectural work: migrate localStorage to a versioned native transactional store for concurrent-window atomicity, malformed-record recovery and quota handling; add native crash/relaunch reconciliation for in-flight run history; split the large adapter/component into capture, replacement and run-state modules after real-app acceptance. Unsupported platform/features remain explicitly unavailable rather than simulated. These are recorded limitations, not claims of completed functionality.
