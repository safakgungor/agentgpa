import { cleanText, type RunConsents, type Tool } from '@agentgpa/core';
import { canvas, type Style } from './terminal.ts';

// The terminal screens of a run. None of them shows a result: grades, quotes and findings are
// only on the website. Without a code the CLI points to /start and reads nothing; with one it
// says what it read and sent, and where the report is.

const TOOL_NAMES: Record<Tool, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
};

/** "Found Claude Code and Codex · Cursor not found", and readable tools only count as found. */
export function foundLine(tools: readonly { tool: Tool; found: boolean; readable: boolean }[]) {
  const names = (list: typeof tools) => list.map((t) => TOOL_NAMES[t.tool]);
  const and = (list: string[]) =>
    list.length <= 1 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
  const found = names(tools.filter((t) => t.found && t.readable));
  const unreadable = names(tools.filter((t) => t.found && !t.readable));
  const missing = names(tools.filter((t) => !t.found));
  return [
    found.length ? `Found ${and(found)}` : 'Found no agent sessions',
    ...(unreadable.length ? [`${and(unreadable)} not readable`] : []),
    ...(missing.length ? [`${and(missing)} not found`] : []),
  ].join(' · ');
}

const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** The service note, as the box shows it: cleaned and short. */
const note = (message: string | undefined) =>
  cleanText(message ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 74);

export function renderPaused(message: string | undefined, host: string, style: Style): string[] {
  const c = canvas(style);
  return [
    c.rule('╭', '╮'),
    c.row([['UPLOADS PAUSED', 'accb']], [[`message from ${host}`, 'dim']]),
    c.rule('├', '┤'),
    c.row([[note(message) || 'Uploads are paused for a few minutes.', 'bold']]),
    c.row([['Nothing was read or sent. Run the same command again in a few minutes.', '']]),
    c.rule('╰', '╯'),
  ];
}

/** `npx agentgpa` without a code: the way in is the website, and nothing was read. */
export function renderStartOnWebsite(host: string, style: Style): string[] {
  const c = canvas(style);
  return [
    c.rule('╭', '╮'),
    c.row([['START ON THE WEBSITE', 'accb']], [['NOTHING WAS READ', 'dim']]),
    c.rule('├', '┤'),
    c.row(),
    c.row([
      ['1. ', 'bold'],
      ['Open ', ''],
      [`${host}/start`, 'hi'],
      [' and sign in with GitHub.', ''],
    ]),
    c.row([
      ['2. ', 'bold'],
      ['Say yes once: what is read, what is sent, the terms.', ''],
    ]),
    c.row([
      ['3. ', 'bold'],
      ['Copy your command and run it right here.', ''],
    ]),
    c.row(),
    c.row([[`Your grades live on ${host}, never in this terminal.`, 'dim']]),
    c.row(),
    c.rule('╰', '╯'),
  ];
}

/** Why a code did not open a run, and what to do about it. */
export function codeRefusal(status: number, host: string): string {
  if (status === 409) return `That code was used already. Open ${host}/start for a new one.`;
  if (status === 410)
    return `That code expired after 60 minutes. Open ${host}/start for a new one.`;
  return `That code is not one we know. Open ${host}/start for a new one.`;
}

export interface RunDone {
  version: string;
  handle?: string | undefined;
  tools: readonly { tool: Tool; found: boolean; readable: boolean }[];
  sessions: number;
  /** The period read, in days (--since). */
  days: number;
  readSeconds: number;
  sentSeconds: number;
  quotes: number;
  consents: RunConsents;
  deepReadSent: boolean;
  page: URL;
  opened: boolean;
}

/** A run with a code, once it was sent: what was read and sent, and where the report is. */
export function renderRunDone(o: RunDone, style: Style): string[] {
  const c = canvas(style);
  const shown = `${o.page.host}${o.page.pathname}`;
  return [
    c.line([[`AGENTGPA ${o.version}${o.handle ? ` · LINKED TO @${o.handle}` : ''}`, 'dim']]),
    c.line([
      ['✓ ', 'acc'],
      [foundLine(o.tools), ''],
    ]),
    c.line([
      ['✓ ', 'acc'],
      [`Read ${plural(o.sessions, 'session', 'sessions')} from the last ${o.days} days`, ''],
      [`   ${o.readSeconds.toFixed(1)} s`, 'dim'],
    ]),
    c.line([
      ['✓ ', 'acc'],
      [`Sent what you said yes to on ${o.page.host}/start`, ''],
      [`   ${o.sentSeconds.toFixed(1)} s`, 'dim'],
    ]),
    c.line([
      [
        `  a text-free event log, your counts and ${plural(o.quotes, 'private quote candidate', 'private quote candidates')}`,
        'dim',
      ],
    ]),
    c.line([
      [
        `  research ${o.consents.researchAggregates ? 'on' : 'off'} · deep read ${o.consents.deepRead ? (o.deepReadSent ? 'sent, read once and dropped' : 'not sent') : 'off'}`,
        'dim',
      ],
    ]),
    '',
    c.rule('╭', '╮'),
    c.row([['YOUR REPORT IS READY', 'accb']], [['ONE CLICK LEFT', 'dim']]),
    c.rule('├', '┤'),
    c.row(),
    c.row([
      [shown, 'hi'],
      [o.opened ? '  opened in your browser' : '  open it in your browser', 'dim'],
    ]),
    c.row(),
    c.row([['Your grades, your cards and what we found are there, not here.', '']]),
    c.row([['Confirm the run with one click to make it yours.', '']]),
    c.row(),
    c.rule('╰', '╯'),
    c.line([['Nothing else left this machine.', '']]),
  ];
}

/** `--offline`: what was found and what a run would send, with no network call. */
export function renderOffline(
  o: {
    version: string;
    tools: RunDone['tools'];
    sessions: number;
    days: number;
    readSeconds: number;
    quotes: number;
  },
  style: Style,
): string[] {
  const c = canvas(style);
  return [
    c.line([[`AGENTGPA ${o.version} · OFFLINE · NOTHING WAS SENT`, 'dim']]),
    c.line([
      ['✓ ', 'acc'],
      [foundLine(o.tools), ''],
    ]),
    c.line([
      ['✓ ', 'acc'],
      [`Read ${plural(o.sessions, 'session', 'sessions')} from the last ${o.days} days`, ''],
      [`   ${o.readSeconds.toFixed(1)} s`, 'dim'],
    ]),
    c.line([
      [
        `  A run would send a text-free event log, your counts and ${plural(o.quotes, 'quote candidate', 'quote candidates')}.`,
        '',
      ],
    ]),
    c.line([
      ['  Run with ', ''],
      ['--dry-run', 'bold'],
      [' to write exactly that to agentgpa-payload.json.', ''],
    ]),
  ];
}
