import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The workflows run with this repository's permissions, and the release workflow publishes what
// people install, so every action is pinned to a commit, comes from GitHub or the short list this
// repository allows, and every workflow starts from read-only permissions. Only the release job
// may mint an OIDC token, and nothing runs on untrusted pull request code with secrets.

const dir = join(import.meta.dirname, '..', '..', '.github', 'workflows');
const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
/** A workflow without its comments, which may name what the code must not do. */
const read = (f: string) => readFileSync(join(dir, f), 'utf8').replace(/(^|\s)#.*$/gm, '$1');
const OWNERS = /^(actions|github)\/|^pnpm\/action-setup$|^ossf\/scorecard-action$/;

describe('the workflows', () => {
  it('pin every action to a full commit, from an allowed owner', () => {
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      for (const [, action, ref] of read(f).matchAll(/^\s*(?:-\s+)?uses:\s*([^@\s]+)@(\S+)/gm)) {
        expect(ref, `${f}: ${action}`).toMatch(/^[0-9a-f]{40}$/);
        const repo = (action ?? '').split('/').slice(0, 2).join('/');
        expect(OWNERS.test(repo) || OWNERS.test(action ?? ''), `${f}: ${action}`).toBe(true);
      }
    }
  });

  it('start from read-only permissions, and only the release publishes', () => {
    for (const f of files) {
      const text = read(f);
      expect(text, f).toMatch(
        /^permissions:\s*\n\s+contents: read\s*$|^permissions: read-all\s*$/m,
      );
      expect(text, f).not.toMatch(/pull_request_target/);
      if (f !== 'release.yml') expect(text, f).not.toMatch(/id-token:\s*write/);
    }
    const release = read('release.yml');
    expect(release).toMatch(/environment: release/);
    expect(release).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN:/);
    expect(release).not.toMatch(/cache: pnpm/);
  });
});
