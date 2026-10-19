/* eslint-disable no-continue */
import { stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { setImmediate as yieldImmediate } from 'node:timers/promises';

import { spawnFfmpeg, spawnFfprobe } from './ffmpeg.js';

export interface VerificationStreamInfo {
  index: number, codec_type: string, codec_name?: string, time_base: string,
  avg_frame_rate?: string, r_frame_rate?: string, has_b_frames?: number,
  sample_rate?: string, channels?: number, pix_fmt?: string,
  start_time?: string,
  duration?: string,
  profile?: string, color_range?: string, color_space?: string, color_transfer?: string, color_primaries?: string, channel_layout?: string,
  tags?: { language?: string, title?: string }, disposition?: Record<string, number>,
}
type StreamInfo = VerificationStreamInfo;
interface Metadata { streams: StreamInfo[], format: { duration?: string, start_time?: string, size?: string, tags?: Record<string, string> } }
export interface VerificationSource { path: string, start?: number, end?: number, streamIds?: number[], timeScale?: number, origins?: VerificationSource[] }
export interface VerifyExportParams {
  id: string, path: string, sources: VerificationSource[], merged: boolean, reencodedVideo?: boolean, timeScale?: number,
  expectedStreams?: Partial<VerificationStreamInfo>[], preserveTrackMetadata?: boolean,
  reencodedAudioStreamIds?: number[],
  deferAudioContentToMerge?: boolean,
}
export interface ExportVerificationResult {
  status: 'passed' | 'failed' | 'inconclusive' | 'pending-merge', issues: string[], elapsedMs: number,
  cancelled?: boolean,
  coverage: { structure: boolean, packetTimestamps: boolean, boundaries: boolean, perceptualVideo: boolean },
}
export interface ExportVerificationState {
  id: string, phase: 'queued' | 'structure' | 'packets' | 'boundaries' | 'finished',
  packets: number, elapsedMs: number, result?: ExportVerificationResult,
}
interface Job { state: ExportVerificationState, controller: AbortController, started: number }
interface Packet {
  stream: number, pts: number, dts: number, duration: number, hash: string, skip: number, discard: number,
  key: boolean,
}
interface Anchor { packet: Packet, sourceIndex: number, sourceStream: StreamInfo, outputIndex: number, matches: Packet[] }
interface Frame { pts: number, duration: number, hash: string, samples?: Int16Array | Int32Array }
interface DecodeWindow { path: string, stream: StreamInfo, from: number, to: number, origin?: number, wholeAudioFrames?: boolean, samples32?: boolean }

const jobs = new Map<string, Job>();
let queue = Promise.resolve();
const anchorLimit = 12; // First/last anchor cohorts, independent of media duration and packet count.
const diagnosticLimit = 65536;
const decodedFrameLimit = 4096; // A memory bound for one local window, never a timing tolerance.
const decodedSampleLimit = 4 * 1024 * 1024;
const probeTime = (value: number) => value.toFixed(12);
const ratio = (value: string | undefined) => {
  const [numerator, denominator] = (value ?? '').split('/').map(Number);
  return numerator != null && denominator != null && denominator > 0 ? numerator / denominator : NaN;
};
const finite = (value: string | undefined) => (value == null || value === 'N/A' ? NaN : Number(value));
const median = (values: number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]!;
const splitFields = (line: string) => Object.fromEntries(line.split('|').slice(1).map((part) => {
  const separator = part.indexOf('=');
  return [part.slice(0, separator), part.slice(separator + 1)];
}));

function finalMediaTime(metadata: Metadata) {
  const ends = metadata.streams.map((stream) => finite(stream.start_time) + finite(stream.duration)).filter((value) => Number.isFinite(value));
  return ends.length > 0 ? Math.max(...ends) : (finite(metadata.format.start_time) || 0) + finite(metadata.format.duration);
}

function parsePacket(line: string): Packet | undefined {
  if (!line.startsWith('packet|')) return undefined;
  const fields = splitFields(line);
  return {
    stream: Number(fields['stream_index']),
    pts: finite(fields['pts']),
    dts: finite(fields['dts']),
    duration: finite(fields['duration']),
    hash: fields['data_hash'] ?? '',
    skip: Number(fields['side_datum/skip_samples:skip_samples'] ?? 0),
    discard: Number(fields['side_datum/skip_samples:discard_padding'] ?? 0),
    key: (fields['flags'] ?? '').includes('K'),
  };
}

type Child = ReturnType<typeof spawnFfprobe>;
async function consume(child: Child, onLine: (line: string) => void, signal: AbortSignal) {
  const completion = child.then(() => undefined, (error: unknown) => ({ error }));
  let diagnostic = '';
  const drain = (async () => {
    if (child.stderr == null) return;
    for await (const chunk of child.stderr as Readable) diagnostic = (diagnostic + String(chunk)).slice(-diagnosticLimit);
  })();
  if (child.stdout == null) throw new Error('Verification process has no output stream');
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let count = 0;
  try {
    for await (const chunk of child.stdout as Readable) {
      signal.throwIfAborted();
      pending += decoder.write(chunk as Buffer);
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, '');
        if (line.length > diagnosticLimit) throw new Error('Unexpected oversized verification record');
        onLine(line);
        pending = pending.slice(newline + 1);
        count += 1;
        if (count % 512 === 0) await yieldImmediate();
        newline = pending.indexOf('\n');
      }
      if (pending.length > diagnosticLimit) throw new Error('Unexpected oversized verification record');
    }
    pending += decoder.end();
    if (pending) onLine(pending.replace(/\r$/, ''));
    const outcome = await completion;
    await drain;
    if (outcome != null) throw new Error(diagnostic.trim() || 'Verification media process failed', { cause: outcome.error });
    return diagnostic.trim();
  } catch (error) {
    child.kill();
    await Promise.allSettled([completion, drain]);
    throw error;
  }
}

function probe(args: string[], signal: AbortSignal) {
  return spawnFfprobe(['-v', 'error', ...args], { timeout: 0, logCli: false }, { buffer: { stdout: false, stderr: false }, cancelSignal: signal });
}

async function readMetadata(path: string, signal: AbortSignal): Promise<Metadata> {
  let text = '';
  const diagnostic = await consume(probe([
    '-show_entries', 'stream=index,codec_type,codec_name,time_base,avg_frame_rate,r_frame_rate,has_b_frames,sample_rate,channels,channel_layout,pix_fmt,profile,start_time,duration,color_range,color_space,color_transfer,color_primaries:stream_tags=language,title:stream_disposition:format=duration,start_time,size:format_tags=stash_compression,comment',
    '-of', 'json', path,
  ], signal), (line) => {
    text += line;
    if (text.length > diagnosticLimit) throw new Error('Unexpected oversized stream metadata');
  }, signal);
  if (diagnostic) throw new Error(diagnostic);
  return JSON.parse(text) as Metadata;
}

const packetArgs = [
  '-show_packets', '-show_data_hash', 'sha256', '-show_entries',
  'packet=stream_index,pts,dts,duration,data_hash,flags:packet_side_data=skip_samples,discard_padding', '-of', 'compact=p=1:nk=0',
];

function boundaryContext(metadata: Metadata) {
  const periods = metadata.streams.map((stream) => {
    if (stream.codec_type === 'video') return (anchorLimit + (stream.has_b_frames ?? 0) + 2) / (ratio(stream.avg_frame_rate) || ratio(stream.r_frame_rate));
    if (stream.codec_type === 'audio') return ((anchorLimit + 2) * 1024) / Number(stream.sample_rate);
    return NaN;
  }).filter((value) => Number.isFinite(value) && value > 0);
  if (periods.length === 0) throw new Error('Cannot determine a bounded media verification window');
  return Math.max(...periods);
}

