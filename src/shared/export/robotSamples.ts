import type { TrajectorySample } from "../types";

const MAX_INTERVAL_S = 0.020;
const MAX_SAMPLES = 100_000;
const fields = ["t", "s", "f", "x", "y", "headingRad", "velocityMps", "accelerationMps2", "angularVelocityRadps", "curvatureInvM"] as const;
const angleBetween = (before: number, after: number, ratio: number) => before
  + Math.atan2(Math.sin(after - before), Math.cos(after - before)) * ratio;

/** Subdivide timestamp intervals without removing velocity corners or authored boundaries. */
export function densifyRobotSamples(samples: readonly TrajectorySample[], headings: readonly number[], curvatures: readonly number[] = samples.map(sample => sample.curvatureInvM)) {
  if (samples.length < 2 || samples.length > MAX_SAMPLES || headings.length !== samples.length || curvatures.length !== samples.length) {
    throw new Error("BDX sample count or travel headings are invalid");
  }
  // Check the complete allocation first, including pathological low-speed paths.
  const divisions = samples.map((sample, index) => {
    if (sample.i !== index || fields.some((field) => !Number.isFinite(sample[field])) || !Number.isFinite(headings[index]) || !Number.isFinite(curvatures[index])) {
      throw new Error("BDX sample values/indexes are invalid");
    }
    const duration = index ? sample.t - samples[index - 1].t : 0;
    if (duration < 0) throw new Error("BDX sample time must be nondecreasing");
    return index ? Math.max(1, Math.ceil(duration / MAX_INTERVAL_S - 1e-9)) : 0;
  });
  const count = 1 + divisions.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(count) || count > MAX_SAMPLES) throw new Error(`BDX 20 ms sampling exceeds ${MAX_SAMPLES} samples`);

  const output: TrajectorySample[] = [{ ...samples[0], i: 0 }];
  const travelHeadings = [headings[0]];
  const outputCurvatures = [curvatures[0]];
  const sourceIndices = [0];
  for (let index = 1; index < samples.length; index += 1) {
    const before = samples[index - 1], after = samples[index];
    for (let step = 1; step < divisions[index]; step += 1) {
      const ratio = step / divisions[index];
      const sample = { ...before, i: output.length };
      // Match the timestamped reader's linear interpolation. In particular,
      // retain f independently of s (stationary actions can advance s alone).
      for (const field of fields) sample[field] = before[field] + (after[field] - before[field]) * ratio;
      sample.headingRad = angleBetween(before.headingRad, after.headingRad, ratio);
      output.push(sample);
      travelHeadings.push(angleBetween(headings[index - 1], headings[index], ratio));
      outputCurvatures.push(curvatures[index - 1] + (curvatures[index] - curvatures[index - 1]) * ratio);
    }
    sourceIndices.push(output.length);
    output.push({ ...after, i: output.length });
    travelHeadings.push(headings[index]);
    outputCurvatures.push(curvatures[index]);
  }
  return { samples: output, travelHeadings, sourceIndices, curvatures: outputCurvatures };
}
