import {
  type Dirent,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, sep } from 'node:path';
import type { ClaudeFileKind } from '@agentgpa/core';

// Finds the agent data on this machine. Only the known locations are read, symlinks are
// never followed, and every file must stay inside its tool's folder.

export interface FoundFile {
  path: string;
  size: number;
  mtimeMs: number;
  /** The creation time, or the change time where the file system keeps none. */
  birthtimeMs: number;
  /** The creation time only where the file system records it (for the file checks). */
  createdMs?: number;
}

export interface ClaudeFound extends FoundFile {
  kind: ClaudeFileKind;
  sessionId: string;
}

export interface CodexFound extends FoundFile {
  sessionId: string;
}

export interface TranscriptFound extends FoundFile {
  composerId: string;
}

export interface Discovery {
  claude: {
    dir: string;
    found: boolean;
    files: ClaudeFound[];
    cleanupPeriodDays: number;
    cleanupFromSettings: boolean;
  };
  codex: { dir: string; found: boolean; files: CodexFound[] };
  cursor: { found: boolean; databases: string[]; transcripts: TranscriptFound[] };
}

export interface DiscoverOptions {
  /** A folder that stands in for the home folder (tests, fixtures). Env overrides are ignored. */
  root?: string | undefined;
  /** The home folder when there is no root; env overrides apply. Defaults to the user's home. */
  home?: string | undefined;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
}

const UUID_TAIL = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

function entries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function inside(root: string, path: string): boolean {
  try {
    const real = realpathSync(path);
    const base = realpathSync(root);
    return real === base || real.startsWith(base + sep);
  } catch {
    return false;
  }
}

function found(path: string): FoundFile | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return undefined;
    const file: FoundFile = {
      path,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      birthtimeMs: stat.birthtimeMs || stat.mtimeMs,
    };
    if (stat.birthtimeMs > 0) file.createdMs = stat.birthtimeMs;
    return file;
  } catch {
    return undefined;
  }
}

function isDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function claudeFiles(projects: string): ClaudeFound[] {
  const out: ClaudeFound[] = [];
  const add = (path: string, kind: ClaudeFileKind, sessionId: string): void => {
    const file = path.endsWith('.jsonl') && inside(projects, path) ? found(path) : undefined;
    if (file) out.push({ ...file, kind, sessionId });
  };
  for (const project of entries(projects)) {
    if (!project.isDirectory()) continue;
    const projectDir = join(projects, project.name);
    for (const entry of entries(projectDir)) {
      const path = join(projectDir, entry.name);
      if (entry.isFile() && entry.name.endsWith('.jsonl'))
        add(path, 'main', entry.name.slice(0, -'.jsonl'.length));
      if (!entry.isDirectory()) continue;
      const sessionId = entry.name;
      const subagents = join(path, 'subagents');
      for (const sub of entries(subagents)) {
        if (sub.isFile() && sub.name.startsWith('agent-'))
          add(join(subagents, sub.name), 'subagent', sessionId);
      }
      const workflows = join(subagents, 'workflows');
      for (const wf of entries(workflows)) {
        if (!wf.isDirectory()) continue;
        for (const agent of entries(join(workflows, wf.name))) {
          // The workflow journal next to the agents is not a transcript.
          if (agent.isFile() && agent.name.startsWith('agent-'))
            add(join(workflows, wf.name, agent.name), 'workflow-agent', sessionId);
        }
      }
    }
  }
  return out;
}

function cleanupPeriod(dir: string): { days: number; fromSettings: boolean } {
  try {
    const settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as {
      cleanupPeriodDays?: unknown;
    };
    const days = settings.cleanupPeriodDays;
    if (typeof days === 'number' && Number.isFinite(days) && days >= 0)
      return { days, fromSettings: true };
  } catch {
    // No settings file, or one we cannot read: Claude Code's default applies.
  }
  return { days: 30, fromSettings: false };
}

function codexFiles(dir: string): CodexFound[] {
  const out: CodexFound[] = [];
  const walk = (path: string, depth: number): void => {
    for (const entry of entries(path)) {
      const child = join(path, entry.name);
      if (entry.isDirectory() && depth < 4) walk(child, depth + 1);
      else if (
        entry.isFile() &&
        entry.name.startsWith('rollout-') &&
        entry.name.endsWith('.jsonl') &&
        inside(dir, child)
      ) {
        const file = found(child);
        if (file)
          out.push({
            ...file,
            sessionId: UUID_TAIL.exec(entry.name)?.[1] ?? basename(entry.name, '.jsonl'),
          });
      }
    }
  };
  walk(join(dir, 'sessions'), 0);
  walk(join(dir, 'archived_sessions'), 0);
  return out;
}

function cursorUserDirs(home: string, options: DiscoverOptions): string[] {
  const env = options.env ?? process.env;
  if (options.root) {
    return [
      join(home, 'Library', 'Application Support', 'Cursor', 'User'),
      join(home, '.config', 'Cursor', 'User'),
      join(home, 'AppData', 'Roaming', 'Cursor', 'User'),
    ];
  }
  const platform = options.platform ?? process.platform;
  if (platform === 'darwin')
    return [join(home, 'Library', 'Application Support', 'Cursor', 'User')];
  if (platform === 'win32')
    return [join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Cursor', 'User')];
  return [join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'Cursor', 'User')];
}

function cursorTranscripts(projects: string): TranscriptFound[] {
  const out: TranscriptFound[] = [];
  for (const project of entries(projects)) {
    if (!project.isDirectory()) continue;
    const dir = join(projects, project.name, 'agent-transcripts');
    for (const entry of entries(dir)) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        for (const file of entries(path)) {
          const child = join(path, file.name);
          const f =
            file.isFile() && file.name.endsWith('.jsonl') && inside(projects, child)
              ? found(child)
              : undefined;
          if (f) out.push({ ...f, composerId: entry.name });
        }
      } else if (entry.isFile() && entry.name.endsWith('.jsonl') && inside(projects, path)) {
        const f = found(path);
        if (f) out.push({ ...f, composerId: entry.name.slice(0, -'.jsonl'.length) });
      }
    }
  }
  return out;
}

export function discover(options: DiscoverOptions = {}): Discovery {
  const env = options.env ?? process.env;
  const home = options.root ?? options.home ?? homedir();
  const claudeDir = options.root
    ? join(home, '.claude')
    : (env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'));
  const codexDir = options.root ? join(home, '.codex') : (env.CODEX_HOME ?? join(home, '.codex'));

  const projects = join(claudeDir, 'projects');
  const cleanup = cleanupPeriod(claudeDir);
  const databases = cursorUserDirs(home, options)
    .map((dir) => join(dir, 'globalStorage', 'state.vscdb'))
    .filter((path) => existsSync(path) && statSync(path).isFile());
  const transcripts = cursorTranscripts(join(home, '.cursor', 'projects'));

  return {
    claude: {
      dir: claudeDir,
      found: isDir(projects),
      files: claudeFiles(projects),
      cleanupPeriodDays: cleanup.days,
      cleanupFromSettings: cleanup.fromSettings,
    },
    codex: {
      dir: codexDir,
      found: isDir(join(codexDir, 'sessions')) || isDir(join(codexDir, 'archived_sessions')),
      files: codexFiles(codexDir),
    },
    cursor: { found: databases.length > 0 || transcripts.length > 0, databases, transcripts },
  };
}
