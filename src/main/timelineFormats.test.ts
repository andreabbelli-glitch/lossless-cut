// eslint-disable-next-line import/no-extraneous-dependencies
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

vi.mock('electron', () => ({ app: { isPackaged: false }, clipboard: {}, nativeImage: {} }));
vi.mock('./util.js', () => ({ platform: process.platform, arch: process.arch, isWindows: process.platform === 'win32', isLinux: process.platform === 'linux' }));
vi.mock('./isDev.js', () => ({ default: false }));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const ffmpeg = await import('./ffmpeg');
const { verifyExport } = await import('./exportVerification');

interface Packet { stream_index: number, pts: number, dts: number, duration: number, data_hash: string, side_data_list?: { skip_samples?: number, discard_padding?: number }[] }
interface Probe { packets: Packet[], streams: { index: number, codec_type: string, sample_rate?: string, time_base: string, profile?: string }[] }
let directory: string;
let completedTests = 0;
let negativePhase: string;
let negativePhaseCopy: string;
let fragmented: string;
let fragmentedCopy: string;

const encoding = ['-c:v', 'libx265', '-preset', 'slow', '-crf', '26', '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1', '-x265-params', 'pools=1:frame-threads=1:open-gop=0:keyint=30:min-keyint=30:scenecut=0:bframes=3:log-level=error', '-c:a', 'aac'];
const fragmentation = ['-movflags', '+frag_keyframe+empty_moov+default_base_moof'];

async function probe(path: string): Promise<Probe> {
  const { stdout } = await ffmpeg.runFfprobe(['-v', 'error', '-show_packets', '-show_streams', '-show_data_hash', 'sha256', '-of', 'json', path]);
  return JSON.parse(Buffer.from(stdout).toString()) as Probe;
}

function trackPackets(info: Probe, index: number) {
  return info.packets.filter((packet) => packet.stream_index === index).map(({ pts, dts, duration, data_hash: hash }) => ({ pts, dts, duration, hash }));
}

// ISO BMFF tfdt stores the track's base decode time. Composition offsets live in trun.
function firstVideoDecodeTime(data: Buffer): number | undefined {
  function boxes(from: number, to: number) {
    const result: { type: string, start: number, end: number }[] = [];
    let cursor = from;
    while (cursor + 8 <= to) {
      let size = data.readUInt32BE(cursor);
      const type = data.toString('ascii', cursor + 4, cursor + 8);
      let header = 8;
      if (size === 1) { size = Number(data.readBigUInt64BE(cursor + 8)); header = 16; }
      if (size === 0) size = to - cursor;
      if (size < header || cursor + size > to) throw new Error('Invalid synthetic MP4 box');
      result.push({ type, start: cursor + header, end: cursor + size });
      cursor += size;
    }
    return result;
  }
  for (const moof of boxes(0, data.length).filter(({ type }) => type === 'moof')) {
    for (const traf of boxes(moof.start, moof.end).filter(({ type }) => type === 'traf')) {
      const children = boxes(traf.start, traf.end);
      const tfhd = children.find(({ type }) => type === 'tfhd');
      if (tfhd != null && data.readUInt32BE(tfhd.start + 4) === 1) {
        const tfdt = children.find(({ type }) => type === 'tfdt');
        if (tfdt == null) throw new Error('Missing synthetic MP4 decode clock');
        return data[tfdt.start] === 1 ? Number(data.readBigUInt64BE(tfdt.start + 4)) : data.readUInt32BE(tfdt.start + 4);
      }
    }
  }
  return undefined;
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'llc-timeline-formats-'));
  negativePhase = join(directory, 'aac44100-video18ms.mp4');
  negativePhaseCopy = join(directory, 'aac44100-copy.mp4');
  fragmented = join(directory, 'main10-fragmented.mp4');
  fragmentedCopy = join(directory, 'main10-fragmented-copy.mp4');
  ffmpeg.setCustomFfPath(resolve('ffmpeg', `${process.platform}-${process.arch}`, ...(process.platform === 'win32' || process.platform === 'linux' ? ['lib'] : [])));
  const inputs = ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=96x64:r=30:d=4', '-f', 'lavfi', '-i'];
  await ffmpeg.runFfmpeg([...inputs, 'sine=f=997:r=44100:d=4', '-vf', 'settb=1/60000,setpts=PTS+1080', '-enc_time_base:v', '1/60000', '-fps_mode', 'passthrough', ...encoding, '-video_track_timescale', '60000', '-movie_timescale', '8820000', negativePhase]);
  await ffmpeg.runFfmpeg(['-v', 'error', '-copyts', '-i', negativePhase, '-map', '0', '-c', 'copy', '-video_track_timescale', '60000', '-movie_timescale', '8820000', negativePhaseCopy]);
  await ffmpeg.runFfmpeg([...inputs, 'sine=f=733:r=48000:d=4', ...encoding, '-video_track_timescale', '60000', '-movie_timescale', '240000', ...fragmentation, fragmented]);
  await ffmpeg.runFfmpeg(['-v', 'error', '-copyts', '-i', fragmented, '-map', '0', '-c', 'copy', '-video_track_timescale', '60000', '-movie_timescale', '240000', ...fragmentation, fragmentedCopy]);
}, 30000);

