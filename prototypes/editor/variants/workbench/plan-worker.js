// Background timing for the non-active paths: same planPath call the core uses, reduced to what the list shows.
import { planPath } from "../../../../src/shared/planners/planPath";

self.onmessage = ({ data }) => {
  let time = null, error = true, reason = "Can't time this path";
  try {
    const result = planPath(data.input);
    time = result.bestEffort?.totalTimeS ?? null;
    const first = result.issues.find((issue) => issue.severity === "error");
    error = Boolean(first);
    reason = first?.message || null;
  } catch { /* reported as an error row */ }
  self.postMessage({ id: data.id, time, error, reason });
};
