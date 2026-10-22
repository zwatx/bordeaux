/**
 * The editor only plays and edits a current trajectory. Every planning error
 * therefore leaves the field blocked, and its notice must say so rather than
 * repeat the planner's internal fallback wording.
 *
 * - `interactive`: the quick preview could not be derived from the edited path.
 * - `failure`: final planning rejected the path or its limits.
 * - `timeout`: final planning did not finish within its deadline.
 */
export type PlanningErrorKind = "interactive" | "failure" | "timeout" | null;

type FinalPlanningResult = { status: string; fallbackReason?: string; deadlineMs?: number; error?: { message?: string } };

const FALLBACK_SUFFIX = /[.;]?\s*(Continuing with the last interactive result|The selected trajectory was not changed)\.?$/i;

export function planningErrorMessage(error: unknown): string {
  const raw = error && typeof error === "object" && "message" in error && typeof error.message === "string"
    ? error.message : String(error);
  return raw.replace(/^Final planning failed:\s*/i, "").replace(FALLBACK_SUFFIX, "").trim();
}

export function formatDeadline(deadlineMs: number | undefined): string {
  if (!Number.isFinite(deadlineMs)) return "its time limit";
  return String(Number(((deadlineMs as number) / 1000).toFixed(3))) + " s";
}

/** Maps an unsuccessful final-planning result to the error and kind the editor presents. */
export function finalPlanningError(result: FinalPlanningResult): { kind: Exclude<PlanningErrorKind, "interactive" | null>; error: Error } {
  if (result.status === "timeout") {
    return { kind: "timeout", error: new Error(`Planning did not finish within ${formatDeadline(result.deadlineMs)}.`) };
  }
  return { kind: "failure", error: new Error(planningErrorMessage({ message: result.fallbackReason || result.error?.message || "Final planning failed" })) };
}

export type PlanningNotice = { kind: Exclude<PlanningErrorKind, null>; label: string; detail: string; recovery: "retry" | "limits" };

export function planningNotice(error: unknown, kind: PlanningErrorKind): PlanningNotice | null {
  if (!error || !kind) return null;
  const message = planningErrorMessage(error);
  const sentence = /[.!?]$/.test(message) ? message : message + ".";
  if (kind === "timeout") {
    return { kind, label: "Planning timed out", recovery: "retry",
      detail: sentence + " Playback and field edits need a trajectory. Retry or simplify the path." };
  }
  return { kind, label: "Trajectory unavailable", recovery: "limits",
    detail: sentence + " Edit the limits or undo the last change to try again." };
}
