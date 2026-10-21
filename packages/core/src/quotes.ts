import { fold, LEXICONS, VAGUE_WORDS } from './lexicons.ts';
import { maskSwears, type RedactionContext, redact, shownLength } from './redaction.ts';
import { QUOTE_RULES as R } from './thresholds.ts';

// Quote candidates for the cards: one most repeated prompt, one caps crisis, one saltiest and
// up to two cryptic ones. Each is masked, redacted and dropped if anything but swears had to
// go, so a quote is the user's own words or nothing. They are the only prompt text that can
// leave the device, and only after the user sees each one and may drop it.

export type QuoteKind = 'most_repeated' | 'caps_crisis' | 'saltiest' | 'cryptic_candidate';

export interface QuoteCandidate {
  kind: QuoteKind;
  /** Swears masked as `[[bar:N]]`; nothing else redacted. */
  text: string;
  /** The skeleton prompt row it was said in. */
  prompt: number;
  /** How often it came up (most repeated only). */
  count?: number;
}

/** One prompt as the skeleton saw it: its row, text and flag bits. */
export interface PromptText {
  row: number;
  text: string;
  flags: number;
  words: number;
}

export interface QuoteInput {
  prompts: readonly PromptText[];
  /** The most repeated prompt, when one came up often enough. */
  mostRepeated?: { row: number; text: string; count: number };
  context: RedactionContext;
  /** Prompt flag bits, passed in to keep this module free of the skeleton. */
  bits: {
    caps: number;
    swear: number;
    codeRef: number;
    codeBlock: number;
    url: number;
    pastedError: number;
  };
}

/** The quote as it may leave, or undefined when it cannot leave as it is. */
function clean(text: string, context: RedactionContext): string | undefined {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (/[`\n]/.test(text) || flat.length === 0) return undefined;
  const masked = maskSwears(flat);
  if (shownLength(masked) > R.maxLength) return undefined;
  return redact(masked, context).kinds.length === 0 ? masked : undefined;
}

const exclamations = (text: string) => text.match(/!/g)?.length ?? 0;
function capsShare(text: string): number {
  const letters = text.match(/\p{L}/gu) ?? [];
  const cased = letters.filter((ch) => ch.toLowerCase() !== ch.toUpperCase());
  return cased.length ? cased.filter((ch) => ch === ch.toUpperCase()).length / cased.length : 0;
}
function vagueShare(text: string, words: number): number {
  const tokens = fold(text).match(/[\p{L}\p{N}'’]+/gu) ?? [];
  return words ? tokens.filter((t) => VAGUE_WORDS.has(t)).length / words : 0;
}
function swearCount(text: string): number {
  return (fold(text).match(new RegExp(LEXICONS.swears.source, 'gu')) ?? []).length;
}

export function pickQuotes(input: QuoteInput): QuoteCandidate[] {
  const { bits, context } = input;
  const out: QuoteCandidate[] = [];
  const used = new Set<number>();
  const plain = (p: PromptText) =>
    !(p.flags & (bits.codeRef | bits.codeBlock | bits.url | bits.pastedError)) &&
    p.words >= R.minWords;
  const best = (
    kind: QuoteKind,
    pool: PromptText[],
    score: (p: PromptText) => number,
    limit = 1,
  ) => {
    const ranked = pool
      .filter((p) => !used.has(p.row) && plain(p))
      .map((p) => ({ p, s: score(p) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.p.row - b.p.row);
    const seen = new Set<string>();
    for (const { p } of ranked) {
      if (out.filter((q) => q.kind === kind).length >= limit) break;
      const text = clean(p.text, context);
      if (!text || seen.has(fold(text))) continue;
      seen.add(fold(text));
      used.add(p.row);
      out.push({ kind, text, prompt: p.row });
    }
  };

  const repeated = input.mostRepeated;
  if (repeated) {
    const text = clean(repeated.text, context);
    if (text) {
      out.push({ kind: 'most_repeated', text, prompt: repeated.row, count: repeated.count });
      used.add(repeated.row);
    }
  }
  const prompts = [...input.prompts];
  best(
    'caps_crisis',
    prompts.filter((p) => p.flags & bits.caps),
    (p) => 1 + exclamations(p.text) + capsShare(p.text) - p.text.length / 1000,
  );
  best(
    'saltiest',
    prompts.filter((p) => p.flags & bits.swear),
    (p) =>
      1 +
      R.saltSwearWeight * swearCount(p.text) +
      R.saltCapsWeight * capsShare(p.text) +
      exclamations(p.text) +
      (p.words <= R.saltShortWords ? 1 : 0),
  );
  best(
    'cryptic_candidate',
    prompts.filter(
      (p) =>
        p.words >= R.crypticMinWords &&
        p.words <= R.crypticMaxWords &&
        !(p.flags & (bits.caps | bits.swear)),
    ),
    (p) => {
      const share = vagueShare(p.text, p.words);
      return share >= R.crypticMinVagueShare ? share : 0;
    },
    R.crypticCount,
  );
  return out;
}

const SHELL = /\$\(|`|\|\s*(?:sh|bash|zsh)\b|\b(?:curl|wget|sudo|rm\s+-rf|chmod|eval)\b/i;
const PATH = /(?:^|[\s(])(?:~|\.{1,2})?[/\\][\w.-]+|[A-Za-z]:\\|\b[\w-]+\.(?:[a-z]{1,5})\b/i;
const LINK = /\b(?:https?|ftp):\/\/|\bwww\.|\b[\w-]+\.(?:com|org|net|io|dev|ai|app|co)\b/i;

/**
 * A quote that may be shown inside someone's agent: no link, path, shell construct or wording
 * aimed at an agent, since old sessions can hold text written to steer agents.
 */
export function agentSafe(text: string): boolean {
  return !(
    LINK.test(text) ||
    PATH.test(text) ||
    SHELL.test(text) ||
    LEXICONS.agentDirectives.test(fold(text))
  );
}
