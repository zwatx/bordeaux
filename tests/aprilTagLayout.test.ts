import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REBUILT_2026_FIELD } from "../src/core/field/rebuilt2026";

// FIRST 2026 Field Dimension Drawings (FE-2026 rev B), sheet 11, "AndyMark Perimeter" table.
// Inches from the blue-origin corner, yaw in degrees. FIRST prints this table at kickoff;
// it is independent of the WPILib file the field pack reads, so it catches transcription or frame errors.
const FIRST_ANDYMARK_TABLE: ReadonlyArray<readonly [id: number, x: number, y: number, z: number, yaw: number]> = [
  [1, 467.08, 291.79, 35, 180], [2, 468.56, 182.08, 44.25, 90], [3, 444.8, 172.32, 44.25, 180], [4, 444.8, 158.32, 44.25, 180],
  [5, 468.56, 134.56, 44.25, 270], [6, 467.08, 24.85, 35, 180], [7, 470.03, 24.85, 35, 0], [8, 482.56, 134.56, 44.25, 270],
  [9, 492.33, 144.32, 44.25, 0], [10, 492.33, 158.32, 44.25, 0], [11, 482.56, 182.08, 44.25, 90], [12, 470.03, 291.79, 35, 0],
  [13, 649.58, 291.02, 21.75, 180], [14, 649.58, 274.02, 21.75, 180], [15, 649.57, 169.78, 21.75, 180], [16, 649.57, 152.78, 21.75, 180],
  [17, 183.03, 24.85, 35, 0], [18, 181.56, 134.56, 44.25, 270], [19, 205.32, 144.32, 44.25, 0], [20, 205.32, 158.32, 44.25, 0],
  [21, 181.56, 182.08, 44.25, 90], [22, 183.03, 291.79, 35, 0], [23, 180.08, 291.79, 35, 180], [24, 167.56, 182.08, 44.25, 90],
  [25, 157.79, 172.32, 44.25, 180], [26, 157.79, 158.32, 44.25, 180], [27, 167.56, 134.56, 44.25, 270], [28, 180.08, 24.85, 35, 180],
  [29, 0.54, 25.62, 21.75, 0], [30, 0.54, 42.62, 21.75, 0], [31, 0.55, 146.86, 21.75, 0], [32, 0.55, 163.86, 21.75, 0],
];
const IN = 0.0254;
// FIRST rounds to 0.01 in.
const TABLE_TOLERANCE_M = 0.006 * IN;

describe("AprilTag layout", () => {
  it("reads the vendored file named and hashed in the field pack's sources", () => {
    const bytes = readFileSync(new URL("../src/core/field/wpilib/2026-rebuilt-andymark.json", import.meta.url));
    const source = REBUILT_2026_FIELD.sources.find((item) => item.url.endsWith("/fields/frc/2026-rebuilt-andymark.json"));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(source?.sha256);
  });

  it("places every tag where FIRST's AndyMark table puts it, in the center-origin frame", () => {
    const tags = REBUILT_2026_FIELD.landmarks.filter((item) => item.id.startsWith("apriltag-"));
    expect(tags.map((tag) => tag.id)).toEqual(FIRST_ANDYMARK_TABLE.map(([id]) => `apriltag-${id}`));
    const { lengthM, widthM } = REBUILT_2026_FIELD.dimensions;
    for (const [id, x, y, z, yaw] of FIRST_ANDYMARK_TABLE) {
      const tag = tags.find((item) => item.id === `apriltag-${id}`)!;
      // The center-origin frame is the blue-origin frame turned 180 degrees about the field center.
      expect(Math.abs(tag.point!.x - (lengthM / 2 - x * IN)), `tag ${id} x`).toBeLessThan(TABLE_TOLERANCE_M);
      expect(Math.abs(tag.point!.y - (widthM / 2 - y * IN)), `tag ${id} y`).toBeLessThan(TABLE_TOLERANCE_M);
      expect(tag.elevationM, `tag ${id} z`).toBeCloseTo(z * IN, 4);
      expect((((tag.headingDeg! - (yaw + 180)) % 360) + 360) % 360, `tag ${id} heading`).toBeCloseTo(0, 6);
      expect(tag.navigable).toBe(false);
    }
  });
});
