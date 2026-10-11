// Minimal mount of the shared core, used to verify the harness before variants exist.
import { useState } from "react";
import { Field } from "../core/Field.jsx";
import { useEditorKeys, usePlan, usePlayback, useProjectState } from "../core/state.js";

export function CoreCheck() {
  const store = useProjectState();
  const [selection, setSelection] = useState(null);
  const plan = usePlan(store.activePath, store.project.robot, store.project.field);
  const playback = usePlayback(plan.totalTime);
  useEditorKeys({ selection, setSelection, edit: store.edit, undo: store.undo, redo: store.redo, togglePlay: playback.toggle });
  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <Field path={store.activePath} derived={plan.derived} issues={plan.issues} robot={store.project.robot}
        selection={selection} onSelect={setSelection} edit={store.edit} playhead={{ t: playback.t, visible: playback.t > 0 }} />
      <div style={{ position: "fixed", top: 12, left: 12, fontFamily: "var(--mono)", fontSize: 12 }} data-testid="status">
        {plan.status} · {plan.totalTime.toFixed(2)} s · {plan.issues.length} issues
      </div>
    </div>
  );
}
