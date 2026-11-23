# Bordeaux

Electron/React desktop editor for robot paths, autonomous routines, and LabVIEW command events. Shared trajectory timing must agree across playback, routines, and export; optimization candidates are applied explicitly.

## Where to work

- `src/renderer/`: React UI, browser-domain helpers, assets, and styles.
- `src/electron/`: desktop integration, project files, robot transports, and workers.
- `src/core/`: planner, export and project logic. It builds without Node or DOM types (`tsconfig.core.json`), so it runs in Electron, the browser and Web Workers.
- `src/hosts/contract.ts`: every call the renderer makes on its host, typed once. Electron's preload and `main.ts` handlers are checked against it.
- `src/hosts/systemcore/`: the SystemCore app. `webHost.ts` answers host calls over HTTP; `server.py` (Python standard library) serves the page on port 2468 and stores project files and pushed paths under `/home/systemcore/bordeaux`. It answers only its own page (Host and Origin checks), refuses a save over source files changed on the robot, and publishes a push only after the whole reviewed batch is staged and read back.
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
- SystemCore: `npm run test:systemcore` runs the web build against a local `server.py`; set `BORDEAUX_SYSTEMCORE_URL` to check an installed robot. `npm run package:systemcore` writes `release/bordeaux_<version>_all.ipk`.

CI also certifies fields and checks licenses. Packaging/release tasks have their own gates in `docs/packaging.md`; archive large local installers recoverably rather than discarding them.

## UI changes

Follow [the UI review procedure](docs/agents/ui-review.md) for renderer changes and release sign-off. Verify the rendered workflow and representative states; passing source tests alone is not visual verification.

## Robot boundary

Saving is local and must not open a robot connection. Push is a separate, explicit action: the user reviews the robot host key and the exact files to send, and Push sends only those reviewed files. Each file is written to a temporary name, read back, renamed into place, and read back again; a failure names the files already replaced. Push never activates robot code. Local deletion must not delete robot contents, and a push must not delete or replace robot files outside the reviewed list.

Reading pushed files back (`readRobotFiles`) is the one other robot access, and it is read-only. It is an explicit action like Push, so Save and autosave stay offline. It reads `.bdx` and `.bdr` files by name from the push folder of the robot whose host key is already trusted, and leaves the robot, SSH trust and a waiting push review as they are.

## The Lab and domain guidance

Specs, implementation tickets, bugs, and feature requests use The Lab project `bordeaux` through the `lab` CLI. See `docs/agents/issue-tracker.md`. Prefix Codex CLI operations with `THELAB_AUTHOR=codex`.

The owner grants standing authorization to publish and update Bordeaux plans, reviews, and their related findings/issues in The Lab project `bordeaux`, including internal repository analysis, file/line references, and verification results. Do not request per-document approval for this workflow. See the scope and destination in `docs/agents/issue-tracker.md`; platform approval controls still apply.

Use the five canonical triage roles in `docs/agents/triage-labels.md`, preserving unrelated tags. This is a single-context repository; use `docs/agents/domain.md` for vocabulary and relevant architectural decisions.
