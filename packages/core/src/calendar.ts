// Local time, academic years and terms. Metrics read hours and dates in the machine's time
// zone (an IANA name), which the payload carries so the server computes the same hours.

export interface LocalTime {
  year: number;
  /** 1 to 12. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 is Sunday. */
  weekday: number;
  /** `YYYY-MM-DD`. */
  date: string;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const SLOT = 15 * 60_000;

function formatter(timeZone: string): Intl.DateTimeFormat {
  const options: Intl.DateTimeFormatOptions = {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  };
  try {
    return new Intl.DateTimeFormat('en-US', options);
  } catch {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' });
  }
}

/**
 * A fast converter to local time. Offsets only change at quarter hours, so each 15-minute UTC
 * slot is formatted once and the minutes inside it are added.
 */
export function localClock(timeZone: string): (ts: number) => LocalTime {
  const fmt = formatter(timeZone);
  const slots = new Map<number, LocalTime>();
  return (ts: number) => {
    const slot = Math.floor(ts / SLOT) * SLOT;
    let base = slots.get(slot);
    if (!base) {
      const parts: Record<string, string> = {};
      for (const p of fmt.formatToParts(new Date(slot))) parts[p.type] = p.value;
      const year = Number(parts.year);
      const month = Number(parts.month);
      const day = Number(parts.day);
      base = {
        year,
        month,
        day,
        hour: Number(parts.hour),
        minute: Number(parts.minute),
        weekday: WEEKDAYS[parts.weekday ?? 'Sun'] ?? 0,
        date: `${parts.year}-${parts.month}-${parts.day}`,
      };
      slots.set(slot, base);
    }
    const extra = Math.floor((ts - slot) / 60_000);
    return extra === 0 ? base : { ...base, minute: base.minute + extra };
  };
}

/** Days between two `YYYY-MM-DD` dates. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** The board year a date falls in: Aug 1 to Jul 31, written `2026-27`. */
export function academicYear(local: Pick<LocalTime, 'year' | 'month'>): string {
  const start = local.month >= 8 ? local.year : local.year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** The term: Fall from Aug 1 to Jan 31, Spring from Feb 1 to Jul 31, labelled `FALL '26`. */
export function term(local: Pick<LocalTime, 'year' | 'month'>): {
  season: 'Fall' | 'Spring';
  year: number;
  label: string;
} {
  const fall = local.month >= 8 || local.month === 1;
  const year = local.month === 1 ? local.year - 1 : local.year;
  const season = fall ? 'Fall' : 'Spring';
  return { season, year, label: `${season.toUpperCase()} '${String(year % 100).padStart(2, '0')}` };
}
