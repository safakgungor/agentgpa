import type { Session } from '@agentgpa/core';
import { describe, expect, it } from 'vitest';
import { checkFiles, withoutExcluded } from '../src/forensics.ts';

const hour = 3_600_000;
const t = Date.UTC(2027, 0, 4, 9);

describe('the file checks', () => {
  it('leave out a session whose file was created long after its newest event', () => {
    const f = checkFiles([
      { tool: 'claude-code', sessionId: 'kept', createdMs: t - hour, newestMs: t },
      { tool: 'claude-code', sessionId: 'resumed', createdMs: t + 30 * 60_000, newestMs: t },
      { tool: 'codex', sessionId: 'copied', createdMs: t + 3 * 24 * hour, newestMs: t },
      { tool: 'claude-code', sessionId: 'no-birth-time', newestMs: t },
      { tool: 'claude-code', sessionId: 'no-events', createdMs: t },
    ]);
    expect([...f.excluded]).toEqual(['codex:copied']);
    expect(f).toMatchObject({ excludedSessions: 1, reasons: { 'created-after-last-event': 1 } });
    const sessions = [
      { tool: 'codex', id: 'copied' },
      { tool: 'claude-code', id: 'kept' },
    ] as Session[];
    expect(withoutExcluded(sessions, f).map((s) => s.id)).toEqual(['kept']);
  });

  it('send no reason when nothing was left out', () => {
    expect(checkFiles([])).toMatchObject({ excludedSessions: 0, reasons: {} });
  });
});
