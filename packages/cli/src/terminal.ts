// Drawing for the terminal screens: lines of styled segments, never wider than 80 columns, one
// accent color, and readable without color, where highlights become [brackets] and labels end
// in a colon. Transcript text never reaches these helpers.

export const WIDTH = 80;
export const INNER = WIDTH - 4;

export interface Style {
  color: boolean;
  truecolor: boolean;
}

export type Kind = '' | 'dim' | 'bold' | 'acc' | 'accb' | 'hi' | 'inv';
export type Segment = [string, Kind];

/** Color support from the environment: NO_COLOR, FORCE_COLOR, TERM and COLORTERM. */
export function detectStyle(env: Record<string, string | undefined>, isTTY: boolean): Style {
  const forced = env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0';
  const off =
    (env.NO_COLOR !== undefined && env.NO_COLOR !== '') ||
    env.FORCE_COLOR === '0' ||
    env.TERM === 'dumb';
  const color = !off && (isTTY || forced);
  return { color, truecolor: color && /^(?:truecolor|24bit)$/i.test(env.COLORTERM ?? '') };
}

export const ESC = String.fromCharCode(0x1b);
const sgr = (codes: string) => `${ESC}[${codes}m`;
const RESET = sgr('0');

/** The yellow of the default highlighter, for screens without an archetype. */
export const DEFAULT_ACCENT = '#e4ff3a';

function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function paint(style: Style, accent: string): (s: Segment) => string {
  if (!style.color) {
    return ([text, kind]) =>
      kind === 'hi' ? `[${text.trim()}]` : kind === 'inv' ? `${text.trim()}:` : text;
  }
  const [r, g, b] = rgb(accent);
  const fg = style.truecolor ? `38;2;${r};${g};${b}` : '93';
  const bg = style.truecolor ? `48;2;${r};${g};${b};38;2;17;17;17` : '103;30';
  const codes: Record<Kind, string> = {
    '': '',
    dim: style.truecolor ? '38;2;140;140;140' : '90',
    bold: '1',
    acc: fg,
    accb: `1;${fg}`,
    hi: `1;${bg}`,
    inv: style.truecolor ? '1;48;2;241;239;234;38;2;20;20;20' : '1;107;30',
  };
  return ([text, kind]) => (codes[kind] ? `${sgr(codes[kind])}${text}${RESET}` : text);
}

/** The width a segment takes once painted (brackets and labels when there is no color). */
export function shown(style: Style, [text, kind]: Segment): number {
  if (!style.color && kind === 'hi') return text.trim().length + 2;
  if (!style.color && kind === 'inv') return text.trim().length + 1;
  return text.length;
}

export interface Canvas {
  /** Segments painted into one line. */
  line: (segments: Segment[]) => string;
  width: (segments: Segment[]) => number;
  /** Segments cut to a width, the last one ending in "...". */
  fit: (segments: Segment[], room: number) => Segment[];
  /** A full-width line: left segments, then right ones pushed to the 80th column. */
  spread: (left: Segment[], right?: Segment[]) => string;
  /** A row inside a box. */
  row: (left?: Segment[], right?: Segment[]) => string;
  /** A box edge or divider, from its two corner characters. */
  rule: (a: string, b: string) => string;
  /** A line across the screen. */
  hr: () => string;
}

export function canvas(style: Style, accent = DEFAULT_ACCENT): Canvas {
  const paintSegment = paint(style, accent);
  const line = (segments: Segment[]) => segments.map(paintSegment).join('');
  const width = (segments: Segment[]) => segments.reduce((n, s) => n + shown(style, s), 0);
  const fit = (segments: Segment[], room: number): Segment[] => {
    const out: Segment[] = [];
    let used = 0;
    for (const s of segments) {
      const w = shown(style, s);
      if (used + w <= room) {
        out.push(s);
        used += w;
      } else {
        out.push([`${s[0].slice(0, Math.max(0, room - used - 3))}...`, s[1]]);
        break;
      }
    }
    return out;
  };
  const spread = (left: Segment[], right: Segment[] = []): string => {
    const l = fit(left, WIDTH - width(right) - (right.length ? 1 : 0));
    if (!right.length) return line(l);
    const gap = Math.max(1, WIDTH - width(l) - width(right));
    return line([...l, [' '.repeat(gap), ''], ...right]);
  };
  const row = (left: Segment[] = [], right: Segment[] = []): string => {
    const l = fit(left, INNER - width(right) - (right.length ? 1 : 0));
    const gap = Math.max(right.length ? 1 : 0, INNER - width(l) - width(right));
    return line([['│ ', 'dim'], ...l, [' '.repeat(gap), ''], ...right, [' │', 'dim']]);
  };
  const rule = (a: string, b: string) => line([[`${a}${'─'.repeat(WIDTH - 2)}${b}`, 'dim']]);
  const hr = () => line([['─'.repeat(WIDTH), 'dim']]);
  return { line, width, fit, spread, row, rule, hr };
}

/**
 * Progress on stderr: in a terminal one line rewrites itself and is cleared before the
 * result is printed; anywhere else, an agent or a pipe, each step is a plain line of its own.
 */
export function progressLine(
  stream: { isTTY?: boolean; write: (text: string) => unknown },
  env: Record<string, string | undefined>,
): (text: string | null) => void {
  const live = stream.isTTY === true && env.TERM !== 'dumb';
  let showing = false;
  return (text) => {
    if (!live) {
      if (text !== null) stream.write(`${text}\n`);
      return;
    }
    if (text === null && !showing) return;
    stream.write(`\r${ESC}[2K${text ?? ''}`);
    showing = text !== null;
  };
}

/** Words of a text in lines of at most `room` columns. */
export function wrap(text: string, room: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(' ')) {
    if (current && current.length + 1 + word.length > room) {
      lines.push(current);
      current = '';
    }
    current = current ? `${current} ${word}` : word;
    while (current.length > room) {
      lines.push(current.slice(0, room));
      current = current.slice(room);
    }
  }
  if (current) lines.push(current);
  return lines;
}
