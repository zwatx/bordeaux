# Motor modeling for feasible paths

Current extension: [weight transfer, CG height, and load-dependent exported forces](weight-transfer.md).
Latest extension: [shared battery prediction, brownout checks, mechanism loads and breaker heating](electrical-power.md). The research conclusions below describe the pre-implementation baseline; use the implementation sections and extension documents for current behavior.

Research date: 2026-10-24. Sources: Greg McKaskle's LabVIEW motor-sim (`C:\Users\zwatx\Developer\LabView\motor-sim`, last commit 1f24177, 2021-11-20) and the Bordeaux planner on `main` at 027098c. Nothing here has been run against robot logs yet. The numbers below come from the reference script in this folder, not from robot measurements.

## Conclusion

Bordeaux already times translation and heading together against a drivetrain model. Module wheel speed, chassis traction, per-module traction force and angular limits are hard constraints. The planner's main optimism comes from its motor model, which has two gaps.

1. **It assumes stall torque at every speed below free speed, with no current limit.** `motorMaxTorqueNm` is the datasheet stall torque (3.6 N·m for a Vortex). Our drive motors are limited to 55 A, which gives a Vortex about 0.94 N·m, or 26% of stall. For rebuilt-68, the planner's motor term works out to 38 m/s², so traction (μg = 11.8 m/s²) is the only limit that binds at low and middle speeds.
2. **It assumes a full 12 V at the wheels.** There is no battery sag, no gearbox loss, and no voltage headroom left for the path follower's feedback.

motor-sim models exactly these terms. For rebuilt-68 (Vortex 5.5:1, 3 in wheels, 54.4 kg, μ 1.2), the model with a 55 A stator limit, a 12.5 V / 0.02 Ω battery and 90% gearing gives:

| speed (m/s) | Bordeaux max accel today | motor-sim model | model as % of Bordeaux |
|---:|---:|---:|---:|
| 0–1.5 | 11.8 | 9.0 | 76% |
| 2.0 | 11.8 | 8.6 | 73% |
| 3.0 | 11.8 | 5.7 | 49% |
| 3.5 | 11.0 | 4.3 | 39% |
| 4.0 | 7.2 | 2.9 | 40% |
| 4.5 | 3.3 | 1.5 | 44% |

Getting from 0 to 4 m/s takes **0.35 s over 0.74 m in Bordeaux**. The model takes **0.61 s over 1.44 m**, and 0.79 s over 2.06 m when the other mechanisms draw another 60 A. A path timed by Bordeaux at high speed asks for roughly twice the acceleration the drivetrain can deliver. The follower then falls behind, and at the same time it has no voltage left to recover.

The good news: Bordeaux's reachability solver already supports the right constraint shape, a per-module force bound that is affine in speed with a flat cap. The code that builds per-module motor constraints exists, but its output is never passed to the solver. Most of the integration is replacing the stall-torque line with the motor-sim line, then connecting constraints that are already built.

To regenerate the numbers, run `node motor-envelope.mjs [motor]` in this folder. The motor options are `rev-vortex` (default), `"neo (REV current)"`, `kraken-x60`, `kraken-x60-foc`, `falcon-500`, and `"neo (motor-sim 2021)"`.

## Implemented on `feat/electrical-drive-model` (2026-10-24)

Proposal steps 1–3 are implemented, and **the electrical model is how planning works for every robot with a drive model**. It is not opt-in. Unset values come from the motor preset and from planning defaults, so a project that configures nothing still gets current-limited, sag-aware limits instead of the old stall-torque line. The only exception is a *custom* motor with unknown stall and free current: it keeps the 12 V stall-torque line, and the Robot page asks for those two figures.

### Inputs and defaults

The resolution lives in `resolveElectricalDriveInputs` in `src/shared/robotLimits.ts`. Preset data is in `src/shared/motorPresets.ts`. An authored value always wins.

