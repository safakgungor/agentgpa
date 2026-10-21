import type { SecretType } from '../src/index.ts';

// Fake secrets, generated when the tests run so no secret-shaped string sits in the source
// (secret scanners read this repository too). Every value is random and fake.

export function rng(seed: number): () => number {
  let x = seed;
  return () => {
    x = (x * 1_103_515_245 + 12_345) % 2 ** 31;
    return x / 2 ** 31;
  };
}

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const BASE32 = `${UPPER}234567`;
const ALNUM = `${UPPER}abcdefghijklmnopqrstuvwxyz0123456789`;
const URLSAFE = `${ALNUM}_-`;
export const join = (...parts: string[]): string => parts.join('');

/** One sample of each kind the detector knows, from a seeded generator. */
export function secretSamples(seed = 42): [SecretType, string][] {
  const random = rng(seed);
  const pick = (alphabet: string, n: number) =>
    Array.from({ length: n }, () => alphabet[Math.floor(random() * alphabet.length)]).join('');
  return [
    ['aws', join('AK', 'IA', pick(BASE32, 16))],
    ['aws', join('AS', 'IA', pick(BASE32, 16))],
    ['github', join('gh', 'p_', pick(ALNUM, 36))],
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

/** 225 fake secrets: fifteen seeds of every kind. */
export function secretCorpus(): string[] {
  return Array.from({ length: 15 }, (_, i) =>
    secretSamples(1000 + i).map(([, value]) => value),
  ).flat();
}

/** Prompts that carry a fake secret, the way people paste them. */
export function leakyPrompts(): string[] {
  const frames = [
    (s: string) => `here is the key ${s} use it`,
    (s: string) => `export API_KEY="${s}"`,
    (s: string) => `why does ${s} not work`,
    (s: string) => `config:\n  token: ${s}\n`,
  ];
  return secretCorpus().map((secret, i) =>
    (frames[i % frames.length] as (s: string) => string)(secret),
  );
}

/** The fragments a leak test looks for: every 12-character window of each secret's body. */
export function fragments(secret: string): string[] {
  const body = secret.replace(/^-----BEGIN[^\n]*\n|\n-----END[\s\S]*$/g, '');
  const out: string[] = [];
  for (let i = 0; i + 12 <= body.length; i += 6) out.push(body.slice(i, i + 12));
  return out;
}
