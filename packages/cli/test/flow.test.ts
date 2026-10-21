import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { leadingZeroBits, PacketSchema, PayloadSchema, TelemetrySchema } from '@agentgpa/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseClaude, parseCodex, parseCursor } from '../../core/test/fixtures.ts';
import { scriptedKeys } from '../src/keys.ts';
import { type Io, runScan, runUpload, VERSION } from '../src/run.ts';
import { fixtureHome } from './home.ts';

// The whole CLI against a stand-in AgentGPA server on this machine. The fixture home's sessions
// end in October 2027, so the scans run on 2027-10-20.

const NOW = Date.UTC(2027, 9, 20);
const PREFIX = 'flow-prefix-0123456789';
type Seen = {
  runs: number;
  reports: unknown[];
  packets: unknown[];
  statusPolls: number;
  telemetry: unknown[];
};
let seen: Seen;
let server: Server;
let base = '';
let mode: { uploads: 'open' | 'paused'; claimAfterPolls: number; telemetry: boolean } = {
  uploads: 'open',
  claimAfterPolls: 2,
  telemetry: false,
};

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
        return send(res, 200, {
          current: '0.0.0',
          minimum: '0.0.0',
          rankable: true,
          revoked: false,
          uploads: mode.uploads,
          message: 'Back in a few minutes.',
          ...(mode.telemetry ? { telemetry: true } : {}),
        });
      }
      if (req.method === 'POST' && path === '/api/cli/telemetry') {
        seen.telemetry.push(TelemetrySchema.parse(body(req, raw)));
        return send(res, 200, { ok: true });
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
        return send(res, 200, {
          runToken: 'run-token-flow-aaaaaaaaaa',
          expiresAt: new Date(NOW + 1_800_000).toISOString(),
          ...(r.code ? { account: { name: 'Mira', handle: 'mira-dev' } } : {}),
        });
      }
      if (req.method === 'POST' && path === '/api/cli/reports') {
        const payload = PayloadSchema.parse(body(req, raw));
        seen.reports.push(payload);
        return send(res, 202, {
          claimUrl: `${base}/claim/7KQ2M9XA4P`,
          ...(payload.consents.deepRead ? { deepReadToken: 'deep-read-token-aaaaaaaaaa' } : {}),
        });
      }
      if (req.method === 'GET' && path === '/api/cli/deep-read/status') {
        seen.statusPolls++;
        return send(res, 200, { bound: seen.statusPolls > mode.claimAfterPolls, graded: true });
      }
      if (req.method === 'POST' && path === '/api/cli/deep-read') {
        seen.packets.push(PacketSchema.parse(body(req, raw)));
        return send(res, 200, { ok: true });
      }
      send(res, 404, {});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  seen = { runs: 0, reports: [], packets: [], statusPolls: 0, telemetry: [] };
  mode = { uploads: 'open', claimAfterPolls: 2, telemetry: false };
});

function io(keys: string[] | null, extra: Partial<Io> = {}) {
  const out: string[] = [];
  const opened: string[] = [];
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
    keys: keys ? scriptedKeys(keys) : null,
    open: (url) => {
      opened.push(url.href);
      return true;
    },
    clock: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    timeZone: 'UTC',
    // As if npx had started the CLI, the way the copy prompt does.
    program: {
      script: '/home/dev/.npm/_npx/0f1e2d3c/node_modules/agentgpa/dist/agentgpa.mjs',
      execPath: '/usr/local/bin/node',
      sea: false,
    },
    ...extra,
  };
  return { io: value, out, opened, config };
}

