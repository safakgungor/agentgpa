import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { type Payload, PayloadSchema } from '@agentgpa/core';
import { z } from 'zod';

// The pending payload of the agent flow: what `--agent` showed, waiting for `upload` in
// ~/.agentgpa/pending/ (folder 0700, file 0600). It holds the same content a dry run writes and
// the run token, and is deleted after the upload, after 30 minutes and when the next scan starts.
// The deep read packet is never written: `upload --deep-read` builds it again in memory.

export const PENDING_MINUTES = 30;

const PendingSchema = z.strictObject({
  createdAt: z.number().int(),
  code: z.string().optional(),
  payload: PayloadSchema,
  /** How to read the same period again, for the deep read. */
  scan: z.strictObject({
    root: z.string().optional(),
    tools: z.array(z.enum(['claude-code', 'codex', 'cursor'])),
    days: z.number().int(),
    end: z.number().int(),
  }),
});
export type Pending = z.infer<typeof PendingSchema>;

const dirOf = (configDir: string) => join(configDir, 'pending');
const fileOf = (configDir: string, code: string | undefined) =>
  join(dirOf(configDir), `${code ? code.replace(/[^A-Z0-9-]/g, '') : 'run'}.json`);

/** Deletes every pending payload; every scan starts with this. */
export function clearPending(configDir: string): void {
  const dir = dirOf(configDir);
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir))
    if (name.endsWith('.json')) rmSync(join(dir, name), { force: true });
}

export function writePending(configDir: string, pending: Pending): string {
  const dir = dirOf(configDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = fileOf(configDir, pending.code);
  writeFileSync(path, JSON.stringify(PendingSchema.parse(pending)), { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/** The pending payload for a code, unless it is missing, broken or older than 30 minutes. */
export function readPending(
  configDir: string,
  code: string | undefined,
  now: number,
): Pending | undefined {
  const path = fileOf(configDir, code);
  if (!existsSync(path)) return undefined;
  try {
    const pending = PendingSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    if (now - pending.createdAt <= PENDING_MINUTES * 60_000 && pending.code === code)
      return pending;
  } catch {
    // A broken file is removed below.
  }
  rmSync(path, { force: true });
  return undefined;
}

export function removePending(configDir: string, code: string | undefined): void {
  rmSync(fileOf(configDir, code), { force: true });
}

export type { Payload };
