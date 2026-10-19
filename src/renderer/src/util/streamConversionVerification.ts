import type { VerificationStreamInfo } from '../../../main/exportVerification.js';

/** Declare only conversions explicitly requested by the productive stream map. */
// eslint-disable-next-line import/prefer-default-export
export function getStreamConversionVerification(mapStreamsArgs: readonly string[], selectedStreams: readonly { codec_type: string }[]) {
  const expectedStreams: Partial<VerificationStreamInfo>[] = selectedStreams.map(() => ({}));
  const reencodedAudioStreamIds: number[] = [];
  for (const [index, stream] of selectedStreams.entries()) {
    const codecPosition = mapStreamsArgs.lastIndexOf(`-c:${index}`);
    const codec = codecPosition !== -1 ? mapStreamsArgs[codecPosition + 1] : undefined;
    if (codec != null && codec !== 'copy' && stream.codec_type !== 'video') {
      expectedStreams[index]!.codec_name = codec === 'srt' ? 'subrip' : codec;
      if (stream.codec_type === 'audio') reencodedAudioStreamIds.push(index);
    }
    const ratePosition = mapStreamsArgs.lastIndexOf(`-ar:${index}`);
    const rate = ratePosition !== -1 ? mapStreamsArgs[ratePosition + 1] : undefined;
    if (stream.codec_type === 'audio' && rate != null) expectedStreams[index]!.sample_rate = rate;
  }
  return { expectedStreams, reencodedAudioStreamIds };
}
