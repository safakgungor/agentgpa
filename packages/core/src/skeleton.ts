import { safeLabel } from './clean.ts';
import { fold, LAUGH, LEXICONS } from './lexicons.ts';
import { type PromptText, pickQuotes, type QuoteCandidate } from './quotes.ts';
import type { RedactionContext } from './redaction.ts';
import { type SecretCounts, SecretScanner } from './secrets.ts';
import {
  endsWithExclaim,
  endsWithQuestion,
  hasCodeBlock,
  hasCodeReference,
  hasEmoji,
  hasUrl,
  isCapsCrisis,
  languageSample,
  looksPastedError,
  normalizePrompt,
  proseOf,
  referencesPlanFile,
  wordCount,
} from './text.ts';
import { FINGERPRINT_RULES, METRIC_RULES, SIGNAL_RULES } from './thresholds.ts';
import type { PromptEvent, ReplyEvent, Session, Tool, ToolCategory, UsageEvent } from './types.ts';

// The event skeleton (v2): everything metrics and signals need and no text, no paths, no
// names. The CLI builds it from parsed sessions; the server recomputes every metric from it
// with the same code. Text-dependent facts are decided here, on the device, and travel only
// as flag bits and indexes into fixed lists.

export const SKELETON_VERSION = 2;

export const PROMPT_FLAGS = {
  caps: 1,
  thanks: 2,
  swear: 4,
  correction: 8,
  codeRef: 16,
  plan: 32,
  repeat: 64,
  approx: 128,
  planFile: 256,
  question: 512,
  please: 1024,
  praise: 2048,
  sorry: 4096,
  laugh: 8192,
  emoji: 16384,
  exclaim: 32768,
  nudge: 65536,
  pastedError: 131072,
  image: 262144,
  url: 524288,
  codeBlock: 1048576,
  think: 2097152,
} as const;

export const REPLY_FLAGS = {
  absolutelyRight: 1,
  sycophancy: 2,
  apology: 4,
  sidechain: 8,
  text: 16,
  refusal: 32,
  asksUser: 64,
} as const;

/** Tool call flags: the shell flags of `TOOL_FLAGS` (commit to deploy, install, lint) and these. */
export const CALL_FLAGS = {
  gitCommit: 1,
  prCreate: 2,
  test: 4,
  build: 8,
  deploy: 16,
  error: 32,
  declined: 64,
  sidechain: 128,
  approx: 256,
  testFail: 512,
  testPass: 1024,
  install: 2048,
  lint: 4096,
  sensitiveFile: 8192,
} as const;

export const CATEGORIES: readonly ToolCategory[] = [
  'Bash',
  'Edit',
  'Write',
  'Read',
  'Search',
  'Web',
  'Task',
  'MCP',
  'Other',
  'Todo',
  'Notebook',
];

/** How much a session let the agent do without asking: the most it allowed at any point. */
export type Autonomy = 'ask' | 'acceptEdits' | 'bypass';
export type Entrypoint = 'terminal' | 'desktop' | 'ide';

export interface SkeletonSession {
  tool: Tool;
  version?: string;
  /** ISO time of the session's first event, which can be before the period. */
  startedAt: string;
  models: string[];
  planMode: boolean;
  /** Only where the tool records a permission setting (Claude Code and Codex). */
  autonomy?: Autonomy;
  entrypoint?: Entrypoint;
  compactions: number;
  /** Built-in slash commands by name; every other command counts as `custom`. */
  builtinCommands: Record<string, number>;
}

/** session, minute, words, flags, language (index into `langs`, -1 when too short), seq */
export type PromptRow = [number, number, number, number, number, number];
/**
 * session, minute, model (index, -1 unknown), input, output, cache read, cache write, flags,
 * seq, count. Replies with text are one row each; the rest of one minute merge into one row
 * per model and flags, with summed tokens and their count.
 */
export type ReplyRow = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];
/**
 * session, minute, category, lines added, flags, lines removed, language category (-1 none),
 * seq, count. The main agent's calls are one row each; a subagent's calls of one minute merge
 * per category, flags and language category.
 */
export type ToolRow = [number, number, number, number, number, number, number, number, number];
/** session, minute */
export type InterruptRow = [number, number];

