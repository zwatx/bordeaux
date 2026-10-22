# Windows chrome implementation handoff

Based on `8e8d58b`. Windows uses a 36px custom title bar with narrow, sender-validated window actions and main-owned native submenus. macOS keeps its native menu and hidden-inset traffic lights. Renderer integration is confined to `main.tsx`; no edits to App, Panels, ProjectChip, Routine components, or app.css.

Windows minimum content is 1100×756: title bar plus the existing 1100×720 editor. Native outer minimums include any frame/content difference. Main owns minimize, maximize/restore, fullscreen exit, close, menu definitions, and accelerators. Close invokes the existing project-departure lifecycle; Save remains local. The title bar marks `data-native-chrome` for the parent’s capture-phase playback-shortcut exclusion.

## Verification

- Raw renderer and Electron builds and typecheck passed. Five IPC/window-state tests and nineteen project-native-departure tests passed (24 total).
- A broader follow-up found the three `projectNativeWindow` extracted-function fixtures lacked the new helper binding. Their sandbox now includes the actual helper; the parent should rerun these with the combined changes.
- Production main/preload/renderer run `.ui-artifacts/windows-chrome-final/result.json` records passing pointer minimize/maximize/restore, external maximize synchronization, Space/Enter caption activation, keyboard/pointer/Alt+F native menu opening, Ctrl+S dispatch after focus, offline Save, and custom Close through production departure, with zero forbidden robot calls.
- Personally inspected final `editor-1440x900.png`, `editor-1100x756-minimum.png`, `editor-content-1100x720.png`, and `maximized.png` in that directory. Two independent read-only reviews found no confirmed product/security blocker. The final review confirmed readable chrome and preserved editor geometry.
- The native run closed the real window successfully but its wrapper waited for application quit. The retained harness now exits its test-owned process after the real window closes; that teardown adjustment requires a parent rerun. Application quit cleanup is outside this harness; use the existing update/quit harness for that flow.
- `npm run build` / `verify:renderer` remains failing at the unchanged size gate: aggregate application JS 742,627 / 739,328 bytes; CSS 150,411 / 149,504 bytes. The parent owns the combined documented allowance.

Rerun on Windows, in a sequential foreground slot, after raw renderer/Electron builds: set `BORDEAUX_CHROME_UI_OUTPUT` to a fresh absolute directory, then run `node scripts/verify-windows-chrome.mjs`. It creates its own source/profile, uses scale factor 1 for exact screenshots, and does not replace the installed application. Linux CI skips the Windows native harness and still runs the IPC contracts.

Native popup Escape/selection, OS-level accelerator input, drag/snap, Alt+Space, other workspaces, expanded inspectors, and macOS native behavior remain manual/integration coverage limits. Earlier failed attempts remain under `.ui-artifacts/windows-chrome-1` through `-8`; they are not final sign-off. No NI API, robot connection, push, release, or installer action was performed. The final retained harness sends no OS-global input.
