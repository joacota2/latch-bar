# Latch Bar

Latch Bar is a contextual desktop surface for the Codex installation already on a user's computer. Select content, choose a permission-scoped Codex profile, and inspect or apply the streamed result without manually moving context between applications.

## What is implemented

- A polished Codex Studio with Agents, Runs, MCPs, Skills, Workspaces, and Settings.
- Full agent CRUD and configuration for prompt, runtime, sandbox, approvals, workspace, context, tools, Skills, and output.
- A functional Context Bar state machine: idle → running → approval → result/error.
- An expanded thread surface with effective runtime settings and constructed prompt inspection.
- Persistent browser-preview state and a native SQLite migration.
- A Tauri 2 shell with Codex status, MCP/Skill discovery, and a supervised `codex app-server` JSONL client.

The browser adapter is deterministic so the complete product flow can be reviewed without executing real commands. In the Tauri shell, discovery and runtime commands switch to the local Codex installation.

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

## Architecture

```text
React Studio + Context Bar
          │
          ├── Browser preview adapter (deterministic QA)
          │
          └── Tauri commands
                 ├── Codex environment scanner
                 ├── MCP / Skill discovery
                 ├── SQLite schema
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
