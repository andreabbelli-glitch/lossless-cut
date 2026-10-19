import { stat } from 'node:fs/promises';
import readline from 'node:readline';
import assert from 'node:assert';

import { runFfprobe, spawnFfprobe } from './ffmpeg.js';
import type { CompatibleCut, CompatibleCutRange as Range, CompatibleCutPlan, CompatibleSourceIdentity } from '../common/compatibleCuts.js';

export { getCompatibleTimingArgs } from '../common/compatibleCuts.js';
export type { CompatibleCut } from '../common/compatibleCuts.js';

interface Rational { n: bigint, d: bigint }
const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));
const rational = (n: bigint, d = 1n): Rational => ({ n, d });
const add = (a: Rational, b: Rational) => rational(a.n * b.d + b.n * a.d, a.d * b.d);
const subtract = (a: Rational, b: Rational) => rational(a.n * b.d - b.n * a.d, a.d * b.d);
const seconds = (a: Rational) => Number(a.n) / Number(a.d);
const equal = (a: Rational, b: Rational) => a.n * b.d === b.n * a.d;
const parseClock = (value: string) => { const [n, d] = value.split('/').map(BigInt); assert(n != null && d != null && n > 0n && d > 0n); return rational(n, d); };
const onClock = (time: Rational, clock: Rational) => {
  const numerator = time.n * clock.d;
  const denominator = time.d * clock.n;
  return numerator % denominator === 0n ? numerator / denominator : undefined;
};
const atTick = (tick: bigint, clock: Rational) => rational(tick * clock.n, clock.d);

interface SourceStream { index: number, codec_type: string, codec_name?: string, time_base: string, sample_rate?: string, extradata?: string }
interface Packet { pts: bigint, dts: bigint, duration: bigint, keyframe: boolean, skip: bigint, discard: bigint }
interface Point { time: Rational, videoPts: bigint, videoDts: bigint | undefined, audio: Map<number, bigint>, eof: boolean }
async function packets(path: string, streamIndex: number, operationId: string | undefined, visit: (packet: Packet) => void) {
  const ps = spawnFfprobe(['-v', 'error', '-select_streams', String(streamIndex), '-show_packets', '-show_entries', 'packet=pts,dts,duration,flags:packet_side_data=skip_samples,discard_padding', '-of', 'compact=p=0:nk=0', path], { timeout: 0, logCli: false, operationId }, { buffer: { stdout: false, stderr: true } });
  assert(ps.stdout != null);
  const lines = readline.createInterface({ input: ps.stdout });
  try {
    for await (const line of lines) {
      const fields = Object.fromEntries(line.split('|').map((field) => field.split('=')));
      if (fields['pts'] != null && /^-?\d+$/.test(fields['pts']) && fields['dts'] != null && /^-?\d+$/.test(fields['dts']) && fields['duration'] != null && /^\d+$/.test(fields['duration'])) {
        visit({ pts: BigInt(fields['pts']), dts: BigInt(fields['dts']), duration: BigInt(fields['duration']), keyframe: fields['flags']?.startsWith('K') ?? false, skip: BigInt(fields['skip_samples'] ?? '0'), discard: BigInt(fields['discard_padding'] ?? '0') });
      }
    }
    await ps;
  } catch (err) {
    ps.kill();
    await Promise.allSettled([ps]);
    throw err;
  } finally {
    lines.close();
  }
}

function dumpBytes(dump: string) {
  const hex = dump.split('\n').flatMap((line) => {
    const match = line.match(/^[\da-f]+:\s+([\da-f ]+?)\s{2}/i);
    return match == null ? [] : [match[1]!.replaceAll(' ', '')];
  }).join('');
  return Buffer.from(hex, 'hex');
}

// A keyframe flag alone does not prove a closed GOP (HEVC CRA can have RASL).
// Inspect the first VCL NAL of each actually proposed boundary.
export function isClosedRandomAccess(packet: Uint8Array, codec: string, lengthSize: number) {
  let offset = 0;
  while (offset + lengthSize < packet.length) {
    let length = 0;
    for (let index = 0; index < lengthSize; index += 1) length = length * 256 + packet[offset + index]!;
    offset += lengthSize;
    if (length <= 0 || offset + length > packet.length) return false;
    const type = codec === 'hevc' ? Math.floor(packet[offset]! / 2) % 64 : packet[offset]! % 32;
    if (codec === 'hevc' && type <= 31) return type >= 16 && type <= 20;
    if (codec === 'h264' && type >= 1 && type <= 5) return type === 5;
    offset += length;
  }
  return false;
}

