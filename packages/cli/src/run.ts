import { randomUUID } from 'node:crypto';
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
  localClock,
  observedWindowStart,
  type Packet,
  type Payload,
  PayloadSchema,
  type RedactionContext,
  type Report,
  type RunToken,
  SecretScanner,
  type Session,
  type TelemetryEvent,
  TOOLS,
  type Tool,
} from '@agentgpa/core';
import pkg from '../package.json' with { type: 'json' };
import { AGENT_OUTPUT_LIMIT, renderAgentRun, renderUploaded } from './agent.ts';
import { type Api, ApiError, createApi } from './api.ts';
import { openInBrowser, reportUrl } from './browser.ts';
import { configDir, loadConfig, saveConfig } from './config.ts';
import { askConsent, type ConsentQuote, type ConsentState, renderConsent } from './consent.ts';
import { discover } from './discover.ts';
import { checkFiles, type Forensics, withoutExcluded } from './forensics.ts';
import { CTRL_C, ENTER, ESCAPE, type KeyReader, terminalKeys } from './keys.ts';
import { detectLanguage } from './language.ts';
import { apiOrigin, createNet, NetError, type Origin } from './net.ts';
import { clearPending, readPending, removePending, writePending } from './pending.ts';
import { renderPreview } from './preview.ts';
import { debugReport, gradesSummary } from './report.ts';
import { scan, sha256 } from './scan.ts';
import {
  pausedFooter,
  renderClaimWait,
  renderPaused,
  renderSent,
  renderTelemetryQuestion,
} from './screens.ts';
import { detectStyle, ESC, type Style } from './terminal.ts';

// One run of the CLI: read the sessions, grade them, show the card, and, only after a yes,
// upload the payload. Nothing streams in the background and nothing is sent without the
// consent step (or `--yes`, which still prints it). `--offline`, `--dry-run` and `--json` make
// no network call at all.

export const VERSION = pkg.version;
const MAX_UPLOAD_BYTES = 1024 * 1024;
const CLAIM_WAIT_MS = 10 * 60_000;
const CLAIM_POLL_MS = 3000;

export interface ScanOptions {
  dryRun?: boolean;
  debug?: boolean;
  offline?: boolean;
  details?: boolean;
  root?: string;
  since?: string;
  tools?: string;
  yes?: boolean;
  json?: boolean;
  agent?: boolean;
  code?: string;
  deepRead?: boolean;
  showPacket?: boolean;
}

