import { decodeBdx, type DecodedBdx } from "../core/export/bdxReader";

function requirePath(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(`Invalid BDX path data: ${detail}`);
}

const close = (actual: number, expected: number) =>
  Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected));

/** The shared decoder checks the container. Comparison also needs a bounded, coherent trajectory. */
export function inspectRobotPath(bytes: Uint8Array): DecodedBdx {
  const path = decodeBdx(bytes);
  const { samples, followSections, events, totalTimeS, totalDistanceM, robot, field } = path;
  const text = (value: string, limit = 256, optional = false) =>
    (optional && !value || Boolean(value.trim())) && !value.includes("\0") && Buffer.byteLength(value) <= limit;
  requirePath(text(path.id) && text(path.name, 1024) && text(path.planner) && text(field.id)
    && text(field.revision) && text(field.coordinateSchemaId) && text(path.commandProtocolId, 256, true)
    && text(path.catalogHash, 256, true), "invalid path metadata");
  requirePath(totalTimeS >= 0 && totalDistanceM >= 0 && robot.widthM > 0 && robot.lengthM > 0 && robot.maxSpeedMps > 0,
    "invalid duration, distance or robot dimensions");
  requirePath(samples.length >= 2 && samples.length <= 100_000, "invalid sample count");
  requirePath(samples[0].t === 0 && samples[0].s === 0, "samples must start at zero time and distance");
  const tiedFields = ["s", "f", "x", "y", "headingRad", "velocityMps", "accelerationMps2", "angularVelocityRadps", "curvatureInvM"] as const;
  samples.forEach((sample, index) => {
    const before = samples[index - 1];
    requirePath(sample.f >= 0 && sample.f <= 1 && sample.velocityMps >= 0, "invalid sample fraction or speed");
    if (before) {
      requirePath(sample.t >= before.t && sample.s >= before.s && sample.f >= before.f, "samples must be in time and distance order");
      if (sample.t === before.t) {
        requirePath(tiedFields.every(key => close(sample[key], before[key])), "equal-time samples disagree");
      }
    }
    if (totalTimeS === 0) {
      requirePath(sample.velocityMps === 0 && sample.angularVelocityRadps === 0 && close(sample.s, 0)
        && close(sample.x, samples[0].x) && close(sample.y, samples[0].y) && close(sample.headingRad, samples[0].headingRad),
      "a zero-duration path must be stationary");
    }
  });
  const last = samples.at(-1)!;
  requirePath(close(last.t, totalTimeS) && close(last.s, totalDistanceM), "the last sample does not match the path totals");

  requirePath(followSections.length >= 1 && followSections.length <= 4096, "invalid follow section count");
  let boundary = 0;
  for (const { startSample, endSample } of followSections) {
    requirePath(startSample === boundary && endSample >= startSample && endSample < samples.length, "follow sections are not contiguous");
    boundary = endSample;
  }
  requirePath(boundary === samples.length - 1, "follow sections do not reach the last sample");

  requirePath(events.length <= 2000, "too many events");
  const ids = new Set<string>();
  for (const event of events) {
    requirePath(text(event.eventId) && text(event.name, 1024) && text(event.vi) && text(event.conditionId ?? "", 256, true)
      && !ids.has(event.eventId), "invalid or duplicate event metadata");
    ids.add(event.eventId);
    requirePath(event.timeS >= 0 && event.timeS <= totalTimeS && event.fraction >= 0 && event.fraction <= 1
      && (event.repeatEveryS ?? 0) >= 0 && (event.endTimeS === undefined || event.endTimeS >= event.timeS && event.endTimeS <= totalTimeS),
    "event schedule is outside the path");
    requirePath(!event.group || text(event.group.id), "invalid event group ID");
    const loop = event.loop;
    requirePath(!loop || loop.kind === "pathEnd" || (loop.kind === "time" ? loop.seconds : loop.meters) > 0, "invalid event loop limit");
    const keys = event.arguments.map(argument => argument.key);
    requirePath(keys.length <= 64 && new Set(keys).size === keys.length && keys.every(key => text(key))
      && event.arguments.every(argument => argument.niType !== "String" || Buffer.byteLength(argument.value) <= 65_536),
    "invalid or duplicate event arguments");
  }
  return path;
}
