import { describe, expect, it } from "vitest";
import { REBUILT_2026_FIELD } from "../src/core/field/rebuilt2026";
import { APRILTAG_SIZE_M, TAG_READ_LIMITS, fieldTags, pathTagCoverage, visibleTags, type FieldTag } from "../src/core/tagVisibility";
import { CAMERA_RANGE_DEFAULT_M } from "../src/core/robotCameras";
import type { RobotCamera } from "../src/core/types";

/*
 * Ways tag visibility can fail, written before the code:
 *  1. A tag behind the lens counts as seen.
 *  2. A tag counts as seen from behind its face.
 *  3. The robot's heading is left out, added with the wrong sign, or mixed up between degrees and radians.
 *  4. The camera's mount offset does not turn with the robot.
 *  5. Camera yaw turns the wrong way, or is not added to the robot's heading.
 *  6. Lens height, tag height or pitch is ignored, so a tag above or below the picture counts as seen.
 *  7. A tag whose center is in the picture but whose corner is cut off counts as seen.
 *  8. A tag too far away, or seen too far from straight on, counts as seen.
 *  9. Two cameras seeing one tag are merged into one sighting, or one camera's sighting is given to another.
 * 10. A robot without cameras, or a field without tags, throws.
 * 11. The field's tag facings point into the wall, so every result on the real field is backwards.
 * 13. A camera's own range is ignored, is applied to another camera, or a camera saved without one reads nothing.
 * 12. Coverage along a path counts one tag twice when two cameras see it, or loses the order of the samples.
 */
const camera = (patch: Partial<RobotCamera> = {}): RobotCamera => ({
  id: "front", name: "Front", horizontalFovDeg: 70, verticalFovDeg: 50, positionM: { x: 0, y: 0, z: 0.5 }, yawDeg: 0, pitchDeg: 0, ...patch,
});
/** A tag 3 m in front of the origin at lens height, facing back toward it. */
const ahead: FieldTag = { id: 1, point: { x: 3, y: 0 }, elevationM: 0.5, headingDeg: 180 };
const origin = { x: 0, y: 0, headingRad: 0 };
const seen = (pose: typeof origin, cameras: RobotCamera[], tags: FieldTag[]) => visibleTags(pose, cameras, tags).map((sighting) => `${sighting.cameraId}:${sighting.tagId}`);

