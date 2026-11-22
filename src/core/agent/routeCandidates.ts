import { officialToAppPoint, officialToAppRect, REBUILT_2026_FIELD, REBUILT_2026_INITIAL_FUEL_REGION, REBUILT_2026_TRENCH_CLEARANCE_M } from "../field/rebuilt2026";
import { resolveProjectFieldTerm } from "../field/vocabulary";
import { FIELD_H, FIELD_W } from "../math/fieldBounds";
import { PM } from "../math/pm";
import { orderedWaypointSampleIndices } from "../planners/waypointSamples";
import { buildWaypoints, clone, createPathId } from "../project/defaults";
import type { BordeauxProject, PathDoc, TrajectorySample } from "../types";
import { analyzePath, minimumPathClearance } from "./pathAnalysis";
import { boundsPolygon, convexPolygonClearance, polygonBounds, robotFootprintAt, robotFootprintRadius } from "./robotFootprint";
import type { FieldPointInput, FuelCollectionIntent, PlanPathRequest, RouteCandidate, RouteLocationInput, RouteStep, RouteTraversal } from "./types";

const MAX_CANDIDATES = 5;

function isFieldTerm(input: RouteLocationInput): input is { term: string } {
  return "term" in input;
}

function resolveLocation(
  project: BordeauxProject,
  input: RouteLocationInput,
  request: PlanPathRequest,
  fallbackPose?: { x: number; y: number; physicalHeadingRad: number },
  allowReference = false,
): FieldPointInput {
  if (!isFieldTerm(input)) {
    if (!Number.isFinite(input.x) || !Number.isFinite(input.y) || input.x < 0 || input.x > FIELD_W || input.y < 0 || input.y > FIELD_H || (input.headingDeg !== undefined && !Number.isFinite(input.headingDeg))) {
      throw new Error("Route coordinates must be finite and inside Bordeaux's field bounds; requested points are never silently clamped.");
    }
    return { ...input };
  }
  const resolved = resolveProjectFieldTerm(input.term, project.strategy, {
    alliance: request.alliance,
    robotHeightM: project.robot.heightM ?? request.robotHeightM,
    ...(fallbackPose ? { pose: { ...fallbackPose, headingSource: "physical" as const } } : {}),
  });
  if (resolved.status !== "resolved" || resolved.matches.length !== 1) {
    throw new Error(resolved.message ?? `“${input.term}” must resolve to exactly one field location.`);
  }
  const match = resolved.matches[0];
  if (!allowReference && match.navigable === false) throw new Error(`“${input.term}” is an official reference surface or fiducial, not a collision-free robot drive coordinate.`);
  const point = { ...match.point };
  if (match.id.includes("initial-fuel-") && fallbackPose) {
    const bounds = officialToAppRect(REBUILT_2026_INITIAL_FUEL_REGION);
    const margin = Math.min((bounds.yMax - bounds.yMin) / 2, robotFootprintRadius(project.robot) + 0.05);
    point.y = Math.max(bounds.yMin + margin, Math.min(bounds.yMax - margin, fallbackPose.y));
  }
  return { ...point, ...(match.headingDeg === undefined ? {} : { headingDeg: match.headingDeg }) };
}

function uniqueName(project: BordeauxProject, requested: string): string {
  const base = requested.trim() || "Agent path";
  const names = new Set(project.paths.map((path) => path.name.toLocaleLowerCase("en-US")));
  if (!names.has(base.toLocaleLowerCase("en-US"))) return base;
  let suffix = 2;
  while (names.has(`${base} ${suffix}`.toLocaleLowerCase("en-US"))) suffix += 1;
  return `${base} ${suffix}`;
}

interface CollectionSpan {
  startWaypointIndex: number;
  endWaypointIndex: number;
  intent: FuelCollectionIntent;
}

interface ActiveCollectionSpan {
  startSegmentIndex: number;
  startT: number;
  endSegmentIndex: number;
  endT: number;
  f0: number;
  f1: number;
  intent: FuelCollectionIntent;
}

function sameCollectionIntent(left: FuelCollectionIntent, right: FuelCollectionIntent): boolean {
  return (left.maxHeadingErrorDeg ?? 5) === (right.maxHeadingErrorDeg ?? 5)
    && (left.allowCrosswiseHeading ?? false) === (right.allowCrosswiseHeading ?? false);
}

function unwrapNear(value: number, reference: number): number {
  return reference + Math.atan2(Math.sin(value - reference), Math.cos(value - reference));
}

