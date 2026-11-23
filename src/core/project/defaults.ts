import { autoHandles } from "../math/geometry";
import { FIELD_H, FIELD_W, clampWorldPoint } from "../math/fieldBounds";
import { ACTIVE_FIELD_REFERENCE } from "../field/rebuilt2026";
import { createPathId, createRoutineId } from "./ids";
import { robotDefaultConstraints } from "../robotLimits";
import type {
  BordeauxProject,
  PathConstraints,
  PathDoc,
  RobotConfig,
  SegmentType,
  Waypoint,
} from "../types";

export { FIELD_H, FIELD_W, clampWorldPoint };
export { createMarkerId, createPathId, createPathLinkId, createRoutineId } from "./ids";

export const DEFAULT_CONSTRAINTS: PathConstraints = {
  maxVel: 4.2,
  maxAccel: 6.5,
  maxDecel: 6.5,
  maxAngVel: 540,
  maxAngAccel: 720,
  maxAngDecel: 720,
  maxJerk: 0,
  maxAngJerk: 0,
};

type RawWaypoint = Partial<Waypoint> & {
  x: number;
  y: number;
  theta?: number;
  segType?: SegmentType;
};

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function buildWaypoints(raw: RawWaypoint[]): Waypoint[] {
  const out = raw.map((w) => ({
    linked: true,
    thetaOn: false,
    theta: 0,
    stop: false,
    ...w,
    ...clampWorldPoint(w),
  })) as Waypoint[];

  out.forEach((w, i) => {
    const handles = autoHandles(out, i);
    w.prevC = w.prevC ?? handles.prevC;
    w.nextC = w.nextC ?? handles.nextC;
  });

  if (out.length) {
    out[0].thetaOn = true;
    out[out.length - 1].thetaOn = true;
  }

  return out;
}

export function defaultPathConstraints(robot?: RobotConfig): PathConstraints {
  const constraints = { ...DEFAULT_CONSTRAINTS };
  return robot ? robotDefaultConstraints(constraints, robot) : constraints;
}

export function blankPath(name = "NewPath", robot?: RobotConfig): PathDoc {
  return {
    id: createPathId(),
    name,
    waypoints: buildWaypoints([
      { x: 2.2, y: 4.0, theta: 0, segType: "bezier" },
      { x: 5.0, y: 4.0, theta: 0 },
    ]),
    targets: [],
    markers: [],
    ranges: [],
    constraints: defaultPathConstraints(robot),
    headingMode: "targets",
    startVel: 0,
    goalVel: 0,
    exportable: true,
  };
}

export function createDemoProject(): BordeauxProject {
  const routine = {
    id: createRoutineId(),
    name: "Autonomous Routine",
    nodes: [],
  };
  const path = blankPath("NewPath");
  return {
    schemaVersion: "1.0",
    field: { ...ACTIVE_FIELD_REFERENCE },
    name: "Untitled",
    robot: { drive: "swerve", w: 0.84, l: 0.84, heightM: 0.5, maxSpeed: 5.0 },
    paths: [path],
    pathLinks: [],
    routines: [routine],
    activeRoutineId: routine.id,
    plannerId: "profiledSpline",
    editor: { activePathId: path.id },
  };
}
