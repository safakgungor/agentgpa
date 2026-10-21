import { describe, expect, it } from 'vitest';
import {
  buildSkeleton,
  CALL_FLAGS,
  computeMetrics,
  computeSignals,
  type Event,
  LANG_CATEGORIES,
  type Session,
  type Signals,
  TOOL_FLAGS,
} from '../src/index.ts';
import { at, call, END, prompt, reply, session } from './build.ts';

// Every signal gets an exact expectation; the last test fails when one has none. Dates: the
// period ends on Wednesday 2027-03-31, so at(1) is a Tuesday and at(5) a Friday.

const covered = new Set<string>();
function expectSignals(actual: Signals, expected: Partial<Signals>): void {
  for (const [key, value] of Object.entries(expected)) {
    covered.add(key);
    expect(actual[key as keyof Signals], key).toEqual(value);
  }
}

function signals(sessions: Session[], days = 90, extra = {}): Signals {
  const { skeleton } = buildSkeleton(sessions, {
    end: END,
    days,
    observedDays: { 'claude-code': days, codex: days, cursor: days },
    ...extra,
  });
  return computeSignals(skeleton, computeMetrics(skeleton, 'UTC'), 'UTC');
}

type Tokens = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
const usage = (ts: number, model: string, tokens: Tokens, sidechain = false): Event => ({
  kind: 'usage',
  ts,
  model,
  sidechain,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  ...tokens,
});
const said = (ts: number, model: string, text: string, tokens: Tokens): Event[] => [
  usage(ts, model, tokens),
  { kind: 'assistant_text', ts, text, model },
];

describe('rhythm signals', () => {
  it('finds shifts, the biggest day and hour, breaks, comebacks and weekday habits', () => {
    const s = signals([
      session('codex', [prompt(at(20, 10), 'read the old importer')]), // Thursday
      session('codex', [prompt(at(12, 11), 'sketch the new importer')]), // Friday
      session('claude-code', [
        prompt(at(6, 3, 10), 'why is the import slow'),
        prompt(at(6, 3, 40), 'profile it'),
      ]), // Thursday, 3 AM
      session('claude-code', [
        prompt(at(5, 9), 'start the import'),
        prompt(at(5, 12, 30), 'lunch check'),
        prompt(at(5, 13, 15), 'resume'),
      ]), // Friday
      session('cursor', [
        prompt(at(3, 19), 'tidy the styles'),
        prompt(at(3, 19, 30), 'and the fonts'),
      ]), // Sunday night
    ]);
    expectSignals(s, {
      shiftStart: 600,
      shiftEnd: 660,
      biggestDay: { date: '2027-03-26', weekday: 5, prompts: 3 },
      biggestHour: { date: '2027-03-25', hour: 3, prompts: 2 },
      burstiness: 3 / 9,
      longestBreakDays: 7,
      comebacks: 1,
      lunchShare: 2 / 9,
      threeAmPrompts: 2,
      sundayNightShare: 2 / 9,
      weekdayLead: { weekday: 5, lead: 4 / 3 },
      hoursCovered: 7,
    });
  });

  it('centers the clock on the circle, so 23:00 and 01:00 meet at midnight', () => {
    const s = signals([
      session('codex', [prompt(at(2, 23), 'late one')]),
      session('codex', [prompt(at(1, 1), 'later one')]),
    ]);
    expectSignals(s, { clockCenter: { minute: 0, spreadMinutes: 60 } });
  });

  it('spots Friday afternoon deploys and a prompt at midnight on New Year', () => {
    const deploy = { flags: CALL_FLAGS.deploy };
    const friday = signals([
      session('claude-code', [
        prompt(at(5, 14), 'deploy it'),
        call(at(5, 14, 1), 'Bash', 'Bash', deploy),
        call(at(5, 16), 'Bash', 'Bash', deploy),
        call(at(5, 16, 5), 'Bash', 'Bash', { ...deploy, approx: true }),
        call(at(4, 16), 'Bash', 'Bash', deploy),
      ]),
    ]);
    expectSignals(friday, { fridayDeploys: 1 });
    const party = (ts: number) =>
      signals([session('codex', [prompt(ts, 'happy new year')])]).newYearPrompt;
    expect([
      party(at(90, 23, 45)),
      party(at(89, 0, 30)),
      party(at(90, 23, 20)),
      party(at(89, 0, 31)),
    ]).toEqual([true, true, false, false]);
    expectSignals(signals([session('codex', [prompt(at(90, 23, 45), 'happy new year')])]), {
      newYearPrompt: true,
    });
  });
});

