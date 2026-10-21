import { z } from 'zod';
import { cleanText, safeLabel } from '../clean.ts';
import { isSensitiveFile, langCategoryOf, touchesSensitiveFile } from '../files.ts';
import { patchLines } from '../lines.ts';
import { shellFlags, testOutcome } from '../shell.ts';
import { normalizeToolName } from '../tools.ts';
import { type ParseResult, type ParserOptions, TOOL_FLAGS, type ToolCallEvent } from '../types.ts';
import { bump, emptyStats, kindName, SessionBuilder, toTime } from './session.ts';

// Codex rollout files (docs/formats.md). One file is one session. Prompts and replies come
// from the best source a session has: finished items, then older events, then raw model input.

const Line = z.looseObject({
  timestamp: z.string(),
  type: z.string(),
  payload: z.looseObject({ type: z.string().optional() }).optional(),
});

const ContentBlock = z.looseObject({ type: z.string(), text: z.string().optional() });

const Item = z.looseObject({
  id: z.string().optional(),
  type: z.string(),
  content: z.array(ContentBlock).optional(),
});

const TokenTotals = z.looseObject({
  input_tokens: z.number().optional(),
  cached_input_tokens: z.number().optional(),
  cache_write_input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
});

const INJECTED =
  /^\s*(?:<(?:environment_context|user_instructions|permissions|developer_instructions|collaboration_mode|apps_instructions|skills_instructions|turn_aborted|user_shell_command|subagent_notification|personality)\b|# AGENTS\.md instructions)/;

type Source = 'item' | 'event' | 'response';

interface Candidate {
  ts: number;
  text: string;
  images: number;
  model?: string;
}

interface CodexSession {
  builder: SessionBuilder;
  prompts: Record<Source, Candidate[]>;
  replies: Record<Source, Candidate[]>;
  model?: string;
  totals?: { input: number; cached: number; cacheWrite: number; output: number };
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function texts(blocks: z.infer<typeof ContentBlock>[] | undefined, kinds: string[]): string[] {
  return (blocks ?? [])
    .filter((b) => kinds.includes(b.type) && typeof b.text === 'string')
    .map((b) => b.text as string);
}

/** The command of a shell tool call, from its JSON arguments or its free-form input. */
function commandOf(args: unknown): string | undefined {
  if (typeof args === 'string') {
    try {
      return commandOf(JSON.parse(args));
    } catch {
      return args;
    }
  }
  if (!args || typeof args !== 'object') return undefined;
  const a = args as Record<string, unknown>;
  for (const key of ['cmd', 'command']) {
    const value = a[key];
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.filter((v) => typeof v === 'string').join(' ');
  }
  return undefined;
}

/** The first file a patch adds, updates or deletes. */
const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/m;

/** A path argument of a tool call, from its JSON arguments. */
function pathOf(args: unknown): string | undefined {
  if (typeof args === 'string') {
    try {
      return pathOf(JSON.parse(args));
    } catch {
      return undefined;
    }
  }
  if (!args || typeof args !== 'object') return undefined;
  const a = args as Record<string, unknown>;
  return str(a.path) ?? str(a.file_path);
}

/** True when a tool output reports a non-zero exit code. */
function failed(output: unknown): boolean {
  const text = typeof output === 'string' ? output : JSON.stringify(output ?? '');
  const json = /"exit_code"\s*:\s*(-?\d+)/.exec(text);
  if (json) return json[1] !== '0';
  const plain = /^Exit code:\s*(-?\d+)/m.exec(text);
  return plain ? plain[1] !== '0' : false;
}

export function createCodexParser(options: ParserOptions) {
  const stats = emptyStats();
  const sessions = new Map<string, CodexSession>();
  const seenItems = new Set<string>();
  const toolCalls = new Map<string, ToolCallEvent>();

  function sessionFor(id: string): CodexSession {
    let s = sessions.get(id);
    if (!s) {
      s = {
        builder: new SessionBuilder('codex', id),
        prompts: { item: [], event: [], response: [] },
        replies: { item: [], event: [], response: [] },
      };
      sessions.set(id, s);
    }
    return s;
  }

  function addCall(
    s: CodexSession,
    ts: number,
    rawName: string,
    callId: string | undefined,
    input: unknown,
  ): void {
    if (callId && toolCalls.has(callId)) return;
    const { name, category } = normalizeToolName('codex', rawName);
    const call: ToolCallEvent = { kind: 'tool_call', ts, name, category, sidechain: false };
    if (category === 'Bash') {
      const command = commandOf(input);
      const flags = command ? shellFlags(command) : 0;
      if (flags) call.flags = flags;
      if (command && touchesSensitiveFile(command)) call.sensitive = true;
    }
    if (category === 'Read') {
      const path = pathOf(input);
      if (path && isSensitiveFile(path)) call.sensitive = true;
    }
    if (rawName === 'apply_patch') {
      const patch =
        typeof input === 'string'
          ? input
          : (commandOf(input) ?? str((input as { input?: unknown } | null)?.input));
      if (patch) {
        const lines = patchLines(patch);
        call.linesAdded = lines.added;
        call.linesRemoved = lines.removed;
        // One category per call: a patch over several files counts its first one.
        const file = PATCH_FILE.exec(patch)?.[1];
        const lang = file ? langCategoryOf(file) : -1;
        if (lang >= 0) call.langCat = lang;
      }
    }
    s.builder.add(call);
    if (callId) toolCalls.set(callId, call);
  }

  /**
   * Reads one line and returns its time, if it has one (for the file checks in the CLI).
   * `fileSession` is the id the file name gives; `session_meta` usually confirms it.
   */
  function line(text: string, fileSession: string): number | undefined {
    stats.lines++;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      stats.malformed++;
      return undefined;
    }
    const parsed = Line.safeParse(raw);
    const ts = parsed.success ? toTime(parsed.data.timestamp) : undefined;
    if (!parsed.success || ts === undefined) {
      stats.malformed++;
      return undefined;
    }
    read(parsed.data, ts, fileSession);
    return ts;
  }

  function read(l: z.infer<typeof Line>, ts: number, fileSession: string): void {
    const p = (l.payload ?? {}) as Record<string, unknown>;
    const ptype = str(p.type);
    bump(
      stats.kinds,
      kindName(
        ptype && l.type !== 'session_meta' && l.type !== 'turn_context'
          ? `${l.type}/${ptype}`
          : l.type,
      ),
    );
    const s = sessionFor(fileSession);
    const b = s.builder;
    b.seen(ts);

    if (l.type === 'session_meta') {
      b.version ??= safeLabel(p.cli_version);
      b.entrypoint ??= safeLabel(p.originator) ?? safeLabel(p.source);
      if (b.cwd === undefined && typeof p.cwd === 'string') b.cwd = p.cwd;
      return;
    }
    if (l.type === 'turn_context') {
      const model = b.model(p.model);
      if (model) s.model = model;
      const collaboration = (p.collaboration_mode as { mode?: unknown } | undefined)?.mode;
      if (collaboration === 'plan') b.usedPlanMode = true;
      const sandbox = (p.sandbox_policy as { type?: unknown } | undefined)?.type;
      if (typeof sandbox === 'string') b.mode(`sandbox:${sandbox}`);
      if (b.cwd === undefined && typeof p.cwd === 'string') b.cwd = p.cwd;
      return;
    }
    if (l.type === 'event_msg') {
      if (ptype === 'task_started' && p.collaboration_mode_kind === 'plan') b.usedPlanMode = true;
      else if (ptype === 'turn_aborted') {
        if (p.reason === 'interrupted') b.add({ kind: 'interrupt', ts });
      } else if (ptype === 'user_message') {
        const message = str(p.message);
        const images = Array.isArray(p.images) ? p.images.length : 0;
        if (message !== undefined)
          s.prompts.event.push({ ts, text: cleanText(message).trim(), images });
      } else if (ptype === 'agent_message') {
        const message = str(p.message);
        if (message)
          s.replies.event.push(withModel({ ts, text: cleanText(message), images: 0 }, s.model));
      } else if (ptype === 'token_count') usage(s, ts, p.info);
      else if (ptype === 'item_completed') item(s, ts, p.item);
      return;
    }
    if (l.type === 'response_item') {
      if (ptype === 'message') {
        const role = p.role;
        const content = z.array(ContentBlock).safeParse(p.content);
        if (!content.success) return;
        if (role === 'user') {
          const own = texts(content.data, ['input_text']).filter((t) => !INJECTED.test(t));
          const images = content.data.filter((c) => c.type === 'input_image').length;
          if (own.length || images)
            s.prompts.response.push({ ts, text: cleanText(own.join('\n')).trim(), images });
        } else if (role === 'assistant') {
          if (typeof p.id === 'string') b.messageIds.push(p.id);
          const out = texts(content.data, ['output_text']);
          if (out.length)
            s.replies.response.push(
              withModel({ ts, text: cleanText(out.join('\n')), images: 0 }, s.model),
            );
        }
      } else if (ptype === 'function_call') {
        addCall(s, ts, str(p.name) ?? '', str(p.call_id), p.arguments);
      } else if (ptype === 'custom_tool_call') {
        addCall(s, ts, str(p.name) ?? '', str(p.call_id), p.input);
      } else if (ptype === 'local_shell_call') {
        addCall(
          s,
          ts,
          'local_shell_call',
          str(p.call_id),
          (p.action as { command?: unknown } | undefined) ?? {},
        );
      } else if (ptype === 'function_call_output' || ptype === 'custom_tool_call_output') {
        const call = toolCalls.get(str(p.call_id) ?? '');
        const isTest = ((call?.flags ?? 0) & TOOL_FLAGS.test) !== 0;
        const output =
          options.onToolOutput || isTest
            ? typeof p.output === 'string'
              ? p.output
              : JSON.stringify(p.output ?? '')
            : '';
        if (options.onToolOutput && output) options.onToolOutput(output, ts, call?.category);
        if (call && failed(p.output)) call.error = true;
        if (call && isTest) {
          const outcome = testOutcome(output) ?? (call.error ? 'fail' : undefined);
          if (outcome) call.testResult = outcome;
        }
      }
    }
  }

  function withModel(c: Candidate, model: string | undefined): Candidate {
    if (model) c.model = model;
    return c;
  }

  function item(s: CodexSession, ts: number, value: unknown): void {
    const parsed = Item.safeParse(value);
    if (!parsed.success) return;
    const it = parsed.data;
    // Item ids count up per session (`item-1`, `item-2`), so they are unique only within one.
    if (it.id) {
      const key = `${s.builder.id}:${it.id}`;
      if (seenItems.has(key)) {
        stats.duplicates++;
        return;
      }
      seenItems.add(key);
    }
    if (it.type === 'UserMessage') {
      const own = texts(it.content, ['text', 'Text']);
      const images = (it.content ?? []).filter(
        (c) => c.type === 'local_image' || c.type === 'image',
      ).length;
      s.prompts.item.push({ ts, text: cleanText(own.join('\n')).trim(), images });
    } else if (it.type === 'AgentMessage') {
      const out = texts(it.content, ['text', 'Text']);
      if (out.length)
        s.replies.item.push(withModel({ ts, text: cleanText(out.join('\n')), images: 0 }, s.model));
    } else if (it.type === 'WebSearch') addCall(s, ts, 'web_search', it.id, undefined);
  }

  function usage(s: CodexSession, ts: number, info: unknown): void {
    const totals = TokenTotals.safeParse(
      (info as { total_token_usage?: unknown } | null)?.total_token_usage,
    );
    if (!totals.success) return;
    const t = {
      input: totals.data.input_tokens ?? 0,
      cached: totals.data.cached_input_tokens ?? 0,
      cacheWrite: totals.data.cache_write_input_tokens ?? 0,
      output: totals.data.output_tokens ?? 0,
    };
    const prev = s.totals ?? { input: 0, cached: 0, cacheWrite: 0, output: 0 };
    const d = {
      input: Math.max(0, t.input - prev.input),
      cached: Math.max(0, t.cached - prev.cached),
      cacheWrite: Math.max(0, t.cacheWrite - prev.cacheWrite),
      output: Math.max(0, t.output - prev.output),
    };
    s.totals = t;
    if (d.input + d.cached + d.cacheWrite + d.output === 0) return;
    const event = {
      kind: 'usage' as const,
      ts,
      sidechain: false,
      // input_tokens includes the cached part.
      input: Math.max(0, d.input - d.cached),
      output: d.output,
      cacheRead: d.cached,
      cacheWrite: d.cacheWrite,
      ...(s.model ? { model: s.model } : {}),
    };
    s.builder.add(event);
  }

  function finish(): ParseResult {
    const built = [];
    for (const s of sessions.values()) {
      const prompts = s.prompts.item.length
        ? s.prompts.item
        : s.prompts.event.length
          ? s.prompts.event
          : s.prompts.response;
      for (const c of prompts)
        if (c.text || c.images)
          s.builder.add({ kind: 'user_prompt', ts: c.ts, text: c.text, images: c.images });
      const replies = s.replies.item.length
        ? s.replies.item
        : s.replies.event.length
          ? s.replies.event
          : s.replies.response;
      for (const c of replies) {
        s.builder.add({
          kind: 'assistant_text',
          ts: c.ts,
          text: c.text,
          ...(c.model ? { model: c.model } : {}),
        });
      }
      const session = s.builder.build(options);
      if (session?.events.some((e) => e.kind === 'user_prompt' || e.kind === 'usage'))
        built.push(session);
    }
    built.sort((a, b) => a.startedAt - b.startedAt);
    return { sessions: built, stats };
  }

  return { line, finish, stats };
}
