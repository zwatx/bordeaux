import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error Intentional renderer JS API.
import { createFieldGestureOwner, fieldRangeEndpoint } from '../src/renderer/components/FieldView';
import { PathEdit } from '../src/renderer/assets/path-edit';
import { effectiveRanges } from '../src/shared/math/pathRanges';
import { buildWaypoints } from '../src/shared/project/defaults';
import { sample } from '../src/shared/math/geometry';
import type { ConstraintRange } from '../src/shared/types';

describe('field gesture draft ownership', () => {
  it('allows its own synchronous updates and yields one finished edit', () => {
    const store = PathEdit.create<{ id: string; x: number }>(), retired = vi.fn();
    const owner = createFieldGestureOwner(store, 'path', retired);
    owner.write(() => store.begin({ id: 'path', x: 0 }), true);
    for (const x of [1, 2, 3]) expect(owner.write(() => store.update({ id: 'path', x }))).toBe(true);
    expect(owner.current()).toBe(true); expect(retired).not.toHaveBeenCalled();
    owner.dispose(); expect(store.finish()).toEqual({ id: 'path', x: 3 });
    expect(store.finish()).toBeNull(); expect(retired).not.toHaveBeenCalled();
  });
  it.each(['finish', 'cancel', 'replacement'])('retires after external %s before any more writes', resolution => {
    const store = PathEdit.create<{ id: string; x: number }>(), after = vi.fn();
    let owner: any;
    const retired = vi.fn(() => { if (owner.current()) store.finish(); });
    owner = createFieldGestureOwner(store, 'path', retired);
    owner.write(() => store.begin({ id: 'path', x: 0 }), true);
    owner.write(() => store.update({ id: 'path', x: 2 }));
    if (resolution === 'replacement') store.update({ id: 'other-owner', x: 9 });
    else if (resolution === 'finish') store.finish();
    else store.cancel();
    expect(retired).toHaveBeenCalledOnce(); expect(owner.current()).toBe(false);
    expect(owner.write(after)).toBe(false); expect(after).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toEqual(resolution === 'replacement' ? { id: 'other-owner', x: 9 } : null);
  });
  it('retires an unmoved press on cancellation without beginning history', () => {
    const store = PathEdit.create<{ id: string; x: number }>(), retired = vi.fn(), begin = vi.fn();
    const owner = createFieldGestureOwner(store, 'path', retired);
    store.cancel(); expect(retired).toHaveBeenCalledOnce();
    expect(owner.write(begin, true)).toBe(false); expect(begin).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toBeNull();
  });
  it('never adopts an existing draft owned by another gesture', () => {
    const store = PathEdit.create<{ id: string; x: number }>(); store.begin({ id: 'path', x: 4 });
    const retired = vi.fn(), begin = vi.fn(), owner = createFieldGestureOwner(store, 'path', retired);
    expect(owner.write(begin, true)).toBe(false); expect(begin).not.toHaveBeenCalled();
    expect(retired).toHaveBeenCalledOnce(); expect(store.getSnapshot()).toEqual({ id: 'path', x: 4 });
  });
  it('detects synchronous external finish during an owned update without recursion', () => {
    const store = PathEdit.create<{ id: string; x: number }>(), retired = vi.fn();
    const owner = createFieldGestureOwner(store, 'path', retired);
    owner.write(() => store.begin({ id: 'path', x: 0 }), true);
    let finish = true;
    store.subscribe(() => { if (finish && store.getSnapshot()) { finish = false; store.finish(); } });
    expect(owner.write(() => store.update({ id: 'path', x: 2 }))).toBe(false);
    expect(retired).toHaveBeenCalledOnce(); expect(store.getSnapshot()).toBeNull();
  });
  it('releases an ordinary unmoved click without an edit or store emission', () => {
    const store = PathEdit.create<{ id: string; x: number }>(), emitted = vi.fn(); store.subscribe(emitted);
    createFieldGestureOwner(store, 'path', vi.fn()).dispose();
    expect(store.getRevision()).toBe(0); expect(emitted).not.toHaveBeenCalled();
  });
  it('does not adopt a same-path draft restarted synchronously by another owner', () => {
    const store = PathEdit.create<{ id: string; x: number }>(), retired = vi.fn();
    const owner = createFieldGestureOwner(store, 'path', retired);
    owner.write(() => store.begin({ id: 'path', x: 0 }), true);
    let replace = true;
    store.subscribe(() => {
      if (replace && store.getSnapshot()) { replace = false; store.finish(); store.begin({ id: 'path', x: 99 }); }
    });
    expect(owner.write(() => store.update({ id: 'path', x: 2 }))).toBe(false);
    expect(retired).toHaveBeenCalledOnce(); expect(store.getSnapshot()).toEqual({ id: 'path', x: 99 });
  });
});

describe('field range edges', () => {
  const waypoints = buildWaypoints([{ x: 2, y: 2, segType: 'line' }, { x: 4, y: 2, segType: 'line' }, { x: 8, y: 2 }]);
  const geometry = sample(waypoints, 14, true);
  it.each(['param', 'dist', 'wp'] as const)('clamps both %s edges and maps inverted authored ends', anchor => {
    const range: ConstraintRange = { anchor, f0: 0.2, f1: 0.8, d0: 1.2, d1: 4.8, w0: 0, t0: 0.6, w1: 1, t1: 0.7 };
    const effective = effectiveRanges({ waypoints, ranges: [range] }, geometry)[0];
    const start = fieldRangeEndpoint(effective, 0, 1, geometry.length), end = fieldRangeEndpoint(effective, 1, 0, geometry.length);
    expect(start.which).toBe(0); expect(start.f).toBeCloseTo(effective.f1, 12);
    expect(end.which).toBe(1); expect(end.f).toBeCloseTo(effective.f0, 12);
    const inverted = { ...effective, f0: effective.f1, f1: effective.f0 };
    expect(fieldRangeEndpoint(inverted, 0, 1, geometry.length).which).toBe(1);
    expect(fieldRangeEndpoint(inverted, 1, 0, geometry.length).which).toBe(0);
    expect(inverted.anchor).toBe(anchor);
  });
  it('keeps centimetre rounding on its side of a finer legacy distance boundary', () => {
    const start = fieldRangeEndpoint({ anchor: 'dist', f0: 0.1, f1: 0.235 }, 0, 1, 1);
    expect(+(start.f).toFixed(2)).toBe(0.23);
    const end = fieldRangeEndpoint({ anchor: 'dist', f0: 0.235, f1: 0.8 }, 1, 0, 1);
    expect(+(end.f).toFixed(2)).toBe(0.24);
  });
});
