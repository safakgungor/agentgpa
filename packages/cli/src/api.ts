import {
  type CliStatus,
  CliStatusSchema,
  DeepReadDoneSchema,
  type Packet,
  type Payload,
  type ReportAccepted,
  ReportAcceptedSchema,
  RunAnswerSchema,
  type RunRequest,
  RunRequestSchema,
  type RunToken,
} from '@agentgpa/core';
import { type Answer, type Net, NetError, type RetryOptions, withRetries } from './net.ts';
import { solvePow } from './pow.ts';

// The CLI routes of the AgentGPA server. Every call goes through net.ts; nothing here keeps or
// logs what it sends or what comes back.

/** The server answered, but not with a yes. */
export class ApiError extends Error {
  readonly status: number;
  /** From `Retry-After`: the server asked for another try after this long. */
  readonly retryAfterMs: number | undefined;
  constructor(status: number, retryAfterMs?: number) {
    super(`server answered ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function ok<T>(answer: Answer<T>): T {
  if (answer.data === undefined || answer.status < 200 || answer.status >= 300)
    throw new ApiError(answer.status, answer.retryAfterMs);
  return answer.data;
}

export interface Api {
  net: Net;
  /** Whether this version may upload, and whether uploads are open; undefined when offline. */
  status(version: string): Promise<CliStatus | undefined>;
  /** A run token, bought with a solved proof-of-work challenge. */
  runToken(request: Omit<RunRequest, 'challenge' | 'nonce'>): Promise<RunToken>;
  upload(payload: Payload, runToken: string): Promise<ReportAccepted>;
  /** `retries` overrides the client's own retries, for a run that keeps its own clock. */
  sendDeepRead(token: string, packet: Packet, retries?: number): Promise<void>;
}

export function createApi(net: Net, retry: RetryOptions = {}, workers?: number): Api {
  return {
    net,
    async status(version) {
      try {
        const answer = await net.request({
          method: 'GET',
          path: `/api/cli/status?version=${encodeURIComponent(version)}`,
          schema: CliStatusSchema,
          timeoutMs: 5000,
        });
        return answer.data;
      } catch (error) {
        if (error instanceof NetError) return undefined;
        throw error;
      }
    },

    async runToken(request) {
      const ask = (body: RunRequest) =>
        withRetries(
          () =>
            net.request({
              method: 'POST',
              path: '/api/cli/runs',
              schema: RunAnswerSchema,
              body: RunRequestSchema.parse(body),
            }),
          retry,
        );
      let answer = ok(await ask(request));
      if ('pow' in answer) {
        const nonce = await solvePow(answer.pow, workers);
        answer = ok(await ask({ ...request, challenge: answer.pow.challenge, nonce }));
      }
      if (!('runToken' in answer)) throw new ApiError(409);
      return answer;
    },

    async upload(payload, runToken) {
      // The run token makes a retried upload return the first answer, never a second report.
      const answer = await withRetries(
        () =>
          net.request({
            method: 'POST',
            path: '/api/cli/reports',
            schema: ReportAcceptedSchema,
            body: payload,
            gzip: true,
            headers: { 'x-agentgpa-run-token': runToken },
            timeoutMs: 30_000,
          }),
        retry,
      );
      return ok(answer);
    },

    async sendDeepRead(token, packet, retries) {
      const answer = await withRetries(
        () =>
          net.request({
            method: 'POST',
            path: '/api/cli/deep-read',
            schema: DeepReadDoneSchema,
            body: packet,
            gzip: true,
            headers: { 'x-agentgpa-deep-read-token': token },
            timeoutMs: 60_000,
          }),
        retries === undefined ? retry : { ...retry, retries },
      );
      ok(answer);
    },
  };
}
