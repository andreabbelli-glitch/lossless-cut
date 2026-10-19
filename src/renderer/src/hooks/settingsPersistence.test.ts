import { expect, test, vi } from 'vitest';

import createSettingsPersistence from './settingsPersistence';

test('continuous changes save the final value at release and discrete changes save immediately', () => {
  const write = vi.fn();
  const settings = createSettingsPersistence<string, number>(write);
  settings.begin('volume');
  for (let value = 0; value < 100; value += 1) settings.update('volume', value);
  expect(write).not.toHaveBeenCalled();
  settings.end('volume');
  settings.flush();
  expect(write).toHaveBeenCalledExactlyOnceWith('volume', 99);
  settings.update('volume', 99);
  expect(write).toHaveBeenCalledTimes(1);
  settings.update('volume', 50);
  expect(write).toHaveBeenLastCalledWith('volume', 50);
});

test('a final render supersedes older pending values and closing flushes active controls', () => {
  const write = vi.fn();
  const settings = createSettingsPersistence<string, number>(write);
  settings.begin('quality');
  settings.update('quality', 1);
  settings.end('quality');
  settings.update('quality', 2);
  settings.flush();
  expect(write).toHaveBeenCalledExactlyOnceWith('quality', 2);
  settings.begin('quality');
  settings.update('quality', 3);
  settings.flush(true);
  expect(write).toHaveBeenLastCalledWith('quality', 3);
});

test('failed writes remain available to retry at the next flush', () => {
  const write = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
  const settings = createSettingsPersistence<string, number>(write);
  settings.update('quality', 3);
  settings.flush(true);
  expect(write).toHaveBeenCalledTimes(2);
  expect(write).toHaveBeenLastCalledWith('quality', 3);
});
