import { z } from 'zod';
import { localClock } from './calendar.ts';
import { LABEL } from './clean.ts';
import { GRADING_VERSION } from './grading/config.ts';
import type { Metrics } from './metrics.ts';
import type { QuoteKind } from './quotes.ts';
import type { Report } from './report.ts';
import { SECRET_TYPES } from './secrets.ts';
import type { Session, Tool } from './types.ts';
import { encodeSkeleton, ToolSchema, WireSkeletonSchema } from './wire.ts';

// The payload: everything that leaves the machine after the user says yes, and nothing else.
// The schema is strict, so no field can ride along unlisted, and the server parses every
// upload with this same schema before it recomputes everything from the skeleton.

/** Version of the upload payload schema. */
export const PAYLOAD_SCHEMA_VERSION = 1;

/** Every metric that is a plain number, sent so the server can compare them with its own. */
export const METRIC_SCALARS = [
  'sessions',
  'userPrompts',
  'assistantMessages',
  'toolCalls',
  'subagentToolCalls',
  'activeDays',
  'activeMinutes',
  'nightShare',
  'busiestWeekday',
  'avgPromptWords',
  'shortPromptShare',
  'absolutelyRightCount',
  'sycophancyCount',
  'apologyCount',
  'thanksCount',
  'capsCrisisCount',
  'swearCount',
  'interruptCount',
  'correctionCount',
  'rageRepeatCount',
  'maxParallelSessions',
  'longestRunMinutes',
  'marathonCount',
  'medianBlockMinutes',
  'promptsPerActiveHour',
  'longestStreakDays',
  'peakHour',
  'earlyShare',
  'weekendShare',
  'commitsViaAgent',
  'prsViaAgent',
  'linesWrittenByAgent',
  'linesRemovedByAgent',
  'estimatedCostUsd',
  'unpricedCalls',
  'abandonedSessions',
  'contextualPromptShare',
  'planSessionShare',
  'thanksPer100',
  'days',
] as const satisfies readonly (keyof Metrics)[];

export const QUOTE_KINDS = [
  'most_repeated',
  'caps_crisis',
  'saltiest',
  'cryptic_candidate',
] as const satisfies readonly QuoteKind[];

/** Why the CLI left a session out (the file checks); only these names can be sent. */
export const FORENSIC_REASONS = ['created-after-last-event'] as const;
export type ForensicReason = (typeof FORENSIC_REASONS)[number];

const number = z.number().finite();
const count = z.number().int().min(0).safe();
const share = z.number().min(0).max(1);
const label = z.string().regex(LABEL);
const series = z.array(count).max(400);

const ToolStatsSchema = z.strictObject({
  sessions: count,
  prompts: count,
  activeDays: count,
  observedDays: count,
  planBase: count,
  planned: count,
  marathons: count,
  capsCrises: count,
  commits: count,
  costUsd: number.min(0),
});

const MetricsSchema = z.strictObject({
  ...(Object.fromEntries(METRIC_SCALARS.map((key) => [key, number])) as Record<
    (typeof METRIC_SCALARS)[number],
    typeof number
  >),
  perTool: z.partialRecord(ToolSchema, ToolStatsSchema),
  per30: z.strictObject({
    marathons: number,
    capsCrises: number,
    commits: number,
    costUsd: number,
  }),
});

export const PayloadSchema = z.strictObject({
  schemaVersion: z.literal(PAYLOAD_SCHEMA_VERSION),
  gradingVersion: z.literal(GRADING_VERSION),
  cliVersion: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.]{1,32})?$/),
  generatedAt: z.iso.datetime(),
  period: z.strictObject({
    start: z.iso.datetime(),
    end: z.iso.datetime(),
    days: count.min(1).max(366),
  }),
  observedDays: z.partialRecord(ToolSchema, count.min(1).max(366)),
  tools: z
    .array(
      z.strictObject({
        tool: ToolSchema,
        found: z.boolean(),
        readable: z.boolean(),
        sessions: count,
        userPrompts: count,
      }),
    )
    .max(3),
  allTime: z
    .array(
      z.strictObject({
        tool: ToolSchema,
        firstSessionAt: z.iso.datetime(),
        sessions: count,
        userPrompts: count,
      }),
    )
    .max(3),
  primaryTool: z.union([ToolSchema, z.literal('multi')]),
  promptLanguage: z.string().regex(/^[a-z]{3}$/),
  counts: z.strictObject({
    sessions: count,
    userPrompts: count,
    assistantMessages: count,
    toolCalls: count,
    activeDays: count,
    activeMinutes: count,
  }),
  metrics: MetricsSchema,
  secrets: z.strictObject({
    pasted: count,
    exposedViaTools: count,
    types: z.partialRecord(z.enum(SECRET_TYPES as unknown as [string, ...string[]]), count),
    byTool: z.partialRecord(ToolSchema, z.strictObject({ pasted: count, exposed: count })),
  }),
  consents: z.strictObject({ researchAggregates: z.boolean(), deepRead: z.boolean() }),
  distributions: z.strictObject({
    hourly: z.array(count).length(24),
    daily: z.strictObject({
      from: z.iso.date(),
      prompts: series,
      thanks: series,
      capsCrises: series,
      nightPrompts: series,
      absolutelyRight: series,
      apologies: series,
      assistantMessages: series,
    }),
    modelShares: z.array(z.strictObject({ model: label, share })).max(5),
    topTools: z.array(z.strictObject({ name: label, count })).max(5),
  }),
  quotes: z
    .array(
      z.strictObject({
        id: z.string().regex(/^q[1-5]$/),
        kind: z.enum(QUOTE_KINDS),
        text: z.string().min(1).max(400),
        hour: count.max(23),
        weekday: count.max(6),
        prompt: count,
        count: count.optional(),
      }),
    )
    .max(5),
  client: z.strictObject({
    os: z.enum(['darwin', 'linux', 'win32']),
    runMode: z.enum(['terminal', 'agent']),
    tz: z.string().regex(/^[A-Za-z][A-Za-z0-9_+/-]{0,63}$/),
    origin: z.enum(['default', 'custom']),
    /** Whether the CLI read the tools' default locations, or a folder given with --root. */
    root: z.enum(['default', 'custom']),
  }),
  runToken: z
    .string()
    .regex(/^[A-Za-z0-9._~-]{16,512}$/)
    .optional(),
  skeleton: WireSkeletonSchema,
  fingerprints: z.array(z.string().regex(/^00[0-9a-f]{14}$/)).max(512),
  forensics: z.strictObject({
    excludedSessions: count,
    reasons: z.partialRecord(z.enum(FORENSIC_REASONS), count),
  }),
});

