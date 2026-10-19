const operations = new Map<string, AbortController>();

export function createFfOperation(id: string) {
  if (operations.has(id)) throw new Error('FFmpeg operation already exists');
  operations.set(id, new AbortController());
}

export function abortFfOperation(id: string) {
  operations.get(id)?.abort();
}

export function finishFfOperation(id: string) {
  operations.delete(id);
}

export function getFfOperationSignal(id: string | undefined): AbortSignal | undefined {
  if (id == null) return undefined;
  const operation = operations.get(id);
  if (operation == null) throw new Error('FFmpeg operation does not exist');
  return operation.signal;
}

export function combineFfSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
  return AbortSignal.any(signals.filter((signal): signal is AbortSignal => signal != null));
}
