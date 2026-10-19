/** Mirrors the seek/duration flags used by an ordinary stream-copy export. */
// eslint-disable-next-line import/prefer-default-export
export function getLosslessCutRange({ cutFrom, cutTo, fileDuration, frameDuration, cutFromAdjustmentFrames, cutToAdjustmentFrames }: {
  cutFrom: number,
  cutTo: number,
  fileDuration: number | undefined,
  frameDuration: number,
  cutFromAdjustmentFrames: number,
  cutToAdjustmentFrames: number,
}) {
  const cuttingStart = cutFrom > 0;
  const cuttingEnd = fileDuration == null || !Number.isFinite(fileDuration) || fileDuration <= 0 || cutTo < fileDuration;
  const adjustedFrom = cutFrom + cutFromAdjustmentFrames * frameDuration;
  const adjustedTo = cutTo + cutToAdjustmentFrames * frameDuration;
  // Retain the existing minimum-frame rule and the omission of -ss/-t at file edges.
  const duration = Math.max(adjustedTo - adjustedFrom, frameDuration);
  const start = cuttingStart ? adjustedFrom : 0;
  const end = cuttingEnd ? start + duration : cutTo;
  return { cuttingStart, cuttingEnd, adjustedFrom, duration, start, end };
}