function configureCollectionHeading(path: PathDoc, spans: readonly ActiveCollectionSpan[], intakeDirectionDeg: number): void {
  const alignedSegments = new Set<number>();
  spans.filter((span) => span.intent.allowCrosswiseHeading !== true).forEach((span) => {
    for (let segment = span.startSegmentIndex; segment <= span.endSegmentIndex; segment += 1) alignedSegments.add(segment);
  });
  if (alignedSegments.size === 0) return;
  const firstAlignedSegment = Math.min(...alignedSegments);
  const lastControlledSegment = Math.max(...alignedSegments);
  const intakeOffset = intakeDirectionDeg * Math.PI / 180;
  if (Math.abs(Math.atan2(Math.sin(intakeOffset), Math.cos(intakeOffset))) < 1e-6) {
    alignedSegments.forEach((segment) => { path.waypoints[segment].segmentHeadingMode = "tangent"; });
    return;
  }
  for (let segment = firstAlignedSegment; segment <= lastControlledSegment; segment += 1) path.waypoints[segment].segmentHeadingMode = "targets";
  const sampled = PM.sample(path.waypoints, 56);
  const points = sampled.pts as Array<{ s: number; seg: number; heading: number }>;
  const total = sampled.length || 1;
  const targets: PathDoc["targets"] = [];
  const first = points.findIndex((point) => point.seg >= firstAlignedSegment);
  let last = points.length - 1;
  for (let index = points.length - 1; index >= first; index -= 1) {
    if (alignedSegments.has(points[index].seg)) { last = index; break; }
  }
  const tangentDesired: number[] = [];
  for (let index = first; index <= last; index += 1) {
    const raw = points[index].heading - intakeOffset;
    tangentDesired.push(tangentDesired.length ? unwrapNear(raw, tangentDesired[tangentDesired.length - 1]) : raw);
  }
  const allowedHeadingError = points.slice(first, last + 1).map((point) => {
    const active = spans.filter((span) => span.intent.allowCrosswiseHeading !== true
      && point.seg >= span.startSegmentIndex && point.seg <= span.endSegmentIndex);
    return active.length === 0
      ? null
      : Math.max(0.25, Math.min(...active.map((span) => span.intent.maxHeadingErrorDeg ?? 5))) * Math.PI / 180;
  });
  let smoothed = [...tangentDesired];
  // Project a low-curvature heading law into each collection span's permitted
  // intake-error band. Non-collection approach samples remain free so the same
  // solve can blend continuously into a target-facing shooting pose.
  for (let pass = 0; pass < 320; pass += 1) {
    const next = [...smoothed];
    for (let local = 1; local < smoothed.length - 1; local += 1) {
      const relaxed = (smoothed[local - 1] + 2 * smoothed[local] + smoothed[local + 1]) / 4;
      const allowed = allowedHeadingError[local];
      if (allowed === null) next[local] = relaxed;
      else {
        next[local] = Math.max(tangentDesired[local] - allowed, Math.min(tangentDesired[local] + allowed, relaxed));
      }
    }
    smoothed = next;
  }
  let lastAnchorLocal = -1;
  for (let local = 0; local < smoothed.length; local += 1) {
    const endpoint = local === 0 || local === smoothed.length - 1;
    const farEnough = lastAnchorLocal < 0 || points[first + local].s - points[first + lastAnchorLocal].s >= 0.3;
    const turnedEnough = lastAnchorLocal < 0 || Math.abs(smoothed[local] - smoothed[lastAnchorLocal]) >= 5 * Math.PI / 180;
    if (!endpoint && !farEnough && !turnedEnough) continue;
    const index = first + local;
    const fraction = points[index].s / total;
    const deg = smoothed[local] * 180 / Math.PI;
    if (fraction <= 1e-8) path.waypoints[0].theta = deg;
    else if (fraction >= 1 - 1e-8) path.waypoints[path.waypoints.length - 1].theta = deg;
    else targets.push({ f: fraction, deg });
    lastAnchorLocal = local;
  }
  path.targets = targets;
}

function activeCollectionSpans(path: PathDoc, requested: readonly CollectionSpan[]): ActiveCollectionSpan[] {
  if (requested.length === 0) return [];
  const sampled = PM.sample(path.waypoints, 120);
  const points = sampled.pts as Array<{ x: number; y: number; seg: number; t: number; s: number }>;
  const total = sampled.length || 1;
  const fuel = officialToAppRect(REBUILT_2026_INITIAL_FUEL_REGION);
  const insideFuel = (point: { x: number; y: number }) => point.x >= fuel.xMin - 0.01 && point.x <= fuel.xMax + 0.01 && point.y >= fuel.yMin - 0.01 && point.y <= fuel.yMax + 0.01;
  const active: ActiveCollectionSpan[] = [];
  requested.forEach((span) => {
    let first = -1;
    const flush = (last: number) => {
      if (first < 0 || last < first) return;
      const start = points[first];
      const end = points[last];
      active.push({
        startSegmentIndex: start.seg,
        startT: start.t,
        endSegmentIndex: end.seg,
        endT: end.t,
        f0: start.s / total,
        f1: end.s / total,
        intent: span.intent,
      });
      first = -1;
    };
    points.forEach((point, index) => {
      const inRequestedLeg = point.seg >= span.startWaypointIndex && point.seg < span.endWaypointIndex;
      if (inRequestedLeg && insideFuel(point)) {
        if (first < 0) first = index;
      } else flush(index - 1);
    });
    flush(points.length - 1);
  });
  return active;
}

