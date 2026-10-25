# Shared battery and breaker estimates

Implemented October 24, 2026. This extends the electrical motor envelope and load-transfer model. It does not change BDX 1.1 or deploy robot code.

## What the planner enforces

Timing retains the affine motor envelope, with a conservative additional current cap that reserves the configured minimum bus voltage under peak mechanism load. Motor loss current now occupies part of the stator-current budget; it is not added on top of the controller limit. This corrects the original research script's distinction between torque-producing and total motor current.

Dense validation evaluates the allocated wheel forces and speeds together. Each motor's terminal voltage is back-EMF plus winding voltage drop; positive electrical power determines battery-side current. With N identical motors distributed among contacts (including multiple motors per tank side):

```
I_motor = F_wheel * radius / (reduction * efficiency * Kt * motors_per_contact) + I_loss
V_motor = omega_motor / Kv + R_motor * I_motor
P_drive = sum(max(0, V_motor * I_motor) * motors_per_contact)
V_bus = V_open - R_battery * (I_other + P_drive / V_bus)
```

The stable, high-voltage quadratic root gives the shared bus. A negative discriminant means the requested load has no steady-state solution. A requested motor voltage above the reserved bus voltage or current above the reserved stator limit is an `electrical-power` violation. Existing timing repair can slow the trajectory; unresolved violations prevent acceptance/export. Complete but electrically impossible configurations produce explicit errors instead of falling back to an unconstrained model.

At zero speed, a requested launch force still draws winding current. Braking electrical power is signed, but negative supply power receives no regeneration credit. Positive copper-loss power during low-speed plugging still draws from the battery. This does not simulate battery charge acceptance or controller regeneration limits.

The timing cap assumes supply current can approach motor current and can therefore be conservative at low duty. The shared-bus check improves qualification of unequal module demands; this is not a globally time-optimal nonlinear electrical solver.

## Configuration

Settings → Electrical model retains unloaded battery voltage, combined battery/wiring resistance, constant Other mechanisms current, and control reserve. These are the battery-condition inputs; no state-of-charge or temperature estimator is inferred from elapsed time.

- `minimumBusVoltageV`: default **7.25 V**, an explicit planning floor, not a detected hardware setting. It includes 0.5 V above roboRIO 2's default 6.75 V threshold. Teams must match their configured threshold and desired margin.
- `loadBursts`: up to 128 additional supply-current intervals `{startTimeS, endTimeS, currentA}`. Intervals are half-open and overlaps add. Times are relative to the analyzed path, or to the selected routine preview when analyzing a routine. No mechanism schedule is inferred from command names. Timing always reserves the maximum simultaneous load, so shifting command timing cannot invalidate that assumption.
- `driveBreaker`, `mainBreaker`: optional `{ratedCurrentA, tripTimeAt2xS, initialHeat}`. Missing curves remain **Not configured**. A drive curve means one breaker per drive motor; mechanism branch breakers are not modeled. `initialHeat` ranges from 0 (cold) to 1 (modeled trip level); it is an assumption, not a temperature measurement.

All values persist with the robot configuration. Electrical changes invalidate selected trajectory identities: corridor-selection/4 and route-selection/5. Existing electrical defaults remain marked placeholders; breaker presets require an explicit selection.

## Breaker model and confirmed hardware

The user identified REV 40 A ATO drive breakers and supplied a main-breaker photo labeled **185120F, 120 AMPERE**. Both have explicit presets:

| Preset | Cold 2× current point used | Evidence |
| --- | --- | --- |
| REV 40 A ATO (REV-11-1863) | 80 A, 5 s | REV datasheet minimum; typical 18 s and maximum 60 s |
| Bussmann 185120F | 240 A, approximately 10 s | Early edge read visually from the Series 18X time/current band, catalog p. 71, revision 01.31.20 |

The Bussmann value is graph-derived, not a tabulated guaranteed trip time. The code links the source beside each preset. Both start cold; initial heat can be edited for warm-start scenarios.