describe('session signals', () => {
  it('measures session length, one-and-done edits, compactions and commands', () => {
    const s = signals([
      session(
        'claude-code',
        [prompt(at(2, 9), 'rename the helper'), call(at(2, 9, 1), 'Edit', 'Edit')],
        {
          compactions: 2,
          commands: { clear: 1, compact: 2 },
        },
      ),
      session(
        'claude-code',
        [
          prompt(at(2, 10), 'commit this'),
          prompt(at(2, 10, 2), 'and push'),
          call(at(2, 10, 3), 'Bash', 'Bash', { flags: CALL_FLAGS.gitCommit }),
        ],
        {
          commands: { clear: 1 },
        },
      ),
      session('codex', [
        ...Array.from({ length: 5 }, (_, i) =>
          prompt(at(2, 11, i * 2), `step ${i} of the migration`),
        ),
        call(at(2, 11, 9), 'apply_patch', 'Edit'),
      ]),
      session('codex', [
        prompt(at(2, 13), 'what does this do'),
        call(at(2, 13, 1), 'read', 'Read'),
      ]),
    ]);
    expectSignals(s, {
      promptsPerSession: 1.5,
      oneAndDoneShare: 0.5,
      longestSessionPrompts: 5,
      compactions: 2,
      builtinCommands: { clear: 2, compact: 2 },
    });
  });
});

describe('tone signals', () => {
  it('counts thanks by tool, the swear hour, meltdowns, forgiveness and the longest calm run', () => {
    const s = signals([
      session(
        'codex',
        [
          'add the import step',
          'thanks for that',
          'now the export',
          'and the tests',
          'then the docs',
        ].map((t, i) => prompt(at(2, 10, i * 15), t)),
      ),
      session('claude-code', [
        prompt(at(1, 10), 'WHY IS THIS STILL SO BROKEN'),
        prompt(at(1, 10, 3), 'no, that is wrong'),
        prompt(at(1, 10, 5), 'damn it, try again'),
        prompt(at(1, 10, 30), 'thanks, that fixed it'),
        prompt(at(1, 10, 40), 'add a test for it'),
        prompt(at(1, 10, 50), 'run the whole suite'),
        prompt(at(1, 11), 'ship it'),
      ]),
    ]);
    expectSignals(s, {
      thanksByTool: { codex: (1 / 5) * 100, 'claude-code': (1 / 7) * 100 },
      swearPeakHour: 10,
      meltdowns: 1,
      forgiveMinutes: 25,
      zenRun: 5,
    });
  });
});

describe('collaboration signals', () => {
  it('counts agent moves per prompt, the bounce back after a correction, subagents and declines', () => {
    const s = signals([
      session('claude-code', [
        prompt(at(1, 9), 'start the refactor of the parser module'),
        call(at(1, 9, 1), 'Read', 'Read'),
        call(at(1, 9, 2), 'Edit', 'Edit'),
        call(at(1, 9, 3), 'Bash', 'Bash'),
        prompt(at(1, 9, 10), 'no, keep the old api'),
        call(at(1, 9, 11), 'Edit', 'Edit'),
        prompt(at(1, 9, 12), 'no, revert that file'),
        prompt(at(1, 9, 14), 'good, now add tests'),
        call(at(1, 9, 15), 'Task', 'Task'),
        call(at(1, 9, 16), 'Bash', 'Bash', { sidechain: true }),
        call(at(1, 9, 17), 'Bash', 'Bash', { declined: true }),
      ]),
    ]);
    expectSignals(s, {
      movesPerPrompt: { median: 1.5, p90: 3 },
      longestSoloRun: 3,
      bounceBack: 1.5,
      subagentRuns: 1,
      declinedCalls: 1,
    });
  });

  it('finds the peak of sessions open at once, across tools', () => {
    const s = signals([
      session('claude-code', [
        prompt(at(1, 9), 'one'),
        prompt(at(1, 9, 5), 'two'),
        prompt(at(1, 9, 10), 'three'),
      ]),
      session('codex', [prompt(at(1, 9, 4), 'side quest'), prompt(at(1, 9, 8), 'more')]),
      session('cursor', [prompt(at(1, 9, 6), 'styles')]),
      session('claude-code', [prompt(at(2, 15), 'yesterday')]),
    ]);
    expectSignals(s, { parallelPeak: { sessions: 3, date: '2027-03-30' } });
  });
});

