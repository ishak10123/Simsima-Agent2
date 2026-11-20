# Simsima Agent

A local MCP/CLI publishing tool controlled by the account owner through a chat assistant. The local tool executes the requested action and does not call another model or require a model API key.

This private repository contains the application source for review. Runtime credentials, browser profiles, local drafts, operation databases and account-specific publishing records are not included.

## Current implementation

- X: text and one optional image through an isolated headless Brave profile.
- YouTube: channel posts with text and one optional image through that isolated profile.
- Discord: text and one optional image through an incoming channel webhook.
- Reddit: planned official API integration, pending access approval. No Reddit API publisher is implemented or enabled in this snapshot.

The intended Reddit use is occasional, individually requested project updates to the account owner's profile, with a title, body and optional image. The assistant may help draft the text. The integration would verify the destination, publish once and read back the resulting post to confirm it. This is an external desktop/chat integration rather than a Reddit-hosted interactive application.

## Requirements and setup

Windows, Brave, and Node.js 24.15 or newer.

```powershell
npm ci
npm run connect
```

`npm run connect` registers the local MCP server in the current project's Codex configuration. `node src/cli.js help` lists the equivalent CLI commands. Commands that accept content read JSON files through `--input`.

Browser publishing uses a dedicated profile under `%LOCALAPPDATA%/SimsimaAgent/Brave`. It does not use the mouse, keyboard or visible tabs during normal publishing. One-time session import is documented in [Brave setup](docs/brave-setup.md). [Discord setup](docs/discord-setup.md) describes the local webhook configuration.

## Application structure

- `src/mcp.js`, `src/server.js`, `src/cli.js`: MCP and CLI entry points.
- `src/service.js`: draft preparation, platform routing, publishing and verification.
- `src/store.js`: SQLite drafts and durable operation records.
- `src/browser.js`: isolated Brave execution and one-time setup connection.
- `src/*-publisher.js`, `src/*-evidence.js`: platform execution and result checks.
- `scripts/`: setup and development commands.
- `test/`: unit, MCP and intercepted-browser tests.

An operation ID is reused to recover a previous response. A draft with an uncertain submission is not sent again. When the post ID is known, verification can read that existing post without sending another one. Successful results include a verified post URL.

## Development verification

```powershell
npm test
npm run check
```

The source snapshot was taken after the existing 36-test suite passed. Browser tests intercept platform requests and use temporary profiles; they do not publish real posts.

The repository is private. Access for review can be arranged with the owner if required.
