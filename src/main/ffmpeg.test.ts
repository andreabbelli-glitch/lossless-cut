// eslint-disable-next-line import/no-extraneous-dependencies
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execa } from 'execa';

const injected = vi.hoisted(() => ({ producerFailurePath: undefined as string | undefined }));
vi.mock('electron', () => ({ app: { isPackaged: false }, clipboard: {}, nativeImage: {} }));
vi.mock('./util.js', () => ({ platform: process.platform, arch: process.arch, isWindows: process.platform === 'win32', isLinux: process.platform === 'linux' }));
vi.mock('./isDev.js', () => ({ default: false }));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('execa', async (importOriginal) => {
  const actual = await importOriginal<typeof import('execa')>();
  return {
    ...actual,
    execa(file: string, args: readonly string[], options: import('execa').Options) {
      if (injected.producerFailurePath != null && args.includes('-copyinkf')) {
        // A valid stream followed by a producer error: the PNG consumer can
        // succeed, but the operation must still fail.
        return actual.execa(process.execPath, ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(injected.producerFailurePath)}));setTimeout(()=>process.exit(7),100);`], options);
      }
      return actual.execa(file, args, options);
    },
  };
});

const ffmpeg = await import('./ffmpeg');
const bin = resolve('ffmpeg', `${process.platform}-${process.arch}`, ...(process.platform === 'win32' || process.platform === 'linux' ? ['lib'] : []));
let directory: string;
let scenes: string;
let vfr: string;
let audio: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'llc-media-regression-'));
  scenes = join(directory, 'scenes.mp4');
  vfr = join(directory, 'vfr.mp4');
  audio = join(directory, 'audio.mka');
  ffmpeg.setCustomFfPath(bin);
  await execa(ffmpeg.getFfmpegPath(), ['-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=128x96:r=25:d=1', '-f', 'lavfi', '-i', 'color=white:s=128x96:r=25:d=1', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-g', '25', scenes]);
  await execa(ffmpeg.getFfmpegPath(), ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=128x96:r=25:d=2', '-vf', String.raw`select=not(eq(mod(n\,3)\,1))`, '-fps_mode', 'vfr', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', vfr]);
  await execa(ffmpeg.getFfmpegPath(), ['-v', 'error', '-f', 'lavfi', '-i', 'sine=r=48000:d=2', '-c:a', 'aac', audio]);
}, 15000);

afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

test('scene detector preserves zero/one-change boundaries and rejects producer overflow', async () => {
  const params = { filePath: scenes, streamId: 0, from: 0, to: 2, ffmpegHwaccel: 'none' as const, onProgress: vi.fn() };
  const noChanges: { start: number, end: number }[] = [];
  await ffmpeg.detectSceneChanges({ ...params, minChange: 1, onSegmentDetected: (segment) => noChanges.push(segment) });
  expect(noChanges).toEqual([{ start: 0, end: 2 }]);
  const oneChange: { start: number, end: number }[] = [];
  await ffmpeg.detectSceneChanges({ ...params, minChange: 0.2, onSegmentDetected: (segment) => oneChange.push(segment) });
  expect(oneChange).toEqual([{ start: 0, end: 1 }, { start: 1, end: 2 }]);
  await expect(ffmpeg.detectSceneChanges({ ...params, minChange: 1, maxSegments: 0, onSegmentDetected: vi.fn() })).rejects.toThrow('Too many detected segments');
  await expect(ffmpeg.detectSceneChanges({ ...params, minChange: 0.2, maxSegments: 1, onSegmentDetected: vi.fn() })).rejects.toThrow('Too many detected segments');
});

test('streaming keyframe scan preserves exactly the direct FFprobe keyframe clock', async () => {
  const times = await ffmpeg.readKeyframeTimes({ filePath: scenes, from: 0, to: 2, streamIndex: 0 });
  const { stdout } = await ffmpeg.runFfprobe(['-v', 'error', '-select_streams', '0', '-show_packets', '-show_entries', 'packet=pts_time,flags', '-of', 'json', scenes]);
  const packets = JSON.parse(new TextDecoder().decode(stdout)) as { packets: { pts_time: string, flags: string }[] };
  expect(times).toEqual(packets.packets.filter((packet) => packet.flags.startsWith('K')).map((packet) => Number(packet.pts_time)).sort((a, b) => a - b));
});

test('a waveform producer error is rejected even if the consumer produced a valid PNG', async () => {
  injected.producerFailurePath = audio;
  try {
    await expect(ffmpeg.renderWaveformPng({ filePath: audio, color: '#ffffff', streamIndex: 0 })).rejects.toMatchObject({ exitCode: 7 });
  } finally {
    injected.producerFailurePath = undefined;
  }
});

test('capture timestamp filenames represent VFR presentation time for markers and filtered/unfiltered ranges', async () => {
  for (const [name, to, filter] of [['all', 0.6, undefined], ['filtered', 0.6, String.raw`select=not(mod(n\,2))`], ['marker', undefined, undefined]] as const) {
    const prefix = join(directory, `${name}-%d.png`);
    await ffmpeg.captureFrames({ from: 0.22, to, videoPath: vfr, outPathTemplate: prefix, quality: 0.9, filter, framePts: true, onProgress: vi.fn(), captureFormat: 'png' });
    const timestamps = (await readdir(directory)).filter((file) => file.startsWith(`${name}-`)).map((file) => Number(file.slice(name.length + 1, -4)) / 1000000).sort((a, b) => a - b);
    expect(timestamps.length).toBeGreaterThan(0);
    expect(timestamps[0]).toBeCloseTo(0.02, 6);
    const { stdout } = await ffmpeg.runFfprobe(['-v', 'error', '-show_frames', '-show_entries', 'frame=pts_time', '-of', 'json', vfr]);
    const frames = JSON.parse(new TextDecoder().decode(stdout)) as { frames: { pts_time: string }[] };
    for (const timestamp of timestamps) expect(frames.frames.some((frame) => Math.abs(Number(frame.pts_time) - (0.22 + timestamp)) < 0.000002)).toBe(true);
  }
});
