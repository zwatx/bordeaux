// Dark cyan (low) through teal to bright mint (high), close hues no other field meaning uses (alliance red/blue,
// zone amber, command violet, problem red). OKLCH lightness carries most of the value and the small hue turn adds to
// it, so slowdowns on the thin field line read as clearly darker, bluer stretches in every metric. The low end is
// where every path starts and stops (and full deceleration on the signed metrics), so it stays at least 3:1 against
// the dark surfaces and path casing; every stop and the ramp between them stay inside sRGB.
const HEATMAP = [[0.50, 0.090, 232], [0.70, 0.115, 192], [0.95, 0.075, 152]] as const;

export function metricColor(_mode: string, value: number) {
  const t = Math.max(0, Math.min(1, Number.isNaN(value) ? 0 : value)) * 2;
  const index = Math.min(1, Math.floor(t));
  const before = HEATMAP[index], after = HEATMAP[index + 1];
  return `oklch(${before.map((channel, i) => (channel + (after[i] - channel) * (t - index)).toFixed(4)).join(" ")})`;
}

export function metricGradient(mode: string) {
  return 'linear-gradient(90deg in oklch,' + [0, 0.5, 1].map(t => `${metricColor(mode, t)} ${t * 100}%`).join(',') + ')';
}

export const METRICS = [
  { id: 'velocity', label: 'Velocity', unit: 'm/s', kind: 'seq' },
  { id: 'accel', label: 'Acceleration', unit: 'm/s\u00b2', kind: 'div' },
  { id: 'angvel', label: 'Angular velocity', unit: '\u00b0/s', kind: 'div' },
  { id: 'curvature', label: 'Curvature', unit: '1/m', kind: 'seq' },
];
