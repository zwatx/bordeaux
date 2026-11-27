import { PM } from "../math/pm";
import type { ControlPoint, PlannerInput, RouteGeometry } from "../types";
import { curveDeviation } from "./corridorFinal";
import { materialGainS } from "./limits";
import { routeTask } from "./routeGeometry";

/** One Bézier handle whose length the descent may change. Its direction never changes. */
interface Handle {
  knot: number;
  key: "prevC" | "nextC";
  segment: number;
  /** Unit direction from the knot to the drawn control point. */
  direction: ControlPoint;
  maximumM: number;
}

const MINIMUM_HANDLE_M = 0.05;
/** A handle may grow to this multiple of its segment's chord, as in the earlier corridor search. */
const MAXIMUM_HANDLE_CHORDS = 1.5;
/** Handle lengths change by whole powers of this ratio, so a move cut short by the limit ends on the same curve whatever its size. */
const LENGTH_STEP = 1.03;
/** Largest change tried per move, in length steps: about 1.6x, then 1.27x, then 1.09x. Each size refines the last. */
const MOVE_STEPS = [16, 8, 3];
const ROUNDS_PER_STEP = 3;
/** A move must save this much first-pass time to be kept. */
const MINIMUM_PROBE_GAIN_S = 1e-4;
const DEVIATION_RESOLUTION = 64;
/**
 * The share of a material gain the first sweep must promise for the descent to go on. Over the 22 optimizer
 * eval paths on one robot, the paths with nothing to gain promised at most 0.23 of it and the rest at least 1.09.
 */
const WORTHWHILE_FIRST_SWEEP = 0.5;

/** Per handle, -1 shortens, 1 lengthens, 0 leaves it. Tried for the one or two handles of each segment. */
const SEGMENT_MOVES: ReadonlyArray<readonly [number, number]> = [
  [-1, 0], [0, -1], [-1, -1], [1, 0], [0, 1], [1, 1], [-1, 1], [1, -1],
];

/**
 * Searches for the fastest curve that keeps the drawn shape. Waypoints and the
 * travel direction at each waypoint stay as drawn, and the curve stays within
 * `limitM` of the drawn one; only handle lengths change.
 *
 * The descent ranks curves by first-pass time, which the caller supplies: each
 * `yield` hands over up to `batchCurves` curves and resumes with their times, in
 * order. Between batches it reads `pace`. `giveUp` ends the descent with what it
 * has. `enough` ends it only after the first sweep: that sweep is what finds a
 * result at all, so a slow machine still finishes it and gets a coarser curve
 * instead of none.
 * Time them at the plan's own sample density. At half density the corpus slalom
 * ranked curves that were slower than Normal once planned in full, and the
 * search returned nothing where a 9.6% gain exists.
 * A caller may time a batch on several threads; the result is the same either
 * way. Returns the best curve found, or nothing when no curve beats the drawn
 * one, followed by fallbacks: the curve it held after each smaller move size and
 * after its first sweep. A first-pass time can be far below what the full plan
 * of the same curve takes (2.32 s against 3.43 s on the corpus slalom after the
 * finest moves), so the caller plans and qualifies these in order and keeps the
 * first that holds up.
 */
