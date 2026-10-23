import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  COURSE_NAMES,
  leadingZeroBits,
  type Packet,
  PacketSchema,
  PayloadSchema,
} from '@agentgpa/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseClaude, parseCodex, parseCursor } from '../../core/test/fixtures.ts';
import { type Io, runScan } from '../src/run.ts';
import { fixtureHome } from './home.ts';

// The whole CLI against a stand-in AgentGPA server on this machine. The fixture home's sessions
// end in October 2027, so the scans run on 2027-10-20. The owner says yes on /start; the code
// carries that yes, and the CLI sends at once and shows no result.

const NOW = Date.UTC(2027, 9, 20);
const PREFIX = 'flow-prefix-0123456789';
const CODE = 'K7Q3-PX9M';
type Seen = {
  status: number;
  runs: number;
  reports: unknown[];
  packets: unknown[];
  deepReadTries: number;
  /** Requests to any other route: there must be none. */
  other: string[];
};
let seen: Seen;
let server: Server;
let base = '';
let mode: {
  uploads: 'open' | 'paused';
  consents: { researchAggregates: boolean; deepRead: boolean };
  refuse?: number;
  /** The reports route answers this instead of taking the report. */
  reportStatus?: number;
  /**
   * Busy answers 429 with a Retry-After once, swamped always does; limit always answers 429
   * without one.
   */
  deepRead?: 'busy' | 'swamped' | 'limit';
};
/** Codes that already started a run: each works once. */
let used: Set<string>;

const send = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
};
const body = (req: IncomingMessage, raw: Buffer) =>
  JSON.parse(
    (req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw).toString() || '{}',
  );

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const path = req.url?.split('?')[0];
      if (req.method === 'GET' && path === '/api/cli/status') {
        seen.status++;
        return send(res, 200, {
          current: '0.0.0',
          minimum: '0.0.0',
          rankable: true,
          revoked: false,
          uploads: mode.uploads,
          message: 'Back in a few minutes.',
        });
      }
      if (req.method === 'POST' && path === '/api/cli/runs') {
        seen.runs++;
        const r = body(req, raw);
        if (r.nonce === undefined) {
          return send(res, 200, {
            pow: {
              algorithm: 'sha256',
              prefix: PREFIX,
              difficulty: 8,
              expiresAt: new Date(NOW + 60_000).toISOString(),
              challenge: 'signed-challenge-flow',
            },
          });
        }
        if (leadingZeroBits(createHash('sha256').update(`${PREFIX}:${r.nonce}`).digest()) < 8)
          return send(res, 403, {});
        if (!r.code) return send(res, 400, {});
        if (mode.refuse) return send(res, mode.refuse, {});
        if (used.has(r.code)) return send(res, 409, {});
        used.add(r.code);
        return send(res, 200, {
          runToken: 'run-token-flow-aaaaaaaaaa',
          expiresAt: new Date(NOW + 1_800_000).toISOString(),
          account: { name: 'Mira', handle: 'mira-dev' },
          consents: mode.consents,
        });
      }
      if (req.method === 'POST' && path === '/api/cli/reports') {
        if (mode.reportStatus) return send(res, mode.reportStatus, {});
        const payload = PayloadSchema.parse(body(req, raw));
        seen.reports.push(payload);
        return send(res, 202, {
          reportUrl: `${base}/start`,
          ...(payload.consents.deepRead ? { deepReadToken: 'deep-read-token-aaaaaaaaaa' } : {}),
        });
      }
      if (req.method === 'POST' && path === '/api/cli/deep-read') {
        seen.deepReadTries++;
        if (mode.deepRead === 'limit') return send(res, 429, {});
        if (mode.deepRead === 'busy' || mode.deepRead === 'swamped') {
          if (mode.deepRead === 'busy') delete mode.deepRead;
          res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '20' });
          return res.end('{}');
        }
        seen.packets.push(PacketSchema.parse(body(req, raw)));
        return send(res, 200, { ok: true });
      }
      seen.other.push(`${req.method} ${path}`);
      send(res, 404, {});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  seen = { status: 0, runs: 0, reports: [], packets: [], deepReadTries: 0, other: [] };
  mode = { uploads: 'open', consents: { researchAggregates: true, deepRead: false } };
  used = new Set();
});
// The CLI calls the status, runs, reports and deep read routes and nothing else.
afterEach(() => expect(seen.other).toEqual([]));