function routePath(project: BordeauxProject, base: PathDoc, name: string, points: FieldPointInput[], requestedCollectionSpans: readonly CollectionSpan[], finishHeadingDeg?: number, smoothGeometry = false): { path: PathDoc; collectionSpans: ActiveCollectionSpan[] } {
  const raw = points.map((point, index) => {
    const next = points[Math.min(points.length - 1, index + 1)];
    const previous = points[Math.max(0, index - 1)];
    const theta = point.headingDeg ?? Math.atan2(next.y - previous.y, next.x - previous.x) * 180 / Math.PI;
    const authored = point as FieldPointInput & { prevC?: { x: number; y: number }; nextC?: { x: number; y: number }; segType?: "bezier" | "line" | "arc" | "clothoid" };
    const segType: "bezier" | "line" | "arc" | "clothoid" = authored.segType
      ?? (smoothGeometry ? "clothoid" : base.waypoints[Math.min(index, base.waypoints.length - 1)]?.segType ?? "bezier");
    return {
      x: point.x, y: point.y, theta,
      segType,
      ...(authored.prevC ? { prevC: authored.prevC } : {}),
      ...(authored.nextC ? { nextC: authored.nextC } : {}),
    };
  });
  const waypoints = buildWaypoints(raw);
  waypoints.forEach((waypoint, index) => {
    const authored = points[index] as FieldPointInput & { prevC?: { x: number; y: number }; nextC?: { x: number; y: number } };
    const next = waypoints[index + 1];
    if (!authored.prevC || authored.nextC || !next) return;
    const dx = waypoint.x - authored.prevC.x;
    const dy = waypoint.y - authored.prevC.y;
    const length = Math.hypot(dx, dy);
    const capped = Math.min(length, Math.hypot(next.x - waypoint.x, next.y - waypoint.y) / 3);
    if (length > 1e-9) waypoint.nextC = { x: waypoint.x + dx / length * capped, y: waypoint.y + dy / length * capped };
  });
  waypoints.forEach((waypoint, index) => {
    const capHandle = (key: "prevC" | "nextC", neighborIndex: number) => {
      if ((points[index] as FieldPointInput & { prevC?: unknown; nextC?: unknown })[key]) return;
      const handle = waypoint[key];
      const neighbor = waypoints[neighborIndex];
      if (!handle || !neighbor) return;
      const handleLength = Math.hypot(handle.x - waypoint.x, handle.y - waypoint.y);
      const maximum = Math.hypot(neighbor.x - waypoint.x, neighbor.y - waypoint.y) / 3;
      if (handleLength <= maximum || handleLength <= 1e-9) return;
      const scale = maximum / handleLength;
      waypoint[key] = { x: waypoint.x + (handle.x - waypoint.x) * scale, y: waypoint.y + (handle.y - waypoint.y) * scale };
    };
    capHandle("prevC", index - 1);
    capHandle("nextC", index + 1);
  });
  const intake = project.robot.planning?.intake;
  if (requestedCollectionSpans.length > 0 && !intake) throw new Error("Configure the robot's intake location, direction, capture width, and collection speed before planning FUEL collection.");
  if (finishHeadingDeg !== undefined) {
    const endpoint = waypoints.at(-1)!;
    endpoint.stop = true;
    endpoint.theta = finishHeadingDeg;
    endpoint.thetaOn = true;
  }
  if (requestedCollectionSpans.length > 0) waypoints.slice(0, -1).forEach((waypoint) => { waypoint.segmentHeadingMode = "tangent"; });
  const path: PathDoc = {
    ...clone(base),
    id: createPathId(),
    name,
    folderId: base.folderId,
    waypoints,
    targets: [],
    markers: [],
    ranges: [],
    driveBackward: false,
    startVel: 0,
    goalVel: 0,
  };
  const collectionSpans = activeCollectionSpans(path, requestedCollectionSpans);
  path.ranges = collectionSpans.map((span) => ({
    anchor: "wp" as const,
    f0: 0,
    f1: 0,
    w0: span.startSegmentIndex,
    t0: span.startT,
    w1: span.endSegmentIndex,
    t1: span.endT,
    maxVel: Math.min(base.constraints.maxVel, intake?.maxCollectSpeedMps ?? base.constraints.maxVel),
    maxAccel: base.constraints.maxAccel,
    maxDecel: base.constraints.maxDecel,
    maxAngVel: base.constraints.maxAngVel,
    maxAngAccel: base.constraints.maxAngAccel,
    name: collectionSpans.length > 1 ? `FUEL collection ${collectionSpans.indexOf(span) + 1}` : "FUEL collection",
  }));
  if (intake) {
    configureCollectionHeading(path, collectionSpans, intake.directionDeg);
  }
  if (finishHeadingDeg !== undefined && path.waypoints.length > 1) {
    const finishStart = collectionSpans.length
      ? Math.min(path.waypoints.length - 2, Math.max(...collectionSpans.map((span) => span.endSegmentIndex)) + 1)
      : 0;
    path.waypoints[finishStart].thetaOn = true;
    for (let segment = finishStart; segment < path.waypoints.length - 1; segment += 1) path.waypoints[segment].segmentHeadingMode = "targets";
  }
  return { path, collectionSpans };
}

function traversalOptions(request: PlanPathRequest): RouteTraversal[] {
  switch (request.traversal) {
    case "trench": return ["trench-table", "trench-away"];
    case "bump": return ["bump-table", "bump-away"];
    case "compare": return ["direct", "trench-table", "trench-away", "bump-table", "bump-away"];
    default: return ["direct", "trench-table", "trench-away", "bump-table", "bump-away"];
  }
}

function legBarriers(start: FieldPointInput, goal: FieldPointInput) {
  return REBUILT_2026_FIELD.crossingBarriers
    .map((barrier) => ({ barrier, appX: officialToAppPoint({ x: barrier.x, y: 0 }).x }))
    .filter(({ appX }) => appX >= Math.min(start.x, goal.x) - 1e-6 && appX <= Math.max(start.x, goal.x) + 1e-6)
    .sort((left, right) => goal.x > start.x ? left.appX - right.appX : right.appX - left.appX);
}

function appendPoint(points: FieldPointInput[], point: FieldPointInput): void {
  const previous = points.at(-1);
  if (!previous || Math.hypot(previous.x - point.x, previous.y - point.y) > 1e-6) points.push(point);
}

