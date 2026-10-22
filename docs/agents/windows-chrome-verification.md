# Windows toolbar chrome handoff

Based on `e9d8a9f`. Windows uses the existing 44px editor toolbar for one compact Application menu button and minimize, maximize/restore, and close controls at its far right. There is no brand, title text, visible File/Robot/Agents/View/Help row, or extra title strip. Content starts at 1440×900 with a 1100×720 minimum; native outer minimums include the frame/content difference. macOS retains its native menu and traffic lights.

`WindowsTitleBar` stays mounted outside App and its error boundary. Its controls render into the document body, or into the active native modal so the modal top layer does not make them inert. The overlay is fixed to the viewport and reserves 190px in the Windows toolbar (182px of controls plus 8px clearance). Scoped rules cancel the containing modal's entrance animation: its temporary transform/opacity would otherwise clip or hide the controls. Startup uses a 44px toolbar too. Parent-owned dialog copy, App, Panels, ProjectChip, project.css and app.css are unchanged by this handoff.

Main owns the actual application menu and all command callbacks/accelerators. The new allowlisted `application` menu ID opens that menu directly. Existing submenu IDs retain Alt+F/R/A/V/H. F10 focuses the Application button; Enter, Space and Up/Down open it, and Escape returns to the prior focus after native popup dismissal. Modal sheets retain their ordinary keyboard behavior. The controls retain `data-native-chrome` for playback-shortcut exclusion.

Sender/main-frame/platform guards, the initial state snapshot and live updates, graceful `window.close()`, and captured live-webContents cleanup remain intact. Save still uses the main-owned local save callback; no renderer menu definitions or robot connections were introduced.

## Verification in the isolated worktree

- `node node_modules/vitest/vitest.mjs run tests/windowChrome.test.ts tests/projectNativeWindow.test.ts tests/projectNativeDeparture.test.ts`: 30 tests passed. Coverage includes the actual application-menu object, shared popup admission, frame/sender/platform rejection, actions and graceful close, minimum-size frame compensation, destroyed-window cleanup, extracted production window sizing and project departure.
- `npm run typecheck`: passed.
- `npm run build:electron`: passed.
- `npm run build`: passed (renderer gate and Electron build together).
- `npm run verify:renderer`: passed with unchanged budgets: 742,562 B application JS / 211,818 B worker JS / 151,514 B CSS (CSS ceiling 151,552 B).
- `node --check scripts/verify-windows-chrome-electron.cjs`: passed.
- Existing checkout dependencies are reused through an ignored worktree-local `node_modules` junction. No application installation, NI API, robot connection, push, release or PR operation was performed.
- After the parent explicitly released the sequential foreground slot, the isolated native run passed: `.ui-artifacts/windows-toolbar-isolated-1/result.json` and `result-process.json` record all 14 checks passing, exit 0 and no timeout. `BORDEAUX_CHROME_ISOLATED_BASE=1` excluded only the parent-owned tab-centering assertion. All native menu/control/state/Save/Reload/Close checks ran. The test window closed normally; installed Bordeaux was untouched, and the foreground slot was released.
- Personally inspected all six native screenshots: startup, 1440×900, 1100×720, maximized, Keyboard shortcuts modal and reloaded 1100×720. The controls occupy the existing row, stay readable above the modal and leave the supported editor height intact. Tab placement in these images is the unchanged isolated base.
- Native stderr retains two `project:transitionBegin` / `A project departure is already pending` rejections while Reload/Close complete. The inherited App transition code catches that rejected admission and continues the main-owned departure checkpoint; this handoff does not change that path. Integrated review should retain and assess these logs.

## Parent integration on 2026-10-22

Integrated as `e161ba8`, with the parent's concise copy and project-status changes, then fingerprint failure draining at `60ae102`. `.ui-artifacts/integrated-toolbar-final-r2` records all 14 checks passing, process exit 0 and no timeout. Ten production images cover startup, Paths at both supported sizes, Routines and Settings at both sizes, maximized, Keyboard shortcuts and reload. Labels are centered within their own tabs; the nav group stays beside the project divider across pages. The separate title strip is absent.

Parent build/typecheck passed. Aggregate renderer sizes are 741,146 B application JS / 211,818 B worker JS / 150,964 B CSS, within unchanged ceilings. Native pointer/keyboard checks cover the Application menu, direct Alt submenus, local Save, min/max/restore and external state changes, caption Space/Enter, modal/inert-editor access, Reload and real Close. No installed app, NI instance or robot was used by these harnesses.

Retained failed runs are harness failures: an obsolete viewport-centering expectation, then an old native menu reference after autosave rebuilt the menu. Final checks measure each label's text, obtain fresh menu references, and preserve the same product assertions. Native-popup dismissal is programmatic; OS popup selection/dismissal, drag/snap, Alt+Space, fatal rendering and actual macOS remain unverified.

## Repeating native integration

The parent owns the sequential foreground slot and has the installed application open. The isolated native check passed only after the parent granted that slot; the combined UI still requires integration sign-off. After merging the parent's toolbar/tab layout changes and this commit, build both outputs, set `BORDEAUX_CHROME_UI_OUTPUT` to a fresh absolute evidence directory, and run `node scripts/verify-windows-chrome.mjs` in that slot. Do not run it concurrently with another GUI harness. Leave `BORDEAUX_CHROME_ISOLATED_BASE` unset for the integrated run so tab centering remains required.

The production main/preload/renderer harness asserts one 44px toolbar, exact 1440×900 and 1100×720 content, no brand/menu row, text centered in each tab, toolbar controls within bounds and clear of caption controls, and matching native minimums. Leave `BORDEAUX_CHROME_ISOLATED_BASE` unset for the combined layout.

It prepares screenshots and native input checks for startup controls, Application by pointer/F10/Tab/arrows/Enter/Space, direct Alt submenus, offline Save, pointer minimize/maximize/restore, external state synchronization, keyboard caption activation, a real Keyboard shortcuts modal, an explicitly inert editor, protected main-owned Reload and fresh state subscriptions, and real Close while a modal is open. The test-owned process exits only after the production window closes.

The parent must run and personally inspect the integrated screenshots and obtain the independent read-only UI review required by `ui-review.md`. Fatal rendering and departure/error/pending sheets still need integration inspection; the component remains outside the error boundary and ports controls into native modals, but these states have not been exercised visually in this revision. Native popup Escape/selection, OS-global accelerator input, drag/snap, Alt+Space, expanded inspectors, other workspaces and macOS native behavior remain manual/integration limits. Use `verify-update-quit.mjs` for application-quit cleanup; it is outside this harness.

Previous 36px-strip screenshots/results describe the superseded layout and do not verify this redesign.
