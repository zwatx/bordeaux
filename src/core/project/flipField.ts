import type { ControlPoint, PathDoc, RobotConfig, RotationDirection, TurnInPlace, Waypoint } from "../types";
import { wrapRadians } from "../math/angles";
import { deriveHeadingGeometry } from "../math/pm";
import { MAX_AUTHORED_ANGLE_DEG } from "../planners/limits";

export type FieldFlipDirection = "horizontal" | "vertical" | "rotate";

const mirrorMoving = (direction: RotationDirection): RotationDirection => direction === "cw" ? "ccw" : direction === "ccw" ? "cw" : direction;
const mirrorStationary = (direction: NonNullable<TurnInPlace["direction"]>): NonNullable<TurnInPlace["direction"]> =>
  direction === "clockwise" ? "counterclockwise" : direction === "counterclockwise" ? "clockwise" : direction;

function mirroredStationaryTies(path: PathDoc, robot: RobotConfig): Set<number> {
  const canTie = ({ turnInPlace, stop }: Waypoint, index: number) => turnInPlace
    ? !turnInPlace.direction || turnInPlace.direction === "shortest"
    : stop && index > 0 && index < path.waypoints.length - 1;
  const ties = new Set<number>();
  if (!path.waypoints.some(canTie)) return ties;
  const { head, wpIdx } = deriveHeadingGeometry(path, robot);
  path.waypoints.forEach((waypoint, index) => {
    if (!canTie(waypoint, index)) return;
    const { turnInPlace } = waypoint;
    const boundary = wpIdx[index];
    const incoming = head[turnInPlace && index > 0 ? Math.max(0, boundary - 1) : boundary];
    const target = turnInPlace ? turnInPlace.headingDeg * Math.PI / 180 : head[boundary + 1];
    const delta = wrapRadians(target - incoming);
    if (Math.abs(Math.abs(delta) - Math.PI) < 1e-12) ties.add(index);
  });
  return ties;
}

/** Apply a field-space isometry while keeping distances, constraints and path-relative event anchors. */
function flipFieldPath(path: PathDoc, direction: FieldFlipDirection, robot: RobotConfig): PathDoc {
  const mirrored = direction !== "rotate";
  const stationaryTies = mirrored ? mirroredStationaryTies(path, robot) : null;
  const point = ({ x, y }: ControlPoint): ControlPoint => ({
    x: direction === "vertical" ? x : -x,
    y: direction === "horizontal" ? y : -y,
  });
  // Keep raw authored angles so signed half-turns keep their interpolation branch.
  const heading = (degrees: number) => {
    const next = direction === "rotate" ? degrees + 180 : direction === "horizontal" ? 180 - degrees : -degrees;
    if (!Number.isFinite(next) || Math.abs(next) > MAX_AUTHORED_ANGLE_DEG) throw new Error("A transformed heading is outside the planner’s supported range.");
    return next;
  };
  return { ...path,
    waypoints: path.waypoints.map((waypoint, index) => {
      const tie = stationaryTies?.has(index);
      const turn = waypoint.turnInPlace;
      const transformed: Waypoint = { ...waypoint, ...point(waypoint),
        theta: heading(waypoint.theta), prevC: point(waypoint.prevC), nextC: point(waypoint.nextC),
        ...(waypoint.segmentLookAt ? { segmentLookAt: point(waypoint.segmentLookAt) } : {}),
        ...(mirrored && waypoint.rotationDirection ? { rotationDirection: mirrorMoving(waypoint.rotationDirection) } : {}),
        ...(turn ? { turnInPlace: { ...turn, headingDeg: heading(turn.headingDeg),
          ...(tie ? { direction: "clockwise" as const }
            : mirrored && turn.direction ? { direction: mirrorStationary(turn.direction) } : {}),
        } } : {}),
        ...(mirrored && waypoint.jiggle ? { jiggle: { ...waypoint.jiggle, startDeg: -waypoint.jiggle.startDeg, stepDeg: -waypoint.jiggle.stepDeg } } : {}),
      };
      // Keep an automatic turn anchored to the actual arrival heading.
      if (mirrored && !turn) {
        if (waypoint.implicitHalfTurnClockwise) delete transformed.implicitHalfTurnClockwise;
        else if (tie) transformed.implicitHalfTurnClockwise = true;
      }
      return transformed;
    }),
    targets: path.targets.map((target) => ({ ...target, deg: heading(target.deg),
      ...(mirrored && target.rotationDirection ? { rotationDirection: mirrorMoving(target.rotationDirection) } : {}),
    })),
  };
}

/** The path moved to the other side of the field. Waypoints Optimize added stay flagged; timing is replanned. */
export function flipPath(path: PathDoc, direction: FieldFlipDirection, robot: RobotConfig): PathDoc {
  return flipFieldPath(path, direction, robot);
}
