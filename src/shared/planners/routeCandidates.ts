import { officialToAppRect, REBUILT_2026_FIELD } from "../field/rebuilt2026";
import { FIELD_H } from "../math/fieldBounds";
import { waypointHeadingSemantics } from "../math/waypointHeading";
import type { ControlPoint, PathDoc, PlannerInput, RouteGeometry } from "../types";
import { segmentHeadingLaws } from "./headingTransitions";
import { geometryFromPath, routeGeometryShapeError, MAX_ROUTE_KNOTS } from "./routeGeometry";
import { routeFieldModel, routeLineClear, type RouteFieldModel } from "./routeSafety";

const dist = (a: ControlPoint, b: ControlPoint) => Math.hypot(a.x - b.x, a.y - b.y);

function handles(source: PathDoc, points: ControlPoint[], indices: number[], factor: number, rotation: number, tankDrive: boolean): RouteGeometry {
  const laws = segmentHeadingLaws(source, tankDrive);
  const knots = points.map((p, index) => {
    const before = points[Math.max(0, index - 1)];
    const after = points[Math.min(points.length - 1, index + 1)];
    const required = indices.indexOf(index);
    const original = source.waypoints[required];
    let incoming = Math.atan2(p.y - before.y, p.x - before.x);
    let outgoing = Math.atan2(after.y - p.y, after.x - p.x);
    if (!original?.stop && index > 0 && index < points.length - 1) {
      incoming = outgoing = Math.atan2(after.y - before.y, after.x - before.x);
    }
    incoming += rotation;
    outgoing += rotation;
    const departure = original && waypointHeadingSemantics(original, required, laws).tangentDepartureDeg;
    if (departure !== undefined) outgoing = departure * Math.PI / 180;
    const previousLength = (index > 0 ? dist(before, p) : dist(p, after)) * factor;
    const nextLength = (index < points.length - 1 ? dist(after, p) : dist(p, before)) * factor;
    return {
      ...p, smooth: true,
      prevC: { x: p.x - Math.cos(incoming) * previousLength, y: p.y - Math.sin(incoming) * previousLength },
      nextC: { x: p.x + Math.cos(outgoing) * nextLength, y: p.y + Math.sin(outgoing) * nextLength },
    };
  });
  return { version: 1, knots, requiredPointIndices: indices };
}

function graphNodes(model: RouteFieldModel, margin: number): ControlPoint[] {
  // Axis-aligned footprint approaches can enter real narrow portals; final
  // timing supplies and independently certifies the actual heading throughout.
  const offset = Math.max(...model.vertices.map((p) => Math.max(Math.abs(p.x), Math.abs(p.y)))) + margin;
  const nodes: ControlPoint[] = [];
  for (const r of model.obstacles) {
    for (const x of [r.xMin - offset, r.xMax + offset]) {
      for (const y of [r.yMin - offset, r.yMax + offset]) nodes.push({ x, y });
    }
  }
  for (const barrier of REBUILT_2026_FIELD.crossingBarriers) {
    for (const portal of barrier.portals) {
      const b = officialToAppRect(portal.bounds);
      for (const x of [b.xMin - offset, b.xMax + offset]) nodes.push({ x, y: (b.yMin + b.yMax) / 2 });
    }
  }
  return nodes.filter((p, i) => nodes.findIndex((q) => dist(p, q) < 1e-6) === i && routeLineClear(p, p, model));
}

/** Bounded visibility graph. Alternate side costs choose different legal portals;
 * no relationship to the seed's portal sequence is imposed. */
