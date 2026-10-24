import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { CommanderError } from 'commander';
import { describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import { buildProgram } from '../src/program.ts';
import { askYes } from '../src/terminal.ts';

// An empty home and config folder, so no test ever reads or writes the real ones.
const scratch = mkdtempSync(join(tmpdir(), 'agentgpa-cli-'));

async function run(args: string[]): Promise<string> {
  let output = '';
  const write = (text: string) => {
    output += `${text}\n`;
  };
  const io = {
    out: write,
    err: write,
    home: scratch,
    env: { AGENTGPA_CONFIG_DIR: join(scratch, 'config') },
  };
  const program = buildProgram(io)
    .exitOverride()
    .configureOutput({ writeOut: write, writeErr: write });
  try {
    await program.parseAsync(args, { from: 'user' });
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
  }
  return output;
}

describe('agentgpa', () => {
  it('prints its help with --help', async () => {
    expect(await run(['--help'])).toContain('Usage: agentgpa');
  });

  it('points to /start when run without a code, and reads nothing', async () => {
    const output = await run([]);
    expect(output).toContain('START ON THE WEBSITE');
    expect(output).toContain('agentgpa.dev/start');
    expect(output).toContain('NOTHING WAS READ');
  });

  it('says what it found with --offline, and that nothing was sent', async () => {
    const output = await run(['--offline']);
    expect(output).toContain('Found no agent sessions');
    expect(output).toContain('NOTHING WAS SENT');
  });

  it('prints its version and the payload schema', async () => {
    expect(await run(['--version'])).toContain(`${pkg.version} (payload schema 1)`);
  });

  it('lists the scan flags', async () => {
    const help = await run(['--help']);
    for (const flag of [
      '--code',
      '--agent',
      '--to',
      '--dry-run',
      '--debug',
      '--since',
      '--tools',
      '--root',
    ])
      expect(help).toContain(flag);
    // The choices are made on agentgpa.dev/start; a terminal is asked only whose account the code
    // is for, and no flag answers that for it.
    for (const gone of ['--yes', '--deep-read', '--details', 'upload'])
      expect(help).not.toContain(gone);
  });
});

describe('the account question', () => {
  const answer = async (typed: string | null) => {
    const input = new PassThrough();
    const reply = askYes('Is that you? [y/N] ', input, new PassThrough());
    if (typed === null) input.end();
    else input.write(typed);
    return reply;
  };

  it('takes only y or yes as a yes', async () => {
    expect(await answer('y\n')).toBe(true);
    expect(await answer(' YES \n')).toBe(true);
    for (const typed of ['\n', 'n\n', 'no\n', 'yep\n']) expect(await answer(typed)).toBe(false);
  });

  it('counts a closed input as a no', async () => {
    expect(await answer(null)).toBe(false);
  });
});

// The npm package must stay dependency-free: everything is bundled at build time.
describe('the published package', () => {
  it('declares no runtime dependencies and no install scripts', () => {
    expect(Object.keys(pkg)).not.toContain('dependencies');
    const scripts: Record<string, string> = pkg.scripts;
    for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
      expect(Object.keys(scripts)).not.toContain(hook);
    }
  });
});
