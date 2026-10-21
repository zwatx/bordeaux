import { FIELD_H, FIELD_W } from "../math/fieldBounds";
import type { BordeauxProject, ControlPoint, PathDoc } from "../types";
import { acceptedTrajectoryShapeError, optimizationInputKey } from "../planners/acceptedTrajectoryIdentity";
import { routeIntentKey } from "../planners/routeIdentity";
import { routePlanningPath } from "../planners/routeGeometry";

export const oppositeAlliancePoint = (point: ControlPoint): ControlPoint => ({ x: FIELD_W - point.x, y: FIELD_H - point.y });
// Keep the interpolation branch, including the sign of an exact 180-degree turn.
const oppositeHeading = (degrees: number) => degrees + 180;

/** A physical half-turn, with unchanged distances, timing anchors and robot-local settings. */
export function flipFieldPath(path: PathDoc): PathDoc {
  return { ...path,
    waypoints: path.waypoints.map((waypoint) => ({ ...waypoint, ...oppositeAlliancePoint(waypoint),
      theta: oppositeHeading(waypoint.theta), prevC: oppositeAlliancePoint(waypoint.prevC), nextC: oppositeAlliancePoint(waypoint.nextC),
      ...(waypoint.segmentLookAt ? { segmentLookAt: oppositeAlliancePoint(waypoint.segmentLookAt) } : {}),
      ...(waypoint.turnInPlace ? { turnInPlace: { ...waypoint.turnInPlace, headingDeg: oppositeHeading(waypoint.turnInPlace.headingDeg) } } : {}),
    })),
    targets: path.targets.map((target) => ({ ...target, deg: oppositeHeading(target.deg) })),
  };
}

/** Flip every authored path once, preserving shared positions, endpoint links and routine references. */
export function flipProjectPaths(project: BordeauxProject, qualifyAccepted?: (path: PathDoc) => boolean): BordeauxProject {
  const paths = project.paths.map((path) => {
    const flipped = flipFieldPath(path), accepted = path.optimization?.accepted;
    const key = accepted?.version === 2 ? routeIntentKey(path, project.robot, project.field) : optimizationInputKey(path, project.robot, project.field);
    if (!accepted || accepted.inputKey !== key) return flipped;
    // The worker must qualify the original artifact before reconstruction can
    // rewrite any semantics. Invalid current selections require explicit recovery.
    if (acceptedTrajectoryShapeError(accepted) || !qualifyAccepted?.(path)) {
      throw new Error(`${path.name}: The applied optimization is invalid or unverified. Choose Use normal or optimize and apply again before flipping.`);
    }
    const result = accepted.result;
    const routeGeometry = result.routeGeometry && { ...result.routeGeometry, knots: result.routeGeometry.knots.map((knot) => ({ ...knot,
      ...oppositeAlliancePoint(knot), prevC: oppositeAlliancePoint(knot.prevC), nextC: oppositeAlliancePoint(knot.nextC) })) };
    const transformed = { ...result,
      samples: result.samples.map((sample) => ({ ...sample, ...oppositeAlliancePoint(sample), headingRad: sample.headingRad + Math.PI })),
      ...(routeGeometry ? { routeGeometry, optimizedPath: routePlanningPath(flipped, routeGeometry) }
        : result.optimizedPath ? { optimizedPath: flipFieldPath(result.optimizedPath) } : {}),
    };
    flipped.optimization = { ...flipped.optimization, accepted: { ...accepted, result: transformed,
      inputKey: accepted.version === 2 ? routeIntentKey(flipped, project.robot, project.field) : optimizationInputKey(flipped, project.robot, project.field) } };
    return flipped;
  });
  return { ...project, paths };
}
