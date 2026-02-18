# AI Agent Usage Monitor

Terminal script to show usage for:
- Claude Code
- Codex CLI
- Cursor

Runs as:

```bash
node usage.js
```

## What It Does

- **Claude**: runs `claude_usage.expect` to open `/usage` in Claude CLI and parse results.
- **Codex**: reads local Codex auth and calls Codex usage API.
- **Cursor**: reads local Cursor auth token and calls Cursor DashboardService usage endpoints.

It also shows per-service elapsed time in seconds in the section header.

## Requirements

- Node.js (modern version with built-in `node:` modules)
- `expect` (for Claude usage collection)
- `sqlite3` CLI (for reading Cursor local auth state)
- Logged in to each service locally:
  - `claude auth login`
  - `codex auth login`
  - Cursor desktop app signed in

## Usage

```bash
node usage.js              # all services
node usage.js --claude     # Claude only
node usage.js --codex      # Codex only
node usage.js --cursor     # Cursor only
node usage.js --json       # JSON output
node usage.js --setup      # interactive config setup
node usage.js --help       # help
```

## Config

Optional local config file:

- `.usage-config.json` (ignored by git)

Common keys:

- `cursor_access_token` (optional override)

## Environment Overrides

- `CURSOR_ACCESS_TOKEN`: override Cursor token.
- `CLAUDE_USAGE_TIMEOUT_MS`: override Claude collector timeout in milliseconds (default `35000`, allowed `5000` to `120000`).

## Notes

- No external npm dependencies are required to run `usage.js`.
- If Claude collection is flaky, rerun or increase `CLAUDE_USAGE_TIMEOUT_MS`.
- Cursor and Codex rely on local auth state; re-run their login commands if auth expires.
