import { describe, expect, it } from 'vitest';
import {
  type ClaudeFile,
  createClaudeCodeParser,
  LANG_CATEGORIES,
  TOOL_FLAGS,
  type ToolCallEvent,
} from '../src/index.ts';
import { claudeFiles, count, hash, lines, parseClaude } from './fixtures.ts';

const MAIN: ClaudeFile = { kind: 'main', sessionId: 's1' };
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2027, 0, 4, 9, minute)).toISOString();

function user(content: unknown, extra: Record<string, unknown> = {}, minute = 0): string {
  return JSON.stringify({
    type: 'user',
    uuid: uuid(),
    sessionId: 's1',
    timestamp: at(minute),
    cwd: '/home/dev/p',
    message: { role: 'user', content },
    ...extra,
  });
}

function assistant(content: unknown[], extra: Record<string, unknown> = {}, minute = 1): string {
  const { message, ...rest } = extra as { message?: Record<string, unknown> };
  return JSON.stringify({
    type: 'assistant',
    uuid: uuid(),
    sessionId: 's1',
    timestamp: at(minute),
    requestId: 'req_011',
    message: {
      id: 'msg_011',
      model: 'claude-opus-5-5',
      role: 'assistant',
      content,
      usage: { input_tokens: 10, output_tokens: 5 },
      ...message,
    },
    ...rest,
  });
}

function parse(input: string[], file = MAIN) {
  const parser = createClaudeCodeParser({ hash });
  for (const line of input) parser.line(line, file);
  return parser.finish();
}

describe('Claude Code fixtures (scrubbed real sessions)', () => {
  const result = parseClaude();

  it('finds every session and joins subagent files to their parent', () => {
    expect(claudeFiles().filter((f) => f.kind === 'main')).toHaveLength(6);
    expect(result.sessions).toHaveLength(6);
    expect(result.sessions.filter((s) => s.subagents > 0)).toHaveLength(4);
    expect(result.stats.malformed).toBe(0);
  });

  it('counts prompts, queued prompts and interrupts, and nothing that only looks like a prompt', () => {
    expect(count(result, 'user_prompt')).toBe(18);
    const queued = result.sessions
      .flatMap((s) => s.events)
      .filter((e) => e.kind === 'user_prompt' && e.queued);
    expect(queued).toHaveLength(3);
    expect(count(result, 'interrupt')).toBe(2);
    expect(result.stats.notPrompts).toMatchObject({
      'origin:task-notification': 12,
      meta: 8,
      slash_command: 2,
      compact_summary: 1,
      queued_not_human: 1,
    });
  });

  it('counts each reply and tool call once, and keeps subagent traffic apart', () => {
    const calls = result.sessions
      .flatMap((s) => s.events)
      .filter((e): e is ToolCallEvent => e.kind === 'tool_call');
    expect(count(result, 'usage')).toBe(161);
    expect(calls).toHaveLength(198);
    expect(calls.filter((c) => c.sidechain)).toHaveLength(23);
    expect(calls.filter((c) => c.error)).toHaveLength(9);
    expect(calls.filter((c) => c.declined)).toHaveLength(1);
  });

  it('records plan mode, compactions, commands, modes, versions and models', () => {
    expect(result.sessions.filter((s) => s.usedPlanMode)).toHaveLength(1);
    expect(result.sessions.reduce((sum, s) => sum + s.compactions, 0)).toBe(1);
    expect(result.sessions.some((s) => s.commands.model === 1)).toBe(true);
    expect(result.sessions.every((s) => s.entrypoint === 'claude-desktop')).toBe(true);
    expect(result.sessions.every((s) => /^2\.1\.\d+$/.test(s.version ?? ''))).toBe(true);
    expect(result.sessions.every((s) => s.models.every((m) => /^claude-/.test(m)))).toBe(true);
    expect(result.sessions.flatMap((s) => Object.keys(s.permissionModes)).sort()).toContain('auto');
  });

  it('never keeps a project path, only its hash', () => {
    expect(result.sessions.every((s) => s.projectKey.startsWith('hash:'))).toBe(true);
  });

  it('counts a session copied into a second file once (resumed sessions)', () => {
    const parser = createClaudeCodeParser({ hash });
    const main = claudeFiles().find((f) => f.kind === 'main');
    if (!main) throw new Error('no fixture');
    for (const line of lines(main.path)) parser.line(line, main);
    for (const line of lines(main.path)) parser.line(line, { kind: 'main', sessionId: 'copy' });
    const once = createClaudeCodeParser({ hash });
    for (const line of lines(main.path)) once.line(line, main);
    const [a, b] = [parser.finish(), once.finish()];
    expect(count(a, 'user_prompt')).toBe(count(b, 'user_prompt'));
    expect(count(a, 'usage')).toBe(count(b, 'usage'));
    expect(a.stats.duplicates).toBeGreaterThan(0);
  });
});