describe("tag visibility", () => {
  it("sees a tag straight ahead and reports its distance and angle", () => {
    const [sighting, ...rest] = visibleTags(origin, [camera()], [ahead]);
    expect(rest).toEqual([]);
    expect(sighting).toMatchObject({ cameraId: "front", tagId: 1 });
    expect(sighting.distanceM).toBeCloseTo(3, 9);
    expect(sighting.skewDeg).toBeCloseTo(0, 6);
  });

  it("does not see a tag behind the lens or from behind its face", () => {
    expect(seen(origin, [camera()], [{ ...ahead, point: { x: -3, y: 0 }, headingDeg: 0 }])).toEqual([]);
    expect(seen(origin, [camera()], [{ ...ahead, headingDeg: 0 }])).toEqual([]);
  });

  it("turns with the robot's heading, in radians", () => {
    const left: FieldTag = { id: 2, point: { x: 0, y: 3 }, elevationM: 0.5, headingDeg: -90 };
    expect(seen(origin, [camera()], [ahead, left])).toEqual(["front:1"]);
    expect(seen({ ...origin, headingRad: Math.PI / 2 }, [camera()], [ahead, left])).toEqual(["front:2"]);
    expect(seen({ ...origin, headingRad: -Math.PI / 2 }, [camera()], [ahead, left])).toEqual([]);
  });

  it("adds camera yaw to the heading, positive to the left", () => {
    const left: FieldTag = { id: 2, point: { x: 0, y: 3 }, elevationM: 0.5, headingDeg: -90 };
    expect(seen(origin, [camera({ yawDeg: 90 })], [ahead, left])).toEqual(["front:2"]);
    expect(seen(origin, [camera({ yawDeg: -90 })], [ahead, left])).toEqual([]);
    expect(seen({ ...origin, headingRad: -Math.PI / 2 }, [camera({ yawDeg: 90 })], [ahead, left])).toEqual(["front:1"]);
  });

  it("carries the mount offset around with the robot", () => {
    // 2.9 m forward of center puts the lens 0.1 m from the tag: too close for the whole tag to fit in the picture.
    const far = camera({ positionM: { x: 2.9, y: 0, z: 0.5 } });
    expect(seen(origin, [far], [ahead])).toEqual([]);
    // Facing away, the same offset puts the lens 5.9 m from the tag, looking the other way.
    expect(seen({ ...origin, headingRad: Math.PI }, [far], [ahead])).toEqual([]);
    const side = camera({ positionM: { x: 0, y: 1, z: 0.5 } });
    const [sighting] = visibleTags({ ...origin, headingRad: Math.PI / 2 }, [side], [{ id: 3, point: { x: -1, y: 3 }, elevationM: 0.5, headingDeg: -90 }]);
    // Heading +Y moves a mount 1 m to the robot's left to x = -1, straight under the tag's line.
    expect(sighting.distanceM).toBeCloseTo(3, 9);
    expect(sighting.skewDeg).toBeCloseTo(0, 6);
  });

  it("uses lens height, tag height and pitch", () => {
    const high: FieldTag = { ...ahead, elevationM: 2.5 };
    expect(seen(origin, [camera()], [high])).toEqual([]);
    expect(seen(origin, [camera({ pitchDeg: 30 })], [high])).toEqual(["front:1"]);
    expect(seen(origin, [camera({ pitchDeg: -30 })], [high])).toEqual([]);
    expect(seen(origin, [camera({ positionM: { x: 0, y: 0, z: 2.5 } })], [high])).toEqual(["front:1"]);
    expect(seen(origin, [camera({ pitchDeg: 30 })], [ahead])).toEqual([]);
  });

  it("needs the whole tag in the picture, not only its center", () => {
    // Half the horizontal field of view is 35 degrees. The tag's center sits just inside that edge, so one side is cut off.
    const at = (deg: number): FieldTag => ({ id: 4, point: { x: 3 * Math.cos(deg * Math.PI / 180), y: 3 * Math.sin(deg * Math.PI / 180) }, elevationM: 0.5, headingDeg: 180 + deg });
    const halfTagDeg = Math.atan(APRILTAG_SIZE_M / 2 / 3) * 180 / Math.PI;
    expect(seen(origin, [camera()], [at(35 - halfTagDeg / 2)])).toEqual([]);
    expect(seen(origin, [camera()], [at(35 - halfTagDeg * 1.5)])).toEqual(["front:4"]);
    expect(seen(origin, [camera()], [at(-(35 - halfTagDeg * 1.5))])).toEqual(["front:4"]);
  });

  it("stops at the reading distance and the reading angle", () => {
    const at = (distanceM: number): FieldTag => ({ ...ahead, point: { x: distanceM, y: 0 } });
    expect(seen(origin, [camera()], [at(TAG_READ_LIMITS.maxDistanceM - 0.01)])).toEqual(["front:1"]);
    expect(seen(origin, [camera()], [at(TAG_READ_LIMITS.maxDistanceM + 0.01)])).toEqual([]);
    const turned = (skewDeg: number): FieldTag => ({ ...ahead, headingDeg: 180 + skewDeg });
    expect(visibleTags(origin, [camera()], [turned(40)])[0].skewDeg).toBeCloseTo(40, 6);
    expect(seen(origin, [camera()], [turned(TAG_READ_LIMITS.maxSkewDeg - 1)])).toEqual(["front:1"]);
    expect(seen(origin, [camera()], [turned(TAG_READ_LIMITS.maxSkewDeg + 1)])).toEqual([]);
    expect(seen(origin, [camera()], [turned(-(TAG_READ_LIMITS.maxSkewDeg + 1))])).toEqual([]);
  });

  it("stops each camera at its own range, and uses the default for a camera without one", () => {
    const at = (distanceM: number): FieldTag => ({ ...ahead, point: { x: distanceM, y: 0 } });
    const short = camera({ id: "short", maxRangeM: 2 }), long = camera({ id: "long", maxRangeM: 9 }), unset = camera({ id: "unset" });
    expect(seen(origin, [short, long, unset], [at(1.9)])).toEqual(["short:1", "long:1", "unset:1"]);
    expect(seen(origin, [short, long, unset], [at(2.1)])).toEqual(["long:1", "unset:1"]);
    expect(seen(origin, [short, long, unset], [at(CAMERA_RANGE_DEFAULT_M + 0.1)])).toEqual(["long:1"]);
    expect(seen(origin, [short, long, unset], [at(9.1)])).toEqual([]);
    expect(TAG_READ_LIMITS.maxDistanceM).toBe(CAMERA_RANGE_DEFAULT_M);
  });

  it("reports each camera's own sightings", () => {
    const behind: FieldTag = { id: 5, point: { x: -3, y: 0 }, elevationM: 0.5, headingDeg: 0 };
    const cameras = [camera(), camera({ id: "front2", positionM: { x: 0, y: 0.2, z: 0.5 } }), camera({ id: "rear", yawDeg: 180 })];
    expect(seen(origin, cameras, [ahead, behind])).toEqual(["front:1", "front2:1", "rear:5"]);
  });

  it("returns nothing without cameras or tags", () => {
    expect(visibleTags(origin, [], [ahead])).toEqual([]);
    expect(visibleTags(origin, [camera()], [])).toEqual([]);
  });

  it("reads every official tag facing into the field", () => {
    const tags = fieldTags(REBUILT_2026_FIELD);
    const { lengthM, widthM } = REBUILT_2026_FIELD.dimensions;
    expect(tags).toHaveLength(32);
    expect(new Set(tags.map((tag) => tag.id)).size).toBe(32);
    for (const tag of tags) {
      const heading = tag.headingDeg * Math.PI / 180;
      const out = { x: tag.point.x + Math.cos(heading) * 1.5, y: tag.point.y + Math.sin(heading) * 1.5 };
      // The field's origin is its center. A point 1.5 m out of a tag's face is on the carpet, never past a wall.
      expect(Math.abs(out.x), `tag ${tag.id}`).toBeLessThan(lengthM / 2);
      expect(Math.abs(out.y), `tag ${tag.id}`).toBeLessThan(widthM / 2);
      // A robot standing there and facing the tag reads it; facing away it does not.
      const lens = camera({ positionM: { x: 0, y: 0, z: tag.elevationM } });
      expect(seen({ ...out, headingRad: heading + Math.PI }, [lens], [tag]), `tag ${tag.id}`).toEqual([`front:${tag.id}`]);
      expect(seen({ ...out, headingRad: heading }, [lens], [tag]), `tag ${tag.id}`).toEqual([]);
    }
  });

  it("lists the tags seen at each sample of a path, once each", () => {
    const behind: FieldTag = { id: 5, point: { x: -3, y: 0 }, elevationM: 0.5, headingDeg: 0 };
    const cameras = [camera(), camera({ id: "front2", positionM: { x: 0, y: 0.2, z: 0.5 } })];
    const samples = [{ t: 0, ...origin }, { t: 0.5, x: 0, y: 0, headingRad: Math.PI / 2 }, { t: 1, x: 0, y: 0, headingRad: Math.PI }];
    expect(pathTagCoverage(samples, cameras, [behind, ahead])).toEqual([
      { t: 0, tagIds: [1] }, { t: 0.5, tagIds: [] }, { t: 1, tagIds: [5] },
    ]);
    expect(pathTagCoverage([], cameras, [ahead])).toEqual([]);
  });
});
