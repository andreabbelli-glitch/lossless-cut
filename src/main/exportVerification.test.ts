// eslint-disable-next-line import/no-extraneous-dependencies
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { execa } from 'execa';

vi.mock('electron', () => ({ app: { isPackaged: false }, clipboard: {}, nativeImage: {} }));
vi.mock('./util.js', () => ({ platform: process.platform, arch: process.arch, isWindows: process.platform === 'win32', isLinux: process.platform === 'linux' }));
vi.mock('./isDev.js', () => ({ default: false }));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const ffmpeg = await import('./ffmpeg');
const { verifyExport, compareBoundaryShifts, compareAudioSamples, cancelExportVerification, compressionMarkers } = await import('./exportVerification');
let directory: string;
let source: string;
let copied: string;
let shifted: string;
let inherited: string;
let nonzero: string;
let nonzeroCopy: string;
let main10: string;
let main10Reencoded: string;
let parts: string[];
let merged: string;
let alignedCut: string;
let offKeyCut: string;
let singleMerged: string;
let scaledVideo: string;
let differentAudio: string;
let exactVideoCut: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'llc-verify-'));
  source = join(directory, 'source.mp4');
  copied = join(directory, 'copy.mp4');
  shifted = join(directory, 'shifted.mp4');
  inherited = join(directory, 'inherited.mp4');
  nonzero = join(directory, 'nonzero.mp4');
  nonzeroCopy = join(directory, 'nonzero-copy.mp4');
  main10 = join(directory, 'main10.mp4');
  main10Reencoded = join(directory, 'main10-reencoded.mp4');
  parts = [join(directory, 'part0.mp4'), join(directory, 'part1.mp4')];
  merged = join(directory, 'merged.mp4');
  alignedCut = join(directory, 'aligned-cut.mp4');
  offKeyCut = join(directory, 'off-key-cut.mp4');
  singleMerged = join(directory, 'single-merged.mp4');
  scaledVideo = join(directory, 'scaled-video.mp4');
  differentAudio = join(directory, 'different-audio.mp4');
  exactVideoCut = join(directory, 'exact-video-cut.mp4');
  ffmpeg.setCustomFfPath(resolve('ffmpeg', `${process.platform}-${process.arch}`, ...(process.platform === 'win32' || process.platform === 'linux' ? ['lib'] : [])));
  const bin = ffmpeg.getFfmpegPath();
  await execa(bin, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=128x96:r=30:d=3', '-f', 'lavfi', '-i', 'sine=r=48000:d=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-bf', '2', '-g', '30', '-threads', '1', '-c:a', 'aac', source]);
  await execa(bin, ['-v', 'error', '-i', source, '-c', 'copy', copied]);
  await execa(bin, ['-v', 'error', '-i', source, '-itsoffset', '0.018', '-i', source, '-map', '0:v', '-map', '1:a', '-c', 'copy', shifted]);
  await execa(bin, ['-v', 'error', '-copyts', '-i', shifted, '-c', 'copy', inherited]);
  await execa(bin, ['-v', 'error', '-copyts', '-i', source, '-output_ts_offset', '5', '-c', 'copy', nonzero]);
  await execa(bin, ['-v', 'error', '-copyts', '-i', nonzero, '-c', 'copy', nonzeroCopy]);
  const encoding = ['-c:v', 'libx265', '-preset', 'slow', '-crf', '26', '-pix_fmt', 'yuv420p10le', '-x265-params', 'pools=1:frame-threads=1:open-gop=0:keyint=30:bframes=2', '-tag:v', 'hvc1', '-c:a', 'copy'];
  await execa(bin, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=128x96:r=30:d=8', '-f', 'lavfi', '-i', 'sine=r=48000:d=8', ...encoding, '-c:a', 'aac', main10]);
  await execa(bin, ['-v', 'error', '-i', main10, ...encoding, main10Reencoded]);
  await execa(bin, ['-v', 'error', '-i', source, '-t', '1', '-c', 'copy', parts[0]!]);
  await execa(bin, ['-v', 'error', '-ss', '1', '-i', source, '-t', '1', '-avoid_negative_ts', 'make_zero', '-c', 'copy', parts[1]!]);
  const list = join(directory, 'parts.txt');
  await writeFile(list, parts.map((path) => `file '${path.replaceAll('\\', '/')}'`).join('\n'));
  await execa(bin, ['-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', merged]);
  await execa(bin, ['-v', 'error', '-ss', '2', '-i', main10, '-t', '4', '-avoid_negative_ts', 'make_zero', '-c', 'copy', alignedCut]);
  await execa(bin, ['-v', 'error', '-ss', '2.37', '-i', main10, '-t', '4.04', '-avoid_negative_ts', 'make_zero', '-c', 'copy', offKeyCut]);
  await execa(bin, ['-v', 'error', '-ss', '2', '-i', main10, '-t', '4', '-map', '0:v', '-avoid_negative_ts', 'make_zero', '-c', 'copy', '-bsf:v', "noise=drop='gte(pts,61440)'", exactVideoCut]);
  const singleList = join(directory, 'single-list.txt');
  await writeFile(singleList, `file '${main10.replaceAll('\\', '/')}'`);
  await execa(bin, ['-v', 'error', '-copyts', '-f', 'concat', '-safe', '0', '-i', singleList, '-c', 'copy', singleMerged]);
  await execa(bin, ['-v', 'error', '-itsscale', '0.8', '-i', source, '-map', '0:v', '-c', 'copy', scaledVideo]);
  await execa(bin, ['-v', 'error', '-i', source, '-f', 'lavfi', '-i', 'sine=f=880:r=48000:d=3', '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', differentAudio]);
}, 30000);

