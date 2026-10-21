import { drawMasks, type QuoteKind } from '@agentgpa/core';
import { CTRL_C, ESCAPE, type KeyReader } from './keys.ts';
import { canvas, ESC, type Segment, type Style, WIDTH, wrap } from './terminal.ts';

// The consent screen: what would be sent, the quotes one by one, the deep read and research
// choices, and the one question. Nothing leaves without a yes here (or `--yes`, which still
// prints this screen). Quotes are the only prompt text it shows, already redacted, with swears
// drawn as bars.

export interface ConsentQuote {
  kind: QuoteKind;
  /** Redacted, swears masked as `[[bar:N]]`. */
  text: string;
  /** "23 times" or "Tue 02:14". */
  meta: string;
}

export interface ConsentView {
  sessions: number;
  secrets: number;
  quotes: ConsentQuote[];
  /** Prompts the deep read would read; 0 when it is not offered (another server). */
  deepReadPrompts: number;
  /** The server the upload goes to, as a host name. */
  host: string;
}

export interface ConsentState {
  /** Quote numbers (1 to 5) the user dropped. */
  dropped: Set<number>;
  deepRead: boolean;
  research: boolean;
}

export const KIND_NAMES: Record<QuoteKind, string> = {
  most_repeated: 'most repeated',
  caps_crisis: 'loudest',
  saltiest: 'saltiest',
  cryptic_candidate: 'cryptic',
};

const PAD = ' '.repeat(16);
const QUOTE_INDENT = 19;
const num = (n: number) => n.toLocaleString('en-US');

export function renderConsent(view: ConsentView, state: ConsentState, style: Style): string[] {
  const c = canvas(style);
  const out: string[] = [];
  const blank = () => out.push('');
  const said = (first: Segment, text: string) => {
    wrap(text, WIDTH - 2).forEach((part, i) => {
      out.push(
        c.line(
          i === 0
            ? [first, [part, '']]
            : [
                ['  ', ''],
                [part, ''],
              ],
        ),
      );
    });
  };

  out.push(
    c.spread(
      [
        ['AGENTGPA', 'accb'],
        [' · WHAT WOULD BE SENT', 'bold'],
      ],
      [['nothing sent yet', 'dim']],
    ),
  );
  out.push(c.hr());
  out.push(c.line([['ALWAYS SENT, TEXT-FREE', 'accb']]));
  said(
    ['✓ ', 'acc'],
    `An event log of ${num(view.sessions)} ${view.sessions === 1 ? 'session' : 'sessions'}: when each prompt, reply and tool call happened, its length, model and token count. No text, no paths, no project names.`,
  );
  said(
    ['✓ ', 'acc'],
    view.secrets > 0
      ? `Your counts and rates, and ${num(view.secrets)} ${view.secrets === 1 ? 'secret' : 'secrets'} as a count by type (never the value).`
      : 'Your counts and rates.',
  );
  blank();

  const n = view.quotes.length;
  out.push(
    c.spread(
      [['QUOTES FOR YOUR CARDS', 'accb']],
      n === 0 ? [] : [[n === 1 ? 'press 1 to drop it' : `press 1 to ${n} to drop one`, 'dim']],
    ),
  );
  if (n === 0) out.push(c.line([['None this time: nothing was safe to quote.', 'dim']]));
  view.quotes.forEach((q, i) => {
    const kind = KIND_NAMES[q.kind];
    const head: Segment[] = [
      [`[${i + 1}] `, 'dim'],
      [kind + ' '.repeat(Math.max(1, QUOTE_INDENT - 4 - kind.length)), 'dim'],
    ];
    if (state.dropped.has(i + 1)) {
      out.push(c.spread([...head, ['(dropped)', 'dim']], [[q.meta, 'dim']]));
      return;
    }
    const room = WIDTH - QUOTE_INDENT - q.meta.length - 1;
    const parts = wrap(`"${drawMasks(q.text)}"`, room);
    parts.forEach((part, j) => {
      if (j === 0) out.push(c.spread([...head, [part, 'bold']], [[q.meta, 'dim']]));
      else
        out.push(
          c.line([
            [' '.repeat(QUOTE_INDENT), ''],
            [part, 'bold'],
          ]),
        );
    });
  });
  blank();

  out.push(c.line([['OPTIONAL', 'accb']]));
  if (view.deepReadPrompts > 0) {
    const box: Segment = state.deepRead ? ['[x] ', 'acc'] : ['[ ] ', 'dim'];
    const text = `Our model reads ${num(view.deepReadPrompts)} of your typed prompts once (redacted, no code or tool output), writes a private chapter, then deletes them. We keep only the findings and habit labels.`;
    wrap(text, WIDTH - PAD.length).forEach((part, i) => {
      out.push(
        c.line(
          i === 0
            ? [box, ['Deep read   ', 'bold'], [part, '']]
            : [
                [PAD, ''],
                [part, ''],
              ],
        ),
      );
    });
    out.push(
      c.line([
        [PAD, ''],
        ['d', 'hi'],
        [state.deepRead ? ' turns it off · ' : ' turns it on · ', 'dim'],
        ['s', 'hi'],
        [' shows the exact prompts first', 'dim'],
      ]),
    );
  } else {
    out.push(
      c.line([
        ['[ ] ', 'dim'],
        ['Deep read   ', 'bold'],
        ['Off: it only ever goes to agentgpa.dev.', 'dim'],
      ]),
    );
  }
  out.push(
    c.line([
      state.research ? ['[x] ', 'acc'] : ['[ ] ', 'dim'],
      ['Research    ', 'bold'],
      ['Anonymous counts may join AgentGPA research.  ', ''],
      ['r', 'hi'],
      [state.research ? ' turns it off' : ' turns it on', 'dim'],
    ]),
  );
  blank();
  out.push(
    c.line([['Sessions from work may belong to your employer. Check your policy first.', 'dim']]),
  );
  out.push(c.hr());
  out.push(
    c.line([
      [`Upload to ${view.host}? `, 'bold'],
      ['y', 'hi'],
      [' yes · ', ''],
      ['n', 'hi'],
      [' no · ', ''],
      ...(n > 0
        ? ([
            [n === 1 ? '1' : `1-${n}`, 'hi'],
            [n === 1 ? ' drop the quote · ' : ' drop a quote · ', ''],
          ] as Segment[])
        : []),
      ['?', 'hi'],
      [' details ', ''],
      ['❯ ', 'acc'],
    ]),
  );
  return out;
}