function io(extra: Partial<Io> = {}) {
  const out: string[] = [];
  const opened: string[] = [];
  /** The progress lines, in order, and how many deep read tries had happened at each opening. */
  const progress: string[] = [];
  const openedAfterTries: number[] = [];
  let clock = NOW;
  const config = mkdtempSync(join(tmpdir(), 'agentgpa-flow-'));
  const value: Io = {
    // An empty home: no test may ever read the real one, even when --root is missing.
    home: mkdtempSync(join(tmpdir(), 'agentgpa-home-')),
    out: (t) => out.push(t),
    err: (t) => out.push(t),
    now: NOW,
    env: { AGENTGPA_CONFIG_DIR: config },
    officialApi: base,
    open: (url) => {
      opened.push(url.href);
      openedAfterTries.push(seen.deepReadTries);
      return true;
    },
    progress: (text) => {
      if (text !== null) progress.push(text);
    },
    clock: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    timeZone: 'UTC',
    ...extra,
  };
  return { io: value, out, opened, config, progress, openedAfterTries };
}

/** No grade, archetype, line or quote of the fixture's report reaches the text. */
function expectNoResults(text: string, payload: unknown) {
  expect(text).not.toMatch(/\bGPA\b/);
  for (const name of Object.values(COURSE_NAMES)) expect(text).not.toContain(name);
  for (const q of PayloadSchema.parse(payload).quotes) expect(text).not.toContain(q.text);
  const sessions = [parseClaude(), parseCodex(), parseCursor()].flatMap((r) => r.sessions);
  const texts = sessions
    .flatMap((s) => s.events)
    .flatMap((e) =>
      e.kind === 'user_prompt' || e.kind === 'assistant_text'
        ? [e.text.replace(/\s+/g, ' ').trim()]
        : [],
    )
    .filter((x) => x.length >= 12);
  expect(texts.filter((x) => text.includes(x.slice(0, 12)))).toEqual([]);
}

