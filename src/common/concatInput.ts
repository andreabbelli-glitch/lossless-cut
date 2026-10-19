import { formatFfmpegNumber } from './util.js';

/** Durations must be common-clock spans already proven by the cut planner. */
// eslint-disable-next-line import/prefer-default-export
export function buildConcatInput(absolutePaths: readonly string[], certifiedDurations?: readonly number[]) {
  if (certifiedDurations != null && (certifiedDurations.length !== absolutePaths.length || certifiedDurations.some((duration) => !Number.isFinite(duration) || duration <= 0))) {
    throw new Error('Certified concat spans must match the input count and be finite positive durations');
  }
  let cumulativeDuration = 0;
  let previousBoundaryUs = 0;
  return absolutePaths.map((path, index) => {
    if (/[\r\n]/.test(path)) throw new Error('Concat input filenames cannot contain line breaks');
    const file = `file 'file:${path.replaceAll("'", String.raw`'\''`)}'`;
    if (certifiedDurations == null) return file;
    // ffconcat stores durations in microseconds. Quantize the shared boundaries,
    // rather than each span independently, so rounding cannot accumulate at joins.
    cumulativeDuration += certifiedDurations[index]!;
    const boundaryUs = Math.round(cumulativeDuration * 1_000_000);
    const durationUs = boundaryUs - previousBoundaryUs;
    if (!Number.isSafeInteger(boundaryUs) || durationUs <= 0) throw new Error('Certified concat spans cannot be represented on the concat microsecond clock');
    previousBoundaryUs = boundaryUs;
    return `${file}\nduration ${formatFfmpegNumber(durationUs / 1_000_000)}`;
  }).join('\n');
}
