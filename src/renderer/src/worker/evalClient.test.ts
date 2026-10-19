import { afterEach, describe, expect, test, vi } from 'vitest';

import { createEvalClient } from './evalClient';
import type { RequestMessageData, ResponseMessageData } from './evalClient';

class FakeWorker extends EventTarget {
  requests: RequestMessageData[] = [];

  terminated = false;

  postMessage(message: RequestMessageData) { this.requests.push(message); }

  terminate() { this.terminated = true; }

  reply(data: ResponseMessageData) { this.dispatchEvent(new MessageEvent('message', { data })); }

  start(id: number) { this.reply({ id, startedAt: performance.timeOrigin + performance.now() }); }
}

afterEach(() => vi.useRealTimers());

describe('expression worker queue', () => {
  test('uses FIFO and starts the next deadline when execution starts', async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const evaluate = createEvalClient(() => worker as unknown as Worker);
    const first = evaluate('first', {});
    const second = evaluate('second', {});
    expect(worker.requests).toHaveLength(1);
    worker.start(worker.requests[0]!.id);
    await vi.advanceTimersByTimeAsync(1500);
    worker.reply({ id: worker.requests[0]!.id, durationMs: 0, data: 'one' });
    await expect(first).resolves.toBe('one');
    worker.start(worker.requests[1]!.id);
    await vi.advanceTimersByTimeAsync(1500);
    expect(worker.terminated).toBe(false);
    worker.reply({ id: worker.requests[1]!.id, durationMs: 0, data: 'two' });
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
    workers[0]!.start(workers[0]!.requests[0]!.id);
    await vi.advanceTimersByTimeAsync(2000);
    expect((await failed).every((result) => result.status === 'rejected')).toBe(true);
    expect(workers[0]!.terminated).toBe(true);
    const next = evaluate('next', {});
    workers[0]!.reply({ id: 3, durationMs: 0, data: 'stale' });
    workers[1]!.reply({ id: workers[1]!.requests[0]!.id, durationMs: 0, data: 'fresh' });
    await expect(next).resolves.toBe('fresh');
  });

  test('worker startup is excluded and message delivery does not restart the two-second budget', async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const evaluate = createEvalClient(() => worker as unknown as Worker);
    const failed = expect(evaluate('infinite', {})).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(10000);
    expect(worker.terminated).toBe(false);
    worker.reply({ id: worker.requests[0]!.id, startedAt: performance.timeOrigin + performance.now() - 1000 });
    await vi.advanceTimersByTimeAsync(1001);
    await failed;
    expect(worker.terminated).toBe(true);
  });

  test('a replacement worker also enforces its own execution deadline', async () => {
    vi.useFakeTimers();
    const workers: FakeWorker[] = [];
    const evaluate = createEvalClient(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    });
    for (let generation = 0; generation < 2; generation += 1) {
      const failed = expect(evaluate('infinite', {})).rejects.toThrow('timed out');
      const worker = workers[generation]!;
      worker.start(worker.requests[0]!.id);
      await vi.advanceTimersByTimeAsync(2000);
      await failed;
      expect(worker.terminated).toBe(true);
    }
  });

  test('a late result cannot cancel an already exhausted execution budget', async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const evaluate = createEvalClient(() => worker as unknown as Worker);
    const failed = expect(evaluate('slow', {})).rejects.toThrow('timed out');
    const { id } = worker.requests[0]!;
    worker.reply({ id, startedAt: performance.timeOrigin + performance.now() - 3000 });
    worker.reply({ id, durationMs: 3000, data: 'late' });
    await failed;
    expect(worker.terminated).toBe(true);
  });

  test('fast execution remains valid when start and result messages are delivered late', async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const evaluate = createEvalClient(() => worker as unknown as Worker);
    const result = evaluate('fast', {});
    const { id } = worker.requests[0]!;
    worker.reply({ id, startedAt: performance.timeOrigin + performance.now() - 3000 });
    worker.reply({ id, durationMs: 20, data: 'fast' });
    await expect(result).resolves.toBe('fast');
    await vi.advanceTimersByTimeAsync(1);
    expect(worker.terminated).toBe(false);
  });

  test('serialization errors do not block subsequent requests', async () => {
    const worker = new FakeWorker();
    const evaluate = createEvalClient(() => worker as unknown as Worker);
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    await expect(evaluate('circular', circular)).rejects.toThrow();
    const result = evaluate('ok', {});
    worker.reply({ id: worker.requests[0]!.id, durationMs: 0, data: 'ok' });
    await expect(result).resolves.toBe('ok');
  });

  test('expression exceptions reject only that request', async () => {
    const worker = new FakeWorker();
    const evaluate = createEvalClient(() => worker as unknown as Worker);
    const failed = expect(evaluate('bad', {})).rejects.toThrow('bad expression');
    const next = evaluate('ok', {});
    worker.reply({ id: worker.requests[0]!.id, durationMs: 0, error: 'bad expression' });
    await failed;
    worker.reply({ id: worker.requests[1]!.id, durationMs: 0, data: 'ok' });
    await expect(next).resolves.toBe('ok');
  });
});
