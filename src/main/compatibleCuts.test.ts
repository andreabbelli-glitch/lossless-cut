// eslint-disable-next-line import/no-extraneous-dependencies
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

vi.mock('electron', () => ({ app: { isPackaged: false }, clipboard: {}, nativeImage: {} }));
vi.mock('./util.js', () => ({ platform: process.platform, arch: process.arch, isWindows: process.platform === 'win32', isLinux: process.platform === 'linux' }));
vi.mock('./isDev.js', () => ({ default: false }));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const ffmpeg = await import('./ffmpeg');
const { checkCompatibleSource, chooseCompatibleRanges, getCompatibleTimingArgs, isClosedRandomAccess, planCompatibleCuts, planVideoCopyRange } = await import('./compatibleCuts');
const bin = resolve('ffmpeg', `${process.platform}-${process.arch}`, ...(process.platform === 'win32' || process.platform === 'linux' ? ['lib'] : []));
let directory: string;
let source: string;
const marker = '{"version":1,"id":"00000000-0000-4000-8000-000000000042","profile":"hevc-main10-crf26-slow-v1","generation":1}';

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'llc-compatible-regression-'));
  source = join(directory, 'main10-offset18ms.mp4');
  ffmpeg.setCustomFfPath(bin);
  await ffmpeg.runFfmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=128x96:r=30:d=24', '-f', 'lavfi', '-i', 'sine=r=48000:d=24', '-vf', 'settb=1/60000,setpts=PTS+1080', '-enc_time_base:v', '1/60000', '-video_track_timescale', '60000', '-fps_mode', 'passthrough', '-c:v', 'libx265', '-preset', 'slow', '-crf', '26', '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1', '-x265-params', 'pools=1:frame-threads=1:keyint=60:min-keyint=60:scenecut=0:open-gop=0:log-level=error', '-c:a', 'aac', '-movie_timescale', '240000', '-metadata', `stash_compression=${marker}`, '-metadata', 'comment=existing synthetic comment STASH-COMPRESSION:test42', '-movflags', '+faststart+use_metadata_tags', source]);
}, 30000);

afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

test('compatible alternatives are explicit and non-overlapping instead of silently changing selections', () => {
  expect(chooseCompatibleRanges([0, 8, 16, 24], [{ start: 2, end: 6 }, { start: 8, end: 12 }, { start: 14, end: 18 }])).toEqual([{ start: 0, end: 8 }, { start: 8, end: 16 }, { start: 16, end: 24 }]);
  expect(chooseCompatibleRanges([0, 8, 16], [{ start: 5, end: 6 }])).toEqual([{ start: 0, end: 8 }]);
  expect(chooseCompatibleRanges([0, 24], [{ start: 2, end: 6 }, { start: 8, end: 12 }])).toBeUndefined();
});

test('HEVC CRA is not accepted as a proven closed GOP; IDR and AVC IDR are', () => {
  expect(isClosedRandomAccess(new Uint8Array([0, 0, 0, 2, 40, 1]), 'hevc', 4)).toBe(true);
  expect(isClosedRandomAccess(new Uint8Array([0, 0, 0, 2, 36, 1]), 'hevc', 4)).toBe(true);
  expect(isClosedRandomAccess(new Uint8Array([0, 0, 0, 2, 38, 1]), 'hevc', 4)).toBe(false);
  expect(isClosedRandomAccess(new Uint8Array([0, 0, 0, 2, 42, 1]), 'hevc', 4)).toBe(false);
  expect(isClosedRandomAccess(new Uint8Array([0, 0, 0, 1, 5]), 'h264', 4)).toBe(true);
  expect(isClosedRandomAccess(new Uint8Array([0, 0, 0, 1, 1]), 'h264', 4)).toBe(false);
});

