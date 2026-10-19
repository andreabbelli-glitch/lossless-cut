import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';

const { verify, cancelVerify } = vi.hoisted(() => ({ verify: vi.fn(), cancelVerify: vi.fn(async () => undefined) }));
vi.mock('../mainApi', async () => ({ default: {
  ...await import('../../../main/outputTransaction.js'),
  ...await import('../../../main/outputPathIdentity.js'),
  verifyExport: verify,
  cancelExportVerification: cancelVerify,
} }));

const { writeValidatedOutput } = await import('./validatedOutput');

async function cleanup(dir: string) {
  if (dirname(resolve(dir)) !== resolve(tmpdir()) || !basename(dir).startsWith('losslesscut-validated-')) throw new Error('Unexpected test directory');
  await rm(dir, { recursive: true, force: true });
}

async function fixture(run: (target: string, source: string, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'losslesscut-validated-'));
  try {
    const target = join(dir, 'export.mp4');
    const source = join(dir, 'source.mp4');
    await writeFile(target, 'previous');
    await writeFile(source, 'source');
    await run(target, source, dir);
  } finally {
    await cleanup(dir);
  }
}

beforeEach(() => { verify.mockReset(); cancelVerify.mockClear(); });

test('publishes only after actual candidate verification and preserves the previous export', async () => {
  await fixture(async (target, source, dir) => {
    let approve: (() => void) | undefined;
    let notifyVerification: (() => void) | undefined;
    const verificationStarted = new Promise<void>((resolveStarted) => { notifyVerification = resolveStarted; });
    const verificationGate = new Promise<void>((resolveGate) => { approve = resolveGate; });
    verify.mockImplementation(async ({ path, reencodedVideo }: { path: string, reencodedVideo: boolean }) => {
      expect(reencodedVideo).toBe(true);
      expect(await readFile(path, 'utf8')).toBe('candidate');
      expect(await readFile(target, 'utf8')).toBe('previous');
      notifyVerification?.();
      await verificationGate;
      return { status: 'passed', issues: [] };
    });
    const onVerification = vi.fn();
    const output = writeValidatedOutput({
      path: target,
      overwrite: true,
      sources: [{ path: source }],
      merged: false,
      reencodedVideo: (value) => value === 'writer result',
      onVerification,
      write: async (candidate) => { await writeFile(candidate, 'candidate'); return 'writer result'; },
    });
    await verificationStarted;
    expect(await readFile(target, 'utf8')).toBe('previous');
    approve?.();
    expect(await output).toMatchObject({ status: 'created', path: target, value: 'writer result' });
    expect(await readFile(target, 'utf8')).toBe('candidate');
    const backup = (await readdir(dir)).find((name) => name.includes('.previous.'));
    expect(backup).toBeDefined();
    expect(await readFile(join(dir, backup!), 'utf8')).toBe('previous');
    expect(onVerification).toHaveBeenLastCalledWith(undefined);
  });
});

test.each([
  { result: { status: 'failed', issues: ['Timeline changed'] }, errorName: 'ExportVerificationError' },
  { result: { status: 'inconclusive', issues: ['Cancelled'], cancelled: true }, errorName: 'AbortError' },
])('a $errorName verification preserves both destination and candidate', async ({ result, errorName }) => {
  await fixture(async (target, source, dir) => {
    verify.mockResolvedValue(result);
    const onVerification = vi.fn();
    await expect(writeValidatedOutput({
      path: target,
      overwrite: true,
      sources: [{ path: source }],
      merged: false,
      onVerification,
      write: async (candidate) => writeFile(candidate, 'candidate'),
    })).rejects.toMatchObject({ name: errorName });
    expect(await readFile(target, 'utf8')).toBe('previous');
    const candidate = (await readdir(dir)).find((name) => name.includes('.pending.'));
    expect(candidate).toBeDefined();
    expect(await readFile(join(dir, candidate!), 'utf8')).toBe('candidate');
    expect(onVerification).toHaveBeenLastCalledWith(undefined);
  });
});

test('a skipped export invokes neither writer nor verifier', async () => {
  await fixture(async (target, source) => {
    const write = vi.fn();
    expect(await writeValidatedOutput({ path: target, overwrite: false, sources: [{ path: source }], merged: false, write })).toEqual({ status: 'skipped', path: target });
    expect(write).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(await readFile(target, 'utf8')).toBe('previous');
  });
});

test('a writer abort retains its partial candidate and never verifies it', async () => {
  await fixture(async (target, source, dir) => {
    await expect(writeValidatedOutput({
      path: target,
      overwrite: true,
      sources: [{ path: source }],
      merged: false,
      write: async (candidate) => { await writeFile(candidate, 'partial'); throw new DOMException('Cancelled', 'AbortError'); },
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(verify).not.toHaveBeenCalled();
    expect(await readFile(target, 'utf8')).toBe('previous');
    const candidate = (await readdir(dir)).find((name) => name.includes('.pending.'));
    expect(await readFile(join(dir, candidate!), 'utf8')).toBe('partial');
  });
});

test('fresh preflight prevents overwriting a source before the writer starts', async () => {
  await fixture(async (_target, source) => {
    const write = vi.fn();
    await expect(writeValidatedOutput({ path: source, overwrite: true, sources: [{ path: source }], merged: false, write })).rejects.toThrow('conflicts with a source');
    expect(write).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(await readFile(source, 'utf8')).toBe('source');
  });
});

test('an abort after the writer returns cannot publish or start verification', async () => {
  await fixture(async (target, source, dir) => {
    const controller = new AbortController();
    await expect(writeValidatedOutput({
      path: target,
      overwrite: true,
      sources: [{ path: source }],
      merged: false,
      signal: controller.signal,
      write: async (candidate) => { await writeFile(candidate, 'partial candidate'); controller.abort(); },
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(verify).not.toHaveBeenCalled();
    expect(await readFile(target, 'utf8')).toBe('previous');
    const candidate = (await readdir(dir)).find((name) => name.includes('.pending.'));
    expect(await readFile(join(dir, candidate!), 'utf8')).toBe('partial candidate');
  });
});

test('an abort during verification cancels its ID and prevents publication of a late pass', async () => {
  await fixture(async (target, source) => {
    const controller = new AbortController();
    let notifyStarted: (() => void) | undefined;
    let passVerification: (() => void) | undefined;
    const started = new Promise<void>((resolveStarted) => { notifyStarted = resolveStarted; });
    const gate = new Promise<void>((resolveGate) => { passVerification = resolveGate; });
    verify.mockImplementation(async () => {
      notifyStarted?.();
      await gate;
      return { status: 'passed', issues: [] };
    });
    const output = writeValidatedOutput({ path: target, overwrite: true, sources: [{ path: source }], merged: false, signal: controller.signal, write: async (candidate) => writeFile(candidate, 'candidate') });
    await started;
    controller.abort();
    passVerification?.();
    await expect(output).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelVerify).toHaveBeenCalledWith(verify.mock.calls[0]![0].id);
    expect(await readFile(target, 'utf8')).toBe('previous');
  });
});

test('fresh preflight protects original paths referenced through intermediate origins', async () => {
  await fixture(async (_target, source, dir) => {
    const part = join(dir, 'part.mp4');
    await writeFile(part, 'intermediate');
    const write = vi.fn();
    await expect(writeValidatedOutput({ path: source, overwrite: true, sources: [{ path: part, origins: [{ path: source }] }], merged: true, write })).rejects.toThrow('conflicts with a source');
    expect(write).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(await readFile(source, 'utf8')).toBe('source');
  });
});