export interface UploadOptions {
  code?: string;
  dropQuotes?: string;
  deepRead?: boolean;
  /** `--no-research` sets this to false. */
  research?: boolean;
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
  /** Key presses; null means none (not a terminal). Tests pass scripted keys. */
  keys?: KeyReader | null;
  fetch?: typeof fetch;
  /** Opens a report page; tests record it instead. */
  open?: (url: URL) => boolean;
  sleep?: (ms: number) => Promise<void>;
  /** A clock for the waits (tests move it). */
  clock?: () => number;
  /** Where `--dry-run` writes its file. */
  cwd?: string;
  platform?: NodeJS.Platform;
  powWorkers?: number;
  /** Stands in for agentgpa.dev (tests only; users cannot reach this). */
  officialApi?: string;
}

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
  tools: { tool: Tool; found: boolean; readable: boolean }[];
  forensics: Forensics;
  context: RedactionContext;
  claudeCleanupDays: number;
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
  const observedDays: Partial<Record<Tool, number>> = {
    'claude-code': Math.min(o.days, discovery.claude.cleanupPeriodDays),
    codex: o.days,
    cursor: o.days,
  };
  const window = { end: o.end, days: o.days, observedDays };
  const scanner = new SecretScanner();
  const scans = await scan(discovery, o.tools, (tool) => {
    const from = observedWindowStart(window, tool);
    // Web pages and MCP results are other people's content: their example keys are not yours.
    return (text, ts, category) => {
      if (ts >= from && ts <= o.end && category !== 'Web' && category !== 'MCP')
        scanner.toolOutput(text, tool);
    };
  });
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
    gradesSummary(report),
    `  file checks: ${forensics.excludedSessions} sessions left out; agent's own session skipped: ${report.device.skippedSessions}`,
  ].join('\n');
  return {
    report,
    sessions,
    kept,
    tools: scans.map((s) => ({ tool: s.tool, found: s.found, readable: s.readable })),
    forensics,
    context,
    claudeCleanupDays: discovery.claude.cleanupPeriodDays,
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
    consents: { researchAggregates: boolean; deepRead: boolean };
    dropQuotes?: number[];
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
    ...(o.dropQuotes ? { dropQuotes: o.dropQuotes } : {}),
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
    ...(code ? { skipSessionsWith: code } : {}),
  });
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The quotes as the consent screen and agent mode show them. */
function quoteViews(report: Report, timeZone: string): ConsentQuote[] {
  const clock = localClock(timeZone);
  const start = Date.parse(report.skeleton.period.start);
  return report.quotes.map((q) => {
    if (q.kind === 'most_repeated')
      return { kind: q.kind, text: q.text, meta: `${q.count ?? 0} times` };
    const t = clock(start + ((report.skeleton.prompts[q.prompt]?.[1] ?? 0) as number) * 60_000);
    const meta = `${WEEKDAYS[t.weekday]} ${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
    return { kind: q.kind, text: q.text, meta };
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

interface Online {
  api: Api;
  origin: Origin;
  token?: RunToken;
  /** Why nothing can be uploaded, when nothing can. */
  blocked?: string;
  paused?: string | true;
  /** The server takes opt-in usage counts. */
  telemetry?: boolean;
}

/** The status check and the run token, both before the scan (the token proves when it began). */
async function goOnline(
  origin: Origin,
  installId: string,
  code: string | undefined,
  io: Io,
): Promise<Online> {
  const api = createApi(
    createNet(origin, io.fetch ?? fetch),
    io.sleep ? { sleep: io.sleep } : {},
    io.powWorkers,
  );
  const status = await api.status(VERSION);
  if (!status)
    return {
      api,
      origin,
      blocked: `Couldn't reach ${origin.host}, so nothing can be sent right now.`,
    };
  if (status.revoked || versionBelow(VERSION, status.minimum)) {
    return {
      api,
      origin,
      blocked: `This version can no longer upload. Run npx agentgpa@${status.current} instead.`,
    };
  }
  const telemetry = status.telemetry === true;
  if (status.uploads === 'paused') {
    return { api, origin, paused: status.message ?? true, telemetry };
  }
  try {
    const token = await api.runToken({ installId, cliVersion: VERSION, ...(code ? { code } : {}) });
    return { api, origin, token, telemetry };
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 410) && code) {
      return {
        api,
        origin,
        blocked: 'That link code is no longer valid. Open /start for a new one.',
        telemetry,
      };
    }
    if (error instanceof ApiError || error instanceof NetError) {
      return {
        api,
        origin,
        blocked: `${origin.host} did not hand out a run token, so nothing can be sent right now.`,
        telemetry,
      };
    }
    throw error;
  }
}

/** One run's opt-in usage counts, and how they leave once the run ends (if they may). */
interface RunTelemetry {
  events: Map<TelemetryEvent, number>;
  send?: () => Promise<void>;
}

const counted = (tel: RunTelemetry, name: TelemetryEvent) =>
  tel.events.set(name, Math.min(100, (tel.events.get(name) ?? 0) + 1));

