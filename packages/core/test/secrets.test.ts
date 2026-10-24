import { describe, expect, it } from 'vitest';
import { findSecrets, SecretScanner, type SecretType } from '../src/index.ts';
import { githubToken } from './corpus.ts';

// The corpus is generated when the test runs, so no secret-shaped string sits in the source
// (secret scanners read this repository too). Every value is random and fake.

let seed = 42;
const random = () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
  return seed / 2 ** 31;
};
const pick = (alphabet: string, n: number) =>
  Array.from({ length: n }, () => alphabet[Math.floor(random() * alphabet.length)]).join('');
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const BASE32 = `${UPPER}234567`;
const ALNUM = `${UPPER}abcdefghijklmnopqrstuvwxyz0123456789`;
const URLSAFE = `${ALNUM}_-`;
const join = (...parts: string[]) => parts.join('');

function corpus(): [SecretType, string][] {
  return [
    ['aws', join('AK', 'IA', pick(BASE32, 16))],
    ['aws', join('AS', 'IA', pick(BASE32, 16))],
    ['github', githubToken(pick(ALNUM, 30))],
    ['github', join('github', '_pat_', pick(`${ALNUM}_`, 82))],
    ['anthropic', join('sk-', 'ant-', 'api03-', pick(URLSAFE, 93))],
    ['openai', join('sk-', 'proj-', pick(URLSAFE, 60))],
    ['openai', join('sk-', pick(ALNUM, 20), 'T3Blbk', 'FJ', pick(ALNUM, 20))],
    ['stripe', join('sk', '_live_', pick(ALNUM, 24))],
    ['gcp', join('AI', 'za', pick(URLSAFE, 35))],
    ['slack', join('xo', 'xb-', pick('0123456789', 12), '-', pick(ALNUM, 24))],
    [
      'private_key',
      join(
        '-----BEGIN ',
        'RSA PRIVATE KEY-----\n',
        pick(ALNUM, 64),
        '\n-----END RSA PRIVATE KEY-----',
      ),
    ],
    [
      'jwt',
      join('ey', 'J', pick(URLSAFE, 20), '.ey', 'J', pick(URLSAFE, 30), '.', pick(URLSAFE, 43)),
    ],
    [
      'db_url',
      join(
        'postgres',
        '://app_',
        pick(ALNUM, 6),
        ':',
        pick(ALNUM, 16),
        '@db.',
        pick(ALNUM, 8),
        '.net:5432/main',
      ),
    ],
    ['other_provider', join('np', 'm_', pick(ALNUM, 36))],
    ['other_provider', join('hf', '_', pick(ALNUM, 34))],
  ];
}

describe('secret detection', () => {
  it('stays linear on a long run of < inside a match', () => {
    // Built when the test runs, like the corpus: a connection string whose password is a run of <.
    const url = ['postgres', '://u:', '<'.repeat(50_000), '@db.internal'].join('');
    const started = performance.now();
    findSecrets(`connect ${url} now`);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('catches every sample in the corpus, by type', () => {
    for (const [type, value] of corpus()) {
      const found = findSecrets(`config = "${value}"\n`);
      expect(
        found.map((f) => f.type),
        type,
      ).toEqual([type]);
    }
  });

  it('has no false positives on hashes, UUIDs, base64 and ordinary code', () => {
    const clean: string[] = [];
    for (let i = 0; i < 400; i++) {
      clean.push(pick('0123456789abcdef', 64)); // sha256
      clean.push(
        `${pick('0123456789abcdef', 8)}-${pick('0123456789abcdef', 4)}-4${pick('0123456789abcdef', 3)}-a${pick('0123456789abcdef', 3)}-${pick('0123456789abcdef', 12)}`,
      );
      clean.push(pick(`${ALNUM}+/`, 120)); // base64
      clean.push(pick('0123456789ABCDEFGHJKMNPQRSTVWXYZ', 26)); // ULID
    }
    clean.push(
      'const sk = await createSkeleton(events);',
      'if (task.status === "ok") return token;',
      'SELECT * FROM users WHERE id = $1;',
    );
    // Documentation examples, templates and test-mode keys are not counted (split so scanners skip this file).
    clean.push(
      join('AWS example: AK', 'IAIOSFODNN7', 'EXAMPLE'),
      join('postgres', '://user:password@localhost:5432/app'),
      join('stripe test sk', '_test_', 'abcdefghijklmnopqrstuvwx'),
    );
    const hits = clean.filter((text) => findSecrets(text).length > 0);
    expect(hits.length / clean.length).toBeLessThan(0.01);
    expect(hits).toEqual([]);
  });

  it('skips keys that unlock nothing: local demo keys, anon keys and unissued GitHub tokens', () => {
    const base64url = (text: string) =>
      btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const jwt = (claims: Record<string, string>) =>
      join(
        base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
        '.',
        base64url(JSON.stringify(claims)),
        '.',
        pick(URLSAFE, 43),
      );
    const types = (text: string) => findSecrets(text).map((f) => f.type);
    // Supabase's local stack gives everyone the same demo keys, service role included.
    expect(types(jwt({ iss: 'supabase-demo', role: 'service_role' }))).toEqual([]);
    // An anon key is public by design; a service role key or a user's session is a secret.
    expect(types(jwt({ iss: 'supabase', ref: pick(ALNUM, 20), role: 'anon' }))).toEqual([]);
    expect(types(jwt({ iss: 'supabase', ref: pick(ALNUM, 20), role: 'service_role' }))).toEqual([
      'jwt',
    ]);
    expect(types(jwt({ sub: pick(ALNUM, 12), role: 'authenticated' }))).toEqual(['jwt']);
    // A GitHub token counts only when its checksum holds, as every issued one does.
    const token = githubToken(pick(ALNUM, 30));
    const broken = join(token.slice(0, -1), token.endsWith('A') ? 'B' : 'A');
    expect(types(`GH=${token}`)).toEqual(['github']);
    expect(types(`GH=${broken}`)).toEqual([]);
  });

  it('counts distinct secrets, pasted and exposed, by type and tool, and never the values', () => {
    const [aws, github] = [corpus()[0]?.[1] as string, corpus()[2]?.[1] as string];
    const scanner = new SecretScanner();
    scanner.prompt(`here is my key ${aws}`, 'claude-code');
    scanner.prompt(`again ${aws}`, 'claude-code');
    scanner.toolOutput(`AWS_KEY=${aws}\nGH=${github}`, 'claude-code');
    scanner.toolOutput(`GH=${github}`, 'codex');
    const counts = scanner.counts();
    expect(counts.pasted).toBe(1);
    expect(counts.exposedViaTools).toBe(1);
    expect(counts.types).toEqual({ aws: 1, github: 1 });
    // The GitHub token reached both agents; it counts once, for the tool that saw it first.
    expect(counts.byTool).toEqual({ 'claude-code': { pasted: 1, exposed: 1 } });
    expect(JSON.stringify(counts)).not.toContain(aws.slice(4));
    expect(scanner.finish()).toEqual(counts);
    expect(scanner.counts().pasted + scanner.counts().exposedViaTools).toBe(0);
  });

  it('scans only the first 64 KB of a tool output', () => {
    const scanner = new SecretScanner();
    scanner.toolOutput(`${'x'.repeat(70 * 1024)} ${corpus()[2]?.[1]}`, 'claude-code');
    expect(scanner.counts().exposedViaTools).toBe(0);
  });
});
