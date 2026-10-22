# Resume checkpoint — 2026-10-21

This records the user's earlier stopping checkpoint. Verification resumed at the user's request and is summarized below. This is **not release sign-off**. Nothing from this task has been pushed, opened as a PR, merged, tagged or released.

## Verification completed after resuming

Runtime code remained unchanged at `d81a50f568f90e74b39d6dd156123ddff3bee378` throughout the resumed checks.

- Independent `field-blue-origin-core-review-20261021-5` closed the last near-zero finding with no blockers: 19 focused tests and 490 in-memory checks passed. The exact 200-degree production repro retained 0.831538 seconds, 57 samples and zero angular velocity in both directions through Flip, Use normal and export. Explicit CW/CCW half-turn probes also retained their direction.
- Idle built smoke passed: `.ui-artifacts/field-smoke-resume.log`. The deadline was unchanged.
- Native coordinate workflow passed on the final code: `.ui-artifacts/field-native-resume.log`, screenshots in `.ui-artifacts/field-blue-origin-resume/`. Coverage includes pointer/keyboard Flip, invalid draft refusal, all paths/headings, Undo/Redo, save/reopen, both units and supported sizes/inspector states, inverse pointer projection, and delayed-worker protection. Parent personally inspected representative screenshots across both sizes, units and inspector states; layout is unchanged from the independently reviewed eight-image matrix.
- `projectFolderBdx.test.ts` first rerun had another Windows EPERM rename, in the serialization test rather than the prior near-limit case: 11 passed, 1 failed (`field-bdx-isolated-resume.json`). The pre-coordinate checkout at `fb96137` passed 12/12 (`field-bdx-baseline-resume.json`). The next current-code rerun also passed 12/12 (`field-bdx-isolated-resume-r2.json`). This establishes intermittency, not a proven root cause. No filesystem assertions or production writes were changed to suppress it.
- The earlier build/typecheck, 76-test final focused run, certification, license and audit evidence below still applies to the unchanged runtime code. The complete four-shard run remains 2701 passed, 8 failed, 8 skipped and predates the final clamp; it is not represented as a green current full suite. Seven failures match the historical Windows baseline; the eighth rename error passed the isolated rerun.

No independent review blocker remains. Local verification is complete within the stated scope. Full release/CI/platform validation and NI/robot execution remain separate; no publication was performed.

## Workspace and completed work

Repository: `C:\Users\zwatx\bordeaux`, branch `fix/field-notice-dismissal`.

- Local commit `8a0fdfc`: centered notice actions; success-only five-second idle expiry with hover/focus/expanded pauses, repeated-export renewal and guarded dismissal. Errors remain available for recovery.
- Local commit `5d42cbb`: integrated CI agent commit `fb96137832c6cb39d5b3af5bba56ffc57faac413`. Exact-main-SHA CI reuse, packaging parallel with CI, Electron download caches, no redundant installer compression, duplicate certification compile removed. All test/sign/notarization/asset gates retained. Parent reviewed the eight-file patch. Agent validated actionlint, build, typecheck and 43 contract tests; estimated critical-path gain ~28%, not live-measured. Isolated branch `t3/speedup-ci-prereleases` remains recoverable.
- Current checkpoint: fixed blue-origin meters, physical all-path Flip, original image retained and calibrated, migration/recovery/import/export compatibility, regression fixtures and native verification. See `docs/field-coordinates.md` for contracts.

The user's explicit Flip choice is **move paths to the opposite alliance and change saved coordinates**, not merely rotate the view. Keep the original map; they preferred its look. Original raster and v1 corpus/binary fixtures are unchanged. New v2 corpus and blue-origin binary fixtures have independent hashes and `.gitattributes` byte preservation.

## Important implementation details

`flipField.ts` rigidly rotates waypoints, handles, headings, targets and look-at points. It reconstructs generated route semantics through `routePlanningPath`, retaining generated-knot placeholder theta. Current applied selections require full original qualification. The existing planning worker handles `mode: 'flip'`, validates the original and transformed applied results, and returns the project. App guards the asynchronous response against intervening edits and repeats strict draft preflight before committing one project-wide Undo entry. Do not pull full planners into the UI bundle.

Shared angle handling preserves signed authored moving half-turns, including nonzero degree offsets. Stationary shortest half-turns use a representation-independent counterclockwise tie; explicit CW/CCW overrides it. The latest review found directional expansion could turn near-zero roundoff into a full revolution. **The final change clamps wrapped deltas below 1e-9 before expansion.** Production planner/export regressions cover both directions, accepted Flip followed by Use normal, six manual offsets, and line/Bezier automatic U-turns with applied v1/v2.

Legacy recovery envelopes preserve their historical digest. A main-owned WeakMap binds `prepareRestore`'s actual provenance object to the migrated editor digest; saving that exact copy resolves its old receipt, while saving an edited copy preserves the original recovery. No renderer-supplied digest gains authority.

Legacy project migration rotates both raster axes into blue origin, with old dimensions rescaled. The synthetic v2 semantic benchmark conversion instead reflects X while preserving named portal ownership/guardrail lanes, with an explicit neutral-slalom contraction for full-depth clearance. These are intentionally different contracts. Canonicalize project fixtures with production `encodeProjectFile`, not Python JSON alone; linked-handle normalization changes tiny numeric details. Do not regenerate historical fixtures.

## Verification retained locally

Ignored `.ui-artifacts/` contains reports, logs and screenshots. Final build and typecheck after the near-zero clamp passed:

