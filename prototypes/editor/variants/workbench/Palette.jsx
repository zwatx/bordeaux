// ⌘K palette: every action, every path. Opens instantly (no motion: it is used constantly).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon.jsx";

function matches(item, words) {
  const hay = (item.label + " " + (item.group || "")).toLowerCase();
  return words.every((w) => hay.includes(w));
}

export function Palette({ items, commandItems, onClose }) {
  const [step, setStep] = useState("root");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef(null);
  const list = useRef(null);
  const returnTo = useRef(typeof document !== "undefined" ? document.activeElement : null);

  useEffect(() => {
    input.current?.focus();
    const back = returnTo.current;
    return () => { if (back && back.isConnected && back !== document.body) back.focus?.(); };
  }, []);

  const source = step === "commands" ? commandItems : items;
  const shown = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return words.length ? source.filter((i) => matches(i, words)) : source;
  }, [source, query]);
  useEffect(() => setActive(0), [query, step]);
  useLayoutEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const run = (item) => {
    if (!item) return;
    if (item.next) { setStep(item.next); setQuery(""); input.current?.focus(); return; }
    onClose();
    item.run?.();
  };

  const onKeyDown = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(shown.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); run(shown[active]); }
    else if (e.key === "Escape") { e.preventDefault(); if (step !== "root") { setStep("root"); setQuery(""); } else onClose(); }
    else if (e.key === "Backspace" && !query && step !== "root") { e.preventDefault(); setStep("root"); }
    else if (e.key === "Tab") e.preventDefault();
  };

  let lastGroup = null;
  return (
    <div className="wb-palette-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="wb-palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="wb-palette-input">
          {step === "commands" && <span className="wb-palette-crumb">Add command</span>}
          <input ref={input} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKeyDown} spellCheck={false}
            placeholder={step === "commands" ? "Which command?" : "Type an action or path"} aria-label="Search actions and paths"
            role="combobox" aria-expanded="true" aria-controls="wb-palette-list" aria-activedescendant={shown[active] ? "wb-pi-" + active : undefined} />
          <kbd>Esc</kbd>
        </div>
        <div className="wb-palette-list" id="wb-palette-list" role="listbox" ref={list}>
          {shown.map((item, i) => {
            const header = item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            return (
              <div key={item.id} role="presentation">
                {header && step === "root" && <div className="wb-palette-group" role="presentation">{header}</div>}
                <div id={"wb-pi-" + i} data-index={i} role="option" aria-selected={i === active} className="wb-palette-item"
                  onPointerMove={() => { if (active !== i) setActive(i); }} onClick={() => run(item)}>
                  <span className="wb-palette-label">{item.label}</span>
                  {item.current && <span className="wb-palette-meta">Current</span>}
                  {item.meta && <span className="wb-palette-meta num">{item.meta}</span>}
                  {item.next && <Icon name="chev" />}
                  {item.hint && <kbd>{item.hint}</kbd>}
                </div>
              </div>
            );
          })}
          {!shown.length && <div className="wb-palette-empty">No match</div>}
        </div>
      </div>
    </div>
  );
}
