import { describe, expect, it } from 'vitest';
import { Scrubber } from '../scrub.ts';

// Every input below is synthetic. The scrubber must keep structure and replace all text.

const line = {
  type: 'user',
  uuid: '11111111-2222-4333-8444-555555555555',
  parentUuid: '66666666-7777-4888-9999-aaaaaaaaaaaa',
  sessionId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
  timestamp: '2026-05-10T09:30:00.000Z',
  cwd: '/Users/someone/work/secret-project',
  gitBranch: 'feature/quarterly-numbers',
  version: '2.1.219',
  message: {
    role: 'user',
    content: [
      { type: 'text', text: 'Please Refactor the Billing Module NOW!' },
      {
        type: 'tool_result',
        tool_use_id: 'toolu_01AbCdEfGhIjKlMnOpQrStUv',
        is_error: true,
        content: 'stack trace here',
      },
    ],
  },
};

describe('the fixture scrubber', () => {
  it('keeps keys, types, structure and structural values', () => {
    const out = new Scrubber({ shiftDays: 0 }).value(line) as typeof line;
    expect(Object.keys(out)).toEqual(Object.keys(line));
    expect(out.type).toBe('user');
    expect(out.version).toBe('2.1.219');
    expect(out.message.role).toBe('user');
    expect(out.message.content[1]).toMatchObject({ type: 'tool_result', is_error: true });
  });

  it('replaces text with synthetic words of the same shape', () => {
    const out = new Scrubber({ shiftDays: 0 }).value(line) as typeof line;
    const text = (out.message.content[0] as { text: string }).text;
    expect(text).not.toContain('Refactor');
    expect(text).toHaveLength('Please Refactor the Billing Module NOW!'.length);
    expect(text.split(' ').map((w) => w.length)).toEqual([6, 8, 3, 7, 6, 4]);
    expect(text).toMatch(
      /^[A-Z][a-z]{5} [A-Z][a-z]{7} [a-z]{3} [A-Z][a-z]{6} [A-Z][a-z]{5} [A-Z]{3}!$/,
    );
    expect(out.gitBranch).not.toContain('quarterly');
  });

  it('maps ids consistently, keeps their shape and moves times', () => {
    const scrubber = new Scrubber({ shiftDays: 364 });
    const a = scrubber.value(line) as typeof line;
    const b = scrubber.value({ parentUuid: line.uuid, ref: 'toolu_01AbCdEfGhIjKlMnOpQrStUv' }) as {
      parentUuid: string;
      ref: string;
    };
    expect(a.uuid).not.toBe(line.uuid);
    expect(a.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(b.parentUuid).toBe(a.uuid);
    const id = (a.message.content[1] as { tool_use_id: string }).tool_use_id;
    expect(id).toMatch(/^toolu_01[0-9A-Za-z]{22}$/);
    expect(b.ref).toBe(id);
    expect(a.timestamp).toBe('2027-05-09T09:30:00.000Z');
  });

  it('keeps the time inside a UUID v7 consistent with the shifted times', () => {
    const v7 = '0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';
    const out = new Scrubber({ shiftDays: 1 }).string(v7, 'id');
    const ms = (s: string) => Number.parseInt(s.replace(/-/g, '').slice(0, 12), 16);
    expect(out[14]).toBe('7');
    expect(ms(out) - ms(v7)).toBe(86_400_000);
  });

  it('replaces paths, emails, URLs and MCP names', () => {
    const scrubber = new Scrubber({ shiftDays: 0 });
    expect(scrubber.string('/Users/someone/work/secret-project/src/app.ts', 'file_path')).toMatch(
      /^\/home\/dev\/project-\d+(\/dir-\d+)*\/file-\d+\.ts$/,
    );
    expect(scrubber.string('someone@example.org', 'email')).toMatch(/^user\d+@example\.com$/);
    expect(scrubber.string('https://acme.io/private/page', 'url')).toMatch(
      /^https:\/\/example\.com\//,
    );
    expect(scrubber.string('mcp__acme-crm__lookup_customer', 'name')).toBe('mcp__server_1__tool_1');
    expect(scrubber.string('Bash', 'name')).toBe('Bash');
  });

  it('replaces emails, URLs, domains, paths, time zones and names in free text whole', () => {
    const scrubber = new Scrubber({ shiftDays: 0, names: ['someone', 'Ada Lovelace'] });
    const out = scrubber.text(
      'Mail someone12@example.org, see https://acme.io/a?b=1 or acme.io/docs, open /Users/someone/work/app.ts in America/New_York; ask Ada Lovelace or someone.',
    );
    for (const placeholder of [
      'user@example.com',
      'https://example.com',
      ' example.com,',
      '/home/dev/path',
      'Etc/UTC;',
    ])
      expect(out).toContain(placeholder);
    expect(out).toMatch(/ dev [a-z]+ dev\.$/);
    for (const word of ['someone', 'example.org', 'acme', 'Users', 'New_York', 'Lovelace'])
      expect(out).not.toContain(word);
    // Nothing of the email's shape (its letters, digits and @) is left to match a guess.
    expect(out).not.toMatch(/[A-Za-z]{7}\d\d[a@]/);
  });

  it('turns a time zone value into UTC and money into 0', () => {
    const scrubber = new Scrubber({ shiftDays: 0 });
    expect(
      scrubber.value({
        timezone: 'Europe/Istanbul',
        totalCostUSD: 27.5,
        usage: { costUSD: 3.1, input_tokens: 12 },
      }),
    ).toEqual({ timezone: 'Etc/UTC', totalCostUSD: 0, usage: { costUSD: 0, input_tokens: 12 } });
  });

  it('keeps two significant digits of token counts and durations, and limits exact', () => {
    const scrubber = new Scrubber({ shiftDays: 0 });
    expect(
      scrubber.value({
        usage: { input_tokens: 12_345, output_tokens: 87, cache_read_input_tokens: 1_000 },
        durationMs: 4_321,
        turnDurationMs: 99.5,
        contextTokenLimit: 200_000,
        maxTokens: 12_345,
        bytes: 12_345,
      }),
    ).toEqual({
      usage: { input_tokens: 12_000, output_tokens: 87, cache_read_input_tokens: 1_000 },
      durationMs: 4_300,
      turnDurationMs: 99.5,
      contextTokenLimit: 200_000,
      maxTokens: 12_345,
      bytes: 12_345,
    });
  });

  it('keeps client markers and built-in command names, and hides custom commands', () => {
    const scrubber = new Scrubber({ shiftDays: 0 });
    expect(scrubber.text('[Request interrupted by user for tool use]')).toBe(
      '[Request interrupted by user for tool use]',
    );
    const command = scrubber.text(
      '<command-name>/compact</command-name>\n<command-args>keep the tests</command-args>',
    );
    expect(command.startsWith('<command-name>/compact</command-name>\n<command-args>')).toBe(true);
    expect(command).not.toContain('tests');
    expect(scrubber.text('<command-name>/deploy-acme</command-name>')).toMatch(
      /^<command-name>\/custom-\d+<\/command-name>$/,
    );
    expect(scrubber.text('<user_query>\nfix the parser\n</user_query>')).toMatch(
      /^<user_query>\n[a-z]{3} [a-z]{3} [a-z]{6}\n<\/user_query>$/,
    );
  });

  it('turns the keys and values of MCP inputs into data', () => {
    const scrubber = new Scrubber({ shiftDays: 0 });
    const use = scrubber.value({
      type: 'tool_use',
      id: 'toolu_01ZzZzZzZzZzZzZzZzZzZzZz',
      name: 'mcp__acme__search',
      input: { customerName: 'Jane' },
    }) as { input: Record<string, unknown> };
    expect(Object.keys(use.input)).not.toContain('customerName');
  });

  it('parses JSON inside strings and scrubs it in place', () => {
    const out = new Scrubber({ shiftDays: 0 }).string(
      '{"command":"git commit -m wip","old_string":"a\\nb"}',
      'params',
    );
    const parsed = JSON.parse(out) as { command: string; old_string: string };
    expect(Object.keys(parsed)).toEqual(['command', 'old_string']);
    expect(parsed.command).not.toContain('commit');
    expect(parsed.old_string.split('\n')).toHaveLength(2);
  });

  it('finds replaced text that survived in an output', () => {
    const scrubber = new Scrubber({ shiftDays: 0 });
    const out = JSON.stringify(scrubber.value(line));
    expect(scrubber.leaks(out)).toBe(0);
    expect(scrubber.leaks(`${out} Refactor quarterly`)).toBe(2);
  });

  it('never writes a word that secret scanners key on', () => {
    const scrubber = new Scrubber({ shiftDays: 0, maxText: 10_000 });
    const words = Array.from({ length: 4000 }, (_, i) => `w${i}xxxxxxxxxx`.slice(0, 3 + (i % 9)));
    const out = scrubber.text(words.join(' '));
    expect(out).not.toMatch(/key|token|secret|passw|pwd|auth|api|access|cred|bearer/i);
  });
});
