import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// CLAUDE.md: @agentgpa/core is pure. No fs, no network, no Node-only APIs.
const SRC = fileURLToPath(new URL('../src/', import.meta.url));

const NODE_BUILTINS = [
  'assert',
  'buffer',
  'child_process',
  'cluster',
  'crypto',
  'dgram',
  'dns',
  'events',
  'fs',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'querystring',
  'readline',
  'repl',
  'stream',
  'string_decoder',
  'timers',
  'tls',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'worker_threads',
  'zlib',
];

const RULES: [string, RegExp][] = [
  ['a node: import', /from\s+['"]node:|import\(\s*['"]node:/],
  ['a Node built-in import', new RegExp(`from\\s+['"](${NODE_BUILTINS.join('|')})(/[^'"]*)?['"]`)],
  ['require()', /\brequire\s*\(/],
  ['process', /\bprocess\s*\./],
  ['a network call', /\b(fetch|XMLHttpRequest|WebSocket)\s*\(/],
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('@agentgpa/core purity', () => {
  it('has source files to check', () => {
    expect(sourceFiles(SRC).length).toBeGreaterThan(0);
  });

  it('imports no Node built-ins and makes no network calls', () => {
    const found = sourceFiles(SRC).flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      return RULES.filter(([, rule]) => rule.test(text)).map(([name]) => `${file}: ${name}`);
    });
    expect(found).toEqual([]);
  });
});

// Formatters can turn escapes such as \u202e into the characters themselves, and invisible
// characters in source hide what code does. None may appear anywhere in the repository.
describe('repository text', () => {
  const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
  const code = (c: number): string => String.fromCodePoint(c);
  const range = (a: number, b: number): string => `${code(a)}-${code(b)}`;
  const INVISIBLE = new RegExp(
    `[${range(0x00, 0x08)}${code(0x0b)}${code(0x0c)}${range(0x0e, 0x1f)}${range(0x7f, 0x9f)}${range(0x200b, 0x200f)}${range(0x202a, 0x202e)}${range(0x2060, 0x2064)}${range(0x2066, 0x2069)}${code(0xfeff)}]`,
  );
  const textFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.config')
        return [];
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return textFiles(path);
      return /\.(ts|js|json|jsonl|md|yml|yaml)$/.test(entry.name) ? [path] : [];
    });

  it('holds no control, bidi or zero-width characters', () => {
    const found = textFiles(ROOT).filter((file) => INVISIBLE.test(readFileSync(file, 'utf8')));
    expect(found).toEqual([]);
  });
});