| `driveModel` field | Default when unset | Source |
|---|---|---|
| `motorStallCurrentA`, `motorFreeCurrentA` | the preset for `motorId` | REV NEO V1.1, Vortex and NEO 550 docs; WCP Kraken X60/X44 performance tables; CTRE/AndyMark Falcon 500; motor-sim (CIM) |
| `driveCurrentLimitA` (stator, per motor) | REV presets **80 A**; CTRE presets **120 A**; CIM and custom motors: the stall current (no limit) | SPARK Smart Current Limit default (REV brushless FAQ); Phoenix 6 `CurrentLimitsConfigs.StatorCurrentLimit` default 120 A, enabled |
| `batteryVoltageV` | 12 V | datasheet reference voltage |
| `batteryResistanceOhm` | 0.020 Ω | MK ES17-12 is about 12 mΩ at 1 kHz, which understates DC sag; wiring and the breaker add a few mΩ. motor-sim sweeps 14–24 mΩ. |
| `otherLoadA` | 0 A | enter the expected intake or shooter draw during paths |
| `driveEfficiency` | 0.90 | typical swerve gearing and wheel losses |
| `controlReserve` | 0.10 | voltage and current kept for the follower's correction |

### How the model works

- **Battery sag stays linear.** At full duty, battery resistance acts as `N·R_bat` of extra series resistance on each motor:

  ```
  I + I_free = (V_bat − R_bat·I_other − ω/Kv) / (R + N·R_bat)
  ```

  The torque-speed line is therefore still affine in speed. This matches the time-stepped sag simulation in `motor-envelope.mjs` exactly whenever the current limit is not binding. That is the case where sag matters: when the limit binds, duty < 1 and the battery draw is small.
- **`robotHardLimits`** returns:
  - `maxSpeedMps`: the speed where the line reaches zero;
  - `motorAccelMps2`: the line's intercept;
  - `motorCapAccelMps2`: the flat current cap;
  - `brakingCapAccelMps2` and `maxDecelMps2`: braking, which is not back-EMF limited;
  - `electrical`: R, Kt, Kv, effective R, available voltage and current cap.
- **Timing:** the per-module motor-force constraints are passed to the reachability solve again (`optimizationConstraints.ts`). A new `motoringOnly` flag (`reachability.ts`) applies the line to motoring force alone. The old symmetric line also forbade braking near free speed, which is the likely reason it had been removed. Only custom motors without currents keep the symmetric, chassis-level timing.
- **Validation:**
  - `evaluateDrivetrainForces` checks the force along each wheel's rolling direction. Motoring is checked against the falling line, braking against the current cap.
  - The allocation clips each contact force only by traction; lateral force is tire friction.
  - The motor tolerance is scaled by the flat cap. Near a module's zero-torque speed, the local limit tends to zero and the solver's interval geometry differs from the dense validation grid by a few newtons.
- **Accepted results:** `PLANNER_VERSION` (`corridor-selection/2`) and `routeIntentKey` (`route-selection/3`) are bumped, so accepted results for existing drive-model projects become stale and are planned again.
- **UI:** the renderer preview (`pathMath.js`) uses the shared limits.
  - The Robot page always shows the "Electrical model" fields. Defaults appear as placeholders marked "Default", and typing stores an explicit value.
  - "Use default electrical values" clears the authored values.
  - Choosing a custom motor keeps the last preset's currents as editable values.
- **Cost:** per-module motor constraints make planning about 2–3× slower on the v2 corpus geometry with a MAXSwerve drive model, for example 53 → 119–230 ms per optimized path. Tight rotating corners can trigger 1–2 extra validation refinement passes, in the worst case about 1 s → 2.3 s. Planned path times on the corpus grow by 0–17%.

Not done yet: proposal steps 4–6 (utilization display, a coupled per-interval sag loop, and a capability plot).

## Answers to the earlier questions