async function boundaryPackets(source: VerificationSource, metadata: Metadata, signal: AbortSignal, visit?: (packet: Packet) => void) {
  const context = boundaryContext(metadata);
  const origin = finite(metadata.format.start_time) || 0;
  const start = origin + (source.start ?? 0);
  const end = source.end == null ? finalMediaTime(metadata) : origin + source.end;
  if (!Number.isFinite(end) || end < start) throw new Error('Cannot locate the final media boundary');
  const selected = new Set(source.streamIds ?? metadata.streams.map((stream) => stream.index));
  const targets = new Map<number, number[]>();
  const requested = metadata.streams.filter((stream) => selected.has(stream.index) && ['video', 'audio'].includes(stream.codec_type)).flatMap((stream) => {
    const trackStart = Number.isFinite(finite(stream.start_time)) ? finite(stream.start_time) : origin;
    const trackEnd = trackStart + finite(stream.duration);
    const points = [Math.max(start, trackStart), Math.min(end, Number.isFinite(trackEnd) ? trackEnd : end)];
    targets.set(stream.index, points);
    return points.map((at) => ({ from: Math.max(origin, at - context), to: at + context }));
  }).toSorted((a, b) => a.from - b.from);
  const intervals: { from: number, to: number }[] = [];
  const maximumSpan = Math.max(...requested.map((interval) => interval.to - interval.from));
  for (const interval of requested) {
    const previous = intervals.at(-1);
    if (previous != null && interval.from <= previous.to && Math.max(previous.to, interval.to) - previous.from <= maximumSpan) previous.to = Math.max(previous.to, interval.to);
    else intervals.push(interval);
  }
  const packets: Packet[] = [];
  const primaryVideo = metadata.streams.find((stream) => stream.codec_type === 'video');
  for (const [intervalIndex, interval] of intervals.entries()) {
    let startKeyframeSeen = false;
    const cohorts = new Map<number, { first: Packet[], last: Packet[], recent: Packet[], atKey: Packet[], afterKey: number, nearest: { at: number, packets: Packet[] }[] }>();
    const onPacket = (line: string) => {
      const packet = parsePacket(line);
      if (packet == null) return;
      visit?.(packet);
      if (primaryVideo != null && packet.stream === primaryVideo.index && packet.key && packet.pts * ratio(primaryVideo.time_base) <= Math.max(start, finite(primaryVideo.start_time) || origin) + ratio(primaryVideo.time_base) / 2) {
        startKeyframeSeen = true;
        for (const cohort of cohorts.values()) {
          cohort.atKey = [...cohort.recent];
          cohort.afterKey = anchorLimit;
        }
      }
      if (!selected.has(packet.stream)) return;
      let cohort = cohorts.get(packet.stream);
      if (cohort == null) {
        cohort = { first: [], last: [], recent: [], atKey: [], afterKey: startKeyframeSeen ? anchorLimit : 0, nearest: (targets.get(packet.stream) ?? []).filter((at) => at >= interval.from && at <= interval.to).map((at) => ({ at, packets: [] })) };
        cohorts.set(packet.stream, cohort);
      }
      if (cohort.first.length < anchorLimit) cohort.first.push(packet);
      cohort.last.push(packet);
      if (cohort.last.length > anchorLimit) cohort.last.shift();
      cohort.recent.push(packet);
      if (cohort.recent.length > anchorLimit) cohort.recent.shift();
      if (cohort.afterKey > 0) { cohort.atKey.push(packet); cohort.afterKey -= 1; }
      const tick = ratio(metadata.streams.find((stream) => stream.index === packet.stream)?.time_base);
      for (const nearest of cohort.nearest) {
        nearest.packets.push(packet);
        nearest.packets.sort((a, b) => Math.abs(a.pts * tick - nearest.at) - Math.abs(b.pts * tick - nearest.at));
        if (nearest.packets.length > anchorLimit) nearest.packets.pop();
      }
    };
    const readInterval = async (streamIndex?: number) => {
      const diagnostic = await consume(probe([
        ...(streamIndex == null ? [] : ['-select_streams', String(streamIndex)]),
        '-read_intervals', `${probeTime(Math.max(0, interval.from))}%${probeTime(interval.to)}`, ...packetArgs, source.path,
      ], signal), onPacket, signal);
      if (diagnostic) throw new Error(diagnostic);
    };
    await readInterval();
    // A fragmented MP4 can store one track's complete fragment before another's.
    // FFprobe may stop on the first track before reaching the other track's earlier PTS.
    // Supplement only missing tracks at this boundary, retaining the same bounded interval.
    for (const [streamIndex, points] of targets) {
      if (!cohorts.has(streamIndex) && points.some((at) => at >= interval.from && at <= interval.to)) await readInterval(streamIndex);
    }
    cohorts.forEach((cohort) => packets.push(...(intervalIndex === 0 ? cohort.first : []), ...cohort.atKey, ...cohort.last, ...cohort.nearest.flatMap((nearest) => nearest.packets)));
  }
  return [...new Map(packets.map((packet) => [`${packet.stream}:${packet.pts}:${packet.hash}`, packet])).values()];
}

async function decode(window: DecodeWindow, signal: AbortSignal, perceptual = false) {
  const video = window.stream.codec_type === 'video';
  const tick = ratio(window.stream.time_base);
  const framePeriod = 1 / (ratio(window.stream.avg_frame_rate) || ratio(window.stream.r_frame_rate));
  const lookAhead = video && Number.isFinite(framePeriod) ? ((window.stream.has_b_frames ?? 0) + 2) * framePeriod : tick;
  const times: { pts: number, duration: number }[] = [];
  // This decoder output is the timing oracle. The rawvideo framehash muxer can
  // clamp non-monotone timestamps and must never be used to certify the clock.
  const diagnostic = await consume(probe([
    '-read_intervals', `${probeTime(Math.max(0, window.from))}%${probeTime(window.to + lookAhead)}`, '-select_streams', String(window.stream.index),
    '-show_frames', '-show_entries', 'frame=pts,duration,nb_samples', '-of', 'compact=p=1:nk=0', window.path,
  ], signal), (line) => {
    if (!line.startsWith('frame|')) return;
    const fields = splitFields(line);
    const pts = finite(fields['pts']) * tick;
    const duration = video ? finite(fields['duration']) * tick : finite(fields['nb_samples']) / Number(window.stream.sample_rate);
    if ((window.wholeAudioFrames ? pts + duration <= window.from : pts < window.from - tick / 2) || pts >= window.to - tick / 2) return;
    times.push({ pts, duration });
    if (times.length > decodedFrameLimit) throw new Error('Local verification window exceeds the bounded decoded-frame budget');
  }, signal);
  if (diagnostic) throw new Error(diagnostic);
  if (times.length === 0 || times.some((frame) => !Number.isFinite(frame.pts) || !(frame.duration > 0))) throw new Error('No unambiguous decoded boundary timestamps');
  // Decode whole sample blocks, including padding exposed by the container.
  // Cropping a partial AAC block would create a different checksum by itself.
  const from = Math.min(...times.map((frame) => frame.pts));
  const to = Math.max(...times.map((frame) => frame.pts + frame.duration));
  const hashes: string[] = [];
  const sampleBlocks: (Int16Array | Int32Array)[] = [];
  const sampleBytes = window.samples32 ? 4 : 2;
  const audioContext = video ? 0 : 2048 / Number(window.stream.sample_rate);
  const child = spawnFfmpeg([
    '-v', 'error', '-nostdin', '-copyts', '-ss', String(Math.max(0, from - (window.origin ?? 0) - (video ? tick : audioContext))),
    ...(!video ? ['-noaccurate_seek'] : []), '-i', window.path,
    '-to', String(to + (video ? -tick / 2 : audioContext)), '-map', `0:${window.stream.index}`,
    ...(video ? ['-c:v', 'rawvideo', '-threads:v', '1', '-fps_mode:v', 'passthrough', '-enc_time_base:v', 'demux'] : ['-c:a', window.samples32 ? 'pcm_s32le' : 'pcm_s16le']),
    // CLI -ss is quantized to microseconds. Trim PCM in its integer sample clock,
    // otherwise a 2666.67 us boundary can silently remove one extra sample.
    ...(!video ? ['-af', window.wholeAudioFrames
      ? `aselect='gte(t,${probeTime(from - tick / 2)})*lte(t,${probeTime(times.at(-1)!.pts + tick / 2)})'`
      : `atrim=start_pts=${Math.round(from * Number(window.stream.sample_rate))}:end_pts=${Math.round(to * Number(window.stream.sample_rate))}`, '-frames:a', String(times.length)] : []),
    ...(!video ? ['-f', window.samples32 ? 's32le' : 's16le', '-'] : (perceptual ? ['-vf', 'scale=9:8:flags=area,format=gray', '-f', 'rawvideo', '-'] : ['-f', 'framehash', '-hash', 'sha256', '-'])),
  ], { buffer: { stdout: false, stderr: false }, cancelSignal: signal }, { logCli: false });
  let hashDiagnostic: string;
  if (!video) {
    const expectedSamples = times.map((frame) => Math.round(frame.duration * Number(window.stream.sample_rate)) * (window.stream.channels ?? 1));
    const expectedBytes = expectedSamples.reduce((sum, count) => sum + count, 0) * sampleBytes;
    if (expectedBytes / sampleBytes > decodedSampleLimit) { child.kill(); await child.catch(() => undefined); throw new Error('Local audio window exceeds the bounded sample budget'); }
    const completion = child.then(() => undefined, (error: unknown) => ({ error }));
    let tail = '';
    const drain = (async () => { for await (const chunk of child.stderr as Readable) tail = (tail + String(chunk)).slice(-diagnosticLimit); })();
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      for await (const chunk of child.stdout as Readable) {
        signal.throwIfAborted();
        bytes += (chunk as Buffer).length;
        if (bytes > expectedBytes) throw new Error('Decoded audio has more samples than its direct frame timestamps');
        chunks.push(chunk as Buffer);
      }
      const outcome = await completion;
      await drain;
      if (outcome != null || bytes !== expectedBytes) throw new Error(tail || 'Decoded audio sample count differs from its direct frame timestamps');
      const pcm = Buffer.concat(chunks);
      let offset = 0;
      for (const count of expectedSamples) {
        const block = window.samples32 ? new Int32Array(count) : new Int16Array(count);
        for (let index = 0; index < count; index += 1) block[index] = window.samples32 ? pcm.readInt32LE((offset + index) * sampleBytes) : pcm.readInt16LE((offset + index) * sampleBytes);
        offset += count;
        sampleBlocks.push(block);
        hashes.push(window.samples32 ? 'pcm32' : 'pcm16');
      }
      hashDiagnostic = tail.trim();
    } catch (error) {
      child.kill();
      await Promise.allSettled([completion, drain]);
      throw error;
    }
  } else if (perceptual) {
    const completion = child.then(() => undefined, (error: unknown) => ({ error }));
    let tail = '';
    const drain = (async () => { for await (const chunk of child.stderr as Readable) tail = (tail + String(chunk)).slice(-diagnosticLimit); })();
    let pending = Buffer.alloc(0);
    try {
      for await (const chunk of child.stdout as Readable) {
        signal.throwIfAborted();
        pending = Buffer.concat([pending, chunk as Buffer]);
        while (pending.length >= 72) {
          const image = pending.subarray(0, 72);
          let hash = 0n;
          for (let row = 0; row < 8; row += 1) {
            for (let column = 0; column < 8; column += 1) hash = hash * 2n + (image[row * 9 + column]! > image[row * 9 + column + 1]! ? 1n : 0n);
          }
          const luminance = Math.floor(image.reduce((sum, value) => sum + value, 0) / (72 * 16));
          hashes.push(`dhash:${hash.toString(16)}:${luminance}`);
          if (hashes.length > decodedFrameLimit) throw new Error('Local verification window exceeds the bounded decoded-frame budget');
          pending = pending.subarray(72);
        }
      }
      const outcome = await completion;
      await drain;
      if (outcome != null || pending.length > 0) throw new Error(tail || 'Incomplete perceptual boundary decode');
      hashDiagnostic = tail.trim();
    } catch (error) {
      child.kill();
      await Promise.allSettled([completion, drain]);
      throw error;
    }
  } else {
    hashDiagnostic = await consume(child, (line) => {
      if (line && !line.startsWith('#')) {
        hashes.push(line.split(',')[5]!.trim());
        if (hashes.length > decodedFrameLimit) throw new Error('Local verification window exceeds the bounded decoded-frame budget');
      }
    }, signal);
  }
  if (hashDiagnostic) throw new Error(hashDiagnostic);
  if (times.length !== hashes.length) throw new Error(`Decoded content and direct presentation timestamps cannot be aligned unambiguously (${window.stream.codec_type}, ${window.from}..${window.to}, ${hashes.length} hashes / ${times.length} timestamps)`);
  return times.map((frame, index) => ({ ...frame, hash: hashes[index]!, ...(!video ? { samples: sampleBlocks[index]! } : {}) }));
}

