import { type Archetype, pickArchetype } from './archetypes.ts';
import { academicYear, localClock, term } from './calendar.ts';
import { type Grades, grade } from './grading/grade.ts';
import { computeMetrics, type Metrics } from './metrics.ts';
import { type PreviewLine, pickPreviewLines } from './preview-lines.ts';
import type { QuoteCandidate } from './quotes.ts';
import type { RedactionContext } from './redaction.ts';
import type { SecretScanner } from './secrets.ts';
import { computeSignals, type Signals } from './signals.ts';
import { buildSkeleton, type DeviceFacts, type Skeleton } from './skeleton.ts';
import { type EarnedActivity, pickActivities } from './traits.ts';
import type { Session, Tool } from './types.ts';

// One report from parsed sessions: the skeleton, the metrics, grades, archetype, activities,
// signals and the preview lines. The server runs the same steps from a skeleton it received.

export interface Report {
  skeleton: Skeleton;
  device: DeviceFacts;
  metrics: Metrics;
  grades: Grades;
  archetype: Archetype;
  activities: EarnedActivity[];
  signals: Signals;
  previewLines: PreviewLine[];
  /** Quote candidates, redacted and masked; empty unless `quotes` was given. */
  quotes: QuoteCandidate[];
  /** The term and board year the period ends in. */
  term: string;
  academicYear: string;
}

export interface ReportOptions {
  end: number;
  days: number;
  observedDays: Partial<Record<Tool, number>>;
  timeZone: string;
  /** Picks the preview lines; the CLI passes its install id. */
  seed: string;
  scanner?: SecretScanner;
  /** Names the language of a sample of prompt words (the CLI passes franc-min); `und` without it. */
  detectLanguage?: (sample: string) => string;
  /** Picks quote candidates, redacted with these local names. */
  quotes?: RedactionContext;
  /** Sessions with a prompt holding this text are left out (the link code in agent mode). */
  skipSessionsWith?: string;
  /** Hashes provider message ids for the fingerprint sample (SHA-256 hex in the CLI). */
  fingerprint?: (id: string) => string;
}

export function buildReport(sessions: Session[], options: ReportOptions): Report {
  const { skeleton, device, quotes } = buildSkeleton(sessions, options);
  const metrics = computeMetrics(skeleton, options.timeZone);
  const grades = grade(metrics, device.secrets);
  const signals = computeSignals(skeleton, metrics, options.timeZone);
  const local = localClock(options.timeZone)(options.end);
  return {
    skeleton,
    device,
    metrics,
    grades,
    archetype: pickArchetype(metrics, grades),
    activities: pickActivities(metrics, device.secrets),
    signals,
    previewLines: pickPreviewLines({ metrics, signals, device }, options.seed),
    quotes,
    term: term(local).label,
    academicYear: academicYear(local),
  };
}