describe('Claude Code rules (synthetic lines)', () => {
  it('counts a typed prompt, an image sent alone, and the text after a leading reminder', () => {
    const r = parse([
      user('fix the parser'),
      user([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }]),
      user([{ type: 'text', text: '<system-reminder>context</system-reminder>\nand the tests' }]),
    ]);
    const prompts = r.sessions[0]?.events.filter((e) => e.kind === 'user_prompt') ?? [];
    expect(prompts.map((p) => (p.kind === 'user_prompt' ? [p.text, p.images] : []))).toEqual([
      ['fix the parser', 0],
      ['', 1],
      ['and the tests', 0],
    ]);
  });

  it('skips client wrappers, bash mode, notifications, reminders, meta, compaction and sidechain lines', () => {
    const r = parse([
      user('<command-name>/compact</command-name>\n<command-message>compact</command-message>'),
      user('<command-name>/deploy-acme</command-name>'),
      user('<local-command-stdout>done</local-command-stdout>'),
      user('<bash-input>ls</bash-input>'),
      user('<task-notification>done</task-notification>'),
      user([{ type: 'text', text: '<system-reminder>only this</system-reminder>' }]),
      user('expanded skill text', { isMeta: true }),
      user('This session is being continued from a previous conversation', {
        isCompactSummary: true,
      }),
      user('a message from another session', { origin: { kind: 'peer' } }),
      user('subagent task', { isSidechain: true }),
      user('the one real prompt'),
    ]);
    expect(r.sessions[0]?.events.filter((e) => e.kind === 'user_prompt')).toHaveLength(1);
    expect(r.sessions[0]?.commands).toEqual({ compact: 1, custom: 1 });
    expect(r.stats.notPrompts).toMatchObject({
      slash_command: 3,
      bash_mode: 1,
      task_notification: 1,
      system_reminder: 1,
      meta: 1,
      compact_summary: 1,
      'origin:peer': 1,
      sidechain: 1,
    });
  });

  it('counts interrupts, also when they ride on a tool result', () => {
    const r = parse([
      user('start'),
      user('[Request interrupted by user]'),
      user([
        { type: 'tool_result', tool_use_id: 'toolu_01x', content: 'x' },
        { type: 'text', text: '[Request interrupted by user for tool use]' },
      ]),
    ]);
    expect(r.sessions[0]?.events.filter((e) => e.kind === 'interrupt')).toHaveLength(2);
  });

  it('counts a reply split over several lines once, with its largest usage', () => {
    const r = parse([
      user('go'),
      assistant([{ type: 'thinking', thinking: 'hmm', signature: 's' }], {
        message: { usage: { input_tokens: 10, output_tokens: 1 } },
      }),
      assistant([{ type: 'text', text: 'You are absolutely right.' }], {
        message: { usage: { input_tokens: 10, output_tokens: 40, cache_read_input_tokens: 7 } },
      }),
      assistant([
        {
          type: 'tool_use',
          id: 'toolu_01a',
          name: 'Bash',
          input: { command: 'pnpm test && git commit -m wip' },
        },
      ]),
    ]);
    const events = r.sessions[0]?.events ?? [];
    expect(events.filter((e) => e.kind === 'usage')).toEqual([
      {
        kind: 'usage',
        ts: Date.parse(at(1)),
        sidechain: false,
        model: 'claude-opus-5-5',
        input: 10,
        output: 40,
        cacheRead: 7,
        cacheWrite: 0,
      },
    ]);
    expect(events.filter((e) => e.kind === 'assistant_text')).toHaveLength(1);
    expect(events.find((e) => e.kind === 'tool_call')).toMatchObject({
      name: 'Bash',
      category: 'Bash',
      flags: TOOL_FLAGS.test | TOOL_FLAGS.gitCommit,
    });
    expect(r.sessions[0]?.messageIds).toEqual(['msg_011']);
  });

  it('marks failed and declined tool calls, and counts edited lines', () => {
    const r = parse([
      assistant([
        {
          type: 'tool_use',
          id: 'toolu_01e',
          name: 'Edit',
          input: { old_string: 'a\nb', new_string: 'a\nb\nc' },
        },
        { type: 'tool_use', id: 'toolu_01f', name: 'Bash', input: { command: 'rm -rf build' } },
        { type: 'tool_use', id: 'toolu_01m', name: 'mcp__acme__lookup', input: {} },
      ]),
      user([
        { type: 'tool_result', tool_use_id: 'toolu_01e', is_error: true, content: 'no match' },
      ]),
      user(
        [{ type: 'tool_result', tool_use_id: 'toolu_01f', is_error: true, content: 'rejected' }],
        { toolDenialKind: 'user-rejected' },
      ),
    ]);
    const calls = (r.sessions[0]?.events ?? []).filter(
      (e): e is ToolCallEvent => e.kind === 'tool_call',
    );
    expect(calls.map((c) => [c.name, c.linesAdded, c.linesRemoved, c.error, c.declined])).toEqual([
      ['Edit', 3, 2, true, undefined],
      ['Bash', undefined, undefined, undefined, true],
      ['MCP', undefined, undefined, undefined, undefined],
    ]);
  });

  it('skips client-made replies and records plan mode', () => {
    const r = parse([
      user('plan it first', { permissionMode: 'plan' }),
      assistant([{ type: 'text', text: 'API Error' }], {
        message: { model: '<synthetic>', id: 'b7f1c2d4-0000-4000-8000-000000000000' },
      }),
    ]);
    expect(r.sessions[0]?.usedPlanMode).toBe(true);
    expect(r.sessions[0]?.events.filter((e) => e.kind === 'usage')).toHaveLength(0);
    expect(r.stats.notPrompts.synthetic_reply).toBe(1);
  });

  it('counts a queued prompt once and skips queued messages that are not from the person', () => {
    const queued = (prompt: string, extra: Record<string, unknown> = {}) =>
      JSON.stringify({
        type: 'attachment',
        uuid: uuid(),
        sessionId: 's1',
        timestamp: at(3),
        attachment: {
          type: 'queued_command',
          commandMode: 'prompt',
          prompt,
          origin: { kind: 'human' },
          ...extra,
        },
      });
    const r = parse([
      queued('also add a test'),
      queued('from a peer', { isMeta: true, origin: { kind: 'peer' } }),
      JSON.stringify({
        type: 'attachment',
        uuid: uuid(),
        timestamp: at(4),
        attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: 'x' },
      }),
    ]);
    const prompts = r.sessions[0]?.events.filter((e) => e.kind === 'user_prompt') ?? [];
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ queued: true, text: 'also add a test' });
  });

  it('counts broken lines and lines without a time as malformed, without stopping', () => {
    const r = parse([
      '{"type":"user"',
      'not json',
      JSON.stringify({ type: 'user', uuid: uuid(), message: { content: 'no time' } }),
      user('still counted'),
    ]);
    expect(r.stats.malformed).toBe(3);
    expect(r.sessions[0]?.events.filter((e) => e.kind === 'user_prompt')).toHaveLength(1);
  });
});