test('Main10 compatible cuts preserve packet content, 18ms source offset, AAC priming, frames and sample clocks', async () => {
  const plan = await planCompatibleCuts({ path: source, segments: [{ start: 2, end: 6 }, { start: 8, end: 12 }, { start: 14, end: 18 }], streamIds: [0, 1] });
  expect(plan.issues).toEqual([]);
  expect(plan.possible).toBe(true);
  expect(plan.segments.map(({ start, end }) => ({ start, end }))).toEqual([{ start: 0, end: 8 }, { start: 8, end: 16 }, { start: 16, end: 24 }]);
  const paths: string[] = [];
  for (const [index, segment] of plan.segments.entries()) {
    const path = join(directory, `part-${index}.mp4`);
    paths.push(path);
    const timing = getCompatibleTimingArgs(segment);
    await ffmpeg.runFfmpeg([...timing.beforeInput, '-i', source, ...timing.afterInput, '-map', '0', '-c', 'copy', ...timing.filters.flatMap((filter) => [`-bsf:${filter.streamIndex}`, filter.expression]), '-movflags', '+faststart+use_metadata_tags', path]);
    const { stdout } = await ffmpeg.runFfprobe(['-v', 'error', '-select_streams', 'a:0', '-read_intervals', '%+#1', '-show_packets', '-of', 'json', path]);
    const packet = (JSON.parse(Buffer.from(stdout).toString()) as { packets: { pts: number, side_data_list?: { skip_samples: number }[] }[] }).packets[0]!;
    expect(packet.pts).toBe(index === 0 ? -1024 : 0);
    expect(packet.side_data_list?.[0]?.skip_samples ?? 0).toBe(index === 0 ? 1024 : 0);
  }
  const concat = join(directory, 'parts.txt');
  await writeFile(concat, paths.map((path, index) => `file '${path.replaceAll('\\', '/')}'\nduration ${plan.segments[index]!.duration}`).join('\n'));
  const merged = join(directory, 'merged.mp4');
  await ffmpeg.runFfmpeg(['-copyts', '-f', 'concat', '-safe', '0', '-i', concat, '-i', paths[0]!, '-map', '0', '-map_metadata', '1', '-c', 'copy', '-movie_timescale', String(plan.segments[0]!.movieTimescale), '-movflags', '+faststart+use_metadata_tags', merged]);
  const read = async (path: string) => {
    const { stdout } = await ffmpeg.runFfprobe(['-v', 'error', '-show_packets', '-show_streams', '-show_format', '-show_data_hash', 'sha256', '-of', 'json', path]);
    return JSON.parse(Buffer.from(stdout).toString()) as { packets: { stream_index: number, pts: number, dts: number, data_hash: string, side_data_list?: { skip_samples?: number }[] }[], streams: { time_base: string, profile: string, codec_tag_string: string }[], format: { tags: Record<string, string> } };
  };
  const original = await read(source);
  const result = await read(merged);
  expect(result.streams[0]).toMatchObject({ profile: 'Main 10', codec_tag_string: 'hvc1' });
  expect(result.format.tags['stash_compression']).toBe(marker);
  expect(result.format.tags['comment']).toBe(original.format.tags['comment']);
  for (const index of [0, 1]) {
    const before = original.packets.filter((packet) => packet.stream_index === index);
    const after = result.packets.filter((packet) => packet.stream_index === index);
    expect(after.map((packet) => packet.data_hash)).toEqual(before.map((packet) => packet.data_hash));
    expect(after.map((packet) => packet.pts)).toEqual(before.map((packet) => packet.pts));
    expect(after.map((packet) => packet.dts)).toEqual(before.map((packet) => packet.dts));
  }
  expect(result.packets.find((packet) => packet.stream_index === 1)?.side_data_list?.[0]?.skip_samples).toBe(1024);
  const { stdout } = await ffmpeg.runFfprobe(['-v', 'error', '-show_frames', '-show_entries', 'frame=stream_index,pts_time,nb_samples', '-of', 'json', merged]);
  const { frames } = JSON.parse(Buffer.from(stdout).toString()) as { frames: { stream_index: number, pts_time: string, nb_samples?: number }[] };
  const video = frames.filter((frame) => frame.stream_index === 0);
  const audio = frames.filter((frame) => frame.stream_index === 1);
  expect(video).toHaveLength(720);
  expect(Number(video[0]!.pts_time)).toBe(0.018);
  expect(audio.reduce((count, frame) => count + frame.nb_samples!, 0)).toBe(1152000);
  for (const [index, frame] of video.entries()) expect(Number(frame.pts_time)).toBeCloseTo(0.018 + index / 30, 5);
  for (const [index, frame] of audio.entries()) expect(Number(frame.pts_time)).toBeCloseTo((index * 1024) / 48000, 5);
  expect((await readFile(merged)).byteLength).toBeGreaterThan(0);
}, 30000);

test('an operation cancelled before analysis stops through its native operation ID', async () => {
  ffmpeg.createFfOperation('compatible-cancel');
  ffmpeg.abortFfOperation('compatible-cancel');
  try {
    await expect(planCompatibleCuts({ path: source, segments: [{ start: 2, end: 6 }], streamIds: [0, 1], operationId: 'compatible-cancel' })).rejects.toMatchObject({ isCanceled: true });
  } finally {
    ffmpeg.finishFfOperation('compatible-cancel');
  }
});

