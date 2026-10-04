# Latch Bar

https://github.com/user-attachments/assets/448b1336-c6d1-4ff6-a669-37a525eb525d

<p align="center">
  <strong>Your agents, right where you need them.</strong><br>
  Select context, choose a permission-scoped agent, and inspect or apply the streamed result without breaking your flow.
</p>

<p align="center">
  <a href="https://github.com/joacota2/latch-bar/releases/latest/download/Latch-Bar.dmg">
    <img alt="Download Latch Bar for macOS 12 or later" src="https://img.shields.io/badge/Download_for_macOS_12%2B-Universal_DMG-000000?style=for-the-badge&amp;logo=apple&amp;logoColor=white">
  </a>
  <img alt="Windows support is planned" src="https://img.shields.io/badge/Windows-Planned-0078D4?style=for-the-badge&amp;logo=windows11&amp;logoColor=white">
</p>

<p align="center"><sub>The notarized macOS download is universal for Apple silicon and Intel. Windows support is planned.</sub></p>

## How it works

1. **Select text** in a supported app, browser, or document.
2. **Choose an agent** from the floating Context Bar.
3. **Review the answer**, ask a follow-up, copy it, or replace the original text when the editor supports it.

<img src="docs/media/latch-bar-conversation.jpg" alt="Latch Bar's Context Bar showing a response and follow-up beside selected text" width="100%">

Latch Bar includes five agents to get started: **Improve writing**, **Translate to English**, **Explain simply**, **Draft a reply**, and **Summarize**. Create your own in Studio, with a prompt, model, workspace, tools, and permissions for each agent.

<img src="docs/media/latch-bar-studio.jpg" alt="Latch Bar Studio showing agent configuration" width="100%">

## Get started

The current release uses Codex as its agent runtime and requires **macOS 12 or later** with Codex installed and signed in. The download supports both Apple silicon and Intel Macs.

1. [Download Latch Bar](https://github.com/joacota2/latch-bar/releases/latest/download/Latch-Bar.dmg) and install it in Applications.
2. Open **Settings → Selection → Enable Accessibility**, then allow Latch Bar in **System Settings → Privacy & Security → Accessibility**.
3. Select at least three characters in another app and choose an agent from the Context Bar.

Latch uses your existing Codex login. The default agents work without a workspace or integrations.

Updates are available under **Settings → General → Updates**. Public downloads and current in-app updates do not require GitHub CLI or a GitHub account. If an older build asks you to sign in to GitHub, install the latest DMG once to switch to public updates.

To report a vulnerability, use the [private security reporting route](SECURITY.md).

## Text capture and privacy

Capture and replacement depend on what the source app exposes. Read-only text can be used as context; **Replace** is available only when both the editor and the agent allow it. If an edit cannot be confirmed, the answer stays visible and Latch prevents another automatic attempt. You can always copy the answer for manual use.

- Password managers and secure fields are excluded from capture.
- Custom editors may use a clipboard fallback after a selection gesture. Latch preserves the previous clipboard when it can safely restore it without overwriting newer content.
- Agents default to read-only permissions. Full-access agents display a warning.
- Original selected text is not stored in local history by default. Responses may quote it, and Codex manages its own history independently.

## Roadmap

Three planned areas of focus, with no committed dates or delivery order:

- **Claude Code support** — choose Claude Code alongside Codex, with streaming, follow-ups, and runtime-specific tools and permissions.
- **Better text capture and replacement** — improve compatibility across apps and editors, preserve the intended selection, and make capture failures and unverified edits easier to understand.
- **Windows support** — bring Studio and the Context Bar to Windows, including native selection capture, safe replacement, and installation and updates.

## Architecture

```text
React Studio                 Native Context Bar window
      │                                │
      └──────────── Tauri commands ────┘
                       │
                       ├── PlatformAdapter
                       │      ├── macOS AXUIElement (implemented)
                       │      └── Windows UI Automation (next)
                       ├── Codex app-server discovery client
                       │      ├── model / config / account
                       │      ├── MCP / Skill / permissions
                       │      └── capabilities / threads
                       └── Codex app-server manager
                              ├── thread/start
                              ├── turn/start / interrupt
                              ├── streamed notifications
                              └── approval responses
```

The runtime protocol follows the current [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server.md). Codex is the source of truth for runtime catalogs and effective settings; Latch keeps only its own agent choices and product preferences. MCP credentials remain owned by Codex, and Skills remain in Codex-discovered user, repository, system, or administrator locations. Named CLI profiles are discovered from the active Codex home and legacy config metadata because app-server does not expose a profile-list method.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup, architecture, and validation. Maintainers can find signing and publishing instructions in the [release guide](docs/RELEASING.md). Shipped changes are recorded in the [changelog](CHANGELOG.md).

## License

Copyright 2026 Joaquin Gomez and contributors.

Latch Bar is licensed under the [Apache License, Version 2.0](LICENSE). See [NOTICE](NOTICE) and [third-party licenses and notices](THIRD_PARTY_NOTICES.txt) for attribution. Third-party dependencies and assets retain their respective licenses and notices; the app includes the complete sources of its MPL components in `Contents/Resources/third-party/sources`.

See the [attribution maintenance guide](docs/THIRD_PARTY.md), [code and asset provenance](docs/PROVENANCE.md), and [brand policy for forks](docs/BRAND.md).
