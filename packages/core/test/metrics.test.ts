import { describe, expect, it } from 'vitest';
import {
  buildSkeleton,
  busyWindows,
  CALL_FLAGS,
  computeMetrics,
  type Metrics,
  PROMPT_FLAGS,
  REPLY_FLAGS,
  type Session,
} from '../src/index.ts';
import { at, call, END, interrupt, prompt, reply, session } from './build.ts';

const window = (
  observedDays: Partial<Record<'claude-code' | 'codex' | 'cursor', number>> = {},
) => ({
  end: END,
  days: 90,
  observedDays: { 'claude-code': 90, codex: 90, cursor: 90, ...observedDays },
});
const metrics = (sessions: Session[], tz = 'UTC', observed = {}) =>
  computeMetrics(buildSkeleton(sessions, window(observed)).skeleton, tz);

describe('the skeleton', () => {
  it('keeps no text, path or name', () => {
    const texts = ['refactor the billing module', 'thanks so much', 'You are absolutely right.'];
    const { skeleton } = buildSkeleton(
      [
        session(
          'claude-code',
          [
            prompt(at(1), texts[0] as string),
            prompt(at(1, 13), texts[1] as string),
            ...reply(at(1, 12, 1), texts[2] as string),
          ],
          { models: ['claude-opus-5-5'] },
        ),
      ],
      window(),
    );
    const json = JSON.stringify(skeleton);
    for (const t of texts) expect(json).not.toContain(t);
    expect(json).not.toContain('hash');
  });

  it('turns text into flag bits on the device', () => {
    const { skeleton } = buildSkeleton(
      [
        session('claude-code', [
          prompt(at(2, 9), 'WHY IS THIS STILL BROKEN AGAIN'),
          prompt(at(2, 9, 1), 'thanks, now fix utils.ts'),
          prompt(at(2, 9, 2), 'no, revert that'),
          prompt(at(2, 9, 3), 'no, revert that'),
          prompt(at(2, 9, 4), 'make a plan first'),
          prompt(at(2, 9, 5), 'read SPEC.md'),
          prompt(at(2, 9, 6), 'damn', { approx: true }),
          ...reply(at(2, 9, 7), "You're absolutely right, I apologize."),
        ]),
      ],
      window(),
    );
    const flags = skeleton.prompts.map((p) => p[3]);
    // "Why" opens a question.
    expect(flags[0]).toBe(PROMPT_FLAGS.caps | PROMPT_FLAGS.question);
    expect(flags[1]).toBe(PROMPT_FLAGS.thanks | PROMPT_FLAGS.codeRef);
    expect(flags[2]).toBe(PROMPT_FLAGS.correction);
    expect(flags[3]).toBe(PROMPT_FLAGS.correction | PROMPT_FLAGS.repeat);
    expect(flags[4]).toBe(PROMPT_FLAGS.plan);
    // A spec file is a code reference, and "spec" asks for a plan.
    expect(flags[5]).toBe(PROMPT_FLAGS.planFile | PROMPT_FLAGS.plan | PROMPT_FLAGS.codeRef);
    expect(flags[6]).toBe(PROMPT_FLAGS.swear | PROMPT_FLAGS.approx);
    expect(skeleton.replies[0]?.[7]).toBe(
      REPLY_FLAGS.text | REPLY_FLAGS.absolutelyRight | REPLY_FLAGS.sycophancy | REPLY_FLAGS.apology,
    );
    expect(skeleton.replies[0]?.slice(3, 7)).toEqual([1000, 200, 0, 0]);
  });

  it('keeps device facts as counts, never the text they came from', () => {
    const text = 'run the whole test suite again';
    const { device } = buildSkeleton(
      [
        session('codex', [
          prompt(at(1, 9), text),
          prompt(at(1, 9, 30), text),
          prompt(at(1, 11), text),
          prompt(at(1, 12), 'ok'),
        ]),
      ],
      window(),
    );
    expect(device.mostRepeatedPrompt).toEqual({ count: 3 });
    expect(JSON.stringify(device)).not.toContain('suite');
  });

  it('leaves out events older than what each tool could record', () => {
    const sessions = [
      session('claude-code', [
        prompt(at(10), 'recent one'),
        prompt(at(60), 'from a session that survived cleanup'),
      ]),
      session('codex', [prompt(at(60), 'codex keeps everything')]),
    ];
    const { skeleton } = buildSkeleton(sessions, window({ 'claude-code': 30 }));
    expect(skeleton.prompts).toHaveLength(2);
    expect(skeleton.sessions.map((s) => s.tool)).toEqual(['claude-code', 'codex']);
  });
});