/** Asks once whether usage counts may go; undefined when nobody can answer here. */
async function askTelemetry(io: Io, style: Style): Promise<boolean | undefined> {
  const keys = io.keys === undefined ? terminalKeys() : io.keys;
  if (!keys) return undefined;
  try {
    io.out(renderTelemetryQuestion(style).join('\n'));
    const key = await waitForKey(keys, (k) =>
      ['y', 'Y', 'n', 'N', ESCAPE, CTRL_C, ...ENTER].includes(k),
    );
    if (key === undefined) return undefined;
    const yes = key === 'y' || key === 'Y';
    io.out(
      yes
        ? 'Thanks. Usage counts are on. Change it any time in ~/.agentgpa/config.json.'
        : 'No usage counts. Change it any time in ~/.agentgpa/config.json.',
    );
    return yes;
  } finally {
    if (io.keys === undefined) keys.close();
  }
}

async function waitForKey(
  keys: KeyReader,
  accept: (key: string) => boolean,
): Promise<string | undefined> {
  for (;;) {
    const key = await keys.next();
    if (key === undefined || accept(key)) return key;
  }
}

/**
 * Reads the sessions on this machine (or under `--root`), grades them and prints the report
 * card; then, after a yes, uploads the payload. Returns the exit code. The run's opt-in usage
 * counts, when they may go, leave once at its end.
 */
export async function runScan(options: ScanOptions, io: Io): Promise<number> {
  const tel: RunTelemetry = { events: new Map() };
  try {
    return await scanRun(options, io, tel);
  } finally {
    await tel.send?.();
  }
}

async function scanRun(options: ScanOptions, io: Io, tel: RunTelemetry): Promise<number> {
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
  const dir = configDir(env);
  const config = loadConfig(dir);
  // A new scan drops any pending agent-mode payload (they last 30 minutes at most anyway).
  clearPending(dir);

  const offline = options.offline || options.dryRun || options.json || options.showPacket;
  let online: Online | undefined;
  if (!offline) {
    if (!origin.isDefault && !options.agent) {
      io.out(
        `Using ${origin.host}, not agentgpa.dev: this run is report only, and the deep read is off.`,
      );
    }
    online = await goOnline(origin, config.installId, options.code, io);
    counted(tel, 'cli_run');
    if (online.telemetry && !options.agent && !options.yes) {
      const choice = config.telemetry ?? (await askTelemetry(io, style));
      if (choice !== undefined && config.telemetry === undefined) {
        saveConfig(dir, { ...config, telemetry: choice });
      }
      if (choice === true) {
        const api = online.api;
        const run = randomUUID();
        tel.send = () =>
          api.telemetry({
            run,
            cliVersion: VERSION,
            events: [...tel.events].map(([name, n]) => ({ name, n })),
          });
      }
    }
    if (online.paused && !options.agent && !options.json) {
      io.out(
        renderPaused(online.paused === true ? undefined : online.paused, origin.host, style).join(
          '\n',
        ),
      );
    }
  }

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
  if (options.agent) {
    return agentRun(
      scanned,
      { origin, online, code: options.code, timeZone, platform, dir, ...(root ? { root } : {}) },
      io,
    );
  }

  const who = online?.token?.account;
  const canUpload = hasPrompts && online?.token !== undefined;
  io.out(
    renderPreview(report, {
      style,
      tools: scanned.tools,
      scanMs: scanned.scanMs,
      days,
      claudeCleanupDays: scanned.claudeCleanupDays,
      details: options.details === true,
      ...(who ? { who } : {}),
      footer: online?.paused ? 'none' : canUpload ? 'enter' : 'plain',
    }),
  );
  counted(tel, 'cli_preview_shown');
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
  if (online?.paused) {
    io.out(pausedFooter(style).join('\n'));
    return 0;
  }
  if (!hasPrompts || offline) return 0;
  if (!online?.token) {
    if (online?.blocked) io.out(online.blocked);
    return 0;
  }
  return terminalUpload(
    scanned,
    {
      online,
      token: online.token,
      options,
      style,
      timeZone,
      platform,
      installId: config.installId,
      tel,
    },
    io,
  );
}

