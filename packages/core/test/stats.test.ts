import { describe, expect, it } from 'vitest';
import { maxOf, median, percentile, share } from '../src/index.ts';

describe('stats', () => {
  it('finds the largest value of a very long list without throwing', () => {
    const values = Array.from({ length: 500_000 }, (_, i) => i % 1000);
    expect(maxOf(values)).toBe(999);
    expect(maxOf([])).toBe(0);
    expect(maxOf([-3, -1, -2])).toBe(-1);
  });

  it('takes medians, nearest-rank percentiles and safe shares', () => {
    expect([median([]), median([3, 1, 2]), median([4, 1, 3, 2])]).toEqual([0, 2, 2.5]);
    expect([percentile([0, 1, 2, 3], 0.9), percentile([5], 0.5), percentile([], 0.9)]).toEqual([
      3, 5, 0,
    ]);
    expect([share(1, 4), share(1, 0)]).toEqual([0.25, 0]);
  });
});
