import { describe, expect, it } from 'vitest';
import { createClaudeCodeParser, createCodexParser, createCursorParser } from '../src/index.ts';
import { claudeFiles, hash, lines } from './fixtures.ts';

// Random, truncated, huge and hostile lines must never crash a parser or pollute objects.

let seed = 20261019;
const random = (): number => {
  seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
  return seed / 2 ** 31;
};
const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;

const fragments = [
  '{',
  '}',
  '[',
  ']',
  '"',
  ':',
  ',',
  'null',
  'true',
  '"type"',
  '"user"',
  '"assistant"',
  '"message"',
  '"content"',
  '"__proto__"',
  '\\u0000',
  String.fromCodePoint(0x202e),
  String.fromCharCode(0xd800),
  '1e999',
  '-0',
  '"timestamp"',
  '"2027-01-04T09:00:00Z"',
];

function randomLine(): string {
  const parts: string[] = [];
  const size = Math.floor(random() * 40);
  for (let i = 0; i < size; i++)
    parts.push(
      random() < 0.6 ? pick(fragments) : String.fromCharCode(Math.floor(random() * 0xffff)),
    );
  return parts.join('');
}

const hostile = [
  '{"type":"__proto__","uuid":"x","timestamp":"2027-01-04T09:00:00Z"}',
  '{"type":"user","__proto__":{"polluted":1},"timestamp":"2027-01-04T09:00:00Z","message":{"content":"hi"}}',
  '{"type":"user","constructor":{"prototype":{"polluted":1}},"timestamp":"2027-01-04T09:00:00Z","message":{"content":"x"}}',
  '{"type":"assistant","timestamp":"2027-01-04T09:00:00Z","message":{"model":"constructor","content":[{"type":"tool_use","id":"toolu_01p","name":"__proto__","input":{}}]}}',
  '{"type":"user","timestamp":"2027-01-04T09:00:00Z","permissionMode":"constructor","message":{"content":"a"}}',
  '{"type":"user","timestamp":"not a time","message":{"content":"a"}}',
  '{"type":"user","timestamp":"2027-01-04T09:00:00Z","message":{"content":[null,1,"x",{"type":"text"},{"type":"tool_result"}]}}',
  '{"timestamp":"2027-01-04T09:00:00Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":-5,"output_tokens":"many"}}}}',
  '{"timestamp":"2027-01-04T09:00:00Z","type":"event_msg","payload":{"type":"item_completed","item":{"type":"UserMessage","content":"not an array"}}}',
  `${'['.repeat(20_000)}${']'.repeat(20_000)}`,
  JSON.stringify({
    type: 'user',
    timestamp: '2027-01-04T09:00:00Z',
    message: { content: 'x'.repeat(2_000_000) },
  }),
  '[]',
  '"just a string"',
  '42',
  'null',
];

describe('parser fuzz suite', () => {
  const real = claudeFiles()
    .flatMap((f) => lines(f.path))
    .slice(0, 400);
  const truncated = real.map((l) => l.slice(0, Math.floor(random() * l.length)));
  const random1 = Array.from({ length: 3000 }, randomLine);
  const all = [...hostile, ...truncated, ...random1];

  it('Claude Code: never throws, counts every line, keeps prototypes clean', () => {
    const parser = createClaudeCodeParser({ hash });
    for (const line of all)
      parser.line(line, {
        kind: pick(['main', 'subagent', 'workflow-agent'] as const),
        sessionId: 's',
      });
    const result = parser.finish();
    expect(parser.stats.lines).toBe(all.length);
    expect(result.stats.malformed).toBeGreaterThan(0);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(result.stats.kinds)).toBeNull();
  });

  it('Codex: never throws and keeps usage from going negative', () => {
    const parser = createCodexParser({ hash });
    for (const line of all) parser.line(line, 's');
    const result = parser.finish();
    for (const event of result.sessions.flatMap((s) => s.events)) {
      if (event.kind === 'usage')
        expect(
          Math.min(event.input, event.output, event.cacheRead, event.cacheWrite),
        ).toBeGreaterThanOrEqual(0);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('Cursor: never throws on random records and transcript lines', () => {
    const parser = createCursorParser({ hash });
    for (const [i, line] of all.entries()) {
      if (i % 3 === 0) parser.composer(`c${i % 7}`, line);
      else if (i % 3 === 1) parser.bubble(`c${i % 7}`, `b${i}`, line);
      else parser.transcriptLine(`c${i % 7}`, line, 1_800_000_000_000);
    }
    expect(() => parser.finish()).not.toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
