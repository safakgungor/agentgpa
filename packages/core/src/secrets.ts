import type { Tool } from './types.ts';

// Secret detection: provider-specific patterns and private key blocks only, no generic
// entropy, and what unlocks nothing is skipped to keep false positives low: documentation
// examples, templates, local database URLs, Supabase's local demo keys and public anon keys,
// and GitHub tokens whose checksum fails. Only counts by type leave this module. Values are
// never stored: a secret is remembered as a hash for deduplication, and the scanner (with
// its hashes) is dropped when the scan ends.

export type SecretType =
  | 'aws'
  | 'github'
  | 'openai'
  | 'anthropic'
  | 'stripe'
  | 'gcp'
  | 'slack'
  | 'private_key'
  | 'jwt'
  | 'db_url'
  | 'other_provider';

export const SECRET_TYPES: readonly SecretType[] = [
  'aws',
  'github',
  'openai',
  'anthropic',
  'stripe',
  'gcp',
  'slack',
  'private_key',
  'jwt',
  'db_url',
  'other_provider',
];

interface Rule {
  type: SecretType;
  /** Substrings a match must contain; a text without any of them skips the regex (prefilter). */
  keywords: readonly string[];
  pattern: string;
}

const RULES: readonly Rule[] = [
  // Key ids encode their account in base32, so the body never holds 0, 1, 8 or 9.
  {
    type: 'aws',
    keywords: ['AKIA', 'ASIA', 'ABIA', 'ACCA'],
    pattern: String.raw`\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}\b`,
  },
  {
    type: 'github',
    keywords: ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_'],
    pattern: String.raw`\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,})\b`,
  },
  {
    type: 'anthropic',
    keywords: ['sk-ant-'],
    pattern: String.raw`\bsk-ant-[a-z]{2,8}\d{2}-[A-Za-z0-9_-]{32,}`,
  },
  {
    type: 'openai',
    keywords: ['sk-'],
    pattern: String.raw`\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}|\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}`,
  },
  // Live keys only: test-mode keys move no money and fill documentation.
  {
    type: 'stripe',
    keywords: ['sk_live_', 'rk_live_'],
    pattern: String.raw`\b[rs]k_live_[A-Za-z0-9]{20,}\b`,
  },
  {
    type: 'gcp',
    keywords: ['AIza'],
    pattern: String.raw`\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])`,
  },
  {
    type: 'slack',
    keywords: ['xox', 'hooks.slack.com'],
    pattern: String.raw`\bxox[abprs]-[A-Za-z0-9-]{10,}|https://hooks\.slack\.com/services/T[A-Za-z0-9]+/B[A-Za-z0-9]+/[A-Za-z0-9]{20,}`,
  },
  {
    type: 'private_key',
    keywords: ['PRIVATE KEY'],
    pattern: String.raw`-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\s\S]{20,}?-----END`,
  },
  {
    type: 'jwt',
    keywords: ['eyJ'],
    pattern: String.raw`\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`,
  },
  {
    type: 'db_url',
    keywords: ['://'],
    pattern: String.raw`\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?|mssql)://[^\s:@/'"]+:[^\s@/'"]{3,}@[^\s/'"]+`,
  },
  {
    type: 'other_provider',
    keywords: ['npm_', 'hf_', 'glpat-', 'SG.', 'gsk_', 'xai-', 'pypi-'],
    pattern: String.raw`\bnpm_[A-Za-z0-9]{36}\b|\bhf_[A-Za-z0-9]{34}\b|\bglpat-[A-Za-z0-9_-]{20}\b|\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b|\bgsk_[A-Za-z0-9]{52}\b|\bxai-[A-Za-z0-9]{70,}|\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}`,
  },
];

/** All rules in one regex; the named group of a match tells its type. */
const COMBINED = new RegExp(RULES.map((r) => `(?<${r.type}>${r.pattern})`).join('|'), 'g');
const KEYWORDS = [...new Set(RULES.flatMap((r) => r.keywords))];

/** Every provider pattern as one fresh global regex, for redaction, which keeps no exceptions. */
export function secretPattern(): RegExp {
  return new RegExp(COMBINED.source, 'g');
}

/** Only the first part of a tool output is scanned. */
export const TOOL_OUTPUT_SCAN_BYTES = 64 * 1024;
const PROMPT_SCAN_CHARS = 256 * 1024;

/** A 64-bit FNV-1a hash in two halves; enough to tell secrets apart, useless to anyone else. */
function hash(value: string): string {
  let a = 0x811c9dc5;
  let b = 0xcbf29ce4;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x0100019d) >>> 0;
  }
  return `${a.toString(36)}.${b.toString(36)}`;
}

export interface SecretCounts {
  pasted: number;
  exposedViaTools: number;
  types: Partial<Record<SecretType, number>>;
  /** Each distinct secret counts once, for the tool that saw it first, so these add up to the totals. */
  byTool: Partial<Record<Tool, { pasted: number; exposed: number }>>;
}