async function proveClosedPoint(path: string, video: SourceStream, clock: Rational, point: Point, operationId: string | undefined) {
  const extra = dumpBytes(video.extradata ?? '');
  if (extra[0] !== 1) return false; // This route only handles length-prefixed AVC/HEVC.
  const lengthSize = ((extra[video.codec_name === 'hevc' ? 21 : 4] ?? 0) % 4) + 1;
  const timestamp = atTick(point.videoPts, clock);
  // FFmpeg CLI time syntax has a microsecond clock. Round upward on that
  // clock, rather than guessing an FPS-dependent seek epsilon.
  const microseconds = (timestamp.n * 1000000n + timestamp.d - 1n) / timestamp.d;
  const { stdout } = await runFfprobe(['-v', 'error', '-select_streams', String(video.index), '-read_intervals', `${Number(microseconds) / 1000000}%+#1`, '-show_packets', '-show_data', '-show_entries', 'packet=pts,data', '-of', 'json', path], { logCli: false, operationId });
  const data = JSON.parse(Buffer.from(stdout).toString()) as { packets: { pts: number, data: string }[] };
  const packet = data.packets[0];
  return packet != null && BigInt(packet.pts) === point.videoPts && isClosedRandomAccess(dumpBytes(packet.data), video.codec_name!, lengthSize);
}

function nearest(values: readonly number[], value: number, minimum: number, maximum: number) {
  let low = minimum;
  let high = maximum + 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle]! < value) low = middle + 1;
    else high = middle;
  }
  return Math.min(maximum, Math.max(minimum, low));
}

export function chooseCompatibleRanges(points: readonly number[], requested: readonly Range[]) {
  if (points.length < requested.length + 1) return undefined;
  let minimum = 0;
  const result: Range[] = [];
  for (const [index, range] of requested.entries()) {
    const remaining = requested.length - index - 1;
    const maxStart = points.length - remaining - 2;
    const maxEnd = points.length - remaining - 1;
    const nearStart = nearest(points, range.start, minimum, maxStart);
    const nearEnd = nearest(points, range.end, minimum, maxStart);
    const candidates = new Set([minimum, maxStart, nearStart, Math.max(minimum, nearStart - 1), nearEnd, Math.max(minimum, nearEnd - 1)]);
    let best: { start: number, end: number, endIndex: number, cost: number, excluded: number } | undefined;
    for (const startIndex of candidates) {
      const endIndex = nearest(points, range.end, startIndex + 1, maxEnd);
      for (const endCandidate of new Set([endIndex, Math.max(startIndex + 1, endIndex - 1)])) {
        const start = points[startIndex]!;
        const end = points[endCandidate]!;
        const cost = Math.abs(start - range.start) + Math.abs(end - range.end);
        const excluded = Math.max(0, start - range.start) + Math.max(0, range.end - end);
        if (best == null || cost < best.cost || (cost === best.cost && excluded < best.excluded)) best = { start, end, endIndex: endCandidate, cost, excluded };
      }
    }
    assert(best != null);
    result.push({ start: best.start, end: best.end });
    minimum = best.endIndex;
  }
  return result;
}