function appendLeg(points: FieldPointInput[], goal: FieldPointInput, traversal: RouteTraversal, enforceTraversal = false, portalRunM = 0): string[] {
  const start = points[points.length - 1];
  const requiredPortalIds: string[] = [];
  const barriers = legBarriers(start, goal);
  if (enforceTraversal && traversal === "direct" && barriers.length > 0) {
    throw new Error("An ordered leg that reaches an alliance barrier must name its exact TRENCH/BUMP and table/away traversal.");
  }
  if (traversal !== "direct") {
    const [kind, side] = traversal.split("-") as ["trench" | "bump", "table" | "away"];
    barriers.forEach(({ barrier, appX }) => {
      const portal = barrier.portals.find((candidate) => candidate.traversal === kind && candidate.side === side)!;
      requiredPortalIds.push(portal.id);
      const portalPoint = officialToAppPoint(portal.point);
      const direction = Math.sign(goal.x - start.x) || 1;
      const startsAtBarrier = Math.abs(start.x - appX) <= 1e-6;
      const endsAtBarrier = Math.abs(goal.x - appX) <= 1e-6;
      if (!startsAtBarrier) appendPoint(points, { x: appX - direction * portalRunM, y: portalPoint.y });
      if (!startsAtBarrier && !endsAtBarrier) appendPoint(points, portalPoint);
      const exitGuide = { x: appX + direction * portalRunM, y: portalPoint.y };
      if (!endsAtBarrier && Math.hypot(goal.x - exitGuide.x, goal.y - exitGuide.y) >= 0.4) appendPoint(points, exitGuide);
    });
  }
  if (enforceTraversal && traversal !== "direct" && requiredPortalIds.length === 0) {
    throw new Error(`The ordered leg requires ${traversal.replace("-", " ")} but does not reach an alliance barrier.`);
  }
  appendPoint(points, goal);
  return requiredPortalIds;
}

function assertPointInside(point: FieldPointInput, label: string): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.x > FIELD_W || point.y < 0 || point.y > FIELD_H) {
    throw new Error(`${label} extends outside Bordeaux's field bounds; reduce the maneuver radius or choose a different turn direction.`);
  }
}

function appendSwoosh(
  points: FieldPointInput[],
  farExtent: FieldPointInput,
  step: Extract<RouteStep, { kind: "swoosh" }>,
  portalRunM: number,
): string[] {
  if (!Number.isFinite(step.radiusM) || step.radiusM < 0.25 || step.radiusM > 2.5) throw new Error("A swoosh radius must be between 0.25 m and 2.5 m.");
  const previous = points[points.length - 1];
  const fuel = officialToAppRect(REBUILT_2026_INITIAL_FUEL_REGION);
  const targetsFuelEdge = Math.min(Math.abs(farExtent.x - fuel.xMin), Math.abs(farExtent.x - fuel.xMax)) < 0.03;
  const initialDirection = Math.sign(farExtent.x - previous.x) || 1;
  const nearEdge = targetsFuelEdge ? { x: initialDirection > 0 ? fuel.xMin : fuel.xMax, y: farExtent.y } : previous;
  const rawDx = farExtent.x - nearEdge.x;
  const rawDy = farExtent.y - nearEdge.y;
  const rawLength = Math.hypot(rawDx, rawDy);
  const insetM = step.insetM ?? 0;
  if (!Number.isFinite(insetM) || insetM < 0 || insetM > 2) throw new Error("A swoosh inset must be between 0 m and 2 m.");
  const far = rawLength > 1e-9 ? { x: farExtent.x - rawDx / rawLength * insetM, y: farExtent.y - rawDy / rawLength * insetM } : farExtent;
  const dx = far.x - nearEdge.x;
  const dy = far.y - nearEdge.y;
  const length = Math.hypot(dx, dy);
  if (length < step.radiusM + 0.1) throw new Error("A swoosh needs enough approach distance to establish its incoming direction.");
  const ux = dx / length;
  const uy = dy / length;
  const side = step.turn === "clockwise" ? 1 : -1;
  const nx = side * uy;
  const ny = side * -ux;
  // `at` is the far longitudinal extent. These three points form a smooth,
  // deterministic 180-degree reversal without inventing an arbitrary loop.
  const entry = { x: far.x - ux * step.radiusM, y: far.y - uy * step.radiusM };
  const outer = { x: far.x + nx * step.radiusM, y: far.y + ny * step.radiusM };
  const exit = { x: entry.x + nx * step.radiusM * 2, y: entry.y + ny * step.radiusM * 2 };
  assertPointInside(entry, "The swoosh entry");
  assertPointInside(outer, "The swoosh outer arc");
  assertPointInside(exit, "The swoosh exit");
  let required: string[];
  if (targetsFuelEdge) {
    required = appendLeg(points, nearEdge, step.traversal ?? "direct", true, portalRunM);
    appendPoint(points, entry);
  } else {
    required = appendLeg(points, entry, step.traversal ?? "direct", true, portalRunM);
  }
  const handle = step.radiusM * 0.5522847498307936;
  Object.assign(points.at(-1)!, {
    segType: "clothoid",
    prevC: { x: entry.x - ux * handle, y: entry.y - uy * handle },
    nextC: { x: entry.x + ux * handle, y: entry.y + uy * handle },
  });
  points.push(
    {
      ...outer,
      segType: "clothoid",
      prevC: { x: outer.x - nx * handle, y: outer.y - ny * handle },
      nextC: { x: outer.x + nx * handle, y: outer.y + ny * handle },
    } as FieldPointInput,
    {
      ...exit,
      prevC: { x: exit.x + ux * handle, y: exit.y + uy * handle },
    } as FieldPointInput,
  );
  if (targetsFuelEdge) appendPoint(points, { x: nearEdge.x, y: exit.y });
  return required;
}

