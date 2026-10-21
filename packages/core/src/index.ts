/**
 * @agentgpa/core: the pure logic shared by the CLI and the AgentGPA server.
 * No fs, no network and no Node-only APIs: test/purity.test.ts enforces it,
 * and this package typechecks without Node's types.
 */

export {
  type CliStatus,
  CliStatusSchema,
  DeepReadDoneSchema,
  DeepReadStatusSchema,
  LINK_CODE,
  OPENABLE_PATH,
  type ReportAccepted,
  ReportAcceptedSchema,
  RunAnswerSchema,
  RunChallengeSchema,
  type RunRequest,
  RunRequestSchema,
  type RunToken,
  RunTokenSchema,
  TELEMETRY_EVENTS,
  type Telemetry,
  TelemetryAcceptedSchema,
  type TelemetryEvent,
  TelemetrySchema,
} from './api.ts';
export {
  ARCHETYPE_RULES,
  ARCHETYPES,
  type Archetype,
  type ArchetypeId,
  pickArchetype,
} from './archetypes.ts';
export { academicYear, daysBetween, type LocalTime, localClock, term } from './calendar.ts';
export { cleanText, LABEL, safeLabel } from './clean.ts';
export {
  isSensitiveFile,
  LANG_CATEGORIES,
  type LangCategory,
  langCategoryOf,
  touchesSensitiveFile,
} from './files.ts';
export * from './grading/config.ts';
export {
  type CourseGrade,
  courseInputs,
  type Grades,
  grade,
  letterFor,
  planning,
  score,
} from './grading/grade.ts';
export { compile, fold, LAUGH, LEXICONS, VAGUE_WORDS } from './lexicons.ts';
export { countLines, patchLines } from './lines.ts';
export {
  activityBlocks,
  computeMetrics,
  type Metrics,
  secretsPer30,
  type ToolStats,
} from './metrics.ts';
export {
  buildPacket,
  PACKET_SCHEMA_VERSION,
  type Packet,
  type PacketOptions,
  type PacketPrompt,
  PacketSchema,
  type PacketSession,
} from './packet.ts';
export {
  type ClaudeFile,
  type ClaudeFileKind,
  createClaudeCodeParser,
} from './parsers/claudeCode.ts';
export { createCodexParser } from './parsers/codex.ts';
export { createCursorParser, isCursorId } from './parsers/cursor.ts';
export {
  buildPayload,
  FORENSIC_REASONS,
  type ForensicReason,
  METRIC_SCALARS,
  PAYLOAD_SCHEMA_VERSION,
  type Payload,
  type PayloadInput,
  PayloadSchema,
  QUOTE_KINDS,
} from './payload.ts';
export { leadingZeroBits, type PowChallenge, PowChallengeSchema, powInput } from './pow.ts';
export { PREVIEW_LINES, type PreviewLine, pickPreviewLines, type Tone } from './preview-lines.ts';
export { costOf, PRICES_AS_OF, priceOf } from './pricing.ts';
export {
  agentSafe,
  type PromptText,
  pickQuotes,
  type QuoteCandidate,
  type QuoteInput,
  type QuoteKind,
} from './quotes.ts';
export {
  drawMasks,
  maskSwears,
  type Redacted,
  type RedactionContext,
  redact,
  shownLength,
} from './redaction.ts';
export { buildReport, type Report, type ReportOptions } from './report.ts';
export {
  findSecrets,
  SECRET_TYPES,
  type SecretCounts,
  SecretScanner,
  type SecretType,
} from './secrets.ts';
export { shellFlags, testOutcome } from './shell.ts';
export { computeSignals, type Signals } from './signals.ts';
export {
  type Autonomy,
  buildSkeleton,
  CALL_FLAGS,
  CATEGORIES,
  type DeviceFacts,
  type Entrypoint,
  type InterruptRow,
  observedWindowStart,
  PROMPT_FLAGS,
  type PromptRow,
  REPLY_FLAGS,
  type ReplyRow,
  SKELETON_VERSION,
  type Skeleton,
  type SkeletonOptions,
  type SkeletonSession,
  type ToolRow,
} from './skeleton.ts';
export { maxOf, median, percentile, share } from './stats.ts';
export {
  endsWithExclaim,
  endsWithQuestion,
  hasCodeBlock,
  hasCodeReference,
  hasEmoji,
  hasUrl,
  isCapsCrisis,
  type LanguageSample,
  languageSample,
  looksPastedError,
  normalizePrompt,
  proseOf,
  referencesPlanFile,
  wordCount,
} from './text.ts';
export {
  FINGERPRINT_RULES,
  FORENSIC_RULES,
  METRIC_RULES,
  PACKET_RULES,
  QUOTE_RULES,
  REDACTION_RULES,
  SIGNAL_RULES,
} from './thresholds.ts';
export { CLAUDE_CODE_COMMANDS, commandKey, normalizeToolName } from './tools.ts';
export { ACTIVITIES, type EarnedActivity, MAX_ACTIVITIES, pickActivities } from './traits.ts';
export * from './types.ts';
export {
  decodeSkeleton,
  encodeSkeleton,
  ToolSchema,
  WIRE_LIMITS,
  type WireSkeleton,
  type WireSkeletonData,
  WireSkeletonSchema,
} from './wire.ts';
