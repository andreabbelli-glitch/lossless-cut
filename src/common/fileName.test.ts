// eslint-disable-next-line import/no-extraneous-dependencies
import { expect, test } from 'vitest';

import { sanitizeFileName, truncateLabel } from './fileName.js';
import { truncateFileName } from './util.js';

test('sanitization preserves combining scripts and normalizes decomposed accents', () => {
  expect(sanitizeFileName('Cafe\u0301 नमस्ते ไทย')).toBe('Café नमस्ते ไทย');
  expect(sanitizeFileName('👩🏽‍💻 🇮🇹 A:B/C')).toBe('👩🏽‍💻 🇮🇹 A_B_C');
});

test('label truncation never splits emoji, combining marks or joined families', () => {
  expect(truncateLabel('a👩🏽‍💻b', 5)).toBe('a');
  expect(truncateLabel('a👩🏽‍💻b', 8)).toBe('a👩🏽‍💻');
  expect(truncateLabel('e\u0301x', 1)).toBe('');
  expect(truncateLabel('e\u0301x', 2)).toBe('e\u0301');
});

test('whole filename truncation retains complete graphemes within filesystem limits', () => {
  const family = '👩‍👩‍👧‍👦';
  const result = truncateFileName(`${family.repeat(20)}-tail.mp4`, 50, true);
  expect(result.length).toBeLessThanOrEqual(50);
  expect(result.endsWith('-tail.mp4')).toBe(true);
  expect(result.replaceAll(family, '').replaceAll('…', '')).toBe('-tail.mp4');
});
