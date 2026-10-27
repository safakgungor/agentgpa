import { createHash } from 'node:crypto';
import {
  createClaudeCodeParser,
  createCodexParser,
  createCursorParser,
  type ParseResult,
  type Tool,
  type ToolCategory,
} from '@agentgpa/core';
import { type CursorUnreadable, readCursorDatabase } from './cursorDb.ts';
import type { Discovery } from './discover.ts';
import { type ReadResult, readLines } from './read.ts';

// Reads every file discovery found and runs the pure parsers over it. Transcript text stays
// in memory; nothing here writes, logs or sends it.

export interface ToolScan {
  tool: Tool;
  found: boolean;
  readable: boolean;
  /** Why a tool that was found could not be read, so the screen can name the fix. */
  unreadable?: CursorUnreadable;
  files: Record<string, number>;
  /** Files that could not be read, moved or deleted while the scan ran; the rest still count. */
  skipped: number;
  bytes: number;
  ms: number;
  result: ParseResult;
  /** Per session file: its session, when it was created and its session's newest line in it. */
  fileFacts: FileFact[];
}

export interface FileFact {
  tool: Tool;
  /** What kind of file it is, for --debug: a Claude Code file kind, or a Codex rollout. */
  kind: string;
  sessionId: string;
  createdMs?: number;
  /** The newest time on the session's own lines in the file. */
  newestMs?: number;
}

function fact(
  tool: Tool,
  kind: string,
  sessionId: string,
  createdMs: number | undefined,
  newestMs: number,
): FileFact {
  const f: FileFact = { tool, kind, sessionId };
  if (createdMs !== undefined) f.createdMs = createdMs;
  if (newestMs > 0) f.newestMs = newestMs;
  return f;
}

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Sees each tool output of a tool while it is parsed (the secret scan); nothing keeps the text. */
export type ToolOutputHook = (
  tool: Tool,
) => ((text: string, ts: number, category: ToolCategory | undefined) => void) | undefined;

export async function scan(
  discovery: Discovery,
  tools: readonly Tool[],
  onToolOutput?: ToolOutputHook,
  /** Each tool as its reading starts, for the progress line. */
  onStart?: (tool: Tool) => void,
): Promise<ToolScan[]> {
  const out: ToolScan[] = [];
  for (const tool of tools) {
    onStart?.(tool);
    const started = performance.now();
    const hook = onToolOutput?.(tool);
    if (tool === 'claude-code')
      out.push({ ...(await claudeCode(discovery, hook)), ms: performance.now() - started });
    else if (tool === 'codex')
      out.push({ ...(await codex(discovery, hook)), ms: performance.now() - started });
    else out.push({ ...(await cursor(discovery, hook)), ms: performance.now() - started });
  }
  return out;
}

type Hook = ((text: string, ts: number, category: ToolCategory | undefined) => void) | undefined;

/** Reads one file, or undefined when it cannot be read, so one bad file never ends the scan. */
async function readOrSkip(
  path: string,
  onLine: (line: string) => void,
): Promise<ReadResult | undefined> {
  try {
    return await readLines(path, onLine);
  } catch {
    return undefined;
  }
}
const options = (hook: Hook) => (hook ? { hash: sha256, onToolOutput: hook } : { hash: sha256 });

async function claudeCode(discovery: Discovery, hook: Hook): Promise<Omit<ToolScan, 'ms'>> {
  const parser = createClaudeCodeParser(options(hook));
  const files: Record<string, number> = { main: 0, subagent: 0, 'workflow-agent': 0 };
  let bytes = 0;
  let skipped = 0;
  const fileFacts: FileFact[] = [];
  for (const file of discovery.claude.files) {
    files[file.kind] = (files[file.kind] ?? 0) + 1;
    const target = { kind: file.kind, sessionId: file.sessionId };
    let newest = 0;
    const read = await readOrSkip(file.path, (line) => {
      const ts = parser.line(line, target);
      if (ts !== undefined && ts > newest) newest = ts;
    });
    if (!read) {
      skipped++;
      continue;
    }
    bytes += read.bytes;
    parser.stats.oversized += read.oversized;
    fileFacts.push(fact('claude-code', file.kind, file.sessionId, file.createdMs, newest));
  }
  return {
    tool: 'claude-code',
    found: discovery.claude.found,
    readable: true,
    files,
    skipped,
    bytes,
    result: parser.finish(),
    fileFacts,
  };
}

async function codex(discovery: Discovery, hook: Hook): Promise<Omit<ToolScan, 'ms'>> {
  const parser = createCodexParser(options(hook));
  let bytes = 0;
  let skipped = 0;
  const fileFacts: FileFact[] = [];
  for (const file of discovery.codex.files) {
    let newest = 0;
    const read = await readOrSkip(file.path, (line) => {
      const ts = parser.line(line, file.sessionId);
      if (ts !== undefined && ts > newest) newest = ts;
    });
    if (!read) {
      skipped++;
      continue;
    }
    bytes += read.bytes;
    parser.stats.oversized += read.oversized;
    fileFacts.push(fact('codex', 'rollout', file.sessionId, file.createdMs, newest));
  }
  return {
    tool: 'codex',
    found: discovery.codex.found,
    readable: true,
    files: { rollout: discovery.codex.files.length },
    skipped,
    bytes,
    result: parser.finish(),
    fileFacts,
  };
}

async function cursor(discovery: Discovery, hook: Hook): Promise<Omit<ToolScan, 'ms'>> {
  const parser = createCursorParser(options(hook));
  let unreadable: CursorUnreadable | undefined;
  let bytes = 0;
  let skipped = 0;
  for (const db of discovery.cursor.databases) {
    const result = await readCursorDatabase(db, parser);
    if (!result.readable) unreadable ??= result.reason;
  }
  for (const file of discovery.cursor.transcripts) {
    const read = await readOrSkip(file.path, (line) =>
      parser.transcriptLine(file.composerId, line, file.birthtimeMs),
    );
    if (!read) {
      skipped++;
      continue;
    }
    bytes += read.bytes;
    parser.stats.oversized += read.oversized;
  }
  return {
    tool: 'cursor',
    found: discovery.cursor.found,
    readable: unreadable === undefined,
    ...(unreadable ? { unreadable } : {}),
    files: {
      database: discovery.cursor.databases.length,
      transcript: discovery.cursor.transcripts.length,
    },
    skipped,
    bytes,
    result: parser.finish(),
    // One database holds every chat, so the file checks do not apply to Cursor.
    fileFacts: [],
  };
}
