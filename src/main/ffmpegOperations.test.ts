// eslint-disable-next-line import/no-extraneous-dependencies
import { describe, expect, test } from 'vitest';
import { execa } from 'execa';
import { abortFfOperation, combineFfSignals, createFfOperation, finishFfOperation, getFfOperationSignal } from './ffmpegOperations';

describe('FFmpeg operation cancellation', () => {
  test('caller and global cancellation both stop a real child process', async () => {
    for (const source of ['caller', 'global'] as const) {
      const caller = new AbortController();
      const global = new AbortController();
      const child = execa(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cancelSignal: combineFfSignals(caller.signal, global.signal) });
      const result = child.catch((error: unknown) => error);
      (source === 'caller' ? caller : global).abort();
      await expect(result).resolves.toMatchObject({ isCanceled: true });
    }
  });

  test('an ID cancelled before process creation remains cancelled', () => {
    createFfOperation('early');
    abortFfOperation('early');
    expect(getFfOperationSignal('early')?.aborted).toBe(true);
    finishFfOperation('early');
    expect(() => getFfOperationSignal('early')).toThrow('does not exist');
    createFfOperation('early');
    expect(getFfOperationSignal('early')?.aborted).toBe(false);
    finishFfOperation('early');
  });
});