afterAll(async () => {
  if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('llc-verify-')) throw new Error('Unexpected verification fixture directory');
  await rm(directory, { recursive: true, force: true });
});

test('one common shift retains inherited offsets and rejects new 18 ms skew', () => {
  expect(compareBoundaryShifts([{ type: 'audio', shifts: [4, 4], quantum: 1 / 48000 }, { type: 'video', shifts: [4.0005, 4.0005], quantum: 1 / 15360 }]).valid).toBe(true);
  expect(compareBoundaryShifts([{ type: 'audio', shifts: [4.018, 4.018], quantum: 1 / 48000 }, { type: 'video', shifts: [4, 4], quantum: 1 / 15360 }]).valid).toBe(false);
});

test('PCM amplitude quantization never permits a different waveform or sample count', () => {
  const stream = { index: 0, codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 1, time_base: '1/48000' };
  const frame = { pts: 0, duration: 3 / 48000, hash: 'pcm16', samples: new Int16Array([10, 20, 30]) };
  expect(compareAudioSamples([frame], [{ ...frame, samples: new Int16Array([11, 19, 30]) }], 0, 1, stream)).toMatchObject({ complete: true, equal: true, count: 3 });
  expect(compareAudioSamples([frame], [{ ...frame, samples: new Int16Array([10, 200, 30]) }], 0, 1, stream)).toMatchObject({ equal: false });
  expect(compareAudioSamples([frame], [{ ...frame, samples: new Int16Array([10, 20, 30, 40]) }], 0, 1, stream)).toMatchObject({ complete: false });
  expect(compareAudioSamples([frame], [{ ...frame, samples: new Int16Array([10, 20]) }], 0, 1, stream)).toMatchObject({ complete: false });
});

test('compression UUID/profile accepts its comment fallback and rejects contradictions', () => {
  const id = '12345678-1234-1234-1234-123456789abc';
  const profile = 'hevc-main10-crf26-slow-v1';
  const comment = `Existing user comment\nSTASH-COMPRESSION:v1:${id}:${profile}`;
  expect(compressionMarkers({ COMMENT: comment })).toEqual(new Set([`${id}:${profile}`]));
  expect(compressionMarkers({ stash_compression: JSON.stringify({ id, profile, version: 1, generation: 1 }), comment })).toEqual(new Set([`${id}:${profile}`]));
  expect(() => compressionMarkers({ stash_compression: JSON.stringify({ id, profile: 'other', version: 1, generation: 1 }), comment })).toThrow('Contradictory');
  expect(compressionMarkers({ comment: `${comment}\nSTASH-COMPRESSION:v1:87654321-1234-1234-1234-123456789abc:${profile}` }, true)).toHaveLength(2);
});

test('real stream copy validates content with direct decoder clocks', async () => {
  const result = await verifyExport({ id: 'copy', path: copied, sources: [{ path: source }], merged: false });
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'passed', coverage: { structure: true, packetTimestamps: false, boundaries: true } });
}, 30000);

test('extra output tracks cannot pass a narrower selected source structure', async () => {
  const result = await verifyExport({ id: 'extra-track', path: copied, sources: [{ path: source, streamIds: [0] }], merged: false });
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'failed' });
  expect(result.issues).toContain('Output track count differs from the selected source tracks');
}, 30000);

test('a different waveform with the same stream clocks fails', async () => {
  const result = await verifyExport({ id: 'different-waveform', path: differentAudio, sources: [{ path: source }], merged: false });
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'failed' });
  expect(result.issues).toContain('Cut lost selected audio boundary packet content');
}, 30000);

test('new audio/video skew fails and cancellation preserves an inconclusive result', async () => {
  const result = await verifyExport({ id: 'skew', path: shifted, sources: [{ path: source }], merged: false });
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'failed' });
  expect(result.issues.some((issue) => issue.includes('common audio/video timeline shift'))).toBe(true);
  const pending = verifyExport({ id: 'cancel', path: copied, sources: [{ path: source }], merged: false });
  cancelExportVerification('cancel');
  expect(await pending).toMatchObject({ status: 'inconclusive', cancelled: true });
}, 30000);

