import { describe, expect, it } from 'vitest';
import { commandExtent, layoutCommandLane, tAtF } from '../src/renderer/components/pathTimelineModel';

// 90 px per second from x = 100: a 10 s plot ending at 1000, its chips allowed from 90 to 1010.
const px = (t) => 100 + t * 90;
const opts = { x: px, left: 90, right: 1010 };
const item = (t, index, w = 110, extra = {}) => ({ t, index, key: 'm' + index, w, ...extra });
const named = (out) => out.chips.filter((chip) => !chip.stack);
const right = (chip) => chip.left + chip.w;
const overlaps = (a, b) => a.row === b.row && a.left < right(b) && b.left < right(a);

function expectNoOverlap(out) {
  for (const a of out.chips) {
    expect(a.left).toBeGreaterThanOrEqual(opts.left - 1e-9);
    expect(right(a)).toBeLessThanOrEqual(opts.right + 1e-9);
    for (const b of out.chips) if (a !== b) expect(overlaps(a, b)).toBe(false);
  }
}

describe('command lane layout', () => {
  it('keeps the diamond on the time: a chip faces right from the start of the lane', () => {
    const [chip] = layoutCommandLane([item(0, 0)], opts).chips;
    expect(chip).toMatchObject({ dir: 'right', row: 0, w: 110, x: px(0) });
    expect(chip.left).toBe(px(0) - 9);
  });

  it('turns a chip at the very end to face left instead of clipping it', () => {
    const out = layoutCommandLane([item(0, 0), item(10, 1, 140)], opts);
    const end = out.chips.find((chip) => chip.index === 1);
    expect(end).toMatchObject({ dir: 'left', w: 140, row: 0 });
    expect(right(end)).toBe(px(10) + 9);
    expectNoOverlap(out);
  });

  it('turns any chip whose name would pass the right edge, not only the last one', () => {
    const [chip] = layoutCommandLane([item(9.5, 0, 160)], opts).chips;
    expect(chip.dir).toBe('left');
    expect(chip.w).toBe(160);
  });

  it('shortens a name only when even the side with more room is too narrow', () => {
    const [chip] = layoutCommandLane([item(5, 0, 2000)], { ...opts, right: 600, left: 400 }).chips;
    expect(chip.w).toBeLessThan(2000);
    expect(chip.left).toBeGreaterThanOrEqual(400);
    expect(right(chip)).toBeLessThanOrEqual(600);
  });

  it('stacks coincident commands into rows with full names before shortening any', () => {
    const out = layoutCommandLane([item(2, 0), item(2, 1), item(2, 2)], opts);
    expect(out.rows).toBe(3);
    expect(named(out).map((chip) => [chip.row, chip.w])).toEqual([[0, 110], [1, 110], [2, 110]]);
    expectNoOverlap(out);
  });

  it('collapses what has no room into one +N chip in the last row', () => {
    const out = layoutCommandLane([0, 1, 2, 3, 4, 5, 6].map((i) => item(2 + i * 0.01, i)), opts);
    expect(named(out).map((chip) => chip.index)).toEqual([0, 1]);
    const stacks = out.chips.filter((chip) => chip.stack);
    expect(stacks).toHaveLength(1);
    expect(stacks[0].row).toBe(2);
    expect(stacks[0].members.map((member) => member.index)).toEqual([2, 3, 4, 5, 6]);
    expect(stacks[0].x).toBe(px(2.02));
    expectNoOverlap(out);
  });

  it('honors fewer rows', () => {
    const out = layoutCommandLane([0, 1, 2, 3].map((i) => item(2, i)), { ...opts, rows: 2 });
    expect(out.rows).toBe(2);
    expect(named(out)).toHaveLength(1);
    expect(out.chips.find((chip) => chip.stack).members).toHaveLength(3);
  });

  it('shortens neighbours (never below their minimum) before giving up on an evenly crowded stretch', () => {
    const items = Array.from({ length: 9 }, (_, i) => item(1 + i * 0.25, i, 120));
    const out = layoutCommandLane(items, opts);
    expectNoOverlap(out);
    for (const chip of named(out)) expect(chip.w).toBeGreaterThanOrEqual(46);
    expect(named(out).length + out.chips.filter((c) => c.stack).reduce((n, c) => n + c.members.length, 0)).toBe(9);
    expect(named(out).length).toBe(9);
  });

  it('gives shortened names their room back once nothing follows them', () => {
    // Index 1 shortens index 0 while it is placed, then becomes part of the stack.
    const items = [item(1, 0, 200), item(1.5, 1, 200), item(1.5, 2, 200), item(1.5, 3, 200), item(1.5, 4, 200)];
    const out = layoutCommandLane(items, opts);
    expectNoOverlap(out);
    for (const chip of named(out)) {
      const blocked = out.chips.some((other) => other !== chip && other.row === chip.row && other.left >= chip.left && other.left - 3 < chip.left + 200);
      if (!blocked) expect(chip.w).toBe(200);
    }
  });

  it('keeps a long name within the lane and passes its own minimum through', () => {
    const out = layoutCommandLane([item(4, 0, 168, { minW: 76 }), item(4.3, 1, 168, { minW: 76 })], { ...opts, rows: 1 });
    expectNoOverlap(out);
    for (const chip of named(out)) expect(chip.w).toBeGreaterThanOrEqual(76);
  });

  it('reserves an extent bar in its row so other chips do not sit on it', () => {
    const out = layoutCommandLane([item(1, 0, 80, { endT: 8 }), item(4, 1, 80)], opts);
    const [loop, other] = [0, 1].map((i) => out.chips.find((chip) => chip.index === i));
    expect(loop.endX).toBe(px(8));
    expect(other.row).not.toBe(loop.row);
  });

  it('a chip facing left at the end can still draw its extent to the right of its diamond', () => {
    const [chip] = layoutCommandLane([item(9.8, 0, 120, { endT: 10 })], opts).chips;
    expect(chip.dir).toBe('left');
    expect(chip.endX).toBe(px(10));
  });

  it('keeps every command reachable whatever the crowding', () => {
    const items = Array.from({ length: 60 }, (_, i) => item((i * 7919 % 1000) / 100, i, 60 + (i * 37) % 120)).sort((a, b) => a.t - b.t);
    const out = layoutCommandLane(items, opts);
    expectNoOverlap(out);
    const seen = out.chips.flatMap((chip) => chip.stack ? chip.members.map((m) => m.index) : [chip.index]).sort((a, b) => a - b);
    expect(seen).toEqual(items.map((i) => i.index).sort((a, b) => a - b));
  });
});

