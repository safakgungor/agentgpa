import { describe, expect, it } from 'vitest';
import {
  ANCHORS,
  buildReport,
  buildSkeleton,
  computeMetrics,
  grade,
  letterFor,
  pickActivities,
  pickArchetype,
  type SecretCounts,
  type Session,
  score,
} from '../src/index.ts';
import { at, END, prompt, reply, session } from './build.ts';

const none: SecretCounts = { pasted: 0, exposedViaTools: 0, types: {}, byTool: {} };

describe('score, letter and GPA (the worked examples)', () => {
  it('Attendance x = 0.35 scores 75, a C', () => {
    expect(score(0.35, ANCHORS.attendance)).toBe(75);
    expect(letterFor(75)).toEqual({ letter: 'C', points: 2 });
  });

  it('Composure x = 2 scores 87, a B+', () => {
    expect(score(2, ANCHORS.composure)).toBe(87);
    expect(letterFor(87).letter).toBe('B+');
  });

  it('Focus x = 60 scores about 32.14, an F', () => {
    expect(score(60, ANCHORS.focus)).toBeCloseTo(32.1, 1);
    expect(letterFor(score(60, ANCHORS.focus)).letter).toBe('F');
  });

  it('Focus with 188 corrections and 136 interrupts in 1,284 prompts is a C+', () => {
    const x = ((188 + 0.5 * 136) / 1284) * 100;
    expect(x).toBeCloseTo(19.94, 2);
    expect(score(x, ANCHORS.focus)).toBeCloseTo(77.9, 1);
    expect(letterFor(score(x, ANCHORS.focus))).toEqual({ letter: 'C+', points: 2.3 });
  });

  it('Manners with 64 thanks in 1,284 prompts is a B+', () => {
    const x = (64 / 1284) * 100;
    expect(score(x, ANCHORS.manners)).toBeCloseTo(88.2, 1);
    expect(letterFor(score(x, ANCHORS.manners))).toEqual({ letter: 'B+', points: 3.3 });
  });

  it('Security Hygiene: 1 secret in 30 days is a B+, 1 in 90 days an A-, none an A', () => {
    expect(score(1, ANCHORS.securityHygiene)).toBeCloseTo(88.3, 1);
    expect(letterFor(score(1, ANCHORS.securityHygiene)).letter).toBe('B+');
    expect(score(30 / 90, ANCHORS.securityHygiene)).toBe(92.8);
    expect(letterFor(92.8).letter).toBe('A-');
    expect(score(0, ANCHORS.securityHygiene)).toBe(95);
    expect(letterFor(95)).toEqual({ letter: 'A', points: 4 });
  });

  it('gives a score on a cut the higher letter and clamps scores', () => {
    expect(letterFor(93).letter).toBe('A');
    expect(letterFor(92.96).letter).toBe('A');
    expect(letterFor(92.94).letter).toBe('A-');
    expect(score(100, ANCHORS.composure)).toBe(0);
    expect(score(1, ANCHORS.attendance)).toBe(100);
  });
});

const report = (sessions: Session[], observedDays = { 'claude-code': 90, codex: 90, cursor: 90 }) =>
  buildReport(sessions, { end: END, days: 90, observedDays, timeZone: 'UTC', seed: 'test' });

/** A steady habit: on each of `days` days, `prompts` prompts with a thanks every fifth one. */
function habit(tool: 'claude-code' | 'codex', days: number, prompts = 6): Session[] {
  return Array.from({ length: days }, (_, d) =>
    session(
      tool,
      Array.from({ length: prompts }, (_, i) =>
        prompt(
          at(d, 10, i * 5),
          i % 5 === 0
            ? 'thanks, now refactor the parser module please'
            : 'refactor the parser module and run all the tests',
        ),
      ),
    ),
  );
}