function addBumpRange(path: PathDoc, anchor: { w0: number; t0: number; w1: number; t1: number }, suffix: number): void {
  const limits = {
    maxVel: Math.min(path.constraints.maxVel, 2),
    maxAccel: path.constraints.maxAccel,
    maxDecel: path.constraints.maxDecel,
    maxAngVel: path.constraints.maxAngVel,
    maxAngAccel: path.constraints.maxAngAccel,
    name: `BUMP traversal${suffix ? ` ${suffix + 1}` : ""}`,
  };
  path.ranges.push({ anchor: "wp", f0: 0, f1: 0, ...anchor, ...limits });
}

function splitContainingRangeForBump(path: PathDoc, containerIndex: number, anchor: { w0: number; t0: number; w1: number; t1: number }, suffix: number): void {
  const container = path.ranges[containerIndex];
  const start = (container.w0 ?? 0) + (container.t0 ?? 0);
  const end = (container.w1 ?? 0) + (container.t1 ?? 0);
  const bumpStart = anchor.w0 + anchor.t0;
  const bumpEnd = anchor.w1 + anchor.t1;
  const baseName = container.name ?? "Speed limit";
  const replacements: PathDoc["ranges"] = [];
  if (start < bumpStart - 1e-6) replacements.push({ ...container, w1: anchor.w0, t1: anchor.t0, name: baseName });
  replacements.push({
    ...container,
    ...anchor,
    maxVel: Math.min(container.maxVel ?? Infinity, 2),
    name: `${baseName} + BUMP traversal${suffix ? ` ${suffix + 1}` : ""}`,
  });
  if (bumpEnd < end - 1e-6) replacements.push({ ...container, w0: anchor.w1, t0: anchor.t1, name: baseName });
  path.ranges.splice(containerIndex, 1, ...replacements);
}

function localAnchor(path: PathDoc, samples: readonly TrajectorySample[], sampleIndex: number): { waypointIndex: number; t: number } {
  const arrivals = orderedWaypointSampleIndices(path.waypoints, samples);
  let waypointIndex = 0;
  while (waypointIndex + 1 < arrivals.length - 1 && arrivals[waypointIndex + 1] <= sampleIndex) waypointIndex += 1;
  const start = samples[arrivals[waypointIndex]]?.s ?? 0;
  const end = samples[arrivals[Math.min(arrivals.length - 1, waypointIndex + 1)]]?.s ?? start;
  const t = end > start + 1e-9 ? (samples[sampleIndex].s - start) / (end - start) : 0;
  return { waypointIndex, t: Math.max(0, Math.min(1, t)) };
}

function bumpCrossingRanges(project: BordeauxProject, path: PathDoc, samples: readonly TrajectorySample[]): Array<{ w0: number; t0: number; w1: number; t1: number }> {
  const intervals: Array<{ first: number; last: number }> = [];
  REBUILT_2026_FIELD.crossingBarriers.flatMap((barrier) => barrier.portals).filter((portal) => portal.traversal === "bump").forEach((portal) => {
    const bounds = officialToAppRect(portal.bounds);
    const rectangle = boundsPolygon({ min: { x: bounds.xMin, y: bounds.yMin }, max: { x: bounds.xMax, y: bounds.yMax } });
    let first = -1;
    samples.forEach((sample, index) => {
      const footprint = robotFootprintAt(project.robot, { x: sample.x, y: sample.y, headingRad: sample.headingRad });
      const footprintBox = polygonBounds(footprint);
      const insideLane = footprintBox.min.y >= bounds.yMin - 1e-6 && footprintBox.max.y <= bounds.yMax + 1e-6;
      const onBump = insideLane && convexPolygonClearance(footprint, rectangle) <= 1e-6;
      if (onBump && first < 0) first = index;
      if (!onBump && first >= 0) { intervals.push({ first, last: index - 1 }); first = -1; }
    });
    if (first >= 0) intervals.push({ first, last: samples.length - 1 });
  });
  const brakingMarginM = Math.max(0, (path.constraints.maxVel ** 2 - 2 ** 2) / (2 * path.constraints.maxDecel)) + 0.1;
  return intervals.sort((left, right) => left.first - right.first).map((interval) => {
    const firstSurfaceDistance = samples[interval.first].s;
    const lastSurfaceDistance = samples[interval.last].s;
    let firstIndex = interval.first;
    let lastIndex = interval.last;
    while (firstIndex > 0 && samples[firstIndex].s > firstSurfaceDistance - brakingMarginM) firstIndex -= 1;
    while (lastIndex + 1 < samples.length && samples[lastIndex].s < lastSurfaceDistance + 0.1) lastIndex += 1;
    firstIndex = Math.max(0, firstIndex - 1);
    lastIndex = Math.min(samples.length - 1, lastIndex + 1);
    const first = localAnchor(path, samples, firstIndex);
    const last = localAnchor(path, samples, lastIndex);
    const start = first.t >= 0.02
      ? { waypointIndex: first.waypointIndex, t: first.t - 0.02 }
      : { waypointIndex: Math.max(0, first.waypointIndex - 1), t: first.waypointIndex > 0 ? 0.98 : 0 };
    const end = last.t <= 0.98
      ? { waypointIndex: last.waypointIndex, t: last.t + 0.02 }
      : { waypointIndex: Math.min(path.waypoints.length - 2, last.waypointIndex + 1), t: last.waypointIndex < path.waypoints.length - 2 ? 0.02 : 1 };
    return { w0: start.waypointIndex, t0: start.t, w1: end.waypointIndex, t1: end.t };
  });
}

