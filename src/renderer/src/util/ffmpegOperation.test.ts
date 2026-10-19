// eslint-disable-next-line import/no-extraneous-dependencies
import { expect, test, vi } from 'vitest';
import { withFfOperation } from './ffmpegOperation';

test('bridge cancellation uses an ID, discards late results, and releases the operation', async () => {
  const controller = new AbortController();
  const api = { createFfOperation: vi.fn(), abortFfOperation: vi.fn(), finishFfOperation: vi.fn() };
  let complete!: (value: string) => void;
  const run = vi.fn((id) => {
    expect(typeof id).toBe('string');
    return new Promise<string>((resolve) => { complete = resolve; });
  });
  const pending = withFfOperation(controller.signal, api, run);
  controller.abort();
  complete('obsolete image');
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(api.abortFfOperation).toHaveBeenCalledWith(api.createFfOperation.mock.calls[0]![0]);
  expect(api.finishFfOperation).toHaveBeenCalledOnce();
  controller.abort();
  expect(api.abortFfOperation).toHaveBeenCalledOnce();
});

test('already aborted requests never create a process or operation', async () => {
  const api = { createFfOperation: vi.fn(), abortFfOperation: vi.fn(), finishFfOperation: vi.fn() };
  const controller = new AbortController();
  controller.abort();
  const run = vi.fn();
  await expect(withFfOperation(controller.signal, api, run)).rejects.toMatchObject({ name: 'AbortError' });
  expect(run).not.toHaveBeenCalled();
  expect(api.createFfOperation).not.toHaveBeenCalled();
});
