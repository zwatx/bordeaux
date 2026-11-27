import { deriveHeadingGeometry } from "../math/pm";
import { visibleTags, type FieldTag } from "../tagVisibility";
import type { PathDoc, PlannerInput, RobotCamera, RotationTarget } from "../types";
import { planPath } from "./planPath";

/** How long a path lasts, and for how much of that the robot reads at least two tags, and at least one. Seconds. */
export interface TagCoverage { totalS: number; twoTagS: number; anyTagS: number }

export interface HeadingForTagsResult {
  /** The given path with the added rotation targets after its own. Nothing else differs. */
  path: PathDoc;
  addedTargets: RotationTarget[];
  /** Coverage of the given path and of `path`, both from the planner's own samples. */
  before: TagCoverage;
  after: TagCoverage;
}

/** One meter of path gets about this many places to try a heading, within the two bounds. */
const SLOT_SPACING_M = 0.6, MIN_SLOTS = 3, MAX_SLOTS = 12;
/** A new heading stays this share of the path away from every heading the user set. */
const ANCHOR_CLEARANCE = 0.04;
/** Turns tried at each place, degrees from the drawn heading there. The second set is the retry when the first is too slow. */
const TURNS_DEG = [[-90, -60, -45, -30, -15, 15, 30, 45, 60, 90], [-30, -15, 15, 30]] as const;
const ROUNDS = 3;
/** A second with exactly one tag counts as this share of a second with none: one tag gives a much worse pose than two. */
const ONE_TAG_LACK = 0.5;
/** The planner's result must lack tags for at least this many seconds less than the drawn path to be offered. */
const MATERIAL_GAIN_S = 0.1;
/** A turn between two headings must fit the drawn path's time between them with this much room. */
const TURN_TIME_ROOM = 1.15;
/** The result may be this much slower than the drawn path, as a share plus a fixed allowance in seconds. */
const SLOWER_SHARE = 0.1, SLOWER_ALLOWANCE_S = 0.05;

/**
 * Seconds a path goes without enough tags: every second with none, and part of every second with exactly one. Lower
 * is better. Seconds with tags would reward a path for being slower; seconds without them cannot.
 */
const lack = (coverage: TagCoverage) => coverage.totalS - coverage.anyTagS + ONE_TAG_LACK * (coverage.anyTagS - coverage.twoTagS);
const tagsSeen = (x: number, y: number, headingRad: number, cameras: readonly RobotCamera[], tags: readonly FieldTag[]) =>
  new Set(visibleTags({ x, y, headingRad }, cameras, tags).map((sighting) => sighting.tagId)).size;

/** Coverage along planned samples. Each sample counts for the time around it. */
export function tagCoverageOf(
  samples: ReadonlyArray<{ t: number; x: number; y: number; headingRad: number }>,
  cameras: readonly RobotCamera[],
  tags: readonly FieldTag[],
): TagCoverage {
  const coverage = { totalS: samples.length ? samples[samples.length - 1].t - samples[0].t : 0, twoTagS: 0, anyTagS: 0 };
  samples.forEach((sample, index) => {
    const seconds = ((samples[index + 1]?.t ?? sample.t) - (samples[index - 1]?.t ?? sample.t)) / 2;
    const seen = tagsSeen(sample.x, sample.y, sample.headingRad, cameras, tags);
    if (seen >= 2) coverage.twoTagS += seconds;
    if (seen >= 1) coverage.anyTagS += seconds;
  });
  return coverage;
}

/**
 * Searches for robot headings that read more AprilTags along a path, without moving the path. The drawn curve, its
 * stops and every heading the user set (waypoint angles and rotation targets) stay as they are. The search only adds
 * rotation targets, and only on stretches whose heading rule is "targets", where the robot is free to face any way.
 *
 * It tries a few turns at evenly spaced places, one place at a time, and ranks each try by a quick estimate: the
 * drawn path's timing with the new headings. A try is skipped when a turn between two neighboring headings cannot
 * fit the drawn path's time between them at the path's angular limits, since the planner would slow the whole path
 * to make it. The planner then plans the best try in full, and that plan decides. The result is returned only when
 * the planner's own samples lack tags for `MATERIAL_GAIN_S` less than the drawn path's and the path is not much slower. Returns nothing for a robot without cameras, a field without tags, a tank robot
 * (its heading follows the path), or a path with no free stretch or nothing to gain.
 */
