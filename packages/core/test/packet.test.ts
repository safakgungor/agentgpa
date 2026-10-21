import { describe, expect, it } from 'vitest';
import {
  buildPacket,
  LANG_CATEGORIES,
  leadingZeroBits,
  PacketSchema,
  type Session,
  TOOL_FLAGS,
} from '../src/index.ts';
import { at, call, END, prompt, session } from './build.ts';
import { fragments, leakyPrompts, secretCorpus } from './corpus.ts';

const context = {
  projects: ['acme-billing', 'secret-project'],
  names: ['someone'],
  home: '/Users/someone',
};
const options = {
  end: END,
  days: 90,
  observedDays: { 'claude-code': 90, codex: 90, cursor: 90 },
  promptLanguage: 'eng',
  context,
  seed: 'packet',
};
const packetOf = (sessions: Session[], extra = {}) =>
  buildPacket(sessions, { ...options, ...extra });

describe('the deep read packet', () => {
  it('keeps only typed prompts: no code, pasted errors, long blobs or one-word nudges', () => {
    const p = packetOf([
      session('claude-code', [
        prompt(at(1, 9), 'please make the parser handle leap years'),
        prompt(at(1, 9, 1), 'use this:\n```\nconst a = 1;\n```'),
        prompt(at(1, 9, 2), 'look:\nTypeError: x is undefined\n    at run (index.js:12:5)'),
        prompt(at(1, 9, 3), 'word '.repeat(600)),
        prompt(at(1, 9, 4), 'ok'),
        prompt(at(1, 9, 5), 'damn, the date tests broke again'),
      ]),
    ]);
    expect(p.prompts.map((x) => x.text).sort()).toEqual([
      '[[bar:4]], the date tests broke again',
      'please make the parser handle leap years',
    ]);
  });

  it('passes the secret corpus and the project names with zero leaks', () => {
    const sessions = leakyPrompts().map((text, i) =>
      session(i % 2 ? 'codex' : 'claude-code', [
        prompt(
          at(1 + (i % 80), 10),
          `${text} in acme-billing at /Users/someone/work/secret-project`,
        ),
      ]),
    );
    const json = JSON.stringify(packetOf(sessions));
    for (const secret of secretCorpus()) {
      for (const piece of fragments(secret)) expect(json, secret.slice(0, 6)).not.toContain(piece);
    }
    expect(json).not.toMatch(/acme-billing|secret-project|someone|\/Users\//);
    expect(json).toContain('[project]');
  });

  it('samples at most 600 prompts, spread across tools and weeks, and cuts each to 280', () => {
    const sessions: Session[] = [];
    for (const tool of ['claude-code', 'codex'] as const) {
      for (let week = 0; week < 10; week++) {
        sessions.push(
          session(
            tool,
            Array.from({ length: 100 }, (_, i) =>
              prompt(
                at(2 + week * 7, 9, i % 60) + i * 1000,
                `refactor step ${i} of the importer ${'please '.repeat(i % 50)}`,
              ),
            ),
          ),
        );
      }
    }
    const p = packetOf(sessions);
    expect(p.prompts).toHaveLength(600);
    const perBucket = new Map<string, number>();
    for (const x of p.prompts) {
      const key = `${p.sessions[x.session]?.tool}|${x.week}`;
      perBucket.set(key, (perBucket.get(key) ?? 0) + 1);
    }
    expect(perBucket.size).toBe(20);
    expect(Math.max(...perBucket.values()) - Math.min(...perBucket.values())).toBeLessThanOrEqual(
      1,
    );
    expect(Math.max(...p.prompts.map((x) => x.text.length))).toBeLessThanOrEqual(280);
    expect(packetOf(sessions)).toEqual(p);
  });

  it('describes each session without text: tool, length, calls, languages and commands', () => {
    const p = packetOf([
      session('codex', [
        prompt(at(1, 9), 'add the importer and its tests'),
        call(at(1, 9, 5), 'apply_patch', 'Edit', { langCat: LANG_CATEGORIES.indexOf('rust') }),
        call(at(1, 9, 10), 'exec_command', 'Bash', { flags: TOOL_FLAGS.test }),
        call(at(1, 9, 20), 'exec_command', 'Bash', { flags: TOOL_FLAGS.gitCommit }),
        prompt(at(1, 10, 30), 'ship it then'),
      ]),
    ]);
    expect(p.sessions).toEqual([
      {
        tool: 'codex',
        duration: 'under-3-hours',
        prompts: 2,
        categories: { Edit: 1, Bash: 2 },
        languages: { rust: 1 },
        commands: { test: 1, build: 0, git: 1, deploy: 0 },
      },
    ]);
  });

  it("leaves out the agent's own session and refuses any field it does not list", () => {
    const p = packetOf(
      [session('codex', [prompt(at(1), 'run npx -y agentgpa --agent --code K7Q3-PX9M please')])],
      { skipSessionsWith: 'K7Q3-PX9M' },
    );
    expect(p.prompts).toEqual([]);
    expect(() => PacketSchema.parse({ ...p, paths: [] })).toThrow();
  });
});

describe('proof of work', () => {
  it('counts the leading zero bits of a digest', () => {
    expect(leadingZeroBits(Uint8Array.from([0, 0, 0x0f]))).toBe(20);
    expect(leadingZeroBits(Uint8Array.from([0x80]))).toBe(0);
    expect(leadingZeroBits(Uint8Array.from([0x01, 0xff]))).toBe(7);
    expect(leadingZeroBits(Uint8Array.from([0, 0]))).toBe(16);
  });
});
