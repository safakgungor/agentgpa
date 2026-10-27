# Transcript formats

What the AgentGPA CLI reads, as found on a real macOS machine in October 2026 with Claude Code 2.1.x (desktop app), Codex 0.146 and 0.148 (desktop app and VS Code) and Cursor 3.25. Only structure was inspected: key names, value types, line kinds, counts and the shape of ids. No prompt, reply or tool text was read or recorded. Anything marked *not seen* comes from the tools' documentation or older versions and is handled defensively.

The parsers live in `packages/core/src/parsers/`, file discovery in `packages/cli/src/discover.ts`. Every rule below has a test: on the scrubbed fixtures in `fixtures/home` where the survey machine had an example, on synthetic lines where it did not.

## Claude Code

### Where

| Path (under `~/.claude`, or `CLAUDE_CONFIG_DIR`) | What it is |
| --- | --- |
| `projects/<encoded cwd>/<session id>.jsonl` | A main session. The file name is the `sessionId` of its lines. |
| `projects/<encoded cwd>/<session id>/subagents/agent-<id>.jsonl` | One subagent (the Agent tool), with `agent-<id>.meta.json` beside it (`agentType`, `model`, `spawnDepth`). |
| `projects/<encoded cwd>/<session id>/subagents/workflows/wf_<id>/agent-<id>.jsonl` | One workflow subagent, same shape. |
| `projects/<encoded cwd>/<session id>/subagents/workflows/wf_<id>/<name>.jsonl` | A workflow journal (`started`, `result`, `launched`, `failed` lines). Not a transcript; skipped. |
| `projects/<encoded cwd>/<session id>/tool-results/` | Large tool outputs moved out of the transcript (text, images, PDFs). Not read. |
| `projects/<encoded cwd>/<session id>/workflows/` | Workflow scripts. Not read. |
| `settings.json` | `cleanupPeriodDays` (30 when absent). Shown by `--debug`; the period does not depend on it. |

Subagent lines carry `isSidechain: true`, an `agentId` and the parent's `sessionId`, so they join the parent session. Older versions wrote subagent lines into the main file with `isSidechain: true` (*not seen*); the parser handles both.

Retention is not strict. Cleanup removes old main session files, but a session file that is still being written keeps messages older than the setting, a few older main files survived on the survey machine, and subagent files keep the age of their run. The CLI therefore reads every file and filters events by their own timestamps.

### Line kinds

Every line is one JSON object with a `type`.

| `type` | What it is | Used for |
| --- | --- | --- |
| `user` | Prompts, tool results, and messages the client or other agents add | Prompts, interrupts, tool errors and declines |
| `assistant` | One content block of one model reply | Replies, tool calls, usage, models, plan mode |
| `attachment` | Context the client attached: hook results, reminders, files, skill and tool listings, queued prompts | Only `queued_command` (below) |
| `system` | Client events; subtypes seen: `compact_boundary`, `stop_hook_summary`, `api_error`, `model_refusal_fallback` | `compact_boundary` counts compactions |
| `progress` | Hook and subagent progress (2.1.7x only) | Nothing |
| `last-prompt`, `queue-operation`, `custom-title`, `ai-title`, `agent-name` | Copies of prompt text or titles | Nothing: never counted as prompts |
| `mode`, `atis-latch`, `bridge-session`, `frame-link`, `pr-link`, `file-history-snapshot`, `file-history-delta`, `cost-state`, `artifact-autoreact-ledger`, `artifact-comment-monitor` | Client bookkeeping | Nothing |

Fields on `user`, `assistant`, `attachment` and `system` lines: `uuid` (UUID v4), `parentUuid`, `sessionId`, `timestamp` (ISO 8601 UTC with milliseconds), `version` (the Claude Code version), `cwd`, `gitBranch`, `entrypoint` (`claude-desktop` seen), `userType`, `isSidechain`, `slug`; subagent lines add `agentId`.

### Prompts

`message.content` is a string or an array of blocks: `text`, `image` (base64), `document` (base64) and `tool_result` (`tool_use_id`, `content` as a string or blocks, `is_error`).

