# Bordeaux

Electron/React desktop editor for robot paths, autonomous routines, and LabVIEW command events. Shared trajectory timing must agree across playback, routines, and export; optimization candidates are applied explicitly.

## Where to work

- `src/renderer/`: React UI, browser-domain helpers, assets, and styles.
- `src/electron/`: desktop integration, project files, robot transports, and workers.
- `src/core/`: planner, export and project logic. It builds without Node or DOM types (`tsconfig.core.json`), so it runs in Electron, the browser and Web Workers.
- `tests/` and `benchmarks/`: correctness, integration, and planner validation.
- `docs/trajectory-optimization.md`, `docs/labview/index.md`, and `docs/packaging.md`: task-specific workflows.

## Local commands

Use Node.js >=22.12 and npm.

- `npm install`
- `npm run dev` (builds before starting Electron).
- `npm test`
- `npm run typecheck`
- `npm run build`
- Desktop smoke check: `env -u ELECTRON_RUN_AS_NODE npm run test:smoke`.

CI also certifies fields and checks licenses. Packaging/release tasks have their own gates in `docs/packaging.md`; archive large local installers recoverably rather than discarding them.

## UI changes

Follow [the UI review procedure](docs/agents/ui-review.md) for renderer changes and release sign-off. Verify the rendered workflow and representative states; passing source tests alone is not visual verification.

## Robot boundary

Saving is local and must not open a robot connection. Push is a separate, explicit action: the user reviews the robot host key and the exact files to send, and Push sends only those reviewed files. Each file is written to a temporary name, read back, renamed into place, and read back again; a failure names the files already replaced. Push never activates robot code. Local deletion must not delete robot contents, and a push must not delete or replace robot files outside the reviewed list.

## The Lab and domain guidance

Specs, implementation tickets, bugs, and feature requests use The Lab project `bordeaux` through the `lab` CLI. See `docs/agents/issue-tracker.md`. Prefix Codex CLI operations with `THELAB_AUTHOR=codex`.

The owner grants standing authorization to publish and update Bordeaux plans, reviews, and their related findings/issues in The Lab project `bordeaux`, including internal repository analysis, file/line references, and verification results. Do not request per-document approval for this workflow. See the scope and destination in `docs/agents/issue-tracker.md`; platform approval controls still apply.

Use the five canonical triage roles in `docs/agents/triage-labels.md`, preserving unrelated tags. This is a single-context repository; use `docs/agents/domain.md` for vocabulary and relevant architectural decisions.
