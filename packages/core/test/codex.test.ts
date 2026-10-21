import { describe, expect, it } from 'vitest';
import {
  createCodexParser,
  LANG_CATEGORIES,
  TOOL_FLAGS,
  type ToolCallEvent,
  type UsageEvent,
} from '../src/index.ts';
import { count, hash, parseCodex } from './fixtures.ts';

const SESSION = '01999999-0000-7000-8000-000000000001';
let t = 0;
const line = (type: string, payload: Record<string, unknown>) =>
  JSON.stringify({
    timestamp: new Date(Date.UTC(2027, 0, 4, 9, 0, t++)).toISOString(),
    type,
    payload,
  });
const meta = line('session_meta', {
  id: SESSION,
  cli_version: '0.148.0',
  originator: 'codex_cli_rs',
  source: 'cli',
  cwd: '/home/dev/p',
});
const turn = (extra: Record<string, unknown> = {}) =>
  line('turn_context', {
    turn_id: 't1',
    model: 'gpt-5.6-sol',
    collaboration_mode: { mode: 'default' },
    sandbox_policy: { type: 'workspace-write' },
    ...extra,
  });
const tokens = (input: number, cached: number, output: number) =>
  line('event_msg', {
    type: 'token_count',
    info: {
      total_token_usage: {
        input_tokens: input,
        cached_input_tokens: cached,
        output_tokens: output,
      },
    },
  });

function parse(lines: string[]) {
  const parser = createCodexParser({ hash });
  for (const l of lines) parser.line(l, SESSION);
  return parser.finish();
}

describe('Codex fixture (a scrubbed real rollout)', () => {
  const result = parseCodex();
  const session = result.sessions[0];

  it('reads one session with its version, entry point, model and sandbox mode', () => {
    expect(result.sessions).toHaveLength(1);
    expect(session?.version).toBe('0.146.0-alpha.3.1');
    expect(session?.entrypoint).toBe('codex_work_desktop');
    expect(session?.models).toEqual(['gpt-5.6-sol']);
    expect(session?.permissionModes).toEqual({ 'sandbox:workspace-write': 3 });
    expect(result.stats.malformed).toBe(0);
  });

  it('takes prompts from UserMessage items, not from the model input that repeats them', () => {
    expect(count(result, 'user_prompt')).toBe(3);
    expect(count(result, 'assistant_text')).toBe(5);
  });

  it('turns cumulative token totals into per-call usage', () => {
    const usage = (session?.events ?? []).filter((e): e is UsageEvent => e.kind === 'usage');
    expect(usage).toHaveLength(6);
    expect(usage.reduce((sum, u) => sum + u.input + u.cacheRead, 0)).toBe(40_000 + 140_000);
    expect(usage.every((u) => u.input >= 0 && u.cacheRead >= 0 && u.output >= 0)).toBe(true);
  });

  it('records tool calls by name', () => {
    expect(
      (session?.events ?? [])
        .filter((e) => e.kind === 'tool_call')
        .map((e) => (e.kind === 'tool_call' ? e.name : '')),
    ).toEqual(['exec', 'web_search', 'exec', 'web_search', 'exec', 'web_search']);
  });
});