- **Motors:** rebuilt-68 is REV MAXSwerve with NEO Vortex drive (5.5:1, 12T, 3 in wheels) and NEO 550 steer (46.42:1). `swerve-template/Hardware VIs/Initialize 8 NEO Swerve Drive.vi` confirms this. Bordeaux models drive motors only; steer is listed under later ideas.
- **Current limit:** REV Smart Current Limit holds motor *phase* (stator) current. It can optionally ramp from a stall limit down to a free limit above a set RPM; the REVLib default is flat for our motors. `kCurrentChop` is an on/off phase chopper. SPARKs have no battery-side limit, so `driveCurrentLimitA` is a stator limit. The SPARK Flex is rated 60 A continuous and 100 A for 2 s.
- **Placeholders** (mass, MOI, μ, battery): REV publishes no μ for MAXSwerve tread, and the ES17-12's 12 mΩ is a 1 kHz figure that understates DC sag. See the measurement table in `authoring/motor-model-follower-20261024/PROPOSAL.md` (apprentice workspace). Battery V0 and R come straight from a regression of PDH voltage against total current, and μ, MOI and efficiency come from simple logged tests.
- **Robot side:** the template's drive loop sends no acceleration feedforward (`ka = ks = 0` in `NEO Set Pod Setpoints.vi`). Theory gives kA ≈ 0.35 V/(m/s²), about 3 V at a 9 m/s² launch. That proposal also covers feedforward, voltage compensation and logging.

## What is in motor-sim

The repository is a LabVIEW 2019 project, `Getting serious with Motors.lvproj`. It was read with the LabVIEW scripting tools without running or saving anything. `Motor Model.vi` currently has a broken cluster wire; the other VIs read below are executable.

| VI | What it does | Useful for Bordeaux |
|---|---|---|
| `Lookup Motor Coefficients.vi` | Motor table: 775pro, CIM, miniCIM, NEO, NEO 550, Falcon 500 (stall torque, stall current, free speed, free current). It also has rough rotor mass and radius guesses for rotor inertia. | Yes, the data model. The values need updating (see below). |
| `Compute Motor Model Values.vi` | Derives R, Kt, Kv from the four datasheet numbers at 12 V. | **Yes, the core.** |
| `Compute Motor Values.vi` | Current, torque and power at a given speed and applied voltage, with a symmetric current limit. | **Yes, the core.** |
| `Motor Model.vi` | Sweeps speed to draw torque, current and power curves. | Reference only. |
| `Apply Torque to Drivebase.vi` | Wheel force = τ/(G·r). Acceleration = min(F_motor, μmg)/m. Flags slip. | Already covered by Bordeaux's traction model. |
| `Compute Drivetrain Values.vi` | Time-stepped straight-line "drag race": battery droop → current per motor (total amps ÷ motor count) → torque × efficiency − torque loss → traction-limited acceleration → trapezoidal integration. Also handles brownout and has a Vbus% or PID control mode. | **Yes, the battery, efficiency and loss terms.** It can also serve as a validation oracle. |
| `Make DriveBase Curves.vi`, `Compare Drivebase Curves.vi` | Sweeps motor count/type, gear ratio, mass (100–150 lb), battery voltage (11.75–13 V), internal resistance (0.014–0.024 Ω) and the total-amp budget (200–300 A). Plots speed and acceleration against distance for a sprint time. Defaults: 12.9 V, 0.015 Ω, 300 A. | Good model for a Bordeaux "drivetrain capability" view and for gear-ratio what-ifs. |
| `Modeling/Battery.vi` | `Vbus = V0 − I·R_internal`. A comment says it ignores state of charge and temperature, and cites a richer RC equivalent circuit (Dost, Athens J. Tech. Eng. 2016). | Yes, the first-order sag model. |
| `Update Brownout Status.vi` | Below 6.3 V, motor voltage is forced to 0 for a hold time. | As a warning only. A planned path should never get near it. |
| `Modeling/Breaker.vi` | Breaker accumulation (marked "not used yet" in the drivetrain VI). | No. |
| `Compute Motor Instantaneous Values.vi`, `Analytical Model.vi` | Flywheel spin-up, solved two ways: by time stepping, and as the state-space form `ω̇ = −G²Kt/(Kv·R·J)·ω + G·Kt/(R·J)·V`. | The equation is the same model in another form. Not needed directly. |
| `Flywheel Moment of Inertia.vi`, `Combine MofI.vi` | J = k·m·r². | Only if rotor or wheel inertia is added later (it is small next to robot mass). |
| `Simulated positioned arm.vi`, `PID FRC form.vi`, `Add External Forces.vi`, `Setpoint Autostep.vi` | Arm with gravity torque, plus PID tuning (including relay autotune). | No, these are not drivetrain. |
| `Add Noise and Delay.vi` | Sensor noise plus an N-iteration delay. | Possibly later, for simulating the follower (see "Later ideas"). |

