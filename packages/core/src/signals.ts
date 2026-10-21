import { daysBetween, type LocalTime, localClock } from './calendar.ts';
import { LANG_CATEGORIES, type LangCategory } from './files.ts';
import { INTERRUPT_WEIGHT } from './grading/config.ts';
import { activityBlocks, type Metrics } from './metrics.ts';
import {
  type Autonomy,
  CALL_FLAGS,
  CATEGORIES,
  type Entrypoint,
  PROMPT_FLAGS,
  REPLY_FLAGS,
  type Skeleton,
} from './skeleton.ts';
import { maxOf, median, percentile, share } from './stats.ts';
import { METRIC_RULES, SIGNAL_RULES as R } from './thresholds.ts';
import type { Tool } from './types.ts';

// Signals feed the personal layer only: they never change a grade, a rank, an archetype or an
// activity. They come from the skeleton alone, so the server can recompute them. Tool and reply
// rows can stand for several calls (`count`), and every total here counts calls, not rows.

export interface Signals {
  clockCenter: { minute: number; spreadMinutes: number } | undefined;
  shiftStart: number | undefined;
  shiftEnd: number | undefined;
  biggestDay: { date: string; weekday: number; prompts: number } | undefined;
  biggestHour: { date: string; hour: number; prompts: number } | undefined;
  burstiness: number;
  longestBreakDays: number;
  comebacks: number;
  lunchShare: number;
  threeAmPrompts: number;
  sundayNightShare: number;
  weekdayLead: { weekday: number; lead: number } | undefined;
  fridayDeploys: number;
  newYearPrompt: boolean;
  hoursCovered: number;
  promptsPerSession: number;
  oneAndDoneShare: number;
  longestSessionPrompts: number;
  compactions: number;
  builtinCommands: Record<string, number>;
  thanksByTool: Partial<Record<Tool, number>>;
  pleaseCount: number;
  praiseCount: number;
  userSorryCount: number;
  laughCount: number;
  emojiPrompts: number;
  exclaimShare: number;
  swearPeakHour: number | undefined;
  meltdowns: number;
  forgiveMinutes: number | undefined;
  zenRun: number;
  movesPerPrompt: { median: number; p90: number };
  /** The most tool calls the main agent made between two prompts. */
  longestSoloRun: number;
  nudgeShare: number;
  questionShare: number;
  bounceBack: number | undefined;
  declinedCalls: number;
  /** Share of sessions per permission setting, where the tool records one. */
  autonomyMix: Partial<Record<Autonomy, number>>;
  todoLists: number;
  subagentRuns: number;
  agentQuestions: number;
  thinkRequests: number;
  parallelPeak: { sessions: number; date: string } | undefined;
  pastedErrorShare: number;
  screenshots: number;
  linkShare: number;
  codeBlockShare: number;
  longestPromptWords: number;
  oneWordShare: number;
  refusals: number;
  replyTokens: { median: number; longest: number };
  toolErrorRate: number;
  apologyPer100: number;
  linesRemoved: number;
  netLines: number;
  /** Failing test runs followed by a passing one in the same session. */
  redToGreen: number;
  testRuns: number;
  builds: number;
  deploys: number;
  installs: number;
  lintRuns: number;
  readEditRatio: number | undefined;
  /** Share of edited files per language category, from their extensions. */
  stackMix: Partial<Record<LangCategory, number>>;
  languagesTouched: number;
  modelSwitches: number;
  topModelShare: number;
  /** Share of sessions per entry point, where the tool records one. */
  entrypointMix: Partial<Record<Entrypoint, number>>;
  mcpCalls: number;
  webCalls: number;
  cacheHitRate: number;
  tokensPerPrompt: number;
  costPerCommit: number | undefined;
  /** Share of prompts per language, from prompts long enough to tell. */
  languageMix: Record<string, number>;
  /** Languages with enough of those prompts, most used first. */
  languagesUsed: string[];
  thanksLanguages: string[];
  /** Agent reads of env, key and credential files. */
  envReads: number;
  bypassShare: number;
  /** Change of the rate course inputs from the first 30 days of the period to the last 30. */
  glowUp: { manners: number; composure: number; promptCraft: number; focus: number } | undefined;
}