function graphRoute(source: PathDoc, model: RouteFieldModel, side: number, stop: () => boolean, exhausted: () => void): { points: ControlPoint[]; indices: number[] } | undefined {
  const fixed = source.waypoints.map(({ x, y }) => ({ x, y }));
  const nodes = [...fixed, ...graphNodes(model, 0.25)];
  if (nodes.length > 192) {
    exhausted();
    return undefined;
  }
  const edges = new Map<string, boolean>();
  let work = 0;
  const visible = (i: number, j: number) => {
    const key = `${Math.min(i, j)}:${Math.max(i, j)}`;
    if (!edges.has(key)) {
      if (++work > 12_000) {
        if (work === 12_001) exhausted();
        return false;
      }
      if (stop()) return false;
      edges.set(key, routeLineClear(nodes[i], nodes[j], model));
    }
    return edges.get(key)!;
  };
  const points: ControlPoint[] = [fixed[0]];
  const indices = [0];
  for (let leg = 0; leg < fixed.length - 1; leg++) {
    const costs = nodes.map(() => Infinity);
    const previous = nodes.map(() => -1);
    const visited = new Set<number>();
    costs[leg] = 0;
    while (!stop()) {
      let current = -1;
      for (let i = 0; i < nodes.length; i++) {
        if (!visited.has(i) && (current < 0 || costs[i] < costs[current])) current = i;
      }
      if (current < 0 || !Number.isFinite(costs[current]) || work > 12_000) return undefined;
      if (current === leg + 1) break;
      visited.add(current);
      for (let next = 0; next < nodes.length; next++) {
        if (next === current || visited.has(next) || (next < fixed.length && next !== leg + 1)) continue;
        const length = dist(nodes[current], nodes[next]);
        const y = (nodes[current].y + nodes[next].y) / (2 * FIELD_H);
        const cost = costs[current] + length * (1 + (side > 0 ? y : side < 0 ? 1 - y : 0) * Math.abs(side));
        if (cost < costs[next] && visible(current, next)) {
          costs[next] = cost;
          previous[next] = current;
        }
      }
    }
    if (stop() || previous[leg + 1] < 0) return undefined;
    const route: ControlPoint[] = [];
    for (let cursor = leg + 1; cursor !== leg; cursor = previous[cursor]) {
      if (cursor < 0 || route.length > nodes.length) return undefined;
      route.push(nodes[cursor]);
    }
    points.push(...route.reverse());
    indices.push(points.length - 1);
    if (points.length > MAX_ROUTE_KNOTS) {
      exhausted();
      return undefined;
    }
  }
  return { points, indices };
}

/** Finite deterministic candidate family, with full vectors and solver-owned knots. */
export function* routeCandidates(input: PlannerInput, stop: () => boolean, exhausted: () => void = () => {}): Generator<RouteGeometry> {
  const source = input.path;
  const points = source.waypoints.map(({ x, y }) => ({ x, y }));
  const indices = points.map((_, i) => i);
  const tankDrive = input.robot.drive === "tank";
  // Canonical rescue runs first, then Normal qualification and strict timing
  // of the authored geometry, which is a distinct candidate.
  yield handles(source, points, indices, 1 / 3, 0, tankDrive);
  const authored = geometryFromPath(source);
  yield authored;
  const model = routeFieldModel(input.robot);
  for (const side of [0, 4, -4]) {
    if (stop()) return;
    const route = graphRoute(source, model, side, stop, exhausted);
    if (route) {
      for (const factor of [0.2, 0.35, 0.12]) {
        const geometry = handles(source, route.points, route.indices, factor, 0, tankDrive);
        yield geometry;
        // Quintic curvature smoothing can overshoot a graph detour when adjacent
        // legs have very different lengths. Also try the same aligned cubic
        // handles at generated knots; each variant still needs full qualification.
        if (route.points.length > route.indices.length) {
          if (stop()) return;
          yield { ...geometry, knots: geometry.knots.map((knot, i) =>
            route.indices.includes(i) ? knot : { ...knot, smooth: false }) };
        }
      }
    }
  }
  const aligned = !routeGeometryShapeError(authored) && authored.knots.every((k, i) => {
    if (i === 0 || i === authored.knots.length - 1 || source.waypoints[i].stop) return true;
    const ax = k.x - k.prevC.x, ay = k.y - k.prevC.y;
    const bx = k.nextC.x - k.x, by = k.nextC.y - k.y;
    const lengths = Math.hypot(ax, ay) * Math.hypot(bx, by);
    return lengths > 1e-12 && Math.abs(ax * by - ay * bx) <= lengths * 1e-7 && ax * bx + ay * by > 0;
  });
  const laws = segmentHeadingLaws(source, tankDrive);
  if (aligned) {
    for (const angle of [-Math.PI / 6, Math.PI / 6]) {
      for (const scale of [0.8, 1.2]) {
        if (stop()) return;
        yield { ...authored, knots: authored.knots.map((knot, i) => {
          const departure = waypointHeadingSemantics(source.waypoints[i], i, laws).tangentDepartureDeg;
          const rotate = (control: ControlPoint, rotation: number) => {
            const x = (control.x - knot.x) * scale;
            const y = (control.y - knot.y) * scale;
            return { x: knot.x + x * Math.cos(rotation) - y * Math.sin(rotation), y: knot.y + x * Math.sin(rotation) + y * Math.cos(rotation) };
          };
          return { ...knot, smooth: true, prevC: rotate(knot.prevC, angle), nextC: rotate(knot.nextC, departure === undefined ? angle : 0) };
        }) };
      }
    }
  }
  for (const factor of [0.2, 0.5, 0.75]) {
    for (const rotation of [0, -Math.PI / 6, Math.PI / 6]) {
      if (stop()) return;
      yield handles(source, points, indices, factor, rotation, tankDrive);
    }
  }
}
