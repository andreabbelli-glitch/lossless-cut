import { useState, useRef, useEffect, useCallback } from 'react';
import sortBy from 'lodash/sortBy';
import invariant from 'tiny-invariant';

import { renderWaveformPng, safeCreateBlob } from '../ffmpeg';
import { isExecaError } from '../util';
import type { OverviewWaveform, WaveformSlice } from '../types';
import type { FFprobeStream } from '../../../common/ffprobe';

const maxWaveforms = 100;
const color = '#ffffff';

export default ({ filePath, relevantTime, fileDuration, waveformEnabled, audioStream, ffmpegExtractWindow, inputFormatName }: {
  filePath: string | undefined,
  relevantTime: number,
  fileDuration: number | undefined,
  waveformEnabled: boolean,
  audioStream: FFprobeStream | undefined,
  ffmpegExtractWindow: number,
  inputFormatName?: string | undefined,
}) => {
  const [waveforms, setWaveforms] = useState<WaveformSlice[]>([]);
  const [overviewWaveform, setOverviewWaveform] = useState<OverviewWaveform>();
  const waveformsRef = useRef<WaveformSlice[]>([]);
  const overviewController = useRef<AbortController>(undefined);

  const updateWaveforms = useCallback((update: (current: WaveformSlice[]) => WaveformSlice[]) => {
    const next = update(waveformsRef.current);
    waveformsRef.current = next;
    setWaveforms(next);
  }, []);

  useEffect(() => {
    updateWaveforms(() => []);
    setOverviewWaveform(undefined);
    return () => overviewController.current?.abort();
  }, [filePath, audioStream, updateWaveforms]);

  const waveformStartTime = Math.floor(relevantTime / ffmpegExtractWindow) * ffmpegExtractWindow;
  const fastSeek = audioStream?.codec_name === 'aac' && (inputFormatName?.split(',').some((format) => format === 'mov' || format === 'matroska') ?? false);

  useEffect(() => {
    const controller = new AbortController();
    const pending = new Set<WaveformSlice>();

    (async () => {
      if (!filePath || fileDuration == null || !audioStream || !waveformEnabled) return;
      const times = [waveformStartTime, waveformStartTime + ffmpegExtractWindow, waveformStartTime - ffmpegExtractWindow];
      for (const time of times) {
        if (controller.signal.aborted) return;
        // eslint-disable-next-line no-continue
        if (time < 0 || time >= fileDuration || waveformsRef.current.some((waveform) => waveform.from === time)) continue;
        const duration = Math.min(ffmpegExtractWindow, fileDuration - time);
        const waveform: WaveformSlice = { from: time, to: time + duration, duration, createdAt: new Date() };
        pending.add(waveform);
        updateWaveforms((current) => [...sortBy(current, 'createdAt').slice(current.length >= maxWaveforms ? 1 : 0), waveform]);
        // A global export abort can interrupt background work. Retry once, while
        // cancellation of this session always stops immediately.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const { buffer } = await renderWaveformPng({ filePath, start: time, duration, color, streamIndex: audioStream.index, timeout: 10000, signal: controller.signal, fastSeek });
            if (controller.signal.aborted) return;
            const url = URL.createObjectURL(safeCreateBlob(buffer, { type: 'image/png' }));
            updateWaveforms((current) => current.map((item) => (item === waveform ? { ...item, url } : item)));
            break;
          } catch (err) {
            if (controller.signal.aborted) return;
            if (isExecaError(err) && err.isCanceled) {
              // eslint-disable-next-line no-continue
              if (attempt === 0) continue;
              updateWaveforms((current) => current.filter((item) => item !== waveform));
            } else {
              console.error('Failed to render waveform', err);
              updateWaveforms((current) => current.map((item) => (item === waveform ? { ...item, failed: true } : item)));
            }
            break;
          }
        }
        pending.delete(waveform);
      }
    })();

    return () => {
      controller.abort();
      // Remove only this request's unfinished objects, never a newer file's
      // slice which happens to have the same start timestamp.
      updateWaveforms((current) => current.filter((item) => !pending.has(item)));
    };
  }, [audioStream, ffmpegExtractWindow, fileDuration, filePath, waveformEnabled, waveformStartTime, updateWaveforms, fastSeek]);

  const lastWaveformsRef = useRef<WaveformSlice[]>([]);
  useEffect(() => {
    const activeUrls = new Set(waveforms.map((waveform) => waveform.url));
    for (const waveform of lastWaveformsRef.current) {
      if (waveform.url != null && !activeUrls.has(waveform.url)) URL.revokeObjectURL(waveform.url);
    }
    lastWaveformsRef.current = waveforms;
  }, [waveforms]);

  const renderOverviewWaveform = useCallback(async () => {
    invariant(filePath != null);
    invariant(audioStream != null);
    overviewController.current?.abort();
    const controller = new AbortController();
    overviewController.current = controller;
    try {
      const { buffer } = await renderWaveformPng({ filePath, color, streamIndex: audioStream.index, resample: 10000, signal: controller.signal });
      if (!controller.signal.aborted) setOverviewWaveform({ createdAt: new Date(), url: URL.createObjectURL(safeCreateBlob(buffer, { type: 'image/png' })) });
    } catch (err) {
      if (!controller.signal.aborted) throw err;
    }
  }, [audioStream, filePath]);

  useEffect(() => () => {
    if (overviewWaveform?.url != null) URL.revokeObjectURL(overviewWaveform.url);
  }, [overviewWaveform]);

  useEffect(() => () => {
    for (const waveform of waveformsRef.current) {
      if (waveform.url != null) URL.revokeObjectURL(waveform.url);
    }
  }, []);

  return { overviewWaveform, waveforms, renderOverviewWaveform };
};
