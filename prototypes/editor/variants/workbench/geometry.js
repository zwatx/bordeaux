// Camera and timing helpers for the Workbench variant.
import { FIELD_H, FIELD_W } from "../../core/Field.jsx";

/** World-space bounds of a path (sampled curve when available), padded by roughly a robot half-diagonal. */
export function pathBounds(path, derived, pad = 0.6) {
  const pts = derived?.sample?.pts?.length ? derived.sample.pts : path.waypoints;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  pts.forEach((p) => { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); });
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}

/** Camera { cx, cy, k } that fits `b` in a viewport of `size`, never zooming in absurdly and avoiding empty space past the field. */
export function fitView(b, size, margin = 56) {
  const bw = Math.max(1, b.x1 - b.x0), bh = Math.max(1, b.y1 - b.y0);
  // Never zoom past ~1.9x the whole-field fit, so the surroundings stay readable.
  const kField = Math.min((size.w - 32) / FIELD_W, (size.h - 32) / FIELD_H);
  const k = Math.max(20, Math.min(kField * 1.9, Math.min((size.w - 2 * margin) / bw, (size.h - 2 * margin) / bh)));
  const clampAxis = (c, half, extent) => (2 * half >= extent + 0.6 ? extent / 2 : Math.max(half - 0.3, Math.min(extent - half + 0.3, c)));
  return {
    k,
    cx: clampAxis((b.x0 + b.x1) / 2, size.w / 2 / k, FIELD_W),
    cy: clampAxis((b.y0 + b.y1) / 2, size.h / 2 / k, FIELD_H),
  };
}

export function visibleBounds(cam, size) {
  const hw = size.w / 2 / cam.k, hh = size.h / 2 / cam.k;
  return { x0: cam.x - hw, x1: cam.x + hw, y0: cam.y - hh, y1: cam.y + hh };
}

/** Planned time (s) at path fraction f. */
export function timeAtF(derived, f) {
  const pts = derived?.sample?.pts, t = derived?.prof?.t;
  if (!pts?.length || !t?.length) return 0;
  const total = pts[pts.length - 1].s || 1, target = f * total;
  let lo = 0, hi = Math.min(pts.length, t.length) - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (pts[mid].s < target) lo = mid + 1; else hi = mid; }
  return t[lo] || 0;
}

/** Short on-path label: what is wrong and by how much. */
export function issueLabel(issue, path) {
  const msg = issue.message || "";
  if (issue.code) return msg.replace(/ limit$/, "");
  const n = Number((msg.match(/([\d.]+)\s*(m\/s²|°\/s)/) || [])[1]);
  const c = path.constraints || {};
  if (/^Acceleration/.test(msg)) return over(n - c.maxAccel, 0.1, "Accelerating too hard", (d) => `Accel ${d.toFixed(1)} m/s² over`);
  if (/^Deceleration/.test(msg)) return over(n - (c.maxDecel || c.maxAccel), 0.1, "Braking too hard", (d) => `Braking ${d.toFixed(1)} m/s² over`);
  if (/^Angular/.test(msg)) return over(n - c.maxAngVel, 1, "Turning too fast", (d) => `Turning ${Math.round(d)}°/s over`);
  return msg;
}
const over = (d, min, plain, fmt) => (Number.isFinite(d) && d >= min ? fmt(d) : plain);

/** Index of a waypoint sitting on top of its predecessor, or -1. */
export function overlappingPoint(path, tolerance = 0.12) {
  const w = path.waypoints;
  for (let i = 1; i < w.length; i++) if (Math.hypot(w[i].x - w[i - 1].x, w[i].y - w[i - 1].y) < tolerance) return i;
  return -1;
}

/**
 * Greedy label placement: each label tries its candidate offsets in order and takes the first
 * that overlaps nothing placed so far (falls back to the first candidate).
 */
export function placeLabels(labels, obstacles = [], bounds = null) {
  const placed = obstacles.slice();
  const outside = (a) => bounds && (a.x < 4 || a.y < 4 || a.x + a.w > bounds.w - 4 || a.y + a.h > bounds.h - 4);
  const hit = (a) => outside(a) || placed.some((b) => a.x < b.x + b.w + 2 && a.x + a.w + 2 > b.x && a.y < b.y + b.h + 2 && a.y + a.h + 2 > b.y);
  const out = [];
  labels.forEach((l) => {
    const w = l.w ?? Math.round(l.text.length * 6.3 + 13), h = 19;
    const base = l.candidates(w, h);
    // Near slots first, then the same slots pushed one row further out.
    const tries = [...base, ...base.map(([dx, dy]) => [dx, dy + (dy < 0 ? -22 : 22)])];
    let box = null;
    for (const [dx, dy] of tries) {
      const cand = { x: l.x + dx, y: l.y + dy, w, h };
      if (!hit(cand)) { box = cand; break; }
    }
    if (!box) {
      if (l.optional) return; // Crowded: drop low-priority labels rather than stack them.
      const [dx, dy] = base[0];
      box = { x: l.x + dx, y: l.y + dy, w, h };
    }
    placed.push(box);
    out.push({ ...l, box });
  });
  return out;
}

/** planPath marks unlocalized problems by spanning the whole path. */
export const isWhole = (issue) => Boolean(issue.whole) || (issue.f0 <= 0.001 && issue.f1 >= 0.999);
export const fmtTime = (t) => (t == null || !Number.isFinite(t) ? "—" : t.toFixed(2));
