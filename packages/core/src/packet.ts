import { z } from 'zod';
import { LANG_CATEGORIES, type LangCategory } from './files.ts';
import { maskSwears, type RedactionContext, redact } from './redaction.ts';
import { CATEGORIES, observedWindowStart } from './skeleton.ts';
import { hasCodeBlock, looksPastedError, wordCount } from './text.ts';
import { PACKET_RULES as R } from './thresholds.ts';
import { type Session, TOOL_FLAGS, type Tool, type ToolCategory } from './types.ts';
import { ToolSchema } from './wire.ts';

// The deep read packet: a redacted sample of the prompts the user typed, and text-free work
// signals per session. It is built in memory, sent once right after the report when the user
// turned the deep read on at /start, read once by our model and dropped. It is never written to
// disk.

export const PACKET_SCHEMA_VERSION = 1;

const DURATIONS = ['under-10-min', 'under-1-hour', 'under-3-hours', 'longer'] as const;
type Duration = (typeof DURATIONS)[number];

export interface PacketSession {
  tool: Tool;
  duration: Duration;
  prompts: number;
  /** Tool calls by category. */
  categories: Partial<Record<ToolCategory, number>>;
  /** Edited files by language category, from their extensions. */
  languages: Partial<Record<LangCategory, number>>;
  commands: { test: number; build: number; git: number; deploy: number };
}

export interface PacketPrompt {
  /** Index into `sessions`. */
  session: number;
  /** Weeks since the start of the period. */
  week: number;
  text: string;
}

export interface Packet {
  schemaVersion: typeof PACKET_SCHEMA_VERSION;
  promptLanguage: string;
  sessions: PacketSession[];
  prompts: PacketPrompt[];
}

export interface PacketOptions {
  end: number;
  days: number;
  observedDays: Partial<Record<Tool, number>>;
  promptLanguage: string;
  context: RedactionContext;
  /** Orders the sample; the CLI passes its install id. */
  seed: string;
  skipSessionsWith?: string;
}

const count = z.number().int().min(0).safe();
const categoryNames = CATEGORIES as unknown as [string, ...string[]];
const languageNames = LANG_CATEGORIES as unknown as [string, ...string[]];

export const PacketSchema = z.strictObject({
  schemaVersion: z.literal(PACKET_SCHEMA_VERSION),
  promptLanguage: z.string().regex(/^[a-z]{3}$/),
  sessions: z
    .array(
      z.strictObject({
        tool: ToolSchema,
        duration: z.enum(DURATIONS),
        prompts: count,
        categories: z.partialRecord(z.enum(categoryNames), count),
        languages: z.partialRecord(z.enum(languageNames), count),
        commands: z.strictObject({ test: count, build: count, git: count, deploy: count }),
      }),
    )
    .max(R.maxSessions),
  prompts: z
    .array(
      z.strictObject({
        session: count,
        week: count.max(60),
        text: z.string().min(1).max(R.promptChars),
      }),
    )
    .max(R.maxPrompts),
});

/** A stable 0 to 1 order for a prompt, from the seed and its place. */
function order(seed: string, key: string): number {
  let h = 0x811c9dc5;
  for (const ch of `${seed}:${key}`)
    h = Math.imul(h ^ (ch.codePointAt(0) as number), 0x01000193) >>> 0;
  return h / 2 ** 32;
}

function durationOf(minutes: number): Duration {
  if (minutes < 10) return 'under-10-min';
  if (minutes < 60) return 'under-1-hour';
  if (minutes < 180) return 'under-3-hours';
  return 'longer';
}

export function buildPacket(all: readonly Session[], options: PacketOptions): Packet {
  const start = options.end - options.days * 86_400_000;
  const sessions: PacketSession[] = [];
  const buckets = new Map<
    string,
    { session: number; week: number; text: string; rank: number }[]
  >();
  for (const session of all) {
    const from = Math.max(start, observedWindowStart(options, session.tool));
    const events = session.events.filter((e) => e.ts >= from && e.ts <= options.end);
    const prompts = events.filter((e) => e.kind === 'user_prompt');
    if (prompts.length === 0) continue;
    const skip = options.skipSessionsWith;
    if (skip && session.events.some((e) => e.kind === 'user_prompt' && e.text.includes(skip)))
      continue;
    const index = sessions.length;
    const categories: Partial<Record<ToolCategory, number>> = {};
    const languages: Partial<Record<LangCategory, number>> = {};
    const commands = { test: 0, build: 0, git: 0, deploy: 0 };
    for (const e of events) {
      if (e.kind !== 'tool_call') continue;
      categories[e.category] = (categories[e.category] ?? 0) + 1;
      const lang = e.langCat === undefined ? undefined : LANG_CATEGORIES[e.langCat];
      if (lang) languages[lang] = (languages[lang] ?? 0) + 1;
      const f = e.flags ?? 0;
      if (f & TOOL_FLAGS.test) commands.test++;
      if (f & TOOL_FLAGS.build) commands.build++;
      if (f & (TOOL_FLAGS.gitCommit | TOOL_FLAGS.prCreate)) commands.git++;
      if (f & TOOL_FLAGS.deploy) commands.deploy++;
    }
    const first = events[0]?.ts ?? from;
    const last = events.at(-1)?.ts ?? first;
    sessions.push({
      tool: session.tool,
      duration: durationOf((last - first) / 60_000),
      prompts: prompts.length,
      categories,
      languages,
      commands,
    });
    prompts.forEach((p, i) => {
      // Only what the user typed: no code, no pasted logs or traces, no long blobs.
      if (p.text.length > R.maxSourceChars || hasCodeBlock(p.text) || looksPastedError(p.text))
        return;
      if (wordCount(p.text) < R.minWords) return;
      const text = redact(maskSwears(p.text.replace(/\s+/g, ' ').trim()), options.context).text;
      const week = Math.min(60, Math.floor((p.ts - start) / (7 * 86_400_000)));
      const key = `${session.tool}|${week}`;
      const bucket = buckets.get(key) ?? [];
      bucket.push({
        session: index,
        week,
        text: text.slice(0, R.promptChars),
        rank: order(options.seed, `${session.id}:${i}`),
      });
      buckets.set(key, bucket);
    });
  }

  // Round robin over tools and weeks, so the sample spreads across them.
  const lists = [...buckets.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([, list]) => list.sort((a, b) => a.rank - b.rank));
  const picked: PacketPrompt[] = [];
  for (let i = 0; picked.length < R.maxPrompts && lists.some((l) => i < l.length); i++) {
    for (const list of lists) {
      const p = list[i];
      if (p && picked.length < R.maxPrompts)
        picked.push({ session: p.session, week: p.week, text: p.text });
    }
  }
  return PacketSchema.parse({
    schemaVersion: PACKET_SCHEMA_VERSION,
    promptLanguage: /^[a-z]{3}$/.test(options.promptLanguage) ? options.promptLanguage : 'und',
    sessions,
    prompts: picked,
  });
}
