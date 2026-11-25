import { FIELD_H, FIELD_W } from "../math/fieldBounds";
import type { BordeauxProject, ControlPoint, PathDoc, RobotConfig, RotationDirection, TurnInPlace, Waypoint } from "../types";
import { wrapRadians } from "../math/angles";
import { deriveHeadingGeometry } from "../math/pm";
import { acceptedTrajectoryShapeError, optimizationInputKey } from "../planners/acceptedTrajectoryIdentity";
import { MAX_AUTHORED_ANGLE_DEG } from "../planners/limits";
import { routeIntentKey } from "../planners/routeIdentity";
import { routePlanningPath } from "../planners/routeGeometry";

export type FieldFlipDirection = "horizontal" | "vertical" | "rotate";
type PlanningContext = Pick<BordeauxProject, "robot" | "field">;

const oppositeAlliancePoint = ({ x, y }: ControlPoint): ControlPoint => ({ x: FIELD_W - x, y: FIELD_H - y });
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
    x: direction === "vertical" ? x : FIELD_W - x,
    y: direction === "horizontal" ? y : FIELD_H - y,
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

/** Only a rigid half-turn of the current path can carry its qualified robot trajectory forward. */
export function flipPath(path: PathDoc, direction: FieldFlipDirection, { robot, field }: PlanningContext,
  qualifyAccepted: (path: PathDoc) => boolean, copy = false): PathDoc {
  const flipped = flipFieldPath(path, direction, robot), accepted = path.optimization?.accepted;
  const keyFor = accepted?.version === 2 ? routeIntentKey : optimizationInputKey;
  if (direction !== "rotate" || copy || accepted && accepted.inputKey !== keyFor(path, robot, field)) {
    // Replan a reflection with the actual robot. A stale selection cannot reactivate at the transformed geometry.
    const corridorM = path.optimization?.corridorM;
    if (corridorM === undefined) delete flipped.optimization;
    else flipped.optimization = { corridorM };
    return flipped;
  }
  if (!accepted) return flipped;
  if (acceptedTrajectoryShapeError(accepted) || !qualifyAccepted(path)) {
    throw new Error(`${path.name}: The applied optimization is invalid or unverified. Choose Use normal or optimize and apply again before flipping.`);
  }
  const result = accepted.result;
  const routeGeometry = result.routeGeometry && { ...result.routeGeometry, knots: result.routeGeometry.knots.map((knot) => ({ ...knot,
    ...oppositeAlliancePoint(knot), prevC: oppositeAlliancePoint(knot.prevC), nextC: oppositeAlliancePoint(knot.nextC) })) };
  const transformed = { ...result,
    samples: result.samples.map((sample) => ({ ...sample, ...oppositeAlliancePoint(sample), headingRad: sample.headingRad + Math.PI })),
    ...(routeGeometry ? { routeGeometry, optimizedPath: routePlanningPath(flipped, routeGeometry) }
      : result.optimizedPath ? { optimizedPath: flipFieldPath(result.optimizedPath, "rotate", robot) } : {}),
  };
  flipped.optimization = { ...flipped.optimization, accepted: { ...accepted, result: transformed, inputKey: keyFor(flipped, robot, field) } };
  return flipped;
}
