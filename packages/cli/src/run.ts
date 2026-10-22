import { chmodSync, writeFileSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  agentSafe,
  buildPacket,
  buildPayload,
  buildReport,
  LINK_CODE,
  observedWindowStart,
  type Packet,
  type Payload,
  type RedactionContext,
  type Report,
  type RunConsents,
  type RunToken,
  SecretScanner,
  type Session,
  TOOLS,
  type Tool,
} from '@agentgpa/core';
import pkg from '../package.json' with { type: 'json' };
import {
  AGENT_OUTPUT_LIMIT,
  renderAgentDeepRead,
  renderAgentRun,
  renderAgentStop,
} from './agent.ts';
import { type Api, ApiError, createApi } from './api.ts';
import { openInBrowser, reportUrl } from './browser.ts';
import { configDir, loadConfig } from './config.ts';
import { discover } from './discover.ts';
import { checkFiles, type Forensics, withoutExcluded } from './forensics.ts';
import { detectLanguage } from './language.ts';
import { apiOrigin, createNet, NetError, type Origin } from './net.ts';
import { debugReport } from './report.ts';
import { scan, sha256 } from './scan.ts';
import {
  codeRefusal,
  type DeepReadEnd,
  renderDeepRead,
  renderOffline,
  renderPaused,
  renderRunDone,
  renderStartOnWebsite,
  type ToolFound,
} from './screens.ts';
import { detectStyle, type Style } from './terminal.ts';

// One run of the CLI. The owner says yes on agentgpa.dev/start, which gives the link code; with
// it the CLI reads the sessions, sends what that yes covers and points back to the site, where
// the report is. It shows no result anywhere: no grades, no quotes, no findings, so neither the
// terminal nor the user's agent sees them. Without a code it reads nothing. `--offline`,
// `--dry-run`, `--json` and `--show-packet` make no network call at all.

export const VERSION = pkg.version;
const MAX_UPLOAD_BYTES = 1024 * 1024;
/**
 * How long the deep read keeps trying while the server's readers are busy. An agent's command can
 * time out, so in agent mode it gives up after a minute: the report is ready either way.
 */
export const DEEP_READ = {
  waitMs: { terminal: 10 * 60_000, agent: 60_000 },
  retryMs: 3000,
} as const;

export interface ScanOptions {
  dryRun?: boolean;
  debug?: boolean;
  offline?: boolean;
  root?: string;
  since?: string;
  tools?: string;
  json?: boolean;
  agent?: boolean;
  code?: string;
  showPacket?: boolean;
}

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
  now?: number;
  env?: Record<string, string | undefined>;
  /** The home folder to read agent data from when there is no --root (tests). */
  home?: string;
  timeZone?: string;
  style?: Style;
  fetch?: typeof fetch;
  /** Opens a report page; tests record it instead. */
  open?: (url: URL) => boolean;
  sleep?: (ms: number) => Promise<void>;
  /** A clock for the timings and the deep read's retries (tests move it). */
  clock?: () => number;
  /** Where `--dry-run` writes its file. */
  cwd?: string;
  platform?: NodeJS.Platform;
  powWorkers?: number;
  /** Stands in for agentgpa.dev (tests only; users cannot reach this). */
  officialApi?: string;
  /**
   * Neutral progress while it works: "Checking agentgpa.dev", "Reading Codex", "Sending".
   * null clears a line a terminal shows in place. Never a result, a path or session text.
   */
  progress?: (text: string | null) => void;
}

const TOOL_NAMES: Record<Tool, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
};

const PERIODS = new Map([
  ['7d', 7],
  ['14d', 14],
  ['30d', 30],
  ['90d', 90],
]);

export function parseSince(value: string | undefined): number | undefined {
  return PERIODS.get(value ?? '90d');
}

export function parseTools(value: string | undefined): Tool[] | undefined {
  if (!value) return [...TOOLS];
  const list = value
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  return list.every((t): t is Tool => (TOOLS as readonly string[]).includes(t)) ? list : undefined;
}

