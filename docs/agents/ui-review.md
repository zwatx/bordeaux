# UI review before shipping

For renderer changes, review the affected workflow in the built app before calling it complete. Passing source assertions, line-box measurements, and the desktop smoke test do not establish visual quality. The owner should not be the first person to see the changed screen.

## Product conventions

- Use sentence-case labels. Distinguish groups with spacing and weight; avoid uppercase microheaders, repeated badges, and nested containers that do not help a decision.
- Keep primary item names readable. Move secondary metadata below a name or allow wrapping before truncating it. A tooltip does not replace a usable label.
- Align shared content and action columns. Reserve action space so hover, selection, and async values do not move labels. Inspect visible text, not only bounding boxes.
- Give each action one predictable meaning. Plain selection must not delete objects. Shift-click explicitly deletes authored field and outline features; library Shift selection remains a range gesture. Create spatial features through deliberate placement on the field.
- Keep ordinary successful background work quiet. Separate loading, failure, and ready states; errors get one explanation and a usable recovery action.
- Show units consistently wherever the same quantity appears. Convert at the display/input boundary, preserving canonical stored values.
- Reuse the existing menu, dialog, row, and field patterns. Check their actual token definitions and keyboard behavior before introducing another variant. Buttons come in three tiers defined once in `app.css`: secondary (`.qbtn`), `.primary` for the single commit on a surface (rightmost in dialogs, an inverted light surface with dark text), and `.quiet`/`.delbtn` for low-emphasis and destructive actions. The chrome has no hue: brightness and a neutral surface (never a weight change) mark the current object and place, a near-white ring marks keyboard focus, and hover stays neutral. Color is reserved for meaning (alliance, zones, commands, problems, path speed, save and push outcomes).
- The toolbar reads project · places (Paths, Routines, Settings) · the place's actions · robot (destination or last result, then Push). Push is a neutral bordered button whose label is its exact scope; the library edits which paths it sends.
- Components imported by `App.jsx` load their stylesheets before `app.css`, while some harnesses load them after. Keep shared rules in `app.css` so both orders render the same.
- Preserve the robot boundary: local Save, explicit scoped Push, immutable revision review, and verified acceptance remain distinct.

## Verification for a UI change

1. Build the renderer with `npm run verify:renderer` and run the focused behavior tests appropriate to the change.
2. Inspect affected screens at 1440×900 and the native minimum 1100×720, with inspector open and closed where applicable. Below-minimum experiments are useful but do not replace supported-size checks.
3. Exercise representative data: long names, multiple digits, badges, expanded sections, a populated routine branch, and both unit systems. Include empty, pending, failure, disabled, and restored-project states where affected.
4. Use real pointer and keyboard input for the changed interaction: Tab, Enter/Space, Escape, applicable arrow keys, focus return, and selection modifiers. Programmatic `.click()` alone does not prove keyboard or pointer behavior.
5. Capture and personally inspect the final rendered result after the last relevant edit. Ensure text/actions are readable and reachable, metadata does not collide, and ordinary work does not accumulate banners.
6. For a changed flow or shared UI primitive, obtain an independent read-only review. Report exact coverage and limitations; do not imply untested platforms, hardware, or states passed.

Existing local harnesses:

- `node scripts/verify-interface-ui.mjs`: shared dropdown search/custom values, keyboard navigation, numeric cancellation, one-change label scrubs including focused fields with Tab, Save, repeated focused scrubs, and cancellation, Enter during a captured scrub deferring to release (one change) or Escape (no change), text and command draft ownership, viewport bounds, and reduced motion. It fails early if the window loses native focus (a lost focus blurs drafts and withholds focus events); rerun it in the foreground rather than treating that as a product result.
- `node scripts/verify-interface-workflows.mjs`: constraint-bar press stability, toolbar shortcut isolation, exact robot numeric cancellation, routine focus return, and timeline keyboard focus. Run foreground workflow harnesses sequentially so another Electron window cannot steal native focus.
- `node scripts/verify-command-branches-ui.mjs`: command output selection, Boolean/named/numeric routes, nested steps, typed comparison editing, missing outputs, and save/reload using a mocked NI catalog.
- `node scripts/verify-routine-workspace-ui.mjs`: the built Routine workspace at both supported sizes, with nested branch/repeat flow, long names, both unit systems, preview notes, keyboard and pointer insertion, Escape focus return, exact Undo, local save/reopen, missing catalog conditions and empty states. Set `BORDEAUX_ROUTINE_UI_OUTPUT` to a fresh evidence directory. Uses an isolated profile and mocked catalog; it does not certify robot execution.