/** Minutes count from `period.start`; `seq` is an event's position inside its session. */
export interface Skeleton {
  version: typeof SKELETON_VERSION;
  period: { start: string; end: string; days: number };
  observedDays: Partial<Record<Tool, number>>;
  sessions: SkeletonSession[];
  models: string[];
  /** ISO 639-3 codes of the prompts' languages. */
  langs: string[];
  prompts: PromptRow[];
  replies: ReplyRow[];
  tools: ToolRow[];
  interrupts: InterruptRow[];
}

/**
 * Facts only the device can know, from text. They stay on the device unless consent says
 * otherwise, and hold counts only: never the text they were counted from.
 */
export interface DeviceFacts {
  /** How often the most repeated prompt (of at least two words) came up. */
  mostRepeatedPrompt?: { count: number };
  vocabulary: number;
  /** The prompts' main language as an ISO 639-3 code, or `und` when it cannot be told. */
  promptLanguage: string;
  secrets: SecretCounts;
  topTools: { name: string; count: number }[];
  /** Sessions left out because they hold the link code (the agent's own session). */
  skippedSessions: number;
  /** The sample of hashed provider message ids (empty without a hash function). */
  fingerprints: string[];
}

export interface SkeletonOptions {
  /** End of the period, epoch ms (the time of the scan). */
  end: number;
  days: number;
  /** Days each tool could have recorded; events before that window are left out. */
  observedDays: Partial<Record<Tool, number>>;
  /** Fed with tool outputs while parsing; prompts are added here. */
  scanner?: SecretScanner;
  /** Names the language of a sample of prompt words (the CLI passes franc-min); `und` without it. */
  detectLanguage?: (sample: string) => string;
  /** Picks quote candidates, redacted with these local names; no quotes without it. */
  quotes?: RedactionContext;
  /** Sessions with a prompt holding this text are left out (the link code in agent mode). */
  skipSessionsWith?: string;
  /** Hashes provider message ids for the fingerprint sample (SHA-256 hex in the CLI). */
  fingerprint?: (id: string) => string;
}

const DAY = 86_400_000;

export function observedWindowStart(
  options: Pick<SkeletonOptions, 'end' | 'days' | 'observedDays'>,
  tool: Tool,
): number {
  return options.end - Math.min(options.days, options.observedDays[tool] ?? options.days) * DAY;
}

/** A session's events inside its tool's window: the ones a report holds. */
export function windowEvents(
  session: Session,
  options: Pick<SkeletonOptions, 'end' | 'days' | 'observedDays'>,
): Session['events'] {
  const from = observedWindowStart(options, session.tool);
  return session.events.filter((e) => e.ts >= from && e.ts <= options.end);
}

/** Permission and sandbox modes, by how much they let the agent do without asking. */
const AUTONOMY: Record<string, Autonomy> = {
  default: 'ask',
  plan: 'ask',
  acceptEdits: 'acceptEdits',
  auto: 'acceptEdits',
  bypassPermissions: 'bypass',
  dontAsk: 'bypass',
  'sandbox:read-only': 'ask',
  'sandbox:workspace-write': 'acceptEdits',
  'sandbox:danger-full-access': 'bypass',
};
const AUTONOMY_RANK: Record<Autonomy, number> = { ask: 0, acceptEdits: 1, bypass: 2 };

function autonomyOf(modes: Record<string, number>): Autonomy | undefined {
  let most: Autonomy | undefined;
  for (const mode of Object.keys(modes)) {
    const a = Object.hasOwn(AUTONOMY, mode) ? AUTONOMY[mode] : undefined;
    if (a && (most === undefined || AUTONOMY_RANK[a] > AUTONOMY_RANK[most])) most = a;
  }
  return most;
}

/** The terminal, the desktop app or an editor, from each tool's own entry point label. */
function entrypointOf(raw: string | undefined): Entrypoint | undefined {
  if (!raw) return undefined;
  const r = raw.toLowerCase();
  if (r === 'agent-transcript' || r.startsWith('sdk')) return undefined;
  if (r.includes('desktop')) return 'desktop';
  if (/vscode|jetbrains|ide|editor|cursor|windsurf|zed|xcode/.test(r)) return 'ide';
  if (/cli|exec|tui|terminal/.test(r)) return 'terminal';
  return undefined;
}

