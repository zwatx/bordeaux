export interface HoverContext {
  eligible: boolean;
  total: number;
  ready(): boolean;
}
export interface FieldHover { f: readonly number[]; primary: number }
export type PathHover = null | { context: HoverContext; source: 'timeline'; t: number }
  | { context: HoverContext; source: 'field'; f: readonly number[]; primary: number };
interface FrameClock { request(callback: FrameRequestCallback): number; cancel(id: number): void }

/** One displayed result and one pending field frame; leaf components own their subscriptions. */
export function createPathHoverStore(clock: FrameClock = { request: callback => requestAnimationFrame(callback), cancel: id => cancelAnimationFrame(id) }) {
  let context: HoverContext | null = null, snapshot: PathHover = null;
  let frame: number | null = null, epoch = 0;
  let pending: (() => FieldHover | null) | null = null;
  const listeners = new Set<() => void>();
  const emit = (next: PathHover) => {
    const old = snapshot;
    if (old === next || old && next && old.context === next.context && old.source === next.source
      && (old.source === 'timeline' && next.source === 'timeline' ? Math.abs(old.t - next.t) <= 1e-4
        : old.source === 'field' && next.source === 'field' && old.primary === next.primary && old.f.length === next.f.length
          && old.f.every((f, i) => Math.abs(f - next.f[i]) <= 1e-4))) return;
    snapshot = next;
    listeners.forEach(listener => listener());
  };
  const cancel = () => {
    epoch++;
    if (frame !== null) clock.cancel(frame);
    frame = null; pending = null;
  };
  const ready = (owner: HoverContext) => context === owner && owner.eligible && owner.ready();
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot() { return snapshot; },
    activate(owner: HoverContext) {
      if (context === owner) return;
      cancel(); context = owner; emit(null);
    },
    // Reversible layout cleanup: StrictMode reactivation must retain still-live leaf listeners.
    deactivate(owner: HoverContext) {
      if (context !== owner) return;
      cancel(); context = null; emit(null);
    },
    clear(source?: 'field' | 'timeline', owner?: HoverContext) {
      if (owner && context !== owner) return;
      if (source !== 'timeline') cancel();
      if (!source || snapshot?.source === source) emit(null);
    },
    setTimeline(owner: HoverContext, t: number) {
      if (!ready(owner) || !Number.isFinite(t) || t < 0 || t > owner.total) return;
      cancel();
      emit(Object.freeze({ context: owner, source: 'timeline', t }));
    },
    queueField(owner: HoverContext, producer: () => FieldHover | null) {
      if (!ready(owner)) return;
      pending = producer;
      if (frame !== null) return;
      const ticket = ++epoch;
      frame = clock.request(() => {
        if (ticket !== epoch || context !== owner) return;
        frame = null;
        const produce = pending; pending = null;
        if (!ready(owner) || !produce) return;
        const value = produce();
        if (ticket !== epoch || !ready(owner)) return;
        if (!value) { if (snapshot?.source === 'field') emit(null); return; }
        const { f, primary } = value;
        if (!f.length || f.length > 3 || !f.every(n => Number.isFinite(n) && n >= 0 && n <= 1)
          || !Number.isInteger(primary) || primary < 0 || primary >= f.length) return;
        emit(Object.freeze({ context: owner, source: 'field', f: Object.freeze([...f]), primary }));
      });
    },
    destroy() { cancel(); context = null; snapshot = null; listeners.clear(); },
  };
}
