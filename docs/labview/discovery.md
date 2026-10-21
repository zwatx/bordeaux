# LabVIEW project and command discovery

Link the directory containing your `.lvproj`. If it contains several projects, Bordeaux asks
you to select the exact project file and remembers that selection for refresh and restore.
Project sources are discovered directly from NI project XML, auto-populating folders, and
referenced `.lvlib`/`.lvclass` containers. A file's membership and target are source information;
they do not establish that the VI is an executable command.

On Windows, keep that exact project open in LabVIEW. Selecting, restoring, or refreshing
the linked project automatically inspects commands. **Sync commands** repeats discovery and
inspection after changes. If inspection is unavailable, Bordeaux retains valid cached or
declared commands and shows the reason with a retry action. On macOS, sync reloads source
and cached metadata; live NI inspection requires Windows. Bordeaux's bundled inspection adapter reads
connector metadata and saved scalar defaults from the existing LabVIEW process. It requires
the same Windows user/session and a single matching registered NI process. It does not open
projects, run inspected VIs, change control values, save/close projects, or connect targets.
It uses the project's **My Computer application context**, including when a file's project
membership belongs to an RT target. It does not certify the RT compilation or execution state.

The adapter is currently validated for **LabVIEW 2025 25.3.3f3, 32-bit**. NI's private ActiveX
`_ExportInterface2` provides typed XML, root typedef paths, terminal direction and indices.
The version and returned shapes are checked before interpreting them. Other NI versions,
unavailable COM, a project that is not open, and unsupported metadata produce explanations.
No MCP server, agent, downloaded LabVIEW SDK, or experimental discovery tool is required.
The existing optional agent MCP feature is independent of this workflow.

## LabVIEW command contract

The inspected legacy Bordeaux implementation (`Trajectory.lvproj`, `Command Stuff/Find RT
Projects.vi` and `Find Command Names.vi`) selects RT myRIO/RT roboRIO project members whose
connector has **exactly two root typedefs named `Command Status Info.ctl`**. It excludes
`Support Code`, `Framework`, `Prep Command Info for Wait.vi`, `Wait for Command.vi`,
`Should Abort Operation.vi`, `SubSystems.vi`, and names containing `Command Helper.vi`.
Bordeaux verifies the observed input/output status pair and completion cluster shape.
Matching filenames, ordinary clusters with similar labels, nested typedefs, and placement
in a `Commands` folder are insufficient.

The status cluster contains a name, a U16 completion enum (Successful, Aborted, Incomplete),
and a notifier reference. These belong to the legacy scheduler and are excluded from author
arguments. Supported argument types map to the existing shared typed parameter contract;
unsupported references or ambiguous cluster fields retain an explanation. Unsupported
numeric representations are not silently widened into permissive values.
Additional output terminals do not exclude an otherwise supported source command: the
legacy planner stores input controls only. Such descriptors explicitly note that their
additional outputs are not represented; they remain unavailable for native execution.

In the selected `RebuiltApprentice.lvproj`, `Intake/Commands/Start Intake.vi` exposes `Setpoint`
(DBL) and `Description` (string). `Intake Immediate.vi` also exposes an operation enum.
The generated `_wrapper.vi` files have front-panel controls but no connected connector pane;
they therefore fail the typed filter naturally. No filename heuristic is needed.

The native form covers **connector inputs and saved defaults**, without opening VI front
panels. It does not inspect off-connector front-panel controls. The old planner's discovery
and Inhale event stored all front-panel input values, but Open Command Panel restored only
connector-bound values, and GenerateWrapper created controls from subVI connector terminals.
Its saved front-panel collection was broader than its generated execution interface. Native
connector forms are therefore not complete parity with those historical control snapshots.

## Authoring readiness and cache

Inspected commands can be selected and edited with typed parameters. Saved connector evidence permits direct BDX serialization, while execution readiness remains a separate caller-owned concern. The generated catalog does not execute commands or install a runtime.

Save, local BDX export, and selected-file push also use the linked project's active connector
snapshot within the current Bordeaux session. This includes live-only inspection when NI
cannot report saved-state flags or a typedef was discovered during inspection. Bordeaux
rechecks the project, VI sources and type dependencies before writing, and rejects changes
with a **Refresh commands** instruction. This uses the inspected types and defaults; it does
not certify that unsaved LabVIEW edits match files on disk or authorize robot execution.
Live-only snapshots are never persisted as saved-source evidence. After restarting Bordeaux,
refresh commands in the open LabVIEW project to obtain a new live snapshot if no valid saved
cache is available. Saving or exporting does not start NI inspection or connect to a robot.

Inspection metadata is stored only in Bordeaux's user-data cache, never in the robot project.
Refresh can use a cache without LabVIEW or MCP while the selected project, VI sources, and
referenced typedef/container files match their hashes. Unsaved or unknown NI modification
state is retained only as live inspection; it is not represented as a saved-source cache.
Known global VIs are noncommands. Clean unsupported sources remain visible as warnings
without preventing the verified command subset from being cached.
Typedefs must also have been hashed before inspection. Newly discovered external typedefs
remain live-only, so metadata cannot be bound to bytes first read after extraction.
Changed sources invalidate cached commands. Missing declared handlers and stale generated
bindings also remain unready. Catalog identities and shared invocation validation check LabVIEW command parameters.

## Later trajectory integration

The actual old planner Push event in `Trajectory Builder.vi` resolves selected paths and calls
`FileIO/Put Multiple Files.vi` to transfer files to `/home/lvuser/natinst/bin/Paths/` using FTP.
The older `Send File.vi` transfer helper is not that active callsite. The writer uses the
versioned BDX format, and differs from the direct BDXLV1 binary layout.

In the selected robot code, `Autonomous.vi` reads the auto-path selection and calls
`Support Code/Parse Auto Data.vi`, which actively calls the planner's `FileIO/Versioned Load.vi`
and transforms path data before command preprocessing and playback. Its standalone Choreo
load snippet is disabled. `Drive/Commands/Play Path.vi`, `Auto Play Path.vi`, and
`Drive/Implementation/Command Sequencer Infrastructure/Sequence Commands.vi` are the
playback/scheduling integration points.

`Preprocess Commands.vi` resolves generated wrappers by VI name and resolves argument
control indices. `Optimized Call Command.vi` writes named Variant arguments by those indices
and invokes Run VI. Subsystem helpers use status/notifier and queue lifecycles. A later port
must deliberately adapt these loader, timing, dispatch, completion, and cancellation paths
to BDXLV1 files. Discovery does not change or execute any of that robot code.


## Conditions

NI connector inspection discovers commands, not conditions. Conditions currently come from
an explicit `conditions` array in `bordeaux-catalog.json` beside the `.lvproj`, for example:

```json
{
  "schemaVersion": "bordeaux-labview-catalog/1",
  "catalogId": "team-autonomous",
  "commands": [],
  "conditions": [
    { "id": "hasGamePiece", "label": "Has game piece", "vi": "Conditions/Has Game Piece.vi" }
  ]
}
```

Add the entry to the existing catalog rather than replacing its commands. Build the catalog
to validate its declared VI files and expose the conditions in Bordeaux's condition picker.
Inspection alone does not build declarations or add conditions automatically.

A condition represents a true/false predicate evaluated by robot code, such as a game-piece
sensor check. The declaration gives the editor its stable ID, label, and VI reference; it does
not generate a VI, infer a Boolean connector contract, or wire the predicate into robot
execution. The team's robot scheduler must map that ID to the implemented check and supply
its result. Catalog building verifies the referenced file, not that runtime behavior. An
ordinary VI with a Boolean output is therefore not automatically a supported condition.