describe('command extents', () => {
  // A straight 10 m path at 2 m/s, then a 1 s wait at the end.
  const tl = { empty: false, total: 6, points: [{ t: 0, f: 0 }, { t: 5, f: 1 }, { t: 6, f: 1 }] };
  const derived = { sample: { length: 10 } };
  const loop = (until) => ({ invocation: { commandId: 'a', arguments: {}, loop: { until } } });

  it('runs to a time limit, open past the end of the path', () => {
    expect(commandExtent(loop({ kind: 'time', seconds: 2 }), 1, tl, derived)).toEqual({ kind: 'loop', t: 3, open: false });
    expect(commandExtent(loop({ kind: 'time', seconds: 9 }), 1, tl, derived)).toEqual({ kind: 'loop', t: 6, open: true });
  });

  it('converts a distance limit to time through the path timing', () => {
    const extent = commandExtent(loop({ kind: 'distance', meters: 4 }), 1, tl, derived);
    expect(extent.t).toBeCloseTo(tAtF(tl, 0.6), 9);
    expect(extent.t).toBeCloseTo(3, 9);
    expect(commandExtent(loop({ kind: 'distance', meters: 9 }), 1, tl, derived)).toEqual({ kind: 'loop', t: 6, open: true });
  });

  it('measures distance by travel, including stationary travel where the path fraction does not move', () => {
    // A 0.5 m jiggle at the start (f stays 0), then 2 m along the path.
    const jiggle = { empty: false, total: 3, points: [{ t: 0, f: 0, s: 0 }, { t: 1, f: 0, s: 0.5 }, { t: 3, f: 1, s: 2.5 }] };
    expect(commandExtent(loop({ kind: 'distance', meters: 0.5 }), 0, jiggle, { sample: { length: 2 } }).t).toBeCloseTo(1, 9);
    expect(commandExtent(loop({ kind: 'distance', meters: 1.5 }), 0.5, jiggle, { sample: { length: 2 } }).t).toBeCloseTo(2.25, 9);
    expect(commandExtent(loop({ kind: 'distance', meters: 5 }), 0, jiggle, { sample: { length: 2 } })).toEqual({ kind: 'loop', t: 3, open: true });
  });

  it('runs to the end of the path', () => {
    expect(commandExtent(loop({ kind: 'pathEnd' }), 1, tl, derived)).toEqual({ kind: 'loop', t: 6, open: false });
  });

  it('shows nothing for a single run, a routine-only output loop, or an untimed path', () => {
    expect(commandExtent({ invocation: { commandId: 'a', arguments: {} } }, 1, tl, derived)).toBeNull();
    expect(commandExtent(loop({ kind: 'output', output: 'ready', operator: 'eq', value: true }), 1, tl, derived)).toBeNull();
    expect(commandExtent(loop({ kind: 'pathEnd' }), 1, { ...tl, empty: true }, derived)).toBeNull();
  });

  it('uses the longest known limit in a group', () => {
    const commands = [{ commandId: 'a', arguments: {}, loop: { until: { kind: 'time', seconds: 1 } } },
      { commandId: 'b', arguments: {}, loop: { until: { kind: 'time', seconds: 3 } } }];
    expect(commandExtent({ commandGroup: { mode: 'parallel', commands } }, 1, tl, derived)).toMatchObject({ t: 4 });
    // In a sequence only the first command starts at the event's time.
    expect(commandExtent({ commandGroup: { mode: 'sequential', commands } }, 1, tl, derived)).toMatchObject({ t: 2 });
    const toEnd = [{ commandId: 'a', arguments: {} }, { commandId: 'b', arguments: {}, loop: { until: { kind: 'pathEnd' } } }];
    expect(commandExtent({ commandGroup: { mode: 'sequential', commands: toEnd } }, 1, tl, derived)).toMatchObject({ t: 6 });
  });

  it('shows a fixed-interval repeat until its end time or the path end', () => {
    expect(commandExtent({ schedule: { repeatEveryS: 0.5, endTimeS: 4 } }, 1, tl, derived)).toEqual({ kind: 'repeat', t: 4, open: false, every: 0.5 });
    expect(commandExtent({ schedule: { repeatEveryS: 0.5 } }, 1, tl, derived)).toMatchObject({ t: 6 });
  });
});
