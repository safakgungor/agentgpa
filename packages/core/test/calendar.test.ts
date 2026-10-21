import { describe, expect, it } from 'vitest';
import { academicYear, costOf, daysBetween, localClock, priceOf, term } from '../src/index.ts';

function reference(ts: number, timeZone: string) {
  const parts: Record<string, string> = {};
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  for (const p of fmt.formatToParts(new Date(ts))) parts[p.type] = p.value;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

describe('localClock', () => {
  it('agrees with Intl at every minute around DST changes and odd offsets', () => {
    const zones = [
      'Europe/Istanbul',
      'America/New_York',
      'Asia/Kolkata',
      'Australia/Lord_Howe',
      'Pacific/Chatham',
      'UTC',
    ];
    const starts = [
      Date.UTC(2026, 2, 8, 5),
      Date.UTC(2026, 10, 1, 4),
      Date.UTC(2026, 3, 4, 14),
      Date.UTC(2026, 9, 3, 14),
    ];
    for (const zone of zones) {
      const clock = localClock(zone);
      for (const start of starts) {
        for (let m = 0; m < 180; m += 7) {
          const ts = start + m * 60_000 + 13_000;
          const got = clock(ts);
          expect(
            { date: got.date, hour: got.hour, minute: got.minute },
            `${zone} ${new Date(ts).toISOString()}`,
          ).toEqual(reference(ts, zone));
        }
      }
    }
  });

  it('falls back to UTC for an unknown zone', () => {
    expect(localClock('Mars/Olympus')(Date.UTC(2027, 0, 1, 3, 4)).hour).toBe(3);
  });
});

describe('academic years and terms', () => {
  it('starts the board year on Aug 1', () => {
    expect(academicYear({ year: 2026, month: 7 })).toBe('2025-26');
    expect(academicYear({ year: 2026, month: 8 })).toBe('2026-27');
    expect(academicYear({ year: 2027, month: 1 })).toBe('2026-27');
  });

  it('runs Fall from Aug 1 to Jan 31 and Spring from Feb 1 to Jul 31', () => {
    expect(term({ year: 2026, month: 8 }).label).toBe("FALL '26");
    expect(term({ year: 2027, month: 1 }).label).toBe("FALL '26");
    expect(term({ year: 2027, month: 2 }).label).toBe("SPRING '27");
    expect(term({ year: 2027, month: 7 }).label).toBe("SPRING '27");
  });

  it('counts days between dates', () => {
    expect(daysBetween('2027-02-27', '2027-03-01')).toBe(2);
  });
});

describe('list prices', () => {
  it('matches model ids by their family and leaves unknown models out', () => {
    expect(priceOf('claude-opus-4-5-20251101')).toEqual(priceOf('claude-opus-4-5'));
    expect(priceOf('claude-opus-4-20250514')?.input).toBe(15);
    expect(priceOf('claude-opus-5-5')?.input).toBe(4);
    expect(priceOf('claude-opus-5')?.input).toBe(5);
    expect(priceOf('claude-haiku-4-5-20251001')?.output).toBe(5);
    expect(priceOf('gpt-5.6-sol')?.input).toBe(4);
    expect(priceOf('gpt-5.6-sol-preview')).toBeUndefined();
    expect(priceOf('grok-4.6')).toBeUndefined();
    expect(priceOf('constructor')).toBeUndefined();
  });

  it('prices a call', () => {
    expect(
      costOf('claude-opus-5-5', {
        input: 1_000_000,
        output: 100_000,
        cacheRead: 2_000_000,
        cacheWrite: 400_000,
      }),
    ).toBeCloseTo(4 + 2 + 0.4 + 2);
    expect(
      costOf('unknown-model', { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 }),
    ).toBeUndefined();
  });
});
