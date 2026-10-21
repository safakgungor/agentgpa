import { fold, LEXICONS } from './lexicons.ts';
import { secretPattern } from './secrets.ts';
import { REDACTION_RULES as R } from './thresholds.ts';

// Redaction for every quote candidate and every deep read prompt: secrets, high-entropy
// strings, ids, contacts, addresses, home paths, project and account names. Swears are masked
// instead, as `[[bar:N]]`, which cards draw as a bar N letters wide. A quote with anything
// redacted is dropped; the deep read keeps the placeholders.

export interface RedactionContext {
  /** Project and repository names seen on this machine; they become `[project]`. */
  projects: readonly string[];
  /** The user's account and host names; they become `[name]`. */
  names: readonly string[];
  /** The home folder, which becomes `~`. */
  home?: string;
}

export interface Redacted {
  text: string;
  /** What was taken out, by kind; empty when nothing but swears changed. */
  kinds: string[];
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

const PREFIXED =
  /\b(?:sk-ant-|sk-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|AKIA|ASIA|xox[abprs]-|AIza|glpat-|npm_|hf_)[A-Za-z0-9_-]{8,}/g;
const BEARER = /\b(?:Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX = /\b[0-9a-f]{32,}\b/gi;
const BASE64 = /[A-Za-z0-9+/]{40,}={0,2}/g;
const TOKEN = /[A-Za-z0-9+/=_-]{20,}/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_WITH_PARTS = /\b(?:https?|ftp):\/\/(?:[^\s/@]*@|[^\s?#]*[?#])\S*/gi;
const IPV4 = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g;
const IPV6 =
  /\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b|\b(?:[0-9a-f]{1,4}:){1,6}:(?:[0-9a-f]{1,4})?\b/gi;
const PHONE = /(?<![\w.])\+?\d[\d\s().-]{7,}\d(?![\w.])/g;
const USER_PATH = /(?:\/Users|\/home|[A-Za-z]:\\Users)[/\\][^/\\\s'"`]+/g;

/** Looks like a key: long, mixed, digits among letters, and close to random. */
function looksRandom(token: string): boolean {
  if (!/\d/.test(token) || !/[A-Za-z]/.test(token)) return false;
  return entropy(token) >= R.minEntropy;
}

/** Text with secrets, ids, contacts, home paths and local names taken out. */
export function redact(text: string, context: RedactionContext): Redacted {
  const kinds = new Set<string>();
  let out = text;
  const swap = (
    pattern: RegExp,
    kind: string,
    placeholder: string,
    keep?: (match: string) => boolean,
  ) => {
    out = out.replace(pattern, (match) => {
      if (keep?.(match)) return match;
      kinds.add(kind);
      return placeholder;
    });
  };
  swap(secretPattern(), 'secret', '[secret]');
  swap(PREFIXED, 'secret', '[secret]');
  swap(BEARER, 'secret', '[secret]');
  // A link with credentials holds an email-shaped part, so links go first.
  swap(URL_WITH_PARTS, 'url', '[url]');
  swap(EMAIL, 'email', '[email]');
  swap(UUID, 'id', '[id]');
  swap(HEX, 'id', '[id]');
  swap(IPV4, 'address', '[ip]');
  swap(IPV6, 'address', '[ip]', (m) => !/\d/.test(m) || m.split(':').length < 3);
  swap(PHONE, 'phone', '[phone]', (m) => {
    const digits = m.replace(/\D/g, '').length;
    return (
      digits < R.minPhoneDigits || digits > R.maxPhoneDigits || /\d{4}-\d{1,2}-\d{1,2}/.test(m)
    );
  });
  swap(BASE64, 'secret', '[secret]', (m) => !looksRandom(m));
  swap(TOKEN, 'secret', '[secret]', (m) => !looksRandom(m));
  if (context.home && context.home.length > 1) {
    swap(new RegExp(escapeRegex(context.home), 'g'), 'path', '~');
  }
  swap(USER_PATH, 'path', '~');
  for (const [names, kind, placeholder] of [
    [context.projects, 'project', '[project]'],
    [context.names, 'name', '[name]'],
  ] as const) {
    const words = [...new Set(names)].filter((n) => n.length >= R.minNameLength);
    if (words.length === 0) continue;
    const list = words
      .sort((a, b) => b.length - a.length)
      .map(escapeRegex)
      .join('|');
    swap(
      new RegExp(`(?<![\\p{L}\\p{N}_-])(?:${list})(?![\\p{L}\\p{N}_-])`, 'giu'),
      kind,
      placeholder,
    );
  }
  return { text: out, kinds: [...kinds].sort() };
}

const MASK = /\[\[bar:(\d{1,3})\]\]/g;
const SWEARS = new RegExp(LEXICONS.swears.source, 'gu');

/** The folded text and, for each of its positions, the position in the original it came from. */
function foldWithMap(text: string): { folded: string; at: number[] } {
  let folded = '';
  const at: number[] = [];
  for (let i = 0; i < text.length; ) {
    const ch = String.fromCodePoint(text.codePointAt(i) as number);
    const f = fold(ch);
    for (let k = 0; k < f.length; k++) at.push(i);
    folded += f;
    i += ch.length;
  }
  at.push(text.length);
  return { folded, at };
}

const bar = (word: string) => `[[bar:${word.match(/\p{L}/gu)?.length ?? word.length}]]`;

/**
 * Swears replaced with `[[bar:N]]`, N being the letters of the word. A phrase gets one mask per
 * word, so a masked prompt keeps its word count.
 */
export function maskSwears(input: string): string {
  const text = input.normalize('NFC');
  const { folded, at } = foldWithMap(text);
  let out = '';
  let last = 0;
  for (const m of folded.matchAll(SWEARS)) {
    const start = at[m.index ?? 0] as number;
    const end = at[(m.index ?? 0) + m[0].length] as number;
    const masked = text
      .slice(start, end)
      .split(/(\s+)/)
      .map((part) => (/\S/.test(part) ? bar(part) : part))
      .join('');
    out += text.slice(last, start) + masked;
    last = end;
  }
  return out + text.slice(last);
}

/** The length of a text as a card shows it: a mask counts as its N letters. */
export function shownLength(text: string): number {
  return text.replace(MASK, (_, n: string) => 'x'.repeat(Number(n))).length;
}

/** A masked text as the terminal shows it: each mask a bar of block characters. */
export function drawMasks(text: string): string {
  return text.replace(MASK, (_, n: string) => '█'.repeat(Number(n)));
}
