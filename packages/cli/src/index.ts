#!/usr/bin/env node
import { NO_PEEKING } from './agent.ts';
import { buildProgram } from './program.ts';

const args = process.argv.slice(2);
// `pnpm --filter agentgpa dev -- --help` passes the `--` through; drop it so the flags still parse.
if (args[0] === '--') args.shift();

buildProgram()
  .parseAsync(args, { from: 'user' })
  .catch((error: unknown) => {
    // The class only: a message could hold a path or a piece of a session.
    process.stderr.write(`agentgpa stopped: ${error instanceof Error ? error.name : 'Error'}\n`);
    // An agent that sees the run stop is told the same as when it ends well.
    if (args.includes('--agent')) process.stderr.write(`${NO_PEEKING}\n`);
    process.exitCode = 1;
  });
