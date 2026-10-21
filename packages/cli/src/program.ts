import { PAYLOAD_SCHEMA_VERSION } from '@agentgpa/core';
import { Command } from 'commander';
import pkg from '../package.json' with { type: 'json' };
import { type Io, runScan, runUpload, type ScanOptions, type UploadOptions } from './run.ts';

/**
 * The agentgpa command: reads your sessions, grades them and prints the report card, then asks
 * before anything is uploaded. `upload` sends what `--agent` showed, after the user said yes.
 */
export function buildProgram(
  io: Io = { out: (t) => console.log(t), err: (t) => console.error(t) },
): Command {
  const program = new Command('agentgpa')
    .description(
      'Your agent graded you. Grades how you work with your coding agents, from the sessions on this machine.',
    )
    .version(
      `${pkg.version} (payload schema ${PAYLOAD_SCHEMA_VERSION})`,
      '-v, --version',
      'Show the version',
    )
    .helpOption('-h, --help', 'Show this help')
    .option('--dry-run', 'Write agentgpa-payload.json here and send nothing')
    .option('--offline', 'No network at all: the report card only')
    .option('--yes', 'Upload after printing what would be sent, without asking')
    .option('--json', 'Print the payload and send nothing')
    .option('--details', 'Show which kinds of secrets reached your agent, and the fix')
    .option('--debug', 'Print counts per tool (never any text from your sessions)')
    .option('--since <period>', 'The period to grade: 90d, 30d, 14d or 7d', '90d')
    .option('--tools <list>', 'Only read these tools: claude-code,codex,cursor')
    .option(
      '--root <dir>',
      'Read agent data under this folder instead of your home folder (such runs never rank)',
    )
    .option('--deep-read', 'Turn on the deep read (it stays off unless you say so)')
    .option('--show-packet', 'Print the exact deep read packet and send nothing')
    .option('--agent', 'Plain output for your own agent to relay (the copy prompt from /start)')
    .option('--code <code>', 'The link code from /start, which binds the run to your account')
    .showHelpAfterError();

  program.action(async (options: ScanOptions) => {
    process.exitCode = await runScan(options, io);
  });

  program
    .command('upload')
    .description('Upload the report that --agent just showed, after the user said yes')
    .option('--code <code>', 'The link code from /start')
    .option('--drop-quotes <numbers>', 'Quotes to leave out, by number: 1,3')
    .option('--deep-read', 'Turn on the deep read')
    .option('--no-research', 'Keep this report out of AgentGPA research')
    .action(async (options: UploadOptions) => {
      process.exitCode = await runUpload(options, io);
    });

  return program;
}
