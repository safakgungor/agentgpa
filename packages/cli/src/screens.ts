import { cleanText } from '@agentgpa/core';
import { canvas, type Style } from './terminal.ts';

// The short terminal screens around the upload: uploads paused, what was sent, and the deep
// read waiting for the claim.

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

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
    c.row([['Your report card still works here, offline. Nothing will be sent.', '']]),
    c.rule('╰', '╯'),
  ];
}

export function pausedFooter(style: Style): string[] {
  const c = canvas(style);
  return [
    c.line([
      ['Nothing has left this machine. Run ', ''],
      ['npx agentgpa', 'bold'],
      [' again in a few minutes', ''],
    ]),
    c.line([['for your rank and the full drop.', '']]),
  ];
}

export function renderSent(
  o: { quotes: number; seconds: number; page: URL; opened: boolean },
  style: Style,
): string[] {
  const c = canvas(style);
  const shown = `${o.page.host}${o.page.pathname}`;
  return [
    c.line([
      ['✓ ', 'acc'],
      [
        `Sent: a text-free event log, your counts and ${o.quotes} ${o.quotes === 1 ? 'quote' : 'quotes'}.`,
        '',
      ],
      [`   ${o.seconds.toFixed(1)} s`, 'dim'],
    ]),
    c.line([
      ['✓ ', 'acc'],
      ['Your report: ', ''],
      [shown, 'bold'],
      [o.opened ? ' (opened in your browser)' : ' (open it in your browser)', 'dim'],
    ]),
  ];
}

export function renderClaimWait(leftMs: number, frame: number, style: Style): string[] {
  const c = canvas(style);
  const seconds = Math.max(0, Math.ceil(leftMs / 1000));
  const left = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} LEFT`;
  return [
    c.rule('╭', '╮'),
    c.row(
      [
        ['DEEP READ', 'accb'],
        [' · WAITING FOR YOUR CLAIM', 'bold'],
      ],
      [[left, 'dim']],
    ),
    c.rule('├', '┤'),
    c.row(),
    c.row([['Claim your report on the page that just opened. The deep read starts', '']]),
    c.row([['right after; until then its prompts stay in memory, never on disk.', '']]),
    c.row(),
    c.row([
      [`${SPINNER[frame % SPINNER.length]} `, 'acc'],
      ['waiting for your claim', 'bold'],
    ]),
    c.row(),
    c.rule('╰', '╯'),
    c.line([
      ['Ctrl+C', 'hi'],
      [' skips the deep read. Your report stays either way.', ''],
    ]),
  ];
}

/** The opt-in usage counts, asked once on the first interactive run the server takes them for. */
export function renderTelemetryQuestion(style: Style): string[] {
  const c = canvas(style);
  return [
    c.rule('╭', '╮'),
    c.row([['ONE QUESTION, ASKED ONCE', 'accb']], [['usage counts', 'dim']]),
    c.rule('├', '┤'),
    c.row([['May the CLI count which of its steps you use?', 'bold']]),
    c.row([['Event names and counts only, like "showed the report card".', '']]),
    c.row([['Never your sessions, code, paths or prompts, and never offline.', '']]),
    c.rule('╰', '╯'),
    c.line([
      ['[y] yes   ', 'bold'],
      ['[n] no, the default', ''],
    ]),
  ];
}
