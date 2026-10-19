// eslint-disable-next-line import/no-extraneous-dependencies
import { afterEach, expect, test, vi } from 'vitest';
import type { FFprobeStream } from '../../../common/ffprobe';

const harness = vi.hoisted(() => {
  interface Slot { value?: unknown, deps?: readonly unknown[], cleanup?: (() => void) | undefined }
  let slots: Slot[] = [];
  let cursor = 0;
  let effects: (() => void)[] = [];
  let seededRefs: unknown[] = [];
  const nextSlot = () => { const index = cursor; cursor += 1; return index; };
  const same = (a: readonly unknown[] | undefined, b: readonly unknown[]) => a != null && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const memoize = (factory: () => unknown, deps: readonly unknown[]) => {
    const index = nextSlot();
    if (!same(slots[index]?.deps, deps)) slots[index] = { value: factory(), deps };
    return slots[index]!.value;
  };
  return {
    memo: (component: unknown) => component,
    seedRefs: (values: unknown[]) => { seededRefs = values; },
    useMemo: memoize,
    useCallback: (callback: unknown, deps: readonly unknown[]) => memoize(() => callback, deps),
    useRef(value: unknown) {
      const index = nextSlot();
      slots[index] ??= { value: { current: seededRefs.length > 0 ? seededRefs.shift() : value } };
      return slots[index]!.value;
    },
    useState(value: unknown) {
      const index = nextSlot();
      slots[index] ??= { value };
      const slot = slots[index]!;
      return [slot.value, (next: unknown) => { slot.value = typeof next === 'function' ? (next as (old: unknown) => unknown)(slot.value) : next; }];
    },
    useEffect(effect: () => (() => void) | undefined, deps: readonly unknown[]) {
      const index = nextSlot();
      slots[index] ??= {};
      const slot = slots[index]!;
      if (!same(slot.deps, deps)) {
        effects.push(() => { slot.cleanup?.(); slot.cleanup = effect(); });
        slot.deps = deps;
      }
    },
    render<T>(callback: () => T) {
      cursor = 0;
      const result = callback();
      const pending = effects;
      effects = [];
      pending.forEach((effect) => effect());
      return result;
    },
    reset() {
      slots.forEach((slot) => slot.cleanup?.());
      slots = [];
      effects = [];
      cursor = 0;
      seededRefs = [];
    },
  };
});
const media = vi.hoisted(() => ({ readFramesAroundTime: vi.fn(), readAllKeyframes: vi.fn(), renderWaveformPng: vi.fn() }));
vi.mock('react', () => harness);
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (text: string) => text }) }));
vi.mock('../edlFormats', () => ({ getFrameCountRaw: vi.fn() }));
vi.mock('../swal', () => ({ showPlaybackFailedMessage: vi.fn() }));
vi.mock('../util', () => ({ isExecaError: (error: { isCanceled?: boolean }) => error?.isCanceled != null, getFrameDuration: () => 1 / 30 }));
vi.mock('../ffmpeg', () => ({ ...media, findNearestKeyFrameTime: vi.fn(), safeCreateBlob: (buffer: Uint8Array) => new Blob([new Uint8Array(buffer)]) }));
vi.mock('../isDev', () => ({ default: false }));

const { default: useKeyframes } = await import('./useKeyframes');
const { default: useWaveform } = await import('./useWaveform');
const { default: useVideo } = await import('./useVideo');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolve2, reject2) => { resolve = resolve2; reject = reject2; });
  return { promise, resolve, reject };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

