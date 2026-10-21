import { FORENSIC_RULES, type ForensicReason, type Session } from '@agentgpa/core';
import type { FileFact } from './scan.ts';

// The file checks that run before the skeleton is built: a session whose file was created long
// after its newest event was written after the fact, or copied from another machine. Such
// sessions stay out of the report, and the payload says how many were left out and why.

export interface Forensics {
  excludedSessions: number;
  reasons: Partial<Record<ForensicReason, number>>;
  /** `tool:id` of each session left out; it stays on this machine. */
  excluded: Set<string>;
}

export function checkFiles(facts: readonly FileFact[]): Forensics {
  const grace = FORENSIC_RULES.createdAfterLastEventMinutes * 60_000;
  const excluded = new Set<string>();
  for (const f of facts) {
    if (f.createdMs === undefined || f.newestMs === undefined) continue;
    if (f.createdMs - f.newestMs > grace) excluded.add(`${f.tool}:${f.sessionId}`);
  }
  const reasons: Forensics['reasons'] = {};
  if (excluded.size) reasons['created-after-last-event'] = excluded.size;
  return { excludedSessions: excluded.size, reasons, excluded };
}

export function withoutExcluded(sessions: readonly Session[], forensics: Forensics): Session[] {
  return sessions.filter((s) => !forensics.excluded.has(`${s.tool}:${s.id}`));
}
