import { z } from 'zod';
import { PowChallengeSchema } from './pow.ts';

// What the CLI and the AgentGPA server say to each other, besides the payload and the deep read
// packet: the CLI routes under /api/cli/, their bodies and answers. Answers are parsed with
// these schemas, so a field the CLI does not know is dropped and a broken answer is refused.

const version = z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.]{1,32})?$/);
const token = z.string().regex(/^[A-Za-z0-9._~-]{16,1024}$/);

/** A link code from /start, as people type it: 8 characters in two groups. */
export const LINK_CODE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

/** `GET /api/cli/status?version=`: is this version current, and are uploads open? */
export const CliStatusSchema = z.object({
  current: version,
  minimum: version,
  rankable: z.boolean(),
  revoked: z.boolean(),
  uploads: z.enum(['open', 'paused']),
  /** A short service note, shown in the uploads-paused box. */
  message: z.string().max(200).optional(),
  /** Whether the server takes the CLI's opt-in usage counts; the CLI asks only then. */
  telemetry: z.boolean().optional(),
});
export type CliStatus = z.infer<typeof CliStatusSchema>;

/** `POST /api/cli/runs`: first without an answer, then with the solved challenge. */
export const RunRequestSchema = z.strictObject({
  installId: z.uuid(),
  cliVersion: version,
  code: z.string().regex(LINK_CODE).optional(),
  challenge: token.optional(),
  nonce: z.number().int().min(0).safe().optional(),
});
export type RunRequest = z.infer<typeof RunRequestSchema>;

export const RunChallengeSchema = z.object({ pow: PowChallengeSchema });
export const RunTokenSchema = z.object({
  runToken: token,
  expiresAt: z.iso.datetime(),
  /** The account a link code bound the run to. */
  account: z
    .object({
      name: z.string().max(60).optional(),
      handle: z
        .string()
        .regex(/^[A-Za-z0-9-]{1,39}$/)
        .optional(),
    })
    .optional(),
});
export type RunToken = z.infer<typeof RunTokenSchema>;
export const RunAnswerSchema = z.union([RunTokenSchema, RunChallengeSchema]);

/** `POST /api/cli/reports` answers 202 with where the report waits. */
export const ReportAcceptedSchema = z.object({
  claimUrl: z.url().optional(),
  reportUrl: z.url().optional(),
  /** Single use, only when the payload said yes to the deep read. */
  deepReadToken: token.optional(),
});
export type ReportAccepted = z.infer<typeof ReportAcceptedSchema>;

/** `GET /api/cli/deep-read/status`: whether the report is claimed and graded yet. */
export const DeepReadStatusSchema = z.object({ bound: z.boolean(), graded: z.boolean() });
export const DeepReadDoneSchema = z.object({ ok: z.literal(true) });

/**
 * `POST /api/cli/telemetry`: the opt-in usage counts of one run, sent once at its end. Only these
 * event names with a count each, the CLI version and a random id for the run that is never
 * stored on the machine; the schema is strict, so nothing else can ride along.
 */
export const TELEMETRY_EVENTS = ['cli_run', 'cli_preview_shown', 'cli_consent_given'] as const;
export type TelemetryEvent = (typeof TELEMETRY_EVENTS)[number];
export const TelemetrySchema = z.strictObject({
  run: z.uuid(),
  cliVersion: version,
  events: z
    .array(
      z.strictObject({
        name: z.enum(TELEMETRY_EVENTS),
        n: z.number().int().min(1).max(100),
      }),
    )
    .min(1)
    .max(TELEMETRY_EVENTS.length),
});
export type Telemetry = z.infer<typeof TelemetrySchema>;
export const TelemetryAcceptedSchema = z.object({ ok: z.literal(true) });

/** Report pages the CLI may open in a browser: the API origin and one of these paths. */
export const OPENABLE_PATH = /^\/(?:claim|r)\/[A-Za-z0-9_-]{4,64}$|^\/start$/;
