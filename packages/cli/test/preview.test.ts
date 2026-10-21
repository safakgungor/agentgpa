import { buildReport, type Report, type Session } from '@agentgpa/core';
import { describe, expect, it } from 'vitest';
import { at, END, prompt, session } from '../../core/test/build.ts';
import { detectStyle, renderPreview, type Style, WIDTH } from '../src/preview.ts';

const ESC = String.fromCharCode(0x1b);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const strip = (text: string) => text.replace(ANSI, '');

const plain: Style = { color: false, truecolor: false };
const basic: Style = { color: true, truecolor: false };
const truecolor: Style = { color: true, truecolor: true };

// A fake AWS key, built here so no key-shaped string sits in the source.
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const fakeKey = [
  'AK',
  'IA',
  ...Array.from({ length: 16 }, (_, i) => BASE32[(i * 7 + 3) % 32]),
].join('');

const week = (tool: 'claude-code' | 'codex', extra: string[] = []): Session[] =>
  Array.from({ length: 6 }, (_, d) =>
    session(tool, [
      ...[
        'refactor the parser module and run all of the tests',
        'no, keep the old api for now',
        'add a test for the date parser in utils.ts',
        'run it',
      ].map((t, i) => prompt(at(d + 1, 10, i * 6), t)),
      ...(d === 0 ? extra.map((t, i) => prompt(at(1, 11, i), t)) : []),
    ]),
  );

const report = (sessions: Session[]): Report =>
  buildReport(sessions, {
    end: END,
    days: 90,
    observedDays: { 'claude-code': 30, codex: 90, cursor: 90 },
    timeZone: 'UTC',
    seed: 'preview',
  });

const graded = report([...week('claude-code'), ...week('codex')]);
const detention = report(week('codex', [`deploy with ${fakeKey} please`]));
const incomplete = report([
  session('codex', [prompt(at(1, 10), 'hello there'), prompt(at(1, 10, 5), 'add a readme')]),
]);
const empty = report([]);

const tools = [
  { tool: 'claude-code' as const, found: true, readable: true },
  { tool: 'codex' as const, found: true, readable: true },
  { tool: 'cursor' as const, found: false, readable: false },
];
const render = (r: Report, style: Style, details = false) =>
  renderPreview(r, { style, tools, scanMs: 1234, days: 90, claudeCleanupDays: 30, details });

describe('the terminal report card', () => {
  it('never goes past 80 columns, with or without color', () => {
    for (const r of [graded, detention, incomplete, empty]) {
      for (const style of [plain, basic, truecolor]) {
        const lines = strip(render(r, style, true)).split('\n');
        for (const line of lines) expect(line.length, line).toBeLessThanOrEqual(WIDTH);
        // Box rows are exactly as wide as the card.
        for (const line of lines.filter((l) => /^[│╭├╰]/.test(l)))
          expect(line.length, line).toBe(WIDTH);
      }
    }
  });

  it('prints no escape codes without color, and marks the GPA and low grades with brackets', () => {
    const out = render(graded, plain);
    expect(out).not.toContain(ESC);
    expect(out).toContain(`GPA [${graded.grades.gpa?.toFixed(2)}] / 4.00`);
    expect(out).toContain('AGENTGPA · REPORT CARD · SPRING');
    const low = Object.values(graded.grades.courses).filter(
      (c) => c.letter === 'D' || c.letter === 'F',
    );
    expect(low.length).toBeGreaterThan(0);
    for (const c of low) expect(out).toContain(`[${c.letter}]`);
    expect(out).toContain('Read 12 sessions and 48 prompts from the last 90 days   1.2 s');
    expect(out).toContain('Claude Code ✓   Codex ✓   Cursor not found');
  });

  it("paints with the archetype's highlighter in truecolor, and bright yellow on 16 colors", () => {
    const hex = graded.archetype.highlighter.replace('#', '');
    const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
    expect(render(graded, truecolor)).toContain(`38;2;${r};${g};${b}`);
    expect(render(graded, basic)).toContain(`${ESC}[93m`);
    expect(render(graded, basic)).not.toContain('38;2;');
  });

  it('shows the tool shares and how many days Claude Code kept', () => {
    const out = render(graded, plain);
    expect(out).toContain('Claude Code 50% · Codex 50% · Claude Code kept 30 of the 90 days');
    expect(out).toContain('Nothing has left this machine.');
  });

  it('puts a leak on detention, and shows the fix only with --details', () => {
    const out = render(detention, plain);
    expect(out).toContain('DETENTION:  1 secret reached your agent. --details shows the fix.');
    expect(out).not.toContain('Detention details');
    const details = render(detention, plain, true);
    expect(details).toContain(
      'Detention details (only you see these, and they never leave this machine):',
    );
    expect(details).toContain('1 AWS key.');
    expect(details).toContain('1 pasted into prompts, 0 read by your agent from files or tools.');
    expect(details).not.toContain(fakeKey.slice(4));
    const many = {
      ...detention,
      device: {
        ...detention.device,
        secrets: {
          ...detention.device.secrets,
          types: {
            aws: 12,
            github: 3,
            openai: 4,
            anthropic: 5,
            stripe: 6,
            gcp: 7,
            slack: 8,
            private_key: 9,
            jwt: 10,
            db_url: 11,
            other_provider: 2,
          },
        },
      },
    };
    for (const line of strip(render(many, plain, true)).split('\n'))
      expect(line.length, line).toBeLessThanOrEqual(WIDTH);
    expect(render(graded, plain, true)).not.toContain('Detention details');
  });

  it('says Incomplete instead of a GPA', () => {
    const out = render(incomplete, plain);
    expect(out).toContain('GPA [I] INCOMPLETE');
    expect(out).toContain('Incomplete: come back after more classes.');
  });

  it('prints no card when there is nothing to grade', () => {
    const out = render(empty, plain);
    expect(out).not.toContain('REPORT CARD');
    expect(out).toContain('No prompts in the last 90 days, so there is nothing to grade yet.');
    const none = renderPreview(empty, {
      style: plain,
      tools: tools.map((t) => ({ ...t, found: false, readable: false })),
      scanMs: 5,
      days: 90,
      claudeCleanupDays: 30,
    });
    expect(none).toContain(
      'No Claude Code, Codex or Cursor sessions on this machine, so nothing to grade.',
    );
  });
});

describe('color detection', () => {
  it('follows NO_COLOR, FORCE_COLOR, TERM and COLORTERM', () => {
    expect(detectStyle({}, true)).toEqual(basic);
    expect(detectStyle({}, false)).toEqual(plain);
    expect(detectStyle({ COLORTERM: 'truecolor' }, true)).toEqual(truecolor);
    expect(detectStyle({ COLORTERM: '24bit' }, true)).toEqual(truecolor);
    expect(detectStyle({ NO_COLOR: '1', COLORTERM: 'truecolor' }, true)).toEqual(plain);
    expect(detectStyle({ NO_COLOR: '' }, true)).toEqual(basic);
    expect(detectStyle({ TERM: 'dumb' }, true)).toEqual(plain);
    expect(detectStyle({ FORCE_COLOR: '1' }, false)).toEqual(basic);
    expect(detectStyle({ FORCE_COLOR: '0' }, true)).toEqual(plain);
  });
});
