import { mkdtemp, rm, access, readFile, writeFile, copyFile } from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import type { FFprobeProbeResult } from '../../../common/ffprobe';
import type { CompatibleCut } from '../../../common/compatibleCuts';

vi.mock('react', () => ({ useCallback: (callback: unknown) => callback }));
vi.mock('electron', () => ({ app: { isPackaged: false }, clipboard: {}, nativeImage: {} }));
vi.mock('../../../main/util.js', () => ({ platform: process.platform, arch: process.arch, isWindows: process.platform === 'win32', isLinux: process.platform === 'linux' }));
vi.mock('../../../main/isDev.js', () => ({ default: false }));
vi.mock('../../../main/logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../util/path', async () => import('node:path'));
vi.mock('../util', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  return {
    getSuffixedOutPath: ({ customOutDir, filePath, nameSuffix }: { customOutDir?: string, filePath: string, nameSuffix: string }) => path.join(customOutDir ?? path.dirname(filePath), `${path.parse(filePath).name}-${nameSuffix}`),
    getOutDir: (customOutDir: string | undefined, filePath: string) => customOutDir ?? path.dirname(filePath),
    getOutFileExtension: () => '.mp4',
    transferTimestamps: vi.fn(),
    getHtml5ifiedPath: vi.fn(),
    unlinkWithRetry: fs.unlink,
    assertFileExists: fs.access,
    readFileSize: async (file: string) => (await fs.stat(file)).size,
    getFrameDuration: (fps: number | undefined) => 1 / (fps ?? 30),
    isMac: false,
    html5ifiedPrefix: 'preview',
    html5dummySuffix: 'dummy',
  };
});
vi.mock('../segments', () => ({ getGuaranteedSegments: (segments: unknown) => segments, isDurationValid: (duration: unknown) => typeof duration === 'number' && Number.isFinite(duration) && duration > 0 }));
vi.mock('../mainApi', async () => {
  const fs = await import('node:fs/promises');
  const verification = await import('../../../main/exportVerification.js');
  return { default: {
    ...await import('../../../main/outputTransaction.js'),
    ...await import('../../../main/outputPathIdentity.js'),
    ...await import('../../../main/compatibleCuts.js'),
    ...verification,
    cancelExportVerification: async (id: string) => verification.cancelExportVerification(id),
    pathExists: async (path: string) => fs.access(path).then(() => true, () => false),
  } };
});
vi.mock('../ffmpeg', async () => {
  const ffmpeg = await import('../../../main/ffmpeg');
  const readMetadata = async (path: string) => {
    const { stdout } = await ffmpeg.runFfprobe(['-v', 'error', '-show_streams', '-show_format', '-show_chapters', '-of', 'json', path]);
    return JSON.parse(new TextDecoder().decode(stdout));
  };
  const keyframes = async ({ filePath, streamIndex, aroundTime, window }: { filePath: string, streamIndex: number, aroundTime: number, window: number }) => (await ffmpeg.readKeyframeTimes({ filePath, streamIndex, from: Math.max(0, aroundTime - window / 2), to: aroundTime + window / 2 })).map((time) => ({ time, keyframe: true, createdAt: new Date() }));
  return {
    ...ffmpeg,
    readFileFfprobeMeta: readMetadata,
    createFileMetadataReader: () => readMetadata,
    getDuration: async (path: string) => Number((await readMetadata(path)).format.duration),
    isCuttingStart: (time: number) => time > 0,
    isCuttingEnd: (time: number, duration: number) => time < duration,
    getExperimentalArgs: () => [],
    getVideoTimescaleArgs: (clock: number | undefined) => (clock == null ? [] : ['-video_track_timescale', String(clock)]),
    logStdoutStderr: vi.fn(),
    RefuseOverwriteError: class extends Error {},
    readKeyframesAroundTime: keyframes,
    findKeyframeAtExactTime: (frames: { time: number }[], time: number) => frames.find((frame) => Math.abs(frame.time - time) < 0.000001),
    findNextKeyframe: (frames: { time: number }[], time: number) => frames.find((frame) => frame.time >= time),
    findKeyframeNearTime: async ({ filePath, streamIndex, time }: { filePath: string, streamIndex: number, time: number }) => (await keyframes({ filePath, streamIndex, aroundTime: time, window: 60 })).findLast((frame) => frame.time <= time)?.time,
    planVideoCopyRangeWithSignal: async ({ signal, ...params }: { signal: AbortSignal, path: string, streamIndex: number, range: { start: number, end: number }, toEnd?: boolean }) => {
      const { withFfOperation } = await import('../util/ffmpegOperation');
      const { planVideoCopyRange } = await import('../../../main/compatibleCuts');
      return withFfOperation(signal, ffmpeg, (operationId) => planVideoCopyRange({ ...params, operationId }));
    },
    createChaptersFromSegments: vi.fn(),
  };
});

