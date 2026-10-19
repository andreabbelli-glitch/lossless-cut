/* eslint-disable import/no-extraneous-dependencies */
import { expect, test } from 'vitest';

import { escapeFfmetadata, getMergedProvenanceMetadataArgs, getProvenanceMetadataArgs, getProcessStderr, isExpectedAttachmentExit, serializeDispositions } from './exportMetadata.js';

test('chapter escaping preserves special characters and CRLF as one escaped newline', () => {
  expect(escapeFfmetadata('A\\B=#;\r\nC')).toBe('A\\\\B\\=\\#\\;\\\nC');
});

test('dispositions retain every active flag and explicitly clear an empty set', () => {
  expect(serializeDispositions({ default: 1, forced: 1, hearing_impaired: 1, dub: 0 })).toBe('default+forced+hearing_impaired');
  expect(serializeDispositions({ default: 0 })).toBe('0');
  expect(serializeDispositions(undefined)).toBe('0');
});

test('attachment diagnostic works for text and buffered process stderr', () => {
  const message = 'At least one output file must be specified';
  expect(getProcessStderr(Uint8Array.from(Array.from(message, (character) => character.codePointAt(0)!)))).toBe(message);
  expect(getProcessStderr(message)).toBe(message);
  expect(getProcessStderr(undefined)).toBe('');
});

test('attachment extraction does not hide another error or a different exit code', () => {
  const expected = 'At least one output file must be specified';
  expect(isExpectedAttachmentExit(1, Uint8Array.from(Array.from(`${expected}\r\n`, (character) => character.codePointAt(0)!)))).toBe(true);
  expect(isExpectedAttachmentExit(1, `Permission denied\n${expected}`)).toBe(false);
  expect(isExpectedAttachmentExit(2, expected)).toBe(false);
});

test('compression provenance keeps the original comment and restores its UUID/profile fallback', () => {
  const marker = JSON.stringify({ id: '12345678-1234-1234-1234-123456789abc', profile: 'hevc-main10-crf26-slow-v1', version: 1, generation: 1 });
  const args = getProvenanceMetadataArgs({ STASH_COMPRESSION: marker, COMMENT: 'Original comment' });
  expect(args).toEqual(['-metadata', `stash_compression=${marker}`, '-metadata', 'comment=Original comment\nSTASH-COMPRESSION:v1:12345678-1234-1234-1234-123456789abc:hevc-main10-crf26-slow-v1']);
  expect(getProvenanceMetadataArgs({ comment: 'Ordinary unmarked file' })).toEqual([]);
});

test('merging marked inputs retains every source identity in the comment fallback', () => {
  const profile = 'hevc-main10-crf26-slow-v1';
  const ids = ['12345678-1234-1234-1234-123456789abc', '87654321-4321-4321-4321-cba987654321'];
  const args = getMergedProvenanceMetadataArgs(ids.map((id) => ({ stash_compression: JSON.stringify({ id, profile, version: 1, generation: 1 }) })));
  expect(args.filter((value) => value.startsWith('stash_compression='))).toHaveLength(1);
  expect(args.at(-1)).toBe(`comment=STASH-COMPRESSION:v1:${ids[0]}:${profile}\nSTASH-COMPRESSION:v1:${ids[1]}:${profile}`);
});

test('marked secondary inputs preserve the unmarked main comment and every selected provenance identity', () => {
  const profile = 'hevc-main10-crf26-slow-v1';
  const marker = JSON.stringify({ id: '12345678-1234-1234-1234-123456789abc', profile, version: 1, generation: 1 });
  const secondaryFallback = `STASH-COMPRESSION:v1:87654321-4321-4321-4321-cba987654321:${profile}`;
  expect(getMergedProvenanceMetadataArgs([
    { COMMENT: 'Original main comment' },
    { STASH_COMPRESSION: marker, comment: 'Secondary comment' },
    { comment: secondaryFallback },
  ])).toEqual(['-metadata', `stash_compression=${marker}`, '-metadata', `comment=Original main comment\nSecondary comment\nSTASH-COMPRESSION:v1:12345678-1234-1234-1234-123456789abc:${profile}\n${secondaryFallback}`]);
});

test('ordinary comments do not force global metadata when no selected source has provenance', () => {
  expect(getMergedProvenanceMetadataArgs([{ comment: 'Main comment' }, undefined, { COMMENT: 'Secondary comment' }])).toEqual([]);
});

test('a secondary tag retains its own fallback when its comment already identifies another source', () => {
  const profile = 'hevc-main10-crf26-slow-v1';
  const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003'];
  const marker = (id: string) => JSON.stringify({ version: 1, id, profile, generation: 1 });
  const fallback = (id: string) => `STASH-COMPRESSION:v1:${id}:${profile}`;
  expect(getMergedProvenanceMetadataArgs([
    { stash_compression: marker(ids[0]!), comment: fallback(ids[0]!) },
    { stash_compression: marker(ids[1]!), comment: fallback(ids[2]!) },
  ])).toEqual(['-metadata', `stash_compression=${marker(ids[0]!)}`, '-metadata', `comment=${fallback(ids[0]!)}\n${fallback(ids[2]!)}\n${fallback(ids[1]!)}`]);
});
