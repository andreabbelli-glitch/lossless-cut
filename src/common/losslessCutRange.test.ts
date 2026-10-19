// eslint-disable-next-line import/no-extraneous-dependencies
import { expect, test } from 'vitest';
import { getLosslessCutRange } from './losslessCutRange.js';

const defaults = { cutFrom: 1.6, cutTo: 4.4, fileDuration: 24, frameDuration: 1 / 25, cutFromAdjustmentFrames: 10, cutToAdjustmentFrames: -10 };

test('verification uses the same adjusted range as ordinary lossless seek and duration', () => {
  expect(getLosslessCutRange(defaults)).toMatchObject({ cuttingStart: true, cuttingEnd: true, adjustedFrom: 2, start: 2, end: 4, duration: 2 });
});

test('file edges preserve the existing omission of seek and end flags', () => {
  expect(getLosslessCutRange({ ...defaults, cutFrom: 0 })).toMatchObject({ cuttingStart: false, start: 0, end: 3.6 });
  expect(getLosslessCutRange({ ...defaults, cutTo: 24 })).toMatchObject({ cuttingEnd: false, start: 2, end: 24 });
});

test('the minimum-frame duration and unknown file end are shared by verification', () => {
  expect(getLosslessCutRange({ ...defaults, cutFrom: 2, cutTo: 2.01, fileDuration: undefined })).toMatchObject({ cuttingEnd: true, start: 2.4, end: 2.44, duration: 0.04 });
});
