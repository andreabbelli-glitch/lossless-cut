import { useMemo, useState, useSyncExternalStore } from 'react';

import createHistory from '../util/history';

export default function useTransactionalHistory<T>(initialValue: T, capacity: number) {
  const [store] = useState(() => createHistory(initialValue, capacity));
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const history = useMemo(() => ({ ...store, ...snapshot }), [snapshot, store]);
  return [snapshot.current, store.set, history] as const;
}
