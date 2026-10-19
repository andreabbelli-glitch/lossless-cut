const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export const splitGraphemes = (name: string) => Array.from(graphemes.segment(name), ({ segment }) => segment);

// Preserve combining scripts and complete emoji clusters; sanitize filesystem punctuation.
// eslint-disable-next-line no-misleading-character-class
export const sanitizeFileName = (name: string) => name.normalize('NFC').replaceAll(/[^\p{L}\p{N}\p{M}\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\u200D\uFE0F ._-]/gu, '_');

export function truncateLabel(name: string, maxLength: number) {
  let result = '';
  for (const { segment } of graphemes.segment(name)) {
    if (result.length + segment.length > Math.max(0, maxLength)) break;
    result += segment;
  }
  return result;
}
