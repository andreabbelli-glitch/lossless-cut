import { describe, expect, it } from 'vitest';

import { parseFiniteNumber, parseOutputPlaybackRate } from './input';

describe('time input validation', () => {
  it('rejects non-finite, partial and empty values without coercing them to zero', () => {
    for (const text of ['', ' ', 'NaN', 'Infinity', '-Infinity', '1foo', '1,5', '1.2.3']) expect(parseFiniteNumber(text)).toBeUndefined();
    expect(parseFiniteNumber(' 1.25 ')).toBe(1.25);
    expect(parseFiniteNumber('-2.5')).toBe(-2.5);
    expect(parseFiniteNumber('1e-6')).toBe(0.000001);
    expect(parseFiniteNumber('1.5', true)).toBeUndefined();
    expect(parseFiniteNumber('25frames', true)).toBeUndefined();
    expect(parseFiniteNumber('25', true)).toBe(25);
  });
});

describe('export FPS input', () => {
  it('preserves decimal, ratio and empty-default inputs', () => {
    expect(parseOutputPlaybackRate('50', 25)).toBe(2);
    expect(parseOutputPlaybackRate('30000/1001', 30)).toBeCloseTo(1000 / 1001);
    expect(parseOutputPlaybackRate('', 25)).toBe(1);
    expect(parseOutputPlaybackRate('  ', 25)).toBe(1);
    expect(parseOutputPlaybackRate('25', undefined)).toBe(25);
  });

  it('rejects invalid speeds, ratios, overflow and partial tokens', () => {
    for (const text of ['0', '-1', 'Infinity', '1e999', '25fps', '25/0', '0/25', '-1/-1', '25/1x', '25/1/2', '/25']) {
      expect(parseOutputPlaybackRate(text, 25)).toBeUndefined();
    }
  });
});
