// eslint-disable-next-line import/no-extraneous-dependencies
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import type { FFprobeStream } from '../../../common/ffprobe';

vi.mock('electron', () => ({ app: { isPackaged: false }, clipboard: {}, nativeImage: {} }));
vi.mock('../../../main/util.js', () => ({ platform: process.platform, arch: process.arch, isWindows: process.platform === 'win32', isLinux: process.platform === 'linux' }));
vi.mock('../../../main/isDev.js', () => ({ default: false }));
vi.mock('../../../main/logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('react', () => ({ useCallback: (callback: unknown) => callback }));
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
  return { default: {
    ...await import('../../../main/outputTransaction.js'),
    ...await import('../../../main/outputPathIdentity.js'),
    ...await import('../../../main/compatibleCuts.js'),
    ...await import('../../../main/exportVerification.js'),
    pathExists: async (path: string) => fs.access(path).then(() => true, () => false),
  } };
});
vi.mock('../ffmpeg', async () => {
  const native = await import('../../../main/ffmpeg');
  const readMetadata = async (path: string) => {
    const { stdout } = await native.runFfprobe(['-v', 'error', '-show_streams', '-show_format', '-show_chapters', '-of', 'json', path]);
    return JSON.parse(Buffer.from(stdout).toString());
  };
  return {
    ...native,
    readFileFfprobeMeta: readMetadata,
    createFileMetadataReader: () => readMetadata,
    getDuration: async (path: string) => Number((await readMetadata(path)).format.duration),
    isCuttingStart: (time: number) => time > 0,
    isCuttingEnd: (time: number, duration: number) => time < duration,
    getExperimentalArgs: () => [],
    getVideoTimescaleArgs: (clock: number | undefined) => (clock == null ? [] : ['-video_track_timescale', String(clock)]),
    logStdoutStderr: vi.fn(),
    RefuseOverwriteError: class extends Error {},
    createChaptersFromSegments: vi.fn(),
  };
});

vi.stubGlobal('window', { require: () => fsPromises });
const ffmpeg = await import('../../../main/ffmpeg');
const { verifyExport, getExportVerificationState } = await import('../../../main/exportVerification');
const { getCompatibleTimingArgs, planCompatibleCuts } = await import('../../../main/compatibleCuts');
const { default: useFfmpegOperations } = await import('./useFfmpegOperations');
let directory: string;
let retainEvidence = false;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'llc-verifier-integration-'));
  ffmpeg.setCustomFfPath(resolve('ffmpeg', `${process.platform}-${process.arch}`, ...(process.platform === 'win32' || process.platform === 'linux' ? ['lib'] : [])));
});
afterAll(async () => {
  if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('llc-verifier-integration-')) throw new Error('Unexpected fixture directory');
  // eslint-disable-next-line no-console -- Failed media regressions retain only their synthetic reproduction files.
  if (retainEvidence) console.info('Synthetic verification evidence retained:', directory);
  else await rm(directory, { recursive: true, force: true });
});

test('a dropped independently decoded frame at a verified boundary cannot pass', async () => {
  const source = join(directory, 'all-intra.mp4');
  const missing = join(directory, 'missing-frame.mp4');
  await ffmpeg.runFfmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=128x96:r=25:d=4', '-f', 'lavfi', '-i', 'sine=r=48000:d=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '1', '-threads', '1', '-c:a', 'aac', source]);
  await ffmpeg.runFfmpeg(['-v', 'error', '-copyts', '-i', source, '-c', 'copy', '-bsf:v', "noise=drop='eq(pts,1536)'", missing]);
  const result = await verifyExport({ id: 'missing-boundary-frame', path: missing, sources: [{ path: source }], merged: true });
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'failed' });
}, 30000);

