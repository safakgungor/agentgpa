import { gzipSync } from 'node:zlib';
import type { z } from 'zod';
import pkg from '../package.json' with { type: 'json' };

// The only module that talks to the network. HTTPS to one API origin (plain HTTP only to this
// machine, for development), certificate checks on, no redirect to another origin, timeouts,
// a cap on every answer and a schema for every answer. It never logs a body.

export const DEFAULT_API = 'https://agentgpa.dev';
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

export type NetFailure =
  | 'bad-origin'
  | 'insecure-origin'
  | 'offline'
  | 'timeout'
  | 'redirect'
  | 'too-large'
  | 'bad-answer';

/** A network failure, by kind; its message never holds a body. */
export class NetError extends Error {
  readonly failure: NetFailure;
  constructor(failure: NetFailure) {
    super(failure);
    this.name = 'NetError';
    this.failure = failure;
  }
}

export interface Origin {
  url: URL;
  /** The official server. Any other origin makes the run report only and the deep read off. */
  isDefault: boolean;
  /** This machine, while developing (http://localhost and its kin). */
  isLocal: boolean;
  host: string;
}

/** The API origin from `AGENTGPA_API_URL`, or the official one (tests stand in their own). */
export function apiOrigin(env: Record<string, string | undefined>, official = DEFAULT_API): Origin {
  let url: URL;
  try {
    url = new URL(env.AGENTGPA_API_URL || official);
  } catch {
    throw new NetError('bad-origin');
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new NetError('bad-origin');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL.has(url.hostname))) {
    throw new NetError('insecure-origin');
  }
  const origin = new URL(url.origin);
  return {
    url: origin,
    isDefault: origin.origin === new URL(official).origin,
    isLocal: LOCAL.has(origin.hostname),
    host: origin.host,
  };
}

export interface Answer<T> {
  status: number;
  data?: T;
  /** From `Retry-After`, in milliseconds. */
  retryAfterMs?: number;
}

export interface RequestOptions<T> {
  method: 'GET' | 'POST';
  /** A path under /api/. */
  path: string;
  schema: z.ZodType<T>;
  body?: unknown;
  /** Gzips the body (uploads). */
  gzip?: boolean;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface Net {
  origin: Origin;
  request<T>(o: RequestOptions<T>): Promise<Answer<T>>;
}

function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new NetError('too-large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createNet(origin: Origin, fetchImpl: typeof fetch = fetch): Net {
  return {
    origin,
    async request<T>(o: RequestOptions<T>): Promise<Answer<T>> {
      if (!o.path.startsWith('/api/')) throw new NetError('bad-origin');
      let url = new URL(o.path, origin.url);
      const headers: Record<string, string> = {
        accept: 'application/json',
        'user-agent': `agentgpa/${pkg.version}`,
        ...o.headers,
      };
      let body: Uint8Array | string | undefined;
      if (o.body !== undefined) {
        const json = JSON.stringify(o.body);
        headers['content-type'] = 'application/json';
        if (o.gzip) {
          headers['content-encoding'] = 'gzip';
          body = gzipSync(json);
        } else body = json;
      }
      for (let hop = 0; hop < 3; hop++) {
        if (url.origin !== origin.url.origin) throw new NetError('redirect');
        let response: Response;
        try {
          response = await fetchImpl(url, {
            method: o.method,
            headers,
            ...(body === undefined ? {} : { body }),
            redirect: 'manual',
            signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
          });
        } catch (error) {
          const name = (error as Error).name;
          throw new NetError(
            name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'offline',
          );
        }
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          await response.body?.cancel();
          // Only a same-origin 307 or 308 is followed; everything else is refused.
          if (!location || (response.status !== 307 && response.status !== 308))
            throw new NetError('redirect');
          url = new URL(location, url);
          continue;
        }
        const text = await readCapped(response, o.maxBytes ?? 256 * 1024);
        const answer: Answer<T> = { status: response.status };
        const wait = retryAfter(response.headers.get('retry-after'));
        if (wait !== undefined) answer.retryAfterMs = wait;
        if (response.status >= 200 && response.status < 300) {
          let parsed: unknown;
          try {
            parsed = text ? JSON.parse(text) : undefined;
          } catch {
            throw new NetError('bad-answer');
          }
          const checked = o.schema.safeParse(parsed);
          if (!checked.success) throw new NetError('bad-answer');
          answer.data = checked.data;
        }
        return answer;
      }
      throw new NetError('redirect');
    },
  };
}

export interface RetryOptions {
  /** Retries after the first try. */
  retries?: number;
  baseMs?: number;
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One try and at most two retries, with backoff and jitter, honoring `Retry-After`. Nothing is
 * written anywhere while it waits.
 */
export async function withRetries<T>(
  attempt: () => Promise<Answer<T>>,
  o: RetryOptions = {},
): Promise<Answer<T>> {
  const retries = o.retries ?? 2;
  const sleep = o.sleep ?? pause;
  const random = o.random ?? Math.random;
  for (let i = 0; ; i++) {
    let wait: number | undefined;
    try {
      const answer = await attempt();
      if (!RETRYABLE.has(answer.status) || i >= retries) return answer;
      wait = answer.retryAfterMs;
    } catch (error) {
      const failure = error instanceof NetError ? error.failure : undefined;
      if ((failure !== 'offline' && failure !== 'timeout') || i >= retries) throw error;
    }
    const backoff = (o.baseMs ?? 1000) * 2 ** i * (0.5 + random());
    await sleep(Math.min(o.maxWaitMs ?? 30_000, wait ?? backoff));
  }
}
