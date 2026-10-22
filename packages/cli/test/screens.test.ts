import { describe, expect, it } from 'vitest';
import { renderAgentRun } from '../src/agent.ts';
import { fixLines, renderOffline, renderRunDone, UNREADABLE_FIX } from '../src/screens.ts';

// The fix a screen names when Cursor was found but could not be read. It is printed on
// this machine only and changes no payload.

const plain = { color: false, truecolor: false };
const tools = [
  { tool: 'claude-code' as const, found: true, readable: true },
  {
    tool: 'cursor' as const,
    found: true,
    readable: false,
    unreadable: 'sqlite unavailable' as const,
  },
];

describe('an unreadable Cursor', () => {
  it('names the fix for each reason, in one short line', () => {
    for (const fix of Object.values(UNREADABLE_FIX)) expect(fix.length).toBeLessThanOrEqual(76);
    expect(fixLines(tools)).toEqual([UNREADABLE_FIX['sqlite unavailable']]);
    expect(fixLines([{ tool: 'cursor', found: false, readable: true }])).toEqual([]);
  });

  it('shows the fix under the found line, offline and after a run, and to an agent', () => {
    const offline = renderOffline(
      { version: '0.1.2', tools, sessions: 3, days: 90, readSeconds: 1, quotes: 1 },
      plain,
    ).join('\n');
    expect(offline).toContain('Cursor not readable');
    expect(offline).toContain('Cursor: update Node to 22.13 or newer');
    const done = {
      version: '0.1.2',
      tools,
      sessions: 3,
      days: 90,
      readSeconds: 1,
      sentSeconds: 1,
      quotes: 1,
      consents: { researchAggregates: true, deepRead: false },
      deepRead: 'off' as const,
      page: new URL('https://agentgpa.dev/start'),
      opened: true,
    };
    expect(renderRunDone(done, plain).join('\n')).toContain('Cursor: update Node');
    expect(renderAgentRun(done)).toContain('Cursor: update Node');
  });
});
