import { describe, expect, it } from 'vitest';
import { drawMasks, redact, shownLength } from '../src/index.ts';
import { fragments, join, secretCorpus } from './corpus.ts';

const context = {
  projects: ['acme-billing', 'secret-project'],
  names: ['someone', 'someones-mbp'],
  home: '/Users/someone',
};

describe('redaction', () => {
  it('takes out every secret of the corpus, leaving no fragment behind', () => {
    const corpus = secretCorpus();
    expect(corpus.length).toBeGreaterThanOrEqual(200);
    for (const secret of corpus) {
      const out = redact(`use ${secret} now`, context);
      for (const piece of fragments(secret))
        expect(out.text, secret.slice(0, 6)).not.toContain(piece);
      expect(out.kinds).toContain('secret');
    }
  });

  it('takes out a random-looking token no pattern knows', () => {
    const token = join('Zk3q9WmX2pL7', 'vR4tB8nY1cF6', 'hJ5dG0sA');
    expect(redact(`the value is ${token}`, context).text).toBe('the value is [secret]');
  });

  it.each([
    ['an email', 'mail someone@example.org about it', 'mail [email] about it'],
    ['a link with a query', 'open https://example.org/a?token=x', 'open [url]'],
    ['a link with credentials', 'clone https://user:pw@example.org/r.git', 'clone [url]'],
    ['an id', 'session 3f2b9c1e-8a4d-4c3b-9e2f-1a2b3c4d5e6f broke', 'session [id] broke'],
    ['a hash', 'commit 3f2b9c1e8a4d4c3b9e2f1a2b3c4d5e6f7a8b9c0d', 'commit [id]'],
    ['an address', 'ssh to 192.168.10.24 please', 'ssh to [ip] please'],
    ['a phone number', 'call +90 532 123 45 67 later', 'call [phone] later'],
    ['the home folder', 'look in /Users/someone/work/app/src', 'look in ~/work/app/src'],
    ["someone else's home", 'see /home/runner/build/out', 'see ~/build/out'],
    ['a project name', 'deploy acme-billing tonight', 'deploy [project] tonight'],
    ['an account name', 'ssh someones-mbp', 'ssh [name]'],
  ])('takes out %s', (_, input, expected) => {
    expect(redact(input, context).text).toBe(expected);
  });

  it('leaves ordinary prompts alone', () => {
    for (const text of [
      'fix the tests',
      'rename createSkeletonFromSessions to buildSkeleton',
      'bump to version 2.1.0',
      'meeting on 2026-10-19 at 14:30',
      'git sha abc1234 broke the build',
      'std::vector is fine here',
    ]) {
      expect(redact(text, context)).toEqual({ text, kinds: [] });
    }
  });
});

describe('masks', () => {
  it('count as their letters and draw as bars', () => {
    expect(shownLength('[[bar:4]] it')).toBe(7);
    expect(drawMasks('[[bar:3]] now')).toBe(`${String.fromCodePoint(0x2588).repeat(3)} now`);
  });
});
