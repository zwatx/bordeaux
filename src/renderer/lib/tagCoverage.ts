import { REBUILT_2026_FIELD } from "../../core/field/rebuilt2026";
import { fieldTags, visibleTags, type TagSighting } from "../../core/tagVisibility";
import type { RobotCamera } from "../../core/types";

/** Every official tag on the active field, in the editor's field frame. */
const FIELD_TAGS = fieldTags(REBUILT_2026_FIELD);

/** The tag count the "Tags seen" color and graph treat as full: two tags fix a pose far better than one. */
export const TAGS_SEEN_FULL = 2;

/** A displayed robot pose, as the field's playback and hover use it: field meters and heading in radians. */
interface DisplayedPose { x: number; y: number; heading: number }

/** Each camera's readings of the active field's tags with the robot at `pose`. */
export function tagSightingsAt(pose: DisplayedPose, cameras: readonly RobotCamera[] | undefined): TagSighting[] {
  return cameras?.length ? visibleTags({ x: pose.x, y: pose.y, headingRad: pose.heading }, cameras, FIELD_TAGS) : [];
}

/** How many different tags the robot reads at `pose`, whichever cameras read them. */
export function tagsSeenAt(pose: DisplayedPose, cameras: readonly RobotCamera[] | undefined): number {
  return new Set(tagSightingsAt(pose, cameras).map((sighting) => sighting.tagId)).size;
}
