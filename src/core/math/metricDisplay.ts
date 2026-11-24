// Both ramps increase lightness so low values read as darker stretches on the thin field line.
const TEAL_HEATMAP = [[0.50, 0.090, 232], [0.70, 0.115, 192], [0.95, 0.075, 152]] as const;
const VELOCITY_HEATMAP = [[0.55, 0.162, 13], [0.72, 0.152, 23], [0.88, 0.083, 35]] as const;

export function metricColor(mode: string, value: number) {
  const heatmap = mode === 'velocity' ? VELOCITY_HEATMAP : TEAL_HEATMAP;
  const t = Math.max(0, Math.min(1, Number.isNaN(value) ? 0 : value)) * 2;
  const index = Math.min(1, Math.floor(t));
  const before = heatmap[index], after = heatmap[index + 1];
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