/** Project and account names to take out of quotes and the deep read; they never leave. */
function redactionContext(sessions: readonly Session[], io: Io): RedactionContext {
  const names = new Set<string>();
  try {
    names.add(userInfo().username);
  } catch {
    // No user database entry: nothing to add.
  }
  const host = hostname();
  names.add(host);
  names.add(host.replace(/\.(?:local|lan|home|localdomain)$/i, ''));
  const projects = new Set(
    sessions.map((s) => s.projectName).filter((n): n is string => Boolean(n)),
  );
  return { projects: [...projects], names: [...names].filter(Boolean), home: io.home ?? homedir() };
}

interface Scanned {
  report: Report;
  /** Every parsed session (the all-time counts). */
  sessions: Session[];
  /** The sessions that passed the file checks. */
  kept: Session[];
  tools: ToolFound[];
  forensics: Forensics;
  context: RedactionContext;
  scanMs: number;
  debug: string;
  end: number;
  days: number;
  observedDays: Partial<Record<Tool, number>>;
  /** Whether the sessions came from a folder given with --root. */
  customRoot: boolean;
}

async function read(
  o: {
    root?: string;
    tools: Tool[];
    days: number;
    end: number;
    installId: string;
    code?: string;
    timeZone: string;
  },
  io: Io,
  env: Record<string, string | undefined>,
): Promise<Scanned> {
  const started = performance.now();
  const discovery = discover({ root: o.root, env, home: io.home });
  // Every tool counts the whole period. Claude Code deletes a transcript once it has not changed
  // for cleanupPeriodDays (30 by default), but a file it keeps still holds its older events, and
  // those count too; the setting only shows in --debug.
  const observedDays: Partial<Record<Tool, number>> = {
    'claude-code': o.days,
    codex: o.days,
    cursor: o.days,
  };
  const window = { end: o.end, days: o.days, observedDays };
  const scanner = new SecretScanner();
  const scans = await scan(
    discovery,
    o.tools,
    (tool) => {
      const from = observedWindowStart(window, tool);
      // Web pages and MCP results are other people's content: their example keys are not yours.
      return (text, ts, category) => {
        if (ts >= from && ts <= o.end && category !== 'Web' && category !== 'MCP')
          scanner.toolOutput(text, tool);
      };
    },
    (tool) => io.progress?.(`Reading ${TOOL_NAMES[tool]}`),
  );
  const sessions = scans.flatMap((s) => s.result.sessions);
  const forensics = checkFiles(scans.flatMap((s) => s.fileFacts));
  const kept = withoutExcluded(sessions, forensics);
  const context = redactionContext(kept, io);
  const report = buildReport(kept, {
    ...window,
    timeZone: o.timeZone,
    seed: o.installId,
    scanner,
    detectLanguage,
    fingerprint: sha256,
    quotes: context,
    ...(o.code ? { skipSessionsWith: o.code } : {}),
  });
  const scanMs = performance.now() - started;
  const debug = [
    debugReport(scans, {
      now: o.end,
      sinceDays: o.days,
      claudeCleanupDays: discovery.claude.cleanupPeriodDays,
      claudeCleanupFromSettings: discovery.claude.cleanupFromSettings,
      scanMs,
    }),
    `  file checks: ${forensics.excludedSessions} sessions left out; agent's own session skipped: ${report.device.skippedSessions}`,
  ].join('\n');
  return {
    report,
    sessions,
    kept,
    tools: scans.map((s) => ({
      tool: s.tool,
      found: s.found,
      readable: s.readable,
      ...(s.unreadable ? { unreadable: s.unreadable } : {}),
    })),
    forensics,
    context,
    scanMs,
    debug,
    end: o.end,
    days: o.days,
    observedDays,
    customRoot: o.root !== undefined,
  };
}

function osOf(platform: NodeJS.Platform): 'darwin' | 'linux' | 'win32' {
  return platform === 'darwin' || platform === 'win32' ? platform : 'linux';
}

function payloadFor(
  s: Scanned,
  o: {
    timeZone: string;
    platform: NodeJS.Platform;
    runMode: 'terminal' | 'agent';
    origin: Origin;
    consents: RunConsents;
    runToken?: string;
    report?: Report;
  },
): Payload {
  return buildPayload({
    report: o.report ?? s.report,
    sessions: s.sessions,
    tools: s.tools,
    cliVersion: VERSION,
    generatedAt: s.end,
    timeZone: o.timeZone,
    os: osOf(o.platform),
    runMode: o.runMode,
    origin: o.origin.isDefault ? 'default' : 'custom',
    root: s.customRoot ? 'custom' : 'default',
    consents: o.consents,
    ...(o.runToken ? { runToken: o.runToken } : {}),
    forensics: { excludedSessions: s.forensics.excludedSessions, reasons: s.forensics.reasons },
  });
}

