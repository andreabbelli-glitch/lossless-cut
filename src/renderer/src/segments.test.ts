import { test, it, expect, describe } from 'vitest';

import { convertSegmentsToChaptersWithGaps, partitionIntoOverlappingRanges, formatSegNum, combineOverlappingSegments, invertSegments, hasAnySegmentOverlap, makeDurationSegments, getSelectedSegmentsForExport, createSegment, addSegmentColorIndex } from './segments';

describe('safe duration splitting', () => {
  it('does not manufacture a floating-point tail and retains real short tails', () => {
    expect(makeDurationSegments(3.3, 9.9)).toEqual([
      { start: 0, end: 3.3 },
      { start: 3.3, end: 6.6 },
      { start: 6.6, end: 9.9 },
    ]);
    const actualTail = makeDurationSegments(3.3, 9.900000001);
    expect(actualTail).toHaveLength(4);
    expect(actualTail.at(-1)!.end - actualTail.at(-1)!.start).toBeGreaterThan(0);
  });

  it('rejects invalid or excessive counts before allocation', () => {
    for (const duration of [0, -1, NaN, Infinity, Number.MIN_VALUE]) expect(() => makeDurationSegments(duration, 100)).toThrow(RangeError);
    for (const total of [0, -1, NaN, Infinity]) expect(() => makeDurationSegments(1, total)).toThrow(RangeError);
    expect(makeDurationSegments(1, 2000)).toHaveLength(2000);
    expect(() => makeDurationSegments(1, 2001)).toThrow(RangeError);
    expect(makeDurationSegments(Number.MAX_VALUE, Number.MIN_VALUE)).toEqual([{ start: 0, end: Number.MIN_VALUE }]);
  });
});

it('inverts the union of nested, overlapping and adjacent exclusions', () => {
  expect(invertSegments([
    { start: 10, end: 20 }, { start: 15, end: 30 }, { start: 17, end: 19 }, { start: 30, end: 40 }, { start: 60, end: 70 },
  ], true, true, 100)).toEqual([{ start: 0, end: 10 }, { start: 40, end: 60 }, { start: 70, end: 100 }]);
  expect(invertSegments([{ start: 0, end: 100 }], true, true, 100)).toEqual([]);
});

it('checks overlap without building groups and preserves adjacent-boundary semantics', () => {
  expect(hasAnySegmentOverlap([])).toBe(false);
  expect(hasAnySegmentOverlap([{ start: 0, end: 1 }, { start: 1, end: 2 }])).toBe(false);
  expect(hasAnySegmentOverlap([{ start: 0, end: 10 }, { start: 1, end: 2 }, { start: 3, end: 4 }])).toBe(true);
});

it('keeps original segment numbers in selected and fallback exports with markers', () => {
  const marker = addSegmentColorIndex(createSegment({ start: 0, selected: false }), 0);
  const segment = addSegmentColorIndex(createSegment({ start: 1, end: 2, selected: false }), 1);
  expect(getSelectedSegmentsForExport([marker, segment])[0]!.originalIndex).toBe(1);
  expect(getSelectedSegmentsForExport([marker, { ...segment, selected: true }])[0]!.originalIndex).toBe(1);
});

it('converts segments to chapters with gaps', () => {
  expect(convertSegmentsToChaptersWithGaps([
    {
      start: 104.612,
      end: 189.053,
      name: 'label 1',
    },
    {
      start: 300.448,
      end: 476.194,
      name: 'label 2',
    },
    {
      start: 567.075,
      end: 704.264,
      name: 'label 3',
    },
    {
      start: 704.264,
      end: 855.455,
      name: 'label 4',
    },
  ])).toMatchSnapshot();
});

it('converts segments to chapters with no gaps when adjacent', () => {
  expect(convertSegmentsToChaptersWithGaps([
    {
      start: 0,
      end: 2,
      name: 'label 1',
    },
    {
      start: 2,
      end: 3,
      name: 'label 2',
    },
  ])).toMatchSnapshot();
});

it('converts segments to chapters with single long segment', () => {
  expect(convertSegmentsToChaptersWithGaps([
    {
      start: 0,
      end: 1,
      name: 'label 1',
    },
  ])).toMatchSnapshot();
});

