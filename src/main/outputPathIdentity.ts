import { randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { mkdir, mkdtemp, open, realpath, rm, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';

interface DirectorySemantics { caseSensitive: boolean, normalizationSensitive: boolean }
export interface OutputPathConflict { kind: 'input' | 'duplicate', path: string, otherPath: string }
export interface CheckOutputPathIdentityParams { inputPaths: string[], outputPaths: string[], refresh?: boolean }

const directoryCache = new Map<string, Promise<DirectorySemantics>>();

async function maybeStat(path: string) {
  try { return await stat(path, { bigint: true }); } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

const sameFile = (a: BigIntStats, b: BigIntStats) => a.ino !== 0n && a.ino === b.ino && a.dev === b.dev;

async function probeDirectory(directory: string): Promise<DirectorySemantics> {
  // Use a unique, exclusively created empty probe; never touch a user file or infer a volume-wide policy.
  const name = `.losslesscut-case-é-${randomUUID()}.tmp`;
  const path = join(directory, name);
  const handle = await open(path, 'wx');
  try {
    const identity = await handle.stat({ bigint: true });
    const caseAlias = await maybeStat(join(directory, name.toUpperCase()));
    const normalizationAlias = await maybeStat(join(directory, name.normalize('NFD')));
    return {
      caseSensitive: caseAlias == null || !sameFile(identity, caseAlias),
      normalizationSensitive: normalizationAlias == null || !sameFile(identity, normalizationAlias),
    };
  } finally {
    try { await handle.close(); } finally { await unlink(path); }
  }
}

// Exported separately to exercise semantics without assuming the test host's filesystem.
export function getFuturePathKey(directoryIdentity: string, names: string[], semantics: DirectorySemantics) {
  const canonicalize = (name: string) => {
    const normalized = semantics.normalizationSensitive ? name : name.normalize('NFC');
    // This is only a candidate bucket. Unicode folds can expand (ß -> SS), so
    // collisions involving non-ASCII names are confirmed on the actual filesystem.
    return semantics.caseSensitive ? normalized : normalized.toLowerCase().toUpperCase();
  };
  return `${directoryIdentity}:${names.map((name) => canonicalize(name)).join(sep)}`;
}

async function namesAlias(directory: string, first: string[], second: string[], semantics: DirectorySemantics) {
  if (first.every((name) => /^[\x00-\x7F]*$/.test(name)) && second.every((name) => /^[\x00-\x7F]*$/.test(name))) return true;
  const scratch = await mkdtemp(join(directory, '.losslesscut-identity-'));
  try {
    // Per-directory case flags need not be inherited on every filesystem.
    const inherited = await probeDirectory(scratch);
    if (inherited.caseSensitive !== semantics.caseSensitive || inherited.normalizationSensitive !== semantics.normalizationSensitive) {
      throw new Error('Unable to verify Unicode filename identity in this directory');
    }
    const firstPath = join(scratch, ...first);
    const secondPath = join(scratch, ...second);
    await mkdir(dirname(firstPath), { recursive: true });
    await mkdir(dirname(secondPath), { recursive: true });
    await (await open(firstPath, 'wx')).close();
    try {
      await (await open(secondPath, 'wx')).close();
      return false;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      const a = await stat(firstPath, { bigint: true });
      const b = await stat(secondPath, { bigint: true });
      return sameFile(a, b);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function checkOutputPathIdentity({ inputPaths, outputPaths, refresh = false }: CheckOutputPathIdentityParams): Promise<OutputPathConflict | undefined> {
  const refreshed = new Set<string>();
  const inputs = await Promise.all(inputPaths.map(async (path) => ({ path, identity: await maybeStat(path), canonical: await realpath(path) })));
  const outputs: { path: string, identity: Awaited<ReturnType<typeof maybeStat>>, key: string, names?: string[] }[] = [];
  try {
    for (const path of outputPaths) {
      const absolute = resolve(path);
      const identity = await maybeStat(absolute);
      if (identity != null) {
        const key = await realpath(absolute);
        const input = inputs.find((candidate) => (candidate.identity != null && sameFile(identity, candidate.identity)) || key === candidate.canonical);
        if (input != null) return { kind: 'input', path, otherPath: input.path };
        const previous = outputs.find((candidate) => candidate.key === key || (candidate.identity != null && sameFile(identity, candidate.identity)));
        if (previous != null) return { kind: 'duplicate', path, otherPath: previous.path };
        outputs.push({ path, identity, key });
        // An existing path has a real filesystem identity; no directory probe is needed.
        // eslint-disable-next-line no-continue
        continue;
      }
      let directory = dirname(absolute);
      const names = [basename(absolute)];
      let parentIdentity = await maybeStat(directory);
      while (parentIdentity == null) {
        names.unshift(basename(directory));
        const parent = dirname(directory);
        if (parent === directory) throw new Error('Cannot resolve the output directory');
        directory = parent;
        parentIdentity = await maybeStat(directory);
      }
      const canonicalDirectory = await realpath(directory);
      const directoryIdentity = `${parentIdentity.dev}:${parentIdentity.ino}:${canonicalDirectory}`;
      if (refresh && !refreshed.has(directoryIdentity)) {
        directoryCache.delete(directoryIdentity);
        refreshed.add(directoryIdentity);
      }
      let semantics = directoryCache.get(directoryIdentity);
      if (semantics == null) {
        semantics = probeDirectory(canonicalDirectory);
        directoryCache.set(directoryIdentity, semantics);
      }
      const resolvedSemantics = await semantics;
      const key = getFuturePathKey(directoryIdentity, names, resolvedSemantics);
      for (const previous of outputs.filter((candidate) => candidate.key === key)) {
        if (previous.names != null && await namesAlias(canonicalDirectory, previous.names, names, resolvedSemantics)) return { kind: 'duplicate', path, otherPath: previous.path };
      }
      outputs.push({ path, identity, key, names });
    }
    return undefined;
  } catch (error) {
    // A failed probe must not become a permanent cached assumption.
    directoryCache.clear();
    throw error;
  }
}
