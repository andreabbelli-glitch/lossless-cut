// eslint-disable-next-line import/no-extraneous-dependencies
import { expect, test } from 'vitest';
import { getStreamConversionVerification } from './streamConversionVerification.js';
import { getMapStreamsArgs } from './streams.js';
import type { LiteFFprobeStream } from '../types.js';

function conversions(streams: LiteFFprobeStream[], outFormat: string, ids = streams.map((stream) => stream.index)) {
  const args = getMapStreamsArgs({ allFilesMeta: { input: { streams } }, copyFileStreams: [{ path: 'input', streamIds: ids }], outFormat, needFlac: true });
  return getStreamConversionVerification(args, ids.map((index) => streams.find((stream) => stream.index === index)!));
}

const disposition: LiteFFprobeStream['disposition'] = { default: 0, dub: 0, original: 0, comment: 0, lyrics: 0, karaoke: 0, forced: 0, hearing_impaired: 0, visual_impaired: 0, clean_effects: 0, attached_pic: 0, timed_thumbnails: 0, captions: 0, descriptions: 0, metadata: 0, dependent: 0, still_image: 0 };
const audio = (codecName: string, index = 7): LiteFFprobeStream => ({ index, codec_type: 'audio', codec_name: codecName, codec_tag: '0', time_base: '1/48000', sample_rate: '48000', disposition });
const subtitle: LiteFFprobeStream = { index: 4, codec_type: 'subtitle', codec_name: 'subrip', codec_tag: '0', time_base: '1/1000', disposition };

test('subtitle muxer conversion is explicit and uses output order', () => {
  expect(conversions([audio('aac'), subtitle], 'mp4', [4, 7])).toEqual({ expectedStreams: [{ codec_name: 'mov_text' }, {}], reencodedAudioStreamIds: [] });
  expect(conversions([{ ...subtitle, codec_name: 'mov_text' }], 'matroska')).toEqual({ expectedStreams: [{ codec_name: 'subrip' }], reencodedAudioStreamIds: [] });
});

test('lossless PCM and FLAC conversions require declared audio verification', () => {
  expect(conversions([audio('pcm_bluray')], 'mov')).toEqual({ expectedStreams: [{ codec_name: 'pcm_s24le' }], reencodedAudioStreamIds: [0] });
  expect(conversions([audio('pcm_dvd')], 'matroska')).toEqual({ expectedStreams: [{ codec_name: 'pcm_s32le' }], reencodedAudioStreamIds: [0] });
  expect(conversions([audio('flac')], 'flac')).toEqual({ expectedStreams: [{ codec_name: 'flac' }], reencodedAudioStreamIds: [0] });
});

test('an intentional DV sample-rate conversion is declared without changing copied AAC', () => {
  expect(conversions([{ ...audio('pcm_s16le'), sample_rate: '44100' }], 'dv')).toEqual({ expectedStreams: [{ codec_name: 'pcm_s16le', sample_rate: '48000' }], reencodedAudioStreamIds: [0] });
  expect(conversions([audio('aac')], 'mp4')).toEqual({ expectedStreams: [{}], reencodedAudioStreamIds: [] });
});
