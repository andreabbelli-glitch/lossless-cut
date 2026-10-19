// eslint-disable-next-line import/no-extraneous-dependencies
import { expect, test } from 'vitest';
import { execa } from 'execa';
import { createChunkReader } from './readableChunks';

test('a real child which exits between reads yields persistent EOF', async () => {
  const child = execa(process.execPath, ['-e', 'process.stdout.write("preview");'], { buffer: { stdout: false, stderr: true } });
  const read = createChunkReader(child.stdout!, child);
  expect((await read())?.toString()).toBe('preview');
  await child;
  expect(await read()).toBeNull();
  expect(await read()).toBeNull();
});

test('closing stdout after output does not hide a child error', async () => {
  const child = execa(process.execPath, ['-e', 'process.stdout.write("partial"); process.exitCode=7;'], { buffer: { stdout: false, stderr: true } });
  const read = createChunkReader(child.stdout!, child);
  expect((await read())?.toString()).toBe('partial');
  await expect(read()).rejects.toMatchObject({ exitCode: 7 });
});

test('abort settles a pending read instead of treating it as successful EOF', async () => {
  const controller = new AbortController();
  const child = execa(process.execPath, ['-e', 'setInterval(() => {},1000)'], { buffer: { stdout: false, stderr: true }, cancelSignal: controller.signal });
  const read = createChunkReader(child.stdout!, child);
  const pending = read();
  controller.abort();
  await expect(pending).rejects.toMatchObject({ isCanceled: true });
});

test('a terminal reader error stops a live producer without waiting for its exit', async () => {
  const child = execa(process.execPath, ['-e', 'setInterval(() => {},1000)'], { buffer: { stdout: false, stderr: true } });
  const read = createChunkReader(child.stdout!, child, () => child.kill());
  const pending = read();
  child.stdout!.destroy(new Error('Reader failed'));
  await expect(pending).rejects.toThrow('Reader failed');
  await expect(child).rejects.toBeDefined();
});
