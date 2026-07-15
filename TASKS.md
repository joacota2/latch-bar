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
- [x] Build an expanded thread view with runtime inspection and constructed-prompt preview.

## Context Bar

- [x] Implement idle, running, approval, result, and error states.
- [x] Implement pinned agents and the full agent menu.
- [x] Implement allow-once, deny, cancel, copy, replace, continue, and expand actions.
- [x] Add a prompt boundary that escapes untrusted selected content.
- [x] Make profile tests create run-history entries.

## Native and Codex integration

- [x] Scaffold the Tauri 2 desktop shell and least-privilege capability file.
- [x] Discover global/project MCP servers without copying credentials.
- [x] Discover Skills from Codex/user/workspace locations with validation metadata.
- [x] Supervise `codex app-server` over JSONL with initialize, thread/start, turn/start, events, approval responses, interruption, and shutdown.
- [x] Generate the integration against locally installed Codex app-server types.
- [ ] Compile native bundles after installing the Rust toolchain on the build machine.
- [ ] Connect platform selection helpers (AXUIElement/AppKit on macOS and UI Automation on Windows) to production signing pipelines.

## Verification

- [x] TypeScript production build.
- [x] Unit tests for prompt isolation and profile/context behavior.
- [x] Browser validation of Agents, full editor, approval flow, result state, and expanded Studio.
- [x] Browser console check with no runtime errors.
- [ ] Native macOS and Windows smoke tests on signed build hosts.
