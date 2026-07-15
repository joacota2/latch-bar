# Latch Bar

Latch Bar is a contextual desktop surface for the Codex installation already on a user's computer. Select content, choose a permission-scoped Codex profile, and inspect or apply the streamed result without manually moving context between applications.

## What is implemented

- A polished Codex Studio with Agents, Runs, MCPs, Skills, Workspaces, and Settings.
- Full agent CRUD and configuration for prompt, runtime, sandbox, approvals, workspace, context, tools, Skills, and output.
- A separate always-on-top Context Bar window driven by real macOS text selections.
- Native Accessibility capture, secure-field exclusion, bounds positioning, direct replacement, and clipboard-paste fallback.
- Persistent local agents, settings, and real run history (no seeded or simulated runs).
- A Tauri 2 shell with Codex status, MCP/Skill discovery, and a supervised `codex app-server` JSONL client with streaming, approvals, cancellation, and shutdown.
- A platform-adapter boundary with the Windows UI Automation module isolated for the next implementation.

The browser build is Studio-only. Selection capture and Codex execution intentionally fail closed outside the Tauri desktop shell; there is no simulated runtime adapter.

## Run it

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:1420`.

Production web build and tests:

```bash
npm run build
npm test
```

Native development requires a Rust toolchain:

```bash
rustup update stable
npm run tauri dev
```

On first launch, open **Settings → Selection → Enable Accessibility**, allow Latch Bar under **System Settings → Privacy & Security → Accessibility**, then relaunch if macOS requests it. Select at least three characters in another application; the native Context Bar appears beside the selected range. Choosing an agent starts a real `codex app-server` turn using the existing Codex login. **Replace** writes through Accessibility and falls back to a targeted Command-V paste when the source control does not expose direct replacement.

## Architecture

```text
React Studio                 Native Context Bar window
      │                                │
      └──────────── Tauri commands ────┘
                       │
                       ├── PlatformAdapter
                       │      ├── macOS AXUIElement (implemented)
                       │      └── Windows UI Automation (next)
                       ├── Codex environment scanner
                       ├── MCP / Skill discovery
                       └── Codex app-server manager
                              ├── thread/start
                              ├── turn/start / interrupt
                              ├── streamed notifications
                              └── approval responses
```

The runtime protocol follows the current [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server.md). MCP configuration remains owned by Codex in `config.toml`, and Skills remain in Codex-discovered global, plugin, managed, or workspace locations.

## Security decisions

- Profiles default to read-only.
- Full access always shows a persistent warning.
- MCP credentials are never copied; profiles store only server IDs.
- Selected text is escaped and placed in a delimited data block with explicit runtime rules.
- Selected source text is not stored by default.
- Screenshot context is off by default.
- Password managers and secure fields are excluded from contextual capture.

See `TASKS.md` for the implementation and platform-release checklist.
