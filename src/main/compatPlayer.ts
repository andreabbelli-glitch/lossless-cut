import { ExecaError } from 'execa';

import logger from './logger.js';
import { createMediaSourceProcess } from './ffmpeg.js';
import { createChunkReader } from './readableChunks.js';


// eslint-disable-next-line import/prefer-default-export
export function createMediaSourceStream(params: Parameters<typeof createMediaSourceProcess>[0]) {
  const abortController = new AbortController();

  const abort = () => abortController.abort();

  async function attemptCreateProcess({ forceColorspace }: { forceColorspace?: boolean } = {}) {
    abortController.signal.throwIfAborted();
    const { videoStreamIndex, audioStreams, seekTo } = params;

    logger.info('Starting preview process', { videoStreamIndex, audioStreams, seekTo });
    const process = createMediaSourceProcess({ ...params, forceColorspace });

    const stop = () => {
      logger.info('Aborting preview process', { videoStreamIndex, audioStreams, seekTo });
      process.kill('SIGKILL');
    };
    abortController.signal.addEventListener('abort', stop, { once: true });
    process.then(() => abortController.signal.removeEventListener('abort', stop), () => abortController.signal.removeEventListener('abort', stop));

    const { stdout } = process;
    const nextChunk = createChunkReader(stdout, process, () => process.kill('SIGKILL'));

    logger.info('Waiting for first chunk');

    let timeout: NodeJS.Timeout | undefined;
    let firstChunk: Buffer | undefined;

    try {
      firstChunk = await Promise.race([
        nextChunk(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(new Error('Timeout waiting for media source process to start outputting data'));
          }, 10000);
        }),
      ]) ?? undefined;
      if (firstChunk == null) throw new Error('Media source process produced no data');
    } catch (err) {
      process.kill('SIGKILL');
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    logger.info('First chunk received');

    const readChunk = async () => {
      if (firstChunk) {
        logger.info('Client read first chunk');
        const chunk = firstChunk;
        firstChunk = undefined;
        return chunk;
      }
      return nextChunk();
    };

    return readChunk;
  }

  return {
    abort,
    promise: (async () => {
      try {
        return await attemptCreateProcess();
      } catch (err) {
        if (abortController.signal.aborted) {
          return undefined;
        }
        if (err instanceof ExecaError && /^\[swscaler[^\]]+\]\s+Unsupported input/gm.test((err as ExecaError<{ buffer: { stdout: false, stderr: true }, encoding: 'utf8' }>).stderr)) {
          logger.warn('Media source process failed due to unsupported colorspace, retrying with forced colorspace conversion');

          try {
            return await attemptCreateProcess({ forceColorspace: true });
          } catch (err2) {
            if (abortController.signal.aborted) {
              return undefined;
            }
            logger.warn('Media source process error', err2 instanceof Error ? err2.message : err2);
            return undefined;
          }
        }

        logger.warn('Media source process error', err instanceof Error ? err.message : err);
        return undefined;
      }
    })(),
  };
}
