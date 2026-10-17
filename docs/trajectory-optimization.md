# Trajectory optimization

Place the required waypoints, set any required headings and stops, and configure the robot. The drawn curve is a starting guess for Optimize, not a boundary around the allowed route. Optimize chooses geometry between the required points and checks the robot footprint against the field. Both normal and optimized trajectories use the same physical limits. The initial editing preview is provisional until normal planning finishes.

Choose **Optimize** in the toolbar to open the inspector and start a quick search. Opening an existing result does not rerun it. Click the **Normal** or **Optimized** time row to preview; **In use** marks the saved selection. **Apply optimized** saves the candidate for that path. Previewing alone never changes the selection, and closing the inspector restores it. **Use normal** clears the saved optimization.

**Search options** contains **Quick search** (five seconds, up to 24 candidates), **Search deeper** (fifteen seconds, up to 48), and **Optimize all**. There is no path-deviation setting. Required waypoint positions and order, set headings, stops, waits, and command content remain part of the task. Fraction and distance anchors keep their existing travel-based meaning on the new route; they do not fix an event to a field coordinate. Waypoint-local zones remain attached to the complete required leg even when the solver inserts bends. Search outcomes and constraint diagnostics are available under **Details**.

A drawn curve that cannot be timed or safely driven does not prevent Optimize from trying other geometry. When there is no independently qualified drawn baseline, a valid result reads **Route found**, with no speedup percentage. A finite search that finds nothing reports that outcome; it does not prove the task impossible. Unsupported source features are reported explicitly.

A search can finish early when no further improvement is found. A physics evaluation cannot be interrupted in the middle, so the worker has a separate hard deadline. Validated checkpoints preserve the best available candidate if the worker times out or is canceled. Background completion never applies a result. **Optimize all** searches paths sequentially and stages candidates for individual application; it preserves existing selections.

An already-good route may have no meaningful gain. Against a qualified drawn baseline, improvements must save at least the greater of 20 ms or 0.5% of normal time. The search is bounded and does not prove a global optimum. It tries fresh full-vector Bézier geometry, strict retiming of the drawn curve, and obstacle-aware alternatives with internal knots; it does not require the seed's portal sequence. Current route search supports 2–41 required waypoints with Bézier segments and no jiggle actions. Other segment types are not silently converted. Clearance uses the actual oriented footprint, including motion between exported poses and stationary rotation. Numerical margins or exhausted subdivision can remain inconclusive. Search limits are engine-owned resource limits, not a hidden distance from the seed.

Seed qualification distinguishes valid, invalid and unknown. An untested seed or an inconclusive clearance certificate is not called invalid. A slower alternative is not offered as an improvement over a ready Normal merely because its seed is unknown. Configured and authored limits remain authoritative; Optimize does not invent a BUMP speed limit from the agent route generator's heuristic.

## Zone limits

Zones are stored as constraint ranges. The editor offers optional speed, acceleration, angular speed, and angular acceleration limits. Acceleration is one control for speeding up and slowing down: adding or editing it writes both stored `maxAccel` and `maxDecel`, and removing it clears both. The whole-path Acceleration control also writes both values. Omitted limits inherit the path limits; overlapping enabled limits use the tightest value. Angular acceleration continues to constrain both angular acceleration and braking. A zone with no enabled limits does not change timing.

Existing saved values, including differing acceleration and deceleration limits, remain unchanged until explicitly edited. The inspector explains when an older path or zone has different speeding and slowing limits. The planner continues to support independent stored fields; an omitted `maxDecel` inherits path deceleration rather than implicitly copying zone acceleration.

## Saved-result contract

`PathDoc.optimization.accepted` stores the explicit selection, including its version, input identity, resolution, and exact samples, solved geometry, required-point mapping, actions, and markers. New route selections use version 2. Cosmetic names, folders, and robot planning notes do not invalidate them. Handle-only changes edit the next search seed and retire pending searches, while preserving an applied route for the same task. Changing a required point, heading, constraint, robot physics, or field makes the selection outdated: playback, routine timing, and export then use current normal planning. The artifact stays available for Undo; a new optimization is never selected automatically. A matching-input artifact that fails independent validation blocks export until the user chooses normal or applies a valid candidate.

Earlier version-1 selections retain their original corridor, identity, exact samples, and validation. Opening them does not widen their freedom or rerun a search. The panel identifies these earlier optimizations; **Optimize again** searches under the new route model, and only **Apply optimized** changes the selection. Applying a new route retains the prior version-1 artifact in `legacyAccepted`. **Use normal** removes the active selection without activating that archive. New selected routes require project source schema 1.2 and standalone path version 2.1 so older readers reject them instead of ignoring the selected route. A project that adopts schema 1.2 keeps that version after **Use normal**, even when no version-2 selection remains; clearing a selection does not downgrade its source format.

Project files with a legacy project-wide `plannerId` still load. That field no longer launches optimization or chooses a fresh solve at export; without a per-path accepted artifact, the path uses normal timing. BDX sample format and LabVIEW trajectory readers remain unchanged.

Legacy identity and structural checks live in `src/shared/planners/acceptedTrajectoryIdentity.ts`; new route intent and seed identities live in `routeIdentity.ts`. Independent route qualification lives in `routeValidation.ts`, with version dispatch and exact export selection in `acceptedTrajectory.ts` and `src/shared/export/bdx.ts`. Keep physics validation in the worker/export boundary, off the renderer's main thread. `path-optimization.js` owns explicit candidate jobs; the project owns applied selections. A progress result is never an applied result.

## Non-blocking editor planning

Import `planPath` directly from `src/shared/planners/planPath.ts`. It wraps normal fixed-path planning and returns `{ status, trajectory, bestEffort, issues }`. An `ok` result preserves the strict planner's samples and timing. `degraded` means only display timing is available; `infeasible` means a known limit is broken or timing is unavailable. Both retain drawable best-effort samples when usable geometry is available within the sampling budget. Issues carry a path-fraction range, optional waypoint/segment and constraint values, a short message, and optional diagnostic detail.

`bestEffort` is for drawing and playback only. It can contain abrupt speed changes, and failure-path validation uses normal sample density. Neither `degraded` nor `infeasible` is an exportable result. Export continues to use the strict planner and accepted-result validation. Soft reachability is opt-in; its default behavior is unchanged.

Editable project source can contain an unfinished path with zero or one waypoint. The file codec uses `validateProjectSource` to save and recover those drafts while checking their other fields. `validateProject` and robot export still require at least two waypoints.

Soft acceleration diagnostics report the worst interval's measured acceleration and achievable limit. Their range may extend through neighboring intervals moving in the same direction on the same binding constraint; averaging across the range must not cancel the overload.

The production renderer uses this API in the editing worker, with immediate geometry updates and stale-result rejection. Editing feedback remains separate from accepted trajectory timing; applying an optimization, playback of accepted results, and export retain their exact-result ownership and strict validation.

## Verification

Run `npm test`, `npm run typecheck`, and `npm run verify:renderer`. After building the renderer, run `node scripts/verify-optimizer-ui.mjs` for the real Electron/worker workflow, including idle stability, compare/apply, persistence, stale selection, and batch staging. This runner uses an isolated profile and in-memory project storage. Tests requiring local IPC/TCP sockets need an execution environment that permits them.
