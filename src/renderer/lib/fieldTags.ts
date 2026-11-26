import { REBUILT_2026_FIELD } from "../../core/field/rebuilt2026";
import { worldToFieldImage } from "../../core/field/imageCalibration";

/** Printed width of an FRC AprilTag (36h11, 6.5 in), drawn to scale once the field is zoomed in. */
export const TAG_WIDTH_M = 6.5 * 0.0254;

/** An AprilTag as the field view draws it, in field-image pixels (y down). */
export interface FieldTagMark {
  id: number;
  /** Center of the tag face. */
  point: { x: number; y: number };
  /** Unit vector out of the tag face, toward the robots that can read it. */
  facing: { x: number; y: number };
}

/** Every official tag on the active field. Number, position and facing all come from the vendored WPILib
 * layout through the field pack; nothing here is hand-written. */
export const FIELD_TAG_MARKS: readonly FieldTagMark[] = REBUILT_2026_FIELD.landmarks.flatMap((landmark): FieldTagMark[] => {
  if (!landmark.id.startsWith("apriltag-") || !landmark.point || landmark.headingDeg === undefined) return [];
  const heading = landmark.headingDeg * Math.PI / 180;
  return [{
    id: Number(landmark.id.slice("apriltag-".length)),
    point: worldToFieldImage(landmark.point),
    // The image's y axis points down, so the world +Y component flips.
    facing: { x: Math.cos(heading), y: -Math.sin(heading) },
  }];
});

/** The tag nearest an image point within `radius` image pixels, for hover. */
export function tagMarkAt(point: { x: number; y: number }, radius: number): FieldTagMark | null {
  let best: FieldTagMark | null = null, bestDistance = radius;
  for (const tag of FIELD_TAG_MARKS) {
    const distance = Math.hypot(tag.point.x - point.x, tag.point.y - point.y);
    if (distance <= bestDistance) { best = tag; bestDistance = distance; }
  }
  return best;
}
