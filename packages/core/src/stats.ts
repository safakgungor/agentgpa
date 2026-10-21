// Small statistics over plain arrays. Loops, not spread arguments: the server runs these on
// skeletons it did not build, and `Math.max(...values)` throws on very long arrays.

export const share = (part: number, whole: number): number => (whole > 0 ? part / whole : 0);

/** The largest value, or 0 for an empty list. */
export function maxOf(values: readonly number[]): number {
  let max = 0;
  let seen = false;
  for (const v of values) {
    if (!seen || v > max) max = v;
    seen = true;
  }
  return max;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** The value at or below which a share p of the values fall (nearest rank). */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] as number;
}
