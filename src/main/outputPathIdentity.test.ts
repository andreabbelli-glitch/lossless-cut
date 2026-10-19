import { mkdtemp, writeFile, link, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// eslint-disable-next-line import/no-extraneous-dependencies
import { expect, test } from 'vitest';

import { checkOutputPathIdentity, getFuturePathKey } from './outputPathIdentity';

test('future outputs follow directory case and normalization semantics', () => {
  const sensitive = { caseSensitive: true, normalizationSensitive: true };
  const insensitive = { caseSensitive: false, normalizationSensitive: false };
  expect(getFuturePathKey('dir', ['Intro.mp4'], sensitive)).not.toBe(getFuturePathKey('dir', ['intro.mp4'], sensitive));
  expect(getFuturePathKey('dir', ['Intro.mp4'], insensitive)).toBe(getFuturePathKey('dir', ['intro.mp4'], insensitive));
  expect(getFuturePathKey('dir', ['e\u0301.mp4'], insensitive)).toBe(getFuturePathKey('dir', ['é.mp4'], insensitive));
  expect(getFuturePathKey('dir', ['e\u0301.mp4'], sensitive)).not.toBe(getFuturePathKey('dir', ['é.mp4'], sensitive));
});

test('protects source identity through hard links and cleans its directory probe', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'losslesscut-paths-'));
  try {
    const source = join(directory, 'source.mp4');
    const alias = join(directory, 'alias.mp4');
    await writeFile(source, 'original');
    await link(source, alias);
    expect(await checkOutputPathIdentity({ inputPaths: [source], outputPaths: [alias], refresh: true })).toEqual({ kind: 'input', path: alias, otherPath: source });
    expect((await readdir(directory)).sort()).toEqual(['alias.mp4', 'source.mp4']);
    const output = join(directory, 'new.mp4');
    expect(await checkOutputPathIdentity({ inputPaths: [source], outputPaths: [output, output] })).toEqual({ kind: 'duplicate', path: output, otherPath: output });
    expect((await readdir(directory)).sort()).toEqual(['alias.mp4', 'source.mp4']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.runIf(process.platform === 'win32')('does not conflate multi-character Unicode uppercase expansions on NTFS', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'losslesscut-unicode-'));
  try {
    expect(await checkOutputPathIdentity({ inputPaths: [], outputPaths: [join(directory, 'Straße.mp4'), join(directory, 'STRASSE.mp4')], refresh: true })).toBeUndefined();
    expect(await readdir(directory)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