describe('grades', () => {
  it('is Incomplete under 20 prompts or 3 active days', () => {
    expect(report(habit('codex', 2, 12)).grades.status).toBe('incomplete');
    expect(report(habit('codex', 3, 3)).grades.status).toBe('incomplete');
    const r = report(habit('codex', 5, 5));
    expect(r.grades.status).toBe('graded');
    expect(r.grades.gpa).toBeGreaterThan(0);
  });

  it('gives the same grades to the same habits whichever tool kept them (retention fairness)', () => {
    // Claude Code keeps 30 days and saw 30 days of the habit; Codex keeps 90 and saw all 90.
    const claude = report(habit('claude-code', 30), { 'claude-code': 30, codex: 90, cursor: 90 });
    const codex = report(habit('codex', 90));
    for (const course of Object.keys(
      claude.grades.courses,
    ) as (keyof typeof claude.grades.courses)[]) {
      expect(claude.grades.courses[course].letter, course).toBe(
        codex.grades.courses[course].letter,
      );
    }
    expect(claude.grades.gpa).toBe(codex.grades.gpa);
  });

  it('grades Planning per tool and weights the scores by sessions', () => {
    const planned = (tool: 'claude-code' | 'codex', planMode: boolean) =>
      session(tool, [prompt(at(1), 'a'), prompt(at(1, 12, 1), 'b'), prompt(at(1, 12, 2), 'c')], {
        usedPlanMode: planMode,
      });
    const m = computeMetrics(
      buildSkeleton(
        [
          planned('claude-code', true),
          planned('codex', false),
          planned('codex', false),
          planned('codex', false),
        ],
        {
          end: END,
          days: 90,
          observedDays: {},
        },
      ).skeleton,
      'UTC',
    );
    const g = grade(m, none);
    // Claude Code planned its one session (100), Codex none of its three (55 each).
    expect(g.courses.planning.score).toBe(66.3);
  });

  it('puts a report on detention when a secret reached the agent', () => {
    const m = computeMetrics(
      buildSkeleton(habit('codex', 5), { end: END, days: 90, observedDays: {} }).skeleton,
      'UTC',
    );
    expect(
      grade(m, { ...none, exposedViaTools: 1, byTool: { codex: { pasted: 0, exposed: 1 } } })
        .detention,
    ).toBe(true);
    expect(grade(m, none).detention).toBe(false);
  });
});

describe('archetypes and activities', () => {
  it('picks the first archetype that matches', () => {
    const caps = report(
      Array.from({ length: 5 }, (_, d) =>
        session(
          'codex',
          Array.from({ length: 6 }, (_, i) => prompt(at(d, 10, i), 'WHY IS THIS STILL SO BROKEN')),
        ),
      ),
    );
    expect(caps.archetype.id).toBe('caps-lock-captain');
    const polite = report(
      Array.from({ length: 5 }, (_, d) =>
        session(
          'codex',
          Array.from({ length: 6 }, (_, i) =>
            prompt(at(d, 10, i * 15), 'thank you, please refactor the parser module and add tests'),
          ),
        ),
      ),
    );
    expect(polite.archetype.id).toBe('diplomat');
    expect(polite.archetype.superlative).toBe('Most likely to thank a robot');
  });

  it('falls back to The All-Rounder when no rule matches', () => {
    // Calm, unhurried daytime sessions: 25-minute blocks of long prompts, no thanks, no plan.
    const neutral = Array.from({ length: 3 }, (_, d) =>
      session(
        'codex',
        Array.from({ length: 4 }, (_, i) =>
          prompt(
            at(d, 10, i * 8),
            `refactor the parser module and then run all of the unit tests again, step ${i}`,
          ),
        ),
      ),
    );
    expect(report(neutral).archetype.id).toBe('all-rounder');
  });

  it('earns at most three activities, strongest first', () => {
    // Nine nights in a row, every prompt polite and with context.
    const r = report(
      Array.from({ length: 9 }, (_, d) =>
        session(
          'codex',
          Array.from({ length: 4 }, (_, i) =>
            prompt(
              at(d, 2, i * 5),
              `thank you, the late night refactor of parser.ts is great ${i}`,
            ),
          ),
        ),
      ),
    );
    const a = pickActivities(r.metrics, r.device.secrets);
    expect(a.map((x) => x.name)).toEqual(['Polite Society', 'Night Shift Society', 'Context Club']);
    expect(a.map((x) => x.evidence)).toEqual([...a.map((x) => x.evidence)].sort((x, y) => y - x));
    expect(r.activities).toEqual(a);
  });

  it('makes a Two-Tool Athlete from a second tool with a fifth of the sessions', () => {
    const sessions = (tool: 'claude-code' | 'codex', n: number) =>
      Array.from({ length: n }, (_, d) =>
        session(tool, [prompt(at(d + 1, 10), 'add a test for the date parser in utils.ts')]),
      );
    const names = (s: Session[]) =>
      pickActivities(report(s).metrics, {
        pasted: 0,
        exposedViaTools: 0,
        types: {},
        byTool: {},
      }).map((a) => a.id);
    expect(names([...sessions('claude-code', 8), ...sessions('codex', 2)])).toContain(
      'two-tool-athlete',
    );
    expect(names([...sessions('claude-code', 9), ...sessions('codex', 1)])).not.toContain(
      'two-tool-athlete',
    );
  });

  it('keeps the archetype rule order stable', () => {
    const r = report(habit('codex', 5));
    expect(pickArchetype(r.metrics, r.grades).id).toBe(r.archetype.id);
    expect(reply(at(1), 'x')).toHaveLength(2);
  });
});