async function terminalUpload(
  s: Scanned,
  o: {
    online: Online;
    token: RunToken;
    options: ScanOptions;
    style: Style;
    timeZone: string;
    platform: NodeJS.Platform;
    installId: string;
    tel: RunTelemetry;
  },
  io: Io,
): Promise<number> {
  const { online, style, options } = o;
  const keys = (io.keys === undefined ? terminalKeys() : io.keys) ?? null;
  if (!keys && !options.yes) {
    io.out('To upload, run this in a terminal, or add --yes to upload after the summary.');
    return 0;
  }
  try {
    if (!options.yes && keys) {
      const key = await waitForKey(
        keys,
        (k) => ENTER.includes(k) || [CTRL_C, ESCAPE, 'q', 'n'].includes(k),
      );
      if (key === undefined || !ENTER.includes(key)) {
        io.out('Nothing was sent.');
        return 0;
      }
    }
    let packet: Packet | undefined;
    const packetOnce = () => {
      packet ??= packetFor(s, o.installId, options.code);
      return packet;
    };
    const deepReadPrompts = online.origin.isDefault ? packetOnce().prompts.length : 0;
    const view = {
      sessions: s.report.metrics.sessions,
      secrets: s.report.device.secrets.pasted + s.report.device.secrets.exposedViaTools,
      quotes: quoteViews(s.report, o.timeZone),
      deepReadPrompts,
      host: online.origin.host,
    };
    let state: ConsentState = {
      dropped: new Set(),
      deepRead: options.deepRead === true && deepReadPrompts > 0,
      research: true,
    };
    if (options.yes || !keys) {
      io.out(renderConsent(view, state, style).join('\n'));
    } else {
      const answer = await askConsent({
        view,
        initial: state,
        style,
        keys,
        out: io.out,
        redraw: style.color,
        showPacket: () => {
          io.out(JSON.stringify(packetOnce(), null, 2));
          io.out('That is exactly the deep read packet. Nothing has been sent.');
        },
      });
      if (!answer.upload) {
        io.out('Nothing was sent.');
        return 0;
      }
      state = answer.state;
    }
    counted(o.tel, 'cli_consent_given');

    const payload = payloadFor(s, {
      timeZone: o.timeZone,
      platform: o.platform,
      runMode: 'terminal',
      origin: online.origin,
      consents: { researchAggregates: state.research, deepRead: state.deepRead },
      dropQuotes: [...state.dropped],
      runToken: o.token.runToken,
    });
    if (gzipSync(JSON.stringify(payload)).length > MAX_UPLOAD_BYTES) {
      io.out('This report is larger than the server takes (1 MB gzipped). Try --since 30d.');
      return 1;
    }
    const clock = io.clock ?? Date.now;
    const started = clock();
    let accepted: Awaited<ReturnType<Api['upload']>>;
    try {
      accepted = await online.api.upload(payload, o.token.runToken);
    } catch (error) {
      const why =
        error instanceof ApiError
          ? `the server answered ${error.status}`
          : 'the server could not be reached';
      io.out(`The upload did not go through: ${why}. Run npx agentgpa again in a few minutes.`);
      return 1;
    }
    const linked = options.code !== undefined;
    const page = reportUrl(
      linked ? '/start' : (accepted.reportUrl ?? accepted.claimUrl ?? ''),
      online.origin,
    );
    const opened = page
      ? (io.open ?? ((u) => openInBrowser(u, io.env ?? process.env, o.platform)))(page)
      : false;
    if (page) {
      io.out(
        renderSent(
          { quotes: payload.quotes.length, seconds: (clock() - started) / 1000, page, opened },
          style,
        ).join('\n'),
      );
    }
    if (state.deepRead && accepted.deepReadToken) {
      await deepRead(online.api, accepted.deepReadToken, packetOnce(), { linked, keys, style, io });
    }
    return 0;
  } finally {
    if (io.keys === undefined) keys?.close();
  }
}

