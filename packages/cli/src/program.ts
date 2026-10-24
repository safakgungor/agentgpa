import { PAYLOAD_SCHEMA_VERSION } from '@agentgpa/core';
import { Command } from 'commander';
import pkg from '../package.json' with { type: 'json' };
import { type Io, runScan, type ScanOptions } from './run.ts';
import { askYes, progressLine } from './terminal.ts';

/**
 * The agentgpa command: with the link code from agentgpa.dev/start, reads your sessions and sends
 * what you said yes to there. Your report is on the website; this command shows no result.
 */
export function buildProgram(
  io: Io = {
    out: (t) => console.log(t),
    err: (t) => console.error(t),
    progress: progressLine(process.stderr, process.env),
    // Only a person at a terminal can be asked; an agent's run or a pipe is not.
    ...(process.stdin.isTTY ? { confirm: (question: string) => askYes(question) } : {}),
  },
): Command {
  const program = new Command('agentgpa')
    .description(
      'Your agent graded you. Say yes on agentgpa.dev/start, then run the command it gives: it reads the agent sessions on this machine and sends what you agreed to. Your report is on the website.',
    )
    .version(
      `${pkg.version} (payload schema ${PAYLOAD_SCHEMA_VERSION})`,
      '-v, --version',
      'Show the version',
    )
    .helpOption('-h, --help', 'Show this help')
    .option('--code <code>', 'The link code from agentgpa.dev/start, which carries your yes')
    .option('--agent', 'Plain output for your own agent to relay (the prompt from /start)')
    .option(
      '--to <handle>',
      'The GitHub handle your code is for; a run with no terminal to ask in needs it (the prompt from /start has it)',
    )
    .option('--dry-run', 'Write exactly what would be sent to agentgpa-payload.json, send nothing')
    .option('--offline', 'No network at all: what was found and what would be sent')
    .option('--json', 'Print exactly what would be sent, send nothing')
    .option('--show-packet', 'Print the exact deep read packet, send nothing')
    .option('--debug', 'Print counts per tool (never any text from your sessions)')
    .option('--since <period>', 'The period to read: 90d, 30d, 14d or 7d', '90d')
    .option('--tools <list>', 'Only read these tools: claude-code,codex,cursor')
    .option(
      '--root <dir>',
      'Read agent data under this folder instead of your home folder (such runs never rank)',
    )
    .showHelpAfterError();

  program.action(async (options: ScanOptions) => {
    process.exitCode = await runScan(options, io);
  });

  return program;
}
