#!/usr/bin/env node
import { buildProgram } from './program.ts';

const args = process.argv.slice(2);
// `pnpm --filter agentgpa dev -- --help` passes the `--` through; drop it so the flags still parse.
if (args[0] === '--') args.shift();

buildProgram()
  .parseAsync(args, { from: 'user' })
  .catch((error: unknown) => {
    // The class only: a message could hold a path or a piece of a session.
    process.stderr.write(`agentgpa stopped: ${error instanceof Error ? error.name : 'Error'}\n`);
    process.exitCode = 1;
  });
