import { describe, expect, it } from 'vitest';
import { buildReport, COURSES, LETTERS, type Report } from '../src/index.ts';
import { parseClaude, parseCodex, parseCursor } from './fixtures.ts';

// The whole report from the fixture home: what the CLI builds and the server rebuilds.

const results = [parseClaude(), parseCodex(), parseCursor()];
const sessions = results.flatMap((r) => r.sessions);
// The fixture sessions span months, so the period stretches to hold them all.
const times = sessions.flatMap((s) => s.events.map((e) => e.ts));
const end = Math.max(...times) + 60_000;
const days = Math.ceil((end - Math.min(...times)) / 86_400_000) + 1;
const options = {
  end,
  days,
  observedDays: { 'claude-code': days, codex: days, cursor: days },
  timeZone: 'Europe/Istanbul',
  seed: 'fixture',
};
const report: Report = buildReport(sessions, options);

describe('a report from the fixture home', () => {
  it('reads every tool', () => {
    expect(Object.keys(report.metrics.perTool).sort()).toEqual(['claude-code', 'codex', 'cursor']);
  });

  it('is the same every time for the same sessions', () => {
    const again = buildReport(sessions, options);
    expect(JSON.stringify(again)).toBe(JSON.stringify(report));
  });

  it('keeps every text and project key out of what can leave the device', () => {
    const texts = sessions
      .flatMap((s) => s.events)
      .flatMap((e) =>
        e.kind === 'user_prompt' || e.kind === 'assistant_text'
          ? [e.text.replace(/\s+/g, ' ').trim()]
          : [],
      )
      .filter((t) => t.length >= 12);
    expect(texts.length).toBeGreaterThan(50);
    const out = JSON.stringify({ ...report, previewLines: undefined });
    expect(texts.filter((t) => out.includes(t.slice(0, 12)))).toEqual([]);
    expect(JSON.stringify(report.skeleton)).not.toContain('hash:');
  });

  it('adds up: per-tool counts make the totals', () => {
    const tools = Object.values(report.metrics.perTool);
    expect(tools.reduce((n, t) => n + (t?.prompts ?? 0), 0)).toBe(report.metrics.userPrompts);
    expect(tools.reduce((n, t) => n + (t?.sessions ?? 0), 0)).toBe(report.metrics.sessions);
    expect(report.skeleton.prompts).toHaveLength(report.metrics.userPrompts);
    expect(report.metrics.daily.prompts.reduce((a, b) => a + b, 0)).toBe(
      report.metrics.userPrompts,
    );
  });

  it('grades every course on the scale', () => {
    const letters = LETTERS.map((l) => l.letter);
    for (const id of COURSES) {
      const c = report.grades.courses[id];
      expect(c.score).toBeGreaterThanOrEqual(0);
      expect(c.score).toBeLessThanOrEqual(100);
      expect(letters).toContain(c.letter);
    }
    expect(report.previewLines).toHaveLength(3);
    expect(report.activities.length).toBeLessThanOrEqual(3);
  });
});
