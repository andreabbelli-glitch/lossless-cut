export interface CompatibleCutRange { start: number, end: number }

export interface CompatibleCut extends CompatibleCutRange {
  requested: CompatibleCutRange,
  includedBefore: number,
  includedAfter: number,
  excludedBefore: number,
  excludedAfter: number,
  seekFrom: number,
  readTo: number | undefined,
  duration: number,
  movieTimescale: number,
  filters: { streamIndex: number, expression: string }[],
}

export interface CompatibleSourceIdentity { size: number, mtimeMs: number }

export type CompatibleCutPlan = {
  possible: true,
  issues: string[],
  segments: CompatibleCut[],
  sourceIdentity: CompatibleSourceIdentity,
} | {
  possible: false,
  issues: string[],
  segments: CompatibleCut[],
  sourceIdentity?: undefined,
};

export function getCompatibleTimingArgs(segment: CompatibleCut) {
  return {
    beforeInput: ['-copyts', ...(segment.start > 0 ? ['-seek_timestamp', '1', '-ss', String(segment.seekFrom)] : [])],
    afterInput: [...(segment.readTo != null ? ['-to', String(segment.readTo)] : []), '-avoid_negative_ts', 'disabled', '-output_ts_offset', String(-segment.start), '-movie_timescale', String(segment.movieTimescale)],
    filters: segment.filters,
  };
}