it('detects overlapping segments', () => {
  expect(partitionIntoOverlappingRanges([
    { start: 0, end: 1 },
  ])).toEqual([]);

  expect(partitionIntoOverlappingRanges([
    { start: 0, end: 1 },
    { start: 1, end: 2 },
  ])).toEqual([]);

  expect(partitionIntoOverlappingRanges([
    { start: 0, end: 1 },
    { start: 0.5, end: 2 },
    { start: 2, end: 3 },
  ])).toEqual([
    [
      { start: 0, end: 1 },
      { start: 0.5, end: 2 },
    ],
  ]);

  expect(partitionIntoOverlappingRanges([
    { start: 0, end: 2 },
    { start: 0.5, end: 1 },
  ])).toEqual([
    [
      { start: 0, end: 2 },
      { start: 0.5, end: 1 },
    ],
  ]);

  expect(partitionIntoOverlappingRanges([
    { start: 9, end: 10.5 },
    { start: 11, end: 12 },
    { start: 11.5, end: 12.5 },
    { start: 11.5, end: 13 },
    { start: 15, end: 17 },
    { start: 17, end: 20 },
    { start: 17.5, end: 18.5 },
    { start: 18, end: 19.5 },
    { start: 19, end: 19.5 },
    { start: 19.5, end: 22 },
    { start: 22, end: 25 },
  ])).toEqual([
    [{ start: 11, end: 12 }, { start: 11.5, end: 13 }, { start: 11.5, end: 12.5 }],
    [{ start: 17, end: 20 }, { start: 17.5, end: 18.5 }, { start: 18, end: 19.5 }, { start: 19, end: 19.5 }, { start: 19.5, end: 22 }],
  ]);
});

it('detects overlapping segments, undefined end', () => {
  expect(partitionIntoOverlappingRanges([
    { start: 1, end: undefined },
    { start: 1.5, end: undefined },
  ])).toEqual([]);
});

test('formatSegNum', () => {
  expect(formatSegNum(0, 9)).toBe('1');
  expect(formatSegNum(0, 10)).toBe('01');

  expect(formatSegNum(0, 10, 2)).toBe('01');
  expect(formatSegNum(0, 10, 3)).toBe('001');
});

describe('invertSegments', () => {
  test('normal', () => {
    expect(invertSegments([
      { start: 1, name: 'Marker 1' },
      { start: 2, end: 3, name: 'Segment 2' },
      { start: 5, name: 'Segment 3' },
    ], true, true, 100)).toMatchSnapshot();
  });

  test('none', () => {
    expect(invertSegments([], true, true, 100)).toMatchSnapshot();
  });

  test('adjacent', () => {
    expect(invertSegments([
      { start: 2, end: 3, name: 'Segment 1' },
      { start: 3, end: 4, name: 'Segment 2' },
    ], true, true, 100)).toMatchSnapshot();
  });

  test('overlap 1', () => {
    expect(invertSegments([
      { start: 2, end: 3.5 },
      { start: 3, end: 4 },
    ], true, true, 100)).toEqual([{ start: 0, end: 2 }, { start: 4, end: 100 }]);
  });

  test('overlap 2', () => {
    expect(invertSegments([
      { start: 2, end: 5 },
      { start: 3, end: 4 },
    ], true, true, 100)).toEqual([{ start: 0, end: 2 }, { start: 5, end: 100 }]);
  });

  test('undefined duration', () => {
    expect(invertSegments([
      { start: 3, name: 'Marker 1' },
    ], true, true)).toMatchSnapshot();
  });

  test('undefined duration 2', () => {
    expect(invertSegments([
      { start: 3 },
    ], false, false)).toMatchSnapshot();
  });
});

describe('combineOverlappingSegments', () => {
  test('non touching', () => {
    expect(combineOverlappingSegments([
      { start: 1, end: 2 },
      { start: 3, end: 4 },
    ])).toMatchSnapshot();
  });
  test('overlapping and non overlapping', () => {
    expect(combineOverlappingSegments([
      { start: 1, end: 2 },
      { start: 1.5, end: 3 },
      { start: 4, end: 5 },
    ])).toMatchSnapshot();
  });
  test('adjacent', () => {
    expect(combineOverlappingSegments([
      { start: 1, end: 2 },
      { start: 2, end: 3 },
      { start: 3, end: 4 },
    ])).toMatchSnapshot();
  });

  test('various', () => {
    const segments = [
      {
        start: 0,
      },
      {
        start: 838,
        end: 1101,
      },
      {
        start: 1101,
        end: 1244,
      },
      {
        start: 1216,
        end: 1487,
      },
      {
        start: 1487,
      },
      {
        start: 1625,
      },
      {
        start: 503,
        end: 669,
      },
      {
        start: 392,
        end: 716,
      },
      {
        start: 229,
        end: 784,
      },
      {
        start: 0,
        end: 87,
      },
      {
        start: 1561,
        end: 1831,
      },
      {
        start: 2027,
      },
    ];

    expect(combineOverlappingSegments(segments)).toMatchSnapshot();
  });
});
