const decimalPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

export function parseFiniteNumber(value: string, integer = false) {
  const text = value.trim();
  if (!(integer ? /^[+-]?\d+$/ : decimalPattern).test(text)) return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseOutputPlaybackRate(value: string, detectedFps: number | undefined) {
  const text = value.trim();
  if (text === '') return 1;
  const parts = text.split('/');
  if (parts.length > 2) return undefined;
  const numerator = parseFiniteNumber(parts[0]!);
  const denominator = parts.length === 2 ? parseFiniteNumber(parts[1]!) : 1;
  if (numerator == null || denominator == null || numerator <= 0 || denominator <= 0) return undefined;
  const fps = detectedFps != null && Number.isFinite(detectedFps) && detectedFps > 0 ? detectedFps : 1;
  const rate = (numerator / denominator) / fps;
  return Number.isFinite(rate) && rate > 0 ? rate : undefined;
}