describe('the terminal flow', () => {
  it('shows the card, asks, uploads, opens the claim page, then sends the deep read once claimed', async () => {
    const root = await fixtureHome();
    const t = io(['\r', 'd', 'y']);
    expect(await runScan({ root }, t.io)).toBe(0);
    const text = t.out.join('\n');
    expect(text).toContain('[Enter] shows what would be sent.');
    expect(text).toContain('AGENTGPA · WHAT WOULD BE SENT');
    expect(text).toContain('✓ Sent: a text-free event log');
    expect(text).toContain('/claim/7KQ2M9XA4P (opened in your browser)');
    expect(text).toContain('DEEP READ · WAITING FOR YOUR CLAIM');
    expect(text).toMatch(/✓ Deep read sent: \d+ prompts/);
    expect(t.opened).toEqual([`${base}/claim/7KQ2M9XA4P`]);
    expect(seen.reports).toHaveLength(1);
    expect(seen.packets).toHaveLength(1);
    const payload = PayloadSchema.parse(seen.reports[0]);
    expect(payload.runToken).toBe('run-token-flow-aaaaaaaaaa');
    expect(payload.consents).toEqual({ researchAggregates: true, deepRead: true });
  });

  it('drops the deep read when the report is not claimed within 10 minutes', async () => {
    mode.claimAfterPolls = Number.POSITIVE_INFINITY;
    const root = await fixtureHome();
    const t = io(['\r', 'd', 'y']);
    await runScan({ root }, t.io);
    expect(t.out.join('\n')).toContain(
      'Deep read skipped: the report was not claimed within 10 minutes.',
    );
    expect(seen.packets).toHaveLength(0);
  });

  it('sends nothing when the answer is no', async () => {
    const root = await fixtureHome();
    const t = io(['\r', 'n']);
    await runScan({ root }, t.io);
    expect(t.out.join('\n')).toContain('Nothing was sent.');
    expect(seen.reports).toHaveLength(0);
  });

  it('prints the summary and uploads with --yes, without asking', async () => {
    const root = await fixtureHome();
    const t = io(null);
    await runScan({ root, yes: true }, t.io);
    expect(t.out.join('\n')).toContain('AGENTGPA · WHAT WOULD BE SENT');
    expect(seen.reports).toHaveLength(1);
  });

  it('shows the paused box, keeps the card offline and asks for no run token', async () => {
    mode.uploads = 'paused';
    const root = await fixtureHome();
    const t = io(['\r', 'y']);
    await runScan({ root }, t.io);
    const text = t.out.join('\n');
    expect(text).toContain('UPLOADS PAUSED');
    expect(text).toContain('Back in a few minutes.');
    expect(text).toContain('again in a few minutes');
    expect(seen.runs).toBe(0);
    expect(seen.reports).toHaveLength(0);
  });

  it('says so when the server cannot be reached, and makes no call at all with --offline', async () => {
    const root = await fixtureHome();
    const down = io(['\r', 'y'], {
      env: {
        AGENTGPA_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'agentgpa-')),
        AGENTGPA_API_URL: 'http://127.0.0.1:9',
      },
    });
    await runScan({ root }, down.io);
    expect(down.out.join('\n')).toContain("Couldn't reach 127.0.0.1:9");
    const off = io(['\r', 'y']);
    await runScan({ root, offline: true }, off.io);
    expect(seen.runs).toBe(0);
    expect(off.out.join('\n')).not.toContain('WHAT WOULD BE SENT');
  });

  it('turns the deep read off and warns for any other server', async () => {
    const root = await fixtureHome();
    const t = io(['\r', 'd', 'y'], {});
    t.io.env = { ...t.io.env, AGENTGPA_API_URL: base.replace('127.0.0.1', 'localhost') };
    await runScan({ root }, t.io);
    const text = t.out.join('\n');
    expect(text).toContain('this run is report only, and the deep read is off');
    expect(text).toContain('Off: it only ever goes to agentgpa.dev.');
    expect(PayloadSchema.parse(seen.reports[0]).client.origin).toBe('custom');
    expect(seen.packets).toHaveLength(0);
  });
});

