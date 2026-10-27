import { z } from 'zod';
import { cleanText, safeLabel } from '../clean.ts';
import { isSensitiveFile, langCategoryOf, touchesSensitiveFile } from '../files.ts';
import { countLines } from '../lines.ts';
import { shellFlags, testOutcome } from '../shell.ts';
import { commandKey, normalizeToolName } from '../tools.ts';
import {
  type ParseResult,
  type ParserOptions,
  type ReplyEvent,
  type Session,
  TOOL_FLAGS,
  type ToolCallEvent,
  type UsageEvent,
} from '../types.ts';
import { bump, emptyStats, kindName, SessionBuilder, toTime } from './session.ts';

// Claude Code transcripts (docs/formats.md). One parser instance reads every file of one
// machine, so lines are deduplicated by uuid and replies by message id across all files.

export type ClaudeFileKind = 'main' | 'subagent' | 'workflow-agent';

export interface ClaudeFile {
  kind: ClaudeFileKind;
  /** The session id the file's path names: the file name of a main file, the folder of a subagent. */
  sessionId: string;
}

const Origin = z.looseObject({ kind: z.string().optional() });

const base = {
  uuid: z.string().optional(),
  sessionId: z.string().optional(),
  timestamp: z.string(),
  isSidechain: z.boolean().optional(),
  isMeta: z.boolean().optional(),
  cwd: z.string().optional(),
  version: z.string().optional(),
  entrypoint: z.string().optional(),
  agentId: z.string().optional(),
};

const UserLine = z.looseObject({
  ...base,
  type: z.literal('user'),
  isCompactSummary: z.boolean().optional(),
  permissionMode: z.string().optional(),
  toolDenialKind: z.string().optional(),
  origin: Origin.optional(),
  message: z.looseObject({ content: z.union([z.string(), z.array(z.unknown())]) }),
});

const Usage = z.looseObject({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
  cache_creation_input_tokens: z.number().optional(),
});

const AssistantLine = z.looseObject({
  ...base,
  type: z.literal('assistant'),
  requestId: z.string().optional(),
  message: z.looseObject({
    id: z.string().optional(),
    model: z.string().optional(),
    content: z.array(z.unknown()),
    usage: Usage.optional(),
  }),
});

const QueuedLine = z.looseObject({
  ...base,
  type: z.literal('attachment'),
  attachment: z.looseObject({
    type: z.literal('queued_command'),
    commandMode: z.string().optional(),
    prompt: z.union([z.string(), z.array(z.unknown())]).optional(),
    isMeta: z.boolean().optional(),
    origin: Origin.optional(),
    timestamp: z.string().optional(),
  }),
});

const TextBlock = z.looseObject({ type: z.literal('text'), text: z.string() });
const ToolResultBlock = z.looseObject({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  is_error: z.boolean().optional(),
  content: z.union([z.string(), z.array(z.unknown())]).optional(),
});

/** The text of a tool result: its string, or its text blocks. Images are skipped. */
function resultText(content: string | unknown[] | undefined): string {
  if (typeof content === 'string') return content;
  if (!content) return '';
  return content
    .map((b) => {
      const text = TextBlock.safeParse(b);
      return text.success ? text.data.text : '';
    })
    .filter(Boolean)
    .join('\n');
}
const ToolUseBlock = z.looseObject({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.unknown().optional(),
});

const WRAPPER =
  /^\s*(?:<(?:command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)>|Caveat: The messages below)/;