vi.stubGlobal('window', { require: () => fsPromises });
const { default: useFfmpegOperations, WholeSegmentEncodingRequiredError } = await import('./useFfmpegOperations');
const ffmpeg = await import('../../../main/ffmpeg');
let directory: string;
let source: string;
let offset: string;
let videoOffset: string;
const compressionMarker = JSON.stringify({ version: 1, id: '00000000-0000-4000-8000-000000000019', profile: 'hevc-main10-crf26-slow-v1', generation: 1 });
const compressionComment = 'STASH-COMPRESSION:v1:00000000-0000-4000-8000-000000000019:hevc-main10-crf26-slow-v1';

type Metadata = FFprobeProbeResult & Required<Pick<FFprobeProbeResult, 'format' | 'streams'>>;

async function metadata(path: string): Promise<Metadata> {
  const { stdout } = await ffmpeg.runFfprobe(['-v', 'error', '-show_streams', '-show_format', '-show_chapters', '-of', 'json', path]);
  const value = JSON.parse(new TextDecoder().decode(stdout)) as FFprobeProbeResult;
  if (!value.streams || !value.format) throw new Error('Incomplete fixture metadata');
  return { ...value, streams: value.streams, format: value.format };
}

async function cut(path: string, name: string, start: number, end: number, allowWholeSegmentEncode = false, options: { signal?: AbortSignal, onVerification?: (id: string | undefined) => void, overwrite?: boolean, verifySkipped?: boolean, ordinary?: boolean, videoOnly?: boolean, fromFrames?: number, toFrames?: number, deferAudioContentToMerge?: boolean, compatibleTimings?: CompatibleCut[], additionalSegments?: { start: number, end: number, name: string }[], stripMetadata?: boolean } = {}) {
  const meta = await metadata(path);
  const commands: string[][] = [];
  // React's identity adapter executes the actual export operation below.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const operations = useFfmpegOperations({ filePath: path, isEncoding: !options.ordinary, lossyMode: undefined, enableOverwriteOutput: options.overwrite ?? true, outputPlaybackRate: 1, cutFromAdjustmentFrames: options.fromFrames ?? 0, cutToAdjustmentFrames: options.toFrames ?? 0, appendLastCommandsLog: vi.fn(), appendFfmpegCommandLog: (args) => commands.push(args), encCustomBitrate: undefined, ffmpegHwaccel: 'none', treatInputFileModifiedTimeAsStart: false, treatOutputFileModifiedTimeAsStart: false, allowWholeSegmentEncode });
  const segments = [{ start, end }, ...options.additionalSegments ?? []].map((segment, originalIndex) => ({ ...segment, originalIndex }));
  const result = await operations.cutMultiple({ ...options, outputDir: directory, customOutDir: directory, segments, cutFileNames: [name, ...(options.additionalSegments ?? []).map((segment) => segment.name)], fileDuration: Number(meta.format.duration), rotation: undefined, detectedFps: 25, onProgress: vi.fn(), keyframeCut: true, copyFileStreams: [{ path, streamIds: meta.streams.filter((stream) => !options.videoOnly || stream.codec_type === 'video').map((stream) => stream.index) }], allFilesMeta: { [path]: { ...meta, chapters: meta.chapters ?? [] } }, outFormat: 'mp4', shortestFlag: false, ffmpegExperimental: false, preserveMetadata: options.stripMetadata ? 'none' : 'default', preserveMetadataOnMerge: true, preserveMovData: true, preserveChapters: false, movFastStart: false, avoidNegativeTs: undefined, paramsByFile: new Map(), chapters: undefined });
  return { result, commands, operations, output: join(directory, name) };
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'llc-smartcut-pipeline-'));
  source = join(directory, 'source.mp4');
  offset = join(directory, 'offset.mp4');
  videoOffset = join(directory, 'video-offset.mp4');
  ffmpeg.setCustomFfPath(resolve('ffmpeg', `${process.platform}-${process.arch}`, ...(process.platform === 'win32' || process.platform === 'linux' ? ['lib'] : [])));
  await ffmpeg.runFfmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=192x108:r=25:d=24', '-f', 'lavfi', '-i', 'sine=r=48000:d=24', '-c:v', 'libx265', '-pix_fmt', 'yuv420p10le', '-crf', '26', '-preset', 'slow', '-x265-params', 'open-gop=0:pools=1:frame-threads=1:keyint=50:min-keyint=50:scenecut=0:log-level=error', '-tag:v', 'hvc1', '-c:a', 'aac', '-metadata', `stash_compression=${compressionMarker}`, '-metadata', `comment=${compressionComment}`, '-movflags', '+use_metadata_tags', '-y', source]);
  await ffmpeg.runFfmpeg(['-v', 'error', '-copyts', '-i', source, '-itsoffset', '0.018', '-i', source, '-map', '0:v', '-map', '1:a', '-c', 'copy', '-movie_timescale', '192000', '-y', offset]);
  await ffmpeg.runFfmpeg(['-v', 'error', '-copyts', '-itsoffset', '0.018', '-i', source, '-i', source, '-map', '0:v', '-map', '1:a', '-c', 'copy', '-movie_timescale', '192000', '-y', videoOffset]);
}, 30000);