function rangeContains(container: PathDoc["ranges"][number], range: { w0: number; t0: number; w1: number; t1: number }): boolean {
  if (container.anchor !== "wp" || container.w0 === undefined || container.w1 === undefined || container.maxVel === undefined || container.maxVel > 2 + 1e-9) return false;
  const startBefore = container.w0 < range.w0 || (container.w0 === range.w0 && (container.t0 ?? 0) <= range.t0 + 1e-9);
  const endAfter = container.w1 > range.w1 || (container.w1 === range.w1 && (container.t1 ?? 0) >= range.t1 - 1e-9);
  return startBefore && endAfter;
}

function collectionHeadingIssue(samples: readonly TrajectorySample[], spans: readonly ActiveCollectionSpan[], intakeDirectionDeg: number): string | null {
  if (samples.length < 3) return null;
  let worst = 0;
  let limit = Number.POSITIVE_INFINITY;
  let checked = false;
  spans.forEach((span) => {
    if (span.intent.allowCrosswiseHeading === true) return;
    checked = true;
    limit = Math.min(limit, span.intent.maxHeadingErrorDeg ?? 5);
    const first = Math.max(1, samples.findIndex((sample) => sample.f >= span.f0 - 1e-5));
    let last = samples.findIndex((sample) => sample.f > span.f1 + 1e-5);
    if (last < 0) last = samples.length - 1;
    last = Math.max(first, Math.min(samples.length - 2, last - 1));
    for (let index = first; index <= last; index += 1) {
      const before = samples[index - 1];
      const after = samples[index + 1];
      const tangent = Math.atan2(after.y - before.y, after.x - before.x);
      const intakeHeading = samples[index].headingRad + intakeDirectionDeg * Math.PI / 180;
      worst = Math.max(worst, Math.abs(Math.atan2(Math.sin(intakeHeading - tangent), Math.cos(intakeHeading - tangent))) * 180 / Math.PI);
    }
  });
  return checked && worst > limit + 0.25 ? `The configured intake deviates ${worst.toFixed(1)}° from collection travel; the allowed error is ${limit.toFixed(1)}°.` : null;
}

function finishHeadingIssue(samples: readonly TrajectorySample[], target: FieldPointInput, shooterDirectionDeg: number, limitDeg: number): string | null {
  const final = samples.at(-1);
  if (!final) return "The planner did not produce a final shooting pose.";
  const targetHeading = Math.atan2(target.y - final.y, target.x - final.x);
  const shooterHeading = final.headingRad + shooterDirectionDeg * Math.PI / 180;
  const error = Math.abs(Math.atan2(Math.sin(shooterHeading - targetHeading), Math.cos(shooterHeading - targetHeading))) * 180 / Math.PI;
  return error > limitDeg + 0.25 ? `The shooter misses its requested target-facing heading by ${error.toFixed(1)}°; the allowed error is ${limitDeg.toFixed(1)}°.` : null;
}

function peak(analysis: RouteCandidate["analysis"], metric: "curvature" | "angularVelocity"): number {
  return analysis.extrema.find((item) => item.metric === metric)?.value ?? 0;
}

function estimatedCollectionArea(project: BordeauxProject, samples: readonly TrajectorySample[], spans: readonly ActiveCollectionSpan[]): number | undefined {
  const intake = project.robot.planning?.intake;
  if (!intake || spans.length === 0 || samples.length < 2) return undefined;
  const cellSize = Math.max(0.04, Math.min(0.15, intake.captureWidthM / 5));
  const covered = new Set<string>();
  const cover = (x: number, y: number) => covered.add(`${Math.floor(x / cellSize)},${Math.floor(y / cellSize)}`);
  spans.forEach((span) => {
    const first = Math.max(0, samples.findIndex((sample) => sample.f >= span.f0 - 1e-5));
    let last = samples.findIndex((sample) => sample.f > span.f1 + 1e-5);
    if (last < 0) last = samples.length;
    last = Math.max(first, last - 1);
    let previous: { x: number; y: number; intakeHeading: number } | null = null;
    for (let index = first; index <= last; index += 1) {
      const sample = samples[index];
      const cos = Math.cos(sample.headingRad);
      const sin = Math.sin(sample.headingRad);
      const center = {
        x: sample.x + intake.centerM.x * cos - intake.centerM.y * sin,
        y: sample.y + intake.centerM.x * sin + intake.centerM.y * cos,
        intakeHeading: sample.headingRad + intake.directionDeg * Math.PI / 180,
      };
      const travel = previous ? Math.hypot(center.x - previous.x, center.y - previous.y) : 0;
      const alongSteps = Math.max(1, Math.ceil(travel / (cellSize / 2)));
      const acrossSteps = Math.max(1, Math.ceil(intake.captureWidthM / (cellSize / 2)));
      for (let along = 0; along <= alongSteps; along += 1) {
        const progress = previous ? along / alongSteps : 1;
        const x = previous ? previous.x + (center.x - previous.x) * progress : center.x;
        const y = previous ? previous.y + (center.y - previous.y) * progress : center.y;
        const heading = previous ? previous.intakeHeading + Math.atan2(Math.sin(center.intakeHeading - previous.intakeHeading), Math.cos(center.intakeHeading - previous.intakeHeading)) * progress : center.intakeHeading;
        for (let across = 0; across <= acrossSteps; across += 1) {
          const offset = -intake.captureWidthM / 2 + intake.captureWidthM * across / acrossSteps;
          cover(x - Math.sin(heading) * offset, y + Math.cos(heading) * offset);
        }
      }
      previous = center;
    }
  });
  return covered.size * cellSize * cellSize;
}

