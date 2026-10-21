import { describe, expect, it } from 'vitest';
import {
  buildPacket,
  HOME_FOLDER,
  LANG_CATEGORIES,
  leadingZeroBits,
  PacketSchema,
  PRIVATE_FOLDER,
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

  it('passes the secret corpus with zero leaks, and names a project only in its own list', () => {
    const sessions = leakyPrompts().map((text, i) =>
      session(
        i % 2 ? 'codex' : 'claude-code',
        [
          prompt(
            at(1 + (i % 80), 10),
            `${text} in acme-billing at /Users/someone/work/secret-project`,
          ),
        ],
        { projectName: 'acme-billing' },
      ),
    );
    const packet = packetOf(sessions);
    expect(packet.projects).toEqual(['acme-billing']);
    const json = JSON.stringify({ ...packet, projects: [] });
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
        day: 88,
      },
    ]);
  });

  it("names each session's project by its folder alone, never the account or a path", () => {
    const p = packetOf(
      [
        session('claude-code', [prompt(at(3, 9), 'add the refund endpoint to checkout')], {
          projectName: 'checkout-service',
          projectKey: 'k-checkout',
        }),
        session('codex', [prompt(at(2, 9), 'fix the flaky checkout test please')], {
          projectName: 'checkout-service',
          projectKey: 'k-checkout-copy',
        }),
        session('claude-code', [prompt(at(2, 10), 'tidy my shell aliases please now')], {
          projectName: 'dev',
          projectKey: 'k-home',
        }),
        session('codex', [prompt(at(2, 11), 'rename the config keys for me')], {
          projectName: 'someone',
          projectKey: 'k-someone',
        }),
        session('codex', [prompt(at(1, 9), 'write the onboarding email copy')], {
          projectName: 'dev@example.com',
          projectKey: 'k-mail',
        }),
        session('claude-code', [prompt(at(1, 10), 'clean up the landing page styles')], {
          projectName: ' my\u200bsite\u202e ',
          projectKey: 'k-site',
        }),
        session('cursor', [prompt(at(1, 11), 'make the header sticky on scroll')]),
      ],
      { homeProjectKey: 'k-home' },
    );
    expect(p.projects).toEqual(['checkout-service', HOME_FOLDER, PRIVATE_FOLDER, 'mysite']);
    expect(p.sessions.map((s) => s.project)).toEqual([0, 0, 1, 2, 2, 3, undefined]);
    expect(p.sessions.map((s) => s.day)).toEqual([86, 87, 87, 87, 88, 88, 88]);
    expect(JSON.stringify(p)).not.toMatch(/someone|example\.com|\//);
    const long = packetOf([
      session('codex', [prompt(at(1), 'add the importer and its tests')], {
        projectName: `${'z'.repeat(59)}🙂`,
      }),
    ]);
    expect(long.projects).toEqual(['z'.repeat(59)]);
  });

  it("leaves out the agent's own session and refuses any field it does not list", () => {
    const p = packetOf(
      [session('codex', [prompt(at(1), 'run npx -y agentgpa --agent --code K7Q3-PX9M please')])],
      { skipSessionsWith: 'K7Q3-PX9M' },
    );
    expect(p.prompts).toEqual([]);
    expect(() => PacketSchema.parse({ ...p, paths: [] })).toThrow();
    const named = packetOf([
      session('codex', [prompt(at(1), 'add the importer and its tests')], { projectName: 'api' }),
    ]);
    const past = { ...named, sessions: named.sessions.map((s) => ({ ...s, project: 1 })) };
    expect(() => PacketSchema.parse(past)).toThrow();
    expect(() =>
      PacketSchema.parse({ ...named, prompts: [{ session: 3, week: 0, text: 'x y z' }] }),
    ).toThrow();
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
