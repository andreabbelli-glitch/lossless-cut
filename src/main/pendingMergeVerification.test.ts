// eslint-disable-next-line import/no-extraneous-dependencies
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

vi.mock('electron', () => ({ app: { isPackaged: false }, clipboard: {}, nativeImage: {} }));
vi.mock('./util.js', () => ({ platform: process.platform, arch: process.arch, isWindows: process.platform === 'win32', isLinux: process.platform === 'linux' }));
vi.mock('./isDev.js', () => ({ default: false }));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const ffmpeg = await import('./ffmpeg');
const { getCompatibleTimingArgs, planCompatibleCuts } = await import('./compatibleCuts');
const { verifyExport } = await import('./exportVerification');
let directory: string;
let source: string;
let merged: string;
let repeatedSource: string;
let repeatedPart: string;
const parts: string[] = [];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'llc-pending-merge-'));
  source = join(directory, 'source.mp4');
  merged = join(directory, 'merged.mp4');
  ffmpeg.setCustomFfPath(resolve('ffmpeg', `${process.platform}-${process.arch}`, ...(process.platform === 'win32' || process.platform === 'linux' ? ['lib'] : [])));
  await ffmpeg.runFfmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=128x96:r=30:d=16', '-f', 'lavfi', '-i', 'anoisesrc=r=48000:d=16:seed=42:color=pink', '-c:v', 'libx265', '-preset', 'slow', '-crf', '26', '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1', '-x265-params', 'pools=1:frame-threads=1:keyint=60:min-keyint=60:scenecut=0:open-gop=0:log-level=error', '-c:a', 'aac', source]);
  const plan = await planCompatibleCuts({ path: source, segments: [{ start: 0, end: 8 }, { start: 8, end: 16 }], streamIds: [0, 1] });
  expect(plan.issues).toEqual([]);
  expect(plan.segments.map(({ start, end }) => ({ start, end }))).toEqual([{ start: 0, end: 8 }, { start: 8, end: 16 }]);
  for (const [index, segment] of plan.segments.entries()) {
    const path = join(directory, `part-${index}.mp4`);
    parts.push(path);
    const timing = getCompatibleTimingArgs(segment);
    await ffmpeg.runFfmpeg([...timing.beforeInput, '-i', source, ...timing.afterInput, '-map', '0', '-c', 'copy', ...timing.filters.flatMap((filter) => [`-bsf:${filter.streamIndex}`, filter.expression]), path]);
  }
  const list = join(directory, 'parts.txt');
  await writeFile(list, parts.map((path, index) => `file '${path.replaceAll('\\', '/')}'\nduration ${plan.segments[index]!.duration}`).join('\n'));
  await ffmpeg.runFfmpeg(['-v', 'error', '-copyts', '-f', 'concat', '-safe', '0', '-i', list, '-map', '0', '-c', 'copy', '-movie_timescale', String(plan.segments[0]!.movieTimescale), merged]);
  repeatedSource = join(directory, 'repeated-source.mp4');
  repeatedPart = join(directory, 'repeated-part.mp4');
  await ffmpeg.runFfmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=192x108:r=25:d=24', '-f', 'lavfi', '-i', 'sine=r=48000:d=24', '-c:v', 'libx265', '-pix_fmt', 'yuv420p10le', '-crf', '26', '-preset', 'slow', '-x265-params', 'open-gop=0:pools=1:frame-threads=1:keyint=50:min-keyint=50:scenecut=0:log-level=error', '-tag:v', 'hvc1', '-c:a', 'aac', repeatedSource]);
  const repeatedPlan = await planCompatibleCuts({ path: repeatedSource, segments: [{ start: 0, end: 8 }], streamIds: [0, 1] });
  expect(repeatedPlan.possible).toBe(true);
  const timing = getCompatibleTimingArgs(repeatedPlan.segments[0]!);
  await ffmpeg.runFfmpeg([...timing.beforeInput, '-i', repeatedSource, ...timing.afterInput, '-map', '0', '-c', 'copy', ...timing.filters.flatMap((filter) => [`-bsf:${filter.streamIndex}`, filter.expression]), repeatedPart]);
}, 30000);

afterAll(async () => {
  if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('llc-pending-merge-')) throw new Error('Unexpected pending merge fixture directory');
  await rm(directory, { recursive: true, force: true });
});

test('copied AAC decoder reset remains strict for separate files and explicitly pending for merge-only intermediates', async () => {
  const options = { path: parts[1]!, sources: [{ path: source, start: 8, end: 16, streamIds: [0, 1] }], merged: false };
  const strict = await verifyExport({ ...options, id: 'strict-aac-intermediate' });
  expect(strict, JSON.stringify(strict)).toMatchObject({ status: 'failed' });
  expect(strict.issues.some((issue) => issue.includes('Decoded audio boundary samples differ')), JSON.stringify(strict)).toBe(true);
  const pending = await verifyExport({ ...options, id: 'pending-aac-intermediate', deferAudioContentToMerge: true });
  expect(pending, JSON.stringify(pending)).toMatchObject({ status: 'pending-merge', coverage: { structure: true, packetTimestamps: false, boundaries: false } });
  expect(pending.issues.some((issue) => issue.includes('not validated for publication'))).toBe(true);
}, 45000);

test('deferring AAC content cannot hide a video selection error', async () => {
  const result = await verifyExport({ id: 'pending-wrong-video-range', path: source, sources: [{ path: source, start: 8, end: 16, streamIds: [0, 1] }], merged: false, deferAudioContentToMerge: true });
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'failed' });
}, 30000);

test('AAC payload repeated after the selected end cannot invent a different common shift', async () => {
  const options = { path: repeatedPart, sources: [{ path: repeatedSource, start: 0, end: 8, streamIds: [0, 1] }], merged: false };
  const strict = await verifyExport({ ...options, id: 'repeated-aac-strict' });
  expect(strict, JSON.stringify(strict)).toMatchObject({ status: 'passed' });
  const pending = await verifyExport({ ...options, id: 'repeated-aac-pending', deferAudioContentToMerge: true });
  expect(pending, JSON.stringify(pending)).toMatchObject({ status: 'pending-merge', coverage: { boundaries: false } });
}, 30000);

test('the final merge proves original PCM and cannot request intermediate deferral', async () => {
  const options = { path: merged, sources: parts.map((path, index) => ({ path, origins: [{ path: source, start: index * 8, end: (index + 1) * 8, streamIds: [0, 1] }] })), merged: true };
  const final = await verifyExport({ ...options, id: 'final-aac-proof' });
  expect(final, JSON.stringify(final)).toMatchObject({ status: 'passed', coverage: { boundaries: true } });
  const invalid = await verifyExport({ ...options, id: 'invalid-final-deferral', deferAudioContentToMerge: true });
  expect(invalid, JSON.stringify(invalid)).toMatchObject({ status: 'inconclusive' });
  expect(invalid.issues.some((issue) => issue.includes('not allowed on a final merged output'))).toBe(true);
}, 45000);
