import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import sortBy from 'lodash/sortBy';
import { useTranslation } from 'react-i18next';

import type { Frame } from '../ffmpeg';
import { readFramesAroundTime, findNearestKeyFrameTime as ffmpegFindNearestKeyFrameTime, readAllKeyframes as ffmpegReadAllKeyframes } from '../ffmpeg';
import type { FFprobeStream } from '../../../common/ffprobe';
import { getFrameCountRaw } from '../edlFormats';
import type { HandleError } from '../contexts';


const toObj = (map: Frame[]) => Object.fromEntries(map.map((frame) => [frame.time, frame]));

function useKeyframes({ keyframesEnabled, filePath, commandedTime, videoStream, detectedFps, ffmpegExtractWindow, maxKeyframes, currentCutSegOrWholeTimeline, setWorking, setMaxKeyframes, handleError }: {
  keyframesEnabled: boolean,
  filePath: string | undefined,
  commandedTime: number,
  videoStream: FFprobeStream | undefined,
  detectedFps: number | undefined,
  ffmpegExtractWindow: number,
  maxKeyframes: number,
  currentCutSegOrWholeTimeline: { start: number, end: number },
  setWorking: (w: { text: string, abortController?: AbortController } | undefined) => void,
  setMaxKeyframes: (max: number) => void,
  handleError: HandleError,
}) {
  const { t } = useTranslation();

  const readAllController = useRef<AbortController>(undefined);
  const [neighbouringKeyFramesMap, setNeighbouringKeyFrames] = useState<Record<string, Frame>>({});

  const neighbouringKeyFrames = useMemo(() => sortBy(Object.values(neighbouringKeyFramesMap), 'time'), [neighbouringKeyFramesMap]);

  const keyframeByNumber = useMemo(() => {
    const map: Record<number, Frame> = {};
    if (detectedFps != null) {
      neighbouringKeyFrames.forEach((frame) => {
        map[getFrameCountRaw(detectedFps, frame.time)!] = frame;
      });
    }
    return map;
  }, [detectedFps, neighbouringKeyFrames]);

  const findNearestKeyFrameTime = useCallback(({ time, direction }: { time: number, direction: number }) => ffmpegFindNearestKeyFrameTime({ frames: neighbouringKeyFrames, time, direction }), [neighbouringKeyFrames]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNeighbouringKeyFrames({});
    return () => {
      const controller = readAllController.current;
      controller?.abort();
      if (readAllController.current === controller) readAllController.current = undefined;
    };
  }, [filePath, videoStream]);

  useEffect(() => {
    const controller = new AbortController();

    const timer = setTimeout(async () => {
      // See getIntervalAroundTime
      // We still want to calculate keyframes even if not shouldShowKeyframes because maybe we want to be able to step to the closest keyframe
      const shouldRun = keyframesEnabled && filePath != null && videoStream && commandedTime != null;
      if (!shouldRun) return;

      try {
        const newFrames = await readFramesAroundTime({ filePath, aroundTime: commandedTime, streamIndex: videoStream.index, window: ffmpegExtractWindow, signal: controller.signal });
        if (controller.signal.aborted) return;
        const newKeyFrames = newFrames.filter((frame) => frame.keyframe);
        // console.log(newFrames);
        setNeighbouringKeyFrames((existingKeyFramesMap) => {
          let existingFrames = Object.values(existingKeyFramesMap);
          if (existingFrames.length >= maxKeyframes) {
            existingFrames = sortBy(existingFrames, 'createdAt').slice(newKeyFrames.length);
          }
          return {
            ...toObj(existingFrames),
            ...toObj(newKeyFrames),
          };
        });
      } catch (err) {
        if (!controller.signal.aborted) console.error('Failed to read keyframes', err);
      }
    }, 500);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [keyframesEnabled, filePath, commandedTime, videoStream, ffmpegExtractWindow, maxKeyframes]);

  const readAllKeyframes = useCallback(async () => {
    const { start, end } = currentCutSegOrWholeTimeline;

    if (!filePath || !videoStream) return;
    if (readAllController.current != null) return;
    const controller = new AbortController();
    readAllController.current = controller;
    try {
      setWorking({ text: t('Reading all keyframes'), abortController: controller });
      const newKeyFrames = await ffmpegReadAllKeyframes({ filePath, from: start, to: end, streamIndex: videoStream.index, signal: controller.signal });
      if (controller.signal.aborted) return;
      setNeighbouringKeyFrames(toObj(newKeyFrames));
      setMaxKeyframes(newKeyFrames.length);
    } catch (err) {
      if (!controller.signal.aborted) handleError({ err });
    } finally {
      if (readAllController.current === controller) {
        readAllController.current = undefined;
        setWorking(undefined);
      }
    }
  }, [currentCutSegOrWholeTimeline, filePath, handleError, setMaxKeyframes, setWorking, t, videoStream]);


  return {
    neighbouringKeyFrames, findNearestKeyFrameTime, keyframeByNumber, readAllKeyframes,
  };
}

export type FindNearestKeyframeTime = ReturnType<typeof useKeyframes>['findNearestKeyFrameTime'];

export default useKeyframes;
