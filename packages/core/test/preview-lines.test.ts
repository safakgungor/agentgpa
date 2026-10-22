import { describe, expect, it } from 'vitest';
import {
  buildReport,
  type DeviceFacts,
  type Metrics,
  PREVIEW_LINES,
  pickPreviewLines,
  type Signals,
} from '../src/index.ts';
import { END } from './build.ts';

const base = buildReport([], {
  end: END,
  days: 90,
  observedDays: {},
  timeZone: 'UTC',
  seed: 'base',
});
const context = (
  metrics: Partial<Metrics> = {},
  signals: Partial<Signals> = {},
  device: Partial<DeviceFacts> = {},
) => ({
  metrics: { ...base.metrics, ...metrics },
  signals: { ...base.signals, ...signals },
  device: { ...base.device, ...device },
});

// Big numbers everywhere, so every line applies and its longest text shows.
const maxed = context(
  {
    userPrompts: 99_999,
    assistantMessages: 99_999,
    absolutelyRightCount: 12_345,
    sycophancyCount: 23_456,
    apologyCount: 3456,
    swearCount: 999,
    capsCrisisCount: 999,
    thanksCount: 9999,
    longestRunMinutes: 1439,
    marathonCount: 99,
    longestStreakDays: 90,
    nightShare: 0.99,
    earlyShare: 0.9,
    hourly: new Array(24).fill(9999),
    weekendShare: 0.9,
    interruptCount: 9999,
    correctionCount: 9999,
    maxParallelSessions: 99,
    agentsAtOnce: 99,
    avgPromptWords: 999,
    shortPromptShare: 1,
    perTool: { 'claude-code': { ...emptyStats(), planned: 9999 } },
    commitsViaAgent: 9999,
    linesWrittenByAgent: 9_999_999,
    toolCalls: 999_999,
    activeMinutes: 99_999,
    estimatedCostUsd: 99_999,
    modelShares: [{ model: 'claude-opus-5-5-20270101', share: 1 }],
  },
  { threeAmPrompts: 999 },
  { mostRepeatedPrompt: { count: 999 } },
);

function emptyStats() {
  return {
    sessions: 0,
    prompts: 0,
    activeDays: 0,
    observedDays: 90,
    planBase: 0,
    planned: 0,
    marathons: 0,
    capsCrises: 0,
    commits: 0,
    costUsd: 0,
  };
}

const seeds = Array.from({ length: 300 }, (_, i) => `install-${i}`);

describe('preview lines', () => {
  it('pick at most one roast and never two lines of one family', () => {
    for (const seed of seeds) {
      const lines = pickPreviewLines(maxed, seed);
      expect(lines).toHaveLength(3);
      expect(lines.filter((l) => l.tone === 'roast').length).toBeLessThanOrEqual(1);
      const families = lines.map((l) => PREVIEW_LINES.find((x) => x.id === l.id)?.family);
      expect(new Set(families).size).toBe(3);
    }
  });

  it('fill up with plain facts when fewer than three lines apply', () => {
    const lines = pickPreviewLines(
      context({ userPrompts: 12, activeDays: 1, toolCalls: 3, sessions: 1 }),
      'seed',
    );
    expect(lines.map((l) => l.text)).toEqual([
      '12 prompts over 1 active day.',
      '3 tool calls by your agent.',
      '1 session with your agent.',
    ]);
  });

  it('are the same for the same seed, and the seed only nudges close calls', () => {
    expect(pickPreviewLines(maxed, 'a')).toEqual(pickPreviewLines(maxed, 'a'));
    // A line ten times stronger always leads; two lines of the same strength trade places by seed.
    const strong = context({ thanksCount: 50, commitsViaAgent: 5, longestStreakDays: 5 });
    for (const seed of seeds.slice(0, 50))
      expect(pickPreviewLines(strong, seed)[0]?.id).toBe('thanks');
    const close = context({ commitsViaAgent: 5, longestStreakDays: 5, interruptCount: 10 });
    const leaders = new Set(seeds.map((seed) => pickPreviewLines(close, seed)[0]?.id));
    expect(leaders.size).toBeGreaterThan(1);
  });

  it('follow the copy rules and fit the 80-column card', () => {
    const emDash = String.fromCodePoint(0x2014);
    // "Agreeable" only speaks when "absolutely right" stays quiet.
    const agreeable = { ...maxed, metrics: { ...maxed.metrics, absolutelyRightCount: 0 } };
    for (const line of PREVIEW_LINES) {
      const c = line.id === 'agreeable' ? agreeable : maxed;
      expect(line.strength(c), line.id).toBeGreaterThanOrEqual(1);
      const text = line.text(c);
      // The card row leaves 74 columns after its border and bullet.
      expect(text.length, line.id).toBeLessThanOrEqual(74);
      expect(text, line.id).not.toContain(emDash);
      expect(text, line.id).not.toMatch(/students?\b|developers?\b|percentile|top \d+%/i);
    }
  });

  it('only praise a clean desk with enough prompts to mean it', () => {
    const clean = PREVIEW_LINES.find((l) => l.id === 'clean-desk');
    expect(clean?.strength(context({ userPrompts: 49 }))).toBe(0);
    expect(clean?.strength(context({ userPrompts: 50 }))).toBe(1);
    const leaked = { ...base.device.secrets, pasted: 1 };
    expect(clean?.strength(context({ userPrompts: 500 }, {}, { secrets: leaked }))).toBe(0);
  });
});
