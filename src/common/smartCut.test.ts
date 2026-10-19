/* eslint-disable import/no-extraneous-dependencies */
import { expect, test } from 'vitest';

import { getCommonMovieTimescale, getSmartCutVideoArgs } from './smartCut.js';

test('a common movie clock represents every track without millisecond rounding', () => {
  expect(getCommonMovieTimescale(['1/15360', '1/48000'])).toBe(384000);
  expect(getCommonMovieTimescale(['1001/30000', '1/44100'])).toBe(4410000);
  expect(getCommonMovieTimescale(['2/90000', '1/48000'])).toBe(720000);
  expect(getCommonMovieTimescale(['0/0'])).toBeUndefined();
});

test('Main10 smart cut explicitly preserves bit depth, codec tag and colour', () => {
  expect(getSmartCutVideoArgs({ codec_name: 'hevc', pix_fmt: 'yuv420p10le', profile: 'Main 10', codec_tag_string: 'hvc1', color_range: 'tv', color_space: 'bt709', color_transfer: 'bt709', color_primaries: 'bt709' }, 2)).toEqual([
    '-c:2', 'libx265', '-pix_fmt:2', 'yuv420p10le', '-profile:2', 'main10', '-x265-params:2', 'open-gop=0', '-tag:2', 'hvc1', '-color_range:2', 'tv', '-colorspace:2', 'bt709', '-color_trc:2', 'bt709', '-color_primaries:2', 'bt709',
  ]);
});

test('H264 does not acquire HEVC or unknown colour settings', () => {
  expect(getSmartCutVideoArgs({ codec_name: 'h264', pix_fmt: 'yuv420p', color_space: 'unknown' }, 0)).toEqual(['-c:0', 'libx264', '-pix_fmt:0', 'yuv420p', '-x264-params:0', 'open-gop=0']);
});
