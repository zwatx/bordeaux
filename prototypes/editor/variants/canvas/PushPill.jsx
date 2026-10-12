// Top-right: push is a state, not a dialog. Destination + changed count; progress and result live in the pill.
import { useCallback, useRef, useState } from "react";
import { Icon, clock, useEscape, useOutside } from "./ui.jsx";

export function PushPill({ push, paths, onPush, refused }) {
  const [open, setOpen] = useState(false);
  const pillRef = useRef(null), popRef = useRef(null), destBtn = useRef(null);
  useOutside(popRef, open, () => setOpen(false), pillRef);
  const closeAndFocus = useCallback(() => { setOpen(false); destBtn.current?.focus(); }, []);
  useEscape(open, closeAndFocus);
  const changed = push.changedIds;
  const sending = push.phase === "sending";
  const nameOf = (id) => paths.find((p) => p.id === id)?.name || id;
  const sendingCount = push.sending?.length || 0;
  const duration = 420 + 160 * sendingCount;

  let state;
  if (sending) state = <span className="cv-push-state num" role="status">Sending {sendingCount}…</span>;
  else if (changed.length) state = (
    <button className="cv-push-btn" onClick={onPush} aria-keyshortcuts="Meta+Shift+P">
      Push <span className="num">{changed.length}</span>
    </button>
  );
  else state = <span className="cv-push-state done" role="status"><Icon.check /> Pushed <span className="num">{push.lastCount} · {push.lastAt ? clock(push.lastAt) : "–"}</span></span>;

  return (
    <div className="cv-topright">
      <div ref={pillRef} className="cv-pill cv-pushpill" data-sending={sending || undefined}>
        <button ref={destBtn} className="cv-push-dest" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}
          aria-label={`Destination ${push.destination.host}, ${push.destination.folder}. ${changed.length} changed`}>
          <span className="num">{push.destination.host}</span><span className="cv-push-folder">· {push.destination.folder}</span>
        </button>
        {state}
        {sending && <span key={push.lastAt + ":" + sendingCount} className="cv-push-progress" style={{ animationDuration: duration + "ms" }} aria-hidden="true" />}
      </div>
      {refused.length > 0 && !sending && (
        <div className="cv-refused" role="alert">
          <span className="cv-refused-name">{nameOf(refused[0].id)}</span>
          <span className="cv-refused-why">· {refused[0].reason}</span>
        </div>
      )}
      {open && (
        <div ref={popRef} className="cv-pop cv-pushpop" role="dialog" aria-label="Changed paths">
          {changed.length ? <ul className="cv-list plain">
            {changed.map((id) => {
              const r = refused.find((x) => x.id === id);
              return <li key={id} className="cv-row static">
                <span className={"cv-dot" + (r ? " bad" : " changed")} />
                <span className="cv-row-name">{nameOf(id)}</span>
                {r && <span className="cv-row-why">{r.reason}</span>}
              </li>;
            })}
          </ul> : <p className="cv-empty">Nothing changed</p>}
          {push.lastAt && <p className="cv-pushpop-foot num">Last push {push.lastCount} · {clock(push.lastAt)}</p>}
        </div>
      )}
    </div>
  );
}
