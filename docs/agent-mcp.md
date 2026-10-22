# Bordeaux agent access

Bordeaux can expose the open editor as a local MCP server so an agent can inspect, analyze, repair, and propose autonomous paths. Access is off by default.

1. Open Bordeaux and a project.
2. Choose **Agents → Enable MCP access**.
3. Choose **Agents → Copy MCP configuration** and paste the JSON into the MCP client configuration.
4. Keep Bordeaux open while the agent works. Proposed paths appear as dashed previews with candidate metrics and **Apply/Reject** controls.

The MCP server cannot save, export, build, deploy, or apply a proposal. Applying a proposal is always an explicit, undoable editor action. Any intervening editor change, project reload, or closed window makes the proposal stale.

## Vocabulary and planning

The `resolve_field_terms` tool understands source-pinned 2026 REBUILT field terms such as `NEUTRAL ZONE`, scoring-table-side/non-scoring-table-side `TRENCH`, and `BUMP`. It also understands alliance-relative crossing names such as `red left TRENCH`: left/right is from that alliance's drivers facing the field, not the current screen orientation. An explicit alliance color always selects that physical structure; the editor's Blue/Red view only changes display orientation.

Bordeaux uses the official fixed blue-origin frame: blue is at low X, red at high X, and +Y points away from the scoring table (screen-up). Zero heading points along +X and positive headings are counterclockwise. Coordinates are meters within the 16.541 × 8.069 m welded field. The original overlay uses one shared calibration of its inner alliance walls and guardrails, excluding the off-field station aprons. Flip is an explicit, undoable edit of every authored path: positions become `(length-x,width-y)` and headings gain 180°. Saved source and exported samples use `wpilib-blue-origin/2026-welded/1`. Legacy source projects migrate from their declared old frame; opaque Robot command arguments are never treated as field coordinates.

Robot-relative `front`, `back`, `left`, and `right` require a specific physical or authored robot pose. A TRENCH route also requires robot height before it can be certified.

The field pack inventories zones, lines, all TRENCH/BUMP portals, HUB bodies and faces, TOWER bases and RUNGS, DEPOTS, OUTPOST CHUTE/CORRAL vocabulary, DRIVER STATIONS, and welded-field AprilTags 1–32. Off-field areas, fiducials, and structure faces are marked non-navigable. DEPOT dimensions are official, but Bordeaux does not invent an uncertified barrier polygon from them.

`plan_path` generates a bounded set of typed route skeletons, runs the selected Bordeaux planner, rejects modeled collisions and illegal alliance-barrier crossings, and ranks the remaining generated candidates. Simple routes may use `goals` plus one global traversal policy. A route with different outbound and inbound crossings must use ordered `steps` with per-leg traversal requirements. Bordeaux validates the exact ordered portal IDs and adds footprint-sized straight entry/exit runs through each portal.

`inspect_session` returns an explicit `context` handle containing the session ID, revision, and active path. Pass that handle to planning, repair, analysis, and robot-profile proposal calls. If the editor changes first, Bordeaux returns `stale_context` before starting expensive work. Calls without a handle remain accepted for older clients, but are not retry-safe.

A `swoosh` step is a deterministic 180-degree reversal with an explicit turn direction, radius, and optional boundary inset. Its `at` location is the maneuver's far longitudinal extent—not its entry or center. It is not an arbitrary loop inferred from prose. Its recommendation is not a proof of a globally optimal match strategy.

When a request says to collect as much initial FUEL as practical, agents must keep collection as the route objective. The complete `NEUTRAL ZONE` is 283 in (7.19 m) deep, but the official starting FUEL corral is only approximately 72 in (1.83 m) deep around the `CENTER LINE`. Initial collection routes therefore resolve the near or far edge of that FUEL band and use distinct lanes with little retracing instead of driving to the far edge of the complete zone. Each collecting travel or swoosh step is marked with `collectFuel`; only those segments receive tangent-aware intake heading and the configured collection-speed limit. Bordeaux still cannot promise an exact FUEL count because placement varies from match to match.