- `node scripts/verify-labview-project-ui.mjs`: actual ProjectChip, lazy Sources dialog and existing command controls: Link/Change/Refresh callbacks, loading/failure states, visible recent-folder metadata, source pagination/search, Escape and focus return through native input. Windows/Mac platform labels and callbacks are component fixtures, not full-App, operating-system or NI verification; run it in the foreground.
- `node scripts/verify-project-folder-ui.mjs`: project chip menu keyboard use, Projects sheet folder selection/cancel and open failure/Retry, recent opening by stable ID, the New project sheet (default home, name collision, template), a real read-only folder failure shown as its plain fact with chip Retry by pointer and keyboard, BDX cause and partial-write retry, autosave error retention, and explicit legacy file command using mocked filesystem dialogs.
- `node scripts/verify-library-ui.mjs`: paths, routines, settings, surface-scoped Undo, undoable path and folder deletion that keeps later library work, linked restoration blocked by newer neighbor edits, divider geometry, Push reachability and project chip Retry (pointer and keyboard) at the minimum height including a valid 5000-character name through save/reload (library rows clamp to two lines and Push keeps its one-line scope label with the full name as its title) with a bounded, wheel-scrollable inspector title, topmost close button, reachable Swap start/end and tool-rail Place waypoint, and pointer close with keyboard reopen, Undo of an applied robot profile proposal that keeps later Settings notes typed with real keyboard input through Redo, save, and reload (including a verified Backspace fallback when select-all does not select the fixture text), and mocked legacy push integration. This harness builds the current App with an explicit Vite alias to the retired revision controller/dialog; it does not certify the shipping direct-file push flow.
- `node scripts/verify-robot-push-ui.mjs`: isolated legacy mocked activation controller transitions (retired revision delivery, excluded from the shipping renderer).
- `node scripts/verify-robot-file-push-ui.mjs`: shipping direct-file controller/dialog: SFTP connection, SSH identity, immutable file review, upload/readback success and failure, and diagnostics focus return using mocked transport.
- `node scripts/verify-optimizer-ui.mjs`: optimizer comparison, exact apply/save/reload timing, units, keyboard reorder, and current-normal routine fallback.
- `node scripts/verify-planning-recovery-ui.mjs`: usable failure details and limit editing, final-planning timeout with Try again, blocked stale geometry/playback, combined acceleration, folder titles, and autosave focus.
- `node scripts/verify-update-quit.mjs`: production window/quit cleanup with unsaved edits and a controlled installer handoff; no native installation.
- `node scripts/verify-range-limits-ui.mjs`: zone add/remove, exact metric/imperial values, save/reload, keyboard focus, field Shift-delete of commands and zones with a focused name draft, and open/closed layouts at both supported sizes.
- `node scripts/verify-app-updates-ui.mjs`: update notes, fixed panel dimensions, progress, cancellation, retry, installation with unsaved edits, stalled-restart recovery, keyboard access, and focus return with mocked updater states. Mac/Windows fixtures do not verify native installers.

Use isolated fixtures and mock robot transports for UI checks. Report a failing check as failing. Do not weaken assertions to get a green result; distinguish an obsolete expectation from a product regression using code and rendered behavior.

## Release evidence

Before a production release, review the whole screen/state matrix: path summary and each feature inspector; routine flow, branch editing and playback; settings and custom footprint; optimizer idle/running/result/failure; connection identity review, push review, upload, acceptance/unconfirmed/rejected outcomes; project open/save and diagnostics.

Record the commit plus any working-tree changes, sizes, screenshots inspected, commands/results, blocking findings, and reviewer. A UI-affecting change after this review requires rechecking the affected states.

Do not sign off with unresolved unintended destructive gestures, incorrect displayed units, inaccessible primary actions, clipped essential content, or failure states presented as indefinite loading. Track lesser consistency issues explicitly.

CI runs these UI harnesses under Xvfb in parallel `desktop` groups and uploads each group's screenshots and results as `ui-verification-<group>`, including artifacts from failed checks. Add a new harness to the group in `.github/workflows/ci.yml` that keeps the group durations balanced. Local runs use isolated temporary directories; set `BORDEAUX_LIBRARY_UI_OUTPUT`, `BORDEAUX_OPTIMIZER_UI_OUTPUT`, or `BORDEAUX_PUSH_UI_OUTPUT` to retain evidence at a chosen location. Use a fresh directory to avoid reusing test preferences. Screenshots still require human or agent visual inspection; passing automated checks alone is not a visual sign-off.