A `user` line is a prompt when all of these hold:
- `isSidechain` is not true, and `isMeta` and `isCompactSummary` are not true;
- it has no `tool_result` block;
- `origin.kind` is absent or `human`;
- its text does not start with a client wrapper (below), or it has no text but an image (an image sent on its own is a prompt; it has its own `promptId`).

Not prompts:
- `origin.kind` `task-notification` (background task events), `peer` (messages from other sessions) and `coordinator` (inside subagents);
- compaction summaries: `isCompactSummary: true` with `isVisibleInTranscriptOnly`, text starting "This session is being continued from a previous conversation";
- slash command wrappers: text starting `<command-name>`, `<command-message>`, `<command-args>`, `<local-command-stdout>`, `<local-command-stderr>` or `<local-command-caveat>`, and "Caveat: The messages below";
- bash mode: `<bash-input>`, `<bash-stdout>`, `<bash-stderr>`;
- text starting `<task-notification>`, and lines whose text blocks are all `<system-reminder>` blocks.

Interrupts are `user` lines whose text starts with `[Request interrupted by user` (also "for tool use").

Queued prompts: a prompt typed while the agent works is written as an `attachment` with `attachment.type: "queued_command"`, `commandMode: "prompt"`, `prompt` and `timestamp`, and absorbed into the running turn. It is never repeated as a `user` line, so it counts as a prompt unless it is `isMeta` or its `origin.kind` is not `human`. `commandMode: "task-notification"` entries are not prompts.

Other prompt fields: `promptId`, `promptSource` (`sdk`, `system`), `permissionMode` (`default`, `acceptEdits`, `auto` and `bypassPermissions` seen), `imagePasteIds`.

### Replies, usage and tool calls

- One reply is split over several `assistant` lines, one per content block (`thinking`, `text`, `tool_use`). All of them share `message.id` and `requestId` and repeat `message.usage`. A reply is counted once per `message.id` plus `requestId`, and its usage once, taking the largest value of each field seen.
- `message.model` names the model (`claude-opus-5-5`, `claude-fable-5-1`, `claude-sonnet-4-6` and others). `<synthetic>` marks messages the client made itself (`isApiErrorMessage`) and is not a model.
- `message.usage`: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, plus `cache_creation.ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens`, `iterations`, `server_tool_use`, `service_tier`, `speed`.
- `tool_use` blocks have `id`, `name` and `input`. Built-in names seen: `Bash`, `Read`, `Edit`, `Write`, `Grep`, `Glob`, `Agent`, `Workflow`, `TodoWrite`, `TaskCreate`, `TaskUpdate`, `TaskList`, `TaskOutput`, `TaskStop`, `ToolSearch`, `WebSearch`, `WebFetch`, `Skill`, `AskUserQuestion`, `SendMessage`, `Monitor`, `ScheduleWakeup`, `CronCreate`, `PushNotification`, `ReadNotifications`, `SendUserFile`, `Artifact`, `ReportFindings`, `EnterPlanMode`, `ExitPlanMode`. MCP tools are named `mcp__<server>__<tool>`; the parser keeps only "MCP".
- Plan mode: an `EnterPlanMode` or `ExitPlanMode` call, or `permissionMode: "plan"` (*not seen*).
- Tool results: `is_error: true` marks a failed call. `toolDenialKind` on the result line (`user-rejected`, `permission-rule`, `automode-unavailable`) marks a call that did not run; `user-rejected` is a decline.
- Compactions: one `system` line with `subtype: "compact_boundary"` (`compactMetadata.trigger`, `auto` seen) per compaction.
- Slash commands: the wrapper's `<command-name>/name</command-name>`; built-in names are counted by name and every other name as custom.

### Ids

- `message.id`: `msg_` plus 24 base62 characters starting with `01`. Messages the client made use a UUID instead.
- `requestId`: `req_` plus 24 base62 characters starting with `01`. Tool use ids: `toolu_` plus 24.
- `uuid`: UUID v4. None of these carries a time we can decode, so they can be checked for shape only.

### Traps

