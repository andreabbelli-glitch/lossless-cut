import { describe, expect, it } from 'vitest';

import createHistory from './history';

describe('transactional undo history', () => {
  it('keeps an entire long drag as one undo step', () => {
    const history = createHistory({ start: 1, end: 2 }, 100);
    history.begin();
    for (let index = 0; index < 1000; index += 1) history.set({ start: index, end: index + 1 });
    expect(history.getSnapshot().history).toHaveLength(1);
    history.end();
    expect(history.getSnapshot().history).toHaveLength(2);
    history.back();
    expect(history.getSnapshot().current).toEqual({ start: 1, end: 2 });
    history.forward();
    expect(history.getSnapshot().current).toEqual({ start: 999, end: 1000 });
  });

  it('undoes immediately after overflow and drops redo on a new edit', () => {
    const history = createHistory(0, 100);
    for (let value = 1; value <= 150; value += 1) history.set(value);
    expect(history.getSnapshot().position).toBe(99);
    history.back();
    expect(history.getSnapshot().current).toBe(149);
    history.set(200);
    history.forward();
    expect(history.getSnapshot().current).toBe(200);
    history.go(0);
    expect(history.getSnapshot().current).toBe(51);
  });

  it('does not consume undo for an unchanged transaction and handles nested transactions', () => {
    const history = createHistory(0, 100);
    history.begin();
    history.end();
    expect(history.getSnapshot().history).toEqual([0]);
    history.begin();
    history.set(1);
    history.begin();
    history.set(2);
    history.end();
    history.end();
    expect(history.getSnapshot().history).toEqual([0, 2]);
  });

  it('resets the file session even during a pending drag', () => {
    const history = createHistory('A', 100);
    history.begin();
    history.set('A edited');
    history.reset('B');
    history.end();
    history.back();
    expect(history.getSnapshot().history).toEqual(['B']);
    expect(history.getSnapshot().current).toBe('B');
  });

  it('leaves history untouched when an atomic update fails', () => {
    const history = createHistory(['original'], 100);
    expect(() => history.set(() => { throw new Error('Detection failed'); })).toThrow('Detection failed');
    expect(history.getSnapshot().history).toEqual([['original']]);
  });
});
