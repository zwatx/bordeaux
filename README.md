# Bordeaux

Bordeaux is a lightweight desktop editor for authoring robot paths, autonomous routines, and robot command events. Normal trajectories use shared physics-aware timing and need no optimizer. Optional per-path optimization searches for faster geometry through the required waypoints, headings, and stops, checking the robot footprint against the field; compare the candidate and apply it to select the exact trajectory used by playback, routines, and export. See [trajectory optimization](docs/trajectory-optimization.md).

Bordeaux is a LabVIEW-only planner. Link a `.lvproj` to discover commands and their parameters, then export a selected path as a `.bdx` binary. The [binary contract](docs/labview/binary-format.md) defines the file layout and robot-code boundary.

## Develop

Requirements: Node.js 22.12+ and npm.

```text
npm install
npm run dev
```

The renderer source lives in `src/renderer` and builds with Vite to `dist-renderer`. `main.tsx` mounts the React application, feature components live under `components`, browser-side domain helpers under `lib`, and static resources under `assets` and `styles`. Renderer modules use explicit imports; no ordered scripts or application globals are required. Electron and shared planner code also live in `src`.

## Verify

```text
npm test
npm run typecheck
npm run build
env -u ELECTRON_RUN_AS_NODE npm run test:smoke
```

Run `npm run verify:package` after producing an unpacked package. Release tags must match `package.json`; CI enforces this with `npm run verify:release-tag`.

Large local installers should be archived outside the worktree instead of discarded. See [local artifact hygiene](docs/packaging.md#local-artifact-hygiene) for recoverable archive/restore commands and safe Git cleanup boundaries.

Installed GitHub builds update on version-derived beta or production channels; Microsoft Store builds use Store-managed updates. See [desktop packaging](docs/packaging.md) for release workflows and signing requirements.

## LabVIEW integration

Choose a `.lvproj` or its containing folder. Project discovery reads project XML; NI inspection supplies saved VI connector types and parameter defaults. The command catalog contains stable command and condition IDs. Discovery never executes robot VIs.

Saving a path writes a local `.bdx` file. Binary export requires saved NI type evidence for command parameters; eventless paths can export without a linked catalog. Robot-code VIs read the file and return setpoints and command requests. The caller supplies measured pose, time, lifecycle state and motor/command integration. See [LabVIEW integration](docs/labview/index.md).

Robot push is a separate explicit action. Saving and local deletion do not connect to a robot or remove robot contents. Revision review, readback and matching disabled-runtime acknowledgment remain required where the configured robot receiver supports deployment.

## Project files

Mark a waypoint **Linkable** and give it a **Point name** to make it available for reuse. On another waypoint, use **Shared position → Use named point…**; only opted-in named points appear. Turning Linkable off hides the point from the picker without breaking existing links. Editing either point updates every linked occurrence; robot facing, tangent handles relative to the point, and stop settings remain local. **Unlink** makes that occurrence independent. Duplicating an entire path retains its shared positions; duplicating an individual waypoint creates an independent, offset point. Appended path endpoints also share position only.

For swerve paths, drag the start heading arrow or edit **Initial robot facing** independently of travel direction. Editing facing while tangent or look-at mode is active switches only the first segment to manual facing. **Entry speed (vi)** and **Exit speed (vf)** specify speed along the path, subject to trajectory limits. A waypoint’s explicit **Stop at entry/exit** overrides that boundary speed to zero; remove the stop to use a moving boundary. Tank heading follows the tangent.

Field feedback uses one compact status; expanded **Details** holds diagnostics. Normal trajectory rebuilding remains automatic. Playback and field editing need a current trajectory: when planning rejects the path, the status explains why and offers **Edit limits**; when final planning runs out of time, it offers **Try again**. A saved optimization that cannot be validated offers **Optimize**.

**Undo** applies to what you are looking at: the open path, or the routines, plus project-wide changes such as deleting a path or folder. It skips edits made elsewhere, but it is unavailable while a newer edit elsewhere depends on the change, such as an edit to a path that shared a position with a deleted one. Undo that newer edit first. Restoring a folder or path keeps library names, folders, and links you have changed since.

Choose **New project** or **Open folder** and select any regular folder; no existing project file is required. The project uses the folder name. Bordeaux automatically saves committed edits in `.bordeaux-workspace.json`, the single project file, and keeps readable path and routine files in `Paths/*.path` and `Routines/*.routine`. Background saving leaves active input drafts and keyboard focus alone; **Save** commits valid drafts and also generates `Paths/*.bdx` for exportable paths with at least two waypoints. Renaming or deleting an item removes its previous managed source file after the replacement save succeeds; successful BDX generation also removes obsolete managed BDX files. Unfinished paths remain editable; if BDX generation fails, the project stays saved and the error offers a retry. Saving is local and never connects to a robot.

Use **Save to another folder…** to copy the project into another folder, or **Open project file…** to open an existing `.bordeaux` file. Existing `.bordeaux` files remain importable. Folder saving migrates a verified matching legacy project into the workspace file without maintaining a duplicate. Bordeaux preserves unrelated or externally modified files and reports conflicts instead of deleting them.

After a legacy import is saved into its workspace, Recent points to the folder. Reopening the unchanged legacy file also recovers that workspace when its recorded source matches. If a folder already has a workspace and Bordeaux cannot prove that the selected legacy file belongs to it, Save and autosave preserve the existing workspace and report a conflict. Use **Open folder** to recover its current work, or **Save to another folder…** to keep the selected legacy project separately. This also protects older workspaces that have no recorded import source.

Bordeaux refuses to write a file it could not reopen. A standalone `.bordeaux` file and each `Paths/*.path` or `Routines/*.routine` file may be at most 16 MiB, and `.bordeaux-workspace.json` at most 32 MiB, measured in the exact UTF-8 bytes to be written. A folder save checks every file before it writes anything or creates `Paths/` or `Routines/`, so a save rejected for exceeding these limits leaves the previous files unchanged and reopenable. If a size limit is exceeded, split the project or remove unused paths and routines, then save again.

File names come from item names, and the full display name is still stored inside each file. Characters that filesystems reject become `-`. Windows device names such as `CON` or `nul.txt` get a leading `_`, and long names are cut on a whole character so the file name fits in 255 UTF-8 bytes. That is the Linux limit, and it also stays within the 255 UTF-16 units allowed by APFS and NTFS. Paths or routines that would share a file get numbered names such as `Name (2).path`. Two BDX outputs that would share a name, such as paths named `CON` and `_CON`, make the save fail instead of overwriting each other. Names are not Unicode-normalized, so decomposed names on older HFS+ volumes and Windows full-path length limits are not checked.

## License and asset rights

The Bordeaux application and LabVIEW integration source are licensed under the [Apache License 2.0](LICENSE). The Bordeaux identity and bundled assets are governed separately; [RIGHTS.md](RIGHTS.md) records the trademark boundary, font terms, media rules, and provenance locations. Apache-2.0 does not grant permission to present a fork or product as an official Bordeaux release.