describe('craft, agent and shipping signals', () => {
  it('measures prompts, replies, tool errors, apologies, tests, builds, deploys and lines', () => {
    const model = 'claude-opus-5-5';
    const s = signals([
      session('claude-code', [
        prompt(at(1, 9), 'fix'),
        ...said(at(1, 9, 1), model, 'Done.', { output: 100 }),
        call(at(1, 9, 2), 'Bash', 'Bash', { flags: CALL_FLAGS.test }),
        call(at(1, 9, 3), 'Bash', 'Bash', { flags: CALL_FLAGS.build }),
        call(at(1, 9, 4), 'Bash', 'Bash', { flags: CALL_FLAGS.deploy, error: true }),
        prompt(at(1, 9, 5), 'ok'),
        ...said(at(1, 9, 6), model, 'I apologize for the confusion.', { output: 300 }),
        call(at(1, 9, 7), 'Read', 'Read'),
        call(at(1, 9, 8), 'Grep', 'Search'),
        call(at(1, 9, 9), 'Read', 'Read'),
        prompt(
          at(1, 9, 10),
          'please rewrite the date parser so it handles leap years and time zones correctly',
        ),
        ...said(at(1, 9, 11), model, 'Here is the new parser.', { output: 50 }),
        usage(at(1, 9, 11), model, { output: 999 }, true),
        call(at(1, 9, 12), 'Edit', 'Edit', { linesAdded: 30, linesRemoved: 10 }),
        call(at(1, 9, 13), 'Write', 'Write', { linesAdded: 20 }),
        call(at(1, 9, 14), 'MCP', 'MCP'),
        call(at(1, 9, 15), 'WebFetch', 'Web'),
        prompt(at(1, 9, 20), 'go'),
      ]),
    ]);
    expectSignals(s, {
      longestPromptWords: 14,
      oneWordShare: 0.75,
      replyTokens: { median: 100, longest: 300 },
      toolErrorRate: 0.1,
      apologyPer100: (1 / 3) * 100,
      testRuns: 1,
      builds: 1,
      deploys: 1,
      readEditRatio: 1.5,
      linesRemoved: 10,
      netLines: 40,
      mcpCalls: 1,
      webCalls: 1,
    });
  });

  it('measures model switches, the top model, the cache, tokens per prompt and cost per commit', () => {
    const opus = 'claude-opus-5-5';
    const sonnet = 'claude-sonnet-5-5';
    const s = signals([
      session('claude-code', [
        prompt(at(1, 9), 'build the importer'),
        ...said(at(1, 9, 1), opus, 'a', { input: 1000, output: 200, cacheRead: 3000 }),
        ...said(at(1, 9, 2), opus, 'b', { input: 1000, output: 200 }),
        ...said(at(1, 9, 3), sonnet, 'c', { input: 1000, output: 200 }),
        ...said(at(1, 9, 4), opus, 'd', { input: 1000, output: 200 }),
        call(at(1, 9, 5), 'Bash', 'Bash', { flags: CALL_FLAGS.gitCommit }),
        call(at(1, 9, 6), 'Bash', 'Bash', { flags: CALL_FLAGS.gitCommit }),
        prompt(at(1, 9, 10), 'thanks'),
      ]),
    ]);
    // Opus 5.5: $4 in, $20 out, $0.20 cache reads per million; Sonnet 5.5: $2 in, $10 out.
    const cost =
      (3 * (1000 * 4 + 200 * 20)) / 1e6 + (3000 * 0.2) / 1e6 + (1000 * 2 + 200 * 10) / 1e6;
    expectSignals(s, {
      modelSwitches: 2,
      topModelShare: 0.75,
      cacheHitRate: 3 / 7,
      tokensPerPrompt: 3900,
    });
    covered.add('costPerCommit');
    expect(s.costPerCommit).toBeCloseTo(cost / 2, 10);
  });
});

describe('glow up', () => {
  // Fourteen days early in the period and fourteen at the end; only the end has thanks.
  const day = (d: number, polite: boolean) =>
    session('codex', [
      prompt(at(d, 10), 'refactor the parser module and run all of the tests'),
      prompt(
        at(d, 10, 30),
        `${polite ? 'thanks, ' : ''}now update the docs for the parser module and the tests`,
      ),
    ]);
  const sessions = [
    ...Array.from({ length: 14 }, (_, i) => day(89 - i, false)),
    ...Array.from({ length: 14 }, (_, i) => day(13 - i, i >= 7)),
  ];

  it('compares the first and last 30 days of a long, busy period', () => {
    expectSignals(signals(sessions), {
      glowUp: { manners: 25, composure: 0, promptCraft: 0, focus: 0 },
    });
  });

  it('stays quiet for short periods', () => {
    expect(signals(sessions, 45).glowUp).toBeUndefined();
  });
});

