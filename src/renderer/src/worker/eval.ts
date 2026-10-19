// https://github.com/vitejs/vite/issues/11823#issuecomment-1407277242
import Worker from './evalWorker?worker';
import { createEvalClient } from './evalClient';

export type { RequestMessageData, ResponseMessageData } from './evalClient';

export default createEvalClient(() => new Worker());
