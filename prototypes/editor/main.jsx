// Prototype harness: one variant at a time, full size, with the standard picker.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./core/core.css";
import "./picker.css";
import { VARIANTS } from "./variants/index.js";

function Picker({ names, active, onPick, position }) {
  const nav = useRef(null);
  const [box, setBox] = useState({ x: 0, w: 0 });
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    const el = nav.current?.querySelectorAll(".proto-picker-item")[active];
    if (el) setBox((b) => (b.x === el.offsetLeft && b.w === el.offsetWidth ? b : { x: el.offsetLeft, w: el.offsetWidth }));
  }, [active, names.join("|")]);
  useEffect(() => { const id = requestAnimationFrame(() => setReady(true)); return () => cancelAnimationFrame(id); }, []);
  return (
    <nav ref={nav} className="proto-picker" aria-label="Prototype variants" data-ready={ready ? "" : undefined} data-position={position}>
      <span className="proto-picker-highlight" aria-hidden="true" style={{ width: box.w, transform: `translateX(${box.x}px)` }} />
      {names.map((name, i) => (
        <button key={name} className="proto-picker-item" data-active={i === active ? "" : undefined} aria-current={i === active ? "true" : undefined} onClick={() => onPick(i)}>{name}</button>
      ))}
    </nav>
  );
}

function Harness() {
  const initial = Math.max(0, Math.min(VARIANTS.length - 1, Number(new URLSearchParams(location.search).get("v") || 1) - 1));
  const [active, setActive] = useState(initial);
  const pick = (i) => {
    setActive(i);
    const url = new URL(location.href); url.searchParams.set("v", String(i + 1)); history.replaceState(null, "", url);
  };
  useEffect(() => {
    const onKey = (e) => {
      const el = e.target;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (el?.closest?.("input,textarea,select,[contenteditable=true]")) return;
      const n = Number(e.key);
      if (n >= 1 && n <= VARIANTS.length) { pick(n - 1); e.preventDefault(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const Variant = VARIANTS[active].component;
  return (
    <>
      <Variant key={active} />
      <div className="proto-sim-tag" data-position={VARIANTS[active].pickerPosition}>Prototype · robot push is simulated</div>
      <Picker names={VARIANTS.map((v) => v.name)} active={active} onPick={pick} position={VARIANTS[active].pickerPosition} />
    </>
  );
}

createRoot(document.getElementById("root")).render(<Harness />);
