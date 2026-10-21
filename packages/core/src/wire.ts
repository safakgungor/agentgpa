import { z } from 'zod';
import { LABEL } from './clean.ts';
import {
  type InterruptRow,
  type PromptRow,
  type ReplyRow,
  SKELETON_VERSION,
  type Skeleton,
  type ToolRow,
} from './skeleton.ts';

// The skeleton as it travels: one column per field, with session, minute and seq stored as
// differences from the row before. Rows come out of the builder in session and time order, so
// those columns become small numbers that compress well. Decoding gives back the same rows.

const PROMPT_FIELDS = ['session', 'minute', 'words', 'flags', 'lang', 'seq'] as const;
const REPLY_FIELDS = [
  'session',
  'minute',
  'model',
  'input',
  'output',
  'cacheRead',
  'cacheWrite',
  'flags',
  'seq',
  'count',
] as const;
const TOOL_FIELDS = [
  'session',
  'minute',
  'category',
  'linesAdded',
  'flags',
  'linesRemoved',
  'langCat',
  'seq',
  'count',
] as const;
const INTERRUPT_FIELDS = ['session', 'minute'] as const;
const DELTA = new Set(['session', 'minute', 'seq']);

type Columns<F extends readonly string[]> = { [K in F[number]]: number[] };

export interface WireSkeleton {
  version: typeof SKELETON_VERSION;
  period: Skeleton['period'];
  observedDays: Skeleton['observedDays'];
  sessions: Skeleton['sessions'];
  models: string[];
  langs: string[];
  prompts: Columns<typeof PROMPT_FIELDS>;
  replies: Columns<typeof REPLY_FIELDS>;
  tools: Columns<typeof TOOL_FIELDS>;
  interrupts: Columns<typeof INTERRUPT_FIELDS>;
}

function toColumns<F extends readonly string[]>(
  rows: readonly (readonly number[])[],
  fields: F,
): Columns<F> {
  const out = Object.fromEntries(fields.map((f) => [f, [] as number[]])) as Columns<F>;
  const previous = new Array<number>(fields.length).fill(0);
  for (const row of rows) {
    fields.forEach((field, i) => {
      const value = row[i] as number;
      const column = (out as Record<string, number[]>)[field] as number[];
      column.push(DELTA.has(field) ? value - (previous[i] as number) : value);
      previous[i] = value;
    });
  }
  return out;
}

function toRows<F extends readonly string[]>(columns: Columns<F>, fields: F): number[][] {
  const lists = fields.map((f) => (columns as Record<string, number[]>)[f] as number[]);
  const length = lists[0]?.length ?? 0;
  if (lists.some((l) => l.length !== length)) throw new Error('skeleton columns differ in length');
  const rows: number[][] = [];
  const running = new Array<number>(fields.length).fill(0);
  for (let r = 0; r < length; r++) {
    rows.push(
      fields.map((field, i) => {
        const value = lists[i]?.[r] as number;
        if (!DELTA.has(field)) return value;
        running[i] = (running[i] as number) + value;
        return running[i] as number;
      }),
    );
  }
  return rows;
}

export function encodeSkeleton(skeleton: Skeleton): WireSkeleton {
  return {
    version: skeleton.version,
    period: skeleton.period,
    observedDays: skeleton.observedDays,
    sessions: skeleton.sessions,
    models: skeleton.models,
    langs: skeleton.langs,
    prompts: toColumns(skeleton.prompts, PROMPT_FIELDS),
    replies: toColumns(skeleton.replies, REPLY_FIELDS),
    tools: toColumns(skeleton.tools, TOOL_FIELDS),
    interrupts: toColumns(skeleton.interrupts, INTERRUPT_FIELDS),
  };
}

/** The rows back from columns; also takes a skeleton the schema just parsed. */
export function decodeSkeleton(wire: WireSkeleton | WireSkeletonData): Skeleton {
  return {
    version: wire.version,
    period: wire.period,
    observedDays: wire.observedDays as Skeleton['observedDays'],
    // The schema checked every field; JSON never holds an undefined optional.
    sessions: wire.sessions as Skeleton['sessions'],
    models: wire.models,
    langs: wire.langs,
    prompts: toRows(wire.prompts, PROMPT_FIELDS) as PromptRow[],
    replies: toRows(wire.replies, REPLY_FIELDS) as ReplyRow[],
    tools: toRows(wire.tools, TOOL_FIELDS) as ToolRow[],
    interrupts: toRows(wire.interrupts, INTERRUPT_FIELDS) as InterruptRow[],
  };
}

/** Upper bounds that keep a hostile payload from costing more than a real one. */
export const WIRE_LIMITS = {
  rows: 2_000_000,
  sessions: 100_000,
  models: 500,
  langs: 200,
  commands: 64,
} as const;

const int = z.number().int().safe();
const column = z.array(int).max(WIRE_LIMITS.rows);
const columns = <F extends readonly string[]>(fields: F) =>
  z.strictObject(
    Object.fromEntries(fields.map((f) => [f, column])) as { [K in F[number]]: typeof column },
  );
const label = z.string().regex(LABEL);
export const ToolSchema = z.enum(['claude-code', 'codex', 'cursor']);
const tool = ToolSchema;

export const WireSkeletonSchema = z.strictObject({
  version: z.literal(SKELETON_VERSION),
  period: z.strictObject({
    start: z.iso.datetime(),
    end: z.iso.datetime(),
    days: int.min(1).max(366),
  }),
  observedDays: z.partialRecord(tool, int.min(1).max(366)),
  sessions: z
    .array(
      z.strictObject({
        tool,
        version: label.optional(),
        startedAt: z.iso.datetime(),
        models: z.array(label).max(WIRE_LIMITS.models),
        planMode: z.boolean(),
        autonomy: z.enum(['ask', 'acceptEdits', 'bypass']).optional(),
        entrypoint: z.enum(['terminal', 'desktop', 'ide']).optional(),
        compactions: int.min(0),
        builtinCommands: z
          .record(z.string().regex(/^[a-z][a-z0-9-]{0,31}$/), int.min(0))
          .refine((r) => Object.keys(r).length <= WIRE_LIMITS.commands),
      }),
    )
    .max(WIRE_LIMITS.sessions),
  models: z.array(label).max(WIRE_LIMITS.models),
  langs: z.array(z.string().regex(/^[a-z]{3}$/)).max(WIRE_LIMITS.langs),
  prompts: columns(PROMPT_FIELDS),
  replies: columns(REPLY_FIELDS),
  tools: columns(TOOL_FIELDS),
  interrupts: columns(INTERRUPT_FIELDS),
});

/** A skeleton as the schema parses it. */
export type WireSkeletonData = z.infer<typeof WireSkeletonSchema>;
