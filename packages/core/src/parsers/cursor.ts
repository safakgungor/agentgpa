import { z } from 'zod';
import { cleanText, safeLabel } from '../clean.ts';
import { isSensitiveFile, langCategoryOf, touchesSensitiveFile } from '../files.ts';
import { countLines } from '../lines.ts';
import { shellFlags, testOutcome } from '../shell.ts';
import { normalizeToolName } from '../tools.ts';
import { type ParseResult, type ParserOptions, TOOL_FLAGS, type ToolCallEvent } from '../types.ts';
import { bump, emptyStats, kindName, SessionBuilder, toTime } from './session.ts';

// Cursor chats (docs/formats.md): composer and bubble records from the editor's database, and
// agent transcripts for chats whose messages are not kept as bubbles. The CLI reads the
// database and the files; this module only sees their JSON text.

const Composer = z.looseObject({
  _v: z.number().optional(),
  createdAt: z.number().optional(),
  lastUpdatedAt: z.number().optional(),
  unifiedMode: z.string().optional(),
  forceMode: z.string().optional(),
  hasPendingPlan: z.boolean().optional(),
  modelConfig: z.looseObject({ modelName: z.string().optional() }).optional(),
});

const ToolFormer = z.looseObject({
  name: z.string().optional(),
  status: z.string().optional(),
  userDecision: z.string().optional(),
  params: z.string().optional(),
  rawArgs: z.string().optional(),
  result: z.string().optional(),
});

const Bubble = z.looseObject({
  type: z.number(),
  createdAt: z.union([z.string(), z.number()]).optional(),
  text: z.string().optional(),
  images: z.array(z.unknown()).optional(),
  isPlanExecution: z.boolean().optional(),
  requestId: z.string().optional(),
  serverBubbleId: z.string().optional(),
  tokenCount: z
    .looseObject({ inputTokens: z.number().optional(), outputTokens: z.number().optional() })
    .optional(),
  modelInfo: z.looseObject({ modelName: z.string().optional() }).optional(),
  toolFormerData: ToolFormer.optional(),
});

const TranscriptLine = z.looseObject({
  role: z.string(),
  message: z.looseObject({ content: z.union([z.string(), z.array(z.unknown())]) }),
});

const Part = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
  name: z.string().optional(),
  input: z.unknown().optional(),
});

const USER_QUERY = /<user_query>([\s\S]*?)<\/user_query>/;