describe('a run with a code from /start', () => {
  it('reads, sends what the code allows and opens /start, with no result on screen', async () => {
    const root = await fixtureHome();
    const t = io();
    expect(await runScan({ root, code: CODE }, t.io)).toBe(0);
    const text = t.out.join('\n');
    expect(text).toContain('LINKED TO @mira-dev');
    expect(text).toContain('Sent what you said yes to on 127.0.0.1');
    expect(text).toContain('YOUR REPORT IS READY');
    expect(text).toContain('research on · deep read off');
    expect(t.opened).toEqual([`${base}/start`]);
    expect(seen.reports).toHaveLength(1);
    const payload = PayloadSchema.parse(seen.reports[0]);
    expect(payload.runToken).toBe('run-token-flow-aaaaaaaaaa');
    expect(payload.consents).toEqual({ researchAggregates: true, deepRead: false });
    expect(payload.client.runMode).toBe('terminal');
    expect(seen.packets).toHaveLength(0);
    expectNoResults(text, payload);
    // What it does as it goes, neutral words only.
    expect(t.progress).toEqual([
      `Checking ${new URL(base).host}`,
      'Reading Claude Code',
      'Reading Codex',
      'Reading Cursor',
      'Sending',
    ]);
    expect(text.endsWith('Nothing else left this machine.')).toBe(true);
  });

  it('sends the deep read in the same run when the owner chose it on /start', async () => {
    mode.consents = { researchAggregates: false, deepRead: true };
    const root = await fixtureHome();
    const t = io();
    expect(await runScan({ root, code: CODE }, t.io)).toBe(0);
    const sent = PayloadSchema.parse(seen.reports[0]);
    expect(sent.consents).toEqual({ researchAggregates: false, deepRead: true });
    // Every tool counts the whole period, Claude Code too, whatever cleanupPeriodDays says.
    expect(sent.observedDays).toEqual({ 'claude-code': 90, codex: 90, cursor: 90 });
    expect(seen.packets).toHaveLength(1);
    // The fixtures' synthetic project folders, by their own names only, never a path.
    const packet = seen.packets[0] as Packet;
    expect(packet.projects.length).toBeGreaterThan(0);
    for (const name of packet.projects) expect(name).not.toMatch(/[/\\]/);
    const text = t.out.join('\n');
    expect(text).toContain('research off · deep read on, sent next, read once and dropped');
    // The report's address and the browser come first; the deep read follows.
    expect(t.openedAfterTries).toEqual([0]);
    expect(text.indexOf('YOUR REPORT IS READY')).toBeLessThan(
      text.indexOf('Deep read sent, read once and dropped'),
    );
    expect(text.endsWith('Nothing else left this machine.')).toBe(true);
    expect(t.progress.slice(-2)).toEqual(['Sending', 'Sending the deep read']);
  });

  it('waits while the deep read is busy, and stops at once at its daily limit', async () => {
    mode.consents = { researchAggregates: true, deepRead: true };
    const root = await fixtureHome();
    mode.deepRead = 'busy';
    const busy = io();
    expect(await runScan({ root, code: CODE }, busy.io)).toBe(0);
    expect(seen.deepReadTries).toBe(2);
    expect(seen.packets).toHaveLength(1);
    expect(busy.out.join('\n')).toContain('Deep read sent, read once and dropped');
    mode.deepRead = 'limit';
    const limit = io();
    expect(await runScan({ root, code: 'K7Q3-PX9N' }, limit.io)).toBe(0);
    // One try and the client's two retries, then no more: no Retry-After, no waiting.
    expect(seen.deepReadTries).toBe(5);
    expect(seen.reports).toHaveLength(2);
    expect(limit.out.join('\n')).toContain(
      'The deep read did not go through. Your report is ready.',
    );
  });

  it('gives a spent code no second try: a failed upload asks for a new code', async () => {
    mode.reportStatus = 500;
    const root = await fixtureHome();
    const t = io();
    expect(await runScan({ root, code: CODE }, t.io)).toBe(1);
    expect(t.out.join('\n')).toContain(
      `The report did not go through: the server answered 500. Make a new code on ${new URL(base).host}/start and run the new command.`,
    );
    expect(t.opened).toEqual([]);
  });

  it('keeps the deep read off and says so for any other server', async () => {
    mode.consents = { researchAggregates: true, deepRead: true };
    const root = await fixtureHome();
    const t = io();
    t.io.env = { ...t.io.env, AGENTGPA_API_URL: base.replace('127.0.0.1', 'localhost') };
    await runScan({ root, code: CODE }, t.io);
    expect(t.out.join('\n')).toContain('this run is report only, and the deep read is off');
    const payload = PayloadSchema.parse(seen.reports[0]);
    expect(payload.client.origin).toBe('custom');
    expect(payload.consents.deepRead).toBe(false);
    expect(seen.packets).toHaveLength(0);
  });

  it('says what to do about a used, expired or unknown code, and reads nothing', async () => {
    const root = await fixtureHome();
    for (const [status, words] of [
      [409, 'That code was used already.'],
      [410, 'That code expired after 60 minutes.'],
      [404, 'That code is not one we know.'],
    ] as const) {
      mode.refuse = status;
      const t = io();
      expect(await runScan({ root, code: CODE }, t.io)).toBe(1);
      expect(t.out.join('\n')).toContain(words);
      expect(t.out.join('\n')).toContain('/start for a new one');
    }
    expect(seen.reports).toHaveLength(0);
  });

  it('shows the paused box and asks for no run token', async () => {
    mode.uploads = 'paused';
    const root = await fixtureHome();
    const t = io();
    expect(await runScan({ root, code: CODE }, t.io)).toBe(0);
    const text = t.out.join('\n');
    expect(text).toContain('UPLOADS PAUSED');
    expect(text).toContain('Back in a few minutes.');
    expect(text).toContain('Nothing was read or sent.');
    expect(seen.runs).toBe(0);
    expect(seen.reports).toHaveLength(0);
  });

  it('says so when the server cannot be reached', async () => {
    const root = await fixtureHome();
    const t = io();
    t.io.env = { ...t.io.env, AGENTGPA_API_URL: 'http://127.0.0.1:9' };
    expect(await runScan({ root, code: CODE }, t.io)).toBe(1);
    expect(t.out.join('\n')).toContain("Couldn't reach 127.0.0.1:9, so nothing was read.");
  });
});

