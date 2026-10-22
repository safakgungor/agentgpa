import { daysBetween, type LocalTime, localClock } from './calendar.ts';
import { EXPOSED_SECRET_WEIGHT } from './grading/config.ts';
import { costOf } from './pricing.ts';
import type { SecretCounts } from './secrets.ts';
import {
  CALL_FLAGS,
  PROMPT_FLAGS,
  type PromptRow,
  REPLY_FLAGS,
  type Skeleton,
} from './skeleton.ts';
import { maxOf, median, share } from './stats.ts';
import { METRIC_RULES as R } from './thresholds.ts';
import type { Tool } from './types.ts';

// Metrics from the skeleton alone, so the CLI preview and the server regrade agree. Times of
// day use the machine's time zone. Prompts whose time is only approximate (Cursor transcripts)
// count everywhere except in time-of-day metrics.

export interface ToolStats {
  sessions: number;
  prompts: number;
  activeDays: number;
  observedDays: number;
  /** Sessions long enough to count for Planning, and how many of them planned first. */
  planBase: number;
  planned: number;
  marathons: number;
  capsCrises: number;
  commits: number;
  costUsd: number;
}

export interface Metrics {
  sessions: number;
  userPrompts: number;
  assistantMessages: number;
  toolCalls: number;
  subagentToolCalls: number;
  activeDays: number;
  activeMinutes: number;
  nightShare: number;
  busiestWeekday: number;
  avgPromptWords: number;
  shortPromptShare: number;
  absolutelyRightCount: number;
  sycophancyCount: number;
  apologyCount: number;
  thanksCount: number;
  capsCrisisCount: number;
  swearCount: number;
  interruptCount: number;
  correctionCount: number;
  rageRepeatCount: number;
  maxParallelSessions: number;
  /**
   * The most sessions that each had a prompt and 3 or more tool calls inside one 15-minute
   * window: agents working at the same time, not just open.
   */
  agentsAtOnce: number;
  longestRunMinutes: number;
  marathonCount: number;
  medianBlockMinutes: number;
  promptsPerActiveHour: number;
  longestStreakDays: number;
  peakHour: number;
  earlyShare: number;
  weekendShare: number;
  commitsViaAgent: number;
  prsViaAgent: number;
  linesWrittenByAgent: number;
  linesRemovedByAgent: number;
  estimatedCostUsd: number;
  /** Model calls with tokens but no list price, left out of the cost. */
  unpricedCalls: number;
  abandonedSessions: number;
  contextualPromptShare: number;
  planSessionShare: number;
  thanksPer100: number;
  hourly: number[];
  /** The period's length in days. */
  days: number;
  /**
   * Counts per local date, from the date the period starts on to the date it ends on (both
   * partial days, so a 90-day period has 91 entries).
   */
  daily: {
    from: string;
    prompts: number[];
    thanks: number[];
    capsCrises: number[];
    nightPrompts: number[];
    absolutelyRight: number[];
    apologies: number[];
    assistantMessages: number[];
  };
  modelShares: { model: string; share: number }[];
  primaryTool: Tool | 'multi' | undefined;
  perTool: Partial<Record<Tool, ToolStats>>;
  /** Counts per 30 observed days, scaled per tool and summed. */
  per30: { marathons: number; capsCrises: number; commits: number; costUsd: number };
}

/** Runs of a session's event minutes with short gaps between them. */
export function activityBlocks(
  minutes: number[],
  gap: number = R.blockGapMinutes,
): { start: number; end: number }[] {
  const sorted = [...minutes].sort((a, b) => a - b);
  const blocks: { start: number; end: number }[] = [];
  for (const m of sorted) {
    const last = blocks.at(-1);
    if (last && m - last.end <= gap) last.end = m;
    else blocks.push({ start: m, end: m });
  }
  return blocks;
}

const duration = (b: { start: number; end: number }): number => b.end - b.start + 1;