### The model

From `Compute Motor Model Values.vi`, using the 12 V datasheet reference:

```
R  = 12 / I_stall
Kt = τ_stall / I_stall
Kv = ω_free / (12 − I_free · R)          (rad/s per volt)
```

From `Compute Motor Values.vi`, at motor speed ω and applied voltage V:

```
I = clamp((V − ω/Kv)/R − I_free, −I_limit, +I_limit)
τ = Kt · I
P = τ · ω
```

The drivetrain VI adds battery droop (`V = V0 − R_bat · I_total`), a torque efficiency factor, a constant torque loss, and the traction cap μmg.

For a swerve module with reduction G (motor turns per wheel turn) and wheel radius r, at wheel speed v:

```
ω_motor  = v · G / r
F_volt(v) = η · Kt · G / r · ((V − ω_motor/Kv)/R − I_free)      (a straight line in v)
F_curr    = η · Kt · G / r · I_limit                           (flat)
F_motor(v) = min(F_curr, F_volt(v))
```

This is a flat cap followed by a falling line. Bordeaux today uses a single falling line that starts from stall torque and assumes V = 12 V.

**Braking is different.** With −V applied, the back-EMF adds to the drive voltage instead of opposing it, so braking is bounded by the current limit and traction, not by the voltage line. A path can therefore safely decelerate harder than it can accelerate at high speed. Bordeaux already applies its motor line to acceleration only (`reachability.ts:344`), which is the right direction. Deceleration should also get the current cap, which it does not have today.

**Supply current versus stator current.** A stator-limited launch runs at low duty cycle, so battery current ≈ stator current × duty. This matters for sag. At 55 A stator and v = 0, each Vortex draws only about 18 A from the battery (duty ≈ 0.30). At 2 m/s it draws about 56 A at full duty, which is where the sag is worst. motor-sim does not model this; the reference script does.

### Motor data

motor-sim's table is from 2021. Its NEO entry (3.36 N·m, 166 A, 5880 rpm, 1.3 A) is REV's original rating. REV's current NEO figures are 2.6 N·m, 105 A, 5676 rpm, 1.8 A. Bordeaux's presets (`RobotPage.jsx:17-18` onward) store only free rpm and stall torque. A physical model needs all four numbers:

| motor | stall torque (N·m) | stall current (A) | free speed (rpm) | free current (A) |
|---|---:|---:|---:|---:|
| REV NEO (current) | 2.6 | 105 | 5676 | 1.8 |
| REV NEO Vortex | 3.6 | 211 | 6784 | 3.6 |
| Kraken X60 (trapezoidal) | 7.09 | 366 | 6000 | 2.0 |
| Kraken X60 (FOC) | 9.37 | 483 | 5800 | 2.0 |
| Falcon 500 | 4.69 | 257 | 6380 | 1.5 |

The Vortex, Kraken and Falcon rows are vendor figures recalled for this note, not read from a source in this session. Check them against the vendor pages before adding them as presets.

## What Bordeaux does today

The description below was verified in source.