/** The deep read: waits for the claim (packet in memory only), sends it once, then drops it. */
async function deepRead(
  api: Api,
  token: string,
  packet: Packet,
  o: { linked: boolean; keys: KeyReader | null; style: Style; io: Io },
): Promise<void> {
  const { io, style } = o;
  const clock = io.clock ?? Date.now;
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = clock() + CLAIM_WAIT_MS;
  if (!o.linked) {
    let drawn = 0;
    let frame = 0;
    const draw = () => {
      const lines = renderClaimWait(deadline - clock(), frame++, style);
      io.out(
        style.color && drawn ? `${ESC}[${drawn}A${ESC}[J${lines.join('\n')}` : lines.join('\n'),
      );
      drawn = lines.length;
    };
    draw();
    let skip = false;
    const key = o.keys?.next().then((k) => {
      if (k === CTRL_C || k === ESCAPE || k === 'q') skip = true;
    });
    void key;
    for (;;) {
      if (skip) {
        io.out('Deep read skipped. Its prompts were dropped; your report stays.');
        return;
      }
      if (clock() >= deadline) {
        io.out(
          'Deep read skipped: the report was not claimed within 10 minutes. Its prompts were dropped.',
        );
        return;
      }
      const status = await api.deepReadStatus(token).catch(() => undefined);
      if (status?.bound) break;
      await sleep(CLAIM_POLL_MS);
      if (style.color) draw();
    }
  }
  // The route answers 429 when its readers are busy; the client retries until the token expires.
  for (;;) {
    try {
      await api.sendDeepRead(token, packet);
      io.out(
        `✓ Deep read sent: ${packet.prompts.length} prompts, read once by our model and then deleted.`,
      );
      return;
    } catch (error) {
      if (error instanceof ApiError && error.status === 429 && clock() < deadline) {
        await sleep(CLAIM_POLL_MS);
        continue;
      }
      io.out('The deep read did not go through. Its prompts were dropped; your report stays.');
      return;
    }
  }
}

async function agentRun(
  s: Scanned,
  o: {
    origin: Origin;
    online: Online | undefined;
    code: string | undefined;
    timeZone: string;
    platform: NodeJS.Platform;
    dir: string;
    root?: string;
  },
  io: Io,
): Promise<number> {
  // Quotes with links, paths, shell or wording aimed at agents never reach the agent.
  const safe: Report = { ...s.report, quotes: s.report.quotes.filter((q) => agentSafe(q.text)) };
  const hasPrompts = safe.metrics.userPrompts > 0;
  const deepReadPrompts =
    o.origin.isDefault && hasPrompts ? packetFor(s, '', o.code).prompts.length : 0;
  const blocked = !hasPrompts
    ? 'No prompts in this period, so there is nothing to upload.'
    : o.online?.paused
      ? 'Uploads are paused for a few minutes. Ask the user to try again later.'
      : o.online?.token
        ? undefined
        : (o.online?.blocked ?? 'Uploads are not available right now.');
  const command = `npx -y agentgpa@${VERSION} upload${o.code ? ` --code ${o.code}` : ''}`;
  const text = renderAgentRun({
    version: VERSION,
    report: safe,
    tools: s.tools,
    days: s.days,
    ...(o.online?.token?.account ? { who: o.online.token.account } : {}),
    quotes: quoteViews(safe, o.timeZone),
    deepReadPrompts,
    command,
    ...(blocked ? { blocked } : {}),
  });
  io.out(text.length > AGENT_OUTPUT_LIMIT ? text.slice(0, AGENT_OUTPUT_LIMIT) : text);
  if (blocked || !o.online?.token) return 0;
  const payload = payloadFor(s, {
    timeZone: o.timeZone,
    platform: o.platform,
    runMode: 'agent',
    origin: o.origin,
    consents: { researchAggregates: true, deepRead: false },
    runToken: o.online.token.runToken,
    report: safe,
  });
  writePending(o.dir, {
    createdAt: io.now ?? Date.now(),
    ...(o.code ? { code: o.code } : {}),
    payload,
    // The same place and period, so `upload --deep-read` reads exactly these sessions again.
    scan: {
      ...(o.root ? { root: o.root } : {}),
      tools: s.tools.map((t) => t.tool),
      days: s.days,
      end: s.end,
    },
  });
  return 0;
}

