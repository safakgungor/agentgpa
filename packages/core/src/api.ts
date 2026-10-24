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

/** What the owner said yes to on /start before the run; the link code carries it. */
export const RunConsentsSchema = z.strictObject({
  researchAggregates: z.boolean(),
  deepRead: z.boolean(),
});
export type RunConsents = z.infer<typeof RunConsentsSchema>;

export const RunChallengeSchema = z.object({ pow: PowChallengeSchema });
export const RunTokenSchema = z.object({
  runToken: token,
  expiresAt: z.iso.datetime(),
  /** The account the link code bound the run to. */
  account: z
    .object({
      name: z.string().max(60).optional(),
      handle: z
        .string()
        .regex(/^[A-Za-z0-9-]{1,39}$/)
        .optional(),
    })
    .optional(),
  /** The choices from /start: the payload carries them, and the deep read follows them. */
  consents: RunConsentsSchema,
});
export type RunToken = z.infer<typeof RunTokenSchema>;
export const RunAnswerSchema = z.union([RunTokenSchema, RunChallengeSchema]);

/**
 * How `POST /api/cli/runs` refuses a link code, by status, so the CLI can say what to do: a run
 * needs a code from /start, and each code works once within its hour.
 */
export const RUN_REFUSAL_STATUS = {
  codeRequired: 400,
  codeUnknown: 404,
  codeUsed: 409,
  codeExpired: 410,
} as const;

/** `POST /api/cli/reports` answers 202 with where the report waits. */
export const ReportAcceptedSchema = z.object({
  /** Where the owner confirms the run and sees the report. */
  reportUrl: z.url(),
  /** Single use, only when the owner said yes to the deep read on /start. */
  deepReadToken: token.optional(),
  /**
   * The /start page the owner made the code on asked for it moments ago: the report comes back
   * to that page, so no second tab opens. Older servers leave it out, and older CLIs drop it.
   */
  watched: z.boolean().optional(),
});
export type ReportAccepted = z.infer<typeof ReportAcceptedSchema>;

export const DeepReadDoneSchema = z.object({ ok: z.literal(true) });

/** Report pages the CLI may open in a browser: the API origin and one of these paths. */
export const OPENABLE_PATH = /^\/r\/[A-Za-z0-9_-]{4,64}$|^\/start$/;
