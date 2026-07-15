# Latch Bar MVP — implementation tasks

## Product foundation

- [x] Define typed contracts for agents, context, output, MCPs, Skills, workspaces, and runs.
- [x] Seed four onboarding profiles plus engineering and UI-review examples.
- [x] Persist agents, runs, and settings locally; keep selected source text off by default.
- [x] Add the normalized SQLite schema for the native shell.

## Codex Studio

- [x] Build the desktop navigation, connection status, and Context Bar pause control.
- [x] Build Agents with pin, enable, create, duplicate, edit, test, and delete flows.
- [x] Build the complete profile editor: prompt, model, reasoning, speed, sandbox, approvals, workspace, MCPs, Skills, context, and output.
- [x] Build Runs with running, approval, completed, failed, and cancelled states.
- [x] Build MCP, Skills, Workspaces, and Settings screens.
- [x] Build real run history and runtime inspection without seeded activity.

## Context Bar

- [x] Implement idle, running, approval, result, and error states from native and app-server events.
- [x] Implement pinned agents and the full agent menu.
- [x] Implement real allow-once, deny, cancel, copy, replace, and Studio actions.
- [x] Add a prompt boundary that escapes untrusted selected content.
- [x] Remove browser/runtime simulation and seeded run-history entries.

## Native and Codex integration

- [x] Scaffold the Tauri 2 desktop shell and least-privilege capability file.
- [x] Discover global/project MCP servers without copying credentials.
- [x] Discover Skills from Codex/user/workspace locations with validation metadata.
- [x] Supervise `codex app-server` over JSONL with initialize, thread/start, turn/start, events, approval responses, interruption, and shutdown.
- [x] Generate the integration against locally installed Codex app-server types.
- [x] Compile the native macOS application with the installed Rust toolchain.
- [x] Implement macOS selection capture, selection bounds, secure-field exclusion, permission status, replacement, and paste fallback with AXUIElement/CoreGraphics.
- [x] Add a cross-platform `PlatformAdapter` and an explicit Windows UI Automation module boundary.
- [ ] Implement the Windows adapter with UI Automation and validate it on a Windows host.
- [ ] Connect notarized macOS and signed Windows bundles to production release pipelines.

## Verification

- [x] TypeScript production build.
- [x] Unit tests for prompt isolation and profile/context behavior.
- [x] Browser validation of Studio without a simulated runtime surface.
- [x] Browser console check with no runtime errors.
- [x] Unsigned native macOS debug build.
- [ ] Manual macOS Accessibility selection/replacement smoke test after granting the local app permission.
- [ ] Native Windows smoke test on a signed Windows build host.
