import type { Metrics } from './metrics.ts';
import type { Signals } from './signals.ts';
import type { DeviceFacts } from './skeleton.ts';
import { METRIC_RULES as R } from './thresholds.ts';

// A report's three funny lines, which the CLI no longer prints: a small public set with fixed
// triggers that need no population data. At most one roast, never two from the same family,
// never a percentage of developers. Strength decides the order, and a hash of the install id
// breaks ties and nudges close calls, so two people with the same numbers can still see
// different lines.

export type Tone = 'brag' | 'roast' | 'wholesome' | 'weird';

export interface PreviewContext {
  metrics: Metrics;
  signals: Signals;
  device: DeviceFacts;
}

interface Line {
  id: string;
  family: string;
  tone: Tone;
  /** 1 or more when the line applies; higher is a stronger story. */
  strength: (c: PreviewContext) => number;
  text: (c: PreviewContext) => string;
}

const n = (value: number): string => Math.round(value).toLocaleString('en-US');
const pct = (value: number): string => `${Math.round(value * 100)}%`;
const hours = (minutes: number): string => `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
const early = (m: Metrics): number =>
  m.hourly.slice(R.nightEndsHour, R.earlyEndsHour).reduce((s, x) => s + x, 0);
const secrets = (d: DeviceFacts): number => d.secrets.pasted + d.secrets.exposedViaTools;

export const PREVIEW_LINES: readonly Line[] = [
  {
    id: 'absolutely-right',
    family: 'agent-talk',
    tone: 'weird',
    strength: ({ metrics }) => metrics.absolutelyRightCount / 3,
    text: ({ metrics }) =>
      `Your agent said "you're absolutely right" ${n(metrics.absolutelyRightCount)} times.`,
  },
  {
    id: 'agreeable',
    family: 'agent-talk',
    tone: 'weird',
    strength: ({ metrics }) =>
      metrics.absolutelyRightCount < 3 ? metrics.sycophancyCount / 10 : 0,
    text: ({ metrics }) =>
      `Your agent agreed with you ${n(metrics.sycophancyCount)} times. Flattery got it everywhere.`,
  },
  {
    id: 'apologies',
    family: 'agent-talk',
    tone: 'weird',
    strength: ({ metrics }) => metrics.apologyCount / 5,
    text: ({ metrics }) =>
      `Your agent apologized ${n(metrics.apologyCount)} times. It meant every one.`,
  },
  {
    id: 'swears',
    family: 'temper',
    tone: 'roast',
    strength: ({ metrics }) => metrics.swearCount / 3,
    text: ({ metrics }) => `${n(metrics.swearCount)} swears at your agent. We've all been there.`,
  },
  {
    id: 'caps',
    family: 'temper',
    tone: 'roast',
    strength: ({ metrics }) => metrics.capsCrisisCount / 3,
    text: ({ metrics }) =>
      `${n(metrics.capsCrisisCount)} prompts in ALL CAPS. Your agent heard you the first time.`,
  },
  {
    id: 'thanks',
    family: 'manners',
    tone: 'wholesome',
    strength: ({ metrics }) => metrics.thanksCount / 5,
    text: ({ metrics }) => `You thanked your agent ${n(metrics.thanksCount)} times. It noticed.`,
  },
  {
    id: 'marathon',
    family: 'stamina',
    tone: 'brag',
    strength: ({ metrics }) => metrics.longestRunMinutes / 180,
    text: ({ metrics }) =>
      metrics.marathonCount > 0
        ? `Longest run: ${hours(metrics.longestRunMinutes)} straight. ${n(metrics.marathonCount)} ${metrics.marathonCount === 1 ? 'run' : 'runs'} went past ${R.marathonMinutes / 60} hours.`
        : `Longest run: ${hours(metrics.longestRunMinutes)} straight.`,
  },
  {
    id: 'streak',
    family: 'stamina',
    tone: 'brag',
    strength: ({ metrics }) => metrics.longestStreakDays / 5,
    text: ({ metrics }) =>
      `${n(metrics.longestStreakDays)} days in a row with your agent. Perfect attendance.`,
  },
  {
    id: 'night',
    family: 'clock',
    tone: 'weird',
    strength: ({ metrics }) => metrics.nightShare / 0.2,
    text: ({ metrics }) =>
      `${pct(metrics.nightShare)} of your prompts landed between midnight and ${R.nightEndsHour} AM.`,
  },
  {
    id: 'three-am',
    family: 'clock',
    tone: 'weird',
    strength: ({ signals }) => signals.threeAmPrompts / 5,
    text: ({ signals }) =>
      `${n(signals.threeAmPrompts)} prompts between 3 and 4 AM. Sleep is a suggestion.`,
  },
  {
    id: 'early',
    family: 'clock',
    tone: 'wholesome',
    strength: ({ metrics }) => metrics.earlyShare / 0.15,
    text: ({ metrics }) =>
      `${n(early(metrics))} prompts before ${R.earlyEndsHour} AM. The early bird gets the merge.`,
  },
  {
    id: 'weekend',
    family: 'calendar',
    tone: 'weird',
    strength: ({ metrics }) => metrics.weekendShare / 0.25,
    text: ({ metrics }) => `${pct(metrics.weekendShare)} of your prompts came on weekends.`,
  },
  {
    id: 'interrupts',
    family: 'steering',
    tone: 'roast',
    strength: ({ metrics }) => metrics.interruptCount / 10,
    text: ({ metrics }) =>
      `You stopped your agent mid-sentence ${n(metrics.interruptCount)} times.`,
  },
  {
    id: 'corrections',
    family: 'steering',
    tone: 'weird',
    strength: ({ metrics }) => metrics.correctionCount / 10,
    text: ({ metrics }) =>
      `${n(metrics.correctionCount)} prompts opened with a "no". Debate team material.`,
  },
  {
    id: 'parallel',
    family: 'parallel',
    tone: 'brag',
    strength: ({ metrics }) => metrics.maxParallelSessions / 3,
    text: ({ metrics }) =>
      `${n(metrics.maxParallelSessions)} agents at once at your peak. Full orchestra.`,
  },
  {
    id: 'repeated',
    family: 'craft',
    tone: 'weird',
    strength: ({ device }) => (device.mostRepeatedPrompt?.count ?? 0) / 3,
    text: ({ device }) =>
      `Your most repeated prompt came up ${n(device.mostRepeatedPrompt?.count ?? 0)} times.`,
  },
  {
    id: 'long-prompts',
    family: 'craft',
    tone: 'brag',
    strength: ({ metrics }) => metrics.avgPromptWords / 40,
    text: ({ metrics }) =>
      `Average prompt: ${n(metrics.avgPromptWords)} words. Your agent got the full brief.`,
  },
  {
    id: 'short-prompts',
    family: 'craft',
    tone: 'weird',
    strength: ({ metrics }) => metrics.shortPromptShare / 0.5,
    text: ({ metrics }) =>
      `${pct(metrics.shortPromptShare)} of your prompts were under ${R.shortPromptWords} words. Efficient.`,
  },
  {
    id: 'planning',
    family: 'craft',
    tone: 'brag',
    strength: ({ metrics }) =>
      Object.values(metrics.perTool).reduce((s, t) => s + (t?.planned ?? 0), 0) / 3,
    text: ({ metrics }) =>
      `You planned before building in ${n(Object.values(metrics.perTool).reduce((s, t) => s + (t?.planned ?? 0), 0))} sessions.`,
  },
  {
    id: 'commits',
    family: 'shipping',
    tone: 'brag',
    strength: ({ metrics }) => metrics.commitsViaAgent / 5,
    text: ({ metrics }) => `Your agent made ${n(metrics.commitsViaAgent)} commits for you.`,
  },
  {
    id: 'lines',
    family: 'shipping',
    tone: 'brag',
    strength: ({ metrics }) => metrics.linesWrittenByAgent / 500,
    text: ({ metrics }) =>
      `Your agent wrote ${n(metrics.linesWrittenByAgent)} lines of code for you.`,
  },
  {
    id: 'tool-calls',
    family: 'busy',
    tone: 'weird',
    strength: ({ metrics }) => metrics.toolCalls / 200,
    text: ({ metrics }) =>
      `Your agent ran ${n(metrics.toolCalls)} tools in ${n(metrics.activeMinutes / 60)} hours of work.`,
  },
  {
    id: 'cost',
    family: 'cost',
    tone: 'weird',
    strength: ({ metrics }) => metrics.estimatedCostUsd / 20,
    text: ({ metrics }) =>
      `Estimated $${n(metrics.estimatedCostUsd)} in tokens at list API prices.`,
  },
  {
    id: 'top-model',
    family: 'models',
    tone: 'weird',
    strength: ({ metrics }) =>
      metrics.assistantMessages >= 20 && (metrics.modelShares[0]?.share ?? 0) >= 0.5
        ? (metrics.modelShares[0]?.share ?? 0) / 0.5
        : 0,
    text: ({ metrics }) =>
      `${metrics.modelShares[0]?.model ?? 'One model'} wrote ${pct(metrics.modelShares[0]?.share ?? 0)} of your replies.`,
  },
  {
    id: 'clean-desk',
    family: 'security',
    tone: 'wholesome',
    strength: ({ metrics, device }) => (metrics.userPrompts >= 50 && secrets(device) === 0 ? 1 : 0),
    text: () => 'No secrets reached your agent. Clean desk.',
  },
];