describe('usage counts', () => {
  const choice = (dir: string) =>
    (JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as { telemetry?: boolean })
      .telemetry;

  it('are asked about once, and after a yes leave once at the end of the run', async () => {
    mode.telemetry = true;
    const root = await fixtureHome();
    const t = io(['y', '\r', 'y']);
    expect(await runScan({ root }, t.io)).toBe(0);
    const text = t.out.join('\n');
    expect(text).toContain('ONE QUESTION, ASKED ONCE');
    expect(text).toContain('Never your sessions, code, paths or prompts, and never offline.');
    expect(seen.reports).toHaveLength(1);
    expect(seen.telemetry).toHaveLength(1);
    const sent = TelemetrySchema.parse(seen.telemetry[0]);
    expect(sent.events).toEqual([
      { name: 'cli_run', n: 1 },
      { name: 'cli_preview_shown', n: 1 },
      { name: 'cli_consent_given', n: 1 },
    ]);
    expect(Object.keys(sent).sort()).toEqual(['cliVersion', 'events', 'run']);
    expect(choice(t.config)).toBe(true);

    // The next run does not ask again.
    const again = io(['\r', 'n'], { env: { AGENTGPA_CONFIG_DIR: t.config } });
    await runScan({ root }, again.io);
    expect(again.out.join('\n')).not.toContain('ONE QUESTION, ASKED ONCE');
    expect(seen.telemetry).toHaveLength(2);
  });

  it('stay off after a no, and the question never comes back', async () => {
    mode.telemetry = true;
    const root = await fixtureHome();
    const t = io(['n', '\r', 'n']);
    await runScan({ root }, t.io);
    expect(t.out.join('\n')).toContain('No usage counts.');
    expect(choice(t.config)).toBe(false);
    const again = io(['\r', 'n'], { env: { AGENTGPA_CONFIG_DIR: t.config } });
    await runScan({ root }, again.io);
    expect(again.out.join('\n')).not.toContain('ONE QUESTION, ASKED ONCE');
    expect(seen.telemetry).toHaveLength(0);
  });

  it('are never asked about in agent mode, with --yes or offline, nor when the server takes none', async () => {
    const root = await fixtureHome();
    mode.telemetry = true;
    const agent = io(null);
    await runScan({ root, agent: true, code: 'K7Q3-PX9M' }, agent.io);
    const yes = io(['y']);
    await runScan({ root, yes: true }, yes.io);
    const offline = io(['y']);
    await runScan({ root, offline: true }, offline.io);
    mode.telemetry = false;
    const none = io(['y', '\r', 'n']);
    await runScan({ root }, none.io);
    for (const t of [agent, yes, offline, none]) {
      expect(t.out.join('\n')).not.toContain('ONE QUESTION, ASKED ONCE');
      expect(choice(t.config)).toBeUndefined();
    }
    expect(seen.telemetry).toHaveLength(0);
  });
});

