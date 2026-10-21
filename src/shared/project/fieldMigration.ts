import { FIELD_H, FIELD_W } from "../math/fieldBounds";
import { ACTIVE_FIELD_REFERENCE } from "../field/rebuilt2026";

export const LEGACY_FIELD_SCHEMA = "bordeaux-field/1.0";
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const heading = (value: unknown) => finite(value) ? value + 180 : value;

/** The old overhead frame had red at low X, Y up, and independently scaled dimensions.
 * Preserve normalized positions in the playing rectangle while rotating into blue origin.
 * Invalid source stays invalid; migration never clamps, deletes or interprets command arguments.
 */
export function migrateLegacyFieldProject(value: unknown): unknown {
  if (!record(value) || !Array.isArray(value.paths)) return value;
  if (value.field !== undefined && (!record(value.field) || value.field.coordinateSchemaId !== LEGACY_FIELD_SCHEMA)) return value;
  const point = (raw: unknown): unknown => record(raw) && finite(raw.x) && finite(raw.y)
    ? { ...raw, x: (1 - raw.x / 17.548) * FIELD_W, y: (1 - raw.y / 8.052) * FIELD_H } : raw;
  const paths = value.paths.map((raw) => {
    if (!record(raw)) return raw;
    return { ...raw,
      ...(Array.isArray(raw.waypoints) ? { waypoints: raw.waypoints.map((waypoint) => {
        if (!record(waypoint)) return waypoint;
        return { ...(point(waypoint) as Record<string, unknown>), theta: heading(waypoint.theta),
          prevC: point(waypoint.prevC), nextC: point(waypoint.nextC),
          ...(waypoint.segmentLookAt !== undefined ? { segmentLookAt: point(waypoint.segmentLookAt) } : {}),
          ...(record(waypoint.turnInPlace) ? { turnInPlace: { ...waypoint.turnInPlace, headingDeg: heading(waypoint.turnInPlace.headingDeg) } } : {}),
        };
      }) } : {}),
      ...(Array.isArray(raw.targets) ? { targets: raw.targets.map((target) => record(target) ? { ...target, deg: heading(target.deg) } : target) } : {}),
      // Accepted samples retain their original provenance/key; the changed field and source invalidate them.
    };
  });
  let strategy = value.strategy;
  if (record(strategy) && Array.isArray(strategy.locations)) strategy = { ...strategy, locations: strategy.locations.map((location) => {
    if (!record(location)) return location;
    const headingPatch = location.headingDeg !== undefined ? { headingDeg: heading(location.headingDeg) } : {};
    if (location.kind === "pose") return { ...(point(location) as Record<string, unknown>), ...headingPatch };
    if (location.kind === "region" && record(location.bounds)) {
      const bounds = location.bounds;
      if ([bounds.xMin, bounds.xMax, bounds.yMin, bounds.yMax].every(finite)) {
        const first = point({ x: bounds.xMax, y: bounds.yMax }) as { x: number; y: number };
        const last = point({ x: bounds.xMin, y: bounds.yMin }) as { x: number; y: number };
        return { ...location, ...headingPatch, bounds: { xMin: first.x, xMax: last.x, yMin: first.y, yMax: last.y } };
      }
    }
    return location;
  }) };
  return { ...value, paths, ...(strategy !== undefined ? { strategy } : {}), field: { ...ACTIVE_FIELD_REFERENCE },
    fieldMigration: { source: value.field === undefined ? "legacy-unpinned" : LEGACY_FIELD_SCHEMA, assigned: { ...ACTIVE_FIELD_REFERENCE } } };
}
