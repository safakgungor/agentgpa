import type { Tool } from '../types.ts';

// Every number that shapes a grade lives here (docs/grading.md explains each one). Changing
// any of them changes the grading version.

/** Version of the grading formula and anchors. */
export const GRADING_VERSION = 'v0';

export type CourseId =
  | 'attendance'
  | 'manners'
  | 'composure'
  | 'promptCraft'
  | 'planning'
  | 'focus'
  | 'securityHygiene';

/** The order courses are shown in. */
export const COURSES: readonly CourseId[] = [
  'attendance',
  'promptCraft',
  'focus',
  'manners',
  'planning',
  'securityHygiene',
  'composure',
];

export const COURSE_NAMES: Record<CourseId, string> = {
  attendance: 'Attendance',
  manners: 'Manners',
  composure: 'Composure',
  promptCraft: 'Prompt Craft',
  planning: 'Planning',
  focus: 'Focus',
  securityHygiene: 'Security Hygiene',
};

export interface Anchor {
  /** The input that scores 55 (the bottom of F). */
  F: number;
  /** The input that scores 95 (an A). */
  A: number;
}

/** v0 anchors, to be calibrated with beta data. For "lower is better" courses F is above A. */
export const ANCHORS: Record<Exclude<CourseId, 'planning'>, Anchor> = {
  attendance: { F: 0.1, A: 0.6 },
  manners: { F: 0, A: 6 },
  composure: { F: 8, A: 0.5 },
  promptCraft: { F: 0.2, A: 0.7 },
  focus: { F: 40, A: 5 },
  securityHygiene: { F: 6, A: 0 },
};

/** Planning is graded against each tool's own habits; v0 starts every tool at the same anchors. */
export const PLANNING_ANCHORS: Record<Tool, Anchor> = {
  'claude-code': { F: 0, A: 0.4 },
  codex: { F: 0, A: 0.4 },
  cursor: { F: 0, A: 0.4 },
};

/** Letters from the top: the lowest score each needs, and its grade points. */
export const LETTERS: readonly { letter: string; min: number; points: number }[] = [
  { letter: 'A', min: 93, points: 4.0 },
  { letter: 'A-', min: 90, points: 3.7 },
  { letter: 'B+', min: 87, points: 3.3 },
  { letter: 'B', min: 83, points: 3.0 },
  { letter: 'B-', min: 80, points: 2.7 },
  { letter: 'C+', min: 77, points: 2.3 },
  { letter: 'C', min: 73, points: 2.0 },
  { letter: 'C-', min: 70, points: 1.7 },
  { letter: 'D', min: 60, points: 1.0 },
  { letter: 'F', min: 0, points: 0.0 },
];

/** Below either, a report is Incomplete: no GPA and never on a board. */
export const INCOMPLETE = { minPrompts: 20, minActiveDays: 3 };

export const HONORS = { deansList: 3.7, probation: 2.0 };

/** Security Hygiene counts an exposed secret at half the weight of a pasted one. */
export const EXPOSED_SECRET_WEIGHT = 0.5;

/** Focus counts an interrupt at half the weight of a correction. */
export const INTERRUPT_WEIGHT = 0.5;
