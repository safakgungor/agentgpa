import { describe, expect, it } from 'vitest';
import {
  createCursorParser,
  LANG_CATEGORIES,
  TOOL_FLAGS,
  type ToolCallEvent,
} from '../src/index.ts';
import { count, hash, parseCursor } from './fixtures.ts';

const created = Date.UTC(2027, 0, 4, 9);
const composer = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    _v: 16,
    createdAt: created,
    lastUpdatedAt: created + 600_000,
    unifiedMode: 'agent',
    modelConfig: { modelName: 'default' },
    ...extra,
  });
const bubble = (type: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    _v: 3,
    type,
    createdAt: new Date(created + 60_000).toISOString(),
    text: '',
    ...extra,
  });

describe('Cursor fixtures (scrubbed real chats)', () => {
  const result = parseCursor();

  it('reads a chat from its bubbles and ignores its transcript', () => {
    const fromBubbles = result.sessions.find((s) => s.events.every((e) => !('approx' in e)));
    expect(fromBubbles?.events.filter((e) => e.kind === 'user_prompt')).toHaveLength(5);
    expect(fromBubbles?.formatVersion).toBe(16);
    expect(result.stats.notPrompts.transcript_of_a_chat_with_bubbles).toBe(10);
  });

  it('reads a chat without bubbles from its transcript, with approximate times', () => {
    const fromTranscript = result.sessions.find((s) => s.events.some((e) => 'approx' in e));
    const prompts = fromTranscript?.events.filter((e) => e.kind === 'user_prompt') ?? [];
    expect(prompts).toHaveLength(4);
    expect(
      prompts.every(
        (p) => p.kind === 'user_prompt' && p.approx && !p.text.includes('<user_query>'),
      ),
    ).toBe(true);
  });

  it('counts status lines as a kind, not as broken lines', () => {
    expect(result.sessions).toHaveLength(2);
    expect(count(result, 'user_prompt')).toBe(9);
    expect(result.stats.kinds['transcript/turn_ended']).toBe(5);
    expect(result.stats.malformed).toBe(0);
  });
});

describe('Cursor rules (synthetic records)', () => {
  it('reads prompts, replies, usage, tool calls and decisions from bubbles', () => {
    const p = createCursorParser({ hash });
    p.composer('c1', composer());
    p.bubble('c1', 'b1', bubble(1, { text: 'add a login page', images: [{}] }));
    p.bubble(
      'c1',
      'b2',
      bubble(2, {
        text: 'Done.',
        tokenCount: { inputTokens: 120, outputTokens: 30 },
        modelInfo: { modelName: 'composer-2.5' },
        serverBubbleId: 's1',
      }),
    );
    p.bubble(
      'c1',
      'b3',
      bubble(2, {
        toolFormerData: {
          name: 'run_terminal_cmd',
          status: 'completed',
          params: JSON.stringify({ command: 'pnpm test' }),
        },
      }),
    );
    p.bubble(
      'c1',
      'b4',
      bubble(2, {
        toolFormerData: {
          name: 'search_replace',
          status: 'error',
          params: JSON.stringify({ old_string: 'a', new_string: 'a\nb' }),
        },
      }),
    );
    p.bubble(
      'c1',
      'b5',
      bubble(2, { toolFormerData: { name: 'write', userDecision: 'rejected', params: '{}' } }),
    );
    p.bubble('c1', 'b1', bubble(1, { text: 'a repeated bubble' }));
    const s = p.finish().sessions[0];
    expect(s?.events.filter((e) => e.kind === 'user_prompt')).toMatchObject([
      { text: 'add a login page', images: 1 },
    ]);
    expect(s?.events.filter((e) => e.kind === 'usage')).toMatchObject([
      { input: 120, output: 30, model: 'composer-2.5' },
    ]);
    expect(s?.events.filter((e) => e.kind === 'tool_call')).toMatchObject([
      { name: 'run_terminal_cmd', category: 'Bash', flags: TOOL_FLAGS.test },
      { name: 'search_replace', category: 'Edit', linesAdded: 2, linesRemoved: 1, error: true },
      { name: 'write', category: 'Write', declined: true },
    ]);
    expect(s?.models.sort()).toEqual(['composer-2.5', 'default']);
    expect(s?.messageIds).toEqual(['s1']);
  });

  it('marks plan mode from plan execution bubbles and plan modes', () => {
    const p = createCursorParser({ hash });
    p.composer('c1', composer());
    p.bubble('c1', 'b1', bubble(1, { text: 'go', isPlanExecution: true }));
    p.composer('c2', composer({ unifiedMode: 'plan' }));
    p.bubble('c2', 'b2', bubble(1, { text: 'plan it' }));
    expect(p.finish().sessions.map((s) => s.usedPlanMode)).toEqual([true, true]);
  });

  it('treats empty records and broken JSON without crashing', () => {
    const p = createCursorParser({ hash });
    p.composer('c1', '');
    p.composer('c2', '{broken');
    p.bubble('c3', 'b1', 'not json');
    p.transcriptLine('c4', '{"role":"user"}', created);
    const r = p.finish();
    expect(r.sessions).toHaveLength(0);
    expect(r.stats.malformed).toBe(3);
    expect(r.stats.kinds['composer/empty']).toBe(1);
  });
});

describe('skeleton v2 facts from Cursor bubbles', () => {
  it('reads file categories, sensitive reads, test results and the entry point', () => {
    const p = createCursorParser({ hash });
    p.composer('c1', composer());
    p.bubble('c1', 'v1', bubble(1, { text: 'go' }));
    const tool = (id: string, name: string, params: Record<string, unknown>, result?: string) =>
      p.bubble(
        'c1',
        id,
        bubble(2, {
          toolFormerData: { name, status: 'completed', params: JSON.stringify(params), result },
        }),
      );
    tool('v2', 'edit_file', { target_file: 'web/App.tsx', code_edit: 'x' });
    tool('v3', 'read_file', { target_file: 'deploy/server.pem' });
    tool('v4', 'run_terminal_cmd', { command: 'pytest -q' }, '3 passed in 0.12s');
    const s = p.finish().sessions[0];
    const calls = (s?.events ?? []).filter((e): e is ToolCallEvent => e.kind === 'tool_call');
    expect(calls.map((c) => [c.name, c.langCat, c.sensitive, c.testResult])).toEqual([
      ['edit_file', LANG_CATEGORIES.indexOf('typescript'), undefined, undefined],
      ['read_file', undefined, true, undefined],
      ['run_terminal_cmd', undefined, undefined, 'pass'],
    ]);
    expect(s?.entrypoint).toBe('editor');
    expect((calls[2]?.flags ?? 0) & TOOL_FLAGS.test).toBe(TOOL_FLAGS.test);
  });
});
