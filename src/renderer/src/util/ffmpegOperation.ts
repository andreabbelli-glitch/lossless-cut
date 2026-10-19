interface OperationApi {
  createFfOperation: (id: string) => void,
  abortFfOperation: (id: string) => void,
  finishFfOperation: (id: string) => void,
}

// Pass only an operation ID over Electron remote. AbortSignal's prototype and
// event delivery are not preserved by that bridge.
// eslint-disable-next-line import/prefer-default-export
export async function withFfOperation<T>(signal: AbortSignal | undefined, api: OperationApi, run: (id: string | undefined) => Promise<T>): Promise<T> {
  if (signal == null) return run(undefined);
  signal.throwIfAborted();
  const id = crypto.randomUUID();
  api.createFfOperation(id);
  const abort = () => api.abortFfOperation(id);
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    const result = await run(id);
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener('abort', abort);
    api.finishFfOperation(id);
  }
}