export function compareAudioSamples(reference: Frame[], actual: Frame[], shift: number, timeScale: number, stream: StreamInfo) {
  const sampleRate = Number(stream.sample_rate);
  const channels = stream.channels ?? 1;
  let count = 0;
  for (const frame of actual) {
    if (frame.samples?.length !== Math.round(frame.duration * sampleRate) * channels) return { complete: false, equal: false, count };
    const wanted = (frame.pts - shift) * timeScale;
    let referenceIndex = reference.findIndex((candidate) => wanted >= candidate.pts - 0.5 / sampleRate && wanted < candidate.pts + candidate.duration - 0.5 / sampleRate);
    if (referenceIndex < 0 || frame.samples == null) return { complete: false, equal: false, count };
    let offset = Math.round((wanted - reference[referenceIndex]!.pts) * sampleRate) * channels;
    for (const sample of frame.samples) {
      const block = reference[referenceIndex]?.samples;
      if (block == null || offset < 0 || offset >= block.length) return { complete: false, equal: false, count };
      // Identical AAC payload can round differently after an edit-list trim.
      // This is one PCM16 amplitude unit, independent of every timing check.
      if (Math.abs(sample - block[offset]!) > (stream.codec_name === 'aac' ? 1 : 0)) return { complete: true, equal: false, count, mismatchAt: frame.pts, difference: sample - block[offset]! };
      count += 1;
      offset += 1;
      if (offset === block.length) {
        const previous = reference[referenceIndex]!;
        referenceIndex += 1;
        offset = 0;
        const next = reference[referenceIndex];
        if (next != null && Math.abs(next.pts - previous.pts - previous.duration) > 0.5 / sampleRate) referenceIndex = -1;
      }
    }
  }
  return { complete: count > 0, equal: true, count };
}

async function compareConvertedAudio(reference: Frame[], actual: Frame[], shift: number, timeScale: number, source: StreamInfo, target: StreamInfo, signal: AbortSignal) {
  const rate = Number(source.sample_rate);
  const channels = source.channels ?? 1;
  const quantum = ratio(source.time_base) + ratio(target.time_base) * timeScale + 1 / rate;
  const sampleRadius = Math.ceil(quantum * rate);
  const shifts: number[] = [];
  let count = 0;
  if (sampleRadius > decodedFrameLimit) return { complete: false, equal: false, shifts, count };
  const matches = (frameIndex: number, offset: number, samples: Int16Array | Int32Array) => {
    let current = frameIndex;
    let at = offset;
    for (const sample of samples) {
      const block = reference[current]?.samples;
      if (block == null || at < 0 || at >= block.length || sample !== block[at]) return false;
      at += 1;
      if (at === block.length) {
        const previous = reference[current]!;
        current += 1;
        at = 0;
        const next = reference[current];
        if (next != null && Math.abs(next.pts - previous.pts - previous.duration) > ratio(source.time_base) + 1 / rate) return false;
      }
    }
    return true;
  };
  for (const frame of actual) {
    signal.throwIfAborted();
    if (frame.samples == null || frame.samples.length !== Math.round(frame.duration * rate) * channels) return { complete: false, equal: false, shifts, count };
    const wanted = (frame.pts - shift) * timeScale;
    const candidates: number[] = [];
    for (const [index, block] of reference.entries()) {
      if (wanted < block.pts - quantum || wanted > block.pts + block.duration + quantum || block.samples == null) continue;
      const predicted = Math.round((wanted - block.pts) * rate);
      for (let sample = Math.max(0, predicted - sampleRadius); sample <= Math.min(block.samples.length / channels - 1, predicted + sampleRadius); sample += 1) {
        if (matches(index, sample * channels, frame.samples)) {
          candidates.push(frame.pts - (block.pts + sample / rate) / timeScale);
          if (candidates.length > 1) return { complete: false, equal: false, shifts, count };
        }
      }
    }
    if (candidates.length === 0) return { complete: true, equal: false, shifts, count };
    if (candidates.length > 1) return { complete: false, equal: false, shifts, count };
    shifts.push(candidates[0]!);
    count += frame.samples.length;
    await yieldImmediate();
    signal.throwIfAborted();
  }
  return { complete: count > 0, equal: true, shifts, count };
}

