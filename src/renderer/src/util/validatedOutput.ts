import mainApi from '../mainApi';
import { UserFacingError } from '../../errors';
import type { ExportVerificationResult, VerificationSource, VerifyExportParams } from '../../../main/exportVerification.js';

export type VerificationPhase = (id: string | undefined) => void;

export class ExportVerificationError extends UserFacingError {
  readonly verification: ExportVerificationResult;

  constructor(verification: ExportVerificationResult) {
    super(`Export verification: ${verification.issues.join('; ')}. Output and intermediate files have been preserved.`);
    this.name = 'ExportVerificationError';
    this.verification = verification;
  }
}

export async function validateOutput({ path, sources, merged, reencodedVideo, onVerification, verificationOptions, signal }: {
  path: string,
  sources: VerificationSource[],
  merged: boolean,
  reencodedVideo?: boolean | undefined,
  onVerification?: VerificationPhase | undefined,
  verificationOptions?: Pick<VerifyExportParams, 'timeScale' | 'preserveTrackMetadata' | 'expectedStreams' | 'reencodedAudioStreamIds'> | undefined,
  signal?: AbortSignal | undefined,
}, id: string = crypto.randomUUID()) {
  signal?.throwIfAborted();
  const abort = () => { mainApi.cancelExportVerification(id).catch(console.error); };
  signal?.addEventListener('abort', abort, { once: true });
  onVerification?.(id);
  try {
    const verification = await mainApi.verifyExport({ ...verificationOptions, id, path, sources, merged, ...(reencodedVideo != null ? { reencodedVideo } : {}) });
    if (verification.cancelled) throw new DOMException('Export verification cancelled', 'AbortError');
    signal?.throwIfAborted();
    if (verification.status !== 'passed') throw new ExportVerificationError(verification);
    return verification;
  } finally {
    signal?.removeEventListener('abort', abort);
    onVerification?.(undefined);
  }
}

export async function writeValidatedOutput<T>({ path, overwrite, sources, merged, reencodedVideo, write, onVerification, verificationOptions, signal }: {
  path: string,
  overwrite: boolean,
  sources: VerificationSource[],
  merged: boolean,
  reencodedVideo?: boolean | ((value: T) => boolean) | undefined,
  write: (candidate: string) => Promise<T>,
  onVerification?: VerificationPhase | undefined,
  verificationOptions?: Pick<VerifyExportParams, 'timeScale' | 'preserveTrackMetadata' | 'expectedStreams' | 'reencodedAudioStreamIds'> | undefined,
  signal?: AbortSignal | undefined,
}) {
  signal?.throwIfAborted();
  const inputPaths = sources.flatMap((source) => [source.path, ...source.origins?.map((origin) => origin.path) ?? []]);
  const conflict = await mainApi.checkOutputPathIdentity({ inputPaths, outputPaths: [path], refresh: true });
  if (conflict) throw new UserFacingError(`Output conflicts with a source file: ${conflict.path}`);
  const transaction = await mainApi.beginOutputTransaction(path, overwrite);
  if (transaction.status === 'skipped') return { status: 'skipped' as const, path };
  try {
    signal?.throwIfAborted();
    const value = await write(transaction.path);
    signal?.throwIfAborted();
    const verification = await validateOutput({ path: transaction.path, sources, merged, reencodedVideo: typeof reencodedVideo === 'function' ? reencodedVideo(value) : reencodedVideo, onVerification, verificationOptions, signal }, transaction.id);
    signal?.throwIfAborted();
    await mainApi.publishOutputTransaction(transaction.id);
    return { status: 'created' as const, path, value, verification };
  } finally {
    await mainApi.releaseOutputTransaction(transaction.id);
  }
}
