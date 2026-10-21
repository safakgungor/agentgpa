import { type Metrics, secretsPer30 } from '../metrics.ts';
import type { SecretCounts } from '../secrets.ts';
import type { Tool } from '../types.ts';
import {
  ANCHORS,
  type Anchor,
  COURSES,
  type CourseId,
  HONORS,
  INCOMPLETE,
  INTERRUPT_WEIGHT,
  LETTERS,
  PLANNING_ANCHORS,
} from './config.ts';

// score = clamp(55 + 40 * (x - F) / (A - F), 0, 100), rounded to one decimal; letters by cut,
// a score on a cut gets the higher letter; GPA is the mean of the seven grade points.

export interface CourseGrade {
  course: CourseId;
  /** The course input. */
  x: number;
  score: number;
  letter: string;
  points: number;
}

export interface Grades {
  courses: Record<CourseId, CourseGrade>;
  /** Undefined when the report is Incomplete. */
  gpa: number | undefined;
  status: 'graded' | 'incomplete';
  honors: 'deans-list' | 'probation' | 'incomplete' | undefined;
  detention: boolean;
}

const round = (value: number, digits: number): number => {
  const f = 10 ** digits;
  return Math.round((value + Number.EPSILON) * f) / f;
};

export function score(x: number, anchor: Anchor): number {
  const raw = 55 + (40 * (x - anchor.F)) / (anchor.A - anchor.F);
  return round(Math.min(100, Math.max(0, raw)), 1);
}

export function letterFor(value: number): { letter: string; points: number } {
  const rounded = round(value, 1);
  const hit = LETTERS.find((l) => rounded >= l.min) ?? (LETTERS.at(-1) as (typeof LETTERS)[number]);
  return { letter: hit.letter, points: hit.points };
}

function course(id: CourseId, x: number, value: number): CourseGrade {
  return { course: id, x, score: value, ...letterFor(value) };
}

/** The course inputs, from metrics and the device's secret counts. */
export function courseInputs(
  metrics: Metrics,
  secrets: SecretCounts,
): Record<Exclude<CourseId, 'planning'>, number> {
  const prompts = metrics.userPrompts;
  const per100 = (n: number) => (prompts > 0 ? (n / prompts) * 100 : 0);
  let weighted = 0;
  let weight = 0;
  for (const t of Object.values(metrics.perTool)) {
    if (!t || t.prompts === 0) continue;
    weighted += t.prompts * Math.min(1, t.activeDays / t.observedDays);
    weight += t.prompts;
  }
  return {
    attendance: weight > 0 ? weighted / weight : 0,
    manners: metrics.thanksPer100,
    composure: per100(metrics.capsCrisisCount + metrics.swearCount + metrics.rageRepeatCount),
    promptCraft: metrics.contextualPromptShare,
    focus: per100(metrics.correctionCount + INTERRUPT_WEIGHT * metrics.interruptCount),
    securityHygiene: secretsPer30(secrets, metrics),
  };
}

/** Planning: each tool against its own anchors, then the session-weighted mean of the scores. */
export function planning(metrics: Metrics): { x: number; score: number } {
  let weighted = 0;
  let sessions = 0;
  let planned = 0;
  for (const [tool, t] of Object.entries(metrics.perTool) as [
    Tool,
    NonNullable<Metrics['perTool'][Tool]>,
  ][]) {
    if (t.planBase === 0) continue;
    weighted += t.planBase * score(t.planned / t.planBase, PLANNING_ANCHORS[tool]);
    sessions += t.planBase;
    planned += t.planned;
  }
  if (sessions === 0) return { x: 0, score: score(0, PLANNING_ANCHORS['claude-code']) };
  return { x: planned / sessions, score: round(weighted / sessions, 1) };
}

export function grade(metrics: Metrics, secrets: SecretCounts): Grades {
  const inputs = courseInputs(metrics, secrets);
  const plan = planning(metrics);
  const courses = {} as Record<CourseId, CourseGrade>;
  for (const id of COURSES) {
    if (id === 'planning') courses.planning = course('planning', plan.x, plan.score);
    else courses[id] = course(id, inputs[id], score(inputs[id], ANCHORS[id]));
  }
  const incomplete =
    metrics.userPrompts < INCOMPLETE.minPrompts || metrics.activeDays < INCOMPLETE.minActiveDays;
  const gpa = incomplete
    ? undefined
    : round(COURSES.reduce((sum, id) => sum + courses[id].points, 0) / COURSES.length, 2);
  const honors =
    gpa === undefined
      ? 'incomplete'
      : gpa >= HONORS.deansList
        ? 'deans-list'
        : gpa < HONORS.probation
          ? 'probation'
          : undefined;
  return {
    courses,
    gpa,
    status: incomplete ? 'incomplete' : 'graded',
    honors,
    detention: secrets.pasted + secrets.exposedViaTools > 0,
  };
}