The thermal estimate is:

```
tau = tripTimeAt2xS / ln(4/3)
heat_after = heat_before * exp(-dt/tau) + (I_supply / I_rated)^2 * (1 - exp(-dt/tau))
```

Heat 1 is the modeled trip level. This reproduces the entered cold 2× point and carries heat through repeated bursts and cooling waits. It does not reproduce the entire manufacturer tolerance band, ambient-temperature derating, contact aging, prior unknown match history, reset timing, or motor/controller thermal protection. It is a review diagnostic, not a certified no-trip guarantee or an automatic breaker-based timing constraint.

## Power view

The **Power** button in path properties and the routine header shows minimum bus voltage, peak battery supply current, peak motor stator current, and main/drive breaker peak heat. It uses final planned samples, including stationary turns and waits. Moving intervals are sampled at at most 20 ms; mechanism burst boundaries are split exactly. The reports approximate peaks between samples.

Routine analysis follows the selected preview branches and repeat counts and carries heat between paths. Idle gaps cool drive breakers while scheduled mechanism current still heats the main breaker. Unknown/conditional durations and truncated previews refuse a whole-routine estimate rather than assuming missing time or motion. Runtime dynamic trajectories are not silently treated as stationary. Analysis runs in a cancellable worker with a 30 s deadline; closing the view terminates its work. Saving and reporting never connect to a robot.

## Validation and remaining measurements

Automated checks cover shared bus and power balance, unequal module loads, duty-cycle supply current, no-regeneration braking, plugging loss, zero resistance, voltage collapse, motor multiplicity, overlapping bursts, cold/warm breaker heating, cooling/subdivision invariance, repeated paths and waits, invalid configuration, and hard-launch planning. The native UI harness exercises defaults, presets, numeric edits and Escape, save/reload, path/routine reports, and pointer/keyboard controls at 1440×900 and 1100×720.

Robot measurements are still required: unloaded voltage and DC resistance for representative batteries, total PDH supply current, mechanism draw timing, controller settings, and warm-start behavior. The existing AutoFollow/DriveCurrent stream is motor-side comparison data; do not directly substitute it for PDH breaker current. CG height remains provisionally 0.25 m. No robot run or deployment validates these estimates yet.

### Implementation verification

- Typecheck and production build passed, including renderer bundle budgets.
- The nine-file focused run passed 183 of 184 tests; one existing planner regression exceeded its 5 s timeout while native UI checks ran concurrently. Re-running the entire 39-test planner regression file alone passed. The other eight files passed in the original run. This is focused coverage, not a full-suite certification.
- The final native UI run passed save/reload, defaults, edits, presets, report results, and real pointer/keyboard interactions at both supported sizes. Evidence is retained in the integration workspace under `authoring/electrical-power-20261024/ui-3`.
- The primary agent and independent read-only reviewer inspected the final reports and settings. Review fixes cover impossible electrical configurations, truncated routines, and optimized routine geometry; no blocking findings remain. No hardware or other-platform behavior was tested.
- The Lab CLI was unavailable in this environment; implementation and review evidence are recorded here instead.

Sources:

- [REV breaker specifications and trip behavior](https://docs.revrobotics.com/ion-control/pdh/specs/rev-ato-auto-resetting-breakers)
- [REV-11-1860-1863-DS-01](https://www.revrobotics.com/content/docs/REV-11-1860-1863-DS.pdf)
- [Cooper Bussmann Series 18X manufacturer catalog page](https://assets-fe147638ed.cdn.insitecloud.net/d978273f2b8897b/46960.pdf)
- [WPILib brownout behavior](https://docs.wpilib.org/en/stable/docs/software/roborio-info/roborio-brownouts.html)
- [CTRE motor-side and supply-current explanation](https://v6.docs.ctr-electronics.com/en/2025/docs/hardware-reference/talonfx/improving-performance-with-current-limits.html)