test('separate selected inputs still require one common timeline shift', async () => {
  const sources = [{ path: source, streamIds: [0] }, { path: copied, streamIds: [1] }];
  const valid = await verifyExport({ id: 'multi-input-copy', path: copied, sources, merged: false });
  expect(valid, JSON.stringify(valid)).toMatchObject({ status: 'passed' });
  const invalid = await verifyExport({ id: 'multi-input-skew', path: shifted, sources, merged: false });
  expect(invalid, JSON.stringify(invalid)).toMatchObject({ status: 'failed' });
  expect(invalid.issues).toContain('Selected inputs no longer share one common audio/video timeline shift');
}, 30000);

test('existing source offsets and nonzero absolute origins survive one common shift', async () => {
  const existing = await verifyExport({ id: 'existing-offset', path: inherited, sources: [{ path: shifted }], merged: false });
  expect(existing, JSON.stringify(existing)).toMatchObject({ status: 'passed' });
  const origin = await verifyExport({ id: 'nonzero', path: nonzeroCopy, sources: [{ path: nonzero }], merged: false });
  expect(origin, JSON.stringify(origin)).toMatchObject({ status: 'passed' });
}, 30000);

test('Main10 re-encoding retains recognizable boundary content, frame clocks and copied audio', async () => {
  const result = await verifyExport({ id: 'main10-reencoded', path: main10Reencoded, sources: [{ path: main10 }], merged: false, reencodedVideo: true });
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'passed', coverage: { perceptualVideo: true } });
}, 30000);

test('a real AAC concat regression fails priming verification on matching packet lineage', async () => {
  const result = await verifyExport({ id: 'merge-priming', path: merged, sources: parts.map((path) => ({ path })), merged: true });
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'failed', coverage: { packetTimestamps: true } });
  expect(result.issues.some((issue) => issue.includes('priming'))).toBe(true);
}, 30000);

test('actual presented Main10 B-tail frames and an off-key AAC reset are rejected', async () => {
  const aligned = await verifyExport({ id: 'aligned-cut', path: alignedCut, sources: [{ path: main10, start: 2, end: 6 }], merged: false });
  expect(aligned, JSON.stringify(aligned)).toMatchObject({ status: 'failed' });
  expect(aligned.issues).toContain('Cut presents video frames beyond the selected end boundary');
  const exact = await verifyExport({ id: 'exact-video-cut', path: exactVideoCut, sources: [{ path: main10, start: 2, end: 6, streamIds: [0] }], merged: false });
  expect(exact, JSON.stringify(exact)).toMatchObject({ status: 'passed' });
  const offKey = await verifyExport({ id: 'off-key-cut', path: offKeyCut, sources: [{ path: main10, start: 2.37, end: 6.41 }], merged: false });
  expect(offKey, JSON.stringify(offKey)).toMatchObject({ status: 'failed' });
  expect(offKey.issues.some((issue) => issue.startsWith('Decoded audio boundary samples differ'))).toBe(true);
  const bin = ffmpeg.getFfmpegPath();
  const packets = async (path: string) => {
    const { stdout } = await ffmpeg.runFfprobe(['-v', 'error', '-select_streams', 'a:0', '-show_packets', '-show_data_hash', 'sha256', '-show_entries', 'packet=pts,data_hash', '-of', 'json', path]);
    return (JSON.parse(new TextDecoder().decode(stdout)) as { packets: { pts: number, data_hash: string }[] }).packets;
  };
  const originals = new Map((await packets(main10)).map((packet) => [packet.data_hash, packet]));
  const first = (await packets(offKeyCut))[0]!;
  const startSample = originals.get(first.data_hash)!.pts - first.pts;
  const pcm = async (path: string) => Buffer.from((await execa(bin, ['-v', 'error', '-i', path, '-map', '0:a:0', '-c:a', 'pcm_s16le', '-f', 's16le', '-'], { encoding: 'buffer' })).stdout);
  const referencePcm = await pcm(main10);
  const actualPcm = await pcm(offKeyCut);
  expect(Array.from({ length: 1024 }, (_, index) => Math.abs(referencePcm.readInt16LE((startSample + index) * 2) - actualPcm.readInt16LE(index * 2))).some((difference) => difference > 1)).toBe(true);
}, 30000);

test('a valid Main10 concat with copyts passes the complete packet scan', async () => {
  const result = await verifyExport({ id: 'single-concat', path: singleMerged, sources: [{ path: main10 }], merged: true });
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'passed', coverage: { packetTimestamps: true } });
}, 30000);

test('an unchanged complete source cannot certify a requested interior cut', async () => {
  for (const [id, start, end, reencodedVideo] of [['interior', 1, 7, false], ['wrong-start', 1, undefined, false], ['wrong-end', 0, 6, false], ['reencoded', 1, 7, true]] as const) {
    const result = await verifyExport({ id: `uncut-source-${id}`, path: main10, sources: [{ path: main10, start, ...(end == null ? {} : { end }) }], merged: false, reencodedVideo });
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'failed' });
  }
}, 30000);

test('an intentional video playback scale uses the requested source clock mapping', async () => {
  const result = await verifyExport({ id: 'scaled-video', path: scaledVideo, sources: [{ path: source, streamIds: [0] }], merged: false, timeScale: 1.25 });
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'passed' });
}, 30000);
