// eslint-disable-next-line import/no-extraneous-dependencies
import { expect, test } from 'vitest';
import { findDirectionalKeyframeTime } from './keyframes';

test('directional keyframe lookup preserves boundaries and rational timestamps', () => {
  const frames = [0, 1001 / 30000, 2, 2, 10].map((time) => ({ time, keyframe: true }));
  expect(findDirectionalKeyframeTime(frames, 2, 1)).toBe(2);
  expect(findDirectionalKeyframeTime(frames, 2, -1)).toBe(2);
  expect(findDirectionalKeyframeTime(frames, 1, 1)).toBe(2);
  expect(findDirectionalKeyframeTime(frames, 1, -1)).toBe(1001 / 30000);
  expect(findDirectionalKeyframeTime(frames, -1, -1)).toBeUndefined();
  expect(findDirectionalKeyframeTime(frames, 11, 1)).toBeUndefined();
  expect(findDirectionalKeyframeTime([], 0, 1)).toBeUndefined();
});

test('lookup agrees with the previous filtering semantics on generated sorted input', () => {
  const frames = Array.from({ length: 1000 }, (_, index) => ({ time: (index * 1001) / 30000, keyframe: index % 7 === 0 }));
  for (let time = -1; time < 35; time += 0.0173) {
    for (const direction of [-1, 1]) {
      const eligible = frames.filter((frame) => frame.keyframe && (direction > 0 ? frame.time >= time : frame.time <= time));
      expect(findDirectionalKeyframeTime(frames, time, direction)).toBe((direction > 0 ? eligible[0] : eligible.at(-1))?.time);
    }
  }
});
