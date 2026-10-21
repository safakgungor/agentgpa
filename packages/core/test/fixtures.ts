import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type ClaudeFileKind,
  createClaudeCodeParser,
  createCodexParser,
  createCursorParser,
  type ParseResult,
} from '../src/index.ts';

// Loads the fixture home (fixtures/home, made by scripts/make-fixture.ts) into the parsers.

export const HOME = fileURLToPath(new URL('../../../fixtures/home/', import.meta.url));

export const hash = (text: string): string => `hash:${text.length}`;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

export function lines(file: string): string[] {
  return readFileSync(file, 'utf8').split('\n').filter(Boolean);
}

export function claudeFiles(): { path: string; kind: ClaudeFileKind; sessionId: string }[] {
  const root = join(HOME, '.claude', 'projects');
  const out: { path: string; kind: ClaudeFileKind; sessionId: string }[] = [];
  for (const path of walk(root).filter((f) => f.endsWith('.jsonl'))) {
    const parts = relative(root, path).split('/');
    if (parts.length === 2) out.push({ path, kind: 'main', sessionId: basename(path, '.jsonl') });
    else if (parts.length === 4 && parts[2] === 'subagents')
      out.push({ path, kind: 'subagent', sessionId: parts[1] as string });
    else if (parts.length === 6 && parts[3] === 'workflows' && parts[5]?.startsWith('agent-')) {
      out.push({ path, kind: 'workflow-agent', sessionId: parts[1] as string });
    }
  }
  return out;
}

export function parseClaude(): ParseResult {
  const parser = createClaudeCodeParser({ hash });
  for (const f of claudeFiles()) for (const line of lines(f.path)) parser.line(line, f);
  return parser.finish();
}

export function parseCodex(): ParseResult {
  const parser = createCodexParser({ hash });
  for (const path of walk(join(HOME, '.codex', 'sessions'))) {
    const id = /([0-9a-f-]{36})\.jsonl$/.exec(path)?.[1] ?? basename(path);
    for (const line of lines(path)) parser.line(line, id);
  }
  return parser.finish();
}

interface CursorFixture {
  cursorDiskKV: { key: string; value: string }[];
}

export function parseCursor(): ParseResult {
  const parser = createCursorParser({ hash });
  const db = JSON.parse(readFileSync(join(HOME, 'cursor-db.json'), 'utf8')) as CursorFixture;
  for (const row of db.cursorDiskKV)
    if (row.key.startsWith('composerData:')) parser.composer(row.key.slice(13), row.value);
  for (const row of db.cursorDiskKV) {
    const [kind, composer, bubble] = row.key.split(':');
    if (kind === 'bubbleId' && composer && bubble) parser.bubble(composer, bubble, row.value);
  }
  for (const path of walk(join(HOME, '.cursor', 'projects')).filter((f) => f.endsWith('.jsonl'))) {
    for (const line of lines(path)) parser.transcriptLine(basename(path, '.jsonl'), line, 1);
  }
  return parser.finish();
}

export function count(result: ParseResult, kind: string): number {
  return result.sessions.reduce((n, s) => n + s.events.filter((e) => e.kind === kind).length, 0);
}
