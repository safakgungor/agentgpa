# agentgpa

Your agent graded you.

AgentGPA grades how you work with your coding agents (Claude Code, Codex and Cursor) and gives you a report card on [agentgpa.dev](https://agentgpa.dev). This package is the command that reads the agent sessions on your machine. It is one bundled file: no dependencies and no install scripts.

## The one command

Start at [agentgpa.dev/start](https://agentgpa.dev/start). Sign in with GitHub, read what is read and what is sent, say yes, and the page gives you a command with a one-time code:

```bash
npx agentgpa@0.1.2 --code K7Q3-PX9M
```

Run it in your terminal, or paste the prompt from /start into your agent, which runs the same command with `--agent`. Before it reads anything, the CLI asks you in your terminal whether the account the code is for is yours; a run with no terminal to ask in, like your agent's, needs `--to` with that account, which the prompt from /start includes. Only run a command or a prompt you got from your own /start. A code works once, for 60 minutes. Without a code a run reads nothing and sends nothing; the flags under "See it before you say yes" read your sessions only to show you what a run would send.

The CLI prints no grades, quotes or findings, in your terminal or in your agent. Your report is on the website, behind your sign-in.

## What it reads

Every session your agents keep on this machine: the last 90 days are graded, and older sessions count only toward your all-time numbers. Everything is read in memory. The one file the CLI writes from your sessions is the one `--dry-run` asks for.

| Tool | Where it looks |
| --- | --- |
| Claude Code | `~/.claude/projects` (or `CLAUDE_CONFIG_DIR`) |
| Codex | `~/.codex/sessions` and `~/.codex/archived_sessions` (or `CODEX_HOME`) |
| Cursor | Cursor's chat database `state.vscdb` in its user folder, opened read-only and never copied, and `~/.cursor/projects` |

## What it sends

| Sent with your yes | Never sent |
| --- | --- |
| A text-free event log: when you prompted, for how long, which kinds of tools ran | Your agent's replies and tool output |
| Your counts and rates | Your code, your files, file names or paths |
| Secrets as a count by type | A secret's value, a part of one or its hash |
| Up to 5 quote candidates from your own prompts, redacted on your machine and private until you pick them on the site | Your other prompts and your project names, except in the deep read below; MCP server names |

The deep read is off unless you turn it on at /start. It sends a redacted sample of up to 600 prompts you typed and the names of your project folders (the folder's own name, never a path), which are read once and dropped. Research aggregates are on unless you turn them off: anonymous counts, published only in groups of 50 or more.

## See it before you say yes

None of these makes a network call:

```bash
npx agentgpa --dry-run
Dry run: wrote agentgpa-payload.json (38 KB gzipped, 5 quotes). It has no run token, so it can never rank. Nothing was sent.
```

- `--dry-run` writes the payload a run would send to `agentgpa-payload.json`, readable by you only, with research and the deep read off and no run token. A run in agent mode sends the same, minus any quote candidate that holds a link, a path, shell or wording aimed at an agent.
- `--json` prints the same payload.
- `--show-packet` prints the deep read packet.

`--json` and `--show-packet` print your prompts, so agent mode refuses both.
- `--offline` says what it found and what a run would send.

## When it talks to the network

Only a run with a code does, over HTTPS to agentgpa.dev (or the origin in `AGENTGPA_API_URL`, which makes the run report only, and which agent mode and any run with no terminal to ask in refuse) and nowhere else: the version check, the start of the run (two requests around a short proof of work), the report, and the deep read when you turned it on, which only ever goes to agentgpa.dev. Your report opens in the browser right after the report is sent, before the deep read, unless the agentgpa.dev page you started from is still open and following the run.

| Flag | What it does |
| --- | --- |
| `--code <code>` | The link code from /start, which carries your yes |
| `--agent` | Plain output for your own agent to relay |
| `--to <handle>` | The GitHub handle your code is for; a run with no terminal to ask in needs it (the prompt from /start has it) |
| `--since <period>` | The period to read: `90d` (the default), `30d`, `14d` or `7d` |
| `--tools <list>` | Only read these tools: `claude-code,codex,cursor` |
| `--debug` | Counts per tool, never any text from your sessions |
| `--root <folder>` | Read agent data under this folder instead of your home folder; such runs never rank |

## Requirements

Node 22.12 or newer, and 22.13 or newer to read Cursor's database.

## License

MIT. The license covers the code; it does not grant use of the AgentGPA name or logo.
