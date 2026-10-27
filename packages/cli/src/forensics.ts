import { FORENSIC_RULES, type ForensicReason, type Session } from '@agentgpa/core';
import type { FileFact } from './scan.ts';

// The file checks that run before the skeleton is built: a session whose file was created long
// after the session's newest line in it was written after the fact, or copied from another
// machine. Such sessions stay out of the report. Each file is judged by its own session's lines
// only: a fork copies its parent's lines and subagent files into the new session's folder with
// their old times, and those copies say nothing about either session (docs/formats.md). The
// payload counts the sessions left out that the report would have held, and why.

export interface FileChecks {
  /** `tool:id` of each session one of its files failed for; it stays on this machine. */
  failed: Set<string>;
  /** The files that failed, by tool and kind, for --debug. */
  files: Record<string, number>;
}

export function checkFiles(facts: readonly FileFact[]): FileChecks {
  const grace = FORENSIC_RULES.createdAfterLastEventMinutes * 60_000;
  const failed = new Set<string>();
  const files: Record<string, number> = {};
  for (const f of facts) {
    if (f.createdMs === undefined || f.newestMs === undefined) continue;
    if (f.createdMs - f.newestMs <= grace) continue;
    failed.add(`${f.tool}:${f.sessionId}`);
    const kind = `${f.tool} ${f.kind}`;
    files[kind] = (files[kind] ?? 0) + 1;
  }
  return { failed, files };
}

export interface Forensics {
  /** Sessions left out that the report would have held: what the payload counts. */
  excludedSessions: number;
  reasons: Partial<Record<ForensicReason, number>>;
  /** Sessions left out with no event in the period, which the report would not hold anyway. */
  outsidePeriod: number;
  /** The files that failed, by tool and kind. */
  files: Record<string, number>;
}

/**
 * The sessions the checks keep, and what they left out. `inPeriod` says whether the report would
 * hold a session: an event in its tool's window, as the skeleton takes them.
 */
export function leaveOut(
  sessions: readonly Session[],
  checks: FileChecks,
  inPeriod: (session: Session) => boolean,
): { kept: Session[]; forensics: Forensics } {
  const kept: Session[] = [];
  let excluded = 0;
  let outside = 0;
  for (const s of sessions) {
    if (!checks.failed.has(`${s.tool}:${s.id}`)) kept.push(s);
    else if (inPeriod(s)) excluded++;
    else outside++;
  }
  const reasons: Forensics['reasons'] = {};
  if (excluded) reasons['created-after-last-event'] = excluded;
  return {
    kept,
    forensics: { excludedSessions: excluded, reasons, outsidePeriod: outside, files: checks.files },
  };
}