afterEach(() => {
  harness.reset();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

test('file B is requested without more interaction and late keyframes from A cannot enter its cache', async () => {
  vi.useFakeTimers();
  const a = deferred<{ time: number, keyframe: boolean, createdAt: Date }[]>();
  const b = deferred<{ time: number, keyframe: boolean, createdAt: Date }[]>();
  media.readFramesAroundTime.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
  const options = { keyframesEnabled: true, commandedTime: 0, videoStream: { index: 0 } as FFprobeStream, detectedFps: undefined, ffmpegExtractWindow: 10, maxKeyframes: 100, currentCutSegOrWholeTimeline: { start: 0, end: 10 }, setWorking: vi.fn(), setMaxKeyframes: vi.fn(), handleError: vi.fn() };
  harness.render(() => useKeyframes({ ...options, filePath: 'A' }));
  await vi.advanceTimersByTimeAsync(500);
  harness.render(() => useKeyframes({ ...options, filePath: 'B' }));
  await vi.advanceTimersByTimeAsync(500);
  expect(media.readFramesAroundTime.mock.calls.map(([request]) => request.filePath)).toEqual(['A', 'B']);
  expect(media.readFramesAroundTime.mock.calls[0]![0].signal.aborted).toBe(true);
  b.resolve([{ time: 222, keyframe: true, createdAt: new Date() }]);
  await flush();
  a.resolve([{ time: 111, keyframe: true, createdAt: new Date() }]);
  await flush();
  expect(harness.render(() => useKeyframes({ ...options, filePath: 'B' })).neighbouringKeyFrames.map((frame) => frame.time)).toEqual([222]);
});

test('an old full scan cannot clear busy state or block a full scan for the new file', async () => {
  const a = deferred<[]>();
  const b = deferred<[]>();
  media.readAllKeyframes.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
  const setWorking = vi.fn();
  const options = { keyframesEnabled: false, commandedTime: 0, videoStream: { index: 0 } as FFprobeStream, detectedFps: undefined, ffmpegExtractWindow: 10, maxKeyframes: 100, currentCutSegOrWholeTimeline: { start: 0, end: 10 }, setWorking, setMaxKeyframes: vi.fn(), handleError: vi.fn() };
  const first = harness.render(() => useKeyframes({ ...options, filePath: 'A' })).readAllKeyframes();
  const second = harness.render(() => useKeyframes({ ...options, filePath: 'B' })).readAllKeyframes();
  expect(media.readAllKeyframes).toHaveBeenCalledTimes(2);
  setWorking.mockClear();
  a.resolve([]);
  await first;
  expect(setWorking).not.toHaveBeenCalled();
  b.resolve([]);
  await second;
  expect(setWorking).toHaveBeenCalledExactlyOnceWith(undefined);
});

test.each(['success', 'error'] as const)('late waveform %s from A cannot remove or replace B at the same timestamp', async (outcome) => {
  const a = deferred<{ buffer: Uint8Array }>();
  const b = deferred<{ buffer: Uint8Array }>();
  media.renderWaveformPng.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:B');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  const options = { relevantTime: 0, fileDuration: 1, waveformEnabled: true, audioStream: { index: 0 } as FFprobeStream, ffmpegExtractWindow: 10 };
  harness.render(() => useWaveform({ ...options, filePath: 'A' }));
  harness.render(() => useWaveform({ ...options, filePath: 'B' }));
  b.resolve({ buffer: new Uint8Array([2]) });
  await flush();
  if (outcome === 'error') a.reject(new Error('old request failed'));
  else a.resolve({ buffer: new Uint8Array([1]) });
  await flush();
  const result = harness.render(() => useWaveform({ ...options, filePath: 'B' }));
  expect(result.waveforms).toHaveLength(1);
  expect(result.waveforms[0]?.url).toBe('blob:B');
  expect(revoke).not.toHaveBeenCalledWith('blob:B');
});

test('a globally cancelled waveform retries without a permanent failed slice or idle polling', async () => {
  media.renderWaveformPng.mockRejectedValueOnce({ isCanceled: true }).mockResolvedValueOnce({ buffer: new Uint8Array([2]) });
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:retry');
  const options = { relevantTime: 0, fileDuration: 1, waveformEnabled: true, audioStream: { index: 0 } as FFprobeStream, ffmpegExtractWindow: 10, filePath: 'A' };
  harness.render(() => useWaveform(options));
  await flush();
  expect(harness.render(() => useWaveform(options)).waveforms[0]?.url).toBe('blob:retry');
  expect(media.renderWaveformPng).toHaveBeenCalledTimes(2);
});

test('a queued seek from A is cleared before B receives a late seeked event', () => {
  const a = harness.render(() => useVideo({ filePath: 'A' }));
  a.videoRef.current = { currentTime: 0, duration: 100 } as HTMLVideoElement;
  a.seekAbs(10);
  a.seekAbs(20);
  const b = harness.render(() => useVideo({ filePath: 'B' }));
  b.videoRef.current = { currentTime: 0, duration: 100 } as HTMLVideoElement;
  b.onSeeked({} as never);
  expect(b.videoRef.current.currentTime).toBe(0);
});

test('missing seeked events still execute the latest seek in the current session', async () => {
  vi.useFakeTimers();
  const video = harness.render(() => useVideo({ filePath: 'A' }));
  video.videoRef.current = { currentTime: 0, duration: 100 } as HTMLVideoElement;
  video.seekAbs(10);
  video.seekAbs(20);
  await vi.advanceTimersByTimeAsync(1000);
  expect(video.videoRef.current.currentTime).toBe(20);
});

test('compatibility preview cancels a trailing restart when its session is disposed', async () => {
  vi.useFakeTimers();
  const createMediaSourceStream = vi.fn(() => ({ abort: vi.fn(), promise: Promise.resolve(vi.fn().mockResolvedValue(null)) }));
  vi.stubGlobal('window', { require: () => ({ require: () => ({ compatPlayer: { createMediaSourceStream } }) }) });
  const sourceBuffer = Object.assign(new EventTarget(), { timestampOffset: 0, buffered: { length: 0 }, appendBuffer: vi.fn(), abort: vi.fn() });
  vi.stubGlobal('MediaSource', class extends EventTarget {
    static isTypeSupported() { return true; }

    readyState = 'open';

    sourceBuffer = sourceBuffer;

    constructor() {
      super();
      setTimeout(() => this.dispatchEvent(new Event('sourceopen')), 0);
    }

    addSourceBuffer() { return this.sourceBuffer; }
  });
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  const { default: MediaSourcePlayer } = await import('../MediaSourcePlayer');
  const video = Object.assign(new EventTarget(), { videoWidth: 128, videoHeight: 96, pause: vi.fn(), removeAttribute: vi.fn(), playbackRate: 1 });
  const master = { currentTime: 0, playbackRate: 1, paused: true, ended: false, volume: 1 } as HTMLVideoElement;
  harness.seedRefs([video, { getContext: () => ({ drawImage: vi.fn() }) }]);
  harness.render(() => MediaSourcePlayer({ rotate: undefined, filePath: 'A', videoStream: undefined, audioStreams: [], masterVideoRef: { current: master }, mediaSourceQuality: 0, ffmpegHwaccel: 'none', baseVideoStyle: {} }));
  await vi.advanceTimersByTimeAsync(1);
  // Reset within the leading debounce interval, leaving a trailing start due.
  master.currentTime = -1;
  await vi.advanceTimersByTimeAsync(30);
  harness.reset();
  await vi.advanceTimersByTimeAsync(1000);
  expect(createMediaSourceStream).toHaveBeenCalledOnce();
});
