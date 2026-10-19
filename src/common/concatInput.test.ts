// eslint-disable-next-line import/no-extraneous-dependencies
import { expect, test } from 'vitest';
import { buildConcatInput } from './concatInput.js';

test('only supplied common-clock certificates override container durations', () => {
  expect(buildConcatInput(['C:/first.mp4', 'C:/second.mp4'], [8, 8])).toBe("file 'file:C:/first.mp4'\nduration 8.000000\nfile 'file:C:/second.mp4'\nduration 8.000000");
  expect(buildConcatInput(['C:/first.mp4'])).toBe("file 'file:C:/first.mp4'");
  expect(buildConcatInput(['C:/micro.mp4'], [0.000001])).toContain('duration 0.000001');
});

test('invalid certificates fail before constructing a misleading concat timeline', () => {
  for (const durations of [[], [0], [-1], [Infinity], [NaN], [0.0000001], [8, 8]]) expect(() => buildConcatInput(['C:/part.mp4'], durations)).toThrow('Certified concat spans');
});

test('file quoting cannot introduce extra concat directives', () => {
  expect(buildConcatInput(["C:/Andrea's video.mp4"])).toBe(String.raw`file 'file:C:/Andrea'\''s video.mp4'`);
  expect(() => buildConcatInput(['C:/part.mp4\nduration 9'])).toThrow('line breaks');
});

test('quantizes cumulative common-clock boundaries without accumulating join drift', () => {
  const span = 8 / 375;
  const count = 1000;
  const input = buildConcatInput(Array.from({ length: count }, (_, index) => `C:/${index}.mp4`), Array.from({ length: count }, () => span));
  const durations = input.split('\n').filter((line) => line.startsWith('duration ')).map((line) => Math.round(Number(line.slice('duration '.length)) * 1_000_000));
  let elapsedUs = 0;
  durations.forEach((durationUs, index) => {
    elapsedUs += durationUs;
    expect(elapsedUs).toBe(Math.round((index + 1) * span * 1_000_000));
  });
  expect(new Set(durations)).toEqual(new Set([21333, 21334]));
});
