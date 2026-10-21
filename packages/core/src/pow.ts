import { z } from 'zod';

// Proof of work: before it issues a run token, the server asks for a SHA-256 hash of
// `<prefix>:<nonce>` with some leading zero bits. It is a speed bump for scripts, not a wall.
// The CLI solves it with Node's built-in hash; this module holds the shared format.

export const PowChallengeSchema = z.strictObject({
  algorithm: z.literal('sha256'),
  /** Random, from the server, bound to the challenge it signed. */
  prefix: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  /** Leading zero bits the hash needs. */
  difficulty: z.number().int().min(1).max(32),
  expiresAt: z.iso.datetime(),
  /** The server's signed challenge, sent back with the answer. */
  challenge: z.string().regex(/^[A-Za-z0-9._~-]{16,1024}$/),
});

export type PowChallenge = z.infer<typeof PowChallengeSchema>;

/** The text that is hashed for a nonce. */
export const powInput = (prefix: string, nonce: number): string => `${prefix}:${nonce}`;

/** How many zero bits a digest starts with. */
export function leadingZeroBits(digest: Uint8Array): number {
  let bits = 0;
  for (const byte of digest) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}
