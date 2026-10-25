interface PlaybackSnapshot {
  time: number;
  playing: boolean;
  total: number;
}

/** Owns the animation frame and playback clock independently of React renders. */
export function createPlaybackStore() {
  let snapshot: PlaybackSnapshot = { time: 0, playing: false, total: 0 };
  let frame = 0, last = 0;
  const listeners = new Set<() => void>();
  const emit = (patch: Partial<PlaybackSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((listener) => listener());
  };
  const stopFrame = () => { if (frame) cancelAnimationFrame(frame); frame = 0; };
  const tick = (now: number) => {
    const time = Math.min(snapshot.total, snapshot.time + (now - last) / 1000);
    last = now;
    const playing = time < snapshot.total - 1e-6;
    emit({ time, playing });
    frame = playing ? requestAnimationFrame(tick) : 0;
  };
  const startFrame = () => {
    if (frame || !snapshot.playing) return;
    last = performance.now(); frame = requestAnimationFrame(tick);
  };
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot() { return snapshot; },
    setTotal(total: number) {
      const next = Math.max(0, total || 0);
      emit({ total: next, time: Math.min(snapshot.time, next), playing: snapshot.playing && snapshot.time < next });
      if (!snapshot.playing) stopFrame();
      startFrame();
    },
    toggle() {
      if (snapshot.playing) { stopFrame(); emit({ playing: false }); return; }
      emit({ time: snapshot.time >= snapshot.total - 1e-3 ? 0 : snapshot.time, playing: snapshot.total > 0 });
      startFrame();
    },
    restart() { stopFrame(); emit({ time: 0, playing: snapshot.total > 0 }); startFrame(); },
    pause() { stopFrame(); if (snapshot.playing) emit({ playing: false }); },
    seek(time: number) { stopFrame(); emit({ time: Math.max(0, Math.min(snapshot.total, time)), playing: false }); },
    reset() { stopFrame(); emit({ time: 0, playing: false }); },
    destroy() { stopFrame(); listeners.clear(); },
  };
}