- `robotHardLimits` (`src/shared/robotLimits.ts:16`) computes:
  - free speed = rpm/60 · π · D / G (`:34`), at a nominal 12 V with no free-current loss;
  - `motorAccelMps2 = N · τ_stall · G / (r · m)` (`:35`);
  - traction = μg;
  - ω_max = v_free / module radius;
  - α_max = a·m·r/I.

  `physicalPlannerInput` replaces `robot.maxSpeed` with that free speed, and new paths default to these limits.
- The reachability solver, `solveReachabilityProfile` (`planners/reachability.ts:622`), is a time-optimal pass over the fixed path in speed² space: a backward pass computes the reachable set, then a forward pass picks the greatest acceleration. `controlBoundsForInterval` (`:329`) applies the chassis motor line `a ≤ motorAccel · (1 − v/v_free)`, integrated exactly over each interval, to acceleration only.
- `projectDrivetrainAtPoint` (`planners/drivetrainProjection.ts:71`) builds, per module:
  - a wheel-speed constraint (translation plus θ′ × offset), so rotation and translation share the wheel-speed budget;
  - a traction-force norm constraint that includes yaw inertia;
  - a **motor-force scalar constraint**: the module force projected onto the module's velocity direction, with `freeSpeed`, `velocityCoefficient` and a stall-force `motorAcceleration` (`:148-161`). This is the right shape, because the drive motor only does work along the direction the wheel rolls.
- **Gap:** `buildReachabilityInput` (`planners/optimizationConstraints.ts:280`) passes only the angular-acceleration constraints as `scalarAccelerationConstraints` (`:405`). It never reads `intervalScalarAccelerationConstraints`, so the per-module motor-force line is never applied during timing.
- Final validation, `evaluateDrivetrainForces` (`drivetrainProjection.ts:218`), uses a constant stall force per module and deliberately leaves out back-EMF. The comment at `:290` explains why: applying a DC line to the whole force vector double-counts the wheel-speed limit and causes false slowdowns. That is true for the whole force vector. Projecting onto the rolling direction, as the scalar constraint above already does, avoids it.
- Safety factors (`optimizationConstraints.ts:19-21`): 0.99 numerical, 0.95 drivetrain, 0.85 angular acceleration. These are uniform margins. They are not a model of the electrical limits.
- Export: the BDX samples carry `velocityMps`, `accelerationMps2` and `angularVelocityRadps`. They do not carry angular acceleration, module states or feedforward.
- Benchmarks: the frozen corpus `benchmarks/planner-corpus/v2` has no `driveModel`, so it only exercises the authored limits. Physics cases will need a new corpus version.

## Why paths turn out unfollowable

In order of expected effect for our robot:

1. **The current limit is missing.** At 55 A, a Vortex module produces about 122 N at the wheel (90% gearing), against about 160 N of traction. Bordeaux plans to the traction figure.
2. **The speed-dependent torque is too generous.** Bordeaux keeps full traction-limited acceleration up to about 3.4 m/s. The model has fallen to half of that by 3 m/s.
3. **There is no voltage headroom.** A feedforward plus feedback follower needs spare voltage to correct errors. A profile planned at 100% of the 12 V envelope leaves none, so any error grows. Planning at about 85–90% of the available voltage keeps correction authority.
4. **Sag from the rest of the robot.** Intake, shooter and other mechanisms running during auto pull the bus down. The 60 A scenario drops the model's top end further (0→4 m/s takes 0.79 s instead of 0.61 s).
5. **Combined motion.** Because per-module motor constraints are not applied in timing, curved paths that also rotate can demand more from the outside modules than the chassis-level line allows. Today that is caught only after the fact by validation and retiming.

The authored path limits usually hide items 1 and 2. The only rebuilt-68 path, `testQuest`, uses 1.52 m/s and 3.05 m/s², well inside the envelope. Problems appear when authors raise those limits toward the robot envelope Bordeaux suggests by default: 4.92 m/s and 11.8 m/s².

## Integration proposal

Each step is useful on its own. Steps 1–3 address most of the problem.