export function optimizeHeadingForTags(input: PlannerInput, tags: readonly FieldTag[]): HeadingForTagsResult | null {
  const { path, robot } = input;
  const cameras = robot.cameras ?? [];
  if (!cameras.length || !tags.length || robot.drive === "tank" || path.waypoints.length < 2) return null;
  const drawnPlan = planPath(input);
  if (drawnPlan.status !== "ok" || !drawnPlan.trajectory || drawnPlan.trajectory.samples.length < 2) return null;
  const drawnSamples = drawnPlan.trajectory.samples;
  const before = tagCoverageOf(drawnSamples, cameras, tags);

  const drawn = deriveHeadingGeometry(path, robot);
  const lengthM = drawn.sample.length;
  if (!(lengthM > 1e-6)) return null;
  // A path driven backward faces half a turn from its heading rule.
  const reverse = path.driveBackward ? Math.PI : 0;
  /** The drawn plan's clock at a share of the path, for weighting each drawn point by the time spent near it. */
  const timeAt = (fraction: number) => {
    let after = 1;
    while (after < drawnSamples.length - 1 && drawnSamples[after].f < fraction) after += 1;
    const a = drawnSamples[after - 1], b = drawnSamples[after], span = b.f - a.f;
    return span > 1e-9 ? a.t + (b.t - a.t) * Math.max(0, Math.min(1, (fraction - a.f) / span)) : b.t;
  };
  /** The quick estimate: `candidate`'s headings on its own drawn points, timed by the drawn plan. */
  const estimate = (candidate: PathDoc): number => {
    const { sample, head } = deriveHeadingGeometry(candidate, robot);
    const times = sample.pts.map((point) => timeAt(point.s / (sample.length || 1)));
    const coverage = { totalS: before.totalS, twoTagS: 0, anyTagS: 0 };
    sample.pts.forEach((point, index) => {
      const seconds = ((times[index + 1] ?? times[index]) - (times[index - 1] ?? times[index])) / 2;
      const seen = tagsSeen(point.x, point.y, head[index] + reverse, cameras, tags);
      if (seen >= 2) coverage.twoTagS += seconds;
      if (seen >= 1) coverage.anyTagS += seconds;
    });
    return lack(coverage);
  };

  // Places to try a heading: evenly spaced, on a "targets" stretch, clear of every heading the user set.
  const modeOf = (segment: number) => path.waypoints[segment]?.segmentHeadingMode || path.headingMode || "targets";
  const segmentAt = (fraction: number) => {
    let segment = 0;
    while (segment < path.waypoints.length - 2 && fraction >= drawn.wpFrac[segment + 1]) segment += 1;
    return segment;
  };
  const set = [...drawn.wpFrac, ...path.targets.map((target) => (target.anchor === "dist" && target.d != null ? target.d / lengthM : target.f))];
  const count = Math.max(MIN_SLOTS, Math.min(MAX_SLOTS, Math.round(lengthM / SLOT_SPACING_M)));
  const slots = Array.from({ length: count }, (_, index) => Math.round((index + 1) / (count + 1) * 1e4) / 1e4)
    .filter((fraction) => modeOf(segmentAt(fraction)) === "targets" && set.every((other) => Math.abs(other - fraction) >= ANCHOR_CLEARANCE));
  if (!slots.length) return null;
  /** The drawn heading at each place, in degrees, which the tried turns start from. */
  const drawnDeg = slots.map((fraction) => {
    let after = 1;
    while (after < drawn.sample.pts.length - 1 && drawn.sample.pts[after].s / lengthM < fraction) after += 1;
    return drawn.head[after] * 180 / Math.PI;
  });
  const wrap = (deg: number) => { const turned = Math.round(deg) % 360; return turned > 180 ? turned - 360 : turned <= -180 ? turned + 360 : turned; };
  // Every heading that pins the robot on a "targets" stretch: the two ends, waypoints with a set angle, and the path's
  // own rotation targets. A try's turns are checked between neighbors in this list plus its added headings.
  const pinned = [
    ...path.waypoints.flatMap((waypoint, index) => index === 0 || index === path.waypoints.length - 1 || waypoint.thetaOn ? [{ f: drawn.wpFrac[index], deg: waypoint.theta || 0 }] : []),
    ...path.targets.map((target) => ({ f: target.anchor === "dist" && target.d != null ? target.d / lengthM : target.f, deg: target.deg })),
  ];
  const limits = path.constraints, speed = limits.maxAngVel, pickup = Math.min(limits.maxAngAccel, limits.maxAngDecel ?? limits.maxAngAccel);
  /** Shortest time to turn `deg` from rest to rest at the path's angular limits. */
  const turnSeconds = (deg: number) => !(speed > 0) || !(pickup > 0) ? 0 : deg <= speed * speed / pickup ? 2 * Math.sqrt(deg / pickup) : deg / speed + speed / pickup;
  const turnsFit = (added: readonly RotationTarget[]) => {
    const ordered = [...pinned, ...added].sort((a, b) => a.f - b.f);
    return ordered.every((anchor, index) => {
      const next = ordered[index + 1];
      if (!next || (!added.includes(anchor as RotationTarget) && !added.includes(next as RotationTarget))) return true;
      const turn = Math.abs(((next.deg - anchor.deg) % 360 + 540) % 360 - 180);
      return timeAt(next.f) - timeAt(anchor.f) >= turnSeconds(turn) * TURN_TIME_ROOM;
    });
  };
  const withTargets = (chosen: ReadonlyArray<number | null>): { path: PathDoc; added: RotationTarget[] } => {
    const added = chosen.flatMap((deg, index): RotationTarget[] => deg === null ? [] : [{ f: slots[index], deg }]);
    return { path: { ...path, targets: [...path.targets, ...added] }, added };
  };

  for (const turns of TURNS_DEG) {
    const chosen: Array<number | null> = slots.map(() => null);
    let best = estimate(path);
    for (let round = 0; round < ROUNDS; round += 1) {
      let improved = false;
      slots.forEach((_, index) => {
        for (const option of [null, ...turns.map((turn) => wrap(drawnDeg[index] + turn))]) {
          if (option === chosen[index]) continue;
          const kept = chosen[index];
          chosen[index] = option;
          const tried = withTargets(chosen);
          const value = turnsFit(tried.added) ? estimate(tried.path) : Infinity;
          if (value < best - 1e-3) { best = value; improved = true; } else chosen[index] = kept;
        }
      });
      if (!improved) break;
    }
    // Drop a heading whose removal costs nothing, so each one left earns its place.
    slots.forEach((_, index) => {
      if (chosen[index] === null) return;
      const kept = chosen[index];
      chosen[index] = null;
      const tried = withTargets(chosen);
      if (!turnsFit(tried.added) || estimate(tried.path) > best + 1e-3) chosen[index] = kept;
    });
    const candidate = withTargets(chosen);
    if (!candidate.added.length) return null;
    const plan = planPath({ ...input, path: candidate.path });
    if (plan.status !== "ok" || !plan.trajectory) continue;
    const after = tagCoverageOf(plan.trajectory.samples, cameras, tags);
    if (after.totalS > before.totalS * (1 + SLOWER_SHARE) + SLOWER_ALLOWANCE_S) continue;
    if (lack(after) > lack(before) - MATERIAL_GAIN_S) continue;
    return { path: candidate.path, addedTargets: candidate.added, before, after };
  }
  return null;
}