/** `agentgpa upload`: sends the payload that `--agent` showed, after the user said yes. */
export async function runUpload(options: UploadOptions, io: Io): Promise<number> {
  const env = io.env ?? process.env;
  if (options.code !== undefined && !LINK_CODE.test(options.code)) {
    io.err('--code takes the 8-character link code from /start, like K7Q3-PX9M.');
    return 2;
  }
  let origin: Origin;
  try {
    origin = apiOrigin(env, io.officialApi);
  } catch {
    io.err('AGENTGPA_API_URL must be an https:// origin (or http://localhost while developing).');
    return 2;
  }
  const dir = configDir(env);
  const config = loadConfig(dir);
  const now = io.now ?? Date.now();
  const pending = readPending(dir, options.code, now);
  if (!pending) {
    io.out(
      'No report is waiting to upload. Run the --agent command again: a waiting report expires after 30 minutes.',
    );
    return 1;
  }
  const count = pending.payload.quotes.length;
  const drop = (options.dropQuotes ?? '')
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= count);
  const wantsDeepRead = options.deepRead === true && origin.isDefault;
  const payload = PayloadSchema.parse({
    ...pending.payload,
    quotes: pending.payload.quotes.filter((_, i) => !drop.includes(i + 1)),
    consents: { researchAggregates: options.research !== false, deepRead: wantsDeepRead },
  });
  const { runToken } = payload;
  if (!runToken) {
    io.out(
      'This report has no run token, so it cannot be uploaded. Run the --agent command again.',
    );
    return 1;
  }
  const api = createApi(
    createNet(origin, io.fetch ?? fetch),
    io.sleep ? { sleep: io.sleep } : {},
    io.powWorkers,
  );
  let accepted: Awaited<ReturnType<Api['upload']>>;
  try {
    accepted = await api.upload(payload, runToken);
  } catch (error) {
    const why =
      error instanceof ApiError
        ? `the server answered ${error.status}`
        : 'the server could not be reached';
    io.out(`The upload did not go through: ${why}. Try the same command again in a few minutes.`);
    return 1;
  }
  removePending(dir, options.code);
  const kept = pending.payload.quotes.map((_, i) => i + 1).filter((n) => !drop.includes(n));
  const page = reportUrl(accepted.reportUrl ?? accepted.claimUrl ?? '', origin);
  const year = academicYearOf(pending.scan.end, pending.payload.client.tz);
  io.out(
    renderUploaded({
      version: VERSION,
      kept,
      deepRead: wantsDeepRead && accepted.deepReadToken !== undefined,
      research: payload.consents.researchAggregates,
      host: origin.host,
      year,
      linked: options.code !== undefined,
      ...(page ? { page } : {}),
    }),
  );
  if (wantsDeepRead && accepted.deepReadToken && options.code) {
    // The packet is built again in memory from the same period; it was never written.
    const scanned = await read(
      {
        ...(pending.scan.root ? { root: pending.scan.root } : {}),
        tools: pending.scan.tools,
        days: pending.scan.days,
        end: pending.scan.end,
        installId: config.installId,
        code: options.code,
        timeZone: pending.payload.client.tz,
      },
      io,
      env,
    );
    await deepRead(
      api,
      accepted.deepReadToken,
      packetFor(scanned, config.installId, options.code),
      {
        linked: true,
        keys: null,
        style: { color: false, truecolor: false },
        io,
      },
    );
  }
  return 0;
}

function academicYearOf(end: number, timeZone: string): string {
  const t = localClock(timeZone)(end);
  const start = t.month >= 8 ? t.year : t.year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}
