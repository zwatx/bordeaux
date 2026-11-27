# Bordeaux

Bordeaux is a desktop editor for FRC robot paths, autonomous routines and robot command events. It plans for LabVIEW robot code only: you link a LabVIEW project to get its commands, draw paths on the field, and export them as `.bdx` files that the robot reads. Routines that chain paths, commands, waits, branches and repeats export as `.bdr` files.

Bordeaux runs as a desktop app on macOS, Windows and Linux. It also runs on a SystemCore robot as an app that any browser on the robot's network can open.

Bordeaux keeps your computer and the robot apart:

- **Save** writes to your computer only. It never connects to a robot.
- **Push** is a separate action. Before anything is sent, you review the robot's host key and the exact list of files. Bordeaux reads each file back to check it and never starts robot code.
- Deleting something in Bordeaux never deletes files on the robot.
- Robot code must check the field coordinate contract in every file before it runs a path. See [Field coordinates](#field-coordinates).

## Install

### Desktop app

Download the build for your computer from the [releases page](https://github.com/zwatx/bordeaux/releases):

- macOS (Apple Silicon): DMG
- Windows: setup executable, or a portable executable
- Linux: AppImage

Installed builds update themselves. The installed version picks the channel: a beta version follows beta releases, and a stable version follows production releases. The Windows portable executable does not update itself; replace it by hand. Microsoft Store builds update through the Store.

### SystemCore app

1. Download `bordeaux_<version>_all.ipk` from the [releases page](https://github.com/zwatx/bordeaux/releases).
2. Upload it under **Add Package** in the SystemCore dashboard, or copy it to the robot and run `opkg install`.
3. Bordeaux appears in the dashboard. Open `http://<robot>:2468/` in a browser on the robot's network.

To update, add the newer ipk the same way. The dashboard removes the installed version first and keeps the team's projects and pushed paths. **Global settings → Software updates** (the gear in the toolbar) shows the installed version. Removing the package also keeps both folders.

The package carries `LICENSE`, `NOTICE`, `RIGHTS.md` and the font license in `/usr/share/doc/bordeaux`.

## Projects and saving

A project is a folder. Choose **New project** or **Open folder…** and pick any regular folder; it does not need an existing project file. The project takes the folder's name.

Bordeaux saves committed edits automatically. A project folder holds:

- `.bordeaux-workspace.json`, the project file
- `Paths/*.path` and `Routines/*.routine`, readable source files for each path and routine
- `Paths/*.bdx`, written when you choose **Save**, for each exportable path with at least two waypoints

Autosave leaves text you are still typing, and keyboard focus, alone. **Save** also commits valid drafts and writes the BDX files. If BDX generation fails, the project stays saved and the error offers a retry. Unfinished paths stay editable.

When you rename or delete an item, Bordeaux removes its old source file only after the new save succeeds. A successful BDX build also removes BDX files it no longer manages. Bordeaux keeps unrelated or externally changed files and reports a conflict instead of deleting them.

Use **Save copy…** to copy the project into another folder.

### Older projects

**Open project file…** opens an existing `.bordeaux` file. Saving it into a folder moves the project into that folder's workspace file without keeping a duplicate, and **Open recent** then points to the folder. Reopening the unchanged `.bordeaux` file also finds that workspace again.

If a folder already has a workspace and Bordeaux cannot prove the selected `.bordeaux` file belongs to it, Save and autosave keep the existing workspace and report a conflict. Use **Open folder…** to recover the folder's current work, or **Save copy…** to keep the `.bordeaux` project separately.

Bordeaux converts saved optimizations in older projects into editable curves and retimes them with the current planner. If a curve cannot be converted, open **Optimize** and apply a new result, or choose **Use drawn path**, before you export that path.

### File limits and names

Bordeaux refuses to write a file it could not reopen:

| File | Largest size |
| --- | --- |
| `.bordeaux`, `Paths/*.path`, `Routines/*.routine` | 16 MiB each |
| `.bordeaux-workspace.json` | 32 MiB |

Sizes are the exact UTF-8 bytes to be written. A folder save checks every file before it writes anything, so a rejected save leaves the previous files unchanged. If you hit a limit, split the project or remove unused paths and routines, then save again.

File names come from item names; the full name is still stored inside each file.

- Characters that file systems reject become `-`.
- Windows device names such as `CON` or `nul.txt` get a leading `_`.
- Long names are cut on a whole character to fit 255 UTF-8 bytes.
- Paths or routines that would share a file get numbered names, such as `Name (2).path`.
- Two BDX files that would share a name, such as paths named `CON` and `_CON`, make the save fail instead of overwriting each other.

Names are not Unicode-normalized. Bordeaux does not check decomposed names on older HFS+ volumes or Windows full-path length limits.

## Editing paths

Trajectories use shared, physics-aware timing. Playback, routines and export all time the path itself, so what you preview is what you export, and a normal path needs no optimizer.

### Waypoints, speed and heading

For swerve paths, drag the start heading arrow or edit **Initial robot facing**. Facing is independent of travel direction. Editing facing while tangent or look-at mode is active switches only the first segment to manual facing. Tank heading follows the tangent.

**Entry speed** and **Exit speed** set the speed along the path at each end, within the trajectory limits. **Stop at entry** or **Stop at exit** on a waypoint sets that boundary speed to zero; remove the stop to keep moving through it.

Rotation targets and waypoint arrival headings turn **Shortest** (the default), **Clockwise** or **Counterclockwise**. To carry a full turn through an intermediate target, choose the same direction on that target and on the end heading. Matching headings with an explicit direction ask for one complete revolution. A moving turn needs distance; use a stopped turn to rotate in place.

### Shared positions

Give a waypoint a **Point name** to offer it for reuse. On another waypoint, choose that name under **Linked position** to share its position. Editing any linked waypoint moves them all. Robot facing, tangent handles and stop settings stay local to each waypoint. **Unlink** makes a waypoint independent again.

Duplicating a whole path keeps its shared positions. Duplicating a single waypoint creates an independent point, offset from the original. Appended path endpoints share position only.

### Optimization

**Optimize** is optional and works on one path at a time. It searches for faster geometry through the required waypoints, headings and stops, and checks the robot's footprint against the field. Compare a result with the current path, then apply it to write its curve into the path as one undoable edit.

Waypoints that a route adds are marked as added by Optimize, so a later run may move or remove them. Edit one and it becomes yours.

### Field status

The field shows one compact status; **Details** holds the diagnostics. Playback and field editing need a current trajectory. When planning rejects a path, the status says why. When final planning runs out of time, it offers **Try again**. When the robot's footprint overlaps a wall or field element, Problems shows where and suggests optimizing again or editing the path.

## Routines

In Routines, **Change path** opens a searchable path list with each path's folder, duration and where it is used.

The preview scrubber shows seconds and the current step. Click or drag to seek and pause. Space plays or pauses.

| Key | Moves |
| --- | --- |
| Arrow keys | 0.1 s |
| Shift + arrow keys | 1 s |
| Page Up / Page Down | to the previous or next step boundary |
| Home / End | to the start or end |

Untimed commands add no preview time. Preview never runs commands or conditions.

## Undo and shortcuts

**Undo** applies to what you are looking at: the open path, or the routines, plus project-wide changes such as deleting a path or folder. It skips edits made elsewhere. It is unavailable while a newer edit elsewhere depends on the change, for example an edit to a path that shared a position with a deleted one; undo that newer edit first. Restoring a deleted folder or path keeps library names, folders and links you changed since.

The **?** button lists keyboard shortcuts. To change one, press the pencil, click a key, then press the new key. A key taken from another command moves to the one you are editing, with **Undo**. **Keyboard shortcuts** in global settings (the gear beside **?**) opens the same editor. File menu commands need Ctrl (⌘). Esc, Tab, the arrow keys and F2 stay fixed. The desktop app saves your keys in `keybindings.json` in its user data folder; the SystemCore app keeps them in each browser.

You can hide the path list from its header. A slim strip at the left edge brings it back and returns keyboard focus to the current path.

## LabVIEW

### Link a project

Choose a `.lvproj` or the folder that contains it. Bordeaux reads the project XML, and NI inspection supplies each VI's saved connector types and parameter defaults. The resulting command catalog has stable command and condition IDs. Discovery never runs robot VIs.

### Export paths and routines

Saving a path writes a local `.bdx` file. Exporting a path with command events needs saved NI type evidence for each command parameter. Paths without events export without a linked catalog.

Robot-code VIs read the file and return setpoints and command requests. Your robot code supplies the measured pose, time, lifecycle state, and the motor and command integration.

**File → Export active routine…** saves the selected routine as a self-contained `.bdr` file with its paths embedded. Compatible LabVIEW code preloads the whole routine and runs its paths, typed commands, waits, branches and repeats. Each command needs matching start and cancel callbacks in robot code.

A BDX file holds the robot trajectory and commands. Editable waypoints and constraints live only in the Bordeaux project.

### Field coordinates

Every BDX file, including each one embedded in a BDR, carries a field reference of three values:

- field: `2026-rebuilt`
- field revision: `2026-manual-tu19-andymark-1`
- coordinate schema: `wpilib-center-origin/2026-andymark/1`

Robot code must check all three against the odometry frame it supports before running any sample or command, and reject missing, older or unknown values when it preloads the file. A successful push or decode means the file arrived and is readable, nothing more.

Positions are in meters from the field center, in the NWU convention. Positive X points toward the blue wall at +8.259 m. Positive Y points toward the scoring-table guardrail at +4.0215 m. Robot heading and travel heading are in radians, zero along +X and counterclockwise positive. Time is in seconds.

## Push to a robot

Push copies files to a robot over SFTP. It is never part of Save, and it never starts robot code.

### From the desktop app

A project can hold several robots on the **Robot** page, each with its own details and address. Push sends to the selected robot. Choose its type, roboRIO or Systemcore, when you set up its connection:

| Robot type | User | Push folder |
| --- | --- | --- |
| roboRIO | `admin` | `/home/lvuser/natinst/bin/Paths` |
| Systemcore | `systemcore` | `/home/systemcore/bordeaux/paths` |

The first Systemcore upload creates its folder. The LabVIEW container reads `/home` at the same path. If the team changed the Systemcore password, enter it under **SSH password**. Bordeaux encrypts it with the OS keychain. On a computer without a keychain, it keeps the password only until Bordeaux closes and never writes it to disk.

Before uploading, Bordeaux shows the robot's host key and the files it will send. Host keys you review are remembered on this computer, so switching back to a robot needs no new review. Bordeaux reads each file back before and after putting it in place. Robot code must read paths from the folder you push to.

**Push routine** uploads the selected routine through the same reviewed flow. A successful upload does not mean the robot accepted or ran it.

Pushing to a Systemcore with a linked LabVIEW project also sends `bordeaux-commands.json`, the project's inspected command list. It appears in the push review. The SystemCore app reads it from the push folder so it can author command events and build the same BDX bytes the desktop would.

### Robot files

Open the menu beside **Push** and choose **Robot files…** to see the paths in the current project next to those in the robot's configured folder.

- **Compare** overlays both compiled routes on the field with direction arrows, and highlights changed values such as the robot speed limit, timing and command events.
- **Inspect** opens a path that exists only on the robot.
- **Download .bdx…** saves that path's exact `.bdx` to a folder you choose.

### From the SystemCore app

The browser plans paths and builds the BDX files; the robot only stores them. **Save** and autosave write project folders to `/home/systemcore/bordeaux/projects`. The editor pushes only to the robot it runs on, so its **Robot** page shows the push folder instead of a robot list.

**Push** copies the selected paths' `.bdx` files into `/home/systemcore/bordeaux/paths`, reads them back and checks their SHA-256. LabVIEW robot code reads that folder.

Without a pushed `bordeaux-commands.json`, the SystemCore app exports only paths that use no commands. LabVIEW project linking and inspection, routine export and push, recovery copies, and project copies need the desktop app.

## Build from source

Requirements: Node.js 22.12+ and npm.

```text
npm install
npm run dev
```

`npm run dev` builds the app, then starts Electron.

### Source layout

- `src/renderer`: the React app, built with Vite to `dist-renderer`. `main.tsx` mounts it; feature components are in `components`, browser-side domain helpers in `lib`, and static resources in `assets` and `styles`. Modules use explicit imports, with no ordered scripts or application globals.
- `src/electron`: desktop integration, project files, robot transports and workers.
- `src/core`: planner, export and project logic, with no Node or DOM dependencies, so it runs in Electron, the browser and Web Workers.
- `src/hosts/systemcore`: the SystemCore web host and its Python server.

### Verify

```text
npm test
npm run typecheck
npm run build
env -u ELECTRON_RUN_AS_NODE npm run test:smoke
```

Run `npm run verify:package` after producing an unpacked package. Release tags must match `package.json`; CI enforces this with `npm run verify:release-tag`.

### Packaging and releases

[Desktop packaging](docs/packaging.md) covers local builds, update channels, release workflows and signing.

To build the SystemCore app, run `npm run package:systemcore`. It writes `release/bordeaux_<version>_all.ipk` using Node alone (no GNU tar or ar), and the same commit always gives the same bytes.

Archive large local installers outside the worktree instead of deleting them. [Local artifact hygiene](docs/packaging.md#local-artifact-hygiene) has the archive and restore commands and the safe Git cleanup boundaries.

## License and asset rights

The Bordeaux application and LabVIEW integration source are licensed under the [Apache License 2.0](LICENSE). The Bordeaux identity and bundled assets are governed separately; [RIGHTS.md](RIGHTS.md) records the trademark boundary, font terms, media rules and provenance locations. Apache-2.0 does not grant permission to present a fork or product as an official Bordeaux release.
