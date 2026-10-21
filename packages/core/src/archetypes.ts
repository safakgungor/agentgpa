import type { Grades } from './grading/grade.ts';
import type { Metrics } from './metrics.ts';

// Archetypes: deterministic, first match wins. Thresholds are data; the superlative is each
// archetype's fixed yearbook line, never a personal count.

export type ArchetypeId =
  | 'conductor'
  | 'caps-lock-captain'
  | 'night-architect'
  | 'micromanager'
  | 'diplomat'
  | 'speedrunner'
  | 'vibe-coder'
  | 'token-baron'
  | 'valedictorian'
  | 'all-rounder';

export interface Archetype {
  id: ArchetypeId;
  name: string;
  /** The yearbook line, "Most likely to ...". */
  superlative: string;
  /** The archetype's highlighter color, as a hex value. */
  highlighter: string;
}

export const ARCHETYPES: Record<ArchetypeId, Archetype> = {
  conductor: {
    id: 'conductor',
    name: 'The Conductor',
    superlative: 'Most likely to run six agents at once',
    highlighter: '#3af2ff',
  },
  'caps-lock-captain': {
    id: 'caps-lock-captain',
    name: 'Caps Lock Captain',
    superlative: 'Most likely to type in all caps',
    highlighter: '#e4ff3a',
  },
  'night-architect': {
    id: 'night-architect',
    name: 'Night Architect',
    superlative: 'Most likely to ship at 3 AM',
    highlighter: '#c9a7ff',
  },
  micromanager: {
    id: 'micromanager',
    name: 'The Micromanager',
    superlative: 'Most likely to say "no, not like that"',
    highlighter: '#ffa53a',
  },
  diplomat: {
    id: 'diplomat',
    name: 'The Diplomat',
    superlative: 'Most likely to thank a robot',
    highlighter: '#ff5fb0',
  },
  speedrunner: {
    id: 'speedrunner',
    name: 'Speedrunner',
    superlative: 'Most likely to finish before the agent does',
    highlighter: '#6bffd0',
  },
  'vibe-coder': {
    id: 'vibe-coder',
    name: 'Vibe Coder',
    superlative: 'Most likely to say "make it pop"',
    highlighter: '#ffb5a0',
  },
  'token-baron': {
    id: 'token-baron',
    name: 'Token Baron',
    superlative: 'Most likely to burn the token budget',
    highlighter: '#8fc3ff',
  },
  valedictorian: {
    id: 'valedictorian',
    name: 'Valedictorian',
    superlative: 'Most likely to give the speech',
    highlighter: '#ffd84d',
  },
  'all-rounder': {
    id: 'all-rounder',
    name: 'The All-Rounder',
    superlative: 'Most likely to do a bit of everything',
    highlighter: '#f2a7ff',
  },
};

export const ARCHETYPE_RULES = {
  conductor: { maxParallelSessions: 4 },
  capsLockCaptain: { composureLetters: ['D', 'F'] },
  nightArchitect: { nightShare: 0.35, avgPromptWords: 15 },
  micromanager: { focusLetters: ['C-', 'D', 'F'] },
  diplomat: { mannersLetters: ['A-', 'A'] },
  speedrunner: { medianBlockMinutes: 15, promptsPerActiveHour: 20 },
  vibeCoder: { shortPromptShare: 0.6, planSessionShare: 0.1 },
  /** Estimated USD per 30 observed days. */
  tokenBaron: { costPer30: 2000 },
  valedictorian: { gpa: 3.5 },
} as const;

export function pickArchetype(metrics: Metrics, grades: Grades): Archetype {
  const r = ARCHETYPE_RULES;
  const letter = (course: keyof Grades['courses']) => grades.courses[course].letter;
  const id: ArchetypeId =
    metrics.maxParallelSessions >= r.conductor.maxParallelSessions
      ? 'conductor'
      : (r.capsLockCaptain.composureLetters as readonly string[]).includes(letter('composure'))
        ? 'caps-lock-captain'
        : metrics.nightShare >= r.nightArchitect.nightShare &&
            metrics.avgPromptWords >= r.nightArchitect.avgPromptWords
          ? 'night-architect'
          : (r.micromanager.focusLetters as readonly string[]).includes(letter('focus'))
            ? 'micromanager'
            : (r.diplomat.mannersLetters as readonly string[]).includes(letter('manners'))
              ? 'diplomat'
              : metrics.medianBlockMinutes <= r.speedrunner.medianBlockMinutes &&
                  metrics.promptsPerActiveHour >= r.speedrunner.promptsPerActiveHour
                ? 'speedrunner'
                : metrics.shortPromptShare >= r.vibeCoder.shortPromptShare &&
                    metrics.planSessionShare < r.vibeCoder.planSessionShare
                  ? 'vibe-coder'
                  : metrics.per30.costUsd >= r.tokenBaron.costPer30
                    ? 'token-baron'
                    : (grades.gpa ?? 0) >= r.valedictorian.gpa
                      ? 'valedictorian'
                      : 'all-rounder';
  return ARCHETYPES[id];
}
