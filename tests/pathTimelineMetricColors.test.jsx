import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import corpus from '../benchmarks/planner-corpus/v2/corpus.bordeaux.json';
import { PathTimeline } from '../src/renderer/components/PathTimeline';
import { buildTimeline } from '../src/renderer/components/pathTimelineModel';
import { PM } from '../src/renderer/lib/pathMath';

describe('timeline graph colors', () => {
  const doc = structuredClone(corpus.paths.find((p) => p.id === 'corpus-neutral-slalom'));
  const derived = PM.derivePath(doc, corpus.robot, 60, 'profiledSpline');
  const tl = buildTimeline(derived);
  const store = { subscribe: () => () => {}, getSnapshot: () => ({ time: 0, playing: false }), seek: () => {}, toggle: () => {} };
  const strokes = (metric) => {
    const html = renderToStaticMarkup(React.createElement(PathTimeline, {
      doc, derived, tl, robot: corpus.robot, metric, sel: { kind: null, idx: -1 }, select: () => {}, edit: {}, actions: {}, playbackStore: store, catalog: null }));
    return [...html.match(/<g class="pt-curve">(.*?)<\/g>/)[1].matchAll(/stroke="([^"]+)"/g)].map((match) => match[1]);
  };
  const palette = Array.from({ length: 101 }, (_, i) => PM.metricColor('velocity', i / 100));
  const lightness = (color) => Number(color.match(/^oklch\(([\d.]+)/)[1]);

  it.each(['velocity', 'accel', 'angvel', 'curvature'])('draws the %s line in the field heatmap, never a flat accent', (metric) => {
    const colors = strokes(metric);
    expect(colors.length).toBeGreaterThan(10);
    for (const color of colors) expect(color).toMatch(/^oklch\(/);
    const [low, high] = [palette[0], palette[100]].map(lightness);
    for (const color of colors) expect(lightness(color)).toBeGreaterThanOrEqual(low - 1e-4), expect(lightness(color)).toBeLessThanOrEqual(high + 1e-4);
    // A real path varies, so the line is not a single color.
    expect(new Set(colors).size).toBeGreaterThan(1);
  });
  it('uses the field scale for the path, so a value has one color in both views', () => {
    const brightest = (scaled) => {
      const html = renderToStaticMarkup(React.createElement(PathTimeline, {
        doc, derived: scaled, tl, robot: corpus.robot, metric: 'curvature', sel: { kind: null, idx: -1 }, select: () => {}, edit: {}, actions: {}, playbackStore: store, catalog: null }));
      return Math.max(...[...html.match(/<g class="pt-curve">(.*?)<\/g>/)[1].matchAll(/stroke="([^"]+)"/g)].map((match) => lightness(match[1])));
    };
    expect(derived.metrics.kMax).toBeGreaterThan(0);
    // The path's own peak takes the bright end; a field scale four times larger keeps the whole line darker.
    expect(brightest(derived)).toBeGreaterThan(lightness(palette[60]));
    expect(brightest({ ...derived, metrics: { ...derived.metrics, kMax: derived.metrics.kMax * 4 } })).toBeLessThan(lightness(palette[40]));
  });
});
