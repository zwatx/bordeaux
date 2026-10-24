import { expect, it } from "vitest";
import { binaryWriterFixture } from "./fixtures/binaryWriterFixture";
import { buildRobotBinary } from "../src/shared/export/robotBinary";
import { buildWaypoints } from "../src/shared/project/defaults";

function samplesFromBytes(bytes: Uint8Array) {
  const buffer = Buffer.from(bytes);
  let cursor = 32;
  const metadataLength = buffer.readUInt32BE(cursor); cursor += 4 + metadataLength;
  const count = buffer.readUInt32BE(cursor); cursor += 4;
  return Array.from({ length: count }, () => Array.from({ length: 15 }, () => {
    const value = buffer.readDoubleBE(cursor); cursor += 8; return value;
  }));
}

it("preserves straight-path velocity area through actual BDX timestamps as acceleration changes", () => {
  const rows = [0.3, 1, 3, 8].map(accel => {
    const f = binaryWriterFixture(false, false);
    f.path.waypoints = buildWaypoints([{ x: 2, y: 4, theta: 0, segType: "bezier" }, { x: 5, y: 4, theta: 0 }]);
    f.path.constraints.maxAccel = accel;
    f.path.constraints.maxDecel = accel;
    const built = buildRobotBinary(f.project, { kind: "path", id: f.path.id }, f.bindings);
    const samples = samplesFromBytes(built.bytes);
    let area = 0, dx = 0, fixedCadenceArea = 0, truncatedTimedArea = 0;
    const oldLoopCutoff = (samples.length - 1) * 0.02;
    const intervals: number[] = [];
    for (let i = 1; i < samples.length; i++) {
      const before = samples[i - 1], after = samples[i], dt = after[0] - before[0];
      intervals.push(dt);
      expect(Math.abs((after[7] - before[7]) / dt)).toBeLessThanOrEqual(accel + 0.0002);
      area += (before[7] + after[7]) * 0.5 * dt;
      dx += (before[7] * Math.cos(before[6]) + after[7] * Math.cos(after[6])) * 0.5 * dt;
      fixedCadenceArea += (before[7] + after[7]) * 0.5 * 0.02;
      const elapsed = Math.max(0, Math.min(dt, oldLoopCutoff - before[0]));
      const endVelocity = dt > 0 ? before[7] + (after[7] - before[7]) * elapsed / dt : before[7];
      truncatedTimedArea += (before[7] + endVelocity) * 0.5 * elapsed;
    }
    expect(Math.max(...intervals)).toBeLessThanOrEqual(0.020000001);
    expect(area).toBeCloseTo(3, 5);
    expect(dx).toBeCloseTo(3, 5);
    expect(oldLoopCutoff).toBeGreaterThanOrEqual(samples.at(-1)![0]);
    expect(truncatedTimedArea).toBeCloseTo(area, 12);
    return { accel, duration: samples.at(-1)![0], count: samples.length, area, dx, minDt: Math.min(...intervals), maxDt: Math.max(...intervals), fixedCadenceArea, oldLoopCutoff, truncatedTimedArea };
  });
  expect(rows[0].count).toBeGreaterThan(rows.at(-1)!.count);
  expect(rows[0].duration).toBeGreaterThan(rows.at(-1)!.duration);
  if (process.env.BORDEAUX_DISTANCE_PROBE === "1") process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
});
