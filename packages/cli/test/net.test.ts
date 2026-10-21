import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { leadingZeroBits } from '@agentgpa/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApi } from '../src/api.ts';
import { apiOrigin, createNet, NetError, withRetries } from '../src/net.ts';
import { answers, searchNonce, solveInline, solvePow } from '../src/pow.ts';

// A local server stands in for the AgentGPA API: plain HTTP is allowed only to this machine.

type Handler = (req: IncomingMessage, body: Buffer, res: ServerResponse) => void;
const routes = new Map<string, Handler>();
let server: Server;
let base = '';
const json = (
  res: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(value));
};

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const handler = routes.get(`${req.method} ${req.url?.split('?')[0]}`);
      if (handler) handler(req, Buffer.concat(chunks), res);
      else json(res, 404, { error: 'not found' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const net = () => createNet(apiOrigin({ AGENTGPA_API_URL: base }));
const Ok = z.object({ ok: z.literal(true) });

describe('the API origin', () => {
  it('is agentgpa.dev unless set, and only HTTPS or this machine', () => {
    expect(apiOrigin({})).toMatchObject({ isDefault: true, host: 'agentgpa.dev' });
    expect(apiOrigin({ AGENTGPA_API_URL: 'https://api.example.org' }).isDefault).toBe(false);
    expect(apiOrigin({ AGENTGPA_API_URL: 'http://localhost:3000' }).host).toBe('localhost:3000');
    for (const bad of [
      'http://example.org',
      'https://example.org/path',
      'https://me:pw@example.org',
      'ftp://example.org',
      'nonsense',
    ]) {
      expect(() => apiOrigin({ AGENTGPA_API_URL: bad }), bad).toThrow(NetError);
    }
  });
});

describe('net.ts', () => {
  it('reads an answer through its schema', async () => {
    routes.set('GET /api/ok', (_, __, res) => json(res, 200, { ok: true, extra: 'dropped' }));
    expect(await net().request({ method: 'GET', path: '/api/ok', schema: Ok })).toEqual({
      status: 200,
      data: { ok: true },
    });
  });

  it('refuses answers that break their schema, are not JSON or are too big', async () => {
    routes.set('GET /api/schema', (_, __, res) => json(res, 200, { ok: 'yes' }));
    routes.set('GET /api/text', (_, __, res) => res.end('not json'));
    routes.set('GET /api/big', (_, __, res) => json(res, 200, { pad: 'x'.repeat(300_000) }));
    const failure = (path: string) =>
      net()
        .request({ method: 'GET', path, schema: Ok })
        .then(
          () => 'none',
          (e: NetError) => e.failure,
        );
    expect(await failure('/api/schema')).toBe('bad-answer');
    expect(await failure('/api/text')).toBe('bad-answer');
    expect(await failure('/api/big')).toBe('too-large');
  });

  it('follows a redirect only to its own origin, and only a 307 or 308', async () => {
    routes.set('GET /api/in', (_, __, res) => res.writeHead(307, { location: '/api/ok' }).end());
    routes.set('GET /api/out', (_, __, res) =>
      res.writeHead(307, { location: 'https://evil.example/api/x' }).end(),
    );
    routes.set('GET /api/302', (_, __, res) => res.writeHead(302, { location: '/api/ok' }).end());
    expect((await net().request({ method: 'GET', path: '/api/in', schema: Ok })).data).toEqual({
      ok: true,
    });
    for (const path of ['/api/out', '/api/302']) {
      await expect(net().request({ method: 'GET', path, schema: Ok })).rejects.toMatchObject({
        failure: 'redirect',
      });
    }
  });

  it('times out, and says when the server cannot be reached', async () => {
    routes.set('GET /api/slow', () => {});
    await expect(
      net().request({ method: 'GET', path: '/api/slow', schema: Ok, timeoutMs: 100 }),
    ).rejects.toMatchObject({
      failure: 'timeout',
    });
    const closed = createNet(apiOrigin({ AGENTGPA_API_URL: 'http://127.0.0.1:9' }));
    await expect(
      closed.request({ method: 'GET', path: '/api/ok', schema: Ok }),
    ).rejects.toMatchObject({ failure: 'offline' });
  });

  it('gzips upload bodies and only calls paths under /api/', async () => {
    routes.set('POST /api/echo', (req, body, res) =>
      json(res, 200, {
        gzip: req.headers['content-encoding'] === 'gzip',
        size: JSON.parse(gunzipSync(body).toString()).n,
      }),
    );
    const Echo = z.object({ gzip: z.boolean(), size: z.number() });
    const answer = await net().request({
      method: 'POST',
      path: '/api/echo',
      schema: Echo,
      body: { n: 7 },
      gzip: true,
    });
    expect(answer.data).toEqual({ gzip: true, size: 7 });
    await expect(net().request({ method: 'GET', path: '/elsewhere', schema: Ok })).rejects.toThrow(
      NetError,
    );
  });
});

describe('retries', () => {
  it('try once and at most twice more, honoring Retry-After', async () => {
    const waits: number[] = [];
    let calls = 0;
    const answer = await withRetries(
      async () => {
        calls++;
        return calls < 3 ? { status: 503, retryAfterMs: 2000 } : { status: 202, data: 'done' };
      },
      { sleep: async (ms) => void waits.push(ms) },
    );
    expect(answer).toEqual({ status: 202, data: 'done' });
    expect(waits).toEqual([2000, 2000]);
  });

  it('back off with jitter when the server gives no time, and stop after the last retry', async () => {
    const waits: number[] = [];
    let calls = 0;
    const answer = await withRetries(
      async () => {
        calls++;
        return { status: 502 };
      },
      { sleep: async (ms) => void waits.push(ms), random: () => 0.5 },
    );
    expect(answer.status).toBe(502);
    expect(calls).toBe(3);
    expect(waits).toEqual([1000, 2000]);
  });

  it('never retry a refusal, and retry a failed connection', async () => {
    let calls = 0;
    const refused = async () => {
      calls++;
      return { status: 400 };
    };
    expect((await withRetries(refused, { sleep: async () => {} })).status).toBe(400);
    expect(calls).toBe(1);
    let tries = 0;
    await expect(
      withRetries(
        async () => {
          tries++;
          throw new NetError('offline');
        },
        { sleep: async () => {} },
      ),
    ).rejects.toThrow(NetError);
    expect(tries).toBe(3);
  });
});

describe('the API client', () => {
  it('buys a run token with a solved challenge, and uploads once even when retried', async () => {
    const prefix = 'testprefix0123456789';
    routes.set('POST /api/cli/runs', (_, body, res) => {
      const request = JSON.parse(body.toString());
      if (request.nonce === undefined) {
        json(res, 200, {
          pow: {
            algorithm: 'sha256',
            prefix,
            difficulty: 12,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            challenge: 'signed-challenge-0001',
          },
        });
        return;
      }
      const digest = createHash('sha256').update(`${prefix}:${request.nonce}`).digest();
      if (leadingZeroBits(digest) < 12 || request.challenge !== 'signed-challenge-0001')
        return json(res, 403, {});
      json(res, 200, {
        runToken: 'run-token-aaaaaaaaaaaaaaaa',
        expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
        account: { name: 'Mira', handle: 'mira-dev' },
      });
    });
    let uploads = 0;
    routes.set('POST /api/cli/reports', (req, body, res) => {
      uploads++;
      expect(req.headers['x-agentgpa-run-token']).toBe('run-token-aaaaaaaaaaaaaaaa');
      expect(JSON.parse(gunzipSync(body).toString())).toEqual({ schemaVersion: 1 });
      if (uploads === 1) return json(res, 503, {}, { 'retry-after': '0' });
      json(res, 202, { claimUrl: `${base}/claim/7KQ2M9XA4P` });
    });
    const api = createApi(net(), { sleep: async () => {} });
    const token = await api.runToken({
      installId: '7f0c0a3e-1d2b-4c5d-8e9f-0a1b2c3d4e5f',
      cliVersion: '0.1.0',
    });
    expect(token.account).toEqual({ name: 'Mira', handle: 'mira-dev' });
    const accepted = await api.upload({ schemaVersion: 1 } as never, token.runToken);
    expect(accepted.claimUrl).toBe(`${base}/claim/7KQ2M9XA4P`);
    expect(uploads).toBe(2);
  });

  it('reads the service status, and is quiet when offline', async () => {
    routes.set('GET /api/cli/status', (_, __, res) =>
      json(res, 200, {
        current: '0.1.0',
        minimum: '0.1.0',
        rankable: true,
        revoked: false,
        uploads: 'paused',
        message: 'Back soon.',
      }),
    );
    expect((await createApi(net()).status('0.1.0'))?.uploads).toBe('paused');
    const offline = createApi(createNet(apiOrigin({ AGENTGPA_API_URL: 'http://127.0.0.1:9' })));
    expect(await offline.status('0.1.0')).toBeUndefined();
  });
});

describe('proof of work', () => {
  const valid = (prefix: string, nonce: number, bits: number) =>
    leadingZeroBits(createHash('sha256').update(`${prefix}:${nonce}`).digest()) >= bits;

  it('finds a nonce inline and with workers', async () => {
    expect(valid('inline-prefix-0001', solveInline('inline-prefix-0001', 16), 16)).toBe(true);
    const challenge = {
      algorithm: 'sha256' as const,
      prefix: 'worker-prefix-0001',
      difficulty: 20,
      expiresAt: new Date().toISOString(),
      challenge: 'signed-challenge-0002',
    };
    expect(valid(challenge.prefix, await solvePow(challenge, 3), 20)).toBe(true);
  });

  it('agrees with node:crypto for every prefix length the server may send', () => {
    // A brute force over node:crypto finds the same first nonce, for prefixes of one, two and
    // three blocks and for the steps the workers use.
    for (const [prefix, bits, start, step] of [
      ['inline-prefix-0001', 12, 0, 1],
      ['p'.repeat(54), 10, 5, 3],
      ['q'.repeat(63), 10, 1, 4],
      ['r'.repeat(64), 9, 0, 7],
      ['s'.repeat(128), 10, 2, 8],
    ] as const) {
      let expected = start;
      while (!valid(prefix, expected, bits)) expected += step;
      expect(searchNonce(prefix, bits, start, step, Number.POSITIVE_INFINITY), prefix).toBe(
        expected,
      );
    }
    expect(searchNonce('inline-prefix-0001', 32, 0, 1, 1000)).toBe(-1);
    expect(answers('inline-prefix-0001', 16, solveInline('inline-prefix-0001', 16))).toBe(true);
  });
});