function packetFor(s: Scanned, installId: string, code: string | undefined): Packet {
  return buildPacket(s.kept, {
    end: s.end,
    days: s.days,
    observedDays: s.observedDays,
    promptLanguage: s.report.device.promptLanguage,
    context: s.context,
    seed: installId,
    // Sessions run from the home folder are named for it, never for the account it is named after.
    ...(s.context.home ? { homeProjectKey: sha256(s.context.home) } : {}),
    ...(code ? { skipSessionsWith: code } : {}),
  });
}

function versionBelow(a: string, b: string): boolean {
  const pa = a.split(/[.-]/).map(Number);
  const pb = b.split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
  }
  return false;
}

/** A run token for the code, or why there is none. */
type Online =
  | { api: Api; token: RunToken }
  | { paused: string | true }
  | { stop: string; exitCode: number };

/** The status check and the run token, both before the scan (the token proves when it began). */
async function goOnline(origin: Origin, installId: string, code: string, io: Io): Promise<Online> {
  const api = createApi(
    createNet(origin, io.fetch ?? fetch),
    io.sleep ? { sleep: io.sleep } : {},
    io.powWorkers,
  );
  const status = await api.status(VERSION);
  if (!status) return { stop: `Couldn't reach ${origin.host}, so nothing was read.`, exitCode: 1 };
  if (status.revoked || versionBelow(VERSION, status.minimum)) {
    return {
      stop: `This version can no longer send. Run npx agentgpa@${status.current} with the same code.`,
      exitCode: 1,
    };
  }
  if (status.uploads === 'paused') return { paused: status.message ?? true };
  try {
    return { api, token: await api.runToken({ installId, cliVersion: VERSION, code }) };
  } catch (error) {
    if (error instanceof ApiError && [404, 409, 410].includes(error.status))
      return { stop: codeRefusal(error.status, origin.host), exitCode: 1 };
    if (error instanceof ApiError || error instanceof NetError) {
      return {
        stop: `${origin.host} did not start the run, so nothing was read. Try again in a few minutes.`,
        exitCode: 1,
      };
    }
    throw error;
  }
}

/** The deep read: the packet is built in memory, sent once and dropped. */
async function sendDeepRead(
  api: Api,
  token: string,
  packet: Packet,
  io: Io,
  agent: boolean,
): Promise<DeepReadEnd> {
  const clock = io.clock ?? Date.now;
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = clock() + (agent ? DEEP_READ.waitMs.agent : DEEP_READ.waitMs.terminal);
  // The route answers 429 with a Retry-After while its readers are busy, and the client tries
  // again until its time is up. Any other refusal, the daily limit among them, ends it at once.
  // In agent mode this loop is the only one, so the minute holds.
  for (;;) {
    try {
      await api.sendDeepRead(token, packet, agent ? 0 : undefined);
      return 'sent';
    } catch (error) {
      if (error instanceof ApiError && error.status === 429 && error.retryAfterMs !== undefined) {
        const wait = Math.max(DEEP_READ.retryMs, error.retryAfterMs);
        if (clock() + wait > deadline) return 'busy';
        io.progress?.('Deep read: the readers are busy, trying again');
        await sleep(wait);
        continue;
      }
      return 'failed';
    }
  }
}

/**
 * Reads the sessions on this machine (or under `--root`) and sends what the owner said yes to on
 * /start, for the link code given; prints no result. Returns the exit code.
 */