describe('the agent flow', () => {
  it('prints plain text under 8,000 characters and leaves a pending payload for upload', async () => {
    const root = await fixtureHome();
    const t = io(null);
    expect(await runScan({ root, agent: true, code: 'K7Q3-PX9M' }, t.io)).toBe(0);
    const text = t.out.join('\n');
    expect(text.length).toBeLessThan(8000);
    expect(text).toContain('AGENT MODE · NOTHING HAS BEEN SENT');
    expect(text).toContain('Mira (@mira-dev)');
    expect(text).toContain(`npx -y agentgpa@${VERSION} upload --code K7Q3-PX9M`);
    expect(text).not.toContain('not agentgpa.dev');
    expect(text).toContain('- Research: ON unless the user turns it off.');
    expect(text).toContain('[--no-research]');
    expect(text).not.toContain(root);
    // No prompt or reply text, apart from the quote lines the user reviews.
    const sessions = [parseClaude(), parseCodex(), parseCursor()].flatMap((r) => r.sessions);
    const texts = sessions
      .flatMap((s) => s.events)
      .flatMap((e) =>
        e.kind === 'user_prompt' || e.kind === 'assistant_text'
          ? [e.text.replace(/\s+/g, ' ').trim()]
          : [],
      )
      .filter((x) => x.length >= 12);
    const outsideQuotes = text
      .split('\n')
      .filter((line) => !/^ {2}\d "/.test(line))
      .join('\n');
    expect(texts.filter((x) => outsideQuotes.includes(x.slice(0, 12)))).toEqual([]);
    expect(text).not.toContain(String.fromCharCode(27));
    const pending = join(t.config, 'pending');
    const files = readdirSync(pending);
    expect(files).toEqual(['K7Q3-PX9M.json']);
    const waiting = JSON.parse(readFileSync(join(pending, 'K7Q3-PX9M.json'), 'utf8'));
    expect(waiting.origin).toBe(new URL(base).origin);
    if (process.platform !== 'win32') {
      expect(statSync(pending).mode & 0o777).toBe(0o700);
      expect(statSync(join(pending, files[0] as string)).mode & 0o777).toBe(0o600);
    }

    // The user said yes in the chat: the agent runs the upload command it was given.
    const up = io(null);
    up.io.env = { ...t.io.env };
    expect(await runUpload({ code: 'K7Q3-PX9M', deepRead: true, research: false }, up.io)).toBe(0);
    const done = up.out.join('\n');
    expect(done).toContain('UPLOADED');
    expect(done).toContain('deep read on · research off');
    expect(done).toContain('confirm the run at 127.0.0.1');
    expect(seen.reports).toHaveLength(1);
    expect(PayloadSchema.parse(seen.reports[0]).consents).toEqual({
      researchAggregates: false,
      deepRead: true,
    });
    expect(seen.packets).toHaveLength(1);
    expect(existsSync(join(pending, 'K7Q3-PX9M.json'))).toBe(false);
  });

  it('refuses an old pending payload, and any new scan clears it', async () => {
    const root = await fixtureHome();
    const t = io(null);
    await runScan({ root, agent: true, code: 'K7Q3-PX9M' }, t.io);
    const late = io(null, { now: NOW + 31 * 60_000 });
    late.io.env = { ...t.io.env };
    expect(await runUpload({ code: 'K7Q3-PX9M' }, late.io)).toBe(1);
    expect(late.out.join('\n')).toContain('expires after 30 minutes');
    await runScan({ root, agent: true, code: 'K7Q3-PX9M' }, t.io);
    const again = io(null);
    again.io.env = { ...t.io.env };
    await runScan({ root, offline: true }, again.io);
    expect(readdirSync(join(t.config, 'pending'))).toEqual([]);
  });

  it('prints the upload command the way the CLI was started', async () => {
    const root = await fixtureHome();
    const build = '/home/dev/Downloads/agentgpa-linux-x64';
    const t = io(null, {
      program: { script: build, execPath: build, sea: true },
      platform: 'linux',
    });
    await runScan({ root, agent: true, code: 'K7Q3-PX9M' }, t.io);
    const text = t.out.join('\n');
    expect(text).toContain(`${build} upload --code K7Q3-PX9M`);
    expect(text).not.toContain('npx');
  });

  it('uploads to the server the report was prepared for, and refuses another one', async () => {
    const root = await fixtureHome();
    const custom = base.replace('127.0.0.1', 'localhost');
    const t = io(null);
    t.io.env = { ...t.io.env, AGENTGPA_API_URL: custom };
    await runScan({ root, agent: true, code: 'K7Q3-PX9M' }, t.io);
    expect(t.out.join('\n')).toContain(
      `Using ${new URL(custom).host}, not agentgpa.dev: this run is report only`,
    );

    // The agent runs the upload command without AGENTGPA_API_URL: it still goes there.
    const up = io(null);
    up.io.env = { AGENTGPA_CONFIG_DIR: t.config };
    expect(await runUpload({ code: 'K7Q3-PX9M', deepRead: true }, up.io)).toBe(0);
    expect(seen.reports).toHaveLength(1);
    expect(PayloadSchema.parse(seen.reports[0]).client.origin).toBe('custom');
    expect(seen.packets).toHaveLength(0);

    // An upload that names another server sends nothing.
    await runScan({ root, agent: true, code: 'K7Q3-PX9M' }, t.io);
    const other = io(null);
    other.io.env = { AGENTGPA_CONFIG_DIR: t.config, AGENTGPA_API_URL: 'https://example.org' };
    expect(await runUpload({ code: 'K7Q3-PX9M' }, other.io)).toBe(1);
    expect(other.out.join('\n')).toContain(
      `This report was prepared for ${new URL(custom).host}, not example.org`,
    );
    expect(seen.reports).toHaveLength(1);
  });

  it('refuses --show-packet in agent mode and a malformed link code', async () => {
    const t = io(null);
    expect(await runScan({ agent: true, showPacket: true }, t.io)).toBe(2);
    expect(await runScan({ code: 'nope' }, t.io)).toBe(2);
  });
});