- `field-build-final-approved.log`: renderer app 738,242 B, worker 211,818 B, total JS 950,060 B; Electron build passed. Bounded caps: app 722 KiB, worker 207 KiB, CSS 146 KiB.
- `field-typecheck-final-approved.log`: passed.
- `field-angles-final.json`: **76 passed, 1 skipped, zero failed**, including final near-zero fix, coordinate regressions, route heading semantics, worker and stationary-action scaling.
- `field-uturn-r11.json`: 40 passed before final near-zero clamp.
- `field-recovery-r10.json`: 90 passed, one unchanged Windows permission-bit assertion failed (`projectRecoveryStore.test.ts:54`). Both new exact/edited legacy recovery resolution cases pass.
- `field-canonical-fixtures-r9.json`: 89 passed, including corpus digest/normalization, fixed/corridor benchmarks, binary fixtures, headings and CI contracts.
- License, field certification and high-severity audit gate passed. Audit has existing moderate findings; no dependency changes made.

Latest complete four-shard unit run: `field-shard-{1,2,3,4}-final.json`, **2701 passed, 8 failed, 8 skipped**. It predates only the final near-zero clamp and its two added regressions; final focused coverage above passes. Seven failures have identical names in the pre-task baseline logs `$env:TEMP/bordeaux-command-tests.log` and `bordeaux-tests-final.log`:

1. `agentSession.test.ts`: Windows `.sock` EACCES.
2. `choreoAdapter.test.ts`: Windows CLI invocation shape.
3. `projectCreation.test.ts`: parent replacement wording.
4. `projectFiles.test.ts`: case-only rename fault injection.
5. `projectRecoveryStore.test.ts`: POSIX mode mask on Windows.
6. `projectsDialog.test.js`: Windows row identity expectation.
7. `projectWriteErrors.test.ts`: Windows ENOENT versus ENOTDIR.

The eighth is **not yet classified**: `projectFolderBdx.test.ts`, “generates nothing when its ownership records would overfill a near-limit workspace”, EPERM during a temporary-file rename under parallel load. Rerun it in isolation before classifying. Do not suppress or weaken assertions. Earlier full-suite reports `field-tests-final.json` and `field-tests-r8.json` span implementation/fixture edits and contain mixed-version failures; they are not final evidence.

Native UI:

- `field-native-r7.log`: all notice behavior passed; later concurrency test failed due harness retaining an input ID across reload. The harness now resolves the current input.
- `field-native-r8.log` and `field-native-r11.log`: coordinate flow passed, including native pointer/keyboard Flip, invalid draft protection, all paths/headings, exact Undo/Redo, save/reopen, two flips, both sizes/inspector states and units, inverse imperial pointer placement, and a delayed Flip after an intervening edit.
- Latest field screenshots: `field-blue-origin-original-20261021-r11/`. Earlier r8 matrix was personally inspected by parent and independent reviewer; layout unchanged in r11.
- Fresh expiry image: `field-blue-origin-original-20261021-r7/export-success-expired.png`. Parent and independent reviewer confirmed no notice remains. Capture now waits two RAFs plus 100 ms to avoid stale compositor frames.
- `field-smoke-r8.log` passed before the last math/recovery changes. The latest `field-smoke-final-current.log` completed every smoke result assertion but exceeded the unchanged 30-second process deadline while all four unit shards ran. **Rerun smoke on an idle machine**; do not raise the deadline to hide this.

No NI command execution, robot operation or native release/package verification occurred for the new frame. Binary round trips are software evidence, not NI certification.

## Independent review history and remaining work

All reviews are read-only T3-owned child tasks. Every follow-up round must call `delegate_task` again with original brief, findings and response; do not message a `childThreadId` to start another review. Current provider/model/options: `codex`, `gpt-6.1-sol`, `{reasoningEffort:'high', serviceTier:'default'}`. Discover live capabilities before choosing options.

- `field-blue-origin-core-review-20261021-1`: generated-knot and half-turn blockers, fixed.
- `...core-review-20261021-2`: nonzero manual half-turn and rejected-artifact promotion, fixed.
- `...core-review-20261021-3`: tangent U-turn and historical recovery resolution, fixed.
- `...core-review-20261021-4`: confirmed both prior fixes and found near-zero directional expansion. That final fix now passes 76 focused tests but **has not received independent closure**.
- `field-blue-origin-ui-review-20261021-final`: inspected 21 PNGs, no rendered blocker; requested fresh expiry capture.
- `field-blue-origin-ui-review-20261021-closure`: personally inspected fresh expiry plus all eight r8 field shots, closed evidence gap, no rendered blocker. Read delayed-worker concurrency assertions and logs.

Task ID prefix for those reviews is:
`node:delegated-task:command%3Amcp%3A1241bfcf-4f33-43b9-ba3f-f4bfba628e4e%3Adelegate-task%3A`
followed by the task name above (without literal ellipses for core rounds).

Resume priorities:

1. Obtain a narrow independent closure on the final near-zero clamp, supplying all prior findings and fixes. Do not reopen already settled design questions.
2. Rerun `projectFolderBdx.test.ts` alone, and built smoke while idle. Recheck coordinate-only native flow after the final clamp if needed: `BORDEAUX_FIELD_COORDINATES_ONLY=1` with a fresh `BORDEAUX_PLANNING_RECOVERY_UI_OUTPUT`. Default CI omits this flag and exercises the whole recovery/notice harness.
3. If release sign-off is requested, run current full checks against the frozen source, retain exact Windows limitations, and obtain required rendered/release evidence. No test assertions or security/package gates should be weakened.
4. Finish a concise delivery report. The latest user request is to stop; do not push/PR/merge/release merely to finish this checkpoint.

All child tasks have completed. No PR watcher is active for this work. The Lab CLI was unavailable earlier; no tracker publication was made. Existing PRs #91–93 are historical and unrelated to the current local checkpoint.
