import type { Metrics } from './metrics.ts';
import type { SecretCounts } from './secrets.ts';

// Activities: a report earns up to 3 of these 14, strongest evidence first. Evidence is the
// metric divided by its threshold, so 1 is just earned and 2 is twice the bar. Thresholds are
// data; count thresholds are per 30 observed days.

export interface Activity {
  id: string;
  name: string;
  /** The threshold the evidence is measured against. */
  threshold: number;
}

export const ACTIVITIES = {
  nightShift: { id: 'night-shift-society', name: 'Night Shift Society', threshold: 0.35 },
  earlyBird: { id: 'early-bird-club', name: 'Early Bird Club', threshold: 0.2 },
  marathon: { id: 'marathon-club', name: 'Marathon Club', threshold: 3 },
  streak: { id: 'streak-team', name: 'Streak Team', threshold: 7 },
  weekend: { id: 'weekend-warriors', name: 'Weekend Warriors', threshold: 0.3 },
  context: { id: 'context-club', name: 'Context Club', threshold: 0.7 },
  planning: { id: 'planning-committee', name: 'Planning Committee', threshold: 0.4 },
  debate: { id: 'debate-team', name: 'Debate Team', threshold: 30 },
  orchestra: { id: 'orchestra', name: 'Orchestra', threshold: 3 },
  twoTool: { id: 'two-tool-athlete', name: 'Two-Tool Athlete', threshold: 0.2 },
  polite: { id: 'polite-society', name: 'Polite Society', threshold: 6 },
  drama: { id: 'drama-club', name: 'Drama Club', threshold: 20 },
  cleanDesk: { id: 'clean-desk-club', name: 'Clean Desk Club', threshold: 1 },
  shipping: { id: 'shipping-crew', name: 'Shipping Crew', threshold: 50 },
} as const satisfies Record<string, Activity>;

export const MAX_ACTIVITIES = 3;

export interface EarnedActivity extends Activity {
  evidence: number;
}

export function pickActivities(metrics: Metrics, secrets: SecretCounts): EarnedActivity[] {
  const a = ACTIVITIES;
  const prompts = metrics.userPrompts;
  const sessions = Object.values(metrics.perTool).map((t) => t?.sessions ?? 0);
  const totalSessions = sessions.reduce((s, n) => s + n, 0);
  const shares = sessions.map((n) => (totalSessions ? n / totalSessions : 0)).sort((x, y) => y - x);
  const secondTool = (shares[1] ?? 0) >= a.twoTool.threshold ? (shares[1] ?? 0) : 0;
  const evidence: [Activity, number][] = [
    [a.nightShift, metrics.nightShare / a.nightShift.threshold],
    [a.earlyBird, metrics.earlyShare / a.earlyBird.threshold],
    [a.marathon, metrics.per30.marathons / a.marathon.threshold],
    [a.streak, metrics.longestStreakDays / a.streak.threshold],
    [a.weekend, metrics.weekendShare / a.weekend.threshold],
    [a.context, metrics.contextualPromptShare / a.context.threshold],
    [a.planning, metrics.planSessionShare / a.planning.threshold],
    [a.debate, (prompts ? (metrics.correctionCount / prompts) * 100 : 0) / a.debate.threshold],
    [a.orchestra, metrics.maxParallelSessions / a.orchestra.threshold],
    [a.twoTool, secondTool / a.twoTool.threshold],
    [a.polite, metrics.thanksPer100 / a.polite.threshold],
    [a.drama, metrics.per30.capsCrises / a.drama.threshold],
    [a.cleanDesk, prompts > 0 && secrets.pasted + secrets.exposedViaTools === 0 ? 1 : 0],
    [a.shipping, metrics.per30.commits / a.shipping.threshold],
  ];
  return evidence
    .filter(([, e]) => e >= 1)
    .map(([activity, e], order) => ({ activity, e, order }))
    .sort((x, y) => y.e - x.e || x.order - y.order)
    .slice(0, MAX_ACTIVITIES)
    .map(({ activity, e }) => ({ ...activity, evidence: e }));
}