test('twelve Main10 VFR parts preserve an inherited offset and both AAC tracks at eleven joins', async () => {
  retainEvidence = true;
  const source = join(directory, 'main10-vfr-multitrack.mp4');
  await ffmpeg.runFfmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=96x64:r=30:d=96', '-f', 'lavfi', '-i', 'anoisesrc=r=48000:d=96:seed=42', '-f', 'lavfi', '-i', 'anoisesrc=color=pink:r=48000:d=96:seed=84', '-map', '0:v', '-map', '1:a', '-map', '2:a', '-vf', "select='if(lt(mod(t,4),2),1,not(mod(n,2)))',settb=1/60000,setpts=PTS+1080", '-fps_mode', 'passthrough', '-c:v', 'libx265', '-preset', 'slow', '-crf', '26', '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1', '-x265-params', 'pools=1:frame-threads=1:keyint=600:min-keyint=1:scenecut=0:open-gop=0:log-level=error', '-force_key_frames', 'expr:gte(t,n_forced*8)', '-enc_time_base:v', '1/60000', '-video_track_timescale', '60000', '-c:a', 'aac', '-movie_timescale', '240000', source]);
  const ranges = Array.from({ length: 12 }, (_, index) => ({ start: (index * 8) + 2, end: (index * 8) + 6 }));
  const plan = await planCompatibleCuts({ path: source, segments: ranges, streamIds: [0, 1, 2] });
  expect(plan.possible, JSON.stringify(plan)).toBe(true);
  const parts: string[] = [];
  for (const [index, segment] of plan.segments.entries()) {
    const path = join(directory, `many-part${index}.mp4`);
    parts.push(path);
    const timing = getCompatibleTimingArgs(segment);
    await ffmpeg.runFfmpeg([...timing.beforeInput, '-i', source, ...timing.afterInput, '-map', '0', '-c', 'copy', ...timing.filters.flatMap((filter) => [`-bsf:${filter.streamIndex}`, filter.expression]), path]);
  }
  const merged = join(directory, 'many-merged.mp4');
  const references = parts.map((path, index) => ({ path, origins: [{ path: source, start: plan.segments[index]!.start, end: plan.segments[index]!.end, streamIds: [0, 1, 2] }] }));
  const { stdout: metadataJson } = await ffmpeg.runFfprobe(['-v', 'error', '-show_streams', '-of', 'json', parts[0]!]);
  const { streams } = JSON.parse(Buffer.from(metadataJson).toString()) as { streams: FFprobeStream[] };
  let verificationId: string | undefined;
  // Identity useCallback executes the actual production export hook. The common
  // spans come from proved GOP/AAC boundaries, including their CLI quantization.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const operations = useFfmpegOperations({ filePath: source, isEncoding: false, lossyMode: undefined, enableOverwriteOutput: true, outputPlaybackRate: 1, cutFromAdjustmentFrames: 0, cutToAdjustmentFrames: 0, appendLastCommandsLog: vi.fn(), appendFfmpegCommandLog: vi.fn(), encCustomBitrate: undefined, ffmpegHwaccel: 'none', treatInputFileModifiedTimeAsStart: false, treatOutputFileModifiedTimeAsStart: false });
  const outcome = await operations.concatFiles({ paths: parts, outDir: directory, outPath: merged, metadataFromPath: parts[0]!, includeAllStreams: true, streams, outFormat: 'mp4', ffmpegExperimental: false, preserveMovData: true, movFastStart: false, chapters: undefined, preserveMetadataOnMerge: true, verificationSources: references, certifiedDurations: plan.segments.map((segment) => segment.duration), onVerification: (id) => { if (id != null) verificationId = id; } });
  expect(outcome).toMatchObject({ status: 'created', validated: true });
  const packets = async (path: string) => {
    const { stdout } = await ffmpeg.runFfprobe(['-v', 'error', '-show_packets', '-show_data_hash', 'sha256', '-show_entries', 'packet=stream_index,pts,dts,duration,data_hash:packet_side_data=skip_samples,discard_padding', '-of', 'json', path]);
    return (JSON.parse(Buffer.from(stdout).toString()) as { packets: { stream_index: number }[] }).packets;
  };
  const before = await packets(source);
  const after = await packets(merged);
  for (const index of [0, 1, 2]) expect(after.filter((packet) => packet.stream_index === index)).toEqual(before.filter((packet) => packet.stream_index === index));
  const result = getExportVerificationState(verificationId!)?.result;
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'passed', coverage: { structure: true, packetTimestamps: true, boundaries: true } });
  const extraContent = await verifyExport({ id: 'full-source-spoofing-first-part', path: source, sources: [references[0]!], merged: true });
  expect(extraContent, JSON.stringify(extraContent)).toMatchObject({ status: 'failed' });
  const noDurationList = join(directory, 'no-certified-durations.txt');
  await writeFile(noDurationList, parts.slice(0, 3).map((path) => `file '${path.replaceAll('\\', '/')}'`).join('\n'));
  const noDuration = join(directory, 'no-certified-durations.mp4');
  await ffmpeg.runFfmpeg(['-copyts', '-f', 'concat', '-safe', '0', '-i', noDurationList, '-map', '0', '-c', 'copy', '-movie_timescale', '240000', '-movflags', '+negative_cts_offsets', noDuration]);
  const unprovedSpans = await verifyExport({ id: 'uncertified-container-spans', path: noDuration, sources: references.slice(0, 3), merged: true });
  expect(unprovedSpans, JSON.stringify(unprovedSpans)).not.toMatchObject({ status: 'passed' });
  expect(unprovedSpans.issues.some((issue) => issue.includes('duration') || issue.includes('gap'))).toBe(true);
  const skewed = join(directory, 'many-second-audio-skewed.mp4');
  await ffmpeg.runFfmpeg(['-v', 'error', '-copyts', '-i', merged, '-itsoffset', '0.018', '-i', merged, '-map', '0:v', '-map', '0:a:0', '-map', '1:a:1', '-c', 'copy', '-movie_timescale', '240000', skewed]);
  const skewedResult = await verifyExport({ id: 'second-audio-new-skew', path: skewed, sources: [{ path: merged }], merged: false });
  expect(skewedResult, JSON.stringify(skewedResult)).toMatchObject({ status: 'failed' });
  expect(skewedResult.issues.some((issue) => issue.includes('common audio/video timeline shift'))).toBe(true);
  // Removing source intervals changes the AAC overlap state at a discontinuity.
  // Matching copied payload alone cannot certify the original decoded samples.
  const discontinuousIndices = [0, 2, 4];
  const discontinuousList = join(directory, 'discontinuous-parts.txt');
  await writeFile(discontinuousList, discontinuousIndices.map((index) => `file '${parts[index]!.replaceAll('\\', '/')}'\nduration 8`).join('\n'));
  const discontinuous = join(directory, 'discontinuous.mp4');
  await ffmpeg.runFfmpeg(['-copyts', '-f', 'concat', '-safe', '0', '-i', discontinuousList, '-map', '0', '-c', 'copy', '-movie_timescale', '240000', '-movflags', '+negative_cts_offsets', discontinuous]);
  const discontinuousResult = await verifyExport({ id: 'colored-noise-discontinuous-aac', path: discontinuous, sources: discontinuousIndices.map((index) => references[index]!), merged: true });
  expect(discontinuousResult, JSON.stringify(discontinuousResult)).not.toMatchObject({ status: 'passed' });
  expect(discontinuousResult.issues.some((issue) => issue.includes('audio'))).toBe(true);
  retainEvidence = false;
}, 180000);
