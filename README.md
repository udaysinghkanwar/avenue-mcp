# A2L MCP — Avenue to Learn for AI Assistants

An MCP (Model Context Protocol) server that gives AI assistants access to McMaster's Avenue to Learn (D2L Brightspace). Ask your AI about assignments, grades, deadlines, course content, and more.

> **Academic Integrity Notice**: This tool is for personal productivity only. Do not use it for any activities that violate McMaster's Academic Integrity Policy.

## What You Can Do

- **Assignments** — List assignments, view details, check submissions & feedback
- **Grades** — View all grades with scores and instructor feedback
- **Calendar** — Get upcoming due dates and events
- **Course Content** — Browse syllabus, modules, topics, and lectures
- **Announcements** — Read instructor announcements
- **File Downloads** — Download and extract content from course files (docx, pdf, etc.)
- **Study Tools** — Task tracking, notes sync, weekly planning

## Prerequisites

- [Node.js](https://nodejs.org/) v18+
- A McMaster MacID (`your-macid@mcmaster.ca`)

## Setup

### 1. Clone and install

```bash
git clone https://github.com/alanxue1/a2l-mcp.git
cd a2l-mcp/a2l-mcp
npm install
npx playwright install chromium
```

### 2. Configure environment

```bash
cp .env.template .env
```

Edit `.env` with your McMaster credentials:

```env
D2L_HOST=avenue.cllmcmaster.ca
D2L_SSO_LOGIN_URL=https://avenue.mcmaster.ca/login.php
D2L_USERNAME=your-macid@mcmaster.ca
D2L_PASSWORD=your-password
```

The Supabase and OpenAI keys are only needed if you want study tools (task tracking, notes search). The server works without them.

### 3. Build and authenticate

```bash
npm run build
node dist/auth-cli.js
```

A browser will open and go through McMaster's Microsoft SSO login. Complete any MFA prompts. The session is saved to `~/.d2l-session/` and lasts ~24 hours.

### 4. Start the server

```bash
MCP_TRANSPORT=http node dist/index.js
```

Server runs on `http://localhost:3000/mcp`.

## Connecting to Your AI Assistant

### Cursor

Add to your MCP settings (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "a2l": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

### VS Code (Copilot)

Add to your VS Code settings:

```json
{
  "mcp": {
    "servers": {
      "a2l": {
        "url": "http://localhost:3000/mcp"
      }
    }
  }
}
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "a2l": {
      "command": "node",
      "args": ["/path/to/a2l-mcp/a2l-mcp/dist/index.js"],
      "env": {
        "MCP_TRANSPORT": "stdio"
      }
    }
  }
}
```

## Course Folders & Websites (optional)

Create `a2l-mcp/courses.json` (gitignored) to file downloads into your own course folders and to add course websites hosted outside Avenue:

```json
{
  "rootDir": "/Users/you/Year 3",
  "courses": {
    "3O03": { "name": "SFWRENG 3O03: Linear Optimization", "folder": "Linear Optimization" },
    "3MX3": {
      "folder": "Signals and Systems",
      "website": {
        "pages": ["https://www.cas.mcmaster.ca/~mohrens/3mx3/"],
        "auth": { "username": "...", "password": "..." }
      }
    }
  }
}
```

- Avenue files are saved to `<rootDir>/<folder>/Avenue/<module path>/<topic title>.<ext>`, website files to `<rootDir>/<folder>/Course Website/`. Courses not listed go to `~/Downloads/Avenue/<code>/`.
- Each file is downloaded once. Repeat requests are served from disk; a cheap conditional request (ETag / Last-Modified) checks for updates at most every 12h, or on `refresh: true`.
- If you've modified a downloaded file (e.g. annotated a PDF), it's never overwritten — a newer version is saved beside it as `name (updated YYYY-MM-DD).pdf`.
- The download index and extracted-text cache live in `~/.avenue-mcp/`.

## Daily Usage

Sessions last ~24 hours. Each day:

```bash
cd a2l-mcp

# 1. Start the server
MCP_TRANSPORT=http node dist/index.js

# 2. If session expired, re-auth in a separate terminal
node dist/auth-cli.js
```

Then just talk to your AI assistant: *"What assignments do I have due this week?"*

## Available Tools

| Tool | Description |
|------|-------------|
| `get_assignments` | List all assignments with due dates |
| `get_assignment` | Get full details for a specific assignment |
| `get_assignment_submissions` | Get your submissions and feedback |
| `get_my_grades` | Get all grades with scores |
| `get_upcoming_due_dates` | Get calendar events and deadlines |
| `get_course_content` | Get complete course syllabus |
| `get_course_modules` | Get main course sections |
| `get_course_module` | Get contents of a specific module |
| `get_course_topic` | Get details for a specific topic |
| `get_announcements` | Get course announcements |
| `get_my_courses` | List enrolled courses |
| `download_file` | Download course files |
| `read_file` | Read downloaded file contents |

### Study Tools (require Supabase + OpenAI)

| Tool | Description |
|------|-------------|
| `sync_all` | Sync all assignments as tasks |
| `tasks_list` | List tasks by course/status |
| `tasks_add` | Add a manual task |
| `tasks_complete` | Mark task as done |
| `plan_week` | Generate weekly study plan |
| `notes_sync` | Sync notes from repository |
| `notes_search` | Search through notes |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `D2L_HOST` | Yes | `avenue.cllmcmaster.ca` |
| `D2L_SSO_LOGIN_URL` | Yes | `https://avenue.mcmaster.ca/login.php` |
| `D2L_USERNAME` | Yes | Your MacID email |
| `D2L_PASSWORD` | Yes | Your MacID password |
| `SUPABASE_URL` | For study tools | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | For study tools | Supabase service key |
| `OPENAI_API_KEY` | For study tools | OpenAI API key for embeddings |
| `MCP_TRANSPORT` | No | `http` (default) or `stdio` |

## Troubleshooting

**"Could not find username field"**
The SSO login page structure may have changed. Open an issue with the error logs.

**Session expires quickly**
Sessions last ~24 hours. Run `node dist/auth-cli.js` again.

**MFA / 2FA prompt**
The browser will open for you to complete MFA. After that, the session is saved automatically.

## Credits

Forked from [mcp-workspace](https://github.com/hamzakammar/mcp-workspace) by [hamzakammar](https://github.com/hamzakammar), who built the original D2L MCP server with Piazza integration, study tools, and the authentication framework that made this possible. This project adapts it for McMaster's split-host SSO setup.

Originally inspired by [d2l-mcp-server](https://github.com/General-Mudkip/d2l-mcp-server) by General-Mudkip.

## License

MIT