1. **Electrical fields on `driveModel`** (optional, so older files keep today's behaviour). Add:
   - `motorStallCurrentA`, `motorFreeCurrentA`;
   - `driveCurrentLimitA` (stator), with an optional `driveSupplyCurrentLimitA`;
   - `planningVoltageV` (for example 11.5–12 V), which stands in for sag and headroom;
   - `gearEfficiency` (for example 0.9).

   Motor presets would carry all four datasheet numbers. Derive R, Kt and Kv exactly as `Compute Motor Model Values.vi` does. The fields would be validated in `validation.ts`. They feed `optimizationInputKey`, so they invalidate accepted results automatically. Bump `PLANNER_VERSION` (`acceptedTrajectoryIdentity.ts:8`).
2. **Replace the stall line in `robotHardLimits` with the motor-sim envelope.** The flat part is `min(F_curr, traction)`. The line part comes from `F_volt(v)`, using the planning voltage and free current. The effective free speed becomes `(V − I_free·R)·Kv·r/G` instead of the 12 V datasheet value. The reachability motor line is already `a ≤ A·(1 − v/v_free)` with a separate flat maximum, so this means changing the numbers fed to `motorAccelerationLimits`, `freeSpeeds` and `accelerationLimits`. The solver does not change. Deceleration gets `min(F_curr, traction)`.
3. **Connect the per-module motor constraints.** Concatenate `drivetrain.intervalScalarAccelerationConstraints` into `scalarAccelerationConstraints` in `buildReachabilityInput`, and give those constraints the step 2 parameters. Then mirror the same projected-force check in `evaluateDrivetrainForces` / `validateModuleForces`, so validation and timing agree. Also update the renderer's preview copy in `src/renderer/lib/pathMath.js`.
4. **Utilization diagnostics.** Per sample, show predicted stator current, supply current, bus voltage, and the percentage of the motor envelope used, with a colour band along the path. The existing "Motors overloaded" / "Wheels would slip" badges (`planProblems.js`) already map constraint labels. Show which limit binds where.
5. **Coupled battery sag (optional).** Replace the single planning voltage with a fixed-point loop, as `Compute Drivetrain Values.vi` does. Solve, predict the per-interval total supply current (plus a user "other loads" figure), compute `Vbus = V0 − R_bat·I`, then solve again with per-interval voltage. Two or three iterations should converge. Warn if the predicted Vbus nears the 6.3 V brownout threshold.
6. **Capability view** (in the spirit of `Compare Drivebase Curves.vi`): on the Robot page, plot acceleration and speed against distance for the configured robot. Optionally overlay other gear ratios or battery states. This helps authors choose limits before drawing paths.

## Validating it

- **Unit:** add `robotLimits.test.ts` cases that check R, Kt and Kv against hand calculations, and an envelope test against `motor-envelope.mjs` values. Add `reachability.test.ts` cases for flat-cap-plus-line behaviour and for current-capped deceleration.
- **Corpus:** add a new planner corpus version with a `driveModel` that includes the electrical fields, so physics cases are frozen separately from v2.
- **Robot logs (most important):** fit the model to real data before trusting it. From a wpilog of straight full-throttle sprints, extract chassis speed, acceleration, drive stator and supply current and bus voltage, then fit μ, effective R_bat, efficiency, and the actual current-limit behaviour. This is the measured counterpart of motor-sim's comparison tool. The parser in `C:/Users/zwatx/scratch/wpilog/` (`parse.py`) already decodes our logs.

## Later ideas (not proposed now)

- Export per-sample angular acceleration, or per-module feedforward, so the robot can add a kA term. This changes the 88-byte BDX record and the LabVIEW `BDX Sample.ctl`, so it needs a format version.
- A closed-loop follower simulation in Bordeaux, using motor-sim's delay and noise idea, to predict tracking error before running on the robot.
- Steer-motor limits, and rotor or wheel inertia (k·m·r²). Both are small next to robot mass and can wait.