// Every metric gets an exact expectation; the last test fails when one has none.
const covered = new Set<string>();
function expectMetrics(actual: Metrics, expected: Partial<Metrics>): void {
  for (const [key, value] of Object.entries(expected)) {
    covered.add(key);
    expect(actual[key as keyof Metrics], key).toEqual(value);
  }
}
/** The series of a 90-day period, 91 local dates, with these values at these indexes (90 is the last). */
const series = (values: Record<number, number> = {}) =>
  Array.from({ length: 91 }, (_, i) => values[i] ?? 0);

describe('metrics', () => {
  it('counts prompts, replies, tools, interrupts and prompt lengths', () => {
    const m = metrics([
      session('claude-code', [
        prompt(at(1, 9), 'one two three four five six seven eight nine ten eleven twelve'),
        prompt(at(1, 10), 'short'),
        ...reply(at(1, 9, 1), 'ok'),
        call(at(1, 9, 2), 'Bash', 'Bash', { flags: CALL_FLAGS.gitCommit }),
        interrupt(at(1, 10, 1)),
      ]),
    ]);
    expectMetrics(m, {
      sessions: 1,
      userPrompts: 2,
      assistantMessages: 1,
      toolCalls: 1,
      interruptCount: 1,
      commitsViaAgent: 1,
      avgPromptWords: 6.5,
      shortPromptShare: 0.5,
      contextualPromptShare: 0.5,
    });
  });

  it('reads hours and weekdays in the machine time zone', () => {
    // 2027-03-30 22:30 UTC is 01:30 on Wednesday the 31st in Istanbul (UTC+3), and
    // Saturday 05:00 UTC is 08:00 there.
    const sessions = [
      session('claude-code', [
        prompt(Date.UTC(2027, 2, 30, 22, 30), 'late night idea'),
        prompt(Date.UTC(2027, 2, 27, 5), 'saturday morning'),
      ]),
    ];
    const utc = metrics(sessions, 'UTC');
    expect([utc.nightShare, utc.earlyShare]).toEqual([0, 0.5]);
    const istanbul = metrics(sessions, 'Europe/Istanbul');
    expectMetrics(istanbul, { nightShare: 0.5, earlyShare: 0.5, weekendShare: 0.5 });
    expect(istanbul.hourly[1]).toBe(1);
  });

  it('finds activity blocks, runs, marathons and parallel sessions', () => {
    const long = Array.from({ length: 40 }, (_, i) =>
      prompt(at(3, 8) + i * 10 * 60_000, `step ${i}`),
    );
    const m = metrics([
      session('claude-code', long),
      session('codex', [prompt(at(3, 9), 'side quest'), prompt(at(3, 9, 5), 'more')]),
      session('cursor', [prompt(at(3, 9, 2), 'third')]),
    ]);
    expectMetrics(m, { longestRunMinutes: 391, marathonCount: 1, maxParallelSessions: 3 });
    expect(m.longestStreakDays).toBe(1);
  });

  it('counts agents at once: sessions each with a prompt and 3 tool calls in one 15-minute window', () => {
    const working = (tool: 'claude-code' | 'codex' | 'cursor', start: number, calls = 3) =>
      session(tool, [
        prompt(start, 'go'),
        ...Array.from({ length: calls }, (_, i) => call(start + (i + 1) * 60_000, 'Read', 'Read')),
      ]);
    const m = metrics([
      working('claude-code', at(2, 10)),
      // Ten minutes later: one window of 15 holds both.
      working('codex', at(2, 10, 10)),
      // Half an hour later: no window holds it with the first two.
      working('claude-code', at(2, 10, 30)),
      // Open at the same time, but only a prompt, or only two tool calls: not working.
      session('cursor', [prompt(at(2, 10, 5), 'just asking')]),
      working('codex', at(2, 10, 6), 2),
    ]);
    expectMetrics(m, { agentsAtOnce: 2 });
    // Their activity blocks never overlap, so the raw peak sees one session at a time.
    expect(m.maxParallelSessions).toBe(1);
  });

  it('finds the minutes from which one session is busy', () => {
    const calls = (...minutes: number[]) => minutes.map((minute) => ({ minute, count: 1 }));
    // A prompt at 100 and calls at 101 to 103: windows from 89 to 100 hold all four.
    expect(busyWindows([100], calls(101, 102, 103))).toEqual([[89, 101]]);
    // A merged row counts for every call it stands for.
    expect(busyWindows([100], [{ minute: 104, count: 3 }])).toEqual([[90, 101]]);
    expect(busyWindows([100], calls(101, 102))).toEqual([]);
    expect(busyWindows([], calls(1, 2, 3))).toEqual([]);
    // Two busy stretches an hour apart stay two runs.
    expect(busyWindows([0, 60], calls(1, 2, 3, 61, 62, 63))).toEqual([
      [-11, 1],
      [49, 61],
    ]);
  });

  it('counts streaks, abandoned sessions and plan sessions per tool', () => {
    const m = metrics([
      ...[1, 2, 3, 5].map((d) => session('claude-code', [prompt(at(d), 'a quick question')])),
      session('codex', [
        prompt(at(4), 'make a plan for the import'),
        prompt(at(4, 12, 20), 'go on'),
        prompt(at(4, 12, 40), 'and test it'),
      ]),
      session(
        'claude-code',
        [prompt(at(6), 'x'), prompt(at(6, 12, 30), 'y'), prompt(at(6, 13), 'z')],
        { usedPlanMode: true },
      ),
    ]);
    expectMetrics(m, { longestStreakDays: 6, abandonedSessions: 4, planSessionShare: 1 });
    expect([m.perTool.codex?.planned, m.perTool['claude-code']?.planned]).toEqual([1, 1]);
  });

  it('estimates cost at list prices and flags models without one', () => {
    const m = metrics([
      session('claude-code', [
        prompt(at(1), 'go'),
        {
          kind: 'usage',
          ts: at(1, 12, 1),
          model: 'claude-opus-5-5',
          sidechain: true,
          input: 1_000_000,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        {
          kind: 'usage',
          ts: at(1, 12, 2),
          model: 'mystery-model',
          sidechain: false,
          input: 5,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
        },
      ]),
    ]);
    expectMetrics(m, { estimatedCostUsd: 4, unpricedCalls: 1 });
  });

  it('names the primary tool, or multi on an exact tie', () => {
    expectMetrics(
      metrics([
        session('codex', [prompt(at(1), 'a'), prompt(at(1, 13), 'b')]),
        session('cursor', [prompt(at(2), 'c')]),
      ]),
      { primaryTool: 'codex' },
    );
    expectMetrics(
      metrics([session('codex', [prompt(at(1), 'a')]), session('cursor', [prompt(at(2), 'c')])]),
      { primaryTool: 'multi' },
    );
  });

  it('scales counts per 30 observed days for each tool', () => {
    const marathon = (d: number) =>
      Array.from({ length: 38 }, (_, i) => prompt(at(d, 6) + i * 10 * 60_000, `m${i}`));
    const m = metrics([session('claude-code', marathon(2)), session('codex', marathon(3))], 'UTC', {
      'claude-code': 30,
    });
    expect(m.per30.marathons).toBeCloseTo(1 + 1 / 3);
  });

  it('keeps prompts with only an approximate time out of time-of-day metrics', () => {
    const m = metrics([
      session('cursor', [prompt(at(1, 2), 'when?', { approx: true }), prompt(at(1, 14), 'now')]),
    ]);
    expect([m.nightShare, m.userPrompts]).toEqual([0, 2]);
    expectMetrics(m, { hourly: Array.from({ length: 24 }, (_, h) => (h === 14 ? 1 : 0)) });
  });

  it('counts tone, agent replies, shipping, models and every series by day', () => {
    // A Tuesday morning with Claude Code and a Sunday afternoon with Codex.
    const m = metrics([
      session('claude-code', [
        prompt(at(1, 9), 'thanks, please refactor the parser module now'),
        ...reply(at(1, 9, 1), "You're absolutely right, I apologize."),
        prompt(at(1, 9, 2), 'WHY IS THIS STILL SO BROKEN'),
        prompt(at(1, 9, 3), 'damn it, try again'),
        prompt(at(1, 9, 4), 'no, revert that'),
        prompt(at(1, 9, 5), 'no, revert that'),
        ...reply(at(1, 9, 6), 'Great question.'),
        call(at(1, 9, 7), 'Task', 'Task', { sidechain: true }),
        call(at(1, 9, 8), 'Bash', 'Bash', { flags: CALL_FLAGS.prCreate }),
        call(at(1, 9, 9), 'Edit', 'Edit', { linesAdded: 12, linesRemoved: 4 }),
      ]),
      session('codex', [
        prompt(at(3, 14), 'add a test for utils.ts'),
        ...reply(at(3, 14, 1), 'Done.', 'gpt-5.6-sol'),
        prompt(at(3, 14, 20), 'thanks'),
      ]),
    ]);
    // Opus 5.5 and GPT-5.6 Sol both cost $4 in and $20 out per million: 1,000 in and 200 out is $0.008.
    const reply$ = 0.008;
    expectMetrics(m, {
      subagentToolCalls: 1,
      activeDays: 2,
      activeMinutes: 13,
      busiestWeekday: 2,
      absolutelyRightCount: 1,
      sycophancyCount: 2,
      apologyCount: 1,
      thanksCount: 2,
      capsCrisisCount: 1,
      swearCount: 1,
      correctionCount: 2,
      rageRepeatCount: 1,
      medianBlockMinutes: 2,
      promptsPerActiveHour: 7 / (13 / 60),
      peakHour: 9,
      prsViaAgent: 1,
      linesWrittenByAgent: 12,
      linesRemovedByAgent: 4,
      thanksPer100: (2 / 7) * 100,
      days: 90,
      daily: {
        from: '2026-12-31',
        prompts: series({ 89: 5, 87: 2 }),
        thanks: series({ 89: 1, 87: 1 }),
        capsCrises: series({ 89: 1 }),
        nightPrompts: series(),
        absolutelyRight: series({ 89: 1 }),
        apologies: series({ 89: 1 }),
        assistantMessages: series({ 89: 2, 87: 1 }),
      },
      modelShares: [
        { model: 'claude-opus-5-5', share: 2 / 3 },
        { model: 'gpt-5.6-sol', share: 1 / 3 },
      ],
      perTool: {
        'claude-code': {
          sessions: 1,
          prompts: 5,
          activeDays: 1,
          observedDays: 90,
          planBase: 1,
          planned: 0,
          marathons: 0,
          capsCrises: 1,
          commits: 0,
          costUsd: expect.closeTo(2 * reply$, 10),
        },
        codex: {
          sessions: 1,
          prompts: 2,
          activeDays: 1,
          observedDays: 90,
          planBase: 0,
          planned: 0,
          marathons: 0,
          capsCrises: 0,
          commits: 0,
          costUsd: expect.closeTo(reply$, 10),
        },
      },
      per30: {
        marathons: 0,
        capsCrises: 1 / 3,
        commits: 0,
        costUsd: expect.closeTo((3 * reply$) / 3, 10),
      },
    });
  });

  it('counts the partial first day of the period in the series', () => {
    // The 90-day period starts on 2026-12-31 at 12:00 UTC, at 15:00 in Istanbul.
    const m = metrics(
      [
        session('codex', [
          prompt(Date.UTC(2026, 11, 31, 13), 'first day'),
          prompt(at(0, 11), 'last day'),
        ]),
      ],
      'Europe/Istanbul',
    );
    expect(m.daily.from).toBe('2026-12-31');
    expect([m.daily.prompts.length, m.daily.prompts[0], m.daily.prompts.at(-1)]).toEqual([
      91, 1, 1,
    ]);
    expect(m.daily.prompts.reduce((a, b) => a + b, 0)).toBe(m.userPrompts);
  });

  it('has an exact expectation for every metric', () => {
    const missing = Object.keys(metrics([])).filter((key) => !covered.has(key));
    expect(missing).toEqual([]);
  });
});

describe('the prompt language', () => {
  it('comes from the detector the CLI passes, and is und without one or for a bad answer', () => {
    const sessions = [
      session('codex', [prompt(at(1), 'bitte den Parser umbauen und danach testen')]),
    ];
    const seen: string[] = [];
    const named = buildSkeleton(sessions, {
      ...window(),
      detectLanguage: (sample) => {
        seen.push(sample);
        return 'deu';
      },
    });
    expect(named.device.promptLanguage).toBe('deu');
    expect(seen).toEqual(['bitte den Parser umbauen und danach testen']);
    expect(JSON.stringify(named.device)).not.toContain('Parser');
    expect(buildSkeleton(sessions, window()).device.promptLanguage).toBe('und');
    expect(
      buildSkeleton(sessions, { ...window(), detectLanguage: () => '<b>' }).device.promptLanguage,
    ).toBe('und');
  });
});
