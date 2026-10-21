import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  buildPayload,
  buildReport,
  decodeSkeleton,
  encodeSkeleton,
  METRIC_SCALARS,
  type Payload,
  type PayloadInput,
  PayloadSchema,
  type Report,
  type Session,
  WireSkeletonSchema,
} from '../src/index.ts';
import { at, call, END, prompt, reply, session } from './build.ts';
import { fragments, leakyPrompts, secretCorpus } from './corpus.ts';
import { parseClaude, parseCodex, parseCursor } from './fixtures.ts';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const context = { projects: ['acme-billing'], names: ['someone'], home: '/Users/someone' };

function payloadOf(
  sessions: Session[],
  end: number,
  days: number,
  extra: Partial<PayloadInput> = {},
) {
  const report = buildReport(sessions, {
    end,
    days,
    observedDays: { 'claude-code': days, codex: days, cursor: days },
    timeZone: 'Europe/Istanbul',
    seed: 'payload',
    quotes: context,
    fingerprint: sha256,
    detectLanguage: () => 'eng',
  });
  const payload = buildPayload({
    report,
    sessions,
    tools: [
      { tool: 'claude-code', found: true, readable: true },
      { tool: 'codex', found: true, readable: true },
      { tool: 'cursor', found: true, readable: true },
    ],
    cliVersion: '0.1.0',
    generatedAt: end,
    timeZone: 'Europe/Istanbul',
    os: 'darwin',
    runMode: 'terminal',
    origin: 'default',
    root: 'default',
    consents: { researchAggregates: true, deepRead: false },
    forensics: { excludedSessions: 0, reasons: {} },
    ...extra,
  });
  return { report, payload };
}

// The fixture home spans months, so the period stretches to hold it.
const fixtures = [parseClaude(), parseCodex(), parseCursor()].flatMap((r) => r.sessions);
const times = fixtures.flatMap((s) => s.events.map((e) => e.ts));
const fixtureEnd = Math.max(...times) + 60_000;
const fixtureDays = Math.min(366, Math.ceil((fixtureEnd - Math.min(...times)) / 86_400_000) + 1);
const { report, payload } = payloadOf(fixtures, fixtureEnd, fixtureDays);

describe('the payload', () => {
  it('passes its own strict schema after a round trip through JSON, and stays small', () => {
    const json = JSON.stringify(payload);
    expect(PayloadSchema.parse(JSON.parse(json))).toEqual(payload);
    expect(gzipSync(json).length).toBeLessThan(250 * 1024);
  });

  it('decodes to the very skeleton the report was graded from', () => {
    expect(decodeSkeleton(payload.skeleton)).toEqual(report.skeleton);
  });

  it('sends every metric that is a number', () => {
    const numeric = Object.entries(report.metrics)
      .filter(([, v]) => typeof v === 'number')
      .map(([k]) => k)
      .sort();
    expect(numeric).toEqual([...METRIC_SCALARS].sort());
  });

  it('refuses any field the schema does not list', () => {
    expect(() => PayloadSchema.parse({ ...payload, notes: 'hi' })).toThrow();
    expect(() =>
      PayloadSchema.parse({ ...payload, client: { ...payload.client, host: 'x' } }),
    ).toThrow();
    expect(() => WireSkeletonSchema.parse({ ...payload.skeleton, paths: [] })).toThrow();
  });

  it('carries no transcript text, path, project key or session id', () => {
    const { quotes, ...rest } = payload;
    const json = JSON.stringify(rest);
    const texts = fixtures
      .flatMap((s) => s.events)
      .flatMap((e) =>
        e.kind === 'user_prompt' || e.kind === 'assistant_text'
          ? [e.text.replace(/\s+/g, ' ').trim()]
          : [],
      )
      .filter((t) => t.length >= 12);
    expect(texts.filter((t) => json.includes(t.slice(0, 12)))).toEqual([]);
    for (const s of fixtures) {
      expect(json).not.toContain(s.id);
      expect(json).not.toContain(s.projectKey);
    }
    expect(json).not.toMatch(/\/Users\/|\/home\/|C:\\\\Users/);
    for (const q of quotes) expect(q.text.length).toBeLessThanOrEqual(400);
  });

  it('leaves out the quotes the user dropped', () => {
    const lots = Array.from({ length: 4 }, (_, d) =>
      session('codex', [
        prompt(at(d + 1, 9), 'fix the tests'),
        prompt(at(d + 1, 9, 20), 'WHY IS THE BUILD STILL RED'),
        prompt(at(d + 1, 9, 40), 'do the thing but not like that one'),
        ...reply(at(d + 1, 9, 41), 'Done.'),
      ]),
    );
    const all = payloadOf(lots, END, 90).payload.quotes.map((q) => q.id);
    const kept = payloadOf(lots, END, 90, { dropQuotes: [2] }).payload.quotes.map((q) => q.id);
    expect(all.length).toBeGreaterThanOrEqual(3);
    expect(kept).toEqual(all.filter((id) => id !== 'q2'));
  });

  it('encodes columns as differences and decodes them back', () => {
    const wire = encodeSkeleton(report.skeleton);
    expect(wire.prompts.session.length).toBe(report.skeleton.prompts.length);
    expect(() =>
      decodeSkeleton({
        ...wire,
        prompts: { ...wire.prompts, minute: wire.prompts.minute.slice(1) },
      }),
    ).toThrow();
  });
});

/** The FNV-1a pair the scanner dedupes with, recomputed to make sure it never leaves. */
function scannerHash(value: string): string {
  let a = 0x811c9dc5;
  let b = 0xcbf29ce4;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x0100019d) >>> 0;
  }
  return `${a.toString(36)}.${b.toString(36)}`;
}

describe('the secret corpus (gates the beta)', () => {
  const prompts = leakyPrompts();
  const secrets = secretCorpus();
  const sessions = prompts.map((text, i) =>
    session(i % 2 ? 'codex' : 'claude-code', [
      prompt(at(1 + (i % 60), 9 + (i % 10)), text),
      // A loud prompt with the same secret: a quote candidate that must never be picked.
      prompt(at(1 + (i % 60), 9 + (i % 10), 5), `WHY DOES THIS STILL FAIL WITH ${secrets[i]}`),
      call(at(1 + (i % 60), 9 + (i % 10), 6), 'Bash', 'Bash'),
    ]),
  );
  const leaky: { report: Report; payload: Payload } = payloadOf(sessions, END, 90);

  it('finds every secret', () => {
    expect(secretCorpus().length).toBeGreaterThanOrEqual(200);
    expect(leaky.payload.secrets.pasted).toBe(secretCorpus().length);
  });

  it('leaves no secret value, fragment or hash in the serialized payload', () => {
    const json = JSON.stringify(leaky.payload);
    for (const secret of secretCorpus()) {
      for (const piece of fragments(secret)) expect(json, secret.slice(0, 6)).not.toContain(piece);
      expect(json).not.toContain(scannerHash(secret));
    }
  });

  it('never makes a quote of a prompt that held a secret', () => {
    expect(leaky.payload.quotes.filter((q) => /secret|KEY|token/i.test(q.text))).toEqual([]);
  });
});