describe('skeleton v2 signals', () => {
  it('counts please, praise, sorry, laughs, emoji, nudges, questions and what prompts carry', () => {
    const s = signals([
      session('codex', [
        ...[
          'please add a test for the parser',
          'perfect, that works now',
          'sorry, I meant the other file',
          'hahaha that bug was wild',
          'ship it \u{1F680}',
          'it works!',
          'continue',
          'how does the parser handle dates?',
          'look:\nTypeError: x is undefined\n    at run (index.js:12:5)',
          'read https://example.org/docs first',
          'use this:\n```\nconst a = 1;\n```',
          'ultrathink about the cache design',
        ].map((t, i) => prompt(at(1, 9, i * 3), t)),
        prompt(at(1, 10), 'what is this', { images: 1 }),
      ]),
    ]);
    const of13 = (n: number) => n / 13;
    expectSignals(s, {
      pleaseCount: 1,
      praiseCount: 1,
      userSorryCount: 1,
      laughCount: 1,
      emojiPrompts: 1,
      exclaimShare: of13(1),
      nudgeShare: of13(1),
      questionShare: of13(2),
      thinkRequests: 1,
      pastedErrorShare: of13(1),
      screenshots: 1,
      linkShare: of13(1),
      codeBlockShare: of13(1),
    });
  });

  it('counts refusals and replies that ask the user something', () => {
    const s = signals([
      session('claude-code', [
        prompt(at(1), 'go'),
        ...reply(at(1, 12, 1), "Sorry, I can't help with that."),
        ...reply(at(1, 12, 2), 'Done. Should I also update the docs?'),
      ]),
    ]);
    expectSignals(s, { refusals: 1, agentQuestions: 1 });
  });

  it('follows tests from red to green, installs, lint runs, env reads, the stack and to-do lists', () => {
    const test = (minute: number, result: 'pass' | 'fail') =>
      call(at(1, 12, minute), 'Bash', 'Bash', { flags: TOOL_FLAGS.test, testResult: result });
    const edit = (minute: number, lang: string, name = 'Edit') =>
      call(at(1, 12, minute), name, name === 'Write' ? 'Write' : 'Edit', {
        langCat: LANG_CATEGORIES.indexOf(lang as never),
      });
    const s = signals([
      session('claude-code', [
        prompt(at(1), 'go'),
        test(1, 'fail'),
        test(2, 'fail'),
        test(3, 'pass'),
        test(4, 'fail'),
        test(5, 'pass'),
        call(at(1, 12, 6), 'Bash', 'Bash', { flags: TOOL_FLAGS.install | TOOL_FLAGS.lint }),
        call(at(1, 12, 7), 'Read', 'Read', { sensitive: true }),
        edit(8, 'python'),
        edit(9, 'python', 'Write'),
        edit(10, 'typescript'),
        call(at(1, 12, 11), 'TodoWrite', 'Todo'),
      ]),
      session('codex', [prompt(at(2), 'later')]),
    ]);
    expectSignals(s, {
      redToGreen: 2,
      installs: 1,
      lintRuns: 1,
      envReads: 1,
      stackMix: { python: 2 / 3, typescript: 1 / 3 },
      languagesTouched: 2,
      todoLists: 1,
    });
  });

  it('shares sessions by permission setting and entry point', () => {
    const s = signals([
      session('claude-code', [prompt(at(1), 'a')], {
        permissionModes: { default: 2, acceptEdits: 1 },
        entrypoint: 'cli',
      }),
      session('claude-code', [prompt(at(1, 13), 'b')], {
        permissionModes: { bypassPermissions: 1 },
        entrypoint: 'claude-desktop',
      }),
      session('codex', [prompt(at(2), 'c')], {
        permissionModes: { 'sandbox:read-only': 1 },
        entrypoint: 'codex_vscode',
      }),
      session('cursor', [prompt(at(3), 'd')], {
        permissionModes: { agent: 1 },
        entrypoint: 'editor',
      }),
    ]);
    expectSignals(s, {
      autonomyMix: { acceptEdits: 1 / 3, bypass: 1 / 3, ask: 1 / 3 },
      entrypointMix: { terminal: 0.25, desktop: 0.25, ide: 0.5 },
      bypassShare: 1 / 3,
    });
  });

  it('shares prompts by language and names the languages of thanks', () => {
    const detectLanguage = (text: string) => (/lütfen|teşekkür/.test(text) ? 'tur' : 'eng');
    const s = signals(
      [
        session(
          'codex',
          [
            'please refactor the parser module and run all of the tests again',
            'thanks, now update the docs for the parser module and the tests',
            'lütfen bütün testleri tekrar çalıştır ve sonucu bana hemen söyle',
            'teşekkürler, şimdi belgeleri de güncelle ve testleri tekrar çalıştır',
            'and also update the readme for the parser module and the docs folder',
            'ok',
          ].map((t, i) => prompt(at(1, 9, i * 3), t)),
        ),
      ],
      90,
      { detectLanguage },
    );
    expectSignals(s, {
      languageMix: { eng: 3 / 5, tur: 2 / 5 },
      languagesUsed: ['eng', 'tur'],
      thanksLanguages: ['eng', 'tur'],
    });
  });
});

describe('coverage', () => {
  it('has an exact expectation for every signal', () => {
    const missing = Object.keys(signals([])).filter((key) => !covered.has(key));
    expect(missing).toEqual([]);
  });
});
