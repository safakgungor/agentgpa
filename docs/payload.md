# What leaves your machine

Two things can leave your machine, and only after you say yes: the **payload** (your report, every time you upload) and the **deep read packet** (only when you turn the deep read on). A third, the **usage counts**, leaves only if you said yes to them once (below). Both are built by `@agentgpa/core` and checked against strict schemas (`packages/core/src/payload.ts` and `packet.ts`), so a field that is not listed on this page cannot be sent. The server parses every upload with the same schemas.

Before you answer, you can see both:

- `agentgpa --dry-run` writes the payload to `agentgpa-payload.json` in the current folder and sends nothing. `agentgpa --json` prints it.
- `agentgpa --show-packet` prints the deep read packet and sends nothing. On the consent screen, `s` does the same.

## When the CLI talks to the network

Every request goes through `packages/cli/src/net.ts`, to one origin: `https://agentgpa.dev`, unless `AGENTGPA_API_URL` names another (any other origin makes the run report only and turns the deep read off). With `--offline`, `--dry-run`, `--json` or `--show-packet` the CLI makes no request at all.

| Request | When | What it sends |
| --- | --- | --- |
| `GET /api/cli/status` | At the start | The CLI version |
| `POST /api/cli/runs` | At the start, before the scan | A random install id (from `~/.agentgpa/config.json`), the CLI version, the link code if you passed one, and the answer to a proof-of-work challenge |
| `POST /api/cli/reports` | After you say yes | The payload, gzipped, with the run token in a header |
| `GET /api/cli/deep-read/status` | Deep read on, while it waits for your claim | The deep read token |
| `POST /api/cli/deep-read` | Deep read on, once the report is yours | The packet, gzipped |
| `POST /api/cli/telemetry` | At the end of a run, only if you said yes to usage counts | The usage counts below |

## The payload

| Field | What it holds |
| --- | --- |
| `schemaVersion`, `gradingVersion`, `cliVersion` | Versions of the payload, the grading and the CLI |
| `generatedAt` | When the report was made |
| `period` | Start, end and length in days of the period graded |
| `observedDays` | Per tool, the days it could have recorded (Claude Code keeps 30 days unless you raised `cleanupPeriodDays`) |
| `tools` | Per tool: found, readable, and sessions and prompts in the period |
| `allTime` | Per tool: when its first session on this machine started, and all-time sessions and prompts |
| `primaryTool` | The tool with the most prompts, or `multi` |
| `promptLanguage` | The main language of your prompts as an ISO 639-3 code (`eng`, `tur`), or `und` |
| `counts` | Sessions, prompts, replies, tool calls, active days and active minutes |
| `metrics` | Every number in `docs/grading.md`, per tool where it is graded per tool, and the counts per 30 observed days |
| `secrets` | How many secrets were pasted or read by your agent, by type and tool. Never a value, a part of one or its hash |
| `consents` | Your two choices: research aggregates (on unless you turn it off) and the deep read (off unless you turn it on). In agent mode, `upload --no-research` and `upload --deep-read` set them |
| `distributions` | Prompts per hour of the day, per-day series (prompts, thanks, caps, night prompts, "absolutely right", apologies, replies), the top 5 models by share, and the top 5 tool names (MCP tools as `MCP`, never by server) |
| `quotes` | Up to 5 quote candidates, only the ones you kept (see below) |
| `client` | Your system (`darwin`, `linux` or `win32`), whether it ran in a terminal or an agent, your time zone, whether the origin is the official one, and whether the sessions came from the tools' default locations or a folder given with `--root` (never the folder itself) |
| `runToken` | The one-time token for this run (absent from `--dry-run` files, which can never rank) |
| `skeleton` | The event log (below) |
| `fingerprints` | Up to 512 hashed provider message ids: SHA-256, the first 16 hex characters, only those that start with `00`. They let the server spot a transcript uploaded under a second account |
| `forensics` | How many sessions the file checks left out, and why |

### The event log (`skeleton`)

The skeleton holds no text, no paths, no file names, no project names and no MCP server names. Times are minutes from the start of the period. It travels as columns: one list per field, with session, minute and event order stored as differences from the row before. Decoding gives the rows below back exactly.