export function* drawnShapeDescent(
  input: PlannerInput,
  limitM: number,
  pace: { enough: () => boolean; giveUp: () => boolean },
  batchCurves: number,
): Generator<RouteGeometry[], RouteGeometry[], number[]> {
  const source = input.path;
  // Every waypoint is a knot, so the waypoints below line up with the knots.
  const drawn = routeTask(source).seed;
  const distance = (a: ControlPoint, b: ControlPoint) => Math.hypot(a.x - b.x, a.y - b.y);
  const handles: Handle[] = [];
  const drawnLengths: number[] = [];
  for (let segment = 0; segment < drawn.knots.length - 1; segment += 1) {
    const chordM = distance(drawn.knots[segment], drawn.knots[segment + 1]);
    for (const [knot, key] of [[segment, "nextC"], [segment + 1, "prevC"]] as const) {
      const at = drawn.knots[knot], control = at[key];
      const lengthM = distance(at, control);
      if (lengthM <= MINIMUM_HANDLE_M) continue;
      handles.push({ knot, key, segment, direction: { x: (control.x - at.x) / lengthM, y: (control.y - at.y) / lengthM },
        maximumM: Math.max(lengthM, chordM * MAXIMUM_HANDLE_CHORDS) });
      drawnLengths.push(lengthM);
    }
  }
  if (handles.length === 0) return [];

  const shaped = (lengths: readonly number[]): RouteGeometry => {
    const knots = drawn.knots.map((knot) => ({ ...knot }));
    handles.forEach((handle, index) => {
      const knot = knots[handle.knot];
      knot[handle.key] = { x: knot.x + handle.direction.x * lengths[index], y: knot.y + handle.direction.y * lengths[index] };
    });
    return { ...drawn, knots };
  };
  const reference = PM.sample(source.waypoints, DEVIATION_RESOLUTION).pts;
  // Sampling reads only positions, handles and smoothing, so the limit check needs no planning path.
  const withinLimit = (lengths: readonly number[]) => {
    const knots = shaped(lengths).knots;
    const waypoints = source.waypoints.map((waypoint, index) => (
      { ...waypoint, linked: knots[index].smooth ?? true, corner: undefined, prevC: knots[index].prevC, nextC: knots[index].nextC }
    ));
    return curveDeviation(reference, PM.sample(waypoints, DEVIATION_RESOLUTION).pts) <= limitM;
  };
  /** `lengths` with the handles of one segment moved `steps` length steps in the direction of their move. */
  const moved = (lengths: readonly number[], indices: readonly number[], move: readonly [number, number], steps: number) => {
    const next = [...lengths];
    indices.forEach((index, slot) => {
      next[index] = Math.max(MINIMUM_HANDLE_M, Math.min(handles[index].maximumM, lengths[index] * LENGTH_STEP ** (move[slot] * steps)));
    });
    return next;
  };
  /** The move of up to `steps` length steps that stays within the limit, or null when even one step leaves it. */
  const reach = (lengths: readonly number[], indices: readonly number[], move: readonly [number, number], steps: number) => {
    const full = moved(lengths, indices, move, steps);
    if (full.every((length, index) => length === lengths[index])) return null;
    if (withinLimit(full)) return full;
    let inside = 0, outside = steps;
    while (outside - inside > 1) {
      const middle = Math.floor((inside + outside) / 2);
      if (withinLimit(moved(lengths, indices, move, middle))) inside = middle; else outside = middle;
    }
    return inside > 0 ? moved(lengths, indices, move, inside) : null;
  };

  // A move cut short by the limit lands on the same curve at every move size, so each curve is timed once.
  const timed = new Map<string, number>();
  const timeOf = (lengths: readonly number[]) => timed.get(lengths.join()) ?? Number.POSITIVE_INFINITY;
  /** Times every curve not timed yet. False when `stop` cut it short, which leaves some of them untimed. */
  function* time(candidates: ReadonlyArray<readonly number[]>, stop: () => boolean): Generator<RouteGeometry[], boolean, number[]> {
    const untimed = [...new Map(candidates.filter((lengths) => !timed.has(lengths.join())).map((lengths) => [lengths.join(), lengths])).values()];
    for (let from = 0; from < untimed.length; from += batchCurves) {
      if (stop()) return false;
      const batch = untimed.slice(from, from + batchCurves);
      const times = yield batch.map(shaped);
      batch.forEach((lengths, index) => timed.set(lengths.join(), Number.isFinite(times[index]) ? times[index] : Number.POSITIVE_INFINITY));
    }
    return true;
  }

  const segments = [...new Set(handles.map((handle) => handle.segment))]
    .map((segment) => ({ segment, indices: handles.flatMap((handle, index) => handle.segment === segment ? [index] : []) }));
  if (!(yield* time([drawnLengths], pace.giveUp))) return [];
  let best = { lengths: drawnLengths as readonly number[], timeS: timeOf(drawnLengths) };
  const incumbents: Array<readonly number[]> = [];
  // The incumbent after the first sweep and after each move size, coarsest first.
  const checkpoints: Array<readonly number[]> = [];
  search: for (const steps of MOVE_STEPS) {
    // A repeat round at the same step revisits only segments whose curve moved, or whose neighbour's did.
    let changed = new Set(segments.map(({ segment }) => segment));
    for (let round = 0; round < ROUNDS_PER_STEP && changed.size > 0; round += 1) {
      const revisit = changed;
      changed = new Set();
      // A round cut short has timed only some segments' moves; choosing among them would favour the early segments.
      const stop = incumbents.length === 0 && steps === MOVE_STEPS[0] && round === 0 ? pace.giveUp : pace.enough;
      // Every segment's moves start from the same curve, so one batch times them all. Finding how far each move
      // stays within the limit costs more the more waypoints there are, so the pace is read between segments too.
      const trials: Array<{ segment: number; indices: number[]; moves: number[][] }> = [];
      for (const { segment, indices } of segments) {
        if (!revisit.has(segment) && !revisit.has(segment - 1) && !revisit.has(segment + 1)) continue;
        if (stop()) break search;
        trials.push({ segment, indices, moves: SEGMENT_MOVES
          .filter((move) => indices.length > 1 || move[1] === 0)
          .flatMap((move) => { const lengths = reach(best.lengths, indices, move, steps); return lengths ? [lengths] : []; }) });
      }
      if (!(yield* time(trials.flatMap((trial) => trial.moves), stop))) break search;
      const improving = trials.flatMap(({ segment, indices, moves }) => {
        const lengths = moves.reduce<readonly number[] | null>((leader, candidate) =>
          timeOf(candidate) < (leader ? timeOf(leader) : best.timeS - MINIMUM_PROBE_GAIN_S) ? candidate : leader, null);
        return lengths ? [{ segment, indices, lengths, timeS: timeOf(lengths) }] : [];
      }).sort((first, second) => first.timeS - second.timeS);
      if (improving.length === 0) continue;
      // The first sweep tries every move at its largest. When all of its gains together are far below what
      // would make a result worth offering, the finer sweeps cannot get there either.
      if (incumbents.length === 0 && steps === MOVE_STEPS[0] && round === 0
        && improving.reduce((total, { timeS }) => total + best.timeS - timeS, 0) < materialGainS(best.timeS) * WORTHWHILE_FIRST_SWEEP) return [];
      let next = { lengths: improving[0].lengths, timeS: improving[0].timeS, segments: [improving[0].segment] };
      if (improving.length > 1) {
        // Segments share only their joints, so their best moves usually add up. Time the union to be sure.
        const union = [...best.lengths];
        improving.forEach(({ indices, lengths }) => indices.forEach((index) => { union[index] = lengths[index]; }));
        if (withinLimit(union) && (yield* time([union], pace.giveUp))) {
          if (timeOf(union) < next.timeS - MINIMUM_PROBE_GAIN_S) next = { lengths: union, timeS: timeOf(union), segments: improving.map(({ segment }) => segment) };
        }
      }
      best = next;
      incumbents.push(next.lengths);
      if (incumbents.length === 1) checkpoints.push(next.lengths);
      next.segments.forEach((segment) => changed.add(segment));
    }
    if (incumbents.length > 0) checkpoints.push(best.lengths);
  }
  if (incumbents.length === 0) return [];
  return [...new Map([best.lengths, ...checkpoints.reverse()].map((lengths) => [lengths.join(), lengths])).values()].map(shaped);
}