describe('without a code', () => {
  it('points to /start, reads nothing and makes no network call', async () => {
    const root = await fixtureHome();
    const t = io();
    expect(await runScan({ root }, t.io)).toBe(0);
    const text = t.out.join('\n');
    expect(text).toContain('START ON THE WEBSITE');
    expect(text).toContain('NOTHING WAS READ');
    expect(text).toContain('127.0.0.1');
    expect(seen.status + seen.runs).toBe(0);
  });

  it('shows what was found and what would be sent with --offline, and no result', async () => {
    const root = await fixtureHome();
    const t = io();
    expect(await runScan({ root, offline: true }, t.io)).toBe(0);
    const text = t.out.join('\n');
    expect(text).toContain('OFFLINE · NOTHING WAS SENT');
    expect(text).toContain('A run would send a text-free event log');
    expect(text).not.toMatch(/\bGPA\b/);
    expect(seen.status + seen.runs).toBe(0);
  });
});

describe('the agent flow', () => {
  it('sends at once and prints a few neutral lines under 8,000 characters', async () => {
    const root = await fixtureHome();
    const t = io();
    expect(await runScan({ root, agent: true, code: CODE }, t.io)).toBe(0);
    const text = t.out.join('\n');
    expect(text.length).toBeLessThan(8000);
    expect(text).toContain('AGENT MODE · LINKED TO @mira-dev');
    expect(text).toContain('Sent what the user said yes to on 127.0.0.1');
    expect(text).toContain('Grades, quotes and findings are only shown there.');
    expect(text).toContain('Do not open or read the session files yourself.');
    expect(text).not.toContain(root);
    expect(text).not.toContain(String.fromCharCode(27));
    expect(t.opened).toEqual([]);
    expect(seen.reports).toHaveLength(1);
    const payload = PayloadSchema.parse(seen.reports[0]);
    expect(payload.client.runMode).toBe('agent');
    expectNoResults(text, payload);
  });

  it('gives up the deep read after a minute while the servers are busy', async () => {
    mode.consents = { researchAggregates: true, deepRead: true };
    mode.deepRead = 'swamped';
    const root = await fixtureHome();
    const t = io();
    expect(await runScan({ root, agent: true, code: CODE }, t.io)).toBe(0);
    const text = t.out.join('\n');
    // Tries at 0, 20, 40 and 60 seconds; the next wait would pass the minute.
    expect(seen.deepReadTries).toBe(4);
    expect(text.indexOf('Tell the user the report is ready at')).toBeLessThan(
      text.indexOf('Deep read skipped, the servers are busy. Your report is ready.'),
    );
    expect(text).toContain('The deep read the user chose goes next, at most a minute.');
    expect(t.progress).toContain('Deep read: the readers are busy, trying again');
    expect(seen.reports).toHaveLength(1);
  });

  it('stops a second run of the same code before reading anything', async () => {
    const root = await fixtureHome();
    await runScan({ root, agent: true, code: CODE }, io().io);
    const again = io();
    expect(await runScan({ root, agent: true, code: CODE }, again.io)).toBe(1);
    expect(again.out.join('\n')).toContain('That code was used already.');
    expect(seen.reports).toHaveLength(1);
  });

  it('asks for a code when there is none', async () => {
    const t = io();
    expect(await runScan({ agent: true }, t.io)).toBe(2);
    expect(t.out.join('\n')).toContain('No link code. Tell the user to start at 127.0.0.1');
    expect(seen.status + seen.runs).toBe(0);
  });

  it('refuses --show-packet and --json in agent mode, and a malformed link code', async () => {
    const t = io();
    expect(await runScan({ agent: true, showPacket: true }, t.io)).toBe(2);
    expect(await runScan({ agent: true, json: true }, t.io)).toBe(2);
    expect(t.out.join('\n')).toContain('--json prints the quote candidates');
    expect(await runScan({ code: 'nope' }, t.io)).toBe(2);
    expect(seen.status + seen.runs).toBe(0);
  });
});
