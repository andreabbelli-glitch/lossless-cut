import type { Readable } from 'node:stream';

// Async iterators retain EOF/error state, including when the stream terminates
// between two client reads. Observe the process as well: closed stdout alone
// must not turn a failed child into a successful end of stream.
// eslint-disable-next-line import/prefer-default-export
export function createChunkReader(stdout: Readable, process: PromiseLike<unknown>, stop?: () => void) {
  const completion = Promise.resolve(process).then(() => undefined, (error: unknown) => ({ error }));
  const chunks = stdout[Symbol.asyncIterator]();
  return async (): Promise<Buffer | null> => {
    let next: IteratorResult<Buffer>;
    try {
      next = await chunks.next();
    } catch (err) {
      // A failed reader is already terminal. Waiting for a producer which is
      // still alive can deadlock; stop it and surface the stream error now.
      stop?.();
      throw err;
    }
    if (!next.done) return next.value;
    const outcome = await completion;
    if (outcome != null) throw outcome.error;
    return null;
  };
}
