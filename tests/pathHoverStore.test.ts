import { describe, expect, it, vi } from 'vitest';
import { createPathHoverStore, type HoverContext } from '../src/renderer/lib/pathHoverStore';

function setup() {
  let id = 0;
  const queued = new Map<number, FrameRequestCallback>(), retained = new Map<number, FrameRequestCallback>();
  const clock = { request(callback: FrameRequestCallback) { queued.set(++id, callback); retained.set(id, callback); return id; }, cancel(key: number) { queued.delete(key); } };
  const store = createPathHoverStore(clock);
  const context: HoverContext = { eligible: true, total: 10, ready: () => true };
  store.activate(context);
  return { store, context, queued, retained, flush() { const work = [...queued]; queued.clear(); work.forEach(([, callback]) => callback(0)); } };
}
const field = () => ({ f: [.1, .6], primary: 1 });
describe('path hover ownership', () => {
  it('coalesces and copies bounded fractions, notifies leaves only for full snapshot changes', () => {
    const { store, context, flush, queued } = setup(), notify = vi.fn(), first = vi.fn(field);
    const unsubscribe = store.subscribe(notify), value = field();
    store.queueField(context, first); store.queueField(context, () => value);
    expect(queued.size).toBe(1); flush(); expect(first).not.toHaveBeenCalled(); expect(notify).toHaveBeenCalledTimes(1);
    value.f[1] = .9; expect(store.getSnapshot()).toMatchObject({ f: [.1, .6], primary: 1 });
    expect(Object.isFrozen(store.getSnapshot())).toBe(true);
    store.queueField(context, field); flush(); expect(notify).toHaveBeenCalledTimes(1);
    store.queueField(context, () => ({ f: [.1, .7], primary: 1 })); flush(); expect(notify).toHaveBeenCalledTimes(2);
    store.queueField(context, () => ({ f: [.1, .7], primary: 0 })); flush(); expect(notify).toHaveBeenCalledTimes(3);
    store.queueField(context, () => ({ f: [.1], primary: 0 })); flush(); expect(notify).toHaveBeenCalledTimes(4);
    unsubscribe(); store.clear(); expect(notify).toHaveBeenCalledTimes(4);
  });
  it('timeline ownership cancels even an equal-time field frame and retained callbacks never run producers', () => {
    const { store, context, flush, queued, retained } = setup(), produce = vi.fn(field);
    store.setTimeline(context, 2); store.queueField(context, produce); const old = [...retained.values()][0];
    store.setTimeline(context, 2); expect(queued.size).toBe(0); old(0); expect(produce).not.toHaveBeenCalled();
    store.queueField(context, produce); old(0); expect(produce).not.toHaveBeenCalled(); flush(); expect(produce).toHaveBeenCalledTimes(1);
    const finished = [...retained.values()].at(-1)!;
    store.queueField(context, produce); finished(0); expect(produce).toHaveBeenCalledTimes(1);
  });
  it('late leaves preserve the other source in both crossing orders', () => {
    const { store, context, flush, queued } = setup();
    store.setTimeline(context, 1); store.queueField(context, field); store.clear('timeline', context);
    expect(queued.size).toBe(1); flush(); expect(store.getSnapshot()?.source).toBe('field');
    store.setTimeline(context, 2); store.clear('field', context); expect(store.getSnapshot()).toMatchObject({ source: 'timeline', t: 2 });
    store.clear('timeline', context); expect(store.getSnapshot()).toBeNull();
  });
  it('same live activation preserves, context retirement rejects old cleanup/publication and reactivation preserves subscribers', () => {
    const { store, context, retained, flush } = setup(), listener = vi.fn(), producer = vi.fn(field);
    store.subscribe(listener); store.setTimeline(context, 1); store.activate(context); expect(listener).toHaveBeenCalledTimes(1);
    store.queueField(context, producer); const old = [...retained.values()][0]; store.deactivate(context);
    store.activate(context); old(0); expect(producer).not.toHaveBeenCalled(); store.setTimeline(context, 3); expect(listener).toHaveBeenCalledTimes(3);
    const next = { ...context }; store.activate(next); store.queueField(next, field);
    store.deactivate(context); store.clear(undefined, context); store.setTimeline(context, 4); flush(); expect(store.getSnapshot()?.context).toBe(next);
  });
  it('checks gate before and after producer and globally retires all queued work', () => {
    const { store, context, retained, flush } = setup(); let ready = true; context.ready = () => ready;
    const producer = vi.fn(field); store.queueField(context, producer); ready = false; flush(); expect(producer).not.toHaveBeenCalled();
    ready = true; store.queueField(context, () => { ready = false; return field(); }); flush(); expect(store.getSnapshot()).toBeNull();
    ready = true; store.queueField(context, producer); store.clear(); [...retained.values()].forEach(fn => fn(0)); expect(producer).not.toHaveBeenCalled();
    context.eligible = false; store.queueField(context, producer); store.setTimeline(context, 1); expect(store.getSnapshot()).toBeNull();
  });
  it.each([NaN, Infinity, -1, 11])('rejects invalid or out-of-context timeline time %s', t => {
    const { store, context } = setup(); store.setTimeline(context, t); expect(store.getSnapshot()).toBeNull();
  });
  it.each([{ f: [], primary: 0 }, { f: [NaN], primary: 0 }, { f: [Infinity], primary: 0 }, { f: [-.1], primary: 0 },
    { f: [1.1], primary: 0 }, { f: [0,.1,.2,.3], primary: 0 }, { f: [.1], primary: -1 }, { f: [.1], primary: 1 }, { f: [.1], primary: .5 }])('rejects malformed field payload %j', value => {
    const { store, context, flush } = setup(); store.queueField(context, () => value); flush(); expect(store.getSnapshot()).toBeNull();
  });
  it('destroy leaves no frame or listeners; obsolete producers remain retired', () => {
    const { store, context, queued, retained } = setup(), listener = vi.fn(), producer = vi.fn(field);
    store.subscribe(listener); store.queueField(context, producer); store.destroy();
    expect(queued.size).toBe(0); [...retained.values()].forEach(fn => fn(0)); expect(producer).not.toHaveBeenCalled();
    store.activate(context); store.setTimeline(context, 2); expect(listener).not.toHaveBeenCalled();
  });
});