// Keep decode cohorts separate when a long GOP makes their timestamps far apart.
function packetWindows(packets: Packet[], stream: StreamInfo, path: string, origin: number): DecodeWindow[] {
  const tick = ratio(stream.time_base);
  const framePeriod = 1 / (ratio(stream.avg_frame_rate) || ratio(stream.r_frame_rate));
  const reorderSpan = stream.codec_type === 'video' && Number.isFinite(framePeriod) ? ((stream.has_b_frames ?? 0) + 1) * framePeriod : tick;
  const sorted = packets.toSorted((a, b) => a.pts - b.pts);
  const windows: DecodeWindow[] = [];
  for (const packet of sorted) {
    if (!Number.isFinite(packet.pts) || !Number.isFinite(packet.duration) || packet.duration <= 0) continue;
    const from = packet.pts * tick;
    const to = (packet.pts + packet.duration) * tick;
    const last = windows.at(-1);
    if (last != null && from <= last.to + reorderSpan) last.to = Math.max(last.to, to);
    else windows.push({ path, stream, from, to, origin });
  }
  return windows;
}

export function compareBoundaryShifts(groups: { type: string, shifts: number[], quantum: number }[]) {
  const audio = groups.filter((group) => group.type === 'audio').flatMap((group) => group.shifts);
  const all = groups.flatMap((group) => group.shifts);
  if (all.length === 0) return { commonShift: NaN, valid: false };
  const commonShift = median(audio.length > 0 ? audio : all);
  return {
    commonShift,
    valid: groups.every((group) => group.shifts.every((shift) => Math.abs(shift - commonShift) <= (group.type === 'video' ? 0.002 : group.quantum))),
  };
}

export function compressionMarkers(tags: Record<string, string> = {}, allowMultiple = false) {
  const normalizedTags = Object.fromEntries(Object.entries(tags).map(([key, value]) => [key.toLowerCase(), value]));
  const markers = new Set<string>();
  if (normalizedTags['stash_compression']) {
    const marker = JSON.parse(normalizedTags['stash_compression']) as { version?: number, id?: string, profile?: string, generation?: number };
    if (marker.version !== 1 || marker.generation !== 1 || typeof marker.id !== 'string' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(marker.id) || typeof marker.profile !== 'string' || !marker.profile) throw new Error('Malformed compression provenance marker');
    markers.add(`${marker.id.toLowerCase()}:${marker.profile}`);
  }
  const comment = normalizedTags['comment'] ?? '';
  for (const token of comment.matchAll(/STASH-COMPRESSION:([^\s]*)/g)) {
    const match = token[1]!.match(/^v1:([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}):([^\s]+)$/i);
    if (match == null) throw new Error('Malformed compression provenance comment');
    markers.add(`${match[1]!.toLowerCase()}:${match[2]}`);
  }
  const profiles = new Map<string, string>();
  for (const marker of markers) {
    const separator = marker.indexOf(':');
    const id = marker.slice(0, separator);
    const profile = marker.slice(separator + 1);
    if (profiles.has(id) && profiles.get(id) !== profile) throw new Error('Contradictory compression provenance markers require review');
    profiles.set(id, profile);
  }
  if (!allowMultiple && profiles.size > 1) throw new Error('Multiple compression UUIDs require a merged provenance context');
  if ((normalizedTags['comment'] ?? '').includes('STASH-COMPRESSION:') && markers.size === 0) throw new Error('Malformed compression provenance comment');
  return markers;
}