const CAT = (name: (typeof CATEGORIES)[number]) => CATEGORIES.indexOf(name);
const MOOD = PROMPT_FLAGS.caps | PROMPT_FLAGS.swear | PROMPT_FLAGS.correction;

/** Shares of each key, from counts. */
function shares<K extends string>(counts: Map<K, number>): Partial<Record<K, number>> {
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const out: Partial<Record<K, number>> = {};
  for (const [key, n] of [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))) {
    out[key] = share(n, total);
  }
  return out;
}

const bump = <K>(map: Map<K, number>, key: K, n = 1) => map.set(key, (map.get(key) ?? 0) + n);

export function computeSignals(skeleton: Skeleton, metrics: Metrics, timeZone: string): Signals {
  const clock = localClock(timeZone);
  const start = Date.parse(skeleton.period.start);
  const at = (minute: number): LocalTime => clock(start + minute * 60_000);
  const prompts = [...skeleton.prompts].sort((a, b) => a[1] - b[1] || a[5] - b[5]);
  const timed = prompts.filter((p) => !(p[3] & PROMPT_FLAGS.approx));
  const locals = timed.map((p) => ({ p, t: at(p[1]) }));
  const promptCount = (bit: number) => prompts.filter((p) => p[3] & bit).length;

  // Rhythm.
  let sin = 0;
  let cos = 0;
  for (const { t } of locals) {
    const angle = ((t.hour * 60 + t.minute) / 1440) * 2 * Math.PI;
    sin += Math.sin(angle);
    cos += Math.cos(angle);
  }
  const r = locals.length ? Math.sqrt(sin * sin + cos * cos) / locals.length : 0;
  const clockCenter = locals.length
    ? {
        minute: Math.round(((Math.atan2(sin, cos) / (2 * Math.PI)) * 1440 + 1440) % 1440),
        spreadMinutes: Math.round(
          (Math.sqrt(-2 * Math.log(Math.max(r, 1e-9))) / (2 * Math.PI)) * 1440,
        ),
      }
    : undefined;
  const byDate = new Map<string, { first: number; last: number; count: number; weekday: number }>();
  const byHour = new Map<string, { date: string; hour: number; count: number }>();
  for (const { t } of locals) {
    const m = t.hour * 60 + t.minute;
    const day = byDate.get(t.date) ?? { first: m, last: m, count: 0, weekday: t.weekday };
    day.first = Math.min(day.first, m);
    day.last = Math.max(day.last, m);
    day.count++;
    byDate.set(t.date, day);
    const key = `${t.date} ${t.hour}`;
    const hour = byHour.get(key) ?? { date: t.date, hour: t.hour, count: 0 };
    hour.count++;
    byHour.set(key, hour);
  }
  const days = [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const biggest = [...byDate.entries()].sort(
    (a, b) => b[1].count - a[1].count || (a[0] < b[0] ? -1 : 1),
  )[0];
  const biggestHour = [...byHour.values()].sort(
    (a, b) => b.count - a.count || (a.date < b.date ? -1 : 1),
  )[0];
  const topDays = Math.max(1, Math.ceil(days.length * R.burstTopDays));
  const busiest = [...days.map(([, d]) => d.count)].sort((a, b) => b - a).slice(0, topDays);
  let longestBreak = 0;
  let comebacks = 0;
  for (let i = 1; i < days.length; i++) {
    const gap = daysBetween(days[i - 1]?.[0] as string, days[i]?.[0] as string) - 1;
    longestBreak = Math.max(longestBreak, gap);
    if (gap >= R.comebackDays) comebacks++;
  }
  const weekdays = new Array<number>(7).fill(0);
  for (const { t } of locals) weekdays[t.weekday] = (weekdays[t.weekday] as number) + 1;
  const rankedDays = weekdays.map((n, d) => [d, n] as const).sort((a, b) => b[1] - a[1]);
  const count = (test: (t: LocalTime) => boolean) => locals.filter(({ t }) => test(t)).length;

  // Rows grouped by session once, so the per-session passes stay linear.
  const group = <T extends readonly number[]>(rows: readonly T[]): T[][] => {
    const out = skeleton.sessions.map(() => [] as T[]);
    for (const row of rows) out[row[0] as number]?.push(row);
    return out;
  };
  const promptsBySession = group(prompts);
  const toolsBySession = group(skeleton.tools).map((rows) => rows.sort((a, b) => a[7] - b[7]));
  const repliesBySession = group(skeleton.replies);

  // Sessions.
  const perSession = skeleton.sessions.map((_, s) => promptsBySession[s]?.length ?? 0);
  const edited = new Set<number>();
  const todo = new Set<number>();
  for (const [s, , category, , flags] of skeleton.tools) {
    if (category === CAT('Edit') || category === CAT('Write') || flags & CALL_FLAGS.gitCommit)
      edited.add(s);
    if (category === CAT('Todo')) todo.add(s);
  }
  const withPrompts = perSession.filter((n) => n > 0);
  const oneAndDone = perSession.filter((n, s) => (n === 1 || n === 2) && edited.has(s)).length;
  const builtinCommands: Record<string, number> = Object.create(null);
  const autonomy = new Map<Autonomy, number>();
  const entrypoints = new Map<Entrypoint, number>();
  for (const s of skeleton.sessions) {
    for (const [k, v] of Object.entries(s.builtinCommands))
      builtinCommands[k] = (builtinCommands[k] ?? 0) + v;
    if (s.autonomy) bump(autonomy, s.autonomy);
    if (s.entrypoint) bump(entrypoints, s.entrypoint);
  }
  const withAutonomy = [...autonomy.values()].reduce((a, b) => a + b, 0);

  // Tone.
  const thanksByTool: Partial<Record<Tool, number>> = {};
  for (const [tool, t] of Object.entries(metrics.perTool) as [
    Tool,
    NonNullable<Metrics['perTool'][Tool]>,
  ][]) {
    const thanks = prompts.filter(
      (p) => skeleton.sessions[p[0]]?.tool === tool && p[3] & PROMPT_FLAGS.thanks,
    ).length;
    thanksByTool[tool] = t.prompts ? (thanks / t.prompts) * 100 : 0;
  }
  const swearHours = new Array<number>(24).fill(0);
  for (const { p, t } of locals)
    if (p[3] & PROMPT_FLAGS.swear) swearHours[t.hour] = (swearHours[t.hour] as number) + 1;
  const maxSwear = maxOf(swearHours);
  const moody = prompts.filter((p) => p[3] & MOOD);
  let meltdowns = 0;
  const meltdownEnds: number[] = [];
  const span = R.meltdownPrompts - 1;
  for (let i = 0; i + span < moody.length; ) {
    if ((moody[i + span]?.[1] as number) - (moody[i]?.[1] as number) <= R.meltdownMinutes) {
      meltdowns++;
      let j = i + span;
      while (
        j + 1 < moody.length &&
        (moody[j + 1]?.[1] as number) - (moody[i]?.[1] as number) <= R.meltdownMinutes
      )
        j++;
      meltdownEnds.push(moody[j]?.[1] as number);
      i = j + 1;
    } else i++;
  }
  const thanksMinutes = prompts.filter((p) => p[3] & PROMPT_FLAGS.thanks).map((p) => p[1]);
  const forgive = meltdownEnds
    .map((end) => thanksMinutes.find((m) => m > end))
    .map((m, i) => (m === undefined ? undefined : m - (meltdownEnds[i] as number)))
    .filter((m): m is number => m !== undefined);
  let zen = 0;
  let run = 0;
  for (const p of prompts) {
    run = p[3] & MOOD ? 0 : run + 1;
    zen = Math.max(zen, run);
  }

  // Collaboration: the main agent's tool calls between one prompt and the next (by seq).
  const moves: number[] = [];
  const bounce: number[] = [];
  let redToGreen = 0;
  skeleton.sessions.forEach((_, s) => {
    const own = [...(promptsBySession[s] ?? [])].sort((a, b) => a[5] - b[5]);
    const tools = toolsBySession[s] ?? [];
    const main = tools.filter((c) => !(c[4] & CALL_FLAGS.sidechain));
    own.forEach((p, i) => {
      const next = own[i + 1]?.[5] ?? Number.POSITIVE_INFINITY;
      moves.push(main.filter((c) => c[7] > p[5] && c[7] < next).reduce((n, c) => n + c[8], 0));
      if (p[3] & PROMPT_FLAGS.correction) {
        const after = own.slice(i + 1).findIndex((q) => !(q[3] & PROMPT_FLAGS.correction));
        if (after >= 0) bounce.push(after + 1);
      }
    });
    let failing = false;
    for (const c of tools) {
      if (c[4] & CALL_FLAGS.testFail) failing = true;
      else if (c[4] & CALL_FLAGS.testPass && failing) {
        redToGreen++;
        failing = false;
      }
    }
  });
  const blocks: { start: number; end: number }[] = [];
  skeleton.sessions.forEach((_, s) => {
    const minutes = [
      ...(promptsBySession[s] ?? []).map((p) => p[1]),
      ...(repliesBySession[s] ?? []).map((x) => x[1]),
      ...(toolsBySession[s] ?? []).map((x) => x[1]),
    ];
    for (const b of activityBlocks(minutes)) blocks.push(b);
  });
  const edges = blocks
    .flatMap((b) => [[b.start, 1] as const, [b.end + 1, -1] as const])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let open = 0;
  let peak: { sessions: number; minute: number } | undefined;
  for (const [minute, delta] of edges) {
    open += delta;
    if (!peak || open > peak.sessions) peak = { sessions: open, minute };
  }

  // Craft, agent, shipping, models and cost.
  const words = prompts.map((p) => p[2]);
  const textReplies = skeleton.replies.filter(
    (x) => x[7] & REPLY_FLAGS.text && !(x[7] & REPLY_FLAGS.sidechain),
  );
  const outputs = textReplies.map((x) => x[4]).filter((n) => n > 0);
  const calls = skeleton.tools;
  const callsWhere = (test: (c: (typeof calls)[number]) => boolean) =>
    calls.reduce((n, c) => (test(c) ? n + c[8] : n), 0);
  const allCalls = callsWhere(() => true);
  const flagged = (bit: number) => callsWhere((c) => (c[4] & bit) !== 0);
  const inCategory = (...names: (typeof CATEGORIES)[number][]) =>
    callsWhere((c) => names.some((n) => c[2] === CAT(n)));
  const edits = inCategory('Edit', 'Write');
  const stack = new Map<LangCategory, number>();
  for (const c of calls) {
    const editing = c[2] === CAT('Edit') || c[2] === CAT('Write') || c[2] === CAT('Notebook');
    const lang = LANG_CATEGORIES[c[6]];
    if (editing && lang) bump(stack, lang, c[8]);
  }
  let switches = 0;
  for (const rows of repliesBySession) {
    let last = -1;
    for (const x of rows) {
      if (!(x[7] & REPLY_FLAGS.text) || x[7] & REPLY_FLAGS.sidechain || x[2] < 0) continue;
      if (last >= 0 && x[2] !== last) switches++;
      last = x[2];
    }
  }
  let input = 0;
  let cacheRead = 0;
  let allTokens = 0;
  for (const x of skeleton.replies) {
    input += x[3];
    cacheRead += x[5];
    allTokens += x[3] + x[4] + x[5] + x[6];
  }

  // Language.
  const languages = new Map<string, number>();
  const thanksIn = new Set<string>();
  for (const p of prompts) {
    const code = skeleton.langs[p[4]];
    if (!code) continue;
    bump(languages, code);
    if (p[3] & PROMPT_FLAGS.thanks) thanksIn.add(code);
  }
  const languageMix = shares(languages) as Record<string, number>;

  return {
    clockCenter,
    shiftStart: days.length ? median(days.map(([, d]) => d.first)) : undefined,
    shiftEnd: days.length ? median(days.map(([, d]) => d.last)) : undefined,
    biggestDay: biggest
      ? { date: biggest[0], weekday: biggest[1].weekday, prompts: biggest[1].count }
      : undefined,
    biggestHour: biggestHour
      ? { date: biggestHour.date, hour: biggestHour.hour, prompts: biggestHour.count }
      : undefined,
    burstiness: share(
      busiest.reduce((s, n) => s + n, 0),
      locals.length,
    ),
    longestBreakDays: longestBreak,
    comebacks,
    lunchShare: share(
      count((t) => (R.lunchHours as readonly number[]).includes(t.hour)),
      locals.length,
    ),
    threeAmPrompts: count((t) => t.hour === 3),
    sundayNightShare: share(
      count((t) => t.weekday === 0 && t.hour >= R.sundayNightFromHour),
      locals.length,
    ),
    weekdayLead: locals.length
      ? {
          weekday: rankedDays[0]?.[0] ?? 0,
          lead: share(rankedDays[0]?.[1] ?? 0, Math.max(1, rankedDays[1]?.[1] ?? 0)),
        }
      : undefined,
    fridayDeploys: callsWhere((c) => {
      if (!(c[4] & CALL_FLAGS.deploy) || c[4] & CALL_FLAGS.approx) return false;
      const t = at(c[1]);
      return t.weekday === 5 && t.hour >= R.fridayDeployFromHour;
    }),
    newYearPrompt: locals.some(
      ({ t }) =>
        (t.month === 12 && t.day === 31 && t.hour === 23 && t.minute >= 60 - R.newYearMinutes) ||
        (t.month === 1 && t.day === 1 && t.hour === 0 && t.minute <= R.newYearMinutes),
    ),
    hoursCovered: new Set(locals.map(({ t }) => t.hour)).size,
    promptsPerSession: median(withPrompts),
    oneAndDoneShare: share(oneAndDone, withPrompts.length),
    longestSessionPrompts: maxOf(withPrompts),
    compactions: skeleton.sessions.reduce((n, s) => n + s.compactions, 0),
    builtinCommands,
    thanksByTool,
    pleaseCount: promptCount(PROMPT_FLAGS.please),
    praiseCount: promptCount(PROMPT_FLAGS.praise),
    userSorryCount: promptCount(PROMPT_FLAGS.sorry),
    laughCount: promptCount(PROMPT_FLAGS.laugh),
    emojiPrompts: promptCount(PROMPT_FLAGS.emoji),
    exclaimShare: share(promptCount(PROMPT_FLAGS.exclaim), prompts.length),
    swearPeakHour: maxSwear > 0 ? swearHours.indexOf(maxSwear) : undefined,
    meltdowns,
    forgiveMinutes: forgive.length ? median(forgive) : undefined,
    zenRun: zen,
    movesPerPrompt: { median: median(moves), p90: percentile(moves, 0.9) },
    longestSoloRun: maxOf(moves),
    nudgeShare: share(promptCount(PROMPT_FLAGS.nudge), prompts.length),
    questionShare: share(promptCount(PROMPT_FLAGS.question), prompts.length),
    bounceBack: bounce.length ? median(bounce) : undefined,
    declinedCalls: flagged(CALL_FLAGS.declined),
    autonomyMix: shares(autonomy),
    todoLists: todo.size,
    subagentRuns: callsWhere((c) => c[2] === CAT('Task') && !(c[4] & CALL_FLAGS.sidechain)),
    agentQuestions: textReplies.filter((x) => x[7] & REPLY_FLAGS.asksUser).length,
    thinkRequests: promptCount(PROMPT_FLAGS.think),
    parallelPeak:
      peak && peak.sessions > 0
        ? { sessions: peak.sessions, date: at(peak.minute).date }
        : undefined,
    pastedErrorShare: share(promptCount(PROMPT_FLAGS.pastedError), prompts.length),
    screenshots: promptCount(PROMPT_FLAGS.image),
    linkShare: share(promptCount(PROMPT_FLAGS.url), prompts.length),
    codeBlockShare: share(promptCount(PROMPT_FLAGS.codeBlock), prompts.length),
    longestPromptWords: maxOf(words),
    oneWordShare: share(words.filter((w) => w === 1).length, words.length),
    refusals: textReplies.filter((x) => x[7] & REPLY_FLAGS.refusal).length,
    replyTokens: { median: median(outputs), longest: maxOf(outputs) },
    toolErrorRate: share(flagged(CALL_FLAGS.error), allCalls),
    apologyPer100: share(metrics.apologyCount, metrics.assistantMessages) * 100,
    linesRemoved: metrics.linesRemovedByAgent,
    netLines: metrics.linesWrittenByAgent - metrics.linesRemovedByAgent,
    redToGreen,
    testRuns: flagged(CALL_FLAGS.test),
    builds: flagged(CALL_FLAGS.build),
    deploys: flagged(CALL_FLAGS.deploy),
    installs: flagged(CALL_FLAGS.install),
    lintRuns: flagged(CALL_FLAGS.lint),
    readEditRatio: edits ? inCategory('Read', 'Search') / edits : undefined,
    stackMix: shares(stack),
    languagesTouched: stack.size,
    modelSwitches: switches,
    topModelShare: metrics.modelShares[0]?.share ?? 0,
    entrypointMix: shares(entrypoints),
    mcpCalls: inCategory('MCP'),
    webCalls: inCategory('Web'),
    cacheHitRate: share(cacheRead, input + cacheRead),
    tokensPerPrompt: share(allTokens, metrics.userPrompts),
    costPerCommit:
      metrics.commitsViaAgent > 0 ? metrics.estimatedCostUsd / metrics.commitsViaAgent : undefined,
    languageMix,
    languagesUsed: Object.entries(languageMix)
      .filter(([, s]) => s >= R.languageUsedShare)
      .map(([code]) => code),
    thanksLanguages: [...thanksIn].sort(),
    envReads: flagged(CALL_FLAGS.sensitiveFile),
    bypassShare: share(autonomy.get('bypass') ?? 0, withAutonomy),
    glowUp: glowUp(skeleton, metrics),
  };
}

/** Rate course inputs over the first and the last days of the period. */
function glowUp(skeleton: Skeleton, metrics: Metrics): Signals['glowUp'] {
  const g = R.glowUp;
  if (metrics.activeDays < g.minActiveDays || skeleton.period.days < g.minPeriodDays)
    return undefined;
  const window = g.windowDays * 1440;
  const last = skeleton.period.days * 1440;
  const rates = (from: number, to: number) => {
    const ps = skeleton.prompts.filter((p) => p[1] >= from && p[1] < to);
    const n = ps.length;
    if (n < g.minPromptsPerWindow) return undefined;
    const per100 = (bits: number) => (ps.filter((p) => p[3] & bits).length / n) * 100;
    const interrupts = skeleton.interrupts.filter((x) => x[1] >= from && x[1] < to).length;
    return {
      manners: per100(PROMPT_FLAGS.thanks),
      composure:
        per100(PROMPT_FLAGS.caps) + per100(PROMPT_FLAGS.swear) + per100(PROMPT_FLAGS.repeat),
      promptCraft:
        ps.filter((p) => p[2] >= METRIC_RULES.contextualPromptWords || p[3] & PROMPT_FLAGS.codeRef)
          .length / n,
      focus: per100(PROMPT_FLAGS.correction) + ((INTERRUPT_WEIGHT * interrupts) / n) * 100,
    };
  };
  const first = rates(0, window);
  const recent = rates(last - window, last);
  if (!first || !recent) return undefined;
  return {
    manners: recent.manners - first.manners,
    composure: recent.composure - first.composure,
    promptCraft: recent.promptCraft - first.promptCraft,
    focus: recent.focus - first.focus,
  };
}
