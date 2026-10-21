// Every string taken from a transcript is cleaned before it is printed or sent: control
// characters, ANSI escape sequences, bidi overrides and isolates, and zero-width characters
// are removed, so text cannot move the terminal cursor or disguise itself.
// The patterns are built from code points, so the source holds no invisible characters and
// no tool can rewrite them into some.

const u = (code: number): string => `\\u${code.toString(16).padStart(4, '0')}`;
const range = (from: number, to: number): string => `${u(from)}-${u(to)}`;

const ESC = u(0x1b);
const BEL = u(0x07);
const CSI = u(0x9b);

const ANSI = new RegExp(
  [
    `${ESC}\\[[0-?]*[ -/]*[@-~]`,
    `${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`,
    `${ESC}[@-Z\\\\-_]`,
    `${CSI}[0-?]*[ -/]*[@-~]`,
  ].join('|'),
  'g',
);
const CONTROL = new RegExp(
  `[${range(0x00, 0x08)}${u(0x0b)}${u(0x0c)}${range(0x0e, 0x1f)}${range(0x7f, 0x9f)}]`,
  'g',
);
const INVISIBLE = new RegExp(
  `[${range(0x200b, 0x200f)}${range(0x202a, 0x202e)}${range(0x2060, 0x2064)}${range(0x2066, 0x2069)}${u(0x061c)}${u(0xfeff)}]`,
  'g',
);

/** Removes escape sequences, control, bidi and zero-width characters. Keeps tabs and newlines. */
export function cleanText(text: string): string {
  return text.replace(ANSI, '').replace(CONTROL, '').replace(INVISIBLE, '');
}

/** A model name, a version or a fixed kind: letters, digits and a few marks, at most 64. */
export const LABEL = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,63}$/;

/**
 * A structural string from a transcript (a model name, a version, a mode) that is safe to
 * keep and print, or undefined when it does not look like one.
 */
export function safeLabel(value: unknown): string | undefined {
  return typeof value === 'string' && LABEL.test(value) ? value : undefined;
}
