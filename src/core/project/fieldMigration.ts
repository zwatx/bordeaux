import { FIELD_H, FIELD_W, rotateBlueOriginPoint } from "../math/fieldBounds";
import { MAX_AUTHORED_ANGLE_DEG } from "../planners/limits";
import { ACTIVE_FIELD_REFERENCE, BLUE_ORIGIN_FIELD_SCHEMA_ID } from "../field/rebuilt2026";

export const LEGACY_FIELD_SCHEMA = "bordeaux-field/1.0";
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
export const BLUE_ORIGIN_FIELD_REFERENCE = { ...ACTIVE_FIELD_REFERENCE, coordinateSchemaId: BLUE_ORIGIN_FIELD_SCHEMA_ID };

/** Convert historical field-space data before normalization. Invalid geometry
 * stays invalid and command arguments remain opaque.
 */
export function migrateFieldProject(value: unknown): unknown {
  if (!record(value) || !Array.isArray(value.paths)) return value;
  const schema = record(value.field) ? value.field.coordinateSchemaId : undefined;
  const legacy = value.field === undefined || schema === LEGACY_FIELD_SCHEMA;
  if (!legacy && schema !== BLUE_ORIGIN_FIELD_SCHEMA_ID) return value;
  const defaultSource = value.field === undefined ? "legacy-unpinned" : legacy ? LEGACY_FIELD_SCHEMA : BLUE_ORIGIN_FIELD_SCHEMA_ID;
  const original = value.fieldMigration;
  const previous = !legacy && record(original) && record(original.assigned)
    && original.assigned.id === BLUE_ORIGIN_FIELD_REFERENCE.id
    && original.assigned.revision === BLUE_ORIGIN_FIELD_REFERENCE.revision
    && original.assigned.coordinateSchemaId === BLUE_ORIGIN_FIELD_SCHEMA_ID
    && (original.source === "legacy-unpinned" || original.source === LEGACY_FIELD_SCHEMA)
    ? original.source : undefined;
  if (original !== undefined && !previous) throw new Error("$.fieldMigration: Invalid historical field migration record.");

  const heading = (raw: unknown, path: string) => {
    if (!finite(raw)) return raw;
    const rotated = raw + (legacy ? 360 : 180);
    if (Math.abs(raw) > MAX_AUTHORED_ANGLE_DEG || Math.abs(rotated) > MAX_AUTHORED_ANGLE_DEG) {
      throw new Error(`${path}: Heading is outside the planner’s supported range after field migration.`);
    }
    return rotated;
  };
  const point = (raw: unknown): unknown => record(raw) && finite(raw.x) && finite(raw.y)
    ? { ...raw, ...rotateBlueOriginPoint(legacy
      ? { x: (1 - raw.x / 17.548) * FIELD_W, y: (1 - raw.y / 8.052) * FIELD_H }
      : { x: raw.x, y: raw.y }) } : raw;
  const paths = value.paths.map((raw, pathIndex) => {
    const base = `$.paths[${pathIndex}]`;
    if (!record(raw)) return raw;
    return { ...raw,
      ...(Array.isArray(raw.waypoints) ? { waypoints: raw.waypoints.map((waypoint, index) => {
        const at = `${base}.waypoints[${index}]`;
        if (!record(waypoint)) return waypoint;
        return { ...(point(waypoint) as Record<string, unknown>), theta: heading(waypoint.theta, `${at}.theta`),
          prevC: point(waypoint.prevC), nextC: point(waypoint.nextC),
          ...(waypoint.segmentLookAt !== undefined ? { segmentLookAt: point(waypoint.segmentLookAt) } : {}),
          ...(record(waypoint.turnInPlace) ? { turnInPlace: { ...waypoint.turnInPlace, headingDeg: heading(waypoint.turnInPlace.headingDeg, `${at}.turnInPlace.headingDeg`) } } : {}),
        };
      }) } : {}),
      ...(Array.isArray(raw.targets) ? { targets: raw.targets.map((target, index) => record(target) ? { ...target, deg: heading(target.deg, `${base}.targets[${index}].deg`) } : target) } : {}),
      // Accepted samples retain their original provenance/key; the changed field and source invalidate them.
    };
  });
  let strategy = value.strategy;
  if (record(strategy) && Array.isArray(strategy.locations)) strategy = { ...strategy, locations: strategy.locations.map((location, index) => {
    if (!record(location)) return location;
    const headingPatch = location.headingDeg !== undefined ? { headingDeg: heading(location.headingDeg, `$.strategy.locations[${index}].headingDeg`) } : {};
    if (location.kind === "pose") return { ...(point(location) as Record<string, unknown>), ...headingPatch };
    if (location.kind === "region" && record(location.bounds)) {
      const bounds = location.bounds;
      if ([bounds.xMin, bounds.xMax, bounds.yMin, bounds.yMax].every(finite)) {
        const first = point(legacy ? { x: bounds.xMin, y: bounds.yMin } : { x: bounds.xMax, y: bounds.yMax }) as { x: number; y: number };
        const last = point(legacy ? { x: bounds.xMax, y: bounds.yMax } : { x: bounds.xMin, y: bounds.yMin }) as { x: number; y: number };
        return { ...location, ...headingPatch, bounds: { xMin: first.x, xMax: last.x, yMin: first.y, yMax: last.y } };
      }
    }
    return location;
  }) };
  return { ...value, paths, ...(strategy !== undefined ? { strategy } : {}), field: { ...ACTIVE_FIELD_REFERENCE },
    fieldMigration: { source: previous ?? defaultSource,
      ...(legacy || previous ? { via: { ...BLUE_ORIGIN_FIELD_REFERENCE } } : {}), assigned: { ...ACTIVE_FIELD_REFERENCE } } };
}
