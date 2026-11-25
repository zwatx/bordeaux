# Robot file contracts

## BDX field coordinates

Every standalone BDX and every BDX embedded in a BDR carries the exact field reference
`2026-rebuilt · 2026-manual-tu19-andymark-1 · wpilib-center-origin/2026-andymark/1`.
The robot must validate all three fields against its supported odometry frame
before executing any sample or command. Reject older pins, missing pins, and unknown
pins during preload. A successful push or binary decode confirms delivery or
readability only.

Positions are in meters from the field center in the NWU convention. Positive X
points toward the blue wall at +8.259 m. Positive Y points toward the scoring-table
guardrail at +4.0215 m. Robot heading and travel heading are radians, with zero along
+X and counterclockwise positive. Timing stays in seconds. Robot-local force
components keep their existing axes and units.

Historical projects rotate around the welded field center to preserve positions relative to the interior structures. The center-origin AndyMark perimeter is smaller. Opening a historical project reports authored positions outside the new limits.

For example, the historical welded blue-origin pose (2 m, 1 m, 30°) describes the same
physical pose as (6.2705 m, 3.0345 m, 210°) in the centered frame. Both heading
angles rotate by π modulo 2π. Angular velocity is unchanged.

Coordinate-aware robot code, odometry, and any team-defined command or generator
arguments containing field poses need to be updated together. Bordeaux leaves
opaque arguments as authored. Verify the LabVIEW reader rejects a historical BDX
and accepts the matching centered fixture before running on a robot.

## Runtime routine files

The explicit **Export active routine…** File menu command saves a local `.bdr` file. **Push routine** uploads only the selected routine file through the same immutable review, pinned SSH identity, temporary-file readback and publication used by standalone `.bdx` paths. Publication uses atomic rename where supported; the existing SFTP overwrite fallback can leave an incomplete selected file after interruption. Save and autosave remain local. A successful transfer confirms stored bytes; it does not certify robot acceptance or execution.

The runtime consumes compiled `.bdr` and embedded BDX 1.1 bytes, never authoring `.routine` or `.path` source files. Standalone and embedded paths preserve authored time/position follow sections. Select **Timing > Position** in the path inspector, or select **Position** for an individual segment; **Use path** inherits the path default. Existing paths retain their saved modes and the default remains Time. Stationary departure/arrival waits remain time sections. Position sections require at least one edge, and every exported edge must have finite nonzero XY displacement and strictly increasing distance, matching the native follower's capability check; select Time for stationary segments. This uses the existing BDX mode field without changing BDX 1.1 or the routine schema. Path marker scheduling is unchanged: only time-triggered markers are supported, with no automatic path-end cancellation. Commands on embedded paths currently reject routine export: move those commands into explicit routine command steps so the routine runtime owns their completion and cancellation.

## Fixed JSON shape

UTF-8 JSON, schema `bordeaux-routine-runtime/1`, maximum 16 MiB. All fields below are always present. Arrays contain homogeneous records; there are no maps, optional properties or recursive JSON unions. Integers are I32, except scalar argument bytes, which preserve their original NI types.

```typescript
{
  schema: string, name: string, catalogHash: string, root: number,
  nodes: [{ id: string, op: number, parent: number, firstChild: number,
    nextSibling: number, path: number, command: number,
    wait: number, count: number, stop: number }],
  paths: [{ name: string, sha256: string, bdxHex: string }],
  commands: [{ vi: string, statusInput: number, statusOutput: number,
    statusInputName: string, statusOutputName: string,
    inputs: [{ name: string, terminal: number, niType: string,
      tag: number, choices: [string], valueHex: string }],
    outputs: [{ name: string, terminal: number, fieldPath: [string],
      niType: string, tag: number, choices: [string] }] }],
  comparisons: [{ producer: number, output: number, operator: number,
    tag: number, valueHex: string }]
}
```

`wait` is DBL seconds. All indices are zero-based; absence is `-1`. Nodes are emitted in strict preorder. A nonempty `firstChild` is the next array index; `nextSibling` is the first node after the previous sibling's entire subtree. Top-level parents are `-1`. `root` is `0`, or `-1` for an empty routine. Every node, including a route, has a unique authoring ID for telemetry, never command dispatch.

| op | Meaning | Fields used |
| --- | --- | --- |
| 1 | Path | `path` indexes embedded paths |
| 2 | Command | `command` indexes the invocation record; children are routes |
| 3 | Wait | `wait`, within 0.02–15 seconds |
| 4 | Repeat | children are the body, `count` is 1–50 or 0 for an output-only stop; `stop` optionally indexes a comparison |
| 5 | Exit repeat | exits the nearest enclosing repeat |
| 6 | End routine | ends the current routine |
| 7 | Output route | child steps execute only when selected; `stop` indexes its comparison |

Unused node fields have the explicit defaults: indices `-1`, `wait=0`, `count=0`. A repeat has a nonempty body and a count, output stop, or both. Each completed body pass gets a fresh command result scope; the stop producer must be a command directly inside that repeat. Never reuse a previous pass's completion. Exit repeat bypasses its stop comparison. End routine propagates through every enclosing branch/repeat.