/** Documentation examples and templates, not secrets. */
// `<[^<>]*>` and not `<[^>]*>`: the same matches, without a quadratic scan over a run of `<`.
const PLACEHOLDER =
  /example|x{6,}|your[_-]|dummy|fake|sample|placeholder|redacted|changeme|<[^<>]*>|\$\{|\*{3,}|0{8,}|1234567890/i;
const LOCAL_DB = /@(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|host\.docker\.internal)(?:[:/]|$)/i;
const TEMPLATE_CREDENTIALS =
  /:\/\/(?:user|username|postgres|root|admin|test|guest)?:(?:password|pass|passwd|secret|postgres|root|admin|test|guest|changeme)@/i;

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function crc32(text: string): number {
  let crc = 0xffffffff;
  for (let i = 0; i < text.length; i++) {
    let c = (crc ^ text.charCodeAt(i)) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * The six characters a classic GitHub token (`ghp_` and its kin) ends with: the CRC32 of its 30
 * random characters in base62. GitHub issues every token with it, so one whose checksum fails
 * was typed or generated, not issued. Exported for tests that make valid-looking fakes.
 */
export function githubChecksum(body: string): string {
  let n = crc32(body);
  let out = '';
  do {
    out = (BASE62[n % 62] as string) + out;
    n = Math.floor(n / 62);
  } while (n > 0);
  return out.padStart(6, '0');
}

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * The claims of a JWT, when its middle part is base64url JSON. Bytes become characters one by
 * one, which keeps ASCII claims such as `iss` and `role` exact (core has no TextDecoder).
 */
function jwtClaims(token: string): Record<string, unknown> | undefined {
  const part = token.split('.')[1] ?? '';
  let bits = 0;
  let value = 0;
  let text = '';
  for (const ch of part) {
    const digit = BASE64URL.indexOf(ch);
    if (digit < 0) return undefined;
    value = (value << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      text += String.fromCharCode((value >> bits) & 0xff);
    }
  }
  try {
    const claims: unknown = JSON.parse(text);
    return claims && typeof claims === 'object' ? (claims as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Matches that unlock nothing: examples, templates, local and public keys, unissued tokens. */
function notASecret(type: SecretType, value: string): boolean {
  if (PLACEHOLDER.test(value)) return true;
  if (type !== 'private_key' && new Set(value.slice(Math.min(8, value.length >> 1))).size <= 4)
    return true;
  if (type === 'db_url') return LOCAL_DB.test(value) || TEMPLATE_CREDENTIALS.test(value);
  if (type === 'jwt') {
    // Supabase's local stack ships the same demo keys to everyone, and an anon key is made to
    // sit in web pages: neither grants anything a visitor does not have.
    const claims = jwtClaims(value);
    return claims?.iss === 'supabase-demo' || claims?.role === 'anon';
  }
  if (type === 'github' && /^gh[pousr]_/.test(value))
    return githubChecksum(value.slice(4, 34)) !== value.slice(34, 40);
  return false;
}

/** The types of secrets in a text. Exported for tests; production code uses `SecretScanner`. */
export function findSecrets(text: string): { type: SecretType; key: string }[] {
  if (!KEYWORDS.some((k) => text.includes(k))) return [];
  const found: { type: SecretType; key: string }[] = [];
  for (const m of text.matchAll(COMBINED)) {
    const groups = m.groups ?? {};
    const type = SECRET_TYPES.find((t) => groups[t] !== undefined);
    if (type && !notASecret(type, m[0])) found.push({ type, key: hash(m[0]) });
  }
  return found;
}

/** Counts distinct secrets in prompts (pasted) and in tool outputs (exposed) while a scan runs. */
export class SecretScanner {
  private readonly pasted = new Map<string, { type: SecretType; tools: Set<Tool> }>();
  private readonly exposed = new Map<string, { type: SecretType; tools: Set<Tool> }>();

  private add(map: SecretScanner['pasted'], text: string, tool: Tool): void {
    for (const { type, key } of findSecrets(text)) {
      const entry = map.get(key) ?? { type, tools: new Set<Tool>() };
      entry.tools.add(tool);
      map.set(key, entry);
    }
  }

  prompt(text: string, tool: Tool): void {
    this.add(
      this.pasted,
      text.length > PROMPT_SCAN_CHARS ? text.slice(0, PROMPT_SCAN_CHARS) : text,
      tool,
    );
  }

  toolOutput(text: string, tool: Tool): void {
    this.add(
      this.exposed,
      text.length > TOOL_OUTPUT_SCAN_BYTES ? text.slice(0, TOOL_OUTPUT_SCAN_BYTES) : text,
      tool,
    );
  }

  counts(): SecretCounts {
    const types: Partial<Record<SecretType, number>> = {};
    const byTool: Partial<Record<Tool, { pasted: number; exposed: number }>> = {};
    const tally = (entry: { type: SecretType; tools: Set<Tool> }, field: 'pasted' | 'exposed') => {
      types[entry.type] = (types[entry.type] ?? 0) + 1;
      const [tool] = entry.tools;
      if (!tool) return;
      const t = byTool[tool] ?? { pasted: 0, exposed: 0 };
      t[field]++;
      byTool[tool] = t;
    };
    let exposedViaTools = 0;
    for (const entry of this.pasted.values()) tally(entry, 'pasted');
    for (const [key, entry] of this.exposed) {
      if (this.pasted.has(key)) continue;
      exposedViaTools++;
      tally(entry, 'exposed');
    }
    return { pasted: this.pasted.size, exposedViaTools, types, byTool };
  }

  /** The counts, once the scan is over. The dedupe hashes are dropped here. */
  finish(): SecretCounts {
    const counts = this.counts();
    this.pasted.clear();
    this.exposed.clear();
    return counts;
  }
}