function promptFlags(e: PromptEvent): number {
  const text = e.text;
  const f = fold(text);
  let flags = 0;
  if (isCapsCrisis(text)) flags |= PROMPT_FLAGS.caps;
  if (LEXICONS.thanks.test(f)) flags |= PROMPT_FLAGS.thanks;
  if (LEXICONS.swears.test(f)) flags |= PROMPT_FLAGS.swear;
  if (LEXICONS.corrections.test(f)) flags |= PROMPT_FLAGS.correction;
  if (hasCodeReference(text)) flags |= PROMPT_FLAGS.codeRef;
  if (LEXICONS.plan.test(f)) flags |= PROMPT_FLAGS.plan;
  if (referencesPlanFile(text)) flags |= PROMPT_FLAGS.planFile;
  if (endsWithQuestion(text) || LEXICONS.questionOpeners.test(f)) flags |= PROMPT_FLAGS.question;
  if (LEXICONS.please.test(f)) flags |= PROMPT_FLAGS.please;
  if (LEXICONS.praise.test(f)) flags |= PROMPT_FLAGS.praise;
  if (LEXICONS.userSorry.test(f)) flags |= PROMPT_FLAGS.sorry;
  if (LAUGH.test(f)) flags |= PROMPT_FLAGS.laugh;
  if (hasEmoji(text)) flags |= PROMPT_FLAGS.emoji;
  if (endsWithExclaim(text)) flags |= PROMPT_FLAGS.exclaim;
  if (LEXICONS.nudge.test(normalizePrompt(text))) flags |= PROMPT_FLAGS.nudge;
  if (looksPastedError(text)) flags |= PROMPT_FLAGS.pastedError;
  if (e.images > 0) flags |= PROMPT_FLAGS.image;
  if (hasUrl(text)) flags |= PROMPT_FLAGS.url;
  if (hasCodeBlock(text)) flags |= PROMPT_FLAGS.codeBlock;
  if (LEXICONS.think.test(f)) flags |= PROMPT_FLAGS.think;
  if (e.approx) flags |= PROMPT_FLAGS.approx;
  return flags;
}

function replyFlags(text: string): number {
  const f = fold(text);
  let flags = REPLY_FLAGS.text;
  if (LEXICONS.absolutelyRight.test(f))
    flags |= REPLY_FLAGS.absolutelyRight | REPLY_FLAGS.sycophancy;
  else if (LEXICONS.sycophancy.test(f)) flags |= REPLY_FLAGS.sycophancy;
  if (LEXICONS.apology.test(f)) flags |= REPLY_FLAGS.apology;
  if (LEXICONS.refusal.test(f)) flags |= REPLY_FLAGS.refusal;
  if (endsWithQuestion(text)) flags |= REPLY_FLAGS.asksUser;
  return flags;
}

