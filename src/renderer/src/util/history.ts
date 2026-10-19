export default function createHistory<T>(initialValue: T, capacity: number) {
  if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('Invalid history capacity');
  let history = [initialValue];
  let position = 0;
  let current = initialValue;
  let transactionDepth = 0;
  const listeners = new Set<() => void>();
  let snapshot = { history, position, current, capacity };

  const publish = () => {
    snapshot = { history, position, current, capacity };
    listeners.forEach((listener) => listener());
  };
  const commit = (value: T) => {
    current = value;
    if (Object.is(history[position], value)) return;
    history = [...history.slice(0, position + 1), value].slice(-capacity);
    position = history.length - 1;
  };
  const finishTransaction = () => {
    transactionDepth = 0;
    commit(current);
  };
  const go = (nextPosition: number) => {
    finishTransaction();
    position = Math.min(Math.max(0, nextPosition), history.length - 1);
    current = history[position]!;
    publish();
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    set: (valueOrUpdater: T | ((previous: T) => T)) => {
      const value = typeof valueOrUpdater === 'function' ? (valueOrUpdater as (previous: T) => T)(current) : valueOrUpdater;
      if (Object.is(current, value)) return;
      if (transactionDepth > 0) current = value;
      else commit(value);
      publish();
    },
    begin: () => { transactionDepth += 1; },
    end: () => {
      if (transactionDepth === 0) return;
      transactionDepth -= 1;
      if (transactionDepth > 0) return;
      commit(current);
      publish();
    },
    back: () => {
      finishTransaction();
      go(position - 1);
    },
    forward: () => {
      finishTransaction();
      go(position + 1);
    },
    go,
    reset: (value: T) => {
      history = [value];
      position = 0;
      current = value;
      transactionDepth = 0;
      publish();
    },
  };
}
