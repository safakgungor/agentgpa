import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommanderError } from 'commander';
import { describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import { buildProgram } from '../src/program.ts';

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

  it('reads the sessions when run without arguments, and says when there are none', async () => {
    const output = await run([]);
    expect(output).toContain('Claude Code not found');
    expect(output).toContain('so nothing to grade.');
    expect(output).toContain('Nothing has left this machine.');
  });

  it('prints its version and the payload schema', async () => {
    expect(await run(['--version'])).toContain(`${pkg.version} (payload schema 1)`);
  });

  it('lists the scan flags', async () => {
    const help = await run(['--help']);
    for (const flag of ['--dry-run', '--debug', '--since', '--tools', '--root'])
      expect(help).toContain(flag);
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