describe('Codex rules (synthetic lines)', () => {
  it('never sums cumulative totals, and a repeated total adds nothing', () => {
    const r = parse([meta, turn(), tokens(100, 40, 10), tokens(100, 40, 10), tokens(250, 140, 30)]);
    const usage = (r.sessions[0]?.events ?? []).filter((e): e is UsageEvent => e.kind === 'usage');
    expect(usage.map((u) => [u.input, u.cacheRead, u.output])).toEqual([
      [60, 40, 10],
      [50, 100, 20],
    ]);
  });

  it('uses user_message events when a session has no UserMessage items (older versions)', () => {
    const r = parse([
      meta,
      turn(),
      line('event_msg', { type: 'user_message', message: 'make it faster' }),
      line('event_msg', { type: 'agent_message', message: 'done' }),
      line('response_item', {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'make it faster' }],
      }),
    ]);
    expect(count(r, 'user_prompt')).toBe(1);
    expect(count(r, 'assistant_text')).toBe(1);
  });

  it('falls back to model input without injected context only when nothing else exists', () => {
    const r = parse([
      meta,
      line('response_item', {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }],
      }),
      line('response_item', {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '# AGENTS.md instructions for the repo' }],
      }),
      line('response_item', {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'rename the module' }],
      }),
    ]);
    const prompts = r.sessions[0]?.events.filter((e) => e.kind === 'user_prompt') ?? [];
    expect(prompts.map((p) => (p.kind === 'user_prompt' ? p.text : ''))).toEqual([
      'rename the module',
    ]);
  });

  it('counts interrupts and plan mode, and keeps item ids apart per session', () => {
    const item = (id: string) =>
      line('event_msg', {
        type: 'item_completed',
        item: { id, type: 'UserMessage', content: [{ type: 'text', text: 'go' }] },
      });
    const r = parse([
      meta,
      turn({ collaboration_mode: { mode: 'plan' } }),
      item('item-1'),
      item('item-1'),
      line('event_msg', { type: 'turn_aborted', reason: 'interrupted' }),
    ]);
    expect(r.sessions[0]?.usedPlanMode).toBe(true);
    expect(count(r, 'interrupt')).toBe(1);
    expect(count(r, 'user_prompt')).toBe(1);
    const other = createCodexParser({ hash });
    for (const l of [item('item-1')]) other.line(l, 'another-session');
    for (const l of [item('item-1')]) other.line(l, SESSION);
    expect(count(other.finish(), 'user_prompt')).toBe(2);
  });

  it('reads shell commands and patches for flags, lines and failures', () => {
    const r = parse([
      meta,
      turn(),
      line('event_msg', {
        type: 'item_completed',
        item: { id: 'item-1', type: 'UserMessage', content: [{ type: 'text', text: 'ship it' }] },
      }),
      line('response_item', {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'call_1',
        arguments: JSON.stringify({ cmd: 'gh pr create --fill' }),
      }),
      line('response_item', {
        type: 'function_call_output',
        call_id: 'call_1',
        output: JSON.stringify({ output: 'x', metadata: { exit_code: 1 } }),
      }),
      line('response_item', {
        type: 'custom_tool_call',
        name: 'apply_patch',
        call_id: 'call_2',
        input: '*** Begin Patch\n*** Update File: a.ts\n-a\n+b\n+c\n*** End Patch',
      }),
      line('response_item', {
        type: 'function_call',
        name: 'shell',
        call_id: 'call_3',
        arguments: JSON.stringify({ command: ['bash', '-lc', 'cargo test'] }),
      }),
    ]);
    const calls = (r.sessions[0]?.events ?? []).filter((e) => e.kind === 'tool_call');
    expect(calls).toMatchObject([
      { name: 'exec_command', category: 'Bash', flags: TOOL_FLAGS.prCreate, error: true },
      { name: 'apply_patch', category: 'Edit', linesAdded: 2, linesRemoved: 1 },
      { name: 'shell', category: 'Bash', flags: TOOL_FLAGS.test },
    ]);
  });
});

describe('skeleton v2 facts from Codex lines', () => {
  it('reads file categories from patches, sensitive reads and test results from outputs', () => {
    const r = parse([
      meta,
      turn(),
      line('event_msg', {
        type: 'item_completed',
        item: { id: 'item-1', type: 'UserMessage', content: [{ type: 'text', text: 'go' }] },
      }),
      line('response_item', {
        type: 'custom_tool_call',
        name: 'apply_patch',
        call_id: 'v1',
        input: '*** Begin Patch\n*** Add File: src/lib/date.rs\n+fn main() {}\n*** End Patch',
      }),
      line('response_item', {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'v2',
        arguments: JSON.stringify({ cmd: 'cat ~/.aws/credentials' }),
      }),
      line('response_item', {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'v3',
        arguments: JSON.stringify({ cmd: 'go test ./...' }),
      }),
      line('response_item', {
        type: 'function_call_output',
        call_id: 'v3',
        output: '--- FAIL: TestDate (0.00s)\nFAIL',
      }),
    ]);
    const calls = (r.sessions[0]?.events ?? []).filter(
      (e): e is ToolCallEvent => e.kind === 'tool_call',
    );
    expect(calls.map((c) => [c.name, c.langCat, c.sensitive, c.testResult])).toEqual([
      ['apply_patch', LANG_CATEGORIES.indexOf('rust'), undefined, undefined],
      ['exec_command', undefined, true, undefined],
      ['exec_command', undefined, undefined, 'fail'],
    ]);
  });

  it("returns each line's time, for the file checks", () => {
    const parser = createCodexParser({ hash });
    const l = line('session_meta', { id: SESSION });
    expect(parser.line(l, SESSION)).toBe(Date.parse(JSON.parse(l).timestamp));
    expect(parser.line('not json', SESSION)).toBeUndefined();
  });
});
