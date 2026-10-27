import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PayloadSchema } from '@agentgpa/core';
import { describe, expect, it } from 'vitest';
import { parseClaude, parseCodex, parseCursor } from '../../core/test/fixtures.ts';
import { runScan } from '../src/run.ts';
import { fixtureHome } from './home.ts';

// The fixture home ends in 2027 (times are moved forward by 52 weeks).
const NOW = Date.UTC(2027, 11, 1);
const SCRATCH = mkdtempSync(join(tmpdir(), 'agentgpa-scan-'));
const CONFIG = join(SCRATCH, 'config');

async function run(args: Parameters<typeof runScan>[0]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runScan(args, {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    now: NOW,
    env: { AGENTGPA_CONFIG_DIR: CONFIG },
    cwd: SCRATCH,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('agentgpa --dry-run --debug', () => {
  it('reports sessions and prompts per tool for the fixture home', async () => {
    const root = await fixtureHome();
    const { code, out } = await run({ dryRun: true, debug: true, root });
    expect(code).toBe(0);
    expect(out).toContain('claude-code: found');
    expect(out).toMatch(/files: main 6, subagent 3, workflow-agent 1/);
    expect(out).toMatch(
      /all on disk: 6 sessions, 18 prompts \(3 queued, 0 with approximate time\)/,
    );
    expect(out).toMatch(/2 interrupts, 1 compactions, 1 sessions with plan mode/);
    expect(out).toMatch(/codex: found[\s\S]*all on disk: 1 sessions, 3 prompts/);
    expect(out).toMatch(
      /cursor: found[\s\S]*all on disk: 2 sessions, 9 prompts \(0 queued, 4 with approximate time\)/,
    );
    expect(out).toContain(
      "file checks: 0 sessions left out of the report, 0 more outside the period; agent's own session skipped: 0",
    );
    expect(out).toContain('Nothing was sent.');
  });

  it('prints no text from the sessions', async () => {
    const root = await fixtureHome();
    const { out } = await run({ debug: true, offline: true, root });
    const texts = [parseClaude(), parseCodex(), parseCursor()]
      .flatMap((r) => r.sessions.flatMap((s) => s.events))
      .flatMap((e) => (e.kind === 'user_prompt' || e.kind === 'assistant_text' ? [e.text] : []))
      .map((t) => t.replace(/\s+/g, ' ').trim())
      .filter((t) => t.length >= 12);
    expect(texts.length).toBeGreaterThan(50);
    expect(texts.filter((t) => out.includes(t.slice(0, 12)))).toEqual([]);
  });

  it('reads only the tools asked for, and checks its flags', async () => {
    const root = await fixtureHome();
    const { out } = await run({ debug: true, offline: true, root, tools: 'codex' });
    expect(out).toContain('codex: found');
    expect(out).not.toContain('claude-code');
    expect((await run({ root, since: '45d' })).code).toBe(2);
    expect((await run({ root, tools: 'claude-code,vim' })).code).toBe(2);
  });

  it('filters the period by event time', async () => {
    const root = await fixtureHome();
    const { out } = await run({
      debug: true,
      offline: true,
      root,
      since: '7d',
      tools: 'claude-code',
    });
    expect(out).toMatch(/last 7 days: 0 sessions/);
  });
});

describe('agentgpa --dry-run', () => {
  it('writes the payload file (0600, no run token) and sends nothing', async () => {
    const root = await fixtureHome();
    const out: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), 'agentgpa-dry-'));
    const code = await runScan(
      { dryRun: true, root, since: '90d' },
      {
        out: (t) => out.push(t),
        err: (t) => out.push(t),
        now: Date.UTC(2027, 9, 20),
        env: { AGENTGPA_CONFIG_DIR: CONFIG },
        cwd: dir,
      },
    );
    expect(code).toBe(0);
    const path = join(dir, 'agentgpa-payload.json');
    expect(existsSync(path)).toBe(true);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    const payload = PayloadSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    expect(payload.runToken).toBeUndefined();
    expect(payload.consents).toEqual({ researchAggregates: false, deepRead: false });
    expect(payload.client.root).toBe('custom');
    expect(out.join('\n')).toMatch(/Dry run: wrote agentgpa-payload.json \(\d+ KB gzipped/);
  });

  it('replaces a file or link planted at its name, and never writes through the link', async () => {
    if (process.platform === 'win32') return;
    const root = await fixtureHome();
    const dir = mkdtempSync(join(tmpdir(), 'agentgpa-dry-'));
    const target = join(dir, 'elsewhere.txt');
    writeFileSync(target, 'keep me', { mode: 0o644 });
    symlinkSync(target, join(dir, 'agentgpa-payload.json'));
    const code = await runScan(
      { dryRun: true, root, since: '90d' },
      {
        out: () => {},
        err: () => {},
        now: Date.UTC(2027, 9, 20),
        env: { AGENTGPA_CONFIG_DIR: CONFIG },
        cwd: dir,
      },
    );
    expect(code).toBe(0);
    const path = join(dir, 'agentgpa-payload.json');
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(target, 'utf8')).toBe('keep me');
    expect(statSync(target).mode & 0o777).toBe(0o644);
    expect(readdirSync(dir).sort()).toEqual(['agentgpa-payload.json', 'elsewhere.txt']);
  });

  it("says when it read the tools' default locations, without naming any folder", async () => {
    const home = await fixtureHome();
    const dir = mkdtempSync(join(tmpdir(), 'agentgpa-dry-'));
    const code = await runScan(
      { dryRun: true, since: '90d' },
      {
        out: () => {},
        err: () => {},
        now: Date.UTC(2027, 9, 20),
        env: { AGENTGPA_CONFIG_DIR: CONFIG },
        home,
        cwd: dir,
      },
    );
    expect(code).toBe(0);
    const text = readFileSync(join(dir, 'agentgpa-payload.json'), 'utf8');
    expect(PayloadSchema.parse(JSON.parse(text)).client.root).toBe('default');
    expect(text).not.toContain(home);
  });
});