/** The index of the first value at least `x` in an ascending list. */
function lowerBound(sorted: readonly number[], x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((sorted[mid] as number) < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The minutes from which one session is busy: a window of `width` minutes starting there holds
 * at least `minPrompts` of its prompts and `minCalls` of its tool calls. Half-open runs of
 * start minutes, ascending. A window's counts only change where an event enters or leaves it,
 * so each run between those minutes is checked once.
 */
export function busyWindows(
  prompts: readonly number[],
  calls: readonly { minute: number; count: number }[],
  width: number = R.atOnceWindowMinutes,
  minPrompts: number = R.atOnceMinPrompts,
  minCalls: number = R.atOnceMinToolCalls,
): [number, number][] {
  if (prompts.length < minPrompts || calls.length === 0) return [];
  const p = [...prompts].sort((a, b) => a - b);
  const c = [...calls].sort((a, b) => a.minute - b.minute);
  const callMinutes = c.map((x) => x.minute);
  const sums = [0];
  for (const x of c) sums.push((sums.at(-1) as number) + x.count);
  const edges = new Set<number>();
  for (const m of [...p, ...callMinutes]) {
    edges.add(m - width + 1);
    edges.add(m + 1);
  }
  const starts = [...edges].sort((a, b) => a - b);
  const runs: [number, number][] = [];
  for (let i = 0; i < starts.length - 1; i++) {
    const from = starts[i] as number;
    const to = from + width;
    const promptsIn = lowerBound(p, to) - lowerBound(p, from);
    const callsIn =
      (sums[lowerBound(callMinutes, to)] as number) -
      (sums[lowerBound(callMinutes, from)] as number);
    if (promptsIn < minPrompts || callsIn < minCalls) continue;
    const next = starts[i + 1] as number;
    const last = runs.at(-1);
    if (last && last[1] === from) last[1] = next;
    else runs.push([from, next]);
  }
  return runs;
}

export function computeMetrics(skeleton: Skeleton, timeZone: string): Metrics {
  const clock = localClock(timeZone);
  const start = Date.parse(skeleton.period.start);
  const at = (minute: number): LocalTime => clock(start + minute * 60_000);
  const days = skeleton.period.days;
  const firstDate = at(0).date;
  const dates = daysBetween(firstDate, clock(Date.parse(skeleton.period.end)).date) + 1;
  const series = () => new Array<number>(dates).fill(0);
  const daily = {
    prompts: series(),
    thanks: series(),
    capsCrises: series(),
    nightPrompts: series(),
    absolutelyRight: series(),
    apologies: series(),
    assistantMessages: series(),
  };
  const addDaily = (key: keyof typeof daily, date: string): void => {
    const i = daysBetween(firstDate, date);
    if (i >= 0 && i < dates) daily[key][i] = (daily[key][i] as number) + 1;
  };

  const perTool: Partial<Record<Tool, ToolStats>> = {};
  const stats = (tool: Tool): ToolStats => {
    let t = perTool[tool];
    if (!t) {
      t = {
        sessions: 0,
        prompts: 0,
        activeDays: 0,
        observedDays: Math.min(days, skeleton.observedDays[tool] ?? days),
        planBase: 0,
        planned: 0,
        marathons: 0,
        capsCrises: 0,
        commits: 0,
        costUsd: 0,
      };
      perTool[tool] = t;
    }
    return t;
  };

  const sessionMinutes = skeleton.sessions.map(() => [] as number[]);
  const sessionPrompts = skeleton.sessions.map(() => [] as PromptRow[]);
  const sessionCalls = skeleton.sessions.map(() => [] as { minute: number; count: number }[]);
  const datesByTool = new Map<Tool, Set<string>>();
  const allDates = new Set<string>();
  const hourly = new Array<number>(24).fill(0);
  const weekdays = new Array<number>(7).fill(0);
  let timed = 0;
  let night = 0;
  let early = 0;
  let weekend = 0;
  let words = 0;
  let short = 0;
  let contextual = 0;
  const flagCount = (bit: number) => skeleton.prompts.filter((p) => p[3] & bit).length;

  for (const p of skeleton.prompts) {
    const [s, minute, w, flags] = p;
    const session = skeleton.sessions[s];
    if (!session) continue;
    sessionMinutes[s]?.push(minute);
    sessionPrompts[s]?.push(p);
    stats(session.tool).prompts++;
    if (flags & PROMPT_FLAGS.caps) stats(session.tool).capsCrises++;
    words += w;
    if (w < R.shortPromptWords) short++;
    if (w >= R.contextualPromptWords || flags & PROMPT_FLAGS.codeRef) contextual++;
    const local = at(minute);
    let dates = datesByTool.get(session.tool);
    if (!dates) {
      dates = new Set();
      datesByTool.set(session.tool, dates);
    }
    dates.add(local.date);
    allDates.add(local.date);
    addDaily('prompts', local.date);
    if (flags & PROMPT_FLAGS.thanks) addDaily('thanks', local.date);
    if (flags & PROMPT_FLAGS.caps) addDaily('capsCrises', local.date);
    if (flags & PROMPT_FLAGS.approx) continue;
    timed++;
    hourly[local.hour] = (hourly[local.hour] as number) + 1;
    weekdays[local.weekday] = (weekdays[local.weekday] as number) + 1;
    if (local.hour < R.nightEndsHour) {
      night++;
      addDaily('nightPrompts', local.date);
    }
    if (local.hour >= R.nightEndsHour && local.hour < R.earlyEndsHour) early++;
    if (local.weekday === 0 || local.weekday === 6) weekend++;
  }

  let assistantMessages = 0;
  let costUsd = 0;
  let unpriced = 0;
  const modelReplies = new Map<number, number>();
  // Rows without text can stand for several calls of one minute: `count` says how many.
  for (const [
    s,
    minute,
    model,
    input,
    output,
    cacheRead,
    cacheWrite,
    flags,
    ,
    count,
  ] of skeleton.replies) {
    const session = skeleton.sessions[s];
    if (!session) continue;
    sessionMinutes[s]?.push(minute);
    const tokens = input + output + cacheRead + cacheWrite;
    if (tokens > 0) {
      // Prices are per token, so a merged row's summed tokens cost what its calls cost.
      const cost = costOf(skeleton.models[model], { input, output, cacheRead, cacheWrite });
      if (cost === undefined) unpriced += count;
      else {
        costUsd += cost;
        stats(session.tool).costUsd += cost;
      }
    }
    if (!(flags & REPLY_FLAGS.text) || flags & REPLY_FLAGS.sidechain) continue;
    assistantMessages++;
    const date = at(minute).date;
    addDaily('assistantMessages', date);
    if (flags & REPLY_FLAGS.absolutelyRight) addDaily('absolutelyRight', date);
    if (flags & REPLY_FLAGS.apology) addDaily('apologies', date);
    if (model >= 0) modelReplies.set(model, (modelReplies.get(model) ?? 0) + 1);
  }
  const replyCount = (bit: number) =>
    skeleton.replies.filter(
      (r) => r[7] & bit && r[7] & REPLY_FLAGS.text && !(r[7] & REPLY_FLAGS.sidechain),
    ).length;

  let subagentToolCalls = 0;
  let commits = 0;
  let prs = 0;
  let linesAdded = 0;
  let linesRemoved = 0;
  let toolCalls = 0;
  for (const [s, minute, , added, flags, removed, , , count] of skeleton.tools) {
    const session = skeleton.sessions[s];
    if (!session) continue;
    sessionMinutes[s]?.push(minute);
    sessionCalls[s]?.push({ minute, count });
    toolCalls += count;
    if (flags & CALL_FLAGS.sidechain) subagentToolCalls += count;
    if (flags & CALL_FLAGS.gitCommit) {
      commits += count;
      stats(session.tool).commits += count;
    }
    if (flags & CALL_FLAGS.prCreate) prs += count;
    linesAdded += added;
    linesRemoved += removed;
  }
  for (const [s, minute] of skeleton.interrupts) sessionMinutes[s]?.push(minute);

  // Activity blocks per session, and how many overlap at once across sessions and tools.
  const durations: number[] = [];
  const edges: [number, number][] = [];
  let activeMinutes = 0;
  let abandoned = 0;
  skeleton.sessions.forEach((session, s) => {
    const blocks = activityBlocks(sessionMinutes[s] ?? []);
    const prompts = sessionPrompts[s] ?? [];
    let total = 0;
    for (const b of blocks) {
      const d = duration(b);
      durations.push(d);
      total += d;
      edges.push([b.start, 1], [b.end + 1, -1]);
      if (d >= R.marathonMinutes) stats(session.tool).marathons++;
    }
    activeMinutes += total;
    if (prompts.length > 0) stats(session.tool).sessions++;
    if (
      prompts.length > 0 &&
      prompts.length <= R.abandonedMaxPrompts &&
      total < R.abandonedUnderMinutes
    )
      abandoned++;
    if (prompts.length >= R.planMinPrompts) {
      const t = stats(session.tool);
      t.planBase++;
      const planned =
        session.planMode ||
        prompts.slice(0, R.planWithinPrompts).some((p) => p[3] & PROMPT_FLAGS.plan) ||
        prompts.some((p) => p[3] & PROMPT_FLAGS.planFile);
      if (planned) t.planned++;
    }
  });
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let running = 0;
  let maxParallel = 0;
  for (const [, delta] of edges) {
    running += delta;
    maxParallel = Math.max(maxParallel, running);
  }

  // Agents at once: sessions busy in the same window, each with its own prompt and tool calls.
  const busy: [number, number][] = [];
  skeleton.sessions.forEach((_, s) => {
    const prompts = (sessionPrompts[s] ?? []).map((p) => p[1]);
    for (const [from, to] of busyWindows(prompts, sessionCalls[s] ?? []))
      busy.push([from, 1], [to, -1]);
  });
  busy.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let working = 0;
  let atOnce = 0;
  for (const [, delta] of busy) {
    working += delta;
    atOnce = Math.max(atOnce, working);
  }

  const sortedDates = [...allDates].sort();
  let streak = 0;
  let best = 0;
  for (let i = 0; i < sortedDates.length; i++) {
    streak =
      i > 0 && daysBetween(sortedDates[i - 1] as string, sortedDates[i] as string) === 1
        ? streak + 1
        : 1;
    best = Math.max(best, streak);
  }

  for (const [tool, dates] of datesByTool) stats(tool).activeDays = dates.size;
  const tools = Object.entries(perTool) as [Tool, ToolStats][];
  for (const [, t] of tools) t.observedDays = Math.max(1, t.observedDays);
  const per30 = (pick: (t: ToolStats) => number): number =>
    tools.reduce((sum, [, t]) => sum + (pick(t) * 30) / t.observedDays, 0);
  const promptTotal = skeleton.prompts.length;
  const ranked = tools.filter(([, t]) => t.prompts > 0).sort((a, b) => b[1].prompts - a[1].prompts);
  const primaryTool =
    ranked.length === 0
      ? undefined
      : ranked.length > 1 && ranked[0]?.[1].prompts === ranked[1]?.[1].prompts
        ? 'multi'
        : ranked[0]?.[0];
  const planBase = tools.reduce((n, [, t]) => n + t.planBase, 0);
  const planned = tools.reduce((n, [, t]) => n + t.planned, 0);

  return {
    sessions: skeleton.sessions.filter((_, s) => (sessionPrompts[s]?.length ?? 0) > 0).length,
    userPrompts: promptTotal,
    assistantMessages,
    toolCalls,
    subagentToolCalls,
    activeDays: allDates.size,
    activeMinutes,
    nightShare: share(night, timed),
    busiestWeekday: weekdays.indexOf(Math.max(...weekdays)),
    avgPromptWords: share(words, promptTotal),
    shortPromptShare: share(short, promptTotal),
    absolutelyRightCount: replyCount(REPLY_FLAGS.absolutelyRight),
    sycophancyCount: replyCount(REPLY_FLAGS.sycophancy),
    apologyCount: replyCount(REPLY_FLAGS.apology),
    thanksCount: flagCount(PROMPT_FLAGS.thanks),
    capsCrisisCount: flagCount(PROMPT_FLAGS.caps),
    swearCount: flagCount(PROMPT_FLAGS.swear),
    interruptCount: skeleton.interrupts.length,
    correctionCount: flagCount(PROMPT_FLAGS.correction),
    rageRepeatCount: flagCount(PROMPT_FLAGS.repeat),
    maxParallelSessions: maxParallel,
    agentsAtOnce: atOnce,
    longestRunMinutes: maxOf(durations),
    marathonCount: durations.filter((d) => d >= R.marathonMinutes).length,
    medianBlockMinutes: median(durations),
    promptsPerActiveHour: share(promptTotal, activeMinutes / 60),
    longestStreakDays: best,
    peakHour: hourly.indexOf(Math.max(...hourly)),
    earlyShare: share(early, timed),
    weekendShare: share(weekend, timed),
    commitsViaAgent: commits,
    prsViaAgent: prs,
    linesWrittenByAgent: linesAdded,
    linesRemovedByAgent: linesRemoved,
    estimatedCostUsd: costUsd,
    unpricedCalls: unpriced,
    abandonedSessions: abandoned,
    contextualPromptShare: share(contextual, promptTotal),
    planSessionShare: share(planned, planBase),
    thanksPer100: share(flagCount(PROMPT_FLAGS.thanks), promptTotal) * 100,
    hourly,
    days,
    daily: { from: firstDate, ...daily },
    modelShares: [...modelReplies]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([model, n]) => ({
        model: skeleton.models[model] ?? 'unknown',
        share: share(n, assistantMessages),
      })),
    primaryTool,
    perTool,
    per30: {
      marathons: per30((t) => t.marathons),
      capsCrises: per30((t) => t.capsCrises),
      commits: per30((t) => t.commits),
      costUsd: per30((t) => t.costUsd),
    },
  };
}

/** Secrets per 30 observed days, for Security Hygiene: pasted ones fully, exposed ones by weight. */
export function secretsPer30(secrets: SecretCounts, metrics: Metrics): number {
  let sum = 0;
  for (const [tool, counts] of Object.entries(secrets.byTool) as [
    Tool,
    { pasted: number; exposed: number },
  ][]) {
    const observed = metrics.perTool[tool]?.observedDays ?? metrics.days;
    sum += ((counts.pasted + EXPOSED_SECRET_WEIGHT * counts.exposed) * 30) / Math.max(1, observed);
  }
  return sum;
}