afterAll(async () => {
  if (directory == null) return;
  if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('llc-timeline-formats-')) throw new Error('Unexpected timeline fixture directory');
  if (completedTests !== 2) {
    // eslint-disable-next-line no-console
    console.info(`Synthetic timeline fixture retained for diagnosis: ${directory}`);
    return;
  }
  await rm(directory, { recursive: true, force: true });
});

test('copied AAC 44.1 kHz retains its negative phase relative to Main10 video', async () => {
  const source = await probe(negativePhase);
  const output = await probe(negativePhaseCopy);
  expect(source.streams[1]).toMatchObject({ codec_type: 'audio', sample_rate: '44100', time_base: '1/44100' });
  expect(source.streams[0]).toMatchObject({ profile: 'Main 10', time_base: '1/60000' });
  const firstVideo = source.packets.filter((packet) => packet.stream_index === 0).reduce((minimum, packet) => Math.min(minimum, packet.pts), Infinity) / 60000;
  expect(firstVideo).toBe(0.018);
  // AAC's effective first sample is zero; its first packet also carries the unchanged encoder priming.
  const firstAudio = source.packets.find((packet) => packet.stream_index === 1)!;
  const firstSample = (firstAudio.pts + (firstAudio.side_data_list?.[0]?.skip_samples ?? 0)) / 44100;
  expect(firstAudio.side_data_list?.[0]?.skip_samples).toBe(1024);
  expect(firstSample - firstVideo).toBe(-0.018);
  for (const index of [0, 1]) expect(trackPackets(output, index)).toEqual(trackPackets(source, index));
  expect(output.packets.find((packet) => packet.stream_index === 1)?.side_data_list).toEqual(firstAudio.side_data_list);
  const result = await verifyExport({ id: 'format-aac44100-negative-phase', path: negativePhaseCopy, sources: [{ path: negativePhase }], merged: true });
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'passed', coverage: { structure: true, packetTimestamps: true, boundaries: true } });
  completedTests += 1;
}, 30000);

test('fragmented Main10 copy validates presentation clocks separately from tfdt decode time', async () => {
  const source = await probe(fragmented);
  const output = await probe(fragmentedCopy);
  const firstVideo = source.packets.find((packet) => packet.stream_index === 0)!;
  expect(firstVideoDecodeTime(await readFile(fragmented))).toBe(firstVideo.dts);
  expect(firstVideo.pts).not.toBe(firstVideo.dts);
  for (const index of [0, 1]) expect(trackPackets(output, index)).toEqual(trackPackets(source, index));
  const result = await verifyExport({ id: 'format-main10-fragmented', path: fragmentedCopy, sources: [{ path: fragmented }], merged: true });
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'passed', coverage: { structure: true, packetTimestamps: true, boundaries: true } });
  completedTests += 1;
}, 30000);
