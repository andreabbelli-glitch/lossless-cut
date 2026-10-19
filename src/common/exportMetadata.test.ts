import { expect, test } from 'vitest';

import { escapeFfmetadata, getProcessStderr, isExpectedAttachmentExit, serializeDispositions } from './exportMetadata';

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
  expect(getProcessStderr(new TextEncoder().encode(message))).toBe(message);
  expect(getProcessStderr(message)).toBe(message);
  expect(getProcessStderr(undefined)).toBe('');
});

test('attachment extraction does not hide another error or a different exit code', () => {
  const expected = 'At least one output file must be specified';
  expect(isExpectedAttachmentExit(1, new TextEncoder().encode(`${expected}\r\n`))).toBe(true);
  expect(isExpectedAttachmentExit(1, `Permission denied\n${expected}`)).toBe(false);
  expect(isExpectedAttachmentExit(2, expected)).toBe(false);
});
