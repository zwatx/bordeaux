// Top-left: the active path (name, time, changed dot), a searchable switcher, and path speed limits.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Icon, NumField, fmt, useEscape, useOutside } from "./ui.jsx";
import { ProjectChip } from "../../core/ProjectChip.jsx";

export const PathPill = forwardRef(function PathPill({ project, activePath, totalTime, otherPlans, changedIds, onPick, onPreview, edit, hasError }, ref) {
  const [open, setOpen] = useState(null); // 'paths' | 'limits' | null
  const pillRef = useRef(null), popRef = useRef(null), nameBtn = useRef(null), limitBtn = useRef(null);
  const close = useCallback((returnFocus = true) => {
    setOpen((was) => {
      if (returnFocus) (was === "limits" ? limitBtn : nameBtn).current?.focus();
      return null;
    });
    onPreview(null);
  }, [onPreview]);
  useOutside(popRef, Boolean(open), () => close(false), pillRef);
  useEscape(Boolean(open), close);
  useImperativeHandle(ref, () => ({ openPaths: () => setOpen("paths"), toggleLimits: () => setOpen((o) => (o === "limits" ? null : "limits")) }), []);

  const changed = changedIds.includes(activePath.id);
  const c = activePath.constraints || {};
  return (
    <div className="cv-topleft">
      <div className="cv-pill cv-pathpill" ref={pillRef} data-open={open || undefined}>
        <ProjectChip className="cv-projectchip" />
        <span className="cv-pill-rule" aria-hidden="true" />
        <button ref={nameBtn} className="cv-pathpill-name" aria-haspopup="listbox" aria-expanded={open === "paths"}
          onClick={() => (open === "paths" ? close() : setOpen("paths"))}>
          <span className={"cv-dot" + (hasError ? " bad" : changed ? " changed" : "")} aria-label={hasError ? "Has a problem" : changed ? "Changed since push" : undefined} role={hasError || changed ? "img" : undefined} />
          <span className="cv-pathpill-title" title={activePath.name}>{activePath.name}</span>
          <span className="cv-pathpill-time num">{totalTime ? fmt(totalTime) : "–"} s</span>
          <span className="cv-pathpill-chev"><Icon.chevron /></span>
        </button>
        <span className="cv-pill-rule" aria-hidden="true" />
        <button ref={limitBtn} className="cv-pathpill-limits num" aria-haspopup="dialog" aria-expanded={open === "limits"} aria-label={`Path limits: speed ${fmt(c.maxVel, 1)} m/s, acceleration ${fmt(c.maxAccel, 1)} m/s²`}
          onClick={() => (open === "limits" ? close() : setOpen("limits"))}>
          {fmt(c.maxVel, 1)}<span className="cv-unit">m/s</span>
          <span className="cv-lim-acc"><span className="cv-sep" aria-hidden="true" />{fmt(c.maxAccel, 1)}<span className="cv-unit">m/s²</span></span>
        </button>
      </div>
      {open === "paths" && <Switcher ref={popRef} project={project} activeId={activePath.id} activeTime={totalTime} otherPlans={otherPlans} changedIds={changedIds}
        onPick={(id) => { onPick(id); close(false); document.activeElement?.blur?.(); }} onPreview={onPreview} onClose={close} />}
      {open === "limits" && <Limits ref={popRef} path={activePath} edit={edit} onClose={close} />}
    </div>
  );
});

const Switcher = forwardRef(function Switcher({ project, activeId, activeTime, otherPlans, changedIds, onPick, onPreview, onClose }, ref) {
  const [query, setQuery] = useState("");
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return project.paths.filter((p) => !q || p.name.toLowerCase().includes(q));
  }, [project.paths, query]);
  const [cursor, setCursor] = useState(() => Math.max(0, project.paths.findIndex((p) => p.id === activeId)));
  useEffect(() => { setCursor((i) => Math.min(Math.max(0, i), Math.max(0, list.length - 1))); }, [list.length]);
  useEffect(() => { onPreview(list[cursor] && list[cursor].id !== activeId ? list[cursor].id : null); }, [cursor, list, activeId, onPreview]);
  const listRef = useRef(null);
  useEffect(() => { listRef.current?.querySelector(`[data-i="${cursor}"]`)?.scrollIntoView({ block: "nearest" }); }, [cursor]);

  const onKeyDown = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setCursor((i) => Math.min(list.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((i) => Math.max(0, i - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); if (list[cursor]) onPick(list[cursor].id); }
  };
  return (
    <div ref={ref} className="cv-pop cv-switcher" role="dialog" aria-label="Paths">
      <div className="cv-search">
        <Icon.search />
        <input autoFocus value={query} onChange={(e) => { setQuery(e.target.value); setCursor(0); }} onKeyDown={onKeyDown}
          placeholder="Find path" aria-label="Find path" role="combobox" aria-expanded="true" aria-controls="cv-path-list"
          aria-activedescendant={list[cursor] ? "cv-path-" + list[cursor].id : undefined} spellCheck={false} />
        <kbd className="cv-kbd">⌘P</kbd>
      </div>
      <ul ref={listRef} id="cv-path-list" role="listbox" className="cv-list" aria-label="Paths">
        {list.map((p, i) => {
          const time = p.id === activeId ? activeTime : otherPlans[p.id]?.totalTime;
          const changed = changedIds.includes(p.id);
          const bad = p.id !== activeId && otherPlans[p.id]?.error;
          return (
            <li key={p.id} id={"cv-path-" + p.id} data-i={i} role="option" aria-selected={p.id === activeId}
              className="cv-row" data-cursor={i === cursor || undefined} data-active={p.id === activeId || undefined}
              onPointerEnter={() => setCursor(i)} onClick={() => onPick(p.id)}>
              <span className={"cv-dot" + (bad ? " bad" : changed ? " changed" : "")} aria-label={bad ? "Has a problem" : changed ? "Changed" : undefined} role={bad || changed ? "img" : undefined} />
              <span className="cv-row-name">{p.name}</span>
              <span className="cv-row-time num">{time ? fmt(time) : "–"} s</span>
            </li>
          );
        })}
        {!list.length && <li className="cv-empty">No match</li>}
      </ul>
    </div>
  );
});

const Limits = forwardRef(function Limits({ path, edit, onClose }, ref) {
  const [more, setMore] = useState(false);
  const c = path.constraints || {};
  const set = (key) => (v, phase) => edit(phase === "end" ? null : (d) => { d.constraints = { ...d.constraints, [key]: v }; return d; }, phase);
  return (
    <div ref={ref} className="cv-pop cv-limits" role="dialog" aria-label="Path limits">
      <NumField label="Speed" unit="m/s" value={c.maxVel} step={0.1} min={0} apply={set("maxVel")} autoFocus />
      <NumField label="Acceleration" unit="m/s²" value={c.maxAccel} step={0.1} min={0} apply={set("maxAccel")} />
      {more && <>
        <NumField label="Braking" unit="m/s²" value={c.maxDecel} step={0.1} min={0} apply={set("maxDecel")} />
        <NumField label="Turn speed" unit="°/s" value={c.maxAngVel} step={10} decimals={0} min={0} apply={set("maxAngVel")} />
      </>}
      <button className="cv-more" aria-expanded={more} onClick={() => setMore((m) => !m)}>{more ? "Less" : "More"}</button>
    </div>
  );
});