export async function runScan(options: ScanOptions, io: Io): Promise<number> {
  const days = parseSince(options.since);
  if (days === undefined) {
    io.err('--since takes 7d, 14d, 30d or 90d.');
    return 2;
  }
  const tools = parseTools(options.tools);
  if (!tools) {
    io.err(`--tools takes a comma-separated list of: ${TOOLS.join(', ')}.`);
    return 2;
  }
  if (options.code !== undefined && !LINK_CODE.test(options.code)) {
    io.err('--code takes the 8-character link code from /start, like K7Q3-PX9M.');
    return 2;
  }
  if (options.showPacket && options.agent) {
    io.err(
      '--show-packet prints prompts, so it only runs in your own terminal, never with --agent.',
    );
    return 2;
  }
  const env = io.env ?? process.env;
  let origin: Origin;
  try {
    origin = apiOrigin(env, io.officialApi);
  } catch {
    io.err('AGENTGPA_API_URL must be an https:// origin (or http://localhost while developing).');
    return 2;
  }
  // pnpm and npm run scripts from the package folder; INIT_CWD is where the command was typed.
  const typedIn = env.INIT_CWD ?? io.cwd ?? process.cwd();
  const root = options.root ? resolve(typedIn, options.root) : undefined;
  const end = io.now ?? Date.now();
  const timeZone = io.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  const platform = io.platform ?? process.platform;
  const style = options.agent
    ? { color: false, truecolor: false }
    : (io.style ?? detectStyle(env, process.stdout.isTTY === true));
  const config = loadConfig(configDir(env));
  // A progress line a terminal shows in place goes before anything else is printed.
  const settle = () => io.progress?.(null);
  const say = (lines: string[]) => {
    settle();
    io.out(lines.join('\n'));
  };
  const stop = (message: string, exitCode: number) => {
    settle();
    if (options.agent) io.out(renderAgentStop(VERSION, message));
    else io.out(message);
    return exitCode;
  };

  const local = options.offline || options.dryRun || options.json || options.showPacket;
  if (!local && !options.code) {
    // The way in is the website: say yes there, then run the command it gives. Nothing is read.
    if (options.agent) {
      return stop(
        `No link code. Tell the user to start at ${origin.host}/start, say yes there and paste the prompt it gives.`,
        2,
      );
    }
    say([`AGENTGPA ${VERSION}`, ...renderStartOnWebsite(origin.host, style)]);
    return 0;
  }

  let online: Online | undefined;
  if (!local && options.code) {
    if (!origin.isDefault && !options.agent) {
      io.out(
        `Using ${origin.host}, not agentgpa.dev: this run is report only, and the deep read is off.`,
      );
    }
    io.progress?.(`Checking ${origin.host}`);
    online = await goOnline(origin, config.installId, options.code, io);
    if ('stop' in online) return stop(online.stop, online.exitCode);
    if ('paused' in online) {
      if (options.agent)
        return stop(
          'Uploads are paused for a few minutes. Nothing was read or sent. Ask the user to try again later.',
          0,
        );
      say(renderPaused(online.paused === true ? undefined : online.paused, origin.host, style));
      return 0;
    }
  }

  const clock = io.clock ?? Date.now;
  const scanned = await read(
    {
      ...(root ? { root } : {}),
      tools,
      days,
      end,
      installId: config.installId,
      ...(options.code ? { code: options.code } : {}),
      timeZone,
    },
    io,
    env,
  );
  settle();
  const readSeconds = scanned.scanMs / 1000;
  const { report } = scanned;
  const hasPrompts = report.metrics.userPrompts > 0;
  if (options.debug) io.out(`${scanned.debug}\n`);
  const consentsOff = { researchAggregates: false, deepRead: false };

  if (options.json) {
    if (!hasPrompts) {
      io.err('No prompts in this period, so there is no payload to print.');
      return 1;
    }
    io.out(
      JSON.stringify(
        payloadFor(scanned, {
          timeZone,
          platform,
          runMode: 'terminal',
          origin,
          consents: consentsOff,
        }),
        null,
        2,
      ),
    );
    return 0;
  }
  if (options.showPacket) {
    io.out(JSON.stringify(packetFor(scanned, config.installId, options.code), null, 2));
    io.out('This is exactly the deep read packet. It was not sent.');
    return 0;
  }
  if (options.dryRun) {
    if (!hasPrompts) {
      io.out('Dry run: no prompts in this period, so there is nothing to write. Nothing was sent.');
      return 0;
    }
    const payload = payloadFor(scanned, {
      timeZone,
      platform,
      runMode: 'terminal',
      origin,
      consents: consentsOff,
    });
    const json = JSON.stringify(payload, null, 2);
    const path = join(typedIn, 'agentgpa-payload.json');
    writeFileSync(path, `${json}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    const kb = Math.ceil(gzipSync(json).length / 1024);
    io.out(
      `Dry run: wrote agentgpa-payload.json (${kb} KB gzipped, ${payload.quotes.length} ${payload.quotes.length === 1 ? 'quote' : 'quotes'}). It has no run token, so it can never rank. Nothing was sent.`,
    );
    return 0;
  }
  if (!online || !('token' in online)) {
    // --offline: what was found and what a run would send.
    say(
      renderOffline(
        {
          version: VERSION,
          tools: scanned.tools,
          sessions: report.metrics.sessions,
          days,
          readSeconds,
          quotes: report.quotes.length,
        },
        style,
      ),
    );
    return 0;
  }

  const { api, token } = online;
  if (!hasPrompts) {
    return stop(
      `No prompts in the last ${days} days, so there is nothing to send. Make a new code on ${origin.host}/start after your next session with an agent.`,
      0,
    );
  }
  // The deep read goes only to agentgpa.dev, whatever the code said.
  const consents: RunConsents = {
    researchAggregates: token.consents.researchAggregates,
    deepRead: token.consents.deepRead && origin.isDefault,
  };
  // Quotes with links, paths, shell or wording aimed at agents stay out of an agent's run.
  const sent: Report = options.agent
    ? { ...report, quotes: report.quotes.filter((q) => agentSafe(q.text)) }
    : report;
  const payload = payloadFor(scanned, {
    timeZone,
    platform,
    runMode: options.agent ? 'agent' : 'terminal',
    origin,
    consents,
    runToken: token.runToken,
    report: sent,
  });
  // The code is spent once the run started: every way back is a new code.
  const again = `Make a new code on ${origin.host}/start and run the new command`;
  if (gzipSync(JSON.stringify(payload)).length > MAX_UPLOAD_BYTES) {
    return stop(
      `This report is larger than the server takes (1 MB gzipped). ${again} with --since 30d. A 30-day run cannot be your entrance exam.`,
      1,
    );
  }
  io.progress?.('Sending');
  const sendStarted = clock();
  let accepted: Awaited<ReturnType<Api['upload']>>;
  try {
    accepted = await api.upload(payload, token.runToken);
  } catch (error) {
    const why =
      error instanceof ApiError
        ? `the server answered ${error.status}`
        : 'the server could not be reached';
    return stop(`The report did not go through: ${why}. ${again}.`, 1);
  }
  const sentSeconds = (clock() - sendStarted) / 1000;
  const page = reportUrl(accepted.reportUrl, origin) ?? reportUrl('/start', origin);
  if (!page) return stop(`Sent. Your report is ready at ${origin.host}/start.`, 0);
  const deepReadToken = consents.deepRead ? accepted.deepReadToken : undefined;
  const done = {
    version: VERSION,
    handle: token.account?.handle,
    tools: scanned.tools,
    sessions: report.metrics.sessions,
    days,
    readSeconds,
    sentSeconds,
    quotes: payload.quotes.length,
    consents,
    deepRead: deepReadToken ? 'next' : consents.deepRead ? 'not sent' : 'off',
    page,
    opened: false,
  } as const;
  // The report first: its address, and the browser, before the deep read, which can wait.
  if (options.agent) {
    const text = renderAgentRun({
      ...done,
      ...(origin.isDefault ? {} : { customHost: origin.host }),
    });
    settle();
    io.out(text.length > AGENT_OUTPUT_LIMIT ? text.slice(0, AGENT_OUTPUT_LIMIT) : text);
  } else {
    const opened = (io.open ?? ((u) => openInBrowser(u, env, platform)))(page);
    say(renderRunDone({ ...done, opened }, style));
  }
  if (!deepReadToken) return 0;
  io.progress?.('Sending the deep read');
  const deepStarted = clock();
  const deepEnd = await sendDeepRead(
    api,
    deepReadToken,
    packetFor(scanned, config.installId, options.code),
    io,
    options.agent === true,
  );
  settle();
  if (options.agent) io.out(renderAgentDeepRead(deepEnd));
  else say(renderDeepRead(deepEnd, (clock() - deepStarted) / 1000, style));
  return 0;
}
