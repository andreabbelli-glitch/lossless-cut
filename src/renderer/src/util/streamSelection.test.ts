import { expect, it } from 'vitest';

import getSelectedAudioStream from './streamSelection';

const streams = [{ index: 0, codec_type: 'video' }, { index: 2, codec_type: 'audio' }, { index: 5, codec_type: 'audio' }];

it('keeps silence detection available with the implicit default audio selection', () => {
  expect(getSelectedAudioStream(streams, new Set())?.index).toBe(2);
  expect(getSelectedAudioStream(streams, new Set([99]))?.index).toBe(2);
});

it('uses the selected audio stream and distinguishes video-only media', () => {
  expect(getSelectedAudioStream(streams, new Set([5]))?.index).toBe(5);
  expect(getSelectedAudioStream([streams[0]!], new Set())).toBeUndefined();
  expect(getSelectedAudioStream([], new Set())).toBeUndefined();
});