function rankCandidates(candidates: RouteCandidate[], nearTieWindowS: number): RouteCandidate[] {
  const fastest = candidates.filter((candidate) => candidate.valid).reduce((value, candidate) => Math.min(value, candidate.metrics.totalTimeS), Number.POSITIVE_INFINITY);
  return candidates.sort((left, right): number => {
    if (left.valid !== right.valid) return left.valid ? -1 : 1;
    if (!left.valid) return left.id.localeCompare(right.id);
    const leftNear = left.metrics.totalTimeS <= fastest + nearTieWindowS;
    const rightNear = right.metrics.totalTimeS <= fastest + nearTieWindowS;
    if (leftNear !== rightNear) return leftNear ? -1 : 1;
    if (!leftNear) return left.metrics.totalTimeS - right.metrics.totalTimeS || left.id.localeCompare(right.id);
    if ((left.metrics.estimatedCollectionAreaM2 ?? 0) !== (right.metrics.estimatedCollectionAreaM2 ?? 0)) return (right.metrics.estimatedCollectionAreaM2 ?? 0) - (left.metrics.estimatedCollectionAreaM2 ?? 0);
    if ((left.metrics.preferredShootingRangeErrorM ?? Number.POSITIVE_INFINITY) !== (right.metrics.preferredShootingRangeErrorM ?? Number.POSITIVE_INFINITY)) return (left.metrics.preferredShootingRangeErrorM ?? Number.POSITIVE_INFINITY) - (right.metrics.preferredShootingRangeErrorM ?? Number.POSITIVE_INFINITY);
    if (left.metrics.minimumClearanceM !== right.metrics.minimumClearanceM) return right.metrics.minimumClearanceM - left.metrics.minimumClearanceM;
    if (left.metrics.peakCurvatureInvM !== right.metrics.peakCurvatureInvM) return left.metrics.peakCurvatureInvM - right.metrics.peakCurvatureInvM;
    if (left.metrics.peakAngularVelocityRadps !== right.metrics.peakAngularVelocityRadps) return left.metrics.peakAngularVelocityRadps - right.metrics.peakAngularVelocityRadps;
    return left.metrics.waypointCount - right.metrics.waypointCount || left.id.localeCompare(right.id);
  });
}