afterAll(async () => {
  if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('llc-smartcut-pipeline-')) throw new Error('Unexpected fixture directory');
  await rm(directory, { recursive: true, force: true });
});

test('Main10 smart cut encodes both borders and retains exactly 100 video frames', async () => {
  const { result, output, commands } = await cut(source, 'cut.mp4', 1, 5, false, { stripMetadata: true });
  expect(result[0]?.validated).toBe(true);
  const { stdout } = await ffmpeg.runFfprobe(['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,codec_name,pix_fmt,profile,nb_read_frames,duration', '-of', 'json', output]);
  const { streams } = JSON.parse(new TextDecoder().decode(stdout));
  expect(streams[0]).toMatchObject({ codec_name: 'hevc', pix_fmt: 'yuv420p10le', profile: 'Main 10', nb_read_frames: '100', duration: '4.000000' });
  expect(commands.filter((args) => args.includes('libx265'))).toHaveLength(2);
  expect(commands.filter((args) => args.includes('libx265')).every((args) => !args.includes('-map') || !args.includes('0:1'))).toBe(true);
  expect((await metadata(output)).format.tags).toMatchObject({ stash_compression: compressionMarker, comment: compressionComment });
}, 30000);

test('an inherited audio offset remains under one common source shift', async () => {
  const { result, output } = await cut(offset, 'offset-cut.mp4', 1, 5);
  expect(result[0]?.validated).toBe(true);
  const readPackets = async (path: string) => {
    const { stdout } = await ffmpeg.runFfprobe(['-v', 'error', '-select_streams', 'a:0', '-show_packets', '-show_data_hash', 'sha256', '-show_entries', 'packet=pts,dts,data_hash:packet_side_data', '-of', 'json', path]);
    return JSON.parse(new TextDecoder().decode(stdout)).packets as { pts: number, dts: number, data_hash: string, side_data_list?: unknown[] }[];
  };
  const inputPackets = new Map((await readPackets(offset)).map((packet) => [packet.pts, packet]));
  for (const packet of await readPackets(output)) {
    const original = inputPackets.get(packet.pts + 48000);
    expect(original).toBeDefined();
    expect(packet.data_hash).toBe(original!.data_hash);
    expect(packet.pts - original!.pts).toBe(-48000);
    expect(packet.dts - original!.dts).toBe(-48000);
    if (packet.pts >= 0) expect(packet.side_data_list).toEqual(original!.side_data_list);
  }
}, 30000);

test('a selection within one GOP requires explicit whole-video encoding consent', async () => {
  await expect(cut(source, 'requires-consent.mp4', 1, 1.5)).rejects.toBeInstanceOf(WholeSegmentEncodingRequiredError);
  expect(await access(join(directory, 'requires-consent.mp4')).then(() => true, () => false)).toBe(false);
  const { result, commands } = await cut(source, 'approved.mp4', 1, 1.5, true);
  expect(result[0]?.validated).toBe(true);
  expect(commands.filter((args) => args.includes('libx265'))).toHaveLength(1);
}, 30000);