- `sessions`: per session its tool, tool version, start time, models, whether plan mode was used, its permission setting where the tool records one (`ask`, `acceptEdits` or `bypass`), its entry point (`terminal`, `desktop` or `ide`), its compaction count and its built-in slash commands by name (every other command counts as `custom`).
- `models` and `langs`: the model names and language codes that rows point at.
- `prompts`: per prompt its session, minute, word count, flag bits, language (from prompts of 8 or more words) and position in the session. The flags: caps, thanks, swear, correction, code reference, plan request, repeat of the previous prompt within 10 minutes, approximate time, plan file, question, please, praise, sorry, laugh, emoji, exclamation, nudge (a prompt like "continue"), pasted error, image, link, code block, think request. Each one is decided on your machine; the words never leave.
- `replies`: per reply its session, minute, model, input, output and cache tokens, flag bits ("absolutely right", agreement, apology, subagent, has text, refusal, asks you something), position and count. Replies with text are one row each; the rest of one minute merge into one row per model, with their tokens summed and their count.
- `tools`: per tool call its session, minute, category (shell, edit, write, read, search, web, subagent, MCP, to-do, notebook, other), lines added and removed, flag bits (commit, pull request, test, build, deploy, error, declined, subagent, approximate time, test failed, test passed, install, lint, sensitive file), the edited file's language category taken from its extension, position and count. The main agent's calls are one row each; a subagent's calls of one minute merge per category, flags and language.
- `interrupts`: per interrupt its session and minute.

### Quotes

A quote is your own prompt, shown to you before anything is sent: one you repeat most, one in all caps, the saltiest, and up to two cryptic ones. Each is at most 120 characters. Swears are masked as `[[bar:N]]` (N letters), which cards draw as a bar, so the word itself never leaves. A prompt with anything else to redact (a secret, a random-looking string, an id, an email, a phone number, an address, a home path, a project or account name) is never a quote, and neither is one with code. You can drop any quote on the consent screen, or with `--drop-quotes`. Each quote carries its kind, its local hour and weekday, the index of the prompt in the event log, so the server can check it against that prompt, and for the most repeated one how often it came up.

In agent mode, quotes with a link, a path, a shell construct or wording aimed at an agent are left out, since old sessions can hold text written to steer agents.

## The deep read packet

Only when you turn the deep read on. It is built in memory, sent once after the report is yours, read once by the AgentGPA model and dropped. It is never written to disk, and `--show-packet` prints exactly what it would hold.

| Field | What it holds |
| --- | --- |
| `schemaVersion`, `promptLanguage` | The packet version and your prompts' main language |
| `sessions` | Per session: tool, length bucket, prompt count, tool calls by category, edited files by language category, and how many test, build, git and deploy commands ran |
| `prompts` | Up to 600 prompts you typed, sampled across tools and weeks: each redacted as above (secrets, ids, contacts, home paths, project and account names become placeholders), swears masked, cut to 280 characters, with its session and week |

Never in the packet: the agent's replies, tool output, file contents, code blocks, pasted errors and logs, prompts over 2,000 characters, and prompts of fewer than three words.

## Usage counts

Off unless you say yes. The first time you run the CLI in a terminal against a server that takes them, it asks once; your answer is kept in `~/.agentgpa/config.json`, and you can change it there any time. It never asks, and nothing is sent, in agent mode, with `--yes`, or offline. The body is checked against a strict schema (`TelemetrySchema` in `packages/core/src/api.ts`), so nothing else can ride along:

| Field | What it holds |
| --- | --- |
| `run` | A random id for this run, made in memory and never stored |
| `cliVersion` | The CLI version |
| `events` | How many times each of these happened in this run: `cli_run`, `cli_preview_shown` (the report card was shown) and `cli_consent_given` (you said yes to an upload) |

Never in it: your install id, sessions, prompts, paths, project names, grades or anything from the payload.

## What the CLI writes on your machine

- `~/.agentgpa/config.json` (folder 0700, file 0600): a random install id, and your answer about usage counts once you give one.
- `~/.agentgpa/pending/` (0700 and 0600): in agent mode only, the payload the agent showed you, waiting for `upload`. It is deleted after the upload, after 30 minutes, and when the next scan starts.
- `agentgpa-payload.json` in the current folder, with `--dry-run` only (0600).
