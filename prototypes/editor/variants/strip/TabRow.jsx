// Path tabs (scrollable, with changed dots), undo/redo, the all-paths menu, and the push control.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon, useDismiss } from "./parts";
import { fmt } from "./timeline";
import { ProjectChip } from "../../core/ProjectChip.jsx";

const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

export function TabRow({ project, activeId, onPick, changedIds, errors, times, canUndo, canRedo, undo, redo, push, onPush }) {
  const scroller = useRef(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const [menu, setMenu] = useState(false);
  const menuRef = useRef(null);
  const menuButton = useRef(null);
  const changed = new Set(changedIds);

  const measure = () => {
    const el = scroller.current;
    if (!el) return;
    setEdges({ left: el.scrollLeft > 2, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2 });
  };
  useLayoutEffect(() => {
    const el = scroller.current;
    const tab = el?.querySelector('[aria-selected="true"]');
    if (tab) {
      const l = tab.offsetLeft, r = l + tab.offsetWidth;
      if (l < el.scrollLeft + 24) el.scrollLeft = l - 24;
      else if (r > el.scrollLeft + el.clientWidth - 24) el.scrollLeft = r - el.clientWidth + 24;
    }
    measure();
  }, [activeId]);
  useEffect(() => {
    const el = scroller.current;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const wheel = (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { el.scrollLeft += e.deltaY; e.preventDefault(); }
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => { ro.disconnect(); el.removeEventListener("wheel", wheel); };
  }, []);

  const closeMenu = (why) => { setMenu(false); if (why === "escape") menuButton.current?.focus(); };
  useDismiss(menuRef, closeMenu, menu);

  const onTabKey = (e, index) => {
    const ids = project.paths.map((p) => p.id);
    let next = null;
    if (e.key === "ArrowRight") next = Math.min(ids.length - 1, index + 1);
    if (e.key === "ArrowLeft") next = Math.max(0, index - 1);
    if (e.key === "Home") next = 0;
    if (e.key === "End") next = ids.length - 1;
    if (next != null) {
      e.preventDefault();
      onPick(ids[next]);
      requestAnimationFrame(() => scroller.current?.querySelector(`[data-id="${ids[next]}"]`)?.focus());
    }
  };

  return (
    <header className="strip-top">
      <ProjectChip className="strip-projectchip" />
      <div className="strip-history">
        <button type="button" className="strip-icon-btn" aria-label="Undo" title="Undo (⌘Z)" onClick={undo} aria-disabled={!canUndo || undefined}><Icon.undo /></button>
        <button type="button" className="strip-icon-btn" aria-label="Redo" title="Redo (⇧⌘Z)" onClick={redo} aria-disabled={!canRedo || undefined}><Icon.redo /></button>
      </div>
      <div className="strip-tabs-wrap" data-fade-left={edges.left ? "" : undefined} data-fade-right={edges.right ? "" : undefined}>
        <div ref={scroller} className="strip-tabs" role="tablist" aria-label="Paths" onScroll={measure}>
          {project.paths.map((p, i) => {
            const active = p.id === activeId;
            const state = errors[p.id] ? "error" : changed.has(p.id) ? "changed" : null;
            return (
              <button
                key={p.id}
                type="button"
                role="tab"
                data-id={p.id}
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                className="strip-tab"
                title={p.name}
                onClick={() => onPick(p.id)}
                onKeyDown={(e) => onTabKey(e, i)}
              >
                <span className="strip-tab-name">{p.name}</span>
                <span className="strip-dot" data-state={state || undefined} aria-label={state === "error" ? "Has a problem" : state === "changed" ? "Changed since push" : undefined} />
              </button>
            );
          })}
        </div>
      </div>
      <div className="strip-menu-anchor">
        <button ref={menuButton} type="button" className="strip-icon-btn" aria-label="All paths" aria-expanded={menu} aria-haspopup="menu" onClick={() => setMenu((m) => !m)}><Icon.chevron /></button>
        {menu && (
          <div ref={menuRef} className="strip-menu" role="menu" aria-label="All paths">
            {project.paths.map((p) => (
              <button
                key={p.id}
                type="button"
                role="menuitemradio"
                aria-checked={p.id === activeId}
                className="strip-menu-item"
                onClick={() => { onPick(p.id); setMenu(false); }}
                ref={(el) => { if (el && p.id === activeId && menu && document.activeElement === menuButton.current) el.focus(); }}
              >
                <span className="strip-dot" data-state={errors[p.id] ? "error" : changed.has(p.id) ? "changed" : undefined} />
                <span className="strip-menu-name">{p.name}</span>
                <span className="strip-menu-time num">{fmt(times[p.id], 1)} s</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <PushControl push={push} changedIds={changedIds} errors={errors} project={project} onPush={onPush} onPick={onPick} />
    </header>
  );
}

function PushControl({ push, changedIds, errors, project, onPush, onPick }) {
  const [, tick] = useState(0);
  const [flash, setFlash] = useState(null);
  const prevPhase = useRef(push.phase);
  useEffect(() => {
    if (prevPhase.current === "sending" && push.phase === "done") {
      setFlash("done");
      const timer = setTimeout(() => setFlash(null), 2600);
      prevPhase.current = push.phase;
      return () => clearTimeout(timer);
    }
    prevPhase.current = push.phase;
    return undefined;
  }, [push.phase]);
  useEffect(() => { const id = setInterval(() => tick((n) => n + 1), 30000); return () => clearInterval(id); }, []);

  const sendable = changedIds.filter((idValue) => !errors[idValue]);
  const refused = changedIds.filter((idValue) => errors[idValue]);
  const sending = push.phase === "sending";
  const count = sending ? (push.sending || []).length : sendable.length;
  const nameOf = (idValue) => project.paths.find((p) => p.id === idValue)?.name || "Path";

  let status;
  const held = refused.length ? (refused.length === 1 ? "1 held" : `${refused.length} held`) : null;
  const heldTitle = refused.map((r) => nameOf(r) + ": " + errors[r]).join("\n");
  if (sending) status = null;
  else if (flash) status = <span className={"strip-push-status " + (held || push.failed ? "bad" : "good")} title={heldTitle || undefined}><Icon.check />Pushed {push.lastCount} · {clock(push.lastAt)}{held ? ` · ${held}` : push.failed ? ` · ${push.failed}` : ""}</span>;
  // The held path is one click away: the status opens it, where the problem is drawn on the path.
  else if (held) status = <button type="button" className="strip-push-status bad strip-push-held" title={heldTitle} onClick={() => onPick(refused[0])}>{held} · {errors[refused[0]]}</button>;
  else if (push.phase === "refused" && push.failed) status = <span className="strip-push-status bad">{push.failed}</span>;
  else if (push.lastAt && !sendable.length) status = <span className="strip-push-status">Pushed {push.lastCount} · {clock(push.lastAt)}</span>;

  const destination = `${push.destination.host} · ${push.destination.folder}`;
  return (
    <div className="strip-push" data-phase={push.phase}>
      <span className="strip-push-dest" title={"Destination " + destination}>{destination}</span>
      {status}
      {(sendable.length > 0 || sending) && (
        <button
          type="button"
          className="strip-push-btn"
          aria-label={sending ? "Pushing" : `Push ${sendable.length} to ${destination}`}
          title={sendable.map(nameOf).join("\n") + (push.lastAt ? `\nLast push ${clock(push.lastAt)}` : "") + "\n⌘⇧P"}
          onClick={onPush}
        >
          {sending ? "Pushing" : <>Push <span className="num">{sendable.length}</span></>}
          {sending && <span className="strip-push-progress" style={{ "--dur": 420 + 160 * count + "ms" }} />}
        </button>
      )}
    </div>
  );
}