test('video with an inherited 18ms delay retains its source frame grid', async () => {
  const originalMetadata = await metadata(videoOffset);
  const originalStart = Number(originalMetadata.streams.find((stream) => stream.codec_type === 'video')!.start_time);
  const { output, result } = await cut(videoOffset, 'video-offset-cut.mp4', 1, 5);
  expect(result[0]?.validated).toBe(true);
  const { stdout } = await ffmpeg.runFfprobe(['-v', 'error', '-select_streams', 'v:0', '-show_frames', '-show_entries', 'frame=pts_time', '-of', 'json', output]);
  const frames = JSON.parse(new TextDecoder().decode(stdout)).frames as { pts_time: string }[];
  expect(frames).toHaveLength(100);
  for (const [index, frame] of frames.entries()) expect(Number(frame.pts_time)).toBeCloseTo(originalStart + index / 25, 6);
}, 30000);

test('a cut from the source beginning preserves the original AAC priming packet', async () => {
  const { output, result, commands } = await cut(source, 'from-start.mp4', 0, 4);
  expect(result[0]?.validated).toBe(true);
  expect(commands.filter((args) => args.includes('libx265'))).toHaveLength(0);
  expect((await metadata(output)).format.tags?.['losslesscut_smartcut']).toBeUndefined();
  const firstPacket = async (path: string) => {
    const { stdout } = await ffmpeg.runFfprobe(['-v', 'error', '-select_streams', 'a:0', '-show_packets', '-show_data_hash', 'sha256', '-show_entries', 'packet=pts,dts,data_hash:packet_side_data', '-of', 'json', path]);
    return JSON.parse(new TextDecoder().decode(stdout)).packets[0];
  };
  expect(await firstPacket(output)).toEqual(await firstPacket(source));
}, 30000);

test('an abort between Smart Cut stages preserves the previous destination', async () => {
  const target = join(directory, 'cancelled.mp4');
  await writeFile(target, 'previous export');
  const controller = new AbortController();
  let phases = 0;
  await expect(cut(source, 'cancelled.mp4', 1, 5, false, {
    signal: controller.signal,
    onVerification: (id) => {
      if (id != null) { phases += 1; queueMicrotask(() => controller.abort()); }
    },
  })).rejects.toMatchObject({ name: 'AbortError' });
  expect(phases).toBe(1);
  expect(await readFile(target, 'utf8')).toBe('previous export');
}, 30000);

test('a skipped full-source file cannot stand in for a different requested selection', async () => {
  const target = join(directory, 'stale.mp4');
  await copyFile(source, target);
  let failure: unknown;
  try { await cut(source, 'stale.mp4', 1, 5, false, { overwrite: false, verifySkipped: true }); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ name: 'ExportVerificationError' });
  expect((await metadata(target)).format.duration).toBe((await metadata(source)).format.duration);
}, 30000);

