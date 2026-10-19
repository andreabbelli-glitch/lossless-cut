export default function getSelectedAudioStream<T extends { index: number, codec_type?: string }>(streams: readonly T[], selectedIndexes: ReadonlySet<number>) {
  return streams.find((stream) => stream.codec_type === 'audio' && selectedIndexes.has(stream.index))
    ?? streams.find((stream) => stream.codec_type === 'audio');
}
