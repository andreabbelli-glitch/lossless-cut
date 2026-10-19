// eslint-disable-next-line import/no-extraneous-dependencies
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

vi.mock('electron', () => ({ app: { isPackaged: false }, clipboard: {}, nativeImage: {} }));
vi.mock('./util.js', () => ({ platform: process.platform, arch: process.arch, isWindows: process.platform === 'win32', isLinux: process.platform === 'linux' }));
vi.mock('./isDev.js', () => ({ default: false }));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const ffmpeg = await import('./ffmpeg');
const { verifyExport } = await import('./exportVerification');
let directory: string;
let source: string;
let converted: string;
let skewed: string;
let changed: string;
let flac: string;
let flacCut: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'llc-audio-conversion-'));
  source = join(directory, 'source.mov');
  converted = join(directory, 'converted.mov');
  skewed = join(directory, 'skewed.mov');
  changed = join(directory, 'changed.mov');
  flac = join(directory, 'source.mkv');
  flacCut = join(directory, 'flac-cut.mkv');
  ffmpeg.setCustomFfPath(resolve('ffmpeg', `${process.platform}-${process.arch}`, ...(process.platform === 'win32' || process.platform === 'linux' ? ['lib'] : [])));
  await ffmpeg.runFfmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=128x96:r=25:d=3', '-f', 'lavfi', '-i', 'anoisesrc=r=48000:d=3:seed=42:color=pink', '-c:v', 'libx264', '-preset', 'ultrafast', '-bf', '0', '-g', '25', '-threads', '1', '-c:a', 'pcm_s24le', source]);
  await ffmpeg.runFfmpeg(['-v', 'error', '-copyts', '-i', source, '-map', '0', '-c:v', 'copy', '-c:a', 'pcm_s32le', converted]);
  await ffmpeg.runFfmpeg(['-v', 'error', '-copyts', '-i', converted, '-itsoffset', '0.018', '-i', converted, '-map', '0:v', '-map', '1:a', '-c', 'copy', '-movie_timescale', '192000', skewed]);
  await ffmpeg.runFfmpeg(['-v', 'error', '-copyts', '-i', source, '-map', '0', '-c:v', 'copy', '-af', 'volume=0.5', '-c:a', 'pcm_s32le', changed]);
  await ffmpeg.runFfmpeg(['-v', 'error', '-i', source, '-map', '0', '-c:v', 'copy', '-c:a', 'flac', flac]);
  await ffmpeg.runFfmpeg(['-v', 'error', '-ss', '0.37', '-i', flac, '-t', '2.04', '-map', '0', '-c:v', 'copy', '-c:a', 'flac', '-avoid_negative_ts', 'make_zero', flacCut]);
}, 30000);

afterAll(async () => {
  if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('llc-audio-conversion-')) throw new Error('Unexpected audio conversion fixture directory');
  await rm(directory, { recursive: true, force: true });
});

test('explicit PCM bit-depth conversion proves full-width samples and one common clock', async () => {
  const result = await verifyExport({ id: 'pcm-conversion', path: converted, sources: [{ path: source }], merged: false, reencodedAudioStreamIds: [1], expectedStreams: [{}, { codec_name: 'pcm_s32le' }] });
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'passed' });
}, 30000);

test('changed audio packets never infer permission to convert', async () => {
  const result = await verifyExport({ id: 'undeclared-pcm-conversion', path: converted, sources: [{ path: source }], merged: false, expectedStreams: [{}, { codec_name: 'pcm_s32le' }] });
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'failed' });
}, 30000);

test('a FLAC trim may change packet framing while retaining exact samples', async () => {
  const result = await verifyExport({ id: 'flac-cut', path: flacCut, sources: [{ path: flac, start: 0.37, end: 2.41 }], merged: false, reencodedAudioStreamIds: [1] });
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'passed' });
}, 30000);

test('declared PCM conversion never permits a new 18 ms offset or different waveform', async () => {
  const options = { sources: [{ path: source }], merged: false, reencodedAudioStreamIds: [1], expectedStreams: [{}, { codec_name: 'pcm_s32le' }] };
  const skew = await verifyExport({ ...options, id: 'pcm-skew', path: skewed });
  expect(skew, JSON.stringify(skew)).toMatchObject({ status: 'failed' });
  const waveform = await verifyExport({ ...options, id: 'pcm-waveform', path: changed });
  expect(waveform, JSON.stringify(waveform)).toMatchObject({ status: 'failed' });
}, 30000);