Route comparisons are evaluated in source order against one successfully completed invocation. A Boolean branch has exactly true and false equality routes. Numeric/enum branches have a final Otherwise. Missing or invalid outputs are errors before evaluating Otherwise. `producer` indexes the command node; `output` indexes that invocation's `outputs`. Operators: 0 Otherwise, 1 equal, 2 unequal, 3 less, 4 less-or-equal, 5 greater, 6 greater-or-equal. Boolean and enum comparisons support equality only. Otherwise has `tag=0,valueHex=""`; ordinary comparisons have the referenced output's scalar tag.

Limits: 4096 flattened nodes including routes, graph depth 64 (root depth 0), 64 embedded paths, at most 4096 samples per path and 16384 samples total, at most 4096 command records and comparisons, 64 inputs/outputs per command, field paths at most 16 components, enum choices at most 1024. Routine names/node IDs are nonempty, NUL-free, at most 1024 UTF-8 bytes. Command names are inspected VI basenames; terminal identities are 0–255. Embedded paths are exact eventless `buildRobotBinary` BDX 1.1 files encoded as lowercase hex, with SHA-256 of the decoded bytes. Command-free routines do not require NI catalog inspection or an available LabVIEW project link.

## Scalar bytes and live command validation

`valueHex` is the lowercase hexadecimal of `encodeBdxArgument`'s payload, in **big-endian** order. It contains no length prefix. Tags are shared with BDX: Boolean 1; I8/U8 2/3; I16/U16 4/5; I32/U32 6/7; I64/U64 8/9; SGL/DBL 10/11; UTF-8 String 12; EB/EW/EL 13/14/15. Integers retain all bits, including values outside JavaScript's safe integer range. Enum bytes are the zero-based choice index. `choices` is empty for other types. Strings have at most 65536 encoded bytes.

Every invocation contains every argument input explicitly. Omitted authored values use only the inspected saved default; absent defaults reject export. Each invocation resets all inputs before starting so a previous call cannot supply an omitted value. Unsupported types, legacy predicate nodes, generated trajectories and malformed branches reject the whole file before publishing it.

Runtime dispatch uses the unique inspected original VI basename in `vi`, never a GUI command ID, display label, absolute inspection path, or generated resolver name. `name` on inputs is the NI control name. `fieldPath` on outputs includes the connector terminal name followed by named cluster fields. `statusInputName` and `statusOutputName` are actual inspected control names, while terminal numbers record provenance. The saved status terminals must have the `Command Status Info.ctl` shape: Name string, Status enum with Successful/Aborted/Incomplete, and notifier reference.

Current inspected command outputs and robot binding support top-level scalar outputs plus the owned status output's `Status` field. The generic field-path representation does not enable arbitrary nested command-output bindings.

Before motion or command invocation, the robot must validate the entire graph, every embedded BDX, every referenced command, ownership of command/comparison records, scalar NI types, enum choices, controls and output field paths against live loaded VIs. Saved metadata and `catalogHash` are provenance, not execution authority. The robot must reject missing/ambiguous commands or start wrappers (`<basename>_wrapper.vi`) during preload. Routines need no cancel wrapper: the robot never calls `<basename>_cancel_wrapper.vi` and does not require one.

Completion comes from the current invocation's notifier. The synthetic completion-status output with `fieldPath=[statusOutputName,"Status"]` must use that actual completed notifier status, not the stale indicator value returned while the start wrapper is still in progress. Cancellation, disable and failure stop the routine from starting anything new. A command already running is never cancelled or aborted: the robot waits for its start wrapper to return, then releases only owned references. A command that only ends when told to stop keeps the routine busy until it ends on its own.

## Rebuilt LabVIEW integration

The rebuilt project selects and preloads exactly one `.bdr` through its existing autonomous chooser. Its independent Bordeaux owner shares start/reload exclusion with native autonomous, including outstanding cleanup. It preserves the measured pose; it does not reset odometry to the first embedded path. Paths retain the existing follower's finish and settling-timeout policy.

`Routine Message.vi` is an included compatible console command with Message:string and Delivered:Boolean. It and the internal owner/path callbacks retain their front panels in the RT build. Its files are built as loose files below `/home/lvuser/natinst/bin/BordeauxCallbacks`; deploy those files together with startup.rtexe. A routine upload does not install new command VIs.

The older Calibrate, Reserve Drive, Config Drive Pipeline Command and testCommand wrappers may still fail preflight on their status or scalar interface as currently authored. Cancellation is not one of the requirements.

The robot checks embedded BDX CRC/sample validity. Embedded `sha256` and `catalogHash` remain provenance; they are not recomputed authorization checks. Runtime integer fields are checked before NI's integer conversion, and decoded NUL string escapes are rejected before NI can truncate names. Physical execution and hardware-specific cleanup require separate robot validation.
