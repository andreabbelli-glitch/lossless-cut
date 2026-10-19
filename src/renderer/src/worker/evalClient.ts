export interface RequestMessageData {
  code: string,
  id: number,
  context: string,
}

export type ResponseMessageData = { id: number } & ({ error: string } | { data: unknown });

type EvalWorker = Pick<Worker, 'postMessage' | 'terminate' | 'addEventListener' | 'removeEventListener'>;
interface Request { message: RequestMessageData, resolve: (value: unknown) => void, reject: (error: Error) => void }

// A deadline starts when dispatched, rather than while waiting behind another expression.
export function createEvalClient(createWorker: () => EvalWorker, timeoutMs = 2000) {
  let worker: EvalWorker | undefined;
  let active: Request | undefined;
  let lastRequestId = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const queue: Request[] = [];

  function reset(error: Error) {
    clearTimeout(timer);
    worker?.removeEventListener('message', onMessage);
    worker?.removeEventListener('error', onError);
    worker?.removeEventListener('messageerror', onMessageError);
    worker?.terminate();
    worker = undefined;
    active?.reject(error);
    active = undefined;
    // Reject this worker generation; never silently replay its queued expressions.
    queue.splice(0).forEach((request) => request.reject(error));
  }

  function dispatch() {
    if (active != null || queue.length === 0) return;
    active = queue.shift()!;
    try {
      if (worker == null) {
        worker = createWorker();
        worker.addEventListener('message', onMessage);
        worker.addEventListener('error', onError);
        worker.addEventListener('messageerror', onMessageError);
      }
      timer = setTimeout(() => reset(new Error('Expression timed out after 2 seconds')), timeoutMs);
      worker.postMessage(active.message);
    } catch (error) {
      reset(error instanceof Error ? error : new Error(String(error)));
    }
  }

  function onMessage(event: MessageEvent<ResponseMessageData>) {
    if (active == null || event.data.id !== active.message.id) return;
    clearTimeout(timer);
    const request = active;
    active = undefined;
    if ('error' in event.data) request.reject(new Error(event.data.error));
    else request.resolve(event.data.data);
    dispatch();
  }

  function onError(event: ErrorEvent) {
    reset(new Error(`Expression worker failed: ${event.message}`));
  }

  function onMessageError() {
    reset(new Error('Unable to read the expression worker response'));
  }

  return (code: string, context: Record<string, unknown>) => new Promise<unknown>((resolve, reject) => {
    // Serialize before enqueueing so failures leave no orphaned request or listener.
    const serializedContext = JSON.stringify(context);
    lastRequestId += 1;
    queue.push({ message: { id: lastRequestId, code, context: serializedContext }, resolve, reject });
    dispatch();
  });
}
/* eslint no-use-before-define: ["error", { "functions": false }] */
