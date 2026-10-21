import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readLines } from '../src/read.ts';

const dir = mkdtempSync(join(tmpdir(), 'agentgpa-read-'));

async function read(
  content: string | Buffer,
  max?: number,
): Promise<{ lines: string[]; oversized: number }> {
  const path = join(dir, `f${Math.random()}.jsonl`);
  writeFileSync(path, content);
  const lines: string[] = [];
  const result = await readLines(path, (l) => lines.push(l), max);
  return { lines, oversized: result.oversized };
}

describe('readLines', () => {
  it('splits lines, drops empty ones and CR, and reads a last line without a newline', async () => {
    expect((await read('a\r\nb\n\nc')).lines).toEqual(['a', 'b', 'c']);
  });

  it('keeps multi-byte characters that cross a chunk boundary', async () => {
    const long = `${'x'.repeat(1024 * 1024 - 1)}ışık`;
    const { lines } = await read(`${long}\nnext\n`);
    expect(lines).toEqual([long, 'next']);
  });

  it('skips lines over the limit without decoding them, and counts them', async () => {
    const { lines, oversized } = await read(
      `short\n${'y'.repeat(5000)}\nafter\n${'z'.repeat(5000)}`,
      1000,
    );
    expect(lines).toEqual(['short', 'after']);
    expect(oversized).toBe(2);
  });

  it('skips a huge line that spans several chunks', async () => {
    const { lines, oversized } = await read(
      Buffer.concat([
        Buffer.from('a\n'),
        Buffer.alloc(3 * 1024 * 1024, 0x61),
        Buffer.from('\nb\n'),
      ]),
      2 * 1024 * 1024,
    );
    expect(lines).toEqual(['a', 'b']);
    expect(oversized).toBe(1);
  });
});
