// Prototype data: a realistic, slightly hostile project (long names, many paths, ~5 commands).
import { buildWaypoints, defaultPathConstraints } from "../../../src/shared/project/defaults";
import { ACTIVE_FIELD_REFERENCE } from "../../../src/shared/field/rebuilt2026";

export const ROBOT = { drive: "swerve", w: 0.84, l: 0.84, heightM: 0.5, maxSpeed: 4.6 };

export const COMMANDS = [
  { id: "IntakeDeploy", label: "Intake down" },
  { id: "IntakeStow", label: "Intake up" },
  { id: "ShooterSpinUp", label: "Spin up shooter", parameters: [{ name: "rpm", label: "RPM", default: 4200 }] },
  { id: "Shoot", label: "Shoot", parameters: [{ name: "count", label: "Pieces", default: 2 }] },
  { id: "Feed", label: "Feed" },
  { id: "AimTurret", label: "Aim turret" },
  { id: "ArmStow", label: "Arm to stow" },
  { id: "ArmScore", label: "Arm to score" },
  { id: "ClimberExtend", label: "Extend climber" },
  { id: "LedsAuto", label: "LEDs: auto pattern" },
];

let nextId = 1;
const id = (prefix) => prefix + "-" + nextId++;

function path(name, raw, extra = {}) {
  const waypoints = buildWaypoints(raw.map((w) => ({ segType: "bezier", ...w })));
  return {
    id: id("path"),
    name,
    waypoints,
    targets: [],
    markers: [],
    ranges: [],
    constraints: defaultPathConstraints(ROBOT),
    headingMode: "manual",
    startVel: 0,
    goalVel: 0,
    exportable: true,
    ...extra,
  };
}

function marker(f, commandId, args = {}) {
  return { id: id("cmd"), f, name: commandId, cmd: commandId, anchor: "param", invocation: { commandId, arguments: args } };
}

export function createProject() {
  const opening = path("Left start → first piece → score", [
    { x: 3.55, y: 7.2, theta: 180, thetaOn: true },
    { x: 6.1, y: 6.55, theta: 200 },
    { x: 7.9, y: 7.25, theta: 180, stop: true },
    { x: 5.4, y: 5.4, theta: 150 },
    { x: 3.2, y: 5.15, theta: 150, thetaOn: true },
  ]);
  opening.markers = [
    marker(0.08, "IntakeDeploy"),
    marker(0.32, "ShooterSpinUp", { rpm: 4200 }),
    marker(0.5, "IntakeStow"),
    marker(0.78, "AimTurret"),
    marker(0.95, "Shoot", { count: 2 }),
  ];
  opening.ranges = [{ anchor: "param", f0: 0.42, f1: 0.58, maxVel: 1.6, name: "Pickup" }];

  const paths = [
    opening,
    path("Collect the second game piece from the far loading station and come back through the trench", [
      { x: 3.2, y: 5.15, theta: 150, thetaOn: true },
      { x: 6.4, y: 4.3, theta: 180 },
      { x: 8.4, y: 1.25, theta: 270 },
      { x: 4.6, y: 0.8, theta: 180 },
      { x: 2.4, y: 2.3, theta: 180, thetaOn: true },
    ]),
    path("Center line sweep (3 pieces)", [
      { x: 3.4, y: 4.0, theta: 180, thetaOn: true },
      { x: 8.0, y: 6.9, theta: 270 },
      { x: 8.25, y: 4.0, theta: 270 },
      { x: 8.0, y: 1.1, theta: 270 },
      { x: 3.6, y: 2.6, theta: 180, thetaOn: true },
    ]),
    path("Right start → hub", [
      { x: 3.55, y: 0.75, theta: 180, thetaOn: true },
      { x: 3.0, y: 2.7, theta: 150, thetaOn: true },
    ]),
    path("Depot run", [
      { x: 3.0, y: 2.7, theta: 150, thetaOn: true },
      { x: 0.8, y: 5.9, theta: 90 },
      { x: 2.9, y: 4.6, theta: 160, thetaOn: true },
    ]),
    path("Outpost pickup", [
      { x: 2.9, y: 4.6, theta: 160, thetaOn: true },
      { x: 0.7, y: 0.65, theta: 180, stop: true, thetaOn: true },
    ]),
    path("Bump crossing → neutral zone", [
      { x: 3.4, y: 2.4, theta: 0, thetaOn: true },
      { x: 5.9, y: 2.4, theta: 0 },
      { x: 7.6, y: 3.0, theta: 0, thetaOn: true },
    ]),
    path("Neutral zone return", [
      { x: 7.6, y: 3.0, theta: 180, thetaOn: true },
      { x: 3.3, y: 3.3, theta: 160, thetaOn: true },
    ]),
    path("Climb approach", [
      { x: 3.3, y: 3.3, theta: 160, thetaOn: true },
      { x: 1.25, y: 3.75, theta: 180, thetaOn: true },
    ]),
    path("Taxi only", [
      { x: 3.55, y: 4.0, theta: 180, thetaOn: true },
      { x: 5.2, y: 4.0, theta: 180, thetaOn: true },
    ]),
    path("Trench run (fast)", [
      { x: 3.4, y: 0.65, theta: 0, thetaOn: true },
      { x: 8.1, y: 0.65, theta: 0, thetaOn: true },
    ]),
    path("Defense: block the far lane", [
      { x: 3.6, y: 6.6, theta: 0, thetaOn: true },
      { x: 9.6, y: 6.2, theta: 0 },
      { x: 12.2, y: 5.0, theta: 0, thetaOn: true },
    ]),
  ];

  return {
    schemaVersion: "1.0",
    field: { ...ACTIVE_FIELD_REFERENCE },
    name: "Week 3 autos",
    robot: ROBOT,
    paths,
    pathLinks: [],
    routines: [],
    plannerId: "profiledSpline",
  };
}
