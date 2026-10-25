# Weight transfer in path planning

Implemented on `feat/weight-transfer`, October 24, 2026. This extends the electrical motor envelope and BDX 1.1 force export; it does not change the binary format or require another robot-side physics implementation.

## Robot settings

`driveModel.cgHeightM` is the center-of-gravity height above the floor, stored in meters. The Robot page converts metric/imperial input, marks an unset value as a default, and offers a reset to the default. Unset means **0.25 m (about 9.8 in)**. This is a provisional estimate, not a measured robot parameter. The owner will supply a measurement later. An explicit zero selects equal wheel loads for comparison with the previous model.

CG height is separate from the robot's overall height. Project validation accepts finite values from 0 through 2 m. Changing it invalidates accepted planning identities; old accepted results must be replanned. Current selection versions are corridor-selection/3 and route-selection/4.

## Model

The robot frame is +x forward, +y left. For a centered rectangular swerve chassis, wheel loads satisfy:

```
sum N_i = m g
sum x_i N_i = -m h a_x
sum y_i N_i = -m h a_y
```

Four contacts give three equilibrium equations. The remaining assumption is equal vertical contact stiffness with no diagonal warp load. Before wheel lift, each wheel starts with m g / 4 and gains/loses m h a_x / (2 wheelbase) and m h a_y / (2 trackwidth). Forward acceleration loads the rear, braking loads the front, and cornering loads the outside. Pure rotation about the centered CG does not transfer load.

`loadTransfer.ts` contains the contact geometry, affine normal loads, active-contact solve, and directional acceleration envelope. Negative contact loads are removed and the remaining equilibrium equations are solved again; unsupported moments are reported as tipping. The timing solver conservatively stays in the all-wheels-down region. Tank geometry remains a two-contact axle abstraction: it models side-to-side transfer, not fore/aft suspension dynamics.

Each module's friction circle is `|F_i| <= mu N_i`. The electrical model still bounds rolling force by current, voltage and motor speed. Heavily loaded wheels can supply more tire force, but cannot exceed their drive-motor limit. Thus load transfer does not necessarily change a current-limited low-acceleration path, and front/rear commanded forces can become equal when both motors are limiting.

## Timing and exported forces

The reachability solver accepts affine friction limits that depend on tangential acceleration and squared speed. It evaluates several force allocations for launch, braking and cornering; each allocation preserves net force and yaw torque. The hull of these sufficient allocations remains conservative relative to the convex contact-force problem at a fixed state. The global robot limits describe the better supported axis; the per-module constraints enforce the actual direction along the path.

Dense validation and export use a load-aware wrench allocator. It iterates between friction/motor limits and exact net-wrench correction. Iteration is bounded; an unresolved overload remains visible to validation rather than being silently clipped away. Purely lateral tire force is not exported as drive feedforward. BDX still stores signed rolling forces in **LF, LB, RF, RB** order; planner contacts are LF, RF, LB, RB. Terminal samples and samples with undefined stationary rolling direction retain the existing zero-force convention.

Traction violations near heading-law seams can persist when only the geometry grid is refined. For nonzero CG height, the optimizer tries its existing local timing repair before multiplying the grid when all violations are drivetrain acceleration. Every repaired result still passes dense validation. A representative curved fixture improved from roughly 5 s to under 1 s on this Windows machine; this is an informal timing comparison, not a universal latency guarantee.

## Verification and limits

Tests cover equilibrium, longitudinal/lateral signs, wheel lift, tipping, analytical traction/current limits, zero/default height, schema validation, affine reachability, a hard launch, braking, and exported force conservation. Existing electrical and frozen binary fixtures explicitly select zero CG so their original equal-load closed forms remain meaningful. Default/nonzero behavior has separate integration coverage.

The Robot UI harness covers default/override/reset, zero, Escape, Enter, Tab/Space activation, exact meter/inch conversion and save/reload. Screens are checked at 1440x900 and 1100x720. Full-precision text while editing a numeric field remains the existing BigNum behavior; blurred values are formatted normally.

This is a quasi-static, centered-CG approximation. It does not model suspension transients, pitch/roll oscillation, uneven carpet, changing mechanisms/payloads, tire slip or an offset CG. The assumed CG height, mass, friction, geometry and electrical settings still need robot measurements. No robot connection, VI execution or deployment is part of this planner change.

The existing robot current log remains analysis-only: `AutoFollow/DriveCurrent` contains expected torque-producing current, measured SPARK current, applied output and bus voltage, four of each in LF/LB/RF/RB order. Compare those with the re-exported force plan after collecting real logs; this feature does not adapt the model automatically.
