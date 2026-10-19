import { afterEach, describe, expect, test, vi } from 'vitest';

import { createEvalClient } from './evalClient';
import type { RequestMessageData, ResponseMessageData } from './evalClient';

class FakeWorker extends EventTarget {
  requests: RequestMessageData[] = [];

  terminated = false;

  postMessage(message: RequestMessageData) { this.requests.push(message); }

  terminate() { this.terminated = true; }

  reply(data: ResponseMessageData) { this.dispatchEvent(new MessageEvent('message', { data })); }
}

afterEach(() => vi.useRealTimers());

describe('expression worker queue', () => {
  test('uses FIFO and starts the next deadline at dispatch', async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const evaluate = createEvalClient(() => worker as unknown as Worker);
    const first = evaluate('first', {});
    const second = evaluate('second', {});
    expect(worker.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1500);
    worker.reply({ id: worker.requests[0]!.id, data: 'one' });
    await expect(first).resolves.toBe('one');
    await vi.advanceTimersByTimeAsync(1500);
    expect(worker.terminated).toBe(false);
    worker.reply({ id: worker.requests[1]!.id, data: 'two' });
    await expect(second).resolves.toBe('two');
  });

  test('timeout rejects the generation and later work gets a fresh worker', async () => {
    vi.useFakeTimers();
    const workers: FakeWorker[] = [];
    const evaluate = createEvalClient(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    });
    const failed = Promise.allSettled([evaluate('infinite', {}), evaluate('queued', {})]);
    await vi.advanceTimersByTimeAsync(2000);
    expect((await failed).every((result) => result.status === 'rejected')).toBe(true);
    expect(workers[0]!.terminated).toBe(true);
    const next = evaluate('next', {});
    workers[0]!.reply({ id: 3, data: 'stale' });
    workers[1]!.reply({ id: workers[1]!.requests[0]!.id, data: 'fresh' });
    await expect(next).resolves.toBe('fresh');
  });

  test('serialization errors do not block subsequent requests', async () => {
    const worker = new FakeWorker();
    const evaluate = createEvalClient(() => worker as unknown as Worker);
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    await expect(evaluate('circular', circular)).rejects.toThrow();
    const result = evaluate('ok', {});
    worker.reply({ id: worker.requests[0]!.id, data: 'ok' });
    await expect(result).resolves.toBe('ok');
  });

  test('expression exceptions reject only that request', async () => {
    const worker = new FakeWorker();
    const evaluate = createEvalClient(() => worker as unknown as Worker);
    const failed = expect(evaluate('bad', {})).rejects.toThrow('bad expression');
    const next = evaluate('ok', {});
    worker.reply({ id: worker.requests[0]!.id, error: 'bad expression' });
    await failed;
    worker.reply({ id: worker.requests[1]!.id, data: 'ok' });
    await expect(next).resolves.toBe('ok');
  });
});
