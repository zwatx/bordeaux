import type { FieldPoint } from "./types";

/**
 * WPILib's field metadata format, one JSON file per field variant under
 * `fields/src/main/native/resources/org/wpilib/fields/frc/` in allwpilib (2027 and later).
 * The vendored file holds the same tag poses as the layout robot code loads through
 * `AprilTagFieldLayout` for the same field variant, so tags drawn from it sit where that
 * robot's localization believes they are.
 *
 * Each season: copy the new game's file from the WPILib release unchanged into `./wpilib/`,
 * import it in the field pack, and pin its URL and sha256 in the pack's `sources`.
 * Annotating the import with this type makes a format change fail the build.
 */
export interface WpilibFieldLayout {
  name: string;
  season: string;
  "field-dimensions": { length: number; width: number };
  "field-tags": ReadonlyArray<{
    ID: number;
    pose: {
      translation: { x: number; y: number; z: number };
      rotation: { quaternion: { W: number; X: number; Y: number; Z: number } };
    };
  }>;
}

/** A tag pose in WPILib's blue-origin frame: +X toward red, yaw counterclockwise from +X. */
export interface WpilibFieldTag {
  id: number;
  point: FieldPoint;
  elevationM: number;
  yawDeg: number;
}

/** Reads each tag's floor position, height and facing direction. Tag pitch is ignored; the field is drawn top-down. */
export function wpilibFieldTags(layout: WpilibFieldLayout): WpilibFieldTag[] {
  return layout["field-tags"].map(({ ID, pose: { translation, rotation: { quaternion: q } } }) => ({
    id: ID,
    point: { x: translation.x, y: translation.y },
    elevationM: translation.z,
    // Rounded so float noise in the quaternion (W = 6e-17 for a 180-degree tag) stays out of the data.
    yawDeg: Math.round(Math.atan2(2 * (q.W * q.Z + q.X * q.Y), 1 - 2 * (q.Y * q.Y + q.Z * q.Z)) * 180 / Math.PI * 1e9) / 1e9,
  }));
}