async function verify(params: VerifyExportParams, job: Job): Promise<ExportVerificationResult> {
  const issues: string[] = [];
  let failed = false;
  let inconclusive = false;
  let deferredAudioContent = false;
  const coverage = { structure: false, packetTimestamps: false, boundaries: false, perceptualVideo: false };
  const fail = (message: string) => { failed = true; if (!issues.includes(message)) issues.push(message); };
  const doubt = (message: string) => { inconclusive = true; if (!issues.includes(message)) issues.push(message); };
  const { signal } = job.controller;
  const { state } = job;
  const timeScale = params.timeScale ?? 1;
  try {
    signal.throwIfAborted();
    if (params.deferAudioContentToMerge && params.merged) throw new Error('Audio content deferral is not allowed on a final merged output');
    if (!Number.isFinite(timeScale) || timeScale <= 0) throw new Error('Invalid requested playback time scale');
    state.phase = 'structure';
    const initialIdentity = await stat(params.path, { bigint: true });
    if (!initialIdentity.isFile() || initialIdentity.size === 0n) throw new Error('Output is empty or is not a file');
    const metaCache = new Map<string, Promise<Metadata>>();
    const metadata = (path: string) => {
      let value = metaCache.get(path);
      if (value == null) { value = readMetadata(path, signal); metaCache.set(path, value); }
      return value;
    };
    const output = await metadata(params.path);
    const reencodedAudio = new Set(params.reencodedAudioStreamIds ?? []);
    for (const index of reencodedAudio) {
      if (!Number.isInteger(index) || index < 0 || output.streams[index]?.codec_type !== 'audio') throw new Error('Declared audio conversion does not identify an output audio track');
    }
    const sourceMetadata: Metadata[] = [];
    const sourceIdentities = new Map<string, Stats>();
    for (const source of params.sources) {
      if (!sourceIdentities.has(source.path)) sourceIdentities.set(source.path, await stat(source.path));
      sourceMetadata.push(await metadata(source.path));
      for (const origin of source.origins ?? []) {
        if (origin.origins != null) throw new Error('Nested verification origins are not supported');
        if (!sourceIdentities.has(origin.path)) sourceIdentities.set(origin.path, await stat(origin.path));
      }
    }
    if (output.streams.length === 0 || params.sources.length === 0) throw new Error('No media tracks to verify');
    const anchors: Anchor[] = [];
    const sourceMappings: Map<number, number>[] = [];
    const startKeyframes = new Map<string, Packet>();
    let nextOutputIndex = 0;
    for (let sourceIndex = 0; sourceIndex < params.sources.length; sourceIndex += 1) {
      const source = params.sources[sourceIndex]!;
      const meta = sourceMetadata[sourceIndex]!;
      const selected = (source.streamIds ?? meta.streams.map((stream) => stream.index)).map((index) => meta.streams.find((stream) => stream.index === index)).filter((stream): stream is StreamInfo => stream != null);
      if (source.streamIds != null && selected.length !== source.streamIds.length) fail('A selected source track is missing');
      if (params.merged && selected.length !== output.streams.length) fail('Merged track count differs from a selected source');
      const outputOffset = params.merged ? 0 : nextOutputIndex;
      const mapping = new Map(selected.map((stream, index) => [stream.index, outputOffset + index]));
      sourceMappings.push(mapping);
      nextOutputIndex += selected.length;
      for (const stream of selected) {
        const targetIndex = mapping.get(stream.index)!;
        const target = output.streams[targetIndex];
        const expected = { ...stream, ...params.expectedStreams?.[targetIndex] };
        if (target == null || target.codec_type !== stream.codec_type) fail('Output track structure differs from the selected source tracks');
        if (target != null) {
          const properties = stream.codec_type === 'video'
            ? ['codec_name', 'pix_fmt', 'profile', 'color_range', 'color_space', 'color_transfer', 'color_primaries'] as const
            : ['codec_name', 'sample_rate', 'channels', 'channel_layout'] as const;
          for (const property of properties) {
            if (expected[property] != null && target[property] !== expected[property]) fail(`Output track ${targetIndex + 1} changed ${property}`);
          }
          if (params.preserveTrackMetadata !== false && (!params.merged || sourceIndex === 0)) {
            for (const property of ['language', 'title'] as const) {
              if (expected.tags?.[property] != null && target.tags?.[property] !== expected.tags[property]) fail(`Output track ${targetIndex + 1} lost ${property}`);
            }
            for (const [flag, value] of Object.entries(expected.disposition ?? {})) {
              if ((target.disposition?.[flag] ?? 0) !== value) fail(`Output track ${targetIndex + 1} changed disposition ${flag}`);
            }
          }
        }
      }
      const outputMarkers = compressionMarkers(output.format.tags, true);
      for (const marker of compressionMarkers(meta.format.tags, true)) {
        if (!outputMarkers.has(marker)) fail('Output lost the source compression UUID/profile provenance');
      }
      const packets = await boundaryPackets(source, meta, signal, (packet) => {
        const stream = selected.find((candidate) => candidate.index === packet.stream);
        if (stream?.codec_type !== 'video' || !packet.key) return;
        const tick = ratio(stream.time_base);
        const start = Math.max((finite(meta.format.start_time) || 0) + (source.start ?? 0), finite(stream.start_time) || 0);
        const key = `${sourceIndex}:${stream.index}`;
        const previous = startKeyframes.get(key);
        if (packet.pts * tick <= start + tick / 2 && (previous == null || packet.pts > previous.pts)) startKeyframes.set(key, packet);
      });
      for (const packet of packets) {
        const sourceStream = selected.find((stream) => stream.index === packet.stream);
        if (sourceStream == null || !['video', 'audio'].includes(sourceStream.codec_type)) continue;
        if (params.reencodedVideo && !params.merged && sourceStream.codec_type === 'video') continue;
        if (sourceStream.codec_type === 'audio' && reencodedAudio.has(mapping.get(packet.stream)!)) continue;
        anchors.push({ packet, sourceIndex, sourceStream, outputIndex: mapping.get(packet.stream)!, matches: [] });
      }
    }
    if (!params.merged && nextOutputIndex !== output.streams.length) fail('Output track count differs from the selected source tracks');
    coverage.structure = true;
    const byHash = new Map<string, Anchor[]>();
    const byTrack = new Map<string, Anchor[]>();
    const sourceHashes = new Map<number, Set<string>>();
    for (const anchor of anchors) {
      const key = `${anchor.outputIndex}:${anchor.packet.hash}`;
      const list = byHash.get(key) ?? [];
      list.push(anchor);
      byHash.set(key, list);
      const trackKey = `${anchor.sourceIndex}:${anchor.sourceStream.index}`;
      const track = byTrack.get(trackKey) ?? [];
      track.push(anchor);
      byTrack.set(trackKey, track);
      const hashes = sourceHashes.get(anchor.sourceIndex) ?? new Set<string>();
      hashes.add(anchor.packet.hash);
      sourceHashes.set(anchor.sourceIndex, hashes);
    }
    state.phase = 'packets';
    const previousDts = new Map<number, number>();
    const streamByIndex = new Map(output.streams.map((stream) => [stream.index, stream]));
    const outputEdges = new Map<number, { first: Packet, last: Packet }>();
    const recordEdge = (packet: Packet) => {
      if (!Number.isFinite(packet.pts)) return;
      const edges = outputEdges.get(packet.stream);
      if (edges == null) outputEdges.set(packet.stream, { first: packet, last: packet });
      else {
        if (packet.pts < edges.first.pts) edges.first = packet;
        if (packet.pts > edges.last.pts) edges.last = packet;
      }
    };
    const onPacket = (line: string) => {
      const packet = parsePacket(line);
      if (packet == null) return;
      recordEdge(packet);
      state.packets += 1;
      const stream = streamByIndex.get(packet.stream);
      if (stream != null && ['video', 'audio'].includes(stream.codec_type)) {
        if (!Number.isFinite(packet.pts) || !Number.isFinite(packet.dts) || !(packet.duration > 0)) doubt('Some media packets have missing or invalid timing information');
        const previous = previousDts.get(packet.stream);
        if (previous != null && packet.dts < previous) fail('Output decoding timestamps run backwards');
        previousDts.set(packet.stream, packet.dts);
      }
      for (const anchor of byHash.get(`${packet.stream}:${packet.hash}`) ?? []) {
        if (anchor.matches.length < 2) anchor.matches.push(packet);
      }
    };
    const matchPacket = (packet: Packet) => {
      for (const anchor of byHash.get(`${packet.stream}:${packet.hash}`) ?? []) {
        if (anchor.matches.length < 2 && !anchor.matches.some((existing) => existing.pts === packet.pts && existing.dts === packet.dts)) anchor.matches.push(packet);
      }
    };
    const required = (anchor: Anchor) => {
      const source = params.sources[anchor.sourceIndex]!;
      const origin = finite(sourceMetadata[anchor.sourceIndex]!.format.start_time) || 0;
      const tick = ratio(anchor.sourceStream.time_base);
      const from = origin + (source.start ?? 0);
      const to = source.end == null ? Infinity : origin + source.end;
      return anchor.packet.pts * tick >= from - tick / 2 && (anchor.packet.pts + anchor.packet.duration) * tick <= to + tick / 2;
    };
    if (params.merged) {
      const diagnostic = await consume(probe([...packetArgs, params.path], signal), onPacket, signal);
      if (diagnostic) fail(`Output packet scan reported: ${diagnostic}`);
      coverage.packetTimestamps = true;
    } else {
      await boundaryPackets({ path: params.path }, output, signal, (packet) => {
        // Intervals may overlap. Retain only unique matches, bounded by anchors.
        matchPacket(packet);
        recordEdge(packet);
      });
      const supplements: { from: number, to: number }[] = [];
      for (const candidates of byTrack.values()) {
        const matched = candidates.filter((anchor) => anchor.matches.length === 1);
        const missing = candidates.filter((anchor) => anchor.matches.length === 0 && required(anchor));
        const first = matched[0];
        if (first == null || missing.length === 0) continue;
        const sourceTick = ratio(first.sourceStream.time_base);
        const target = output.streams[first.outputIndex]!;
        const outputTick = ratio(target.time_base);
        const shift = median(matched.map((anchor) => anchor.matches[0]!.pts * outputTick - ((anchor.packet.pts * sourceTick) / timeScale)));
        const mapped = missing.map((anchor) => ({ ...anchor.packet, pts: ((anchor.packet.pts * sourceTick) / timeScale + shift) / outputTick, duration: ((anchor.packet.duration * sourceTick) / timeScale) / outputTick }));
        supplements.push(...packetWindows(mapped, target, params.path, finite(output.format.start_time) || 0));
      }
      const maximumSpan = Math.max(...supplements.map((window) => window.to - window.from));
      const ranges: { from: number, to: number }[] = [];
      for (const window of supplements.toSorted((a, b) => a.from - b.from)) {
        const previous = ranges.at(-1);
        if (previous != null && window.from <= previous.to && Math.max(previous.to, window.to) - previous.from <= maximumSpan) previous.to = Math.max(previous.to, window.to);
        else ranges.push({ ...window });
      }
      for (const window of ranges) {
        const diagnostic = await consume(probe(['-read_intervals', `${probeTime(Math.max(0, window.from))}%${probeTime(window.to)}`, ...packetArgs, params.path], signal), (line) => {
          const packet = parsePacket(line);
          if (packet != null) matchPacket(packet);
        }, signal);
        if (diagnostic) fail(`Supplementary output boundary scan reported: ${diagnostic}`);
      }
    }
    state.phase = 'boundaries';
    if (params.merged) {
      if (anchors.some((anchor) => anchor.matches.length === 0)) fail('Merge lost selected boundary packet content');
      if (anchors.some((anchor) => anchor.matches.length > 1)) doubt('Repeated boundary packet content cannot be placed uniquely in the merge');
      for (const [index, edges] of outputEdges) {
        if (!['video', 'audio'].includes(streamByIndex.get(index)?.codec_type ?? '')) continue;
        if (reencodedAudio.has(index)) continue;
        if (!(byHash.get(`${index}:${edges.first.hash}`) ?? []).some((anchor) => anchor.sourceIndex === 0)
          || !(byHash.get(`${index}:${edges.last.hash}`) ?? []).some((anchor) => anchor.sourceIndex === params.sources.length - 1)) fail('Actual merged output endpoints do not match the first and last selected parts');
      }
    } else {
      for (const [index, edges] of outputEdges) {
        const target = output.streams.find((stream) => stream.index === index);
        if (target == null || !['video', 'audio'].includes(target.codec_type) || (params.reencodedVideo && target.codec_type === 'video')) continue;
        if (reencodedAudio.has(index)) continue;
        const first = byHash.get(`${index}:${edges.first.hash}`) ?? [];
        const last = byHash.get(`${index}:${edges.last.hash}`) ?? [];
        if (first.length === 0 || last.length === 0) { fail(`Actual ${target.codec_type} output endpoints do not match the selected source boundaries`); continue; }
        if (target.codec_type === 'video' && !first.some((anchor) => startKeyframes.get(`${anchor.sourceIndex}:${anchor.sourceStream.index}`)?.hash === edges.first.hash)) fail('Actual video output begins before or after the proven source keyframe');
        if (!last.some((anchor) => {
          const source = params.sources[anchor.sourceIndex]!;
          if (source.end == null) return true;
          const tick = ratio(anchor.sourceStream.time_base);
          const end = (finite(sourceMetadata[anchor.sourceIndex]!.format.start_time) || 0) + source.end;
          const clock = target.codec_type === 'video' ? anchor.packet.dts : anchor.packet.pts;
          return clock * tick < end + tick / 2;
        })) fail(`Actual ${target.codec_type} output extends beyond the selected source boundary`);
      }
      for (const anchor of anchors) {
        // Packets wholly inside the requested selection are required. Preroll
        // and a block straddling a cut may legitimately be trimmed by elst.
        if (required(anchor) && anchor.matches.length === 0) fail(`Cut lost selected ${anchor.sourceStream.codec_type} boundary packet content`);
      }
    }
    const plans = new Map<string, DecodeWindow[]>();
    const windowKey = (window: DecodeWindow) => `${window.path}:${window.stream.index}:${window.from}:${window.to}`;
    const plannedWindows = new Map<string, DecodeWindow>();
    for (const candidates of byTrack.values()) {
      const matches = candidates.filter((candidate) => candidate.matches.length === 1);
      const anchor = matches[0];
      if (anchor == null) continue;
      const target = output.streams[anchor.outputIndex];
      if (target == null) continue;
      const windows = [
        ...packetWindows(matches.map((candidate) => candidate.packet), anchor.sourceStream, params.sources[anchor.sourceIndex]!.path, finite(sourceMetadata[anchor.sourceIndex]!.format.start_time) || 0),
        ...packetWindows(matches.map((candidate) => candidate.matches[0]!), target, params.path, finite(output.format.start_time) || 0),
      ];
      for (const window of windows) {
        const key = `${window.path}:${window.stream.index}`;
        plans.set(key, [...plans.get(key) ?? [], window]);
      }
    }
    for (const [key, windows] of plans) {
      const merged: DecodeWindow[] = [];
      const maximumSpan = Math.max(...windows.map((window) => window.to - window.from));
      for (const window of windows.toSorted((a, b) => a.from - b.from)) {
        const previous = merged.at(-1);
        // Adjacent joins must not turn overlapping local requests into a full-film decode.
        if (previous != null && window.from <= previous.to && Math.max(previous.to, window.to) - previous.from <= maximumSpan) {
          previous.to = Math.max(previous.to, window.to);
          plannedWindows.set(windowKey(window), previous);
        } else {
          const plan = { ...window };
          merged.push(plan);
          plannedWindows.set(windowKey(window), plan);
        }
      }
      plans.set(key, merged);
    }
    const decodedCache = new Map<string, Promise<Frame[]>>();
    const originPacketCache = new Map<string, Promise<Map<string, Packet[]>>>();
    const readOriginPackets = (origin: VerificationSource, meta: Metadata, allowedHashes: Set<string>) => {
      const key = JSON.stringify(origin);
      let value = originPacketCache.get(key);
      if (value == null) {
        value = (async () => {
          const packets = new Map<string, Packet[]>();
          await boundaryPackets(origin, meta, signal, (packet) => {
            if (!allowedHashes.has(packet.hash)) return;
            const packetKey = `${packet.stream}:${packet.hash}`;
            const matches = packets.get(packetKey) ?? [];
            if (matches.length < 2 && !matches.some((candidate) => candidate.pts === packet.pts)) matches.push(packet);
            packets.set(packetKey, matches);
          });
          return packets;
        })();
        originPacketCache.set(key, value);
      }
      return value;
    };
    const decoded = (window: DecodeWindow) => {
      const plan = plannedWindows.get(windowKey(window)) ?? window;
      const key = `${plan.path}:${plan.stream.index}:${plan.from}:${plan.to}`;
      let value = decodedCache.get(key);
      if (value == null) { value = decode(plan, signal); decodedCache.set(key, value); }
      const tick = ratio(window.stream.time_base);
      return value.then((frames) => frames.filter((frame) => frame.pts >= window.from - tick / 2 && frame.pts < window.to - tick / 2));
    };
    const segmentExtents = new Map<string, { start: number, end: number, quantum: number, type: string }>();
    const cutGroups: { type: string, shifts: number[], quantum: number }[] = [];
    for (let sourceIndex = 0; sourceIndex < params.sources.length; sourceIndex += 1) {
      originPacketCache.clear();
      const source = params.sources[sourceIndex]!;
      const groups: { type: string, shifts: number[], quantum: number }[] = [];
      const originGroups: { type: string, shifts: number[], quantum: number }[] = [];
      for (const sourceStream of sourceMetadata[sourceIndex]!.streams.filter((stream) => ['video', 'audio'].includes(stream.codec_type))) {
        // Reuse overlapping windows within this track, then release decoded content.
        decodedCache.clear();
        if (source.streamIds != null && !source.streamIds.includes(sourceStream.index)) continue;
        if (params.reencodedVideo && !params.merged && sourceStream.codec_type === 'video') continue;
        if (sourceStream.codec_type === 'audio' && reencodedAudio.has(sourceMappings[sourceIndex]!.get(sourceStream.index)!)) continue;
        const matches = (byTrack.get(`${sourceIndex}:${sourceStream.index}`) ?? []).filter((anchor) => anchor.matches.length === 1);
        if (matches.length === 0) { doubt(`Cannot uniquely match ${sourceStream.codec_type} boundary content in segment ${sourceIndex + 1}`); continue; }
        const target = output.streams[matches[0]!.outputIndex];
        if (target == null) continue;
        const sourceTick = ratio(sourceStream.time_base);
        const outputTick = ratio(target.time_base);
        const quantum = sourceTick / timeScale + outputTick + (sourceStream.codec_type === 'audio' ? 1 / Number(sourceStream.sample_rate) : 0);
        const shifts = matches.map((anchor) => anchor.matches[0]!.pts * outputTick - ((anchor.packet.pts * sourceTick) / timeScale));
        groups.push({ type: sourceStream.codec_type, shifts, quantum });
        for (const anchor of matches) {
          if ((params.merged || (params.deferAudioContentToMerge && sourceStream.codec_name === 'aac')) && (anchor.packet.skip !== anchor.matches[0]!.skip || anchor.packet.discard !== anchor.matches[0]!.discard)) fail('Merge changed audio priming or discard samples on matching content');
          if (params.merged && Number.isFinite(anchor.packet.duration) && Math.abs(anchor.matches[0]!.duration * outputTick - ((anchor.packet.duration * sourceTick) / timeScale)) > sourceTick / timeScale + outputTick) fail(`Merge changed a ${sourceStream.codec_type} packet presentation duration`);
        }
        if (params.merged) {
          segmentExtents.set(`${sourceIndex}:${matches[0]!.outputIndex}`, {
            start: Math.min(...matches.map((anchor) => anchor.matches[0]!.pts * outputTick)),
            end: Math.max(...matches.map((anchor) => (anchor.matches[0]!.pts + anchor.matches[0]!.duration) * outputTick)),
            quantum,
            type: sourceStream.codec_type,
          });
        }
        if (params.deferAudioContentToMerge && sourceStream.codec_type === 'audio' && sourceStream.codec_name === 'aac' && target.codec_name === 'aac') {
          deferredAudioContent = true;
          continue;
        }
        let sourceWindows = packetWindows(matches.map((anchor) => anchor.packet), sourceStream, source.path, finite(sourceMetadata[sourceIndex]!.format.start_time) || 0);
        const outputWindows = packetWindows(matches.map((anchor) => anchor.matches[0]!), target, params.path, finite(output.format.start_time) || 0);
        if (!params.merged && sourceStream.codec_type === 'video') {
          const shift = median(shifts);
          const quantization = sourceTick + outputTick * timeScale;
          sourceWindows = outputWindows.map((window) => ({ path: source.path, stream: sourceStream, from: (window.from - shift) * timeScale - quantization, to: (window.to - shift) * timeScale + quantization, origin: finite(sourceMetadata[sourceIndex]!.format.start_time) || 0 }));
        }
        let sampleReference = { stream: sourceStream, shift: median(shifts), timeScale };
        if (sourceStream.codec_type === 'audio' && source.origins != null) {
          const originTracks: { source: VerificationSource, stream: StreamInfo, meta: Metadata }[] = [];
          for (const origin of source.origins) {
            const meta = await metadata(origin.path);
            for (const index of origin.streamIds ?? meta.streams.map((stream) => stream.index)) {
              const stream = meta.streams.find((candidate) => candidate.index === index);
              if (stream == null) throw new Error('An original verification track is missing');
              originTracks.push({ source: origin, stream, meta });
            }
          }
          const selectedIndex = (source.streamIds ?? sourceMetadata[sourceIndex]!.streams.map((stream) => stream.index)).indexOf(sourceStream.index);
          const reference = originTracks[selectedIndex];
          if (reference == null || reference.stream.codec_type !== 'audio') { doubt('Original audio decoder context does not match the selected part tracks'); continue; }
          const originScale = reference.source.timeScale ?? 1;
          if (!Number.isFinite(originScale) || originScale <= 0) throw new Error('Invalid original playback time scale');
          const originalPackets = await readOriginPackets(reference.source, reference.meta, sourceHashes.get(sourceIndex)!);
          const aligned = matches.flatMap((anchor) => {
            const candidates = originalPackets.get(`${reference.stream.index}:${anchor.packet.hash}`);
            return candidates?.length === 1 ? [{ original: candidates[0]!, output: anchor.matches[0]! }] : [];
          });
          if (aligned.length === 0) { doubt('Cannot align the original audio decoder context to the exported part'); continue; }
          const originalTick = ratio(reference.stream.time_base);
          const originShifts = aligned.map((anchor) => anchor.output.pts * outputTick - ((anchor.original.pts * originalTick) / originScale));
          sampleReference = { stream: reference.stream, shift: median(originShifts), timeScale: originScale };
          const originalOrigin = finite(reference.meta.format.start_time) || 0;
          originGroups.push({ type: 'audio', shifts: originShifts.map((shift) => shift + originalOrigin / originScale), quantum: originalTick / originScale + outputTick + 1 / Number(reference.stream.sample_rate) });
          sourceWindows = packetWindows(aligned.map((anchor) => anchor.original), reference.stream, reference.source.path, finite(reference.meta.format.start_time) || 0);
        }
        let sourceFrames: Frame[];
        try {
          sourceFrames = [];
          for (const window of sourceWindows) sourceFrames.push(...await decoded(window));
        } catch (error) { doubt(`Cannot decode reference boundary: ${String(error)}`); continue; }
        let outputFrames: Frame[];
        try {
          outputFrames = [];
          for (const window of outputWindows) outputFrames.push(...await decoded(window));
        } catch (error) { fail(`Output boundary cannot be decoded: ${String(error)}`); continue; }
        if (params.merged && source.origins == null && (sourceFrames.length !== outputFrames.length || sourceFrames.some((frame, index) => outputFrames[index] == null || Math.abs(frame.duration / timeScale - outputFrames[index]!.duration) > sourceTick / timeScale + outputTick || frame.hash !== outputFrames[index]?.hash))) fail(`Merge changed decoded ${sourceStream.codec_type} boundary content or frame count`);
        if (params.merged && sourceStream.codec_type === 'video' && source.origins != null && (sourceFrames.length !== outputFrames.length || sourceFrames.some((frame, index) => frame.hash !== outputFrames[index]?.hash))) fail('Merge changed decoded video boundary content or frame count');
        if (!params.merged && sourceStream.codec_type === 'video') {
          const packetShift = median(shifts);
          const origin = finite(sourceMetadata[sourceIndex]!.format.start_time) || 0;
          const from = origin + (source.start ?? 0);
          const to = source.end == null ? Infinity : origin + source.end;
          const inSelection = (pts: number) => pts >= from - sourceTick / 2 && pts < to - sourceTick / 2;
          const expectedFrames = sourceFrames.filter((frame) => inSelection(frame.pts) && outputWindows.some((window) => frame.pts / timeScale + packetShift >= window.from - outputTick / 2 && frame.pts / timeScale + packetShift < window.to - outputTick / 2));
          const actualFrames = outputFrames.filter((frame) => inSelection((frame.pts - packetShift) * timeScale));
          const decodedHashes = new Set(sourceFrames.map((frame) => frame.hash));
          if (expectedFrames.length !== actualFrames.length || expectedFrames.some((frame, index) => frame.hash !== actualFrames[index]?.hash) || outputFrames.some((frame) => !decodedHashes.has(frame.hash))) fail('Cut changed decoded video boundary content or frame count');
          if (source.end != null && outputFrames.some((frame) => (frame.pts - packetShift) * timeScale >= to - sourceTick / 2)) fail('Cut presents video frames beyond the selected end boundary');
        }
        const referenceHashes = new Map<string, Frame[]>();
        sourceFrames.forEach((frame) => referenceHashes.set(frame.hash, [...referenceHashes.get(frame.hash) ?? [], frame]));
        const decodedShifts: number[] = [];
        if (sourceStream.codec_type === 'audio') {
          const packetShift = median(shifts);
          const comparison = compareAudioSamples(sourceFrames, outputFrames, sampleReference.shift, sampleReference.timeScale, sampleReference.stream);
          if (!comparison.complete) doubt(`Cannot compare every decoded audio sample at the boundary of segment ${sourceIndex + 1}`);
          else if (!comparison.equal) fail(`Decoded audio boundary samples differ in segment ${sourceIndex + 1}${comparison.mismatchAt == null ? '' : ` at output ${probeTime(comparison.mismatchAt)} s (PCM16 delta ${comparison.difference})`}`);
          else {
            decodedShifts.push(...outputFrames.map((frame) => {
              const referenceTime = (frame.pts - packetShift) * timeScale;
              const sampleTime = Math.round(referenceTime * Number(sourceStream.sample_rate)) / Number(sourceStream.sample_rate);
              return frame.pts - sampleTime / timeScale;
            }));
          }
        } else {
          for (const frame of outputFrames) {
            const references = referenceHashes.get(frame.hash);
            if (references?.length === 1) decodedShifts.push(frame.pts - references[0]!.pts / timeScale);
          }
        }
        if (decodedShifts.length === 0) doubt(`Cannot align decoded ${sourceStream.codec_type} boundary content in segment ${sourceIndex + 1}`);
        else { groups.push({ type: sourceStream.codec_type, shifts: decodedShifts, quantum }); }
        // Decode order can differ from presentation order in the packet pass; only test presented frames here.
        for (let index = 1; index < outputFrames.length; index += 1) {
          if (outputFrames[index]!.pts < outputFrames[index - 1]!.pts) fail('Output presentation timestamps run backwards at a boundary');
        }
      }
      for (const sourceStream of sourceMetadata[sourceIndex]!.streams.filter((stream) => stream.codec_type === 'audio')) {
        const targetIndex = sourceMappings[sourceIndex]!.get(sourceStream.index);
        if (targetIndex == null || !reencodedAudio.has(targetIndex)) continue;
        const target = output.streams[targetIndex]!;
        const lossless = (codec: string | undefined) => codec === 'flac' || /^pcm_[su]\d+(?:le|be)?$/.test(codec ?? '') || ['pcm_bluray', 'pcm_dvd'].includes(codec ?? '');
        if (!lossless(sourceStream.codec_name) || !lossless(target.codec_name)) { doubt('Only explicitly declared lossless PCM/FLAC audio conversions have a sample oracle'); continue; }
        if (sourceStream.sample_rate !== target.sample_rate || sourceStream.channels !== target.channels) { doubt('Declared audio resampling or channel conversion needs a separate content oracle'); continue; }
        const origin = finite(sourceMetadata[sourceIndex]!.format.start_time) || 0;
        const trackStart = finite(sourceStream.start_time);
        const trackEnd = trackStart + finite(sourceStream.duration);
        const from = Math.max(origin + (source.start ?? 0), Number.isFinite(trackStart) ? trackStart : origin);
        const to = Math.min(source.end == null ? finalMediaTime(sourceMetadata[sourceIndex]!) : origin + source.end, Number.isFinite(trackEnd) ? trackEnd : Infinity);
        const context = boundaryContext(sourceMetadata[sourceIndex]!);
        const intervals = [{ from, to: Math.min(to, from + context) }, { from: Math.max(from, to - context), to }];
        if (intervals[1]!.from <= intervals[0]!.to) intervals.splice(0, 2, { from, to });
        const rate = Number(sourceStream.sample_rate);
        const quantum = ratio(sourceStream.time_base) / timeScale + ratio(target.time_base) + 1 / rate;
        let commonShift = groups.length > 0 ? compareBoundaryShifts(groups).commonShift : NaN;
        if (!Number.isFinite(commonShift)) commonShift = (Number.isFinite(finite(target.start_time)) ? finite(target.start_time) : finite(output.format.start_time)) - Math.ceil(from * rate) / (rate * timeScale);
        const convertedShifts: number[] = [];
        const edges = outputEdges.get(target.index);
        if (edges != null) {
          const tick = ratio(target.time_base);
          if (!params.merged || sourceIndex === 0) convertedShifts.push(edges.first.pts * tick + edges.first.skip / rate - Math.ceil(from * rate) / (rate * timeScale));
          if (!params.merged || sourceIndex === params.sources.length - 1) convertedShifts.push((edges.last.pts + edges.last.duration) * tick - edges.last.discard / rate - Math.ceil(to * rate) / (rate * timeScale));
        } else doubt('Cannot identify the actual converted audio endpoints');
        for (const interval of intervals) {
          try {
            const reference = await decode({ path: source.path, stream: sourceStream, from: Math.max(origin, interval.from - context), to: interval.to + context, origin, wholeAudioFrames: true, samples32: true }, signal);
            const start = interval.from / timeScale + commonShift;
            const end = interval.to / timeScale + commonShift;
            const frames = await decode({ path: params.path, stream: target, from: start, to: end, origin: finite(output.format.start_time) || 0, wholeAudioFrames: true, samples32: true }, signal);
            const actual: Frame[] = [];
            for (const frame of frames) {
              const first = Math.max(0, Math.ceil((start - frame.pts) * rate));
              const last = Math.min(frame.samples!.length / (target.channels ?? 1), Math.ceil((end - frame.pts) * rate));
              if (last > first) actual.push({ ...frame, pts: frame.pts + first / rate, duration: (last - first) / rate, samples: frame.samples!.subarray(first * (target.channels ?? 1), last * (target.channels ?? 1)) });
            }
            const comparison = await compareConvertedAudio(reference, actual, commonShift, timeScale, sourceStream, target, signal);
            if (!comparison.complete) doubt('Converted audio sample content cannot be placed uniquely on the source clock');
            else if (!comparison.equal) fail('Declared lossless audio conversion changed decoded samples');
            else convertedShifts.push(...comparison.shifts);
          } catch (error) { doubt(`Declared audio conversion could not be verified: ${String(error)}`); }
        }
        groups.push({ type: 'audio', shifts: convertedShifts, quantum });
      }
      if (params.reencodedVideo && !params.merged) {
        const origin = finite(sourceMetadata[sourceIndex]!.format.start_time) || 0;
        const from = origin + (source.start ?? 0);
        const to = source.end == null ? finalMediaTime(sourceMetadata[sourceIndex]!) : origin + source.end;
        const context = boundaryContext(sourceMetadata[sourceIndex]!);
        let commonShift = groups.length > 0 ? compareBoundaryShifts(groups).commonShift : NaN;
        const windows = [{ from, to: Math.min(to, from + context) }, { from: Math.max(from, to - context), to }];
        if (windows[1]!.from <= windows[0]!.to) windows.splice(0, 2, { from, to });
        const streams = sourceMetadata[sourceIndex]!.streams.filter((stream) => source.streamIds == null || source.streamIds.includes(stream.index));
        for (const sourceStream of streams.filter((stream) => stream.codec_type === 'video')) {
          const target = output.streams[sourceMappings[sourceIndex]!.get(sourceStream.index)!];
          if (target == null) continue;
          for (const interval of windows) {
            try {
              const reference = await decode({ ...interval, path: source.path, stream: sourceStream, origin }, signal, true);
              if (!Number.isFinite(commonShift)) commonShift = (Number.isFinite(finite(target.start_time)) ? finite(target.start_time) : finite(output.format.start_time)) - reference[0]!.pts / timeScale;
              const edges = outputEdges.get(target.index);
              if (edges == null) doubt('Cannot identify the actual re-encoded video endpoints');
              else {
                const tick = ratio(target.time_base);
                if (interval === windows[0]) groups.push({ type: 'video', shifts: [edges.first.pts * tick - reference[0]!.pts / timeScale], quantum: ratio(sourceStream.time_base) + tick });
                if (interval === windows.at(-1)) groups.push({ type: 'video', shifts: [edges.last.pts * tick - reference.at(-1)!.pts / timeScale], quantum: ratio(sourceStream.time_base) + tick });
              }
              const actual = await decode({ from: interval.from / timeScale + commonShift, to: interval.to / timeScale + commonShift, path: params.path, stream: target, origin: finite(output.format.start_time) || 0 }, signal, true);
              if (reference.length !== actual.length) { fail('Re-encoded video boundary frame count changed'); continue; }
              const shifts = actual.map((frame, index) => frame.pts - reference[index]!.pts / timeScale);
              groups.push({ type: 'video', shifts, quantum: ratio(sourceStream.time_base) + ratio(target.time_base) });
              const recognized = actual.filter((frame, index) => frame.hash === reference[index]!.hash).length;
              if (recognized < Math.min(2, reference.length)) doubt('Re-encoded boundary content cannot be recognized conservatively');
              else coverage.perceptualVideo = true;
            } catch (error) { doubt(`Re-encoded video boundary could not be aligned: ${String(error)}`); }
          }
        }
      }
      if (groups.length === 0) doubt(`Segment ${sourceIndex + 1} has no verifiable boundary clock`);
      else if (!compareBoundaryShifts(groups).valid) fail(`Segment ${sourceIndex + 1} no longer has one common audio/video timeline shift`);
      if (!params.merged) {
        const origin = finite(sourceMetadata[sourceIndex]!.format.start_time) || 0;
        cutGroups.push(...groups.map((group) => ({ ...group, shifts: group.shifts.map((shift) => shift + origin / timeScale) })));
      }
      if (originGroups.length > 0 && !compareBoundaryShifts(originGroups).valid) fail(`Original tracks in segment ${sourceIndex + 1} no longer have one common timeline shift`);
    }
    if (!params.merged && cutGroups.length > 0 && !compareBoundaryShifts(cutGroups).valid) fail('Selected inputs no longer share one common audio/video timeline shift');
    if (params.merged) {
      for (let index = 1; index < params.sources.length; index += 1) {
        for (const stream of output.streams.filter((candidate) => ['video', 'audio'].includes(candidate.codec_type))) {
          const previous = segmentExtents.get(`${index - 1}:${stream.index}`);
          const next = segmentExtents.get(`${index}:${stream.index}`);
          if (previous == null || next == null) continue;
          const gap = next.start - previous.end;
          if (Math.abs(gap) > previous.quantum + next.quantum) {
            doubt(`Segment boundary ${index}: ${stream.codec_type} has ${gap > 0 ? 'a gap' : 'an overlap'} of ${Math.abs(gap * 1000).toFixed(3)} ms; an exact stream-copy join cannot be certified`);
          }
        }
      }
    }
    coverage.boundaries = !inconclusive && !deferredAudioContent;
    const finalIdentity = await stat(params.path, { bigint: true });
    if (initialIdentity.ino !== finalIdentity.ino || initialIdentity.size !== finalIdentity.size || initialIdentity.mtimeNs !== finalIdentity.mtimeNs) doubt('Output changed while it was being verified');
    for (const [path, identity] of sourceIdentities) {
      const final = await stat(path);
      if (identity.ino !== final.ino || identity.size !== final.size || identity.mtimeMs !== final.mtimeMs) doubt('A source changed while its output was being verified');
    }
  } catch (error) {
    doubt(signal.aborted ? 'Verification cancelled; output and intermediate files were preserved' : `Verification could not finish: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (deferredAudioContent) issues.push('Copied AAC intermediate awaits the final merge and its original-source PCM content proof; it is not validated for publication');
  let status: ExportVerificationResult['status'] = 'passed';
  if (failed) status = 'failed';
  else if (inconclusive) status = 'inconclusive';
  else if (deferredAudioContent) status = 'pending-merge';
  return { status, ...(signal.aborted ? { cancelled: true } : {}), issues, elapsedMs: performance.now() - job.started, coverage };
}

export function verifyExport(params: VerifyExportParams): Promise<ExportVerificationResult> {
  if (jobs.has(params.id)) return Promise.reject(new Error('Verification id already exists'));
  const job: Job = { controller: new AbortController(), started: performance.now(), state: { id: params.id, phase: 'queued', packets: 0, elapsedMs: 0 } };
  jobs.set(params.id, job);
  // Polling needs recent completed states, not an unbounded session history.
  if (jobs.size > 64) {
    for (const [id, previous] of jobs) {
      if (jobs.size <= 64) break;
      if (previous.state.phase === 'finished') jobs.delete(id);
    }
  }
  const result = queue.then(() => verify(params, job));
  queue = result.then(() => undefined, () => undefined);
  return result.then((value) => {
    job.state.phase = 'finished';
    job.state.result = value;
    return value;
  });
}

export function getExportVerificationState(id: string): ExportVerificationState | undefined {
  const job = jobs.get(id);
  return job == null ? undefined : { ...job.state, elapsedMs: performance.now() - job.started };
}

export function cancelExportVerification(id: string) {
  jobs.get(id)?.controller.abort();
}
