# Editor interactions and point links

Verified on Windows, 2026-10-25, with working changes atop `837d1df` on `fix/path-panel-bottom-spacing`.

## Behavior

- Ordinary focused buttons and library controls allow editor tool and view shortcuts. Text fields, menus, native navigation keys, and true modal dialogs retain their keyboard ownership. The endpoint-placement overlay is removed after a path has its initial points.
- Editing during playback preserves elapsed time and playback state while the path replans. The pending preview projects positions and orientation onto the edited geometry while retaining stationary-turn offsets and sample timing. A failed or empty plan clears playback; manually paused playback stays paused.
- **Link points…** in a path's library menu opens a dedicated dialog. The waypoint inspector offers the same flow through **Link points…** or **Manage links…**. Choose any source waypoint, search destinations grouped by path, and select any destination waypoint, including interior points. The review identifies the position and number of points that will move. Applying preserves each visit's heading, speed, and tangent shape. Moving a linked point then moves its group; unlink detaches the selected point. Undo restores the entire change, including links initiated from an inactive library path. Existing endpoint links remain compatible; the project schema is unchanged.
- The Windows project selector has equal four-pixel insets. Its application menu uses one panel with full-row rounded hover, keyboard navigation, and Back navigation. Commands still execute through the main-owned menu; stale, disabled, foreign-window, and already-consumed command tokens are rejected.

## Verification

- Renderer verification passed: 756,145 application JS bytes across both chunks, 215,173 worker JS bytes, 154,468 CSS bytes. The application cap is 740 KiB and CSS cap 152 KiB. This is bounded growth from the preceding UI changes; no dependencies were added and the worker cap is unchanged.
- Typecheck, Electron compilation, and license verification passed. The final focused playback, pending geometry, linking, history, library, and window-menu run passed all 184 tests across 14 files.
- `verify-editor-interactions.mjs` passed all eight size/unit/inspector combinations at 1440×900 and 1100×720. Native pointer and keyboard input cover focused shortcuts, text ownership, playback edits, link review, source selection, search, Escape, Undo/Redo, save/reopen, unlink, and inactive-path toolbar Undo. Evidence: `.ui-artifacts/interactions-20261025-verified/`.
- `verify-windows-chrome.mjs` passed against production main/preload/renderer, including rendered menu commands, offline Save, direct Alt sections, keyboard activation, real modal access, protected Reload, native caption actions, and Close. Evidence: `.ui-artifacts/chrome-20261025-final/`.
- `verify-library-ui.mjs` passed its broader library/editor checks, including scoped Undo, point linking, text and modal keyboard isolation, long names, and restore. Its old programmatic nudge helper left Save focused; the helper now selects the waypoint using native pointer input and asserts keyboard ownership before nudging. Evidence: `.ui-artifacts/library-interactions-20261025-r2/`. This remains an isolated legacy-push fixture, not a certification of production robot delivery.
- `verify-interface-workflows.mjs` passed the actual-App nonmodal updater, first field press, toolbar keyboard isolation, numeric cancellation, and routine focus checks. Evidence: `.ui-artifacts/editor-interactions-workflows-20261025/`.
- Production desktop smoke passed (`BORDEAUX_SMOKE_OK`), including restore, updater integration, local save/export, IPC boundaries, and protected close.

The parent inspected representative final link states and Windows menu captures. Independent read-only review inspected 26 final captures, including all eight link-review combinations and all 14 Windows chrome captures. It confirmed closure of two initial findings: pending trace orientation and inaccessible Undo for inactive-path links. The second review found no new P1/P2 defects and approved the bounded bundle allowances. Its two focused runs passed 179 tests; 19 unchanged CRLF-sensitive VM harness cases failed before executing their assertions.

## Limits

This is not a full Windows suite pass. Existing Windows failures involving CRLF-sensitive VM imports and platform filesystem assumptions were reproduced in an untouched baseline; no tests were disabled to conceal them. Other native platforms, OS drag/snap, Alt+Space, physical robot behavior, and native installers remain unverified. The Lab CLI is unavailable on this host, preventing publication of the review there.
