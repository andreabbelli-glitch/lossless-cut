export default function createSettingsPersistence<K, V>(write: (key: K, value: V) => unknown) {
  const active = new Set<K>();
  const pending = new Map<K, V>();
  const written = new Map<K, V>();
  const save = (key: K, value: V) => {
    if (written.has(key) && Object.is(written.get(key), value)) return true;
    if (write(key, value) === false) return false;
    written.set(key, value);
    return true;
  };
  return {
    begin: (key: K) => { active.add(key); },
    end: (key: K) => { active.delete(key); },
    update: (key: K, value: V) => {
      if (active.has(key)) pending.set(key, value);
      else if (save(key, value)) pending.delete(key);
      else pending.set(key, value);
    },
    flush: (all = false) => {
      for (const [key, value] of pending) {
        if ((all || !active.has(key)) && save(key, value)) pending.delete(key);
      }
    },
  };
}
