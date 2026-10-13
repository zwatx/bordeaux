// Path column: project, history, every path with its time and state, and the push control (SIMULATED push).
import { useEffect, useRef } from "react";
import { ProjectChip } from "../../core/ProjectChip.jsx";
import { Icon } from "./Icon.jsx";
import { clock, fmtTime } from "./labels.js";

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const KEYS = { push: IS_MAC ? "⇧⌘P" : "Ctrl Shift P", undo: IS_MAC ? "⌘Z" : "Ctrl Z", redo: IS_MAC ? "⇧⌘Z" : "Ctrl Shift Z" };

export function PathList({
  rows, activeId, query, setQuery, searchRef, onPick, onStep, onHover, marks, toggleMark,
  onHide, push, children,
}) {
  const list = useRef(null);
  useEffect(() => {
    if (list.current?.contains(document.activeElement)) list.current.querySelector(`[data-path-id="${activeId}"] .hy-path-main`)?.focus();
    list.current?.querySelector(`[data-path-id="${activeId}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  return (
    <nav className="hy-paths" aria-label="Paths">
      <div className="hy-paths-head">
        <ProjectChip className="hy-projectchip" />
        <span className="hy-head-actions">
          <button type="button" className="hy-icon-btn" onClick={onHide} aria-label="Hide paths" aria-keyshortcuts="\" title="Hide paths · \"><Icon name="sidebar" /></button>
        </span>
      </div>
      <div className="hy-search">
        <Icon name="search" />
        <input ref={searchRef} type="search" value={query} placeholder="Find path" aria-label="Find path" spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); onStep(e.key === "ArrowDown" ? 1 : -1); }
            else if (e.key === "Enter") { const first = rows[0]; if (first && !rows.some((r) => r.id === activeId)) onPick(first.id); e.currentTarget.blur(); }
            else if (e.key === "Escape") { e.preventDefault(); setQuery(""); e.currentTarget.blur(); }
          }} />
        {!query && <kbd>/</kbd>}
      </div>
      <div className="hy-path-list" ref={list} role="list" onPointerLeave={() => onHover(null)}>
        {rows.map((r) => {
          const marked = marks.has(r.id);
          const sending = push.phase === "sending" && (push.sending || []).includes(r.id);
          const state = r.error ? "error" : r.changed ? "changed" : null;
          return (
            <div key={r.id} role="listitem" data-path-id={r.id} className="hy-path" data-active={r.id === activeId ? "" : undefined}
              data-marked={marked ? "" : undefined} data-state={state || undefined} onPointerEnter={() => onHover(r.id)}>
              <button type="button" className="hy-path-mark" tabIndex={-1} aria-pressed={marked} aria-label={(marked ? "Don't push " : "Push only ") + r.name}
                title="Choose for push · X" onClick={() => toggleMark(r.id)}>
                <span className="hy-mark-box" aria-hidden="true">{marked && <Icon name="check" />}</span>
                <span className={"hy-dot" + (sending ? " sending" : "")} data-state={state || undefined} aria-hidden="true" />
              </button>
              <button type="button" className="hy-path-main" aria-current={r.id === activeId ? "true" : undefined}
                onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey) toggleMark(r.id); else onPick(r.id); }}
                onKeyDown={(e) => { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); onStep(e.key === "ArrowDown" ? 1 : -1); } }}>
                <span className="hy-path-name">{r.name}</span>
                <span className="hy-path-time num">{fmtTime(r.time)}<span className="hy-unit"> s</span></span>
                <span className="hy-sr">{r.error ? ", has a problem" : r.changed ? ", changed since push" : ""}</span>
              </button>
            </div>
          );
        })}
        {!rows.length && <div className="hy-empty">No match</div>}
      </div>
      {children}
    </nav>
  );
}

/** One push action. Shows the destination, what will be sent, progress, and what was held back and why. */
export function PushControl({ push, ids, marked, refused, onPush, onClearMarks, onOpen, compact = false }) {
  const sending = push.phase === "sending";
  const n = ids.length;
  const label = sending ? `Pushing ${push.sending?.length || n}…` : n ? `Push ${n} ${marked ? "chosen" : "changed"}` : "Up to date";
  const duration = 420 + 160 * Math.max(1, push.sending?.length || n);
  let status = null;
  if (!sending && refused?.length) {
    const first = refused[0];
    status = (
      <button type="button" className="hy-push-held" onClick={() => onOpen(first.id)} title={refused.map((r) => `${r.name}: ${r.reason}`).join("\n")}>
        <span className="hy-push-held-head">Not sent{refused.length > 1 ? ` · ${refused.length} paths` : ""}</span>
        <span className="hy-push-held-name">{first.name} · {first.reason}</span>
      </button>
    );
  } else if (!sending && push.failed && push.phase === "refused") {
    status = <span className="hy-push-status bad">Not sent · {push.failed}</span>;
  } else if (!sending && push.lastAt) {
    status = <span className="hy-push-status"><Icon name="check" className={push.phase === "done" ? "good" : ""} />Pushed {push.lastCount} · {clock(push.lastAt)}</span>;
  }
  if (compact) {
    return (
      <button type="button" className="hy-push-btn compact" data-state={sending ? "sending" : n ? "ready" : "idle"} aria-busy={sending || undefined}
        onClick={onPush} title={`${push.destination.host} · ${push.destination.folder} · ${KEYS.push}`} style={{ "--hy-push-ms": duration + "ms" }}>
        {sending && <span className="hy-push-fill" aria-hidden="true" />}
        <span>{label}</span>
      </button>
    );
  }
  return (
    <div className="hy-push">
      <div className="hy-push-dest">
        <span className="num">{push.destination.host}</span><span className="hy-sep">·</span><span>{push.destination.folder}</span>
        {marked && !sending && <button type="button" className="hy-link hy-push-clear" onClick={onClearMarks}>Clear</button>}
      </div>
      <button type="button" className="hy-push-btn" data-state={sending ? "sending" : n ? "ready" : "idle"} aria-busy={sending || undefined}
        onClick={onPush} style={{ "--hy-push-ms": duration + "ms" }}>
        {sending && <span className="hy-push-fill" aria-hidden="true" />}
        <span className="hy-push-label">{label}</span>
        {!sending && n > 0 && <kbd>{KEYS.push}</kbd>}
      </button>
      <div className="hy-push-foot" aria-live="polite">{status}</div>
    </div>
  );
}

export function History({ undo, redo, canUndo, canRedo }) {
  return <>
    <button type="button" className="hy-icon-btn" onClick={undo} aria-label="Undo" title={"Undo · " + KEYS.undo} data-dim={canUndo ? undefined : ""}><Icon name="undo" /></button>
    <button type="button" className="hy-icon-btn" onClick={redo} aria-label="Redo" title={"Redo · " + KEYS.redo} data-dim={canRedo ? undefined : ""}><Icon name="redo" /></button>
  </>;
}