describe('skeleton v2 facts from Claude Code lines', () => {
  it('reads test results, file categories, sensitive reads, installs and lint runs', () => {
    const r = parse([
      user('run the tests'),
      assistant(
        [
          { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'pnpm test' } },
          { type: 'tool_use', id: 'tu2', name: 'Read', input: { file_path: '/home/dev/p/.env' } },
          {
            type: 'tool_use',
            id: 'tu3',
            name: 'Edit',
            input: { file_path: '/home/dev/p/src/app.py', old_string: 'a', new_string: 'b' },
          },
          {
            type: 'tool_use',
            id: 'tu4',
            name: 'Bash',
            input: { command: 'pnpm add zod && pnpm lint' },
          },
          { type: 'tool_use', id: 'tu5', name: 'Bash', input: { command: 'cargo test' } },
        ],
        { message: { id: 'msg_v2' } },
      ),
      user([{ type: 'tool_result', tool_use_id: 'tu1', content: 'Tests  12 passed (12)' }], {}, 2),
      user(
        [
          {
            type: 'tool_result',
            tool_use_id: 'tu5',
            content: 'error: test failed',
            is_error: true,
          },
        ],
        {},
        3,
      ),
    ]);
    const calls = (r.sessions[0]?.events ?? []).filter(
      (e): e is ToolCallEvent => e.kind === 'tool_call',
    );
    expect(calls.map((c) => [c.name, c.testResult, c.langCat, c.sensitive, c.flags])).toEqual([
      ['Bash', 'pass', undefined, undefined, TOOL_FLAGS.test],
      ['Read', undefined, undefined, true, undefined],
      ['Edit', undefined, LANG_CATEGORIES.indexOf('python'), undefined, undefined],
      ['Bash', undefined, undefined, undefined, TOOL_FLAGS.install | TOOL_FLAGS.lint],
      ['Bash', 'fail', undefined, undefined, TOOL_FLAGS.test],
    ]);
  });

  it("returns each line's time, for the file checks", () => {
    const parser = createClaudeCodeParser({ hash });
    expect(parser.line(user('hello', {}, 5), MAIN)).toBe(Date.parse(at(5)));
    expect(parser.line('{broken', MAIN)).toBeUndefined();
  });

  it("returns no time for a fork's copy of another session's line, which still joins that session", () => {
    const parser = createClaudeCodeParser({ hash });
    const fork: ClaudeFile = { kind: 'main', sessionId: 'fork' };
    expect(parser.line(user('copied from the parent', {}, 5), fork)).toBeUndefined();
    expect(parser.line(user('the fork goes on', { sessionId: 'fork' }, 50), fork)).toBe(
      Date.parse(at(50)),
    );
    // A session id the parser does not take is the file's, so its time counts for the file.
    expect(parser.line(user('odd id', { sessionId: 'not a label!' }, 51), fork)).toBe(
      Date.parse(at(51)),
    );
    const sessions = parser.finish().sessions;
    expect(
      sessions.map((s) => [s.id, s.events.filter((e) => e.kind === 'user_prompt').length]),
    ).toEqual([
      ['s1', 1],
      ['fork', 2],
    ]);
  });
});
