# agentgpa

Your agent graded you.

AgentGPA grades how you work with your coding agents (Claude Code, Codex and Cursor) and gives you a report card on [agentgpa.dev](https://agentgpa.dev). This package is the command that reads the agent sessions on your machine. It is one bundled file: no dependencies and no install scripts.

## The one command

Start at [agentgpa.dev/start](https://agentgpa.dev/start). Sign in with GitHub, read what is read and what is sent, say yes, and the page gives you a command with a one-time code:

```bash
npx agentgpa@0.1.2 --code K7Q3-PX9M
```

Run it in your terminal, or paste the prompt from /start into your agent, which runs the same command with `--agent`. A code works once, for 60 minutes. Without a code the CLI reads nothing and sends nothing.

The CLI prints no grades, quotes or findings, in your terminal or in your agent. Your report is on the website, behind your sign-in.

## What it reads

The sessions your agents keep on this machine, from the last 90 days. Everything is read in memory, and nothing from your sessions is written to disk.

| Tool | Where it looks |
| --- | --- |
| Claude Code | `~/.claude/projects` (or `CLAUDE_CONFIG_DIR`) |
| Codex | `~/.codex/sessions` and `~/.codex/archived_sessions` (or `CODEX_HOME`) |
| Cursor | Cursor's chat database `state.vscdb` in its user folder, opened read-only and never copied, and `~/.cursor/projects` |

## What it sends

| Sent with your yes | Never sent |
| --- | --- |
| A text-free event log: when you prompted, for how long, which kinds of tools ran | Your prompts or your agent's replies |
| Your counts and rates | Your code, your files, file names or paths |
| Secrets as a count by type | A secret's value, a part of one or its hash |
| Up to 5 quote candidates from your own prompts, redacted on your machine and private until you pick them on the site | Tool output, project names or MCP server names |

The deep read is off unless you turn it on at /start. It sends a redacted sample of up to 600 prompts you typed and the names of your project folders (the folder's own name, never a path), which are read once and dropped. Research aggregates are on unless you turn them off: anonymous counts, published only in groups of 50 or more.

## See it before you say yes

None of these makes a network call:

```bash
npx agentgpa --dry-run
Dry run: wrote agentgpa-payload.json (38 KB gzipped, 5 quotes). It has no run token, so it can never rank. Nothing was sent.
```

- `--dry-run` writes exactly what a run would send to `agentgpa-payload.json`, readable by you only.
- `--json` prints the same payload.
- `--show-packet` prints the deep read packet. It holds your prompts, so it runs in your own terminal only.
- `--offline` says what it found and what a run would send.

## When it talks to the network

Only a run with a code does, over HTTPS to agentgpa.dev and nowhere else, in four requests: the version check, the start of the run (with a short proof of work), the report, and the deep read when you turned it on. Then it opens your report in the browser.

| Flag | What it does |
| --- | --- |
| `--code <code>` | The link code from /start, which carries your yes |
| `--agent` | Plain output for your own agent to relay |
| `--since <period>` | The period to read: `90d` (the default), `30d`, `14d` or `7d` |
| `--tools <list>` | Only read these tools: `claude-code,codex,cursor` |
| `--debug` | Counts per tool, never any text from your sessions |

## Requirements

Node 22.12 or newer, and 22.13 or newer to read Cursor's database. Without Node, /start links a standalone build with its SHA-256.

## License

MIT. The license covers the code; it does not grant use of the AgentGPA name or logo.