export async function planCompatibleCuts({ path, segments, streamIds, operationId }: { path: string, segments: Range[], streamIds: number[], operationId?: string | undefined }): Promise<CompatibleCutPlan> {
  const issues: string[] = [];
  const failed = (issue: string): CompatibleCutPlan => ({ possible: false, issues: [...issues, issue], segments: [] });
  if (segments.length === 0 || segments.some((range, index) => !Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < 0 || range.end <= range.start || (index > 0 && segments[index - 1]!.end > range.start))) return failed('Compatible cuts require ordered, non-overlapping source ranges.');
  const identity = await stat(path);
  const { stdout } = await runFfprobe(['-v', 'error', '-show_streams', '-show_data', '-show_entries', 'stream=index,codec_type,codec_name,time_base,sample_rate,extradata', '-of', 'json', path], { logCli: false, operationId });
  const streams = (JSON.parse(Buffer.from(stdout).toString()) as { streams: SourceStream[] }).streams.filter((stream) => streamIds.includes(stream.index));
  const videos = streams.filter((stream) => stream.codec_type === 'video');
  const audio = streams.filter((stream) => stream.codec_type === 'audio');
  if (streams.length !== streamIds.length || videos.length !== 1 || !['hevc', 'h264'].includes(videos[0]!.codec_name ?? '') || streams.some((stream) => stream.codec_type !== 'video' && (stream.codec_type !== 'audio' || stream.codec_name !== 'aac'))) return failed('Compatible copy boundaries currently require one AVC/HEVC video and the selected AAC tracks.');
  if (audio.some((stream) => !/^\d+$/.test(stream.sample_rate ?? '') || BigInt(stream.sample_rate!) === 0n)) return failed('An AAC sample clock is incomplete.');
  const video = videos[0]!;
  const videoClock = parseClock(video.time_base);
  const keyframes: Packet[] = [];
  let firstVideo: bigint | undefined;
  let lastVideo: bigint | undefined;
  await packets(path, video.index, operationId, (packet) => {
    firstVideo = firstVideo == null || packet.pts < firstVideo ? packet.pts : firstVideo;
    const end = packet.pts + packet.duration;
    lastVideo = lastVideo == null || end > lastVideo ? end : lastVideo;
    if (packet.keyframe) keyframes.push(packet);
  });
  if (firstVideo == null || lastVideo == null || keyframes.length === 0) return failed('The video packet clock is incomplete.');
  const origin = atTick(firstVideo, videoClock);
  let sourcePresentationEnd = seconds(subtract(atTick(lastVideo, videoClock), origin));
  const points: Point[] = keyframes.map((packet) => ({ time: subtract(atTick(packet.pts, videoClock), origin), videoPts: packet.pts, videoDts: packet.dts, audio: new Map(), eof: false }));
  points.push({ time: subtract(atTick(lastVideo, videoClock), origin), videoPts: lastVideo, videoDts: undefined, audio: new Map(), eof: true });
  let movieTimescale = videoClock.d;
  const audioOrigins: Rational[] = [];
  for (const stream of audio) {
    const clock = parseClock(stream.time_base);
    movieTimescale = (movieTimescale / gcd(movieTimescale, clock.d)) * clock.d;
    let audioOrigin: Rational | undefined;
    let firstPacket: bigint | undefined;
    let previousEnd: bigint | undefined;
    let audioEnd: Rational | undefined;
    const targets = new Map<string, Point[]>();
    await packets(path, stream.index, operationId, (packet) => {
      if (audioOrigin == null) {
        firstPacket = packet.pts;
        audioOrigin = add(atTick(packet.pts, clock), rational(packet.skip, BigInt(stream.sample_rate!)));
        audioOrigins.push(audioOrigin);
        for (const point of points) {
          const tick = onClock(add(audioOrigin, point.time), clock);
          if (tick != null) targets.set(String(tick), [...(targets.get(String(tick)) ?? []), point]);
          if (point.time.n === 0n) point.audio.set(stream.index, firstPacket); // Retain initial priming and its edit list.
        }
      }
      const matches = targets.get(String(packet.pts)) ?? [];
      if (previousEnd === packet.pts) matches.forEach((point) => point.audio.set(stream.index, packet.pts));
      previousEnd = packet.pts + packet.duration;
      audioEnd = subtract(atTick(previousEnd, clock), rational(packet.discard, BigInt(stream.sample_rate!)));
    });
    if (audioOrigin == null || audioEnd == null) return failed('An AAC packet clock is incomplete.');
    sourcePresentationEnd = Math.max(sourcePresentationEnd, seconds(subtract(audioEnd, audioOrigin)));
    const eof = points.at(-1)!;
    if (equal(subtract(audioEnd, audioOrigin), eof.time)) eof.audio.set(stream.index, previousEnd!);
  }
  if (segments.some((segment) => segment.end > sourcePresentationEnd + 0.000001)) return failed('A requested range extends beyond the source presentation.');
  if (movieTimescale > 2147483647n) return failed('The selected track clocks do not have a representable common MP4 movie clock.');
  const compatible = points.filter((point) => point.audio.size === audio.length).sort((a, b) => seconds(a.time) - seconds(b.time));
  const ranges = chooseCompatibleRanges(compatible.map((point) => seconds(point.time)), segments);
  if (ranges == null) return failed('There are not enough common closed-GOP/AAC boundaries for all selected ranges.');
  const proposed: CompatibleCut[] = [];
  const proved = new Set<Point>();
  for (const [index, range] of ranges.entries()) {
    const start = compatible.find((point) => seconds(point.time) === range.start)!;
    const end = compatible.find((point) => seconds(point.time) === range.end)!;
    for (const point of [start, end]) {
      if (!point.eof && !proved.has(point)) {
        if (!await proveClosedPoint(path, video, videoClock, point, operationId)) return failed('A proposed video boundary is not a proven closed random-access point.');
        proved.add(point);
      }
    }
    const requested = segments[index]!;
    const filters = [{ streamIndex: video.index, expression: `noise=drop='lt(dts,${start.videoDts})${end.videoDts == null ? '' : `+gte(dts,${end.videoDts})`}'` }, ...audio.map((stream) => ({ streamIndex: stream.index, expression: `noise=drop='lt(pts,${start.audio.get(stream.index)})${end.eof ? '' : `+gte(pts,${end.audio.get(stream.index)})`}'` }))];
    const endTimes = [origin, ...audioOrigins].map((trackOrigin) => seconds(add(trackOrigin, end.time)));
    proposed.push({ requested, ...range, duration: range.end - range.start, includedBefore: Math.max(0, requested.start - range.start), includedAfter: Math.max(0, range.end - requested.end), excludedBefore: Math.max(0, range.start - requested.start), excludedAfter: Math.max(0, requested.end - range.end), seekFrom: seconds(atTick(start.videoPts, videoClock)), readTo: end.eof ? undefined : Math.max(...endTimes), movieTimescale: Number(movieTimescale), filters });
  }
  const current = await stat(path);
  if (identity.size !== current.size || identity.mtimeMs !== current.mtimeMs) return failed('The source changed during compatible-boundary analysis.');
  return { possible: true, issues, segments: proposed, sourceIdentity: { size: current.size, mtimeMs: current.mtimeMs } };
}

export async function checkCompatibleSource({ path, sourceIdentity }: { path: string, sourceIdentity: CompatibleSourceIdentity }) {
  try {
    const current = await stat(path);
    return current.size === sourceIdentity.size && current.mtimeMs === sourceIdentity.mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
