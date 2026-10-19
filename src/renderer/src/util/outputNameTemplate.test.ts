import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';

const { evaluate, checkIdentity } = vi.hoisted(() => ({ evaluate: vi.fn(), checkIdentity: vi.fn() }));
vi.mock('../worker/eval', () => ({ default: evaluate }));
vi.mock('../mainApi', () => ({ default: { checkOutputPathIdentity: checkIdentity } }));
vi.mock('../isDev', () => ({ default: false }));
vi.mock('../util', () => ({ isMac: false, isWindows: process.platform === 'win32', hasDuplicates: (names: string[]) => new Set(names).size !== names.length, filenamify: (name: string) => name, getOutFileExtension: () => '.mp4' }));
vi.mock('../segments', () => ({ getSegmentTags: () => ({}), formatSegNum: () => '1', getGuaranteedSegments: (segments: unknown) => segments }));
vi.mock('./path', async () => ({ ...await import('node:path') }));

const { generateMergedFileNames } = await import('./outputNameTemplate');

beforeEach(() => {
  evaluate.mockReset();
  checkIdentity.mockReset();
});

test('filesystem collisions remain blocking without fallback names and protect every merge source', async () => {
  const first = path.resolve('first.mp4');
  const second = path.resolve('second.mp4');
  evaluate.mockResolvedValue('SECOND.mp4');
  checkIdentity.mockResolvedValue({ kind: 'input', path: path.resolve('SECOND.mp4'), otherPath: second });
  const result = await generateMergedFileNames({ template: 'SECOND.mp4', isCustomFormatSelected: false, fileFormat: 'mp4', sourceFiles: [{ path: first }, { path: second }], outputDir: path.dirname(first), safeOutputFileName: true, maxLabelLength: 100, exportCount: 0, epochMs: 1 });
  expect(result.fileNames).toEqual(['SECOND.mp4']);
  expect(result.problems.blocking).toBe(true);
  expect(evaluate).toHaveBeenCalledTimes(1);
  expect(checkIdentity).toHaveBeenCalledWith({ inputPaths: [first, second], outputPaths: [path.resolve('SECOND.mp4')] });
});

test('filesystem inspection errors block instead of falling back to an unchecked destination', async () => {
  const first = path.resolve('first.mp4');
  evaluate.mockResolvedValue('new.mp4');
  checkIdentity.mockRejectedValue(new Error('Permission denied'));
  const result = await generateMergedFileNames({ template: 'new.mp4', isCustomFormatSelected: false, fileFormat: 'mp4', sourceFiles: [{ path: first }], outputDir: path.dirname(first), safeOutputFileName: true, maxLabelLength: 100, exportCount: 0, epochMs: 1 });
  expect(result.problems.blocking).toBe(true);
  expect(evaluate).toHaveBeenCalledTimes(1);
});