const COMMAND_NAME = /<command-name>\s*\/?([^<\s]{1,64})\s*<\/command-name>/;
const BASH_MODE = /^\s*<bash-(?:input|stdout|stderr)>/;
const TASK_NOTIFICATION = /^\s*<task-notification>/;
const REMINDER_ONLY = /^\s*<system-reminder>[\s\S]*<\/system-reminder>\s*$/;
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const INTERRUPT = /^\s*\[Request interrupted by user/;
const COMPACT_SUMMARY = /^\s*This session is being continued from a previous conversation/;
const PLAN_TOOLS = new Set(['EnterPlanMode', 'ExitPlanMode']);

interface Reply {
  usage: UsageEvent;
  text?: ReplyEvent;
}

interface Content {
  texts: string[];
  images: number;
  results: z.infer<typeof ToolResultBlock>[];
}

function readContent(content: string | unknown[]): Content {
  if (typeof content === 'string') return { texts: [content], images: 0, results: [] };
  const out: Content = { texts: [], images: 0, results: [] };
  for (const block of content) {
    const type = (block as { type?: unknown } | null)?.type;
    if (type === 'text') {
      const text = TextBlock.safeParse(block);
      if (text.success) out.texts.push(text.data.text);
    } else if (type === 'image') out.images++;
    else if (type === 'tool_result') {
      const result = ToolResultBlock.safeParse(block);
      if (result.success) out.results.push(result.data);
    }
  }
  return out;
}

function promptText(texts: string[]): string {
  return cleanText(texts.map((t) => t.replace(REMINDER, '')).join('\n')).trim();
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Added and removed lines for the edit tools, from their inputs. */
function editLines(name: string, input: unknown): { added: number; removed: number } | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const i = input as Record<string, unknown>;
  if (name === 'Edit')
    return {
      added: countLines(str(i.new_string) ?? ''),
      removed: countLines(str(i.old_string) ?? ''),
    };
  if (name === 'Write') return { added: countLines(str(i.content) ?? ''), removed: 0 };
  if (name === 'NotebookEdit') return { added: countLines(str(i.new_source) ?? ''), removed: 0 };
  if (name === 'MultiEdit' && Array.isArray(i.edits)) {
    let added = 0;
    let removed = 0;
    for (const edit of i.edits) {
      const e = (edit ?? {}) as Record<string, unknown>;
      added += countLines(str(e.new_string) ?? '');
      removed += countLines(str(e.old_string) ?? '');
    }
    return { added, removed };
  }
  return undefined;
}

/** Why a user line is not a prompt, or `prompt`, or `interrupt` (docs/formats.md). */
function classify(l: z.infer<typeof UserLine>, content: Content, sidechain: boolean): string {
  const any = (rule: RegExp) => content.texts.some((t) => rule.test(t));
  if (content.results.length) return 'tool_result';
  if (sidechain) return 'sidechain';
  if (l.isCompactSummary || any(COMPACT_SUMMARY)) return 'compact_summary';
  if (l.isMeta) return 'meta';
  const origin = l.origin?.kind;
  if (origin && origin !== 'human') return `origin:${kindName(origin)}`;
  if (any(INTERRUPT)) return 'interrupt';
  if (any(WRAPPER)) return 'slash_command';
  if (any(BASH_MODE)) return 'bash_mode';
  if (any(TASK_NOTIFICATION)) return 'task_notification';
  if (content.texts.length && content.texts.every((t) => REMINDER_ONLY.test(t)))
    return 'system_reminder';
  return 'prompt';
}

export function createClaudeCodeParser(options: ParserOptions) {
  const stats = emptyStats();
  const sessions = new Map<string, SessionBuilder>();
  const seenUuids = new Set<string>();
  const replies = new Map<string, Reply>();
  const toolCalls = new Map<string, ToolCallEvent>();

  function sessionFor(lineSessionId: string | undefined, file: ClaudeFile): SessionBuilder {
    const id = safeLabel(lineSessionId) ?? file.sessionId;
    let session = sessions.get(id);
    if (!session) {
      session = new SessionBuilder('claude-code', id);
      sessions.set(id, session);
    }
    return session;
  }

  function common(
    session: SessionBuilder,
    l: { cwd?: string | undefined; version?: string | undefined; entrypoint?: string | undefined },
    main: boolean,
  ): void {
    if (!main) return;
    if (session.cwd === undefined && l.cwd) session.cwd = l.cwd;
    if (session.version === undefined) session.version = safeLabel(l.version);
    if (session.entrypoint === undefined) session.entrypoint = safeLabel(l.entrypoint);
  }

  function user(raw: unknown, file: ClaudeFile): void {
    const parsed = UserLine.safeParse(raw);
    const ts = parsed.success ? toTime(parsed.data.timestamp) : undefined;
    if (!parsed.success || ts === undefined) {
      stats.malformed++;
      return;
    }
    const l = parsed.data;
    const sidechain = l.isSidechain === true || file.kind !== 'main';
    const session = sessionFor(l.sessionId, file);
    session.seen(ts);
    if (l.agentId && sidechain) session.agents.add(l.agentId);
    common(session, l, !sidechain);
    const content = readContent(l.message.content);

    for (const result of content.results) {
      const call = toolCalls.get(result.tool_use_id);
      const isTest = ((call?.flags ?? 0) & TOOL_FLAGS.test) !== 0;
      const text = options.onToolOutput || isTest ? resultText(result.content) : '';
      if (options.onToolOutput && text) options.onToolOutput(text, ts, call?.category);
      if (!call) continue;
      if (l.toolDenialKind === 'user-rejected') call.declined = true;
      else if (result.is_error) call.error = true;
      if (isTest) {
        const outcome = testOutcome(text) ?? (result.is_error ? 'fail' : undefined);
        if (outcome) call.testResult = outcome;
      }
    }
    if (content.results.length && !sidechain && content.texts.some((t) => INTERRUPT.test(t))) {
      // "[Request interrupted by user for tool use]" can ride on the tool result line.
      session.add({ kind: 'interrupt', ts });
    }
    const reason = classify(l, content, sidechain);
    if (reason === 'interrupt') {
      session.add({ kind: 'interrupt', ts });
      return;
    }
    if (reason === 'slash_command') {
      const name = content.texts.map((t) => COMMAND_NAME.exec(t)?.[1]).find(Boolean);
      if (name) bump(session.commands, commandKey(name));
    }
    if (reason !== 'prompt') {
      bump(stats.notPrompts, reason);
      return;
    }
    const text = promptText(content.texts);
    if (!text && content.images === 0) {
      bump(stats.notPrompts, 'empty');
      return;
    }
    if (l.permissionMode) {
      session.mode(l.permissionMode);
      if (l.permissionMode === 'plan') session.usedPlanMode = true;
    }
    session.add({ kind: 'user_prompt', ts, text, images: content.images });
  }

  function assistant(raw: unknown, file: ClaudeFile): void {
    const parsed = AssistantLine.safeParse(raw);
    const ts = parsed.success ? toTime(parsed.data.timestamp) : undefined;
    if (!parsed.success || ts === undefined) {
      stats.malformed++;
      return;
    }
    const l = parsed.data;
    const sidechain = l.isSidechain === true || file.kind !== 'main';
    const session = sessionFor(l.sessionId, file);
    session.seen(ts);
    if (l.agentId && sidechain) session.agents.add(l.agentId);
    common(session, l, !sidechain);
    if (l.message.model === '<synthetic>') {
      bump(stats.notPrompts, 'synthetic_reply');
      return;
    }

    const key = `${l.message.id ?? l.uuid ?? ''}|${l.requestId ?? ''}`;
    let reply = replies.get(key);
    if (!reply) {
      const model = session.model(l.message.model);
      const usage: UsageEvent = {
        kind: 'usage',
        ts,
        sidechain,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      };
      if (model) usage.model = model;
      reply = { usage: session.add(usage) };
      replies.set(key, reply);
      if (l.message.id) session.messageIds.push(l.message.id);
    }
    const u = l.message.usage;
    if (u) {
      reply.usage.input = Math.max(reply.usage.input, u.input_tokens ?? 0);
      reply.usage.output = Math.max(reply.usage.output, u.output_tokens ?? 0);
      reply.usage.cacheRead = Math.max(reply.usage.cacheRead, u.cache_read_input_tokens ?? 0);
      reply.usage.cacheWrite = Math.max(reply.usage.cacheWrite, u.cache_creation_input_tokens ?? 0);
    }

    for (const block of l.message.content) {
      const type = (block as { type?: unknown } | null)?.type;
      if (type === 'text' && !sidechain) {
        const text = TextBlock.safeParse(block);
        if (!text.success) continue;
        const cleaned = cleanText(text.data.text);
        if (reply.text) reply.text.text += `\n${cleaned}`;
        else {
          // The text carries the reply's own time, so it pairs with the reply's usage.
          const event: ReplyEvent = { kind: 'assistant_text', ts: reply.usage.ts, text: cleaned };
          if (reply.usage.model) event.model = reply.usage.model;
          reply.text = session.add(event);
        }
      } else if (type === 'tool_use') {
        const use = ToolUseBlock.safeParse(block);
        if (!use.success || toolCalls.has(use.data.id)) continue;
        if (PLAN_TOOLS.has(use.data.name) && !sidechain) session.usedPlanMode = true;
        const { name, category } = normalizeToolName('claude-code', use.data.name);
        const call: ToolCallEvent = { kind: 'tool_call', ts, name, category, sidechain };
        const input = (
          use.data.input && typeof use.data.input === 'object' ? use.data.input : {}
        ) as Record<string, unknown>;
        if (category === 'Bash') {
          const command = str(input.command);
          if (command) {
            const flags = shellFlags(command);
            if (flags) call.flags = flags;
            if (touchesSensitiveFile(command)) call.sensitive = true;
          }
        }
        const path = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
        if (path && (category === 'Read' || category === 'Search') && isSensitiveFile(path)) {
          call.sensitive = true;
        }
        if (path && (category === 'Edit' || category === 'Write' || category === 'Notebook')) {
          const lang = langCategoryOf(path);
          if (lang >= 0) call.langCat = lang;
        }
        const lines = editLines(use.data.name, use.data.input);
        if (lines) {
          call.linesAdded = lines.added;
          call.linesRemoved = lines.removed;
        }
        toolCalls.set(use.data.id, session.add(call));
      }
    }
  }

  function queued(raw: unknown, file: ClaudeFile): void {
    const parsed = QueuedLine.safeParse(raw);
    if (!parsed.success) return;
    const l = parsed.data;
    const a = l.attachment;
    const ts = toTime(a.timestamp) ?? toTime(l.timestamp);
    if (ts === undefined) return;
    const sidechain = l.isSidechain === true || file.kind !== 'main';
    if (sidechain || a.commandMode !== 'prompt') return;
    if (a.isMeta || l.isMeta || (a.origin?.kind && a.origin.kind !== 'human')) {
      bump(stats.notPrompts, 'queued_not_human');
      return;
    }
    const content = readContent(a.prompt ?? '');
    const text = promptText(content.texts);
    if (!text && content.images === 0) return;
    const session = sessionFor(l.sessionId, file);
    common(session, l, true);
    session.add({ kind: 'user_prompt', ts, text, images: content.images, queued: true });
  }

  /**
   * Reads one line and returns its time when the line is the file's own session's (for the file
   * checks in the CLI). A fork copies its parent's lines, with the parent's `sessionId` and their
   * old times, into the new session's files, so those copies say nothing about the file. A line
   * belongs to the session the parser gives it to.
   */
  function line(text: string, file: ClaudeFile): number | undefined {
    stats.lines++;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      stats.malformed++;
      return undefined;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      stats.malformed++;
      return undefined;
    }
    const r = raw as Record<string, unknown>;
    read(r, file);
    const owner = safeLabel(r.sessionId) ?? file.sessionId;
    return owner === file.sessionId ? toTime(r.timestamp) : undefined;
  }

  function read(r: Record<string, unknown>, file: ClaudeFile): void {
    const type = r.type;
    bump(
      stats.kinds,
      kindName(typeof r.subtype === 'string' ? `${String(type)}/${r.subtype}` : type),
    );
    if (type !== 'user' && type !== 'assistant' && type !== 'attachment' && type !== 'system')
      return;
    if (typeof r.uuid === 'string') {
      if (seenUuids.has(r.uuid)) {
        stats.duplicates++;
        return;
      }
      seenUuids.add(r.uuid);
    }
    if (type === 'user') user(r, file);
    else if (type === 'assistant') assistant(r, file);
    else if (type === 'attachment') {
      if ((r.attachment as { type?: unknown } | null)?.type === 'queued_command') queued(r, file);
    } else if (r.subtype === 'compact_boundary' && r.isSidechain !== true && file.kind === 'main') {
      const ts = toTime(r.timestamp);
      if (ts === undefined) return;
      const session = sessionFor(str(r.sessionId), file);
      session.seen(ts);
      session.compactions++;
    }
  }

  function finish(): ParseResult {
    const built: Session[] = [];
    for (const builder of sessions.values()) {
      const session = builder.build(options);
      if (session?.events.some((e) => e.kind === 'user_prompt' || e.kind === 'usage')) {
        built.push(session);
      }
    }
    built.sort((a, b) => a.startedAt - b.startedAt);
    return { sessions: built, stats };
  }

  return { line, finish, stats };
}