- Resumed sessions: on 2.1.x a resumed session continues its own file, and no `uuid` appeared in two files. Older versions copied earlier lines into a new file, so every line is still deduplicated by `uuid` across all files. The same `uuid` can appear twice in one file.
- Forks: the desktop app (`entrypoint: "claude-desktop"`, seen on 2.1.299 and 2.1.308) can go on with a session as a new one. The new main file starts with copies of the parent's lines, which keep the parent's `sessionId` and their old times, then has its own; the parent's subagent files are copied into the new session's folder, every line still the parent's. The copies come back to the parent, deduplicated by `uuid`, and the file checks skip them (below).
- Usage is repeated on every block line of a reply (above).
- Huge lines: tool results with base64 images and attachments with file contents reach tens of MB. Lines over 8 MB are skipped without parsing and counted; none of them is a prompt.
- Text that is not a prompt: `last-prompt`, `queue-operation` (`content`), attachments and titles hold copies of prompt text.
- Personal data in lines: `cwd`, `gitBranch`, file paths, the account email in some attachments, MCP server names and PR URLs. The CLI never sends any of them; the project is reduced to a hash of `cwd`, and only the deep read, when you turn it on, sends the last part of `cwd` (the folder's own name, never the path).

## Codex

### Where

| Path (under `~/.codex`, or `CODEX_HOME`) | What it is |
| --- | --- |
| `sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl` | One session (a thread) |
| `archived_sessions/` | Archived sessions, same shape (*not seen*) |
| `session_index.jsonl` | Thread ids and names. Not read. |
| `*.sqlite` (`state_5`, `thread_history_1`, `logs_2`, `goals_1`, `memories_1`, `queue_1`) | App state. Not read. |

No retention limit was seen.

### Lines

Every line is `{ timestamp, type, payload, ordinal }`.

| `type` / `payload.type` | What it holds |
| --- | --- |
| `session_meta` | `id` (UUID v7), `session_id`, `cli_version`, `originator` (`codex_work_desktop` seen), `source` (`vscode` seen), `cwd`, `model_provider`, `history_mode`, `thread_source`, `dynamic_tools`, the base instructions |
| `turn_context` | Per turn: `turn_id` (UUID v7), `model` (`gpt-5.6-sol` seen), `effort`, `collaboration_mode.mode` (`default` seen), `approval_policy`, `sandbox_policy.type` (`workspace-write` seen), `permission_profile`, `cwd`, `timezone`, `current_date` |
| `event_msg` / `task_started`, `task_complete` | Turn start and end: `turn_id`, `started_at`, `completed_at`, `duration_ms`, `collaboration_mode_kind` |
| `event_msg` / `item_completed` | One finished item. `item.type`: `UserMessage` (the prompt; `content` blocks `text` and `local_image`), `AgentMessage` (a reply; `phase` is `commentary` or `final_answer`), `Reasoning`, `WebSearch`, `FileChange`, `Extension` |
| `event_msg` / `token_count` | `info.total_token_usage` (cumulative for the session) and `info.last_token_usage`: `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`, `total_tokens`; plus `rate_limits` |
| `event_msg` / `thread_settings_applied` | A settings snapshot: model, approval policy, collaboration mode, personality, service tier |
| `response_item` / `message` | What the model saw and said. Roles `user`, `assistant`, `developer`. User messages include injected context (AGENTS.md, environment context, permissions) |
| `response_item` / `reasoning` | Encrypted reasoning |
| `response_item` / `function_call`, `function_call_output` | Tool calls (`exec_command`, `view_image`, namespaced `run` seen) and results, linked by `call_id` |
| `response_item` / `custom_tool_call`, `custom_tool_call_output` | Free-form tool calls (`exec` seen) and results |
| `world_state` | A context snapshot (AGENTS.md state) |

### Rules

- Prompts are `item_completed` items of type `UserMessage`. Older versions write `event_msg` `user_message` instead (*not seen*): the parser uses those only for a session that has no `UserMessage` item, and falls back to `response_item` user messages without injected context only when neither exists.
- Replies are `AgentMessage` items (older versions: `event_msg` `agent_message`, *not seen*).
- Usage is the difference of `total_token_usage` between consecutive `token_count` events, so a repeated event adds nothing; cumulative totals are never summed. `input_tokens` includes `cached_input_tokens`.
- The model of a reply is the `model` of the latest `turn_context`.
- Interrupts are `event_msg` `turn_aborted` with `reason: "interrupted"` (*not seen*).
- Plan mode: the turn's collaboration mode. Only `default` was seen; the parser treats `plan` as plan mode (*value not seen*).
- Shell tools (`exec_command`, `exec`, `shell`, `local_shell_call`) give the command for the shipping counts; `apply_patch` gives added and removed lines.

### Ids

- Session and turn ids are UUID v7: the first 48 bits are a Unix time in milliseconds, which must agree with the line's `timestamp`. This is the one provider id that can be checked against time.
- Response item ids: `msg_`, `fc_`, `rs_` or `ctc_` plus 50 hex characters, or `msg_`, `fco_` or `ctco_` plus 36 base64url characters. Call ids: `call_` plus 24 base62 characters.

## Cursor

### Where

| Path | What it is |
| --- | --- |
| `globalStorage/state.vscdb` in the Cursor user folder (`~/Library/Application Support/Cursor/User` on macOS, `~/.config/Cursor/User` on Linux, `%APPDATA%\Cursor\User` on Windows) | SQLite: tables `ItemTable` (editor state), `cursorDiskKV` (chats) and, in newer versions, `composerHeaders` |
| `~/.cursor/projects/<project>/agent-transcripts/<composer id>/<composer id>.jsonl` | Agent transcripts, one per chat |
| `workspaceStorage/<hash>/state.vscdb` | Older per-workspace data (`aiService.prompts`, `aiService.generations`, `composer.composerData`, `interactive.sessions`). Not read. |
| `~/.cursor/chats/` | The Cursor CLI's own chat store (*not seen*) |

The databases are opened read-only and never copied. `ItemTable` also holds `secret://` entries, which are never read.

### `cursorDiskKV` records

| Key | What the JSON value holds |
| --- | --- |
| `composerData:<composer id>` | One chat: `_v` (data format version; 10, 13, 14, 16 and 18 seen), `createdAt` and `lastUpdatedAt` (Unix ms), `unifiedMode` (`agent`, `chat`), `forceMode` (`edit`, `chat`), `isAgentic`, `modelConfig.modelName` (`default` or a model id), `status`, `fullConversationHeadersOnly` (`bubbleId`, `type`), `totalLinesAdded`, `totalLinesRemoved`, `agentBackend` (`cursor-agent`), `subagentComposerIds`, `isSpec`, `planModeSuggestionUsed` |
| `bubbleId:<composer id>:<bubble id>` | One message: `_v` (3), `type` (1 user, 2 assistant), `createdAt` (ISO 8601), `text`, `richText`, `tokenCount` (`inputTokens`, `outputTokens`; mostly 0), `modelInfo.modelName`, `toolFormerData` (`name`, `tool` as a number, `status`, `userDecision`, `params`, `rawArgs`, `result`), `isPlanExecution`, `isNudge`, `requestId`, `serverBubbleId`, `thinking`, `timingInfo`, `turnDurationMs`, `checkpointId`, `capabilityType` |
| `agentKv:blob:<hash>` | Content-addressed blobs of the agent backend: JSON messages (`role` `user`, `assistant`, `tool` or `system`; parts `text`, `tool-call`, `tool-result`, `reasoning`) and binary blobs. No timestamp and no chat id. Not read. |
| `checkpointId:*`, `codeBlockDiff:*`, `ofsContent:*`, `messageRequestContext:*`, `inlineDiff:*`, `composerDraft:*` | Editor state. Not read. |

`composerHeaders` rows: `composerId`, `workspaceId`, `createdAt`, `lastUpdatedAt`, `isArchived`, `isSubagent`, `subagentTypeName` and a JSON `value` (`unifiedMode`, `forceMode`, `hasPendingPlan`, `referencedPlans`, `totalLinesAdded`).

Only some chats keep their messages as bubbles. For the others the messages live in the agent backend blobs and in the agent transcript, so a chat is read from its bubbles when it has any and from its transcript otherwise.

### Agent transcripts

- Lines are `{ role, message: { content: [...] } }` with no timestamp and no id.
- User text wraps the request in `<user_query>`; only that part is the prompt.
- Assistant content has `text` and `tool_use` blocks (`Shell`, `Read`, `Grep`, `Glob`, `StrReplace`, `Write` seen).
- The folder and file name are the composer id, so the chat's `createdAt` and `lastUpdatedAt` come from `composerData`. Events read from a transcript carry the chat's start time and are marked approximate.

### Rules

- Prompts: bubbles with `type: 1` (plain text, no wrapper seen), or the `<user_query>` part of transcript user lines.
- Replies: bubbles with `type: 2` and text; usage from `tokenCount` when it is not zero.
- Tool calls: `toolFormerData` on bubbles (names seen: `write`, `todo_write`, `search_replace`, `run_terminal_cmd`, `glob_file_search`, `ripgrep_raw_search`, `read_file`); `status: "error"` marks a failed call and `userDecision: "rejected"` a decline (*only `accepted` seen*).
- Plan mode: `isPlanExecution` on a bubble, or `unifiedMode` or `forceMode` `plan` (*not seen*).
- Bubbles are deduplicated by bubble id.
- Versions: `_v` is the data format version, not the app version. No chat records the app version.

### Ids

Composer, bubble, request and server bubble ids are random UUID v4, so they can be checked for shape only. Many bubbles have an empty `requestId`.

## File checks

Before the skeleton is built, the CLI compares each Claude Code and Codex session file's creation time with the newest line of the file's own session inside it. A file created long after that line was written after the fact, or copied from another machine, and its session is left out of the report. Only the session's own lines count: a Claude Code line that names another session is a fork's copy of that session's line (Traps), and a file holding only copies is not judged, since the original it was copied from is checked in its own folder. The payload counts the sessions left out that the report would have held, those with an event in the period; `--debug` also counts those outside the period and the files that failed, by tool and kind. Change and modification times are not used: Claude Code appends lines without timestamps to old session files (titles, modes, cost state and similar app records) and rewrites some, so a file changed weeks after its last message is normal. Creation times hold: a session file is created when its session starts. Cursor keeps every chat in one database, so the check does not apply to it. Where a file system keeps no creation time, nothing is checked.

## Signals each tool records

| Signal | Claude Code | Codex | Cursor |
| --- | --- | --- | --- |
| Permission mode | `permissionMode` on prompts | `approval_policy` and `sandbox_policy` per turn | `unifiedMode` (agent or chat), not an approval setting |
| Entry point | `entrypoint` on every line | `originator` and `source` in `session_meta` | Editor database or agent transcript |
| Compaction | `compact_boundary` lines and compaction summary prompts | *not seen* | `conversationSummary` and `summarizedComposers` on bubbles |
| Resume | The same file continues; a fork starts a new file with copies (Traps) | *not seen* | *not seen* |
| Built-in commands | `<command-name>` wrappers | *not seen* | `cursorCommands` on bubbles |
| Tool errors | `tool_result.is_error` | Tool output (exit code) | `toolFormerData.status` |
| Declines | `toolDenialKind: "user-rejected"` | *not seen* | `toolFormerData.userDecision` |
| Test results | Tool output text, read on the device only | Same | Same |

## Scan time

Measured with `agentgpa --dry-run --debug` on an Apple Silicon Mac with Node 22, October 2026, on a history of a few gigabytes from all three tools: transcripts are read at about 380 MB a second, every line parsed and validated. Lines over 8 MB are skipped while they are read, so they cost no parsing. Metrics, secret detection and grading add less than a fifth to that time, and peak memory stays under 600 MB. The target is 1 GB in under 15 seconds and a heavy 90-day history in under 40 seconds.

## Fixtures

`fixtures/home` is a home folder in miniature: scrubbed copies of real sessions from all three tools in their real places (`.claude/projects`, `.codex/sessions`, `.cursor/projects`), plus `cursor-db.json`, the Cursor records as reviewable text. `scripts/fixture-db.ts` turns that file into the SQLite database Cursor would keep (`.config/Cursor/User/globalStorage/state.vscdb`, not committed). Every fixture comes from `scripts/make-fixture.ts`, which keeps structure, timing and lengths, replaces all text with synthetic words and every email, URL, domain, path, time zone and name in it with a fixed placeholder, keeps two significant digits of token counts and durations, sets money to 0, moves every time forward by 52 weeks and refuses to write anything that fails its leak check.

```bash
node scripts/fixture-db.ts fixtures/home
pnpm --filter agentgpa dev -- --dry-run --debug --root fixtures/home
```
