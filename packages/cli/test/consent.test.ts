import { describe, expect, it } from 'vitest';
import { askConsent, type ConsentView, consentDetails, renderConsent } from '../src/consent.ts';
import { CTRL_C, scriptedKeys } from '../src/keys.ts';
import { ESC, type Style, WIDTH } from '../src/terminal.ts';

const plain: Style = { color: false, truecolor: false };
const truecolor: Style = { color: true, truecolor: true };
const strip = (t: string) => t.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');

const view: ConsentView = {
  sessions: 1214,
  secrets: 1,
  quotes: [
    { kind: 'most_repeated', text: 'fix the tests', meta: '23 times' },
    { kind: 'caps_crisis', text: 'WHY IS THE BUILD STILL RED', meta: 'Tue 02:14' },
    { kind: 'saltiest', text: '[[bar:7]] DO IT', meta: 'Sun 23:41' },
    { kind: 'cryptic_candidate', text: 'do the thing but not like that one', meta: 'Wed 01:47' },
    {
      kind: 'cryptic_candidate',
      text: 'ok now the other one, the one we talked about before lunch, and then the one after that too',
      meta: 'Thu 03:02',
    },
  ],
  deepReadPrompts: 600,
  host: 'agentgpa.dev',
};
const fresh = { dropped: new Set<number>(), deepRead: false, research: true };

describe('the consent screen', () => {
  it('never goes past 80 columns, with or without color', () => {
    for (const style of [plain, truecolor]) {
      for (const line of renderConsent(view, fresh, style)) {
        expect(strip(line).length, strip(line)).toBeLessThanOrEqual(WIDTH);
      }
    }
    for (const line of consentDetails(plain)) expect(line.length).toBeLessThanOrEqual(WIDTH);
  });

  it('lists what is always sent, every quote, both choices and the question', () => {
    const out = renderConsent(view, fresh, plain).join('\n');
    expect(out).toContain('AGENTGPA · WHAT WOULD BE SENT');
    expect(out).toContain('An event log of 1,214 sessions');
    expect(out).toContain('1 secret as a count by type (never the value)');
    expect(out).toContain('[1] most repeated  "fix the tests"');
    expect(out).toContain('[2] loudest        "WHY IS THE BUILD STILL RED"');
    expect(out).toContain(`[3] saltiest       "${String.fromCodePoint(0x2588).repeat(7)} DO IT"`);
    expect(out).toContain('the one we talked about');
    expect(out).toContain('[ ] Deep read   Our model reads 600 of your typed prompts');
    expect(out).toContain('[x] Research');
    expect(out).toContain('Sessions from work may belong to your employer.');
    expect(out).toContain(
      'Upload to agentgpa.dev? [y] yes · [n] no · [1-5] drop a quote · [?] details',
    );
    expect(out).not.toContain('[[bar:');
  });

  it('marks dropped quotes and turned-on choices', () => {
    const out = renderConsent(
      view,
      { dropped: new Set([3]), deepRead: true, research: false },
      plain,
    ).join('\n');
    expect(out).toMatch(/\[3\] saltiest\s+\(dropped\)/);
    expect(out).toContain('[x] Deep read');
    expect(out).toContain('[d] turns it off');
    expect(out).toContain('[ ] Research');
  });

  it('offers no deep read for another server, and says when there is nothing to quote', () => {
    const out = renderConsent({ ...view, quotes: [], deepReadPrompts: 0 }, fresh, plain).join('\n');
    expect(out).toContain('Off: it only ever goes to agentgpa.dev.');
    expect(out).toContain('None this time: nothing was safe to quote.');
    expect(out).not.toContain('drop a quote');
  });
});

describe('the consent keys', () => {
  const ask = (keys: string[], extra = {}) => {
    const printed: string[] = [];
    return askConsent({
      view,
      initial: fresh,
      style: plain,
      keys: scriptedKeys(keys),
      out: (t) => printed.push(t),
      ...extra,
    }).then((r) => ({ ...r, printed }));
  };

  it('drops quotes, turns the deep read on and research off, then says yes', async () => {
    const r = await ask(['2', '4', '4', 'd', 'r', 'x', 'y']);
    expect(r.upload).toBe(true);
    expect([...r.state.dropped]).toEqual([2]);
    expect(r.state.deepRead).toBe(true);
    expect(r.state.research).toBe(false);
  });

  it('sends nothing on n, Escape, Ctrl+C or the end of input', async () => {
    for (const keys of [['n'], ['\u001b'], [CTRL_C], []])
      expect((await ask(keys)).upload).toBe(false);
  });

  it('shows the packet on s and the field list on ?, then the screen again', async () => {
    let shown = 0;
    const r = await ask(['s', '?', 'y'], { showPacket: () => void shown++ });
    expect(shown).toBe(1);
    expect(r.printed.some((t) => t.includes('WHAT THE UPLOAD HOLDS'))).toBe(true);
    expect(r.printed.filter((t) => t.includes('WHAT WOULD BE SENT'))).toHaveLength(3);
  });
});