export type Payload = z.infer<typeof PayloadSchema>;

export interface PayloadInput {
  report: Report;
  /** Every parsed session on the machine, for the all-time counts. */
  sessions: readonly Session[];
  tools: readonly { tool: Tool; found: boolean; readable: boolean }[];
  cliVersion: string;
  generatedAt: number;
  timeZone: string;
  os: 'darwin' | 'linux' | 'win32';
  runMode: 'terminal' | 'agent';
  origin: 'default' | 'custom';
  /** `custom` when the sessions came from a folder given with --root. */
  root: 'default' | 'custom';
  consents: { researchAggregates: boolean; deepRead: boolean };
  /** Quote numbers (1 to 5) the user dropped. */
  dropQuotes?: readonly number[];
  runToken?: string;
  forensics: { excludedSessions: number; reasons: Partial<Record<ForensicReason, number>> };
}

/** The payload for a report; throws when anything in it breaks the schema. */
export function buildPayload(input: PayloadInput): Payload {
  const { report } = input;
  const m = report.metrics;
  if (m.primaryTool === undefined) throw new Error('a report without prompts has nothing to send');
  const clock = localClock(input.timeZone);
  const start = Date.parse(report.skeleton.period.start);
  const dropped = new Set(input.dropQuotes ?? []);
  const allTime = new Map<Tool, { first: number; sessions: number; userPrompts: number }>();
  for (const s of input.sessions) {
    const entry = allTime.get(s.tool) ?? { first: s.startedAt, sessions: 0, userPrompts: 0 };
    entry.first = Math.min(entry.first, s.startedAt);
    entry.sessions++;
    entry.userPrompts += s.events.filter((e) => e.kind === 'user_prompt').length;
    allTime.set(s.tool, entry);
  }
  const { hourly, daily, modelShares, perTool, per30 } = m;
  const payload: Payload = {
    schemaVersion: PAYLOAD_SCHEMA_VERSION,
    gradingVersion: GRADING_VERSION,
    cliVersion: input.cliVersion,
    generatedAt: new Date(input.generatedAt).toISOString(),
    period: report.skeleton.period,
    observedDays: report.skeleton.observedDays,
    tools: input.tools.map((t) => ({
      ...t,
      sessions: perTool[t.tool]?.sessions ?? 0,
      userPrompts: perTool[t.tool]?.prompts ?? 0,
    })),
    allTime: [...allTime].map(([tool, a]) => ({
      tool,
      firstSessionAt: new Date(a.first).toISOString(),
      sessions: a.sessions,
      userPrompts: a.userPrompts,
    })),
    primaryTool: m.primaryTool,
    promptLanguage: report.device.promptLanguage,
    counts: {
      sessions: m.sessions,
      userPrompts: m.userPrompts,
      assistantMessages: m.assistantMessages,
      toolCalls: m.toolCalls,
      activeDays: m.activeDays,
      activeMinutes: m.activeMinutes,
    },
    metrics: {
      ...(Object.fromEntries(METRIC_SCALARS.map((key) => [key, m[key]])) as Record<
        (typeof METRIC_SCALARS)[number],
        number
      >),
      perTool,
      per30,
    },
    secrets: report.device.secrets,
    consents: input.consents,
    distributions: { hourly, daily, modelShares, topTools: report.device.topTools },
    quotes: report.quotes
      .map((q, i) => ({ q, id: i + 1 }))
      .filter(({ id }) => !dropped.has(id))
      .map(({ q, id }) => {
        const t = clock(start + ((report.skeleton.prompts[q.prompt]?.[1] ?? 0) as number) * 60_000);
        return {
          id: `q${id}`,
          kind: q.kind,
          text: q.text,
          hour: t.hour,
          weekday: t.weekday,
          prompt: q.prompt,
          ...(q.count === undefined ? {} : { count: q.count }),
        };
      }),
    client: {
      os: input.os,
      runMode: input.runMode,
      tz: input.timeZone,
      origin: input.origin,
      root: input.root,
    },
    skeleton: encodeSkeleton(report.skeleton),
    fingerprints: report.device.fingerprints,
    forensics: input.forensics,
  };
  if (input.runToken) payload.runToken = input.runToken;
  return PayloadSchema.parse(payload);
}