/** What each field of the upload holds, for the `?` key. */
export function consentDetails(style: Style): string[] {
  const c = canvas(style);
  return [
    c.line([['WHAT THE UPLOAD HOLDS, AND NOTHING ELSE', 'accb']]),
    '  The period, which tools were found, sessions and prompts per tool, all-time',
    '  counts, your counts, rates and the hourly and daily series.',
    '  Secrets as counts by type, never a value, a part of one or its hash.',
    '  The event log: for each prompt, reply and tool call its minute, session,',
    '  length, model, tokens, kind and flags. No text, paths, file or project names.',
    "  The quotes you keep, your prompts' language, time zone, OS, a sample of",
    '  hashed message ids and how many sessions the file checks left out.',
    c.line([['  Full list: docs/payload.md in the AgentGPA CLI repository.', 'dim']]),
  ];
}

export interface AskOptions {
  view: ConsentView;
  initial: ConsentState;
  style: Style;
  keys: KeyReader;
  out: (text: string) => void;
  /** Prints the exact deep read packet (the `s` key). */
  showPacket?: () => Promise<void> | void;
  /** Redraws in place instead of printing the screen again. */
  redraw?: boolean;
}

/** Shows the screen and waits for a yes or a no; returns the choice and the toggles. */
export async function askConsent(o: AskOptions): Promise<{ upload: boolean; state: ConsentState }> {
  const state: ConsentState = { ...o.initial, dropped: new Set(o.initial.dropped) };
  let drawn = 0;
  const draw = () => {
    const lines = renderConsent(o.view, state, o.style);
    // Back up over the last screen and clear it, so toggles redraw in place.
    if (o.redraw && drawn) o.out(`${ESC}[${drawn}A${ESC}[J${lines.join('\n')}`);
    else o.out(lines.join('\n'));
    drawn = lines.length;
  };
  draw();
  for (;;) {
    const key = await o.keys.next();
    if (
      key === undefined ||
      key === CTRL_C ||
      key === ESCAPE ||
      key === 'n' ||
      key === 'N' ||
      key === 'q'
    ) {
      return { upload: false, state };
    }
    if (key === 'y' || key === 'Y') return { upload: true, state };
    const number = Number(key);
    if (Number.isInteger(number) && number >= 1 && number <= o.view.quotes.length) {
      if (state.dropped.has(number)) state.dropped.delete(number);
      else state.dropped.add(number);
    } else if (key === 'd' && o.view.deepReadPrompts > 0) state.deepRead = !state.deepRead;
    else if (key === 'r') state.research = !state.research;
    else if (key === 's' && o.view.deepReadPrompts > 0 && o.showPacket) {
      await o.showPacket();
      drawn = 0;
    } else if (key === '?') {
      o.out(consentDetails(o.style).join('\n'));
      drawn = 0;
    } else continue;
    draw();
  }
}