test('Smart Cut proves only its two exact video GOP boundaries and rejects an off-key boundary', async () => {
  const probe = vi.spyOn(ffmpeg, 'runFfprobe');
  const plan = await planVideoCopyRange({ path: source, streamIndex: 0, range: { start: 2, end: 4 } });
  expect(probe).toHaveBeenCalledTimes(3);
  for (const [args] of probe.mock.calls) expect(args[args.indexOf('-read_intervals') + 1]).toMatch(/%\+#1$/);
  probe.mockRestore();
  expect(plan.possible, JSON.stringify(plan)).toBe(true);
  expect(plan.segments[0]).toMatchObject({ start: 2, end: 4, duration: 2, seekFrom: 2.018, readTo: 4.018 });
  expect(plan.segments[0]!.filters).toHaveLength(1);
  expect(plan.segments[0]!.filters[0]!.expression).toContain('lt(dts,');
  const copied = join(directory, 'bounded-video-copy.mp4');
  const timing = getCompatibleTimingArgs(plan.segments[0]!);
  await ffmpeg.runFfmpeg([...timing.beforeInput, '-i', source, ...timing.afterInput, '-map', '0:v:0', '-c', 'copy', '-bsf:v', timing.filters[0]!.expression, copied]);
  const { stdout } = await ffmpeg.runFfprobe(['-v', 'error', '-show_frames', '-show_entries', 'frame=pts_time', '-of', 'json', copied]);
  const { frames } = JSON.parse(Buffer.from(stdout).toString()) as { frames: { pts_time: string }[] };
  expect(frames).toHaveLength(60);
  expect(Number(frames[0]!.pts_time)).toBe(0.018);
  const offKey = await planVideoCopyRange({ path: source, streamIndex: 0, range: { start: 2, end: 4.5 } });
  expect(offKey.possible).toBe(false);
  expect(offKey.issues[0]).toContain('not proven closed');
  ffmpeg.createFfOperation('video-copy-proof-cancel');
  ffmpeg.abortFfOperation('video-copy-proof-cancel');
  try {
    await expect(planVideoCopyRange({ path: source, streamIndex: 0, range: { start: 2, end: 4 }, operationId: 'video-copy-proof-cancel' })).rejects.toMatchObject({ isCanceled: true });
  } finally {
    ffmpeg.finishFfOperation('video-copy-proof-cancel');
  }
}, 15000);

test('a non-microsecond video clock seeks upward on integer microseconds without scientific notation', async () => {
  const fractional = join(directory, 'fractional-clock.mp4');
  await ffmpeg.runFfmpeg(['-v', 'error', '-copyts', '-i', source, '-c', 'copy', '-video_track_timescale', '15360', '-movie_timescale', '384000', '-movflags', '+negative_cts_offsets', fractional]);
  const probe = vi.spyOn(ffmpeg, 'runFfprobe');
  const plan = await planVideoCopyRange({ path: fractional, streamIndex: 0, range: { start: 2, end: 4 } });
  const startArgs = probe.mock.calls[1]![0];
  expect(startArgs[startArgs.indexOf('-read_intervals') + 1]).toBe('2.017969%+#1');
  probe.mockRestore();
  expect(plan.possible, JSON.stringify(plan)).toBe(true);
  expect(plan.segments[0]!.seekFrom).toBeCloseTo(2 + (276 / 15360), 12);
}, 15000);

test('an explicit EOF copy keeps the final Main10 GOP without inventing an end keyframe or trimming DTS', async () => {
  const probe = vi.spyOn(ffmpeg, 'runFfprobe');
  const plan = await planVideoCopyRange({ path: source, streamIndex: 0, range: { start: 22, end: 24 }, toEnd: true });
  expect(probe).toHaveBeenCalledTimes(2);
  probe.mockRestore();
  expect(plan.possible, JSON.stringify(plan)).toBe(true);
  expect(plan.segments[0]).toMatchObject({ start: 22, end: 24, duration: 2, readTo: undefined });
  expect(plan.segments[0]!.filters[0]!.expression).not.toContain('gte');
  const path = join(directory, 'last-gop.mp4');
  const timing = getCompatibleTimingArgs(plan.segments[0]!);
  await ffmpeg.runFfmpeg([...timing.beforeInput, '-i', source, ...timing.afterInput, '-map', '0:v:0', '-c', 'copy', '-bsf:v', timing.filters[0]!.expression, path]);
  const { stdout } = await ffmpeg.runFfprobe(['-v', 'error', '-show_frames', '-show_entries', 'frame=pts_time', '-of', 'json', path]);
  const { frames } = JSON.parse(Buffer.from(stdout).toString()) as { frames: { pts_time: string }[] };
  expect(frames).toHaveLength(60);
  expect(Number(frames[0]!.pts_time)).toBe(0.018);
  for (const end of [24 - (1 / 30), 24 + (1 / 30)]) {
    const invalid = await planVideoCopyRange({ path: source, streamIndex: 0, range: { start: 22, end }, toEnd: true });
    expect(invalid.possible).toBe(false);
    expect(invalid.issues[0]).toContain('does not end at the source');
  }
}, 15000);

test('different AAC sample clocks do not manufacture convenient alternatives', async () => {
  const multi = join(directory, 'multi-audio.mp4');
  await ffmpeg.runFfmpeg(['-v', 'error', '-i', source, '-f', 'lavfi', '-i', 'sine=r=44100:d=24', '-map', '0', '-map', '1:a:0', '-c', 'copy', '-c:a:1', 'aac', '-movie_timescale', '35280000', multi]);
  const plan = await planCompatibleCuts({ path: multi, segments: [{ start: 2, end: 6 }, { start: 8, end: 12 }, { start: 14, end: 18 }], streamIds: [0, 1, 2] });
  expect(plan.possible).toBe(false);
  expect(plan.issues[0]).toContain('not enough common');
}, 15000);

test('accepted source identity is checked without a packet rescan and stale sources are rejected', async () => {
  const file = join(directory, 'identity');
  await writeFile(file, 'before');
  const { size, mtimeMs } = await stat(file);
  expect(await checkCompatibleSource({ path: file, sourceIdentity: { size, mtimeMs } })).toBe(true);
  await writeFile(file, 'different size');
  expect(await checkCompatibleSource({ path: file, sourceIdentity: { size, mtimeMs } })).toBe(false);
  await rm(file);
  expect(await checkCompatibleSource({ path: file, sourceIdentity: { size, mtimeMs } })).toBe(false);
  const plan = await planCompatibleCuts({ path: source, segments: [{ start: 30, end: 31 }], streamIds: [0, 1] });
  expect(plan.possible).toBe(false);
  expect(plan.issues[0]).toContain('beyond');
});

test.each([0, 0.02, -0.02])('a common +5s source origin with audio offset %s uses one shift across two cuts', async (audioOffset) => {
  const shifted = join(directory, `origin5-audio${audioOffset}.mp4`);
  await ffmpeg.runFfmpeg(['-v', 'error', '-copyts', '-itsoffset', '5', '-i', source, '-itsoffset', String(5 + audioOffset), '-i', source, '-map', '0:v', '-map', '1:a', '-c', 'copy', '-avoid_negative_ts', 'disabled', '-movie_timescale', '240000', shifted]);
  const plan = await planCompatibleCuts({ path: shifted, segments: [{ start: 2, end: 6 }, { start: 8, end: 12 }], streamIds: [0, 1] });
  expect(plan.possible).toBe(true);
  expect(plan.segments.map(({ start, end }) => ({ start, end }))).toEqual([{ start: 0, end: 8 }, { start: 8, end: 16 }]);
  const paths: string[] = [];
  for (const [index, segment] of plan.segments.entries()) {
    const path = join(directory, `shift${audioOffset}-part${index}.mp4`);
    paths.push(path);
    const timing = getCompatibleTimingArgs(segment);
    await ffmpeg.runFfmpeg([...timing.beforeInput, '-i', shifted, ...timing.afterInput, '-map', '0', '-c', 'copy', ...timing.filters.flatMap((filter) => [`-bsf:${filter.streamIndex}`, filter.expression]), path]);
  }
  const concat = join(directory, `shift${audioOffset}-parts.txt`);
  await writeFile(concat, paths.map((path, index) => `file '${path.replaceAll('\\', '/')}'\nduration ${plan.segments[index]!.duration}`).join('\n'));
  const merged = join(directory, `shift${audioOffset}-merged.mp4`);
  await ffmpeg.runFfmpeg(['-copyts', '-f', 'concat', '-safe', '0', '-i', concat, '-map', '0', '-c', 'copy', '-movie_timescale', String(plan.segments[0]!.movieTimescale), merged]);
  const read = async (path: string) => {
    const { stdout } = await ffmpeg.runFfprobe(['-v', 'error', '-show_packets', '-show_data_hash', 'sha256', '-show_entries', 'packet=stream_index,pts_time,dts_time,data_hash', '-of', 'json', path]);
    return (JSON.parse(Buffer.from(stdout).toString()) as { packets: { stream_index: number, pts_time: string, dts_time: string, data_hash: string }[] }).packets;
  };
  const original = await read(shifted);
  const result = await read(merged);
  const shifts: number[] = [];
  for (const index of [0, 1]) {
    const after = result.filter((packet) => packet.stream_index === index);
    const before = original.filter((packet) => packet.stream_index === index).slice(0, after.length);
    expect(after).toHaveLength(index === 0 ? 480 : 750);
    expect(after.map((packet) => packet.data_hash)).toEqual(before.map((packet) => packet.data_hash));
    const streamShifts = after.map((packet, i) => Number(packet.pts_time) - Number(before[i]!.pts_time));
    expect(Math.max(...streamShifts) - Math.min(...streamShifts)).toBeLessThan(0.000002);
    shifts.push(streamShifts[0]!);
  }
  // One common shift, allowing only rounding to the source video/sample clocks.
  expect(Math.abs(shifts[0]! - shifts[1]!)).toBeLessThan(1 / 48000);
  expect(Math.abs(shifts[0]!)).toBeGreaterThan(4.9);
  const beyondEnd = await planCompatibleCuts({ path: shifted, segments: [{ start: 25, end: 26 }], streamIds: [0, 1] });
  expect(beyondEnd.possible).toBe(false);
  expect(beyondEnd.issues[0]).toContain('beyond');
}, 15000);

test('variable frame durations use actual closed-GOP and AAC clocks rather than an FPS grid', async () => {
  const vfr = join(directory, 'vfr.mp4');
  await ffmpeg.runFfmpeg(['-v', 'error', '-copyts', '-i', source, '-vf', "select='if(lt(mod(t,4),2),1,not(mod(n,2)))'", '-fps_mode', 'passthrough', '-c:v', 'libx265', '-preset', 'slow', '-crf', '26', '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1', '-x265-params', 'pools=1:frame-threads=1:keyint=600:min-keyint=1:scenecut=0:open-gop=0:log-level=error', '-force_key_frames', 'expr:gte(t,n_forced*8)', '-enc_time_base:v', '1/60000', '-video_track_timescale', '60000', '-c:a', 'copy', '-movie_timescale', '240000', vfr]);
  const plan = await planCompatibleCuts({ path: vfr, segments: [{ start: 2, end: 6 }, { start: 8, end: 12 }, { start: 14, end: 18 }], streamIds: [0, 1] });
  expect(plan.issues).toEqual([]);
  expect(plan.possible).toBe(true);
  expect(plan.segments.map(({ start, end }) => ({ start, end }))).toEqual([{ start: 0, end: 8 }, { start: 8, end: 16 }, { start: 16, end: 24 }]);
  const paths: string[] = [];
  for (const [index, segment] of plan.segments.entries()) {
    const path = join(directory, `vfr-part${index}.mp4`);
    paths.push(path);
    const timing = getCompatibleTimingArgs(segment);
    await ffmpeg.runFfmpeg([...timing.beforeInput, '-i', vfr, ...timing.afterInput, '-map', '0', '-c', 'copy', ...timing.filters.flatMap((filter) => [`-bsf:${filter.streamIndex}`, filter.expression]), path]);
  }
  const concat = join(directory, 'vfr-parts.txt');
  await writeFile(concat, paths.map((path, index) => `file '${path.replaceAll('\\', '/')}'\nduration ${plan.segments[index]!.duration}`).join('\n'));
  const merged = join(directory, 'vfr-merged.mp4');
  await ffmpeg.runFfmpeg(['-copyts', '-f', 'concat', '-safe', '0', '-i', concat, '-map', '0', '-c', 'copy', '-movie_timescale', String(plan.segments[0]!.movieTimescale), merged]);
  const read = async (path: string) => {
    const { stdout } = await ffmpeg.runFfprobe(['-v', 'error', '-show_packets', '-show_data_hash', 'sha256', '-show_entries', 'packet=stream_index,pts,dts,duration,data_hash', '-of', 'json', path]);
    return (JSON.parse(Buffer.from(stdout).toString()) as { packets: { stream_index: number, pts: number, dts: number, duration: number, data_hash: string }[] }).packets;
  };
  const original = await read(vfr);
  const result = await read(merged);
  for (const index of [0, 1]) expect(result.filter((packet) => packet.stream_index === index)).toEqual(original.filter((packet) => packet.stream_index === index));
  expect(new Set(original.filter((packet) => packet.stream_index === 0).map((packet) => packet.duration)).size).toBeGreaterThan(1);
}, 30000);
