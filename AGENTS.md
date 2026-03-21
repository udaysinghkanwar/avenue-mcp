# A2L MCP — Agent Guide

> **Read this first.** This file is the authoritative entry point for any AI agent or engineer working in this repository.

---

## 1. What is A2L MCP?

A2L MCP is an MCP (Model Context Protocol) server that gives AI assistants (Cursor, Claude Desktop, VS Code Copilot, etc.) access to McMaster University's Avenue to Learn (D2L Brightspace) LMS. It runs locally and authenticates via Microsoft SSO.

---

## 2. Repo Map

| Path | Purpose |
|---|---|
| `a2l-mcp/` | A2L MCP server (TypeScript) |
| `a2l-mcp/src/auth.ts` | Authentication (Microsoft SSO + D2L token capture) |
| `a2l-mcp/src/index.ts` | MCP server entry point and tool definitions |
| `a2l-mcp/src/client.ts` | D2L API client |
| `a2l-mcp/src/tools/` | Tool implementations (calendar, content, grades, news) |
| `a2l-mcp/src/study/` | Study tools (tasks, notes, planning) |
| `package.json` | Workspace-level scripts |
| `AGENTS.md` | This file |

---

## 3. Key Conventions

- **TypeScript everywhere.** Build to `dist/` before running.
- **Sessions are local.** Browser session persists in `~/.d2l-session/`. Re-auth daily (sessions last ~24h).
- **No secrets in source.** Credentials live in `a2l-mcp/.env` (gitignored).
- **McMaster auth is split-host.** API lives on `avenue.cllmcmaster.ca`, login goes through `avenue.mcmaster.ca` → Microsoft SSO. Configured via `D2L_SSO_LOGIN_URL`.

---

## 4. Running the Project

```bash
cd a2l-mcp
npm install
npm run build

# Start the server
MCP_TRANSPORT=http node dist/index.js

# Authenticate (separate terminal)
node dist/auth-cli.js
```

---

*Keep this file current if the repo changes shape.*
