import type { FFprobeStream } from './ffprobe.js';

export function getCommonMovieTimescale(timeBases: (string | undefined)[]) {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  let clock = 1;
  for (const timeBase of timeBases) {
    const [numerator, denominator] = (timeBase ?? '').split('/').map(Number);
    if (numerator == null || denominator == null || !Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || numerator <= 0 || denominator <= 0) return undefined;
    const reduced = denominator / gcd(numerator, denominator);
    clock = (clock / gcd(clock, reduced)) * reduced;
    if (!Number.isSafeInteger(clock) || clock > 2147483647) return undefined;
  }
  return clock;
}

export function getSmartCutVideoArgs(stream: Pick<FFprobeStream, 'codec_name'> & Partial<Pick<FFprobeStream, 'pix_fmt' | 'profile' | 'color_range' | 'color_space' | 'color_transfer' | 'color_primaries' | 'codec_tag_string'>>, outputIndex: number) {
  const args: string[] = [];
  if (stream.codec_name === 'h264' || stream.codec_name === 'hevc') {
    args.push(`-c:${outputIndex}`, stream.codec_name === 'h264' ? 'libx264' : 'libx265');
    if (stream.pix_fmt) args.push(`-pix_fmt:${outputIndex}`, stream.pix_fmt);
    if (stream.codec_name === 'hevc') {
      if (stream.profile === 'Main 10') args.push(`-profile:${outputIndex}`, 'main10');
      if (stream.profile === 'Main') args.push(`-profile:${outputIndex}`, 'main');
      args.push(`-x265-params:${outputIndex}`, 'open-gop=0');
      if (stream.codec_tag_string === 'hvc1') args.push(`-tag:${outputIndex}`, 'hvc1');
    } else {
      args.push(`-x264-params:${outputIndex}`, 'open-gop=0');
      const profile = ({ 'Constrained Baseline': 'baseline', Baseline: 'baseline', Main: 'main', High: 'high', 'High 10': 'high10', 'High 4:2:2': 'high422', 'High 4:4:4 Predictive': 'high444' } as Record<string, string>)[stream.profile ?? ''];
      if (profile) args.push(`-profile:${outputIndex}`, profile);
    }
  }
  for (const [key, flag] of [['color_range', 'color_range'], ['color_space', 'colorspace'], ['color_transfer', 'color_trc'], ['color_primaries', 'color_primaries']] as const) {
    const value = stream[key];
    if (value && value !== 'unknown' && value !== 'unspecified' && value !== 'reserved') args.push(`-${flag}:${outputIndex}`, value);
  }
  return args;
}
