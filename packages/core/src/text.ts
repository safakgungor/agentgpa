import { fold } from './lexicons.ts';
import { METRIC_RULES as R } from './thresholds.ts';

// Checks on prompt text. They run on the device only; what leaves is a count or a flag bit.

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu;

/** Words in a text, counted the same way in every script. */
export function wordCount(text: string): number {
  return text.match(WORD)?.length ?? 0;
}

/**
 * A caps lock crash-out: at least 3 words and 10 cased letters, at least 70% of them
 * uppercase. Letters without case (CJK, Arabic) never count, and Turkish İ and ı count by
 * their own case.
 */
export function isCapsCrisis(text: string): boolean {
  if (wordCount(text) < R.capsMinWords) return false;
  let cased = 0;
  let upper = 0;
  for (const ch of text) {
    const lower = ch.toLowerCase();
    const up = ch.toUpperCase();
    if (lower === up) continue;
    cased++;
    if (ch === up) upper++;
  }
  return cased >= R.capsMinCasedLetters && upper / cased >= R.capsUpperShare;
}

const CODE_REFERENCE = [
  /`/, // inline code or a fence
  /(?:^|[\s(])(?:\.{0,2}\/)?[\w@.-]+\/[\w@./-]*\.[A-Za-z0-9]{1,8}(?=$|[\s):,;])/m, // a path with an extension
  /(?:^|[\s(])[\w-]+\.(?:[jt]sx?|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|vue|svelte|css|scss|html|json|ya?ml|toml|sql|sh|md|mdx|xml|gradle|tf|lock)(?=$|[\s):,;])/im,
  /^\s+at .+[(:]\d+/m, // a stack trace line
  /Traceback \(most recent call last\)|File ".+", line \d+/,
  /\b(?:Error|Exception|TypeError|ReferenceError|SyntaxError|ValueError):/,
  /\bline \d+\b|:\d+:\d+\b/i,
];

/** The prompt points at code: backticks, a file or path, a stack trace, an error or a line number. */
export function hasCodeReference(text: string): boolean {
  return CODE_REFERENCE.some((rule) => rule.test(text));
}

/** The prompt names a plan or spec file. */
export function referencesPlanFile(text: string): boolean {
  return /(?:^|[^\w])(?:PLAN|SPEC|TODO|CLAUDE|AGENTS)\.md\b/i.test(text);
}

/** The form used to find repeated prompts: folded, punctuation gone, spaces collapsed. */
export function normalizePrompt(text: string): string {
  return fold(text)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface LanguageSample {
  add(text: string): void;
  text(): string;
  clear(): void;
}

/**
 * Prompt words for naming the prompts' language, kept in memory only and capped: code, links,
 * paths and file names are left out, since they read as English whatever the prompt's language.
 */
export function languageSample(max: number = R.languageSampleChars): LanguageSample {
  const parts: string[] = [];
  let size = 0;
  return {
    add(text) {
      if (size >= max) return;
      const words = proseOf(text);
      if (wordCount(words) < R.languageMinWords) return;
      const piece = words.slice(0, max - size);
      parts.push(piece);
      size += piece.length + 1;
    },
    text: () => parts.join(' '),
    clear() {
      parts.length = 0;
      size = 0;
    },
  };
}

// Pictographs, without the marks that also live there (©, ®, ™) and turn up in pasted text.
const EMOJI = /(?![©®™])\p{Extended_Pictographic}/u;
const URL = /\b(?:https?|ftp):\/\/\S/i;
const STACK_TRACE = [
  /^\s+at .+[(:]\d+/m,
  /Traceback \(most recent call last\)/,
  /^\s*File ".+", line \d+/m,
  /\bpanic: /,
  /^\s*error(?:\[E\d+\])?: /m,
  /\berror TS\d+:/,
  /npm ERR!/,
  /^Exception in thread /m,
];
const LOG_LINE = /\b(?:ERROR|FATAL|Error|Exception|WARN(?:ING)?)\b/;

/** The prompt holds an emoji. */
export function hasEmoji(text: string): boolean {
  return EMOJI.test(text);
}

/** The prompt holds a link. */
export function hasUrl(text: string): boolean {
  return URL.test(text);
}

/** The prompt holds a fenced code block. */
export function hasCodeBlock(text: string): boolean {
  return text.includes('```');
}

/** The prompt ends with an exclamation mark. */
export function endsWithExclaim(text: string): boolean {
  return /!\s*$/.test(text);
}

/** The text's last line ends with a question mark (closing quotes and brackets aside). */
export function endsWithQuestion(text: string): boolean {
  return /\?[\s"'’”)\]*_`]*$/.test(text);
}

/** The prompt carries a stack trace or an error log someone pasted. */
export function looksPastedError(text: string): boolean {
  if (STACK_TRACE.some((rule) => rule.test(text))) return true;
  return text.split('\n').length >= 3 && LOG_LINE.test(text);
}

/**
 * The words of a prompt without code, links, paths or file names, which read as English
 * whatever language the prompt is in. Used to name the prompt's language.
 */
export function proseOf(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi, ' ')
    .replace(/\S*[/\\]\S*/g, ' ')
    .replace(/\S+\.[A-Za-z][A-Za-z0-9]{0,7}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
