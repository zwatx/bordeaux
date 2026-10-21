# BDX 1.0 binary contract for direct LabVIEW robot code

This is the BDXLV1 writer/reader contract for ordinary VIs and typedefs inside the Apprentice robot project. BDX only: no AQU, CBOR, serialized NI Variant, new shared library, CLFN, native session or runtime binding manifest. MCP is authoring tooling, not a runtime dependency. The app writer and its production local export workflow have passed focused checks. Actual NI reader and execution verification remain in progress; these bytes do not assert runtime readiness. The earlier native/CBOR design is superseded.

Normative source: `docs/labview/binary-format.md` in the Bordeaux app worktree. The XPS `direct-ni-bdx-format.md` proposal is historical when it conflicts with this document.

Old-format basis: actual `Bordeaux/FileIO/Versioned Write.vi` uses sequential binary writes, version string 4.5; 241 inspected old files start with big-endian length/string `4.4`. Its commands include NI Variants/icons. Reuse its explicit-field approach, not those private serialized values. New magic selects a new parser; old files retain `Parse Auto Data.vi` → `Versioned Load.vi` unchanged. Evidence: `evidence/old-binary/versioned-write.png`, `versioned-write-controls.txt`, `legacy-bdx-structure.md` factual sections, and `direct-ni-evidence-review.md`.

**Current verification restriction:** the owner has requested VI construction only. NI runtime and fixture execution described here are future validation requirements and must not run until separately authorized. Construction-time diagram and connector inspection may proceed; Error List tool calls are also deferred.

## Caller integration boundary

The current delivery consists of ordinary hardware-independent reader, trajectory-math and setpoint/event-output VIs. The owner will wire them into the team Drive Controller and motor/vendor code later. Requested field X/Y velocity and angular velocity remain SI; desired pose and metadata retain the declared field frame. Motor units, alliance conversion, measured-pose acquisition, actual subsystem dispatch and completion/cancellation feedback belong at the documented caller boundary. File contents do not configure hardware or authorize motion. Requirements below for actual robot wrappers, trusted configuration and stop ownership must be fulfilled at that integration boundary before later execution; they do not introduce vendor dependencies into the pure parser/math VIs.

## Primitive rules and bounds

All numbers are big-endian, no alignment/padding. DBL is finite IEEE754 binary64; SGL finite binary32. Integer values use their exact NI width/two's-complement representation; JS writer uses BigInt for 64-bit values, never Number. Boolean is one U8 byte, only 0/1. `Text` is U32 byte count followed by UTF-8 bytes, no BOM/NUL terminator. Valid UTF-8 required; string argument contents may contain NUL, identifiers may not. No implicit LabVIEW array/cluster/string flattening headers beyond the counts specified here.

Limits: payload ≤16,777,216 bytes; metadata ≤65,536; samples 2..100,000; follow sections 1..4,096; events 0..2,000; arguments/event 0..64. IDs/catalog hashes/field revisions ≤256 UTF-8 bytes; display names ≤1,024; string argument ≤65,536. Check counts and remaining bytes BEFORE allocation/indexing; use subtraction (`needed <= remaining`) or wider arithmetic, never unchecked U32 multiplication/addition. Every subsection must consume exactly its declared bytes. Reject trailing bytes, duplicate event IDs, duplicate argument keys, unsupported flags/tags/modes and truncated reads. Header/sample/follow/event bounds are reader limits, not robot motion limits.

eventId, runtime command VI basename and argumentKey are nonblank, valid UTF-8, NUL-free and ≤256 bytes. conditionId is either empty or has the same ID constraints. Names are display-only; the current app requires nonblank path/event display names. Preserve identifiers exactly, without case folding or Unicode normalization.

## Header — exactly 32 bytes

| Offset | Type | Value |
|---:|---|---|
| 0 | U8[8] | ASCII `BDXLV1\r\n`, hex `42 44 58 4c 56 31 0d 0a` |
| 8 | U16 | major 1 |
| 10 | U16 | minor 0 |
| 12 | U32 | headerBytes 32 |
| 16 | U32 | payloadBytes |
| 20 | U32 | payload CRC-32/ISO-HDLC |
| 24 | U32 | flags 0 |
| 28 | U32 | reserved 0 |

Require exact file length `32+payloadBytes`. CRC reflected polynomial 0xEDB88320, initial 0xffffffff, final XOR 0xffffffff; `123456789` → 0xcbf43926. Implement as a small pure-VI U32 shift/XOR loop/table; it detects corruption, not trusted origin. This magic deliberately differs from the abandoned `BDXBIN` CBOR prototype. Reject that prototype, AQUBIN, and unsupported versions at the new reader. Do not guess format from `.bdx` alone.

## Payload — four sections in this order

