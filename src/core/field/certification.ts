import { sha256Hex } from "../bytes";
import { FIELD_X_MAX, FIELD_Y_MAX, centerAndyMarkPoint } from "../math/fieldBounds";
import {
  ACTIVE_FIELD_REFERENCE,
  REBUILT_2026_FIELD,
  REBUILT_2026_TAG_LAYOUT,
  appToAllianceViewPoint,
} from "./rebuilt2026";
import type { FieldPack, FieldPoint, FieldRect } from "./types";

const CERTIFICATION_SCHEMA_VERSION = "bordeaux-field-certification/1.0" as const;
const EPSILON = 1e-8;

/** Update deliberately only after reviewing a changed certification report. */
export const FIELD_CERTIFICATION_EXPECTED_DIGEST = "sha256:a74b0bc94e29f9fe80082689561253b6291cf5a6a9c0809663eb51cf4886794d";

/** These commitments are deliberately distinct so coordinate fixes do not imply full behavior certification. */
export const FIELD_SUPPORT_PROMISES = {
  coordinatesWithinHours: 48,
  fullSupportWithinDays: 7,
} as const;

export interface FieldCertificationCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface FieldCertificationReport {
  schemaVersion: typeof CERTIFICATION_SCHEMA_VERSION;
  passed: boolean;
  digest: string;
  expectedDigest: string | null;
  field: {
    id: string;
    revision: string;
    coordinateSchemaId: string;
  };
  supportPromises: typeof FIELD_SUPPORT_PROMISES;
  sources: Array<{ label: string; revision: string; sha256: string | null }>;
  checks: FieldCertificationCheck[];
}

export interface FieldCertificationTransforms {
  officialToAppPoint: (point: FieldPoint) => FieldPoint;
  appToOfficialPoint: (point: FieldPoint) => FieldPoint;
}

export interface FieldCertificationOptions {
  /** null is reserved for isolated invariant tests; release certification always uses the frozen digest. */
  expectedDigest?: string | null;
  coordinateSchemaId?: string;
  transforms?: FieldCertificationTransforms;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Certification input contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  throw new Error(`Certification input has unsupported ${typeof value} value`);
}

function digest(value: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}

