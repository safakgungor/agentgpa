import { describe, expect, it } from 'vitest';
import {
  cleanText,
  commandKey,
  countLines,
  normalizeToolName,
  patchLines,
  safeLabel,
  shellFlags,
  TOOL_FLAGS,
} from '../src/index.ts';

describe('cleanText', () => {
  it('removes ANSI escapes, control, bidi and zero-width characters', () => {
    const [esc, bel, csi, rlo, zwsp] = [0x1b, 0x07, 0x9b, 0x202e, 0x200b].map((c) =>
      String.fromCodePoint(c),
    );
    const dirty = `a${esc}[31mred${esc}[0m b${rlo}evil${zwsp} c${bel}d${csi}2Je${esc}]0;title${bel}f`;
    expect(cleanText(dirty)).toBe('ared bevil cdef');
  });

  it('keeps tabs, newlines and ordinary Unicode', () => {
    expect(cleanText('tab\tnew\nline İstanbul ışık 🙂')).toBe('tab\tnew\nline İstanbul ışık 🙂');
  });
});

describe('safeLabel', () => {
  it('accepts model names and versions, rejects text, markup and prototype keys', () => {
    expect(safeLabel('claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(safeLabel('0.148.0-alpha.9')).toBe('0.148.0-alpha.9');
    expect(safeLabel('<synthetic>')).toBeUndefined();
    expect(safeLabel('two words')).toBeUndefined();
    expect(safeLabel('__proto__')).toBeUndefined();
    expect(safeLabel(42)).toBeUndefined();
  });
});

describe('shellFlags', () => {
  it.each([
    ['git commit -m "fix"', TOOL_FLAGS.gitCommit],
    ['git -C repo commit --amend', TOOL_FLAGS.gitCommit],
    ['cd app && git add . && git commit -m wip', TOOL_FLAGS.gitCommit],
    ['gh pr create --fill', TOOL_FLAGS.prCreate],
    ['pnpm test', TOOL_FLAGS.test],
    ['npm run test -- --watch=false', TOOL_FLAGS.test],
    ['npx vitest run', TOOL_FLAGS.test],
    ['pytest -q', TOOL_FLAGS.test],
    ['cargo build --release', TOOL_FLAGS.build],
    ['pnpm build', TOOL_FLAGS.build],
    ['vercel --prod', TOOL_FLAGS.deploy],
    ['npm publish', TOOL_FLAGS.deploy],
    ['pnpm build && pnpm test', TOOL_FLAGS.build | TOOL_FLAGS.test],
  ])('%s', (command, flags) => {
    expect(shellFlags(command)).toBe(flags);
  });

  it('ignores commands that only mention the words', () => {
    expect(shellFlags('echo "commit message"')).toBe(0);
    expect(shellFlags('git log --grep commit')).toBe(0);
    expect(shellFlags('cat latest-build.log')).toBe(0);
    expect(shellFlags('tsc --noEmit')).toBe(0);
  });
});

describe('line counts', () => {
  it('counts lines without counting a trailing newline', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('one')).toBe(1);
    expect(countLines('one\n')).toBe(1);
    expect(countLines('one\ntwo\n\nfour')).toBe(4);
  });

  it('counts added and removed lines in a patch', () => {
    const patch = '*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n+more\n*** End Patch';
    expect(patchLines(patch)).toEqual({ added: 2, removed: 1 });
    expect(patchLines('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b')).toEqual({ added: 1, removed: 1 });
  });
});

describe('tool names', () => {
  it('keeps built-in names and reduces MCP and unknown tools', () => {
    expect(normalizeToolName('claude-code', 'Bash')).toEqual({ name: 'Bash', category: 'Bash' });
    expect(normalizeToolName('claude-code', 'mcp__acme__search')).toEqual({
      name: 'MCP',
      category: 'MCP',
    });
    expect(normalizeToolName('codex', 'apply_patch')).toEqual({
      name: 'apply_patch',
      category: 'Edit',
    });
    expect(normalizeToolName('cursor', 'run_terminal_cmd').category).toBe('Bash');
    expect(normalizeToolName('cursor', 'my_private_tool')).toEqual({
      name: 'Other',
      category: 'Other',
    });
    expect(normalizeToolName('codex', '__proto__')).toEqual({ name: 'Other', category: 'Other' });
  });

  it('counts built-in slash commands by name and the rest as custom', () => {
    expect(commandKey('/compact')).toBe('compact');
    expect(commandKey('model')).toBe('model');
    expect(commandKey('/deploy-acme')).toBe('custom');
    expect(commandKey('/constructor')).toBe('custom');
  });
});
