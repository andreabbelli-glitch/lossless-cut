// The caller owns the sorted index; searching never copies or reorders it.
// eslint-disable-next-line import/prefer-default-export
export function findDirectionalKeyframeTime(frames: readonly { time: number, keyframe: boolean }[], time: number, direction: number) {
  if (!Number.isFinite(time)) return undefined;
  let low = 0;
  let high = frames.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (frames[middle]!.time < time || (direction <= 0 && frames[middle]!.time === time)) low = middle + 1;
    else high = middle;
  }
  for (let index = direction > 0 ? low : low - 1; index >= 0 && index < frames.length; index += direction > 0 ? 1 : -1) {
    if (frames[index]!.keyframe) return frames[index]!.time;
  }
  return undefined;
}