export function generateRouteCandidates(project: BordeauxProject, request: PlanPathRequest): RouteCandidate[] {
  if (!request.intent.trim()) throw new Error("A route intent is required.");
  const hasSteps = Array.isArray(request.steps) && request.steps.length > 0;
  const hasGoals = Array.isArray(request.goals) && request.goals.length > 0;
  if (hasSteps === hasGoals) throw new Error("A route must provide either legacy goals or ordered steps, but not both.");
  if (hasSteps && request.traversal !== undefined) throw new Error("Ordered steps define traversal per leg and cannot be combined with a global traversal policy.");
  if (hasSteps && request.steps!.length > 12) throw new Error("An ordered route supports at most 12 steps.");
  if (hasGoals && request.goals!.length > 12) throw new Error("A route supports at most 12 goals.");
  const base = request.basePathId ? project.paths.find((path) => path.id === request.basePathId) : project.paths[0];
  if (!base) throw new Error("The project does not contain a base path.");
  const baseStart = base.waypoints[0];
  const physicalHeadingRad = baseStart.theta * Math.PI / 180 + (base.driveBackward ? Math.PI : 0);
  const start = resolveLocation(project, request.start ?? { x: baseStart.x, y: baseStart.y, headingDeg: baseStart.theta }, request, { x: baseStart.x, y: baseStart.y, physicalHeadingRad });
  const goals = (request.goals ?? []).map((goal) => resolveLocation(project, goal, request, { x: start.x, y: start.y, physicalHeadingRad }));
  const name = uniqueName(project, request.name ?? "Agent path");
  const minimumClearanceM = Math.max(0, Math.min(2, request.minimumClearanceM ?? 0.15));
  const portalRunM = robotFootprintRadius(project.robot) + minimumClearanceM + 0.15;
  const effectiveRobotHeightM = project.robot.heightM ?? request.robotHeightM;
  const candidateTraversals: RouteCandidate["traversal"][] = hasSteps ? ["ordered"] : traversalOptions(request);
  const candidates = candidateTraversals.map((traversal, index): RouteCandidate => {
    const points = [start];
    const requiredPortalIds: string[] = [];
    const collectionSpans: CollectionSpan[] = [];
    if (hasSteps) {
      for (const step of request.steps!) {
        const startWaypointIndex = points.length - 1;
        if (step.kind === "travel") {
          const current = points[points.length - 1];
          const goal = resolveLocation(project, step.to, request, { x: current.x, y: current.y, physicalHeadingRad });
          requiredPortalIds.push(...appendLeg(points, goal, step.traversal ?? "direct", true, portalRunM));
        } else {
          const current = points[points.length - 1];
          const at = resolveLocation(project, step.at, request, { x: current.x, y: current.y, physicalHeadingRad });
          requiredPortalIds.push(...appendSwoosh(points, at, step, portalRunM));
        }
        if (step.collectFuel) {
          const previous = collectionSpans.at(-1);
          if (previous && previous.endWaypointIndex === startWaypointIndex && sameCollectionIntent(previous.intent, step.collectFuel)) previous.endWaypointIndex = points.length - 1;
          else collectionSpans.push({ startWaypointIndex, endWaypointIndex: points.length - 1, intent: step.collectFuel });
        }
      }
    } else {
      goals.forEach((goal) => appendLeg(points, goal, traversal as RouteTraversal, false, portalRunM));
      if (request.collectFuel) collectionSpans.push({ startWaypointIndex: 0, endWaypointIndex: points.length - 1, intent: request.collectFuel });
    }
    let finishTarget: FieldPointInput | null = null;
    let finishHeadingDeg: number | undefined;
    if (request.finishFacing) {
      const shooter = project.robot.planning?.shooter;
      if (!shooter) throw new Error("Configure the robot's shooter direction before requesting a target-facing finish.");
      const endpoint = points[points.length - 1];
      finishTarget = resolveLocation(project, request.finishFacing.target, request, { x: endpoint.x, y: endpoint.y, physicalHeadingRad }, true);
      finishHeadingDeg = Math.atan2(finishTarget.y - endpoint.y, finishTarget.x - endpoint.x) * 180 / Math.PI - shooter.directionDeg;
      if (collectionSpans.some((span) => span.endWaypointIndex === points.length - 1)) {
        throw new Error("Use a separate non-collecting final travel step for a target-facing shooting approach.");
      }
    }
    const usesTrench = traversal.startsWith("trench-") || requiredPortalIds.some((id) => id.includes("-trench-"));
    const trenchIssue = usesTrench && effectiveRobotHeightM !== undefined && effectiveRobotHeightM > REBUILT_2026_TRENCH_CLEARANCE_M
      ? `Robot height ${effectiveRobotHeightM.toFixed(3)} m exceeds the 0.565 m TRENCH clearance.`
      : null;
    const route = routePath(project, base, name, points, collectionSpans, finishHeadingDeg, hasSteps);
    const path = route.path;
    const activeCollection = route.collectionSpans;
    const analysisProject = { ...project, paths: [path] };
    const analysisOptions = {
      minimumClearanceM,
      robotHeightM: effectiveRobotHeightM,
      ...(traversal === "ordered" ? { requiredPortalIds } : { requiredTraversal: traversal as RouteTraversal }),
    };
    const analyze = () => analyzePath(analysisProject, path.id, analysisOptions);
    let analysis = analyze();
    const bumpRanges = bumpCrossingRanges(analysisProject, path, analysis.rawSamples);
    bumpRanges.forEach((range, bumpIndex) => {
      const containingIndex = path.ranges.findIndex((existing) => rangeContains(existing, range));
      if (containingIndex >= 0) splitContainingRangeForBump(path, containingIndex, range, bumpIndex);
      else addBumpRange(path, range, bumpIndex);
    });
    if (bumpRanges.length > 0) analysis = analyze();
    const errors = analysis.findings.filter((finding) => finding.severity === "error");
    const headingIssue = activeCollection.length && project.robot.planning?.intake
      ? collectionHeadingIssue(analysis.rawSamples, activeCollection, project.robot.planning.intake.directionDeg)
      : null;
    const shootingHeadingIssue = finishTarget && project.robot.planning?.shooter
      ? finishHeadingIssue(analysis.rawSamples, finishTarget, project.robot.planning.shooter.directionDeg, request.finishFacing?.maxHeadingErrorDeg ?? 5)
      : null;
    const clearance = minimumPathClearance(analysisProject, analysis.rawSamples);
    const collectionAreaM2 = estimatedCollectionArea(project, analysis.rawSamples, activeCollection);
    const shootingRangeM = finishTarget && analysis.rawSamples.length ? Math.hypot(finishTarget.x - analysis.rawSamples.at(-1)!.x, finishTarget.y - analysis.rawSamples.at(-1)!.y) : undefined;
    const preferredRangeM = project.robot.planning?.shooter?.preferredRangeM;
    const valid = !trenchIssue && !headingIssue && !shootingHeadingIssue && errors.length === 0 && analysis.totalTimeS !== null;
    return {
      id: `route_${index + 1}_${path.id}`,
      label: traversal === "ordered" ? "Ordered route with typed swoosh" : traversal === "direct" ? "Direct candidate" : `Via ${traversal.replace("-", " ")}`,
      traversal,
      ...(requiredPortalIds.length ? { requiredPortalIds } : {}),
      path,
      metrics: {
        totalTimeS: analysis.totalTimeS ?? 0,
        totalDistanceM: analysis.totalDistanceM ?? 0,
        minimumClearanceM: clearance,
        waypointCount: path.waypoints.length,
        peakCurvatureInvM: peak(analysis, "curvature"),
        peakAngularVelocityRadps: peak(analysis, "angularVelocity"),
        ...(collectionAreaM2 === undefined ? {} : { estimatedCollectionAreaM2: collectionAreaM2 }),
        ...(shootingRangeM === undefined ? {} : { shootingRangeM }),
        ...(shootingRangeM === undefined || preferredRangeM === undefined ? {} : { preferredShootingRangeErrorM: Math.abs(shootingRangeM - preferredRangeM) }),
      },
      analysis,
      diagnostics: analysis.plannerDiagnostics,
      valid,
      ...(valid ? {} : { rejectionReason: trenchIssue ?? headingIssue ?? shootingHeadingIssue ?? errors[0]?.message ?? "The planner could not generate this candidate." }),
    };
  });
  return rankCandidates(candidates, Math.max(0, Math.min(2, request.nearTieWindowS ?? 0.1))).slice(0, Math.max(1, Math.min(MAX_CANDIDATES, request.maximumCandidates ?? 3)));
}
