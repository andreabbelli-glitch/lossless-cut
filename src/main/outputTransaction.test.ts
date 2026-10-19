/* eslint-disable import/no-extraneous-dependencies */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { expect, test } from 'vitest';

import { beginOutputTransaction, publishOutputTransaction, releaseOutputTransaction } from './outputTransaction.js';

async function cleanup(dir: string) {
  if (dirname(resolve(dir)) !== resolve(tmpdir()) || !basename(dir).startsWith('losslesscut-output-')) throw new Error('Unexpected test directory');
  await rm(dir, { recursive: true, force: true });
}

test('an existing export is unchanged until a validated candidate is published', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'losslesscut-output-'));
  try {
    const path = join(dir, 'export.mp4');
    await writeFile(path, 'previous');
    const transaction = await beginOutputTransaction(path, true);
    if (transaction.status !== 'created') throw new Error('Unexpected skip');
    expect(transaction.path).not.toBe(path);
    await writeFile(transaction.path, 'candidate');
    expect(await readFile(path, 'utf8')).toBe('previous');
    await expect(beginOutputTransaction(path, true)).rejects.toThrow('still being');
    const published = await publishOutputTransaction(transaction.id);
    expect(await readFile(path, 'utf8')).toBe('candidate');
    expect(published.backupPath).toBeDefined();
    expect(await readFile(published.backupPath!, 'utf8')).toBe('previous');
    expect((await readdir(dir)).sort()).toEqual([basename(published.backupPath!), 'export.mp4'].sort());
  } finally { await cleanup(dir); }
});

test('skip and cancellation preserve the old export; new paths use direct output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'losslesscut-output-'));
  try {
    const path = join(dir, 'export.mp4');
    await writeFile(path, 'previous');
    expect((await beginOutputTransaction(path, false)).status).toBe('skipped');
    const transaction = await beginOutputTransaction(path, true);
    if (transaction.status !== 'created') throw new Error('Unexpected skip');
    await writeFile(transaction.path, 'partial');
    releaseOutputTransaction(transaction.id);
    expect(await readFile(path, 'utf8')).toBe('previous');
    const fresh = await beginOutputTransaction(join(dir, 'new.mp4'), true);
    expect(fresh.path).toBe(join(dir, 'new.mp4'));
    if (fresh.status === 'created') {
      await writeFile(fresh.path, 'new output');
      expect(await publishOutputTransaction(fresh.id)).toEqual({});
    }
  } finally { await cleanup(dir); }
});

test('a missing candidate restores the previous destination on publication failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'losslesscut-output-'));
  try {
    const path = join(dir, 'export.mp4');
    await writeFile(path, 'previous');
    const transaction = await beginOutputTransaction(path, true);
    if (transaction.status !== 'created') throw new Error('Unexpected skip');
    await expect(publishOutputTransaction(transaction.id)).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe('previous');
  } finally { await cleanup(dir); }
});

test('overwriting a long valid filename uses short staging and backup names', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'losslesscut-output-'));
  try {
    const path = join(dir, `${'a'.repeat(220)}.mp4`);
    await writeFile(path, 'previous');
    const transaction = await beginOutputTransaction(path, true);
    if (transaction.status !== 'created') throw new Error('Unexpected skip');
    await writeFile(transaction.path, 'candidate');
    expect(await readFile(path, 'utf8')).toBe('previous');
    const published = await publishOutputTransaction(transaction.id);
    expect(await readFile(path, 'utf8')).toBe('candidate');
    expect(published.backupPath).toBeDefined();
    expect(await readFile(published.backupPath!, 'utf8')).toBe('previous');
    expect((await readdir(dir)).sort()).toEqual([basename(path), basename(published.backupPath!)].sort());
  } finally { await cleanup(dir); }
});

test.runIf(process.platform === 'win32')('a locked destination preserves both previous export and candidate', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'losslesscut-output-'));
  let locker: ReturnType<typeof spawn> | undefined;
  let transactionId: string | undefined;
  try {
    const path = join(dir, 'export.mp4');
    await writeFile(path, 'previous');
    const transaction = await beginOutputTransaction(path, true);
    if (transaction.status !== 'created') throw new Error('Unexpected skip');
    transactionId = transaction.id;
    await writeFile(transaction.path, 'candidate');
    const escapedPath = path.replaceAll("'", "''");
    locker = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$taskLock = [System.IO.File]::Open('${escapedPath}', 'Open', 'Read', 'Read'); [Console]::Out.WriteLine('locked'); Start-Sleep -Seconds 30; $taskLock.Dispose()`], { windowsHide: true });
    await once(locker.stdout!, 'data');
    await expect(publishOutputTransaction(transaction.id)).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe('previous');
    expect(await readFile(transaction.path, 'utf8')).toBe('candidate');
  } finally {
    if (transactionId) releaseOutputTransaction(transactionId);
    if (locker) {
      const closed = once(locker, 'close');
      locker.kill();
      await closed;
    }
    await cleanup(dir);
  }
}, 15000);

test.runIf(process.platform === 'win32')('concurrent aliases cannot reserve the same future output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'losslesscut-output-'));
  const ids: string[] = [];
  try {
    const outcomes = await Promise.allSettled([
      beginOutputTransaction(join(dir, 'Export.mp4'), true),
      beginOutputTransaction(join(dir, 'EXPORT.MP4'), true),
    ]);
    const created = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    for (const outcome of created) if (outcome.value.status === 'created') ids.push(outcome.value.id);
    expect(created).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected?.reason).toBeInstanceOf(Error);
    expect(rejected?.reason.message).toContain('still being');
  } finally {
    for (const id of ids) releaseOutputTransaction(id);
    await cleanup(dir);
  }
});