test('a selection ending at EOF copies the complete last GOP without re-encoding its border', async () => {
  const { output, result, commands } = await cut(source, 'through-end.mp4', 1, 24);
  expect(result[0]?.validated).toBe(true);
  expect(commands.filter((args) => args.includes('libx265'))).toHaveLength(1);
  const { stdout } = await ffmpeg.runFfprobe(['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'json', output]);
  expect(JSON.parse(new TextDecoder().decode(stdout)).streams[0].nb_read_frames).toBe('575');
}, 30000);

test('ordinary stream-copy verification uses the effective frame-adjusted source range', async () => {
  const noBframes = join(directory, 'no-bframes.mp4');
  await ffmpeg.runFfmpeg(['-v', 'error', '-i', source, '-map', '0:v:0', '-c:v', 'libx264', '-bf', '0', '-g', '50', '-sc_threshold', '0', '-y', noBframes]);
  const { output, result, commands } = await cut(noBframes, 'adjusted.mp4', 1.6, 4.4, false, { ordinary: true, videoOnly: true, fromFrames: 10, toFrames: -10 });
  expect(result[0]?.validated).toBe(true);
  expect(result[0]?.originalSources).toMatchObject([{ start: 2, end: 4, streamIds: [0] }]);
  expect(commands[0]).toEqual(expect.arrayContaining(['-ss', '2.000000', '-t', '2.000000']));
  expect(commands.some((args) => args.includes('libx265'))).toBe(false);
  const { stdout } = await ffmpeg.runFfprobe(['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'json', output]);
  expect(JSON.parse(new TextDecoder().decode(stdout)).streams[0].nb_read_frames).toBe('50');
}, 30000);

test('actual cutMultiple intermediates defer AAC content until the contiguous final merge restores decoder context', async () => {
  const { planCompatibleCuts } = await import('../../../main/compatibleCuts');
  const { releaseOutputTransaction } = await import('../../../main/outputTransaction');
  // This positive needs unambiguous packet anchors; repetitive sine AAC is
  // covered separately by the verifier's conservative ambiguity regressions.
  const mergeSource = join(directory, 'merge-source.mp4');
  await ffmpeg.runFfmpeg(['-v', 'error', '-i', source, '-f', 'lavfi', '-i', 'anoisesrc=color=pink:sample_rate=48000:duration=24:amplitude=0.2:seed=42', '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-metadata', `stash_compression=${compressionMarker}`, '-metadata', `comment=${compressionComment}`, '-movflags', '+use_metadata_tags', '-y', mergeSource]);
  const plan = await planCompatibleCuts({ path: mergeSource, streamIds: [0, 1], segments: [{ start: 0, end: 8 }, { start: 8, end: 16 }] });
  if (!plan.possible) throw new Error(plan.issues.join('; '));
  const { result, operations } = await cut(mergeSource, 'merge-first.mp4', 0, 8, false, { ordinary: true, deferAudioContentToMerge: true, compatibleTimings: plan.segments, additionalSegments: [{ start: 8, end: 16, name: 'merge-second.mp4' }] });
  try {
    expect(result).toHaveLength(2);
    expect(result.every((part) => part.created && !part.validated && part.pendingMerge && part.transactionId != null)).toBe(true);
    const mergedPath = join(directory, 'actual-merged.mp4');
    const merged = await operations.concatCutSegments({ customOutDir: directory, outFormat: 'mp4', segmentPaths: result.map((part) => part.path), segmentSources: result.map((part) => ({ path: part.path, origins: part.originalSources })), segmentDurations: plan.segments.map((segment) => segment.duration), ffmpegExperimental: false, onProgress: vi.fn(), preserveMovData: true, movFastStart: false, chapterNames: undefined, preserveMetadataOnMerge: true, mergedOutFilePath: mergedPath });
    expect(merged).toMatchObject({ status: 'created', validated: true });
    expect((await metadata(mergedPath)).format.tags).toMatchObject({ stash_compression: compressionMarker, comment: compressionComment });
    const pcm = async (path: string, to?: number) => (await ffmpeg.runFfmpeg(['-v', 'error', '-i', path, ...(to != null ? ['-t', String(to)] : []), '-map', '0:a:0', '-c:a', 'pcm_s16le', '-f', 's16le', '-'])).stdout;
    expect(Buffer.from(await pcm(mergedPath))).toEqual(Buffer.from(await pcm(mergeSource, 16)));
  } finally {
    await Promise.all(result.flatMap((part) => (part.transactionId != null ? [releaseOutputTransaction(part.transactionId)] : [])));
  }
}, 40000);

test('a later cut failure releases earlier pending reservations without replacing their existing destination', async () => {
  const { planCompatibleCuts } = await import('../../../main/compatibleCuts');
  const { beginOutputTransaction, releaseOutputTransaction } = await import('../../../main/outputTransaction');
  const plan = await planCompatibleCuts({ path: source, streamIds: [0, 1], segments: [{ start: 0, end: 8 }] });
  if (!plan.possible) throw new Error(plan.issues.join('; '));
  const target = join(directory, 'held-before-error.mp4');
  await writeFile(target, 'previous result');
  let verificationCount = 0;
  await expect(cut(source, 'held-before-error.mp4', 0, 8, false, { ordinary: true, deferAudioContentToMerge: true, compatibleTimings: plan.segments, additionalSegments: [{ start: 8, end: 12, name: 'bad-later.mp4' }], onVerification: (id) => { if (id != null) verificationCount += 1; } })).rejects.toMatchObject({ name: 'ExportVerificationError' });
  expect(verificationCount).toBe(2);
  expect(await readFile(target, 'utf8')).toBe('previous result');
  const next = await beginOutputTransaction(target, true);
  expect(next.status).toBe('created');
  if (next.status === 'created') await releaseOutputTransaction(next.id);
}, 30000);
