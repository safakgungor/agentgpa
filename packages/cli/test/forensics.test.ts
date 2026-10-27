import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClaudeFileKind, Session } from '@agentgpa/core';
import { describe, expect, it } from 'vitest';
import type { ClaudeFound, Discovery } from '../src/discover.ts';
import { checkFiles, type Forensics, leaveOut } from '../src/forensics.ts';
import { fileChecksLine } from '../src/report.ts';
import { scan } from '../src/scan.ts';

const hour = 3_600_000;
const t = Date.UTC(2027, 0, 4, 9);

describe('the file checks', () => {
  it('fail a session whose file was created long after its newest own line', () => {
    const checks = checkFiles([
      { tool: 'claude-code', kind: 'main', sessionId: 'kept', createdMs: t - hour, newestMs: t },
      {
        tool: 'claude-code',
        kind: 'main',
        sessionId: 'resumed',
        createdMs: t + 30 * 60_000,
        newestMs: t,
      },
      {
        tool: 'codex',
        kind: 'rollout',
        sessionId: 'copied',
        createdMs: t + 72 * hour,
        newestMs: t,
      },
      { tool: 'claude-code', kind: 'main', sessionId: 'no-birth-time', newestMs: t },
      // A file with no line of its own session (a fork's copy of a subagent) is not judged.
      { tool: 'claude-code', kind: 'subagent', sessionId: 'no-own-lines', createdMs: t },
    ]);
    expect([...checks.failed]).toEqual(['codex:copied']);
    expect(checks.files).toEqual({ 'codex rollout': 1 });
  });

  it('count only the sessions the report would have held', () => {
    const checks = {
      failed: new Set(['claude-code:old', 'claude-code:recent', 'codex:no-session']),
      files: { 'claude-code main': 2, 'codex rollout': 1 },
    };
    const sessions = [
      { tool: 'claude-code', id: 'old' },
      { tool: 'claude-code', id: 'recent' },
      { tool: 'claude-code', id: 'kept' },
    ] as Session[];
    const { kept, forensics } = leaveOut(sessions, checks, (s) => s.id !== 'old');
    expect(kept.map((s) => s.id)).toEqual(['kept']);
    expect(forensics).toEqual({
      excludedSessions: 1,
      reasons: { 'created-after-last-event': 1 },
      outsidePeriod: 1,
      files: { 'claude-code main': 2, 'codex rollout': 1 },
    });
  });

  it('send no reason when nothing the report would hold was left out', () => {
    const checks = { failed: new Set(['claude-code:old']), files: { 'claude-code main': 1 } };
    const sessions = [{ tool: 'claude-code', id: 'old' }] as Session[];
    expect(leaveOut(sessions, checks, () => false).forensics).toMatchObject({
      excludedSessions: 0,
      reasons: {},
      outsidePeriod: 1,
    });
  });

  it('show in --debug what they left out and which files failed, as counts', () => {
    const f: Forensics = {
      excludedSessions: 2,
      reasons: { 'created-after-last-event': 2 },
      outsidePeriod: 3,
      files: { 'claude-code subagent': 4, 'codex rollout': 1 },
    };
    expect(fileChecksLine(f, 0)).toBe(
      "  file checks: 2 sessions left out of the report, 3 more outside the period (files: claude-code subagent 4, codex rollout 1); agent's own session skipped: 0",
    );
    const none = { excludedSessions: 0, reasons: {}, outsidePeriod: 0, files: {} };
    expect(fileChecksLine(none, 1)).toBe(
      "  file checks: 0 sessions left out of the report, 0 more outside the period; agent's own session skipped: 1",
    );
  });
});

// Forks: the Claude desktop app can go on with a session as a new one. The new main file starts
// with copies of the parent's lines (the parent's sessionId and old times), and the parent's
// subagent files are copied into the new session's folder. Synthetic lines only.
const dir = mkdtempSync(join(tmpdir(), 'agentgpa-forks-'));
let n = 0;
const at = (h: number) => Date.UTC(2027, 0, 4, h);

function prompt(sessionId: string, h: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'user',
    uuid: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    sessionId,
    timestamp: new Date(at(h)).toISOString(),
    message: { role: 'user', content: 'synthetic words for a test' },
    ...extra,
  });
}

function file(
  name: string,
  lines: string[],
  kind: ClaudeFileKind,
  sessionId: string,
  createdMs: number,
): ClaudeFound {
  const path = join(dir, name);
  writeFileSync(path, `${lines.join('\n')}\n`);
  return { path, size: 0, mtimeMs: createdMs, birthtimeMs: createdMs, createdMs, kind, sessionId };
}

function discovery(files: ClaudeFound[]): Discovery {
  return {
    claude: { dir, found: true, files, cleanupPeriodDays: 30, cleanupFromSettings: false },
    codex: { dir, found: false, files: [] },
    cursor: { found: false, databases: [], transcripts: [] },
  };
}

describe('the file checks on a fork', () => {
  it('judge each file by its own lines, so the copies leave nobody out', async () => {
    const parent = [prompt('parent', 1), prompt('parent', 2)];
    const agent = [prompt('parent', 1, { isSidechain: true, agentId: 'a1' })];
    const files = [
      file('parent.jsonl', parent, 'main', 'parent', at(1)),
      file('parent-agent.jsonl', agent, 'subagent', 'parent', at(1)),
      // Made eight hours after the parent's lines: the fork, and its copy of the subagent.
      file('fork.jsonl', [...parent, prompt('fork', 9), prompt('fork', 10)], 'main', 'fork', at(9)),
      file('fork-agent.jsonl', agent, 'subagent', 'fork', at(9)),
    ];
    const [claude] = await scan(discovery(files), ['claude-code']);
    expect([...checkFiles(claude?.fileFacts ?? []).failed]).toEqual([]);
    const sessions = claude?.result.sessions ?? [];
    expect(sessions.map((s) => s.id).sort()).toEqual(['fork', 'parent']);
    // The copies went back to the parent: the fork holds its own prompts only.
    const prompts = (id: string) =>
      sessions
        .find((s) => s.id === id)
        ?.events.filter((e) => e.kind === 'user_prompt')
        .map((e) => e.ts);
    expect(prompts('fork')).toEqual([at(9), at(10)]);
    expect(prompts('parent')).toEqual([at(1), at(2)]);
  });

  it('still fail a session whose own lines are all older than its file', async () => {
    const files = [
      file('copied.jsonl', [prompt('copied', 1), prompt('copied', 2)], 'main', 'copied', at(30)),
    ];
    const [claude] = await scan(discovery(files), ['claude-code']);
    const checks = checkFiles(claude?.fileFacts ?? []);
    expect([...checks.failed]).toEqual(['claude-code:copied']);
    expect(checks.files).toEqual({ 'claude-code main': 1 });
  });
});
