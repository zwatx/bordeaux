// Deep crimson (low) through signal red to bright coral (high). Lightness rises and the hue warms a little, so faster
// stretches read brighter and more orange while every value stays clearly red, never a pale near-white. The low end is
// where every path starts and stops and where slow, capped paths sit, so it stays above 3:1 on the dark path casing.
// Each stop sits just inside the sRGB gamut edge for its lightness, and so does the ramp between them.
const HEATMAP = [[0.52, 0.190, 12], [0.64, 0.222, 24], [0.76, 0.140, 35]] as const;

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