`minimumClearanceM` is an advisory target: falling below it produces a warning and affects near-tie ranking, while an actual modeled footprint intersection is always invalid. Collision checks transform the configured convex robot-local footprint at every sampled physical heading; a missing footprint uses the centered rectangle defined by robot length and width. The optional polygon representation supports asymmetric rectangles and trapezoids without reducing them to a centerline radius. Typed TRENCH openings require the full lateral footprint and configured robot height to fit. BUMPs are traversable surfaces; their ranges cover the full 44.4 in ramp depth plus the braking approach. HUBs, alliance-barrier sections outside portals, and field walls are solid.

## Robot planning profile

When MCP access is enabled, the Robot page exposes agent-planning details that are intentionally separate from basic chassis geometry. The profile records the primary intake's robot-local center (`+X` forward, `+Y` left), outward direction, capture width, and maximum safe collection speed. It can also record shooter direction, target-facing requirements, preferred range, and team notes.

An agent first reads `bordeaux://robot/planning-profile` or calls `inspect_robot_profile`, asks only the missing questions, then calls `propose_robot_profile`. Omitted answers merge with the inspected profile instead of erasing it. The proposal opens on the Robot page and does not change the project until the user chooses **Apply robot info**. These details remain optional project metadata.

Collecting segments derive physical chassis heading from `travel tangent − intake direction`, so a front, side, or rear intake stays aligned with travel. The heading law is smoothed inside the allowed intake-error band, and local velocity/acceleration caps keep the curve within authored angular limits. Bézier handles still control path geometry and footprint clearance; they are distinct from swerve chassis heading. A shooting route uses `finishFacing` on a separate non-collecting final approach; Bordeaux stops at the final pose, performs a constrained stationary alignment from configured shooter direction to the physical HUB target, and then verifies the final heading.

Projects may add optional team vocabulary without changing the project schema version:

```json
{
  "strategy": {
    "locations": [
      {
        "id": "our-safe-shot",
        "name": "Our safe shot",
        "aliases": ["safe shot"],
        "kind": "pose",
        "x": 2.5,
        "y": 2.0,
        "headingDeg": 15
      }
    ],
    "actionBindings": [
      { "semanticTag": "shoot-fuel", "commandId": "robot.actions.shoot" }
    ]
  }
}
```

Named regions use `kind: "region"` and `bounds: { "xMin", "xMax", "yMin", "yMax" }`; routing uses the region center. Strategy coordinates use Bordeaux project coordinates and are validated against the field.

An end action is accepted only from an authoritative generated LabVIEW command catalog. The command must be runtime-ready and explicitly advertise the requested semantic tag. If more than one command advertises the same tag, the project must provide one `actionBindings` entry. When the user requests an action such as shooting but no binding exists, the agent sends `endActionIntent`; Bordeaux preserves it as a pending endpoint marker and allows valid path geometry to be added. LabVIEW export remains blocked until that marker has an authoritative command binding, so the action is neither silently dropped nor falsely presented as executable.

## MCP surface

- Resources: current session, robot planning profile, 2026 field pack, the path-authoring contract, linked LabVIEW commands, detailed path analysis, the current proposal, full proposals, and individual proposal candidates.
- Read-only tools: `inspect_session`, `inspect_robot_profile`, `resolve_field_terms`, `analyze_path`, and `get_proposal`.
- Preview tools: `propose_robot_profile`, `plan_path`, and `repair_path`.

Tool results use typed structured output plus a compact text fallback. Preview tools return one of `ready`, `blocked`, `needs_input`, or `stale_context`. A `ready` result includes compact candidate metrics and a resource link; complete paths and bounded raw samples remain behind proposal/candidate resources. A `blocked` result is diagnostic only and is not staged in the editor, so an invalid candidate is never labeled as recommended.

`analyze_path` defaults to a summary containing extrema and findings. Use `detail: "samples"` or read `bordeaux://paths/{id}/analysis` only when exact bounded samples are required. `repair_path` only stages a candidate when a bounded clone improves the requested finding without introducing a worse error or warning. Staging a new ready proposal supersedes the previous preview and reports its ID.
