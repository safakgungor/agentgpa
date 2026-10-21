import { isSea } from 'node:sea';

// How to run this same CLI again. The agent flow prints its upload command the way the CLI was
// started, so the second step works whether the agent ran npx, the standalone build or a local
// copy: a machine without Node has no npx to run the upload with.

export interface Program {
  /** The script Node runs (process.argv[1]). */
  script: string;
  /** The running executable (process.execPath): the standalone build itself, inside one. */
  execPath: string;
  /** True inside the standalone build. */
  sea: boolean;
}

export function thisProgram(): Program {
  return { script: process.argv[1] ?? '', execPath: process.execPath, sea: isSea() };
}

/**
 * A path as one shell word. On macOS and Linux it is single-quoted when needed. On Windows it
 * takes forward slashes, which PowerShell, cmd and Git Bash all read, and double quotes when it
 * has a space.
 */
export function shellWord(path: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    const forward = path.replace(/\\/g, '/');
    return /^[\w.:/@+-]+$/.test(forward) ? forward : `"${forward}"`;
  }
  return /^[\w./@+-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

/** The command that starts this CLI again, at the version that is running. */
export function invocation(program: Program, version: string, platform: NodeJS.Platform): string {
  if (program.sea) return shellWord(program.execPath, platform);
  // npx keeps the packages it runs under a _npx folder in the npm cache.
  if (/[\\/]_npx[\\/]/.test(program.script)) return `npx -y agentgpa@${version}`;
  return `node ${shellWord(program.script, platform)}`;
}