There are no section tags, dictionaries or recursive objects. The fixed order is the versioned contract.

### 1. Metadata

U32 `metadataBytes`, then these fields exactly:

| Order | Type | Field/source |
|---:|---|---|
| 1–3 | Text each | `pathId`, `pathName`, `plannerId` |
| 4–6 | Text each | `fieldId`, `fieldRevision`, `coordinateSchemaId` from the selected pinned field |
| 7–8 | Text each | `commandCatalogId`, `commandCatalogHash` |
| 9 | U16 | `driveType=0` (this version supports the team's holonomic/swerve path route only) |
| 10 | U16 | `reserved=0` |
| 11–15 | DBL each | `totalTimeS`, `totalDistanceM`, `robotWidthM`, `robotLengthM`, `robotMaxSpeedMps` |

The app writes both catalog strings empty when eventCount=0. Otherwise `commandCatalogId` is the runtime protocol identity `bordeaux-dynamic-wrappers/1`. `commandCatalogHash` remains provenance: bare lowercase SHA256 of the exact UTF-8 compact `definitionJson` returned by `bdxBindingsFromCatalog` (no BOM or trailing newline). Its ordered shape is `{schema:"bordeaux-ni-command-types/1",commands:[...]}`. Commands with saved raw NI connector evidence are sorted by stable ID. Each entry has `id,target,file,parameters`, in that order. Argument parameters preserve inspected order and contain `name,type:{niType,choices?},schema,required,defaultValue?`; undefined properties are omitted by JSON.stringify. This hash is not a dispatcher identity or runtime readiness assertion. Dynamic wrapper dispatch requires no generated catalog VI, hardcoded command list, or manually maintained filename mapping; the actual loaded wrapper controls validate the supplied parameters. Path/field/planner identifiers are nonblank. Time ≥0, distance ≥0, robot dimensions/max speed >0. Robot metadata is comparison information, never configuration authority; it is not a complete robot configuration (height/footprint/all limits omitted). Robot-code preflight compares the compiled team's known configuration and limits independently. An authored mismatch rejects motion even when CRC matches.

Units are fixed by major version: field x/y/distance meters, time seconds, headings radians CCW, speed m/s, acceleration m/s², angular velocity rad/s, curvature 1/m. XY origin/axis orientation is the exact `coordinateSchemaId`. The current `wpilib-blue-origin/2026-welded/1` frame has (0,0) at the blue alliance wall/scoring-table corner, +X toward red, +Y away from the scoring table, and zero heading along +X. Its bounds are 16.541 by 8.069 meters. Flip is an explicit, undoable source edit: all authored paths rotate to `(length-x,width-y,heading+π)` and those edited coordinates are exported. NI must not apply a second alliance rotation to this schema. A reader must recognize the exact schema and perform any team-specific conversion once. Legacy `bordeaux-field/1.0` bytes retain their old interpretation; source projects migrate explicitly before new export. Unknown schemas or unverified transforms reject preflight; no automatic pose reset from file. Final team mapping remains a diagram-verification item, separate from these bytes.

### 2. Samples

U32 `sampleCount`, then exactly `sampleCount` records of **88 bytes**, each eleven DBLs in order:

`t, s, f, x, y, headingRad, travelHeadingRad, velocityMps, accelerationMps2, angularVelocityRadps, curvatureInvM`.

The array index supplies `i`; do not write an extra index. Preserve `f` from the planner; it is not `s/totalDistance` (jiggle advances distance while f stays fixed). `headingRad` is robot orientation; `travelHeadingRad` is translation direction. `velocityMps` is nonnegative magnitude; reverse translation is encoded in travel heading, not by changing robot orientation. Field velocity is `speed*cos(travelHeading), speed*sin(travelHeading)`. At zero speed both components are exactly zero.

Require finite fields; t[0]=0 and nondecreasing t; s[0]=0 and nondecreasing s; 0≤f≤1 and nondecreasing f. Last t/s match totalTime/totalDistance using `abs(actual-expected) <= 1e-9 * max(1,abs(expected))`. Preserve f even for all-stationary paths; a valid zero-distance result need not finish at 1. Reject negative speed or speed above independently configured robot bounds. Heading values may exceed ±π; normalize in the controller as needed.

Equal-time samples must have equivalent s/f/pose and dynamics using that same tolerance. Preserve them: boundedly advance across equal-time indexes before interpolation, without dividing by zero, changing event times or dropping follow-section boundaries. If totalTime=0, every sample must have exactly zero speed and angular velocity, s equivalent to zero, and x/y/robot heading equivalent to the first sample. Small planner roundoff in position and distance is permitted by the tolerance; it does not imply motion.

The writer obtains travel heading from the existing `buildCanonicalPathState(selectedPath, samples).points[].tangentRad` on the original planner samples, preserving the planner's stationary/jiggle and geometry rules. It then subdivides intervals longer than 20 ms, retaining every original sample and exact final timestamp. Inserted scalar fields use linear time interpolation; headings use shortest-arc interpolation. Travel headings are interpolated from the original canonical values, not recomputed from the denser geometry. Follow-section indices are remapped; event times and path totals are unchanged. Expansion exceeding 100,000 samples is rejected before allocating the expanded array.

These remain **timestamped samples, not a fixed 20 ms row table**. Retaining all velocity corners preserves the velocity-time area, including triangular profiles whose peaks fall between control ticks. Consumers must interpolate by elapsed time and finish at the terminal timestamp; never infer duration from sample count. The reader consumes stored travel heading directly; at zero speed its translation contribution is zero. Test turn-only, wait-only, zero-duration stationary, jiggle/reverse, curved and endpoint samples against actual app output.

### 3. Follow sections

U32 `followCount`; each record is exactly 16 bytes: U32 `segmentIndex`, U32 `startSample`, U32 `endSample`, U16 `mode` (0=time, 1=position), U16 reserved=0.

Indices are inclusive. Require start≤end<sampleCount, first start=0, last end=sampleCount−1, and each next start=previous end (shared boundary). Preserve exporter ordering and same-s departure/arrival time sections; allow zero-span sections and advance through them once without an infinite loop. Repeated segmentIndex is valid for stationary/time splits. The current dynamic wrapper integration does not support position following or position-triggered events; the exporter rejects both, including position-follow sections on eventless paths. Mode 1 remains reserved in the layout. Never reinterpret mode 1 as time mode.

### 4. Command events

U32 `eventCount`; each event is U32 `eventBytes`, then:

| Order | Type | Field |
|---:|---|---|
| 1–4 | Text each | eventId, displayName, runtime command VI basename, conditionId (empty means unconditional) |
| 5–8 | DBL each | timeS, fraction, repeatEveryS, endTimeS |
| 9 | U8 | trigger: 0=time, 1=measured position |
| 10 | U8 | cancelOnPathEnd Boolean |
| 11 | U16 | reserved=0 |
| 12 | U32 | argumentCount |
| 13 | records | argumentCount argument records below |

timeS in [0,totalTime], fraction in [0,1]. repeatEveryS=0 means once, otherwise >0. endTimeS=−1 means absent, otherwise in [timeS,totalTime]. The current exporter requires an empty conditionId, trigger=0 and cancelOnPathEnd=false; conditional markers, position triggers and automatic path-end cancellation are rejected before writing. For equal due times preserve original event array order. Event IDs unique; repeats use a separate occurrence counter, not modified IDs.

The third identity string is the **original command VI basename, including `.vi`**, resolved from the selected command's saved NI connector descriptor (`labviewConnector.file`) in the linked project. For example, a GUI ID `labview.legacy.<hash>` inspected at `Commands/Start Intake.vi` exports `Start Intake.vi`; the robot derives `Start Intake_wrapper.vi`. Never export the GUI ID, marker label, wrapper name or absolute inspection path. Missing/duplicate IDs, absent filename evidence and ambiguous basenames (including case-only collisions across folders/targets) reject export. GUI IDs and saved-project references remain unchanged. Only invoked event markers become event records; available commands are never emitted as events. Preparation resolves commands without executing them.

Existing exports containing hashed IDs require re-exporting. An eventless file such as the previous `NewPath.bdx` sample cannot validate event support. Re-exported event fixtures must still be checked with the team's reader, preparation and dispatcher in a separately authorized robot test; application byte tests do not verify hardware execution.

Each argument: Text `argumentKey`, U16 `typeTag`, U16 reserved=0, U32 `valueBytes`, then that many bytes. Primitive tags:

| Tag | NI type | Bytes |
|---:|---|---:|
| 1 | Boolean | 1 |
| 2,3 | I8,U8 | 1 |
| 4,5 | I16,U16 | 2 |
| 6,7 | I32,U32 | 4 |
| 8,9 | I64,U64 | 8 |
| 10,11 | SGL,DBL | 4,8 |
| 12 | UTF-8 string | raw UTF-8 `valueBytes`; no second length |
| 13,14,15 | enum with U8,U16,U32 representation | 1,2,4 |

Enum payload is the exact ordinal in the selected command's inspected enum; validate ordinal and labels against authoring evidence/catalog before writing. Type tags do not define a connector or authorize a cast. The dynamic dispatcher checks key/tag/required values against the actual loaded wrapper controls, creates exact typed values and converts to in-memory Variant only when required by existing indexed-control infrastructure. No file-supplied VI paths, control indices, connector indices, defaults, refnums or serialized Variant descriptors.

The app materializes actual inspected optional defaults into each event. If a valid file omits an optional argument, the robot resolver must still use its explicit compiled default **on every invocation**, never previous clone/control values. Omitted required, unknown/duplicate keys, tag mismatch, range/enum mismatch reject preflight. Exact U64/I64 values never pass through DBL. Null, arrays, clusters, maps, objects, opaque values and byte strings are **not supported by this small v1 argument format**: reject export/runtime preflight explicitly. A needed compound parameter must get a concrete command-specific adapter/contract before support is advertised; do not add a generic recursive serialization framework.

Marker group is not stored. Missing group or `sequential` is the existing standalone marker default and is accepted without introducing a new execution group. Explicit `parallel` or `deadline` groups are rejected by export until their semantics have a concrete contract. This concerns standalone path events only.

## Runtime semantics carried by these bytes

The current export profile supports time-triggered events with optional time repeats and end times, empty condition IDs and `cancelOnPathEnd=false`. Conditional/position behavior and path-end cancellation described below are broader reserved semantics, not capabilities enabled by this exporter. Array and cluster arguments are rejected; no binary extensions are introduced.

The NI event step uses one monotonic path clock and monotonic measured fraction. Time events become eligible at timeS; position events at measured f≥fraction. Nonrepeating events whose condition is false remain pending until true or expiry. Expiry comparisons allow 1e-9 seconds; equality remains eligible.

Repeats preserve authored phase: time-triggered repeats start at event.timeS; position-triggered repeats start at the path time when their measured fraction first becomes eligible. Each due occurrence advances the phase even when its condition is false. Catch up due occurrences in scheduled-time order, breaking ties by source event-array order. Do not shift phase to first accepted dispatch, coalesce overdue occurrences, or wait for a prior invocation to finish unless the actual team's wrapper behavior requires it and that feature is explicitly rejected before execution. Example: due=0, period=1, conditions false at due times 0/1/2 and true at time 2.5 yields the next eligible occurrence at 3, not a new phase at 2.5. Already activated repeats can catch up scheduled occurrences through their endTime; an event first observed after its endTime expires without activation. A bounded catch-up limit must fail before partial dispatch when exceeded, rather than silently dropping work. Unknown predicates or unimplemented runtime behavior reject preflight before motion.

The behavioral reference is the existing authored event schedule and its exercised event-runner semantics; no robot runtime or robot integration is required by the NI implementation.

Schedule acknowledgment follows actual subsystem acceptance; success follows actual Successful notifier, not Run VI return. Aborted/error remains distinct. Keep every autonomy-dispatched occurrence in an NI ledger until completion/cancel, including cancelOnPathEnd=false commands. Natural path end zeroes drive and cancels flagged events; unflagged accepted commands may continue in the same autonomy generation under the persistent owner. Final autonomy stop/disable/mode exit/replacement/load failure inhibits dispatch first, advances generation, cancels **all** remaining autonomy work, resolves status and releases owned refs/queues. No file data can disable full-stop behavior.

On a natural end, evaluate eligible endpoint events once at the terminal path time before cleanup; do not skip them through index exhaustion. Never force measured f=1 to fire a position event. Then discard ALL pending/undispatched events and future repeats regardless of cancelOnPathEnd; only already accepted unflagged occurrences may continue. Abort/disable/error suppresses endpoint dispatch entirely. Final-path autonomy termination still cancels all outstanding occurrences.

## Intended NI typedefs (not yet authored)

Under `integration-source/Robot Code/Support Code/Bordeaux/`: `BDX Header.ctl` (header scalar cluster), `BDX Metadata.ctl` (ordered metadata cluster), `BDX Sample.ctl` (11 named DBLs), `BDX Follow Section.ctl` (three U32s + U16 mode), `BDX Argument.ctl` (key String, typeTag U16, raw value U8[]), `BDX Event.ctl` (four Strings, four DBLs, U16 trigger enum, Boolean cancel, arguments[]), `BDX Path.ctl` (metadata, samples[], followSections[], events[]). Reserved/count fields are parser concerns, not repeated in every in-memory typedef.

Under `Drive/Implementation/Command Sequencer Infrastructure/`: `BDX Event State.ctl` (due/fired/repeat/completion fields), `BDX Owned Command.ctl` (generation U64, event/occurrence ID, actual team Command Status Info.ctl, prepared wrapper/ref state), plus a small persistent owner VI. In-memory VI refs/Variants remain ordinary existing NI infrastructure; none is read from disk.

Reader VIs use Open/Get Size/Read Binary File/Close, explicit U8 bytes and offsets, bounded primitive conversions with big-endian byte order, and Bundle By Name into typedefs. Always close the file on errors and clear readiness before selecting/loading. Do not unflatten an unvalidated arbitrary user-supplied type. Compile/reopen and NI fixtures are required before claiming this contract implemented.
