// One teal hue that no other field meaning uses (alliance red/blue, zone amber, command violet, problem red).
// Increasing OKLCH lightness carries the value, so slow stretches read dim and fast ones bright, in every metric.
const HEATMAP = [[0.56, 0.060, 178], [0.74, 0.085, 178], [0.92, 0.060, 178]] as const;

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