export function buildSkeleton(
  sessions: Session[],
  options: SkeletonOptions,
): { skeleton: Skeleton; device: DeviceFacts; quotes: QuoteCandidate[] } {
  const start = options.end - options.days * DAY;
  const minute = (ts: number) => Math.max(0, Math.floor((ts - start) / 60_000));
  const scanner = options.scanner ?? new SecretScanner();
  const index = <T>(list: T[], seen: Map<T, number>, value: T): number => {
    let i = seen.get(value);
    if (i === undefined) {
      i = list.push(value) - 1;
      seen.set(value, i);
    }
    return i;
  };
  const models: string[] = [];
  const modelIndex = new Map<string, number>();
  const modelOf = (name: string | undefined): number => {
    const label = safeLabel(name);
    return label ? index(models, modelIndex, label) : -1;
  };
  const langs: string[] = [];
  const langIndex = new Map<string, number>();
  const langOf = (text: string): number => {
    if (!options.detectLanguage) return -1;
    const prose = proseOf(text);
    if (wordCount(prose) < METRIC_RULES.promptLanguageMinWords) return -1;
    const code = options.detectLanguage(prose.slice(0, METRIC_RULES.promptLanguageChars));
    return /^[a-z]{3}$/.test(code) && code !== 'und' ? index(langs, langIndex, code) : -1;
  };
  const skeleton: Skeleton = {
    version: SKELETON_VERSION,
    period: {
      start: new Date(start).toISOString(),
      end: new Date(options.end).toISOString(),
      days: options.days,
    },
    observedDays: options.observedDays,
    sessions: [],
    models,
    langs,
    prompts: [],
    replies: [],
    tools: [],
    interrupts: [],
  };
  const repeats = new Map<string, { count: number; row: number; text: string }>();
  const vocabulary = new Set<string>();
  const sample = languageSample();
  const toolNames = new Map<string, number>();
  const promptTexts: PromptText[] = [];
  let skipped = 0;
  const skipText = options.skipSessionsWith;
  const fingerprints = new Set<string>();

  for (const session of sessions) {
    const events = windowEvents(session, options);
    if (events.length === 0) continue;
    if (
      skipText &&
      session.events.some((e) => e.kind === 'user_prompt' && e.text.includes(skipText))
    ) {
      skipped++;
      continue;
    }
    const s = skeleton.sessions.length;
    if (options.fingerprint) {
      for (const id of session.messageIds) {
        const hex = options.fingerprint(id).slice(0, FINGERPRINT_RULES.hexChars);
        if (hex.startsWith(FINGERPRINT_RULES.prefix)) fingerprints.add(hex);
      }
    }
    const out: SkeletonSession = {
      tool: session.tool,
      startedAt: new Date(session.startedAt).toISOString(),
      models: session.models,
      planMode: session.usedPlanMode,
      compactions: session.compactions,
      builtinCommands: session.commands,
    };
    if (session.version) out.version = session.version;
    const autonomy = autonomyOf(session.permissionModes);
    if (autonomy) out.autonomy = autonomy;
    const entrypoint = entrypointOf(session.entrypoint);
    if (entrypoint) out.entrypoint = entrypoint;
    skeleton.sessions.push(out);

    // Replies with text pair with the usage of the same call (same time and model).
    const usageByKey = new Map<string, UsageEvent[]>();
    for (const e of events) {
      if (e.kind !== 'usage') continue;
      const key = `${e.ts}|${e.model ?? ''}`;
      const list = usageByKey.get(key) ?? [];
      list.push(e);
      usageByKey.set(key, list);
    }
    const pairedText = new Map<UsageEvent, ReplyEvent>();
    const paired = new Set<ReplyEvent>();
    for (const e of events) {
      if (e.kind !== 'assistant_text') continue;
      const usage = usageByKey.get(`${e.ts}|${e.model ?? ''}`)?.find((u) => !pairedText.has(u));
      if (usage) {
        pairedText.set(usage, e);
        paired.add(e);
      }
    }

    // Rows without text of one minute merge: one per model and flags (replies) or per
    // category, flags and language category (a subagent's tool calls).
    const mergedReplies = new Map<string, number[]>();
    const mergedTools = new Map<string, number[]>();
    let previous: { normalized: string; ts: number } | undefined;

    events.forEach((e, seq) => {
      const m = minute(e.ts);
      if (e.kind === 'user_prompt') {
        let flags = promptFlags(e);
        const normalized = normalizePrompt(e.text);
        if (
          normalized &&
          previous &&
          previous.normalized === normalized &&
          e.ts - previous.ts <= METRIC_RULES.repeatWithinMinutes * 60_000
        ) {
          flags |= PROMPT_FLAGS.repeat;
        }
        previous = { normalized, ts: e.ts };
        const words = wordCount(e.text);
        const row = skeleton.prompts.push([s, m, words, flags, langOf(e.text), seq]) - 1;
        if (words >= SIGNAL_RULES.mostRepeatedMinWords && normalized) {
          const entry = repeats.get(normalized);
          if (entry) entry.count++;
          else repeats.set(normalized, { count: 1, row, text: e.text });
        }
        for (const w of normalized.split(' ')) if (w) vocabulary.add(w);
        if (options.quotes) promptTexts.push({ row, text: e.text, flags, words });
        scanner.prompt(e.text, session.tool);
        sample.add(e.text);
      } else if (e.kind === 'usage') {
        const text = pairedText.get(e);
        let flags = text ? replyFlags(text.text) : 0;
        if (e.sidechain) flags |= REPLY_FLAGS.sidechain;
        const model = modelOf(e.model);
        if (text) {
          skeleton.replies.push([
            s,
            m,
            model,
            e.input,
            e.output,
            e.cacheRead,
            e.cacheWrite,
            flags,
            seq,
            1,
          ]);
          return;
        }
        const key = `${m}|${model}|${flags}`;
        const row = mergedReplies.get(key);
        if (row) {
          row[3] = (row[3] as number) + e.input;
          row[4] = (row[4] as number) + e.output;
          row[5] = (row[5] as number) + e.cacheRead;
          row[6] = (row[6] as number) + e.cacheWrite;
          row[9] = (row[9] as number) + 1;
        } else {
          const fresh: ReplyRow = [
            s,
            m,
            model,
            e.input,
            e.output,
            e.cacheRead,
            e.cacheWrite,
            flags,
            seq,
            1,
          ];
          mergedReplies.set(key, fresh);
          skeleton.replies.push(fresh);
        }
      } else if (e.kind === 'assistant_text') {
        if (!paired.has(e)) {
          skeleton.replies.push([s, m, modelOf(e.model), 0, 0, 0, 0, replyFlags(e.text), seq, 1]);
        }
      } else if (e.kind === 'tool_call') {
        let flags = e.flags ?? 0;
        if (e.error) flags |= CALL_FLAGS.error;
        if (e.declined) flags |= CALL_FLAGS.declined;
        if (e.sidechain) flags |= CALL_FLAGS.sidechain;
        if (e.approx) flags |= CALL_FLAGS.approx;
        if (e.testResult === 'fail') flags |= CALL_FLAGS.testFail;
        if (e.testResult === 'pass') flags |= CALL_FLAGS.testPass;
        if (e.sensitive) flags |= CALL_FLAGS.sensitiveFile;
        const category = Math.max(0, CATEGORIES.indexOf(e.category));
        const lang = e.langCat ?? -1;
        toolNames.set(e.name, (toolNames.get(e.name) ?? 0) + 1);
        if (!e.sidechain) {
          skeleton.tools.push([
            s,
            m,
            category,
            e.linesAdded ?? 0,
            flags,
            e.linesRemoved ?? 0,
            lang,
            seq,
            1,
          ]);
          return;
        }
        const key = `${m}|${category}|${flags}|${lang}`;
        const row = mergedTools.get(key);
        if (row) {
          row[3] = (row[3] as number) + (e.linesAdded ?? 0);
          row[5] = (row[5] as number) + (e.linesRemoved ?? 0);
          row[8] = (row[8] as number) + 1;
        } else {
          const fresh: ToolRow = [
            s,
            m,
            category,
            e.linesAdded ?? 0,
            flags,
            e.linesRemoved ?? 0,
            lang,
            seq,
            1,
          ];
          mergedTools.set(key, fresh);
          skeleton.tools.push(fresh);
        }
      } else if (e.kind === 'interrupt') {
        skeleton.interrupts.push([s, m]);
      }
    });
  }

  let top: { count: number; row: number; text: string } | undefined;
  for (const entry of repeats.values()) if (!top || entry.count > top.count) top = entry;
  repeats.clear();
  const language = options.detectLanguage?.(sample.text());
  sample.clear();
  const mostRepeated = top && top.count >= SIGNAL_RULES.mostRepeatedMinCount ? top : undefined;
  const quotes = options.quotes
    ? pickQuotes({
        prompts: promptTexts,
        ...(mostRepeated ? { mostRepeated } : {}),
        context: options.quotes,
        bits: PROMPT_FLAGS,
      })
    : [];
  promptTexts.length = 0;
  const device: DeviceFacts = {
    vocabulary: vocabulary.size,
    promptLanguage: language && /^[a-z]{3}$/.test(language) ? language : 'und',
    secrets: scanner.finish(),
    topTools: [...toolNames]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, count })),
    skippedSessions: skipped,
    fingerprints: [...fingerprints].sort().slice(0, FINGERPRINT_RULES.max),
  };
  if (mostRepeated) device.mostRepeatedPrompt = { count: mostRepeated.count };
  return { skeleton, device, quotes };
}
