import type { FieldPack, FieldPoint } from "./field/types";
import { CAMERA_RANGE_DEFAULT_M, cameraAxes } from "./robotCameras";
import type { RobotCamera } from "./types";

/** Printed width of an FRC AprilTag (36h11, 6.5 in). */
export const APRILTAG_SIZE_M = 6.5 * 0.0254;

/**
 * How far and how far from straight on a camera is taken to read a tag. The distance applies to a camera without a
 * range of its own. The angle is a round working number, not a measurement of any camera.
 */
export const TAG_READ_LIMITS = { maxDistanceM: CAMERA_RANGE_DEFAULT_M, maxSkewDeg: 60 } as const;

/** An AprilTag in the editor's field frame: the center of its face, its height, and the direction its face points. */
export interface FieldTag {
  id: number;
  point: FieldPoint;
  elevationM: number;
  /** Direction out of the face, degrees counterclockwise from +X. Tags stand upright. */
  headingDeg: number;
}

/** One camera reading one tag. */
export interface TagSighting {
  cameraId: string;
  tagId: number;
  /** Lens to tag center, meters. */
  distanceM: number;
  /** Angle between the line to the lens and straight out of the tag's face, degrees. 0 is head on. */
  skewDeg: number;
}

/** Every official tag on a field. Tags stand upright on every field so far, so only their yaw is kept. */
export function fieldTags(field: FieldPack): FieldTag[] {
  return field.landmarks.flatMap((landmark): FieldTag[] =>
    landmark.id.startsWith("apriltag-") && landmark.point && landmark.elevationM !== undefined && landmark.headingDeg !== undefined
      ? [{ id: Number(landmark.id.slice("apriltag-".length)), point: landmark.point, elevationM: landmark.elevationM, headingDeg: landmark.headingDeg }]
      : []);
}

/**
 * The tags each camera reads with the robot at `pose` (field meters, heading counterclockwise from +X), in camera
 * order and then tag order. A camera reads a tag when all four corners of the tag are inside its picture, the lens is
 * in front of the tag's face within `limits.maxSkewDeg` of straight on, and the tag's center is within the camera's
 * own `maxRangeM`, or `limits.maxDistanceM` for a camera without one. Nothing blocks the view: field structures and the robot's own parts are not considered.
 */
export function visibleTags(
  pose: { x: number; y: number; headingRad: number },
  cameras: readonly RobotCamera[],
  tags: readonly FieldTag[],
  limits: { maxDistanceM: number; maxSkewDeg: number } = TAG_READ_LIMITS,
): TagSighting[] {
  const cos = Math.cos(pose.headingRad), sin = Math.sin(pose.headingRad);
  const headingDeg = pose.headingRad * 180 / Math.PI;
  const half = APRILTAG_SIZE_M / 2;
  const sightings: TagSighting[] = [];
  for (const camera of cameras) {
    // The mount offset and the lens direction both turn with the robot.
    const lens = {
      x: pose.x + camera.positionM.x * cos - camera.positionM.y * sin,
      y: pose.y + camera.positionM.x * sin + camera.positionM.y * cos,
      z: camera.positionM.z,
    };
    const { forward, left, up } = cameraAxes({ yawDeg: camera.yawDeg + headingDeg, pitchDeg: camera.pitchDeg });
    const across = Math.tan(camera.horizontalFovDeg / 2 * Math.PI / 180), along = Math.tan(camera.verticalFovDeg / 2 * Math.PI / 180);
    const maxDistanceM = camera.maxRangeM ?? limits.maxDistanceM;
    const inPicture = (x: number, y: number, z: number) => {
      const dx = x - lens.x, dy = y - lens.y, dz = z - lens.z;
      const depth = dx * forward.x + dy * forward.y + dz * forward.z;
      return depth > 1e-9
        && Math.abs(dx * left.x + dy * left.y + dz * left.z) <= depth * across
        && Math.abs(dx * up.x + dy * up.y + dz * up.z) <= depth * along;
    };
    for (const tag of tags) {
      const facing = tag.headingDeg * Math.PI / 180, nx = Math.cos(facing), ny = Math.sin(facing);
      const dx = lens.x - tag.point.x, dy = lens.y - tag.point.y, dz = lens.z - tag.elevationM;
      const distanceM = Math.hypot(dx, dy, dz);
      if (distanceM > maxDistanceM || distanceM < 1e-9) continue;
      const skewDeg = Math.acos(Math.max(-1, Math.min(1, (dx * nx + dy * ny) / distanceM))) * 180 / Math.PI;
      if (skewDeg > limits.maxSkewDeg) continue;
      // The face's sideways direction lies flat, at right angles to its normal.
      const sx = -ny * half, sy = nx * half;
      const whole = [[1, 1], [1, -1], [-1, 1], [-1, -1]].every(([side, rise]) =>
        inPicture(tag.point.x + sx * side, tag.point.y + sy * side, tag.elevationM + half * rise));
      if (whole) sightings.push({ cameraId: camera.id, tagId: tag.id, distanceM, skewDeg });
    }
  }
  return sightings;
}

/**
 * The tags the robot reads at each sample of a planned path, each tag once however many cameras read it, in tag
 * order. Pass the planner's own samples so coverage shares their timing with playback and export.
 */
export function pathTagCoverage(
  samples: ReadonlyArray<{ t: number; x: number; y: number; headingRad: number }>,
  cameras: readonly RobotCamera[],
  tags: readonly FieldTag[],
): Array<{ t: number; tagIds: number[] }> {
  return samples.map((sample) => ({
    t: sample.t,
    tagIds: [...new Set(visibleTags(sample, cameras, tags).map((sighting) => sighting.tagId))].sort((a, b) => a - b),
  }));
}