/** Shown when fewer than three lines apply. */
const FALLBACKS: readonly Line[] = [
  {
    id: 'basics',
    family: 'basics',
    tone: 'wholesome',
    strength: () => 1,
    text: ({ metrics }) =>
      `${n(metrics.userPrompts)} prompts over ${n(metrics.activeDays)} active ${metrics.activeDays === 1 ? 'day' : 'days'}.`,
  },
  {
    id: 'basics-tools',
    family: 'basics-tools',
    tone: 'wholesome',
    strength: () => 1,
    text: ({ metrics }) => `${n(metrics.toolCalls)} tool calls by your agent.`,
  },
  {
    id: 'basics-sessions',
    family: 'basics-sessions',
    tone: 'wholesome',
    strength: () => 1,
    text: ({ metrics }) =>
      `${n(metrics.sessions)} ${metrics.sessions === 1 ? 'session' : 'sessions'} with your agent.`,
  },
];

/** 0 to 1 from a seed and an id. */
function jitter(seed: string, id: string): number {
  let h = 0x811c9dc5;
  for (const ch of `${seed}:${id}`)
    h = Math.imul(h ^ (ch.codePointAt(0) as number), 0x01000193) >>> 0;
  return h / 2 ** 32;
}

export interface PreviewLine {
  id: string;
  tone: Tone;
  text: string;
}

export function pickPreviewLines(context: PreviewContext, seed: string, count = 3): PreviewLine[] {
  const ranked = PREVIEW_LINES.map((line) => ({ line, raw: line.strength(context) }))
    .filter((x) => Number.isFinite(x.raw) && x.raw >= 1)
    .map((x) => ({ ...x, score: x.raw * (0.9 + 0.2 * jitter(seed, x.line.id)) }))
    .sort((a, b) => b.score - a.score);
  const picked: Line[] = [];
  const families = new Set<string>();
  let roasts = 0;
  for (const { line } of [...ranked, ...FALLBACKS.map((line) => ({ line }))]) {
    if (picked.length === count) break;
    if (families.has(line.family) || (line.tone === 'roast' && roasts >= 1)) continue;
    picked.push(line);
    families.add(line.family);
    if (line.tone === 'roast') roasts++;
  }
  return picked.map((line) => ({ id: line.id, tone: line.tone, text: line.text(context) }));
}
