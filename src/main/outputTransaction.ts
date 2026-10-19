import { randomUUID } from 'node:crypto';
import { access, rename } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { checkOutputPathIdentity } from './outputPathIdentity.js';

const active = new Map<string, { target: string, candidate: string, backup: string }>();

async function exists(path: string) {
  try { await access(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Only an existing destination needs staging. A new output stays on its chosen path. */
async function beginOutput(target: string, overwrite: boolean) {
  const absolute = resolve(target);
  const conflict = await checkOutputPathIdentity({ inputPaths: [], outputPaths: [absolute, ...[...active.values()].map((entry) => entry.target)] });
  if (conflict) throw new Error('This output is still being written or verified');
  const present = await exists(absolute);
  if (present && !overwrite) return { status: 'skipped' as const, path: absolute };
  const id = randomUUID();
  // Keep staging names independent of the user's basename, which may already
  // consume the filesystem's entire filename-component budget.
  const prefix = join(dirname(absolute), `.losslesscut-${id}`);
  const candidate = present ? `${prefix}.pending${extname(absolute)}` : absolute;
  active.set(id, { target: absolute, candidate, backup: `${prefix}.previous${extname(absolute)}` });
  return { status: 'created' as const, id, path: candidate };
}

let beginQueue = Promise.resolve();
export function beginOutputTransaction(target: string, overwrite: boolean) {
  const result = beginQueue.then(() => beginOutput(target, overwrite));
  beginQueue = result.then(() => undefined, () => undefined);
  return result;
}

/** Called only after validation. Failed replacement leaves the old file recoverable. */
export async function publishOutputTransaction(id: string) {
  const entry = active.get(id);
  if (!entry) throw new Error('Unknown output transaction');
  if (entry.candidate === entry.target) { active.delete(id); return {}; }
  await rename(entry.target, entry.backup);
  try {
    await rename(entry.candidate, entry.target);
  } catch (error) {
    try { await rename(entry.backup, entry.target); } catch {
      throw new Error(`Unable to replace output. Previous file is preserved at ${entry.backup}`, { cause: error });
    }
    throw error;
  } finally {
    active.delete(id);
  }
  // eslint-disable-next-line no-console
  console.info('Previous output preserved at', entry.backup);
  return { backupPath: entry.backup };
}

/** Keep a failed candidate for inspection and preserve any previous export. */
export function releaseOutputTransaction(id: string) {
  active.delete(id);
}
