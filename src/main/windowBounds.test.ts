// eslint-disable-next-line import/no-extraneous-dependencies
import { expect, test } from 'vitest';

import { restoreWindowBounds } from './windowBounds';

test('restores valid positions on displays with negative coordinates', () => {
  const bounds = { x: -1800, y: 50, width: 1000, height: 800 };
  expect(restoreWindowBounds(bounds, [{ x: -1920, y: 0, width: 1920, height: 1080 }])).toEqual(bounds);
});

test('fits both dimensions and position after monitor removal or DPI changes', () => {
  expect(restoreWindowBounds({ x: 2200, y: -200, width: 1500, height: 500 }, [{ x: 0, y: 0, width: 1280, height: 720 }]))
    .toEqual({ x: 0, y: 0, width: 1280, height: 500 });
  expect(restoreWindowBounds({ x: 20, y: 10, width: 500, height: 2000 }, [{ x: 0, y: 0, width: 1280, height: 720 }]))
    .toEqual({ x: 20, y: 0, width: 500, height: 720 });
});

test('does not restore corrupt or non-finite geometry', () => {
  expect(restoreWindowBounds({ x: NaN, y: 0, width: 100, height: 100 }, [{ x: 0, y: 0, width: 1000, height: 1000 }])).toEqual({});
});
