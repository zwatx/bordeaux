# Command output branches

Routine commands can optionally branch on a declared output after completion. The inspector offers Boolean routes, one route per named enum value, or ordered numeric comparisons with a final Otherwise route. Users add steps under each route and choose a route for desktop preview. Routes rejoin the next sibling step.

The desktop preview does not execute commands or evaluate real output values. The shared reference interpreter in `src/shared/routineExecution.ts` executes command-driven branches through explicit host adapters: await command completion, verify its fresh invocation ID, read the selected typed output, choose the first matching route, and rejoin the following step. Missing outputs, failed/cancelled/timed-out commands and changed output schemas fail instead of choosing Otherwise. Boolean, enum, DBL/SGL and exact integer/decimal comparisons never use truthiness or lossy numeric coercion.

The robot VI adapter and versioned routine transport are not connected yet. Routine export continues to reject output branches, repeats and end instructions; path-only BDX export remains independent. The interpreter grants no transport or deployment capability and is never called by desktop preview or local Save. Do not drop branch metadata to make a routine deployable.

`RobotCommandDescriptor.outputs` comes from verified NI connector metadata for supported top-level scalar output terminals. `Command Status Info.ctl` terminals remain lifecycle plumbing. Unsupported outputs are reported independently, preserving supported command inputs and outputs. Live NI inspection requires Windows with LabVIEW; supported cached metadata can be read on other hosts.

`RoutineFunctionNode.outputBranch` stores the selected output name, its schema snapshot, and ordered routes. Each route has a stable ID, label, comparison, optional typed value, and nested routine nodes. Boolean routes cover True and False. Enum/numeric routes include exactly one final Otherwise route. Comparisons are first-match; exact 64-bit thresholds stay strings. At most 256 routes are accepted. Preview outcomes use the parent command node ID and selected route ID.

Changing a command or output preserves work until the user confirms removal of populated routes. Missing outputs and changed schemas stay visible for recovery. Existing condition decisions and event gates load as legacy data; new condition authoring is removed. No automatic predicate-to-command migration is assumed.

## Repetition and Wait

Repeat supports a fixed count (1–50, optionally stopping earlier) or **Until command output**, which has no fixed pass cap. A stop rule selects a command directly inside the repeat, one of its outputs, and a typed comparison. The body runs at least once. After each normally completed pass, the interpreter checks that pass’s completed command result: false starts the next pass; true continues after the repeat. Each pass has a fresh result scope. Nested repeats have independent scopes; Exit repeat leaves only its enclosing repeat, while End routine ends the whole run. The host supplies the cancellation signal and must stop ongoing path/command/wait operations on cancellation or disable. Dynamic loops yield between passes so cancellation remains observable even with immediate adapters.

Desktop preview chooses 1–50 illustrative passes without adding a runtime limit to saved dynamic loops. `times` is absent on a dynamic repeat, and `until.source` must be `output`; source validation keeps incomplete selectors editable while execution preflight requires complete, valid bindings. Old counted repeats and saved condition references retain their data.

Wait is a native instruction, `{type:"builtin", builtinId:"bordeaux.wait", arguments:{durationS}}`, available with no robot code linked. Its historical ID is a serialization discriminator, not a required catalog command. Neither authoring nor routine serialization requires a `builtIns` declaration or generated catalog version. The current duration range remains 0.02–15 seconds. The runtime adapter handles it as a delay; no VI is discovered or invoked for Wait.

Verification:

- `npm test -- tests`: repository tests, including branch persistence, traversal, legacy migration, NI parsing, and export rejection.
- `npm run typecheck` and `npm run build`.
- `node scripts/verify-command-branches-ui.mjs`: built-app checks with an isolated project, mocked catalog/filesystem, pointer and keyboard input, route editing, save/reload, and screenshots at 1440×900 and 1100×720. It does not verify live NI or robot execution.

See `.plans/2026-09-19_command_output_branches_and_robot_execution.html` for the future execution contract, scheduler semantics, migration, and acceptance criteria.
