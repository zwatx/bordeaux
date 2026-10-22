# Toolbar, copy and command-refresh verification

2026-10-22, branch `feature/command-driven-decisions`, production source at `60ae102`, based on `e9d8a9f`. Followup harness corrections update old copy expectations and exercise tab text alignment and fresh native menu references; they do not change production behavior.

## Result

Saved projects show their name only. Changes show a plain asterisk alongside the name, including during writes; save/recovery and BDX failures remain visible. Tab labels are centered within equal tabs while project and navigation geometry stays stable across pages. Windows uses one 44px toolbar with Application and caption controls at its right, without a branded title strip. Push, updater, diagnostics and routine explanations use brief copy; complete push failures remain under Details. Local Save and explicit scoped Push retain their separate boundaries.

Command fingerprinting uses up to eight simultaneous local reads, deterministic output and snapshot-local deduplication. Each validation still reads fresh bytes and checks declarations, source/dependency changes and local-path rules. On failure, workers stop scheduling, drain started reads and propagate the first error before a retry can begin. Live authority and saved-cache restrictions are unchanged.

## Evidence

- Focused integrated suite: 316 passed, one skipped across 32 files (`.ui-artifacts/integrated-copy-tests.log`). NI/sync/discovery/wrapper suites: 56 passed, one skipped (`command-refresh-drain-tests.log`). Independent fingerprint closure: 27 passed, no blockers, at `60ae102`.
- Typecheck and full build passed. Renderer: 741,146 B application JS, 211,818 B worker JS, 150,964 B CSS; unchanged ceilings.
- `project-star-centered-r2`: eight native component scenarios passed, both sizes, including long-name star, quiet saved/busy states, failures, menus and centered tab text. Windows/macOS labels here are fixtures.
- `integrated-toolbar-final-r2`: 14 production Windows checks passed, exit 0 without timeout. Ten images cover startup, both supported sizes and all pages, maximized, Keyboard shortcuts and reload. Caption/menu pointer and keyboard behavior, local Save, state synchronization, modal access and Close passed.
- `concise-push-final`: 18 mocked shipping-flow cases passed, including immutable scoped review, upload/readback, identity failure, short error/full Details, native input, retries and long content at both sizes. `concise-updates-final`: all four platform/size fixture cases passed.
- `concise-routines-final-r3`: both supported-size native scenarios passed, exit 0, no timeout, matching before/after source/build/harness hashes. Preview boundary, legacy saved references, unsupported definitions, command-output repeats, offline Wait, insertion, Undo and save/reopen remain covered.
- Built desktop smoke passed with `BORDEAUX_SMOKE_OK`, including invalid-draft close blocking and exact-source close receipt (`toolbar-final-smoke.log`). Expected unavailable-NI export diagnostics and rejected duplicate transition admission remain in the log; neither prevented successful local source saving or closure.
- Parent personally inspected final project saved/changed, toolbar Paths/Routines/Settings/modal, Push review/success/failure/expanded Details, update recovery, routine preview notes/unsupported definition/dynamic-repeat images. Supported content sizes are 1440×900 and 1100×720; high-DPI component PNG dimensions may be larger.

Paired benchmark (`command-refresh-paired.json`): same 400-VI / 12.5 MiB fixture, eight alternating baseline/current passes, warm filesystem and mocked NI. Median fingerprint validation fell from 439.44 ms to 86.82 ms; discovery plus validation from 725.00 ms to 315.60 ms. This measures local validation, not cold filesystem or actual NI latency.

## Retained failures and limits

Two earlier routine runs expected superseded copy; final assertions retain the runtime-unavailable requirement using the current text. Earlier Windows runs used an incorrect viewport-center expectation and a stale native menu reference after autosave; final checks measure text within tabs and retrieve the current menu. Those failed artifacts remain retained.

No live NI/LabVIEW, robot or real transport operation was performed. Native popup OS selection/dismissal, OS drag/snap, Alt+Space, fatal rendering and actual macOS remain unverified. Routine desktop playback remains a preview: commands and conditions do not execute, and a shipping robot routine adapter is still unavailable. This document is local-build verification, not whole-suite or production-release certification. The Lab CLI is unavailable locally; no publication there is claimed.