interface Chat {
  builder: SessionBuilder;
  createdAt?: number;
  lastUpdatedAt?: number;
  bubbles: number;
  transcript: z.infer<typeof TranscriptLine>[];
  fallbackTs?: number;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function args(text: string | undefined): Record<string, unknown> {
  const value = text ? parseJson(text) : undefined;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function toolCall(
  rawName: string,
  input: Record<string, unknown>,
  ts: number,
  approx: boolean,
): ToolCallEvent {
  const { name, category } = normalizeToolName('cursor', rawName);
  const call: ToolCallEvent = { kind: 'tool_call', ts, name, category, sidechain: false };
  if (approx) call.approx = true;
  if (category === 'Bash') {
    const command = str(input.command);
    const flags = command ? shellFlags(command) : 0;
    if (flags) call.flags = flags;
    if (command && touchesSensitiveFile(command)) call.sensitive = true;
  }
  const path =
    str(input.target_file) ??
    str(input.targetFile) ??
    str(input.file_path) ??
    str(input.path) ??
    str(input.relative_workspace_path);
  if (path && (category === 'Read' || category === 'Search') && isSensitiveFile(path)) {
    call.sensitive = true;
  }
  if (path && (category === 'Edit' || category === 'Write' || category === 'Notebook')) {
    const lang = langCategoryOf(path);
    if (lang >= 0) call.langCat = lang;
  }
  if (category === 'Edit' || category === 'Write') {
    const added =
      str(input.new_string) ?? str(input.contents) ?? str(input.content) ?? str(input.code_edit);
    const removed = str(input.old_string);
    if (added !== undefined || removed !== undefined) {
      call.linesAdded = countLines(added ?? '');
      call.linesRemoved = countLines(removed ?? '');
    }
  }
  return call;
}

export function createCursorParser(options: ParserOptions) {
  const stats = emptyStats();
  const chats = new Map<string, Chat>();
  const seenBubbles = new Set<string>();

  function chatFor(id: string): Chat {
    let chat = chats.get(id);
    if (!chat) {
      chat = { builder: new SessionBuilder('cursor', id), bubbles: 0, transcript: [] };
      chats.set(id, chat);
    }
    return chat;
  }

  /** A `composerData` value, or the `value` of a `composerHeaders` row. */
  function composer(id: string, json: string): void {
    stats.lines++;
    if (!json) {
      bump(stats.kinds, 'composer/empty');
      return;
    }
    bump(stats.kinds, 'composer');
    const parsed = Composer.safeParse(parseJson(json));
    if (!parsed.success) {
      stats.malformed++;
      return;
    }
    const c = parsed.data;
    const chat = chatFor(id);
    const b = chat.builder;
    if (c.createdAt) chat.createdAt = Math.min(chat.createdAt ?? c.createdAt, c.createdAt);
    if (c.lastUpdatedAt) chat.lastUpdatedAt = Math.max(chat.lastUpdatedAt ?? 0, c.lastUpdatedAt);
    if (c._v !== undefined) b.formatVersion ??= c._v;
    if (c.unifiedMode === 'plan' || c.forceMode === 'plan' || c.hasPendingPlan)
      b.usedPlanMode = true;
    if (c.unifiedMode) b.mode(c.unifiedMode);
    if (c.modelConfig?.modelName) b.model(c.modelConfig.modelName);
  }

  function bubble(composerId: string, bubbleId: string, json: string): void {
    stats.lines++;
    bump(stats.kinds, 'bubble');
    if (seenBubbles.has(bubbleId)) {
      stats.duplicates++;
      return;
    }
    seenBubbles.add(bubbleId);
    const parsed = Bubble.safeParse(parseJson(json));
    const ts = parsed.success ? toTime(parsed.data.createdAt) : undefined;
    if (!parsed.success || ts === undefined) {
      stats.malformed++;
      return;
    }
    const m = parsed.data;
    const chat = chatFor(composerId);
    const b = chat.builder;
    chat.bubbles++;
    b.entrypoint ??= 'editor';
    b.seen(ts);
    if (m.isPlanExecution) b.usedPlanMode = true;
    if (m.type === 1) {
      const text = cleanText(m.text ?? '').trim();
      const images = m.images?.length ?? 0;
      if (text || images) b.add({ kind: 'user_prompt', ts, text, images });
      else bump(stats.notPrompts, 'empty');
      return;
    }
    if (m.type !== 2) {
      bump(stats.notPrompts, 'other_bubble');
      return;
    }
    const model = b.model(m.modelInfo?.modelName);
    if (m.text)
      b.add({ kind: 'assistant_text', ts, text: cleanText(m.text), ...(model ? { model } : {}) });
    const input = m.tokenCount?.inputTokens ?? 0;
    const output = m.tokenCount?.outputTokens ?? 0;
    if (input || output) {
      b.add({
        kind: 'usage',
        ts,
        sidechain: false,
        input,
        output,
        cacheRead: 0,
        cacheWrite: 0,
        ...(model ? { model } : {}),
      });
    }
    const id = m.serverBubbleId ?? m.requestId;
    if (id) b.messageIds.push(id);
    const tool = m.toolFormerData;
    if (tool?.result && options.onToolOutput) {
      options.onToolOutput(tool.result, ts, normalizeToolName('cursor', tool.name ?? '').category);
    }
    if (tool?.name) {
      const call = b.add(
        toolCall(tool.name, { ...args(tool.rawArgs), ...args(tool.params) }, ts, false),
      );
      if (tool.userDecision === 'rejected') call.declined = true;
      else if (tool.status === 'error') call.error = true;
      if ((call.flags ?? 0) & TOOL_FLAGS.test) {
        const outcome = testOutcome(tool.result ?? '') ?? (call.error ? 'fail' : undefined);
        if (outcome) call.testResult = outcome;
      }
    }
  }

  /** One line of an agent transcript; `fallbackTs` is used when the chat has no record. */
  function transcriptLine(composerId: string, json: string, fallbackTs: number): void {
    stats.lines++;
    const value = parseJson(json);
    const type = (value as { type?: unknown; role?: unknown } | null)?.type;
    if (value && typeof value === 'object' && !('role' in value) && typeof type === 'string') {
      // Turn status lines (`{ type, status }`) carry no message.
      bump(stats.kinds, `transcript/${kindName(type)}`);
      return;
    }
    bump(stats.kinds, 'transcript');
    const parsed = TranscriptLine.safeParse(value);
    if (!parsed.success) {
      stats.malformed++;
      return;
    }
    const chat = chatFor(composerId);
    chat.fallbackTs = Math.min(chat.fallbackTs ?? fallbackTs, fallbackTs);
    chat.transcript.push(parsed.data);
  }

  function fromTranscript(chat: Chat): void {
    const ts = chat.createdAt ?? chat.fallbackTs;
    if (ts === undefined) return;
    const b = chat.builder;
    b.entrypoint ??= 'agent-transcript';
    b.seen(ts);
    if (chat.lastUpdatedAt) b.seen(chat.lastUpdatedAt);
    for (const line of chat.transcript) {
      const content = line.message.content;
      const parts = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
      const texts: string[] = [];
      for (const raw of parts) {
        const part = Part.safeParse(raw);
        if (!part.success) continue;
        if (part.data.type === 'text' && part.data.text) texts.push(part.data.text);
        else if (part.data.type === 'tool_use' && line.role === 'assistant' && part.data.name) {
          const input =
            part.data.input && typeof part.data.input === 'object'
              ? (part.data.input as Record<string, unknown>)
              : {};
          b.add(toolCall(part.data.name, input, ts, true));
        }
      }
      if (line.role === 'user') {
        const joined = texts.join('\n');
        const query = USER_QUERY.exec(joined)?.[1] ?? joined;
        const text = cleanText(query).trim();
        if (text) b.add({ kind: 'user_prompt', ts, text, images: 0, approx: true });
        else bump(stats.notPrompts, 'empty');
      } else if (line.role === 'assistant' && texts.length) {
        b.add({ kind: 'assistant_text', ts, text: cleanText(texts.join('\n')), approx: true });
      }
    }
  }

  function finish(): ParseResult {
    const built = [];
    for (const chat of chats.values()) {
      // A chat is read from its bubbles when it has any, otherwise from its transcript.
      if (chat.bubbles === 0) fromTranscript(chat);
      else if (chat.transcript.length)
        bump(stats.notPrompts, 'transcript_of_a_chat_with_bubbles', chat.transcript.length);
      if (chat.createdAt && chat.bubbles) chat.builder.seen(chat.createdAt);
      const session = chat.builder.build(options);
      if (session?.events.some((e) => e.kind === 'user_prompt' || e.kind === 'assistant_text'))
        built.push(session);
    }
    built.sort((a, b) => a.startedAt - b.startedAt);
    return { sessions: built, stats };
  }

  return { composer, bubble, transcriptLine, finish, stats };
}

/** True for a value that looks like a composer or bubble id. */
export function isCursorId(value: string): boolean {
  return safeLabel(value) !== undefined && value.length <= 64;
}
