import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { abortFfmpegs } from '../ffmpeg';


export interface WorkingState {
  text: string,
  abortController?: AbortController | undefined,
  owner?: string | undefined,
  nonBlocking?: boolean | undefined,
  onAbort?: (() => void) | undefined,
  verificationId?: string | undefined,
}

export default function useLoading() {
  const { t } = useTranslation();

  const [working, setWorkingState] = useState<WorkingState | undefined>();

  // Store "working" in a ref so we can avoid race conditions
  const workingRef = useRef(!!working);
  const workingStateRef = useRef<WorkingState | undefined>(undefined);

  const setWorking = useCallback((valOrBool?: WorkingState | true | undefined) => {
    const val = valOrBool === true ? { text: t('Loading') } : valOrBool;
    workingStateRef.current = val;
    workingRef.current = !!val && !val.nonBlocking;
    setWorkingState(val);
  }, [t]);

  const abortWorking = useCallback(() => {
    console.log('User clicked abort');
    if (working?.nonBlocking) {
      working.onAbort?.();
      working.abortController?.abort();
      return;
    }
    abortFfmpegs(); // todo use abortcontroller for this also
    working?.abortController?.abort();
  }, [working]);

  return {
    working,
    workingRef,
    workingStateRef,
    setWorking,
    abortWorking,
  };
}

export type SetWorking = ReturnType<typeof useLoading>['setWorking'];