function finitePoint(point: FieldPoint | undefined): point is FieldPoint {
  return !!point && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function finiteRect(rect: FieldRect | undefined): rect is FieldRect {
  return !!rect && [rect.xMin, rect.xMax, rect.yMin, rect.yMax].every(Number.isFinite)
    && rect.xMin < rect.xMax && rect.yMin < rect.yMax;
}

function pointInBounds(point: FieldPoint, dimensions: FieldPack["dimensions"]): boolean {
  return Math.abs(point.x) <= dimensions.lengthM / 2 + EPSILON
    && Math.abs(point.y) <= dimensions.widthM / 2 + EPSILON;
}

function rectInBounds(rect: FieldRect, dimensions: FieldPack["dimensions"]): boolean {
  return rect.xMin >= -dimensions.lengthM / 2 - EPSILON && rect.xMax <= dimensions.lengthM / 2 + EPSILON
    && rect.yMin >= -dimensions.widthM / 2 - EPSILON && rect.yMax <= dimensions.widthM / 2 + EPSILON;
}

function close(left: number, right: number): boolean {
  return Math.abs(left - right) <= EPSILON;
}

function segmentIntersectsRect(start: FieldPoint, end: FieldPoint, rect: FieldRect): boolean {
  const minX = Math.min(start.x, end.x);
  const maxX = Math.max(start.x, end.x);
  const minY = Math.min(start.y, end.y);
  const maxY = Math.max(start.y, end.y);
  if (maxX < rect.xMin || minX > rect.xMax || maxY < rect.yMin || minY > rect.yMax) return false;
  if (start.x >= rect.xMin && start.x <= rect.xMax && start.y >= rect.yMin && start.y <= rect.yMax) return true;
  if (end.x >= rect.xMin && end.x <= rect.xMax && end.y >= rect.yMin && end.y <= rect.yMax) return true;
  if (close(start.x, end.x)) return start.x >= rect.xMin && start.x <= rect.xMax;
  if (close(start.y, end.y)) return start.y >= rect.yMin && start.y <= rect.yMax;
  const slope = (end.y - start.y) / (end.x - start.x);
  const atXMin = start.y + slope * (rect.xMin - start.x);
  const atXMax = start.y + slope * (rect.xMax - start.x);
  return (atXMin >= rect.yMin && atXMin <= rect.yMax) || (atXMax >= rect.yMin && atXMax <= rect.yMax);
}

function landmarkGeometryIsValid(pack: FieldPack): boolean {
  const ids = new Set<string>();
  return pack.landmarks.every((landmark) => {
    if (!landmark.id || ids.has(landmark.id)) return false;
    ids.add(landmark.id);
    if (landmark.point && (!finitePoint(landmark.point) || !pointInBounds(landmark.point, pack.dimensions))) return false;
    if (landmark.bounds && (!finiteRect(landmark.bounds) || !rectInBounds(landmark.bounds, pack.dimensions))) return false;
    if (landmark.line && (!finitePoint(landmark.line.start) || !finitePoint(landmark.line.end)
      || !pointInBounds(landmark.line.start, pack.dimensions) || !pointInBounds(landmark.line.end, pack.dimensions))) return false;
    return true;
  });
}

export function certifyField(
  pack: FieldPack = REBUILT_2026_FIELD,
  options: FieldCertificationOptions = {},
): FieldCertificationReport {
  const transforms = options.transforms ?? { officialToAppPoint: centerAndyMarkPoint, appToOfficialPoint: centerAndyMarkPoint };
  const coordinateSchemaId = options.coordinateSchemaId ?? ACTIVE_FIELD_REFERENCE.coordinateSchemaId;
  const expectedDigest = options.expectedDigest === undefined
    ? FIELD_CERTIFICATION_EXPECTED_DIGEST
    : options.expectedDigest;
  const checks: FieldCertificationCheck[] = [];
  const check = (name: string, passed: boolean, detail: string) => checks.push({ name, passed, detail });
  const certificationDigest = digest({
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    field: { id: pack.id, revision: pack.revision, coordinateSchemaId },
    supportPromises: FIELD_SUPPORT_PROMISES,
    pack,
  });

  const officialSamples: FieldPoint[] = [
    { x: 0, y: 0 },
    { x: pack.dimensions.lengthM, y: pack.dimensions.widthM },
    ...pack.crossingBarriers.flatMap((barrier) => barrier.portals.map((portal) => centerAndyMarkPoint(portal.point))),
  ];
  let roundtrip = true;
  try {
    roundtrip = officialSamples.every((point) => {
      const app = transforms.officialToAppPoint(point);
      const restored = finitePoint(app) ? transforms.appToOfficialPoint(app) : undefined;
      return finitePoint(restored) && close(restored.x, point.x) && close(restored.y, point.y);
    });
  } catch { roundtrip = false; }
  check("transform.roundtrip", roundtrip, "AndyMark blue-origin and centered transforms round-trip corners and every portal center.");

  let orientation = true;
  try {
    const officialCorners = [
      { official: { x: 0, y: 0 }, app: { x: FIELD_X_MAX, y: FIELD_Y_MAX } },
      { official: { x: pack.dimensions.lengthM, y: 0 }, app: { x: -FIELD_X_MAX, y: FIELD_Y_MAX } },
      { official: { x: 0, y: pack.dimensions.widthM }, app: { x: FIELD_X_MAX, y: -FIELD_Y_MAX } },
      { official: { x: pack.dimensions.lengthM, y: pack.dimensions.widthM }, app: { x: -FIELD_X_MAX, y: -FIELD_Y_MAX } },
    ];
    orientation = officialCorners.every(({ official, app: expected }) => {
      const app = transforms.officialToAppPoint(official);
      return finitePoint(app) && close(app.x, expected.x) && close(app.y, expected.y);
    });
    const blueOrigin = transforms.officialToAppPoint({ x: 0, y: 0 });
    const redOpposite = transforms.officialToAppPoint({ x: pack.dimensions.lengthM, y: pack.dimensions.widthM });
    const redView = finitePoint(blueOrigin) ? appToAllianceViewPoint(blueOrigin, "red") : undefined;
    orientation = orientation && finitePoint(redView) && finitePoint(redOpposite)
      && close(redView.x, redOpposite.x) && close(redView.y, redOpposite.y);
  } catch { orientation = false; }
  check("transform.alliance-orientation", orientation, "Authored coordinates use centered meters; the opposite alliance is a 180-degree rotation within the same fixed frame.");

  const find = (id: string) => pack.landmarks.find((landmark) => landmark.id === id);
  const wall = find("blue-alliance-wall")?.line;
  const rail = find("scoring-table-guardrail")?.line;
  const wallTag = find("apriltag-29")?.point;
  const blueBarrier = pack.crossingBarriers.find((barrier) => barrier.allianceOwner === "blue");
  check("andymark.perimeter-and-wall-tags",
    !!wall && !!rail && !!wallTag && [wall.start.x, wall.end.x].every((x) => close(x, 8.259))
    && [rail.start.y, rail.end.y].every((y) => close(y, 4.0215))
    && close(wallTag.x, 8.2453094) && close(wallTag.y, 3.3707266),
    "Perimeter and wall tags use WPILib v2026.2.1 AndyMark measurements.");
  const layoutDimensions = REBUILT_2026_TAG_LAYOUT["field-dimensions"];
  check("apriltag.official-layout",
    close(layoutDimensions.length, pack.dimensions.lengthM) && close(layoutDimensions.width, pack.dimensions.widthM)
    && REBUILT_2026_TAG_LAYOUT["field-tags"].every(({ ID }) => find(`apriltag-${ID}`)?.point),
    "Every tag in the vendored WPILib layout is a landmark, and the layout measures the same field as the pack.");
  check("andymark.interior-registration", !!blueBarrier
    && close(blueBarrier.x, 4.24206)
    && blueBarrier.portals.filter((portal) => portal.side === "table").every(({ point }) => point.y > 0)
    && blueBarrier.portals.filter((portal) => portal.side === "away").every(({ point }) => point.y < 0),
    "Interior features retain the welded center-relative geometry; the perimeter limits the wall-side trench clear span.");

  check("landmark.unique-finite-in-bounds", landmarkGeometryIsValid(pack), "Landmarks have unique IDs and all declared coordinates, lines, and regions are finite and in bounds.");

  const landmarkIds = new Set(pack.landmarks.map((landmark) => landmark.id));
  const obstacleValid = pack.solidObstacles.every((obstacle) => obstacle.behavior === "solid"
    && obstacle.kind === "obstacle" && landmarkIds.has(obstacle.id)
    && finiteRect(obstacle.bounds) && rectInBounds(obstacle.bounds, pack.dimensions));
  check("obstacle.shape-and-behavior", obstacleValid, "Solid obstacles are declared obstacle landmarks with finite in-bounds rectangular footprints.");

  const portalIds = new Set<string>();
  const portalGeometryValid = pack.crossingBarriers.every((barrier) => Number.isFinite(barrier.x)
    && barrier.portals.every((portal) => {
      if (portalIds.has(portal.id)) return false;
      portalIds.add(portal.id);
      return finitePoint(portal.point) && finiteRect(portal.bounds) && pointInBounds(portal.point, pack.dimensions)
        && rectInBounds(portal.bounds, pack.dimensions) && portal.widthM > 0 && portal.depthM > 0
        && close(portal.depthM, portal.bounds.xMax - portal.bounds.xMin)
        && close(portal.widthM, portal.bounds.yMax - portal.bounds.yMin)
        && portal.point.x >= portal.bounds.xMin - EPSILON && portal.point.x <= portal.bounds.xMax + EPSILON
        && portal.point.y >= portal.bounds.yMin - EPSILON && portal.point.y <= portal.bounds.yMax + EPSILON
        && barrier.x >= portal.bounds.xMin - EPSILON && barrier.x <= portal.bounds.xMax + EPSILON;
    }));
  check("portal.geometry", portalGeometryValid, "Every crossing barrier has unique portals with finite, bounded width and depth footprints.");

  const trenchClearanceValid = pack.crossingBarriers.flatMap((barrier) => barrier.portals)
    .filter((portal) => portal.traversal === "trench")
    .every((portal) => typeof portal.clearanceHeightM === "number" && Number.isFinite(portal.clearanceHeightM) && portal.clearanceHeightM > 0);
  check("portal.trench-clearance", trenchClearanceValid, "Every TRENCH portal declares a positive overhead clearance height.");

  const blue = pack.crossingBarriers.find((barrier) => barrier.allianceOwner === "blue");
  const red = pack.crossingBarriers.find((barrier) => barrier.allianceOwner === "red");
  const symmetryValid = !!blue && !!red && blue.portals.length === red.portals.length && blue.portals.every((bluePortal) => {
    const redPortal = red.portals.find((candidate) => candidate.traversal === bluePortal.traversal && candidate.side === bluePortal.side);
    return !!redPortal && close(bluePortal.point.x + redPortal.point.x, 0)
      && close(bluePortal.point.y, redPortal.point.y) && close(bluePortal.widthM, redPortal.widthM)
      && close(bluePortal.depthM, redPortal.depthM) && bluePortal.allianceSide !== redPortal.allianceSide;
  });
  check("crossing.red-blue-symmetry", symmetryValid, "Blue and Red portal centers, dimensions, and driver-relative sides mirror across the field length.");

  const routes = pack.crossingBarriers.flatMap((barrier) => barrier.portals.map((portal) => {
    const fromAllianceSide = barrier.allianceOwner === "blue" ? portal.bounds.xMax + 0.2 : portal.bounds.xMin - 0.2;
    const towardNeutral = barrier.allianceOwner === "blue" ? portal.bounds.xMin - 0.2 : portal.bounds.xMax + 0.2;
    return { portal, points: [{ x: fromAllianceSide, y: portal.point.y }, portal.point, { x: towardNeutral, y: portal.point.y }] };
  }));
  const routeBoundsAndOpening = routes.every(({ portal, points }) => points.every((point) => pointInBounds(point, pack.dimensions))
    && portal.point.y >= portal.bounds.yMin - EPSILON && portal.point.y <= portal.bounds.yMax + EPSILON
    && portal.point.x >= portal.bounds.xMin - EPSILON && portal.point.x <= portal.bounds.xMax + EPSILON);
  check("route.bounds-and-declared-opening", routeBoundsAndOpening, "Each before-center-after route stays in bounds and crosses its declared portal opening.");

  const routeAvoidsObstacles = routes.every(({ points }) => points.slice(1).every((point, index) => {
    const start = points[index];
    return pack.solidObstacles.every((obstacle) => finiteRect(obstacle.bounds) && !segmentIntersectsRect(start, point, obstacle.bounds));
  }));
  check("route.avoids-solid-obstacles", routeAvoidsObstacles, "Representative before-center-after routes through every portal avoid every solid obstacle.");

  check("certification.digest", expectedDigest === null || certificationDigest === expectedDigest,
    expectedDigest === null ? "Frozen digest comparison disabled for this isolated certification run." : `Expected ${expectedDigest}; received ${certificationDigest}.`);

  return {
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    passed: checks.every((item) => item.passed),
    digest: certificationDigest,
    expectedDigest,
    field: { id: pack.id, revision: pack.revision, coordinateSchemaId },
    supportPromises: FIELD_SUPPORT_PROMISES,
    sources: pack.sources.map(({ label, revision, sha256 }) => ({ label, revision, sha256: sha256 ?? null })),
    checks,
  };
}
