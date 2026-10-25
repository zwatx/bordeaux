# Editor spacing, robot status, and update popover

Base: `d5b03c0` (0.2.0-beta.23). Verification covers the working changes on `fix/path-panel-bottom-spacing` on Windows, 2026-10-24.

## Behavior

- The smallest path dock is 252 px. Its path summary fits the shared 32 px Add zone button with 15 px of visible bottom clearance and no scrolling.
- macOS traffic lights move from y=18 to y=15 to align their centers with the 44 px toolbar. This native adjustment needs a Mac check; the Windows host cannot render AppKit controls.
- Saved SSH trust is separate from live reachability. Restoring an address and saving settings stay offline. Explicit Connect or a verified upload starts read-only checks, five seconds apart, with a five-second connection deadline. Failed checks clear green; successful checks can recover it. A check never changes trust or invalidates an immutable upload review. Operation generations discard replies superseded by a newer upload or destination.
- Updates use a 420×520 px maximum popover, with the version, scrollable release notes, progress, and actions. Outside clicks dismiss it and reach the editor; Escape restores focus. Native modal guards distinguish the popover from blocking dialogs. Only the approved install handoff blocks editing; stalled-install recovery still requires main-process acknowledgment.

## Evidence

- Renderer build/verification: 749,566 application JS bytes, 215,173 worker JS bytes, 151,119 CSS bytes. The application allowance increases from 730 to 732 KiB for live status and nonmodal updates; all chunks remain counted. Worker, CSS, and package allowances are unchanged.
- Typecheck and Electron compilation passed.
- Focused controller, transport, delivery, update, command, waypoint-focus, problem-selection, playback, window-chrome, and library tests: 217 passed.
- Production built-app smoke: passed (`BORDEAUX_SMOKE_OK`), including native updater IPC and the visible nonmodal popover. An earlier concurrent run produced successful UI results but exceeded the unchanged 30-second process deadline; the isolated rerun completed successfully.
- `verify-app-updates-ui.mjs`: all four 1440×900 / 1100×720 and Mac/Windows fixture combinations passed. Covers safe long/short notes, fixed layout, download progress/cancel/retry, outside-click focus ownership, Escape/Tab/Enter, unsaved install, and stalled restart. Final screenshots: `.ui-artifacts/updates-20261024-reviewed/`.
- `verify-interface-workflows.mjs`: passed. Uses the actual built App to verify first-press field selection and editor tool shortcuts while updates are open, then the existing path/Settings/routine focus workflows. Evidence: `.ui-artifacts/editor-updates-20261024-final/`.
- `verify-robot-file-push-ui.mjs`: 19 passed, including a failed live check removing green without discarding the successful push receipt, and a reconnect action. Uses mocked SSH/file transport. Evidence: `.ui-artifacts/robot-liveness-20261024/`.
- Built-App layout checks: both supported sizes, metric/imperial, inspector open/closed; all eight summaries have 15 px clearance and no scroll. Real pointer Add zone succeeds. Evidence: `.ui-artifacts/layout-20261024-verified/`.

The parent personally inspected the update available/downloading/up-to-date layouts and the minimum-size metric/imperial dock with inspector open/closed. Independent review inspected all 40 update screenshots and caught two issues: nonmodal editor guards and stale liveness evidence. Both have regression coverage and fixes. The second review confirmed both closures, found no new blockers, and personally inspected 28 final captures spanning all eight dock combinations, updater states, disconnected/successful robot states, and the actual-App editor test.

## Limits

The full local Windows suite has preexisting failures involving Unix socket paths, POSIX permission bits, case-insensitive rename assumptions, home-path display, and CRLF-sensitive VM harness import stripping. Representative failures were reproduced in an untouched `d5b03c0` checkout at `.scratch/windows-baseline/`; this is not a full-suite pass. No tests were disabled or assertions weakened to conceal those failures.

Native macOS traffic lights, physical robot disconnects, and native installer execution remain unverified. The Lab CLI is unavailable on this host, so these findings could not be recorded in The Lab.
