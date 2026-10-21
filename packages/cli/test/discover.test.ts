import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discover } from '../src/discover.ts';
import { fixtureHome } from './home.ts';

describe('discover', () => {
  it('finds every tool in a fixture home and sorts Claude Code files by kind', async () => {
    const home = await fixtureHome();
    const d = discover({ root: home });
    expect(d.claude.found).toBe(true);
    const kinds = d.claude.files.map((f) => f.kind);
    expect(kinds.filter((k) => k === 'main')).toHaveLength(6);
    expect(kinds.filter((k) => k === 'subagent')).toHaveLength(3);
    expect(kinds.filter((k) => k === 'workflow-agent')).toHaveLength(1);
    // The workflow journal sits next to the workflow agent and is not a transcript.
    expect(d.claude.files.some((f) => f.path.endsWith('journal.jsonl'))).toBe(false);
    expect(
      d.claude.files
        .filter((f) => f.kind !== 'main')
        .every((f) => d.claude.files.some((m) => m.kind === 'main' && m.sessionId === f.sessionId)),
    ).toBe(true);
    expect(d.codex.files).toHaveLength(1);
    expect(d.codex.files[0]?.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(d.cursor.databases).toHaveLength(1);
    expect(d.cursor.transcripts).toHaveLength(2);
  });

  it('reads cleanupPeriodDays, and uses 30 when it is not set', async () => {
    const home = await fixtureHome();
    expect(discover({ root: home }).claude).toMatchObject({
      cleanupPeriodDays: 30,
      cleanupFromSettings: false,
    });
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ cleanupPeriodDays: 90 }),
    );
    expect(discover({ root: home }).claude).toMatchObject({
      cleanupPeriodDays: 90,
      cleanupFromSettings: true,
    });
  });

  it('never follows a symlink out of a tool folder', async () => {
    const home = await fixtureHome();
    const outside = mkdtempSync(join(tmpdir(), 'agentgpa-outside-'));
    writeFileSync(join(outside, 'stolen.jsonl'), '{}\n');
    const project = join(home, '.claude', 'projects', '-home-dev-link');
    mkdirSync(project, { recursive: true });
    symlinkSync(
      join(outside, 'stolen.jsonl'),
      join(project, '11111111-1111-4111-8111-111111111111.jsonl'),
    );
    symlinkSync(outside, join(home, '.claude', 'projects', '-home-dev-linked-dir'));
    expect(discover({ root: home }).claude.files.some((f) => f.path.includes('-link'))).toBe(false);
  });

  it('honors CLAUDE_CONFIG_DIR and CODEX_HOME, except under --root', async () => {
    const home = await fixtureHome();
    const env = { CLAUDE_CONFIG_DIR: join(home, 'nowhere'), CODEX_HOME: join(home, '.codex') };
    const withEnv = discover({ home, env, platform: 'linux' });
    expect(withEnv.claude.found).toBe(false);
    expect(withEnv.codex.files).toHaveLength(1);
    expect(withEnv.cursor.databases).toHaveLength(1);
    expect(discover({ root: home, env }).claude.found).toBe(true);
  });

  it('finds nothing in an empty home', () => {
    const d = discover({ root: mkdtempSync(join(tmpdir(), 'agentgpa-empty-')) });
    expect([d.claude.found, d.codex.found, d.cursor.found]).toEqual([false, false, false]);
  });
});
