import type { JiggleAction, Waypoint } from "../types";

const DEG = Math.PI / 180;

export function jigglePositions(
  anchor: Pick<Waypoint, "x" | "y">,
  baseRad: number,
  options: JiggleAction & { distance?: number },
  bounds = { w: 16.541, h: 8.069 },
): Array<{ x: number; y: number }> | null {
  const distance = Number(options.distanceM ?? options.distance);
  const strokes = Math.round(Number(options.strokes));
  const startDeg = Number(options.startDeg);
  const stepDeg = Number(options.stepDeg);
  if (!(distance >= 0.03) || strokes < 2 || strokes > 12 || !Number.isFinite(startDeg + stepDeg)) return null;
  const directions = new Set<number>();
  const positions: Array<{ x: number; y: number }> = [];
  for (let stroke = 0; stroke < strokes; stroke += 1) {
    const relativeDeg = startDeg + stepDeg * stroke;
    const key = Math.round((((relativeDeg % 360) + 360) % 360) * 1000) / 1000;
    if (directions.has(key)) return null;
    directions.add(key);
    const angle = baseRad + relativeDeg * DEG;
    const point = { x: anchor.x + Math.cos(angle) * distance, y: anchor.y + Math.sin(angle) * distance };
    if (point.x < 0 || point.x > bounds.w || point.y < 0 || point.y > bounds.h) return null;
    positions.push(point, { x: anchor.x, y: anchor.y });
  }
  return positions;
}
