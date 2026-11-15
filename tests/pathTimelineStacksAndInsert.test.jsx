import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import corpus from '../benchmarks/planner-corpus/v2/corpus.bordeaux.json';
import { PathTimeline, CommandStackMenu, insertionReason } from '../src/renderer/components/PathTimeline';
import { buildTimeline, fAtT, MIN_WAYPOINT_GAP, waypointInsertionAt } from '../src/renderer/components/pathTimelineModel';
import { PM } from '../src/renderer/lib/pathMath';
import { sample } from '../src/shared/math/geometry';

const pathOf = (id) => structuredClone(corpus.paths.find((p) => p.id === id));
const plan = (doc) => PM.derivePath(doc, corpus.robot, 60, 'profiledSpline');

describe('command stacks on the timeline', () => {
  const doc = pathOf('corpus-neutral-slalom');
  doc.markers = [0.14, 0.42, 0.42, 0.42, 0.42, 0.42, 0.428, 0.434, 0.74, 0.74]
    .map((f, i) => ({ id: 'm' + i, f, name: 'Cmd ' + i, cmd: 'none', group: 'sequential' }));
  const derived = plan(doc);
  const tl = buildTimeline(derived);
  const store = { subscribe: () => () => {}, getSnapshot: () => ({ time: 0, playing: false }), seek: () => {}, toggle: () => {} };
  const render = (sel = { kind: null, idx: -1 }) => renderToStaticMarkup(React.createElement(PathTimeline, {
    doc, derived, tl, robot: corpus.robot, sel, select: () => {}, edit: {}, actions: {}, playbackStore: store, catalog: null }));

  it('names what fits in up to three rows and gathers the rest of a crowd into one +N chip', () => {
    const html = render();
    const stacks = html.match(/class="pt-chip stack[^"]*"[^>]*>/g) || [];
    expect(stacks).toHaveLength(1);
    const count = Number(stacks[0].match(/aria-label="(\d+) more commands, \d+\.\d\d s"/)[1]);
    expect(stacks[0]).toContain('aria-haspopup="menu"');
    expect(stacks[0]).toContain('aria-expanded="false"');
    expect(html).toContain('class="pt-stack-count" aria-hidden="true">+' + count + '<');
    // Every command is either a named chip or a member of the stack.
    const named = (html.match(/class="pt-chip(?! stack)[^"]*"[^>]*aria-label="Cmd \d+, /g) || []).length;
    expect(named + count).toBe(10);
    expect(named).toBeGreaterThanOrEqual(5);
    for (const name of ['Cmd 0', 'Cmd 1', 'Cmd 8', 'Cmd 9']) expect(html).toContain('aria-label="' + name + ', ');
    // The crowd used the third row, so the lane grew.
    expect(html).toMatch(/class="pt-lane" style="[^"]*height:69px/);
  });
  it('shows the chosen member on the stack and names it', () => {
    const html = render({ kind: 'em', idx: 7 });
    expect(html).toMatch(/class="pt-chip stack selected"[^>]*aria-label="\d+ more commands, \d+\.\d\d s, Cmd 7 selected"/);
  });
  it('shows a group as one chip with its mode and members, and a loop as an extent to its limit', () => {
    const catalog = { commands: [{ id: 'intake', label: 'Intake' }, { id: 'shoot', label: 'Shooter' }, { id: 'feed', label: 'Feed' }] };
    const grouped = { ...doc, markers: [
      { id: 'g', f: 0.2, name: 'event1', cmd: 'none', commandGroup: { mode: 'parallel', commands: [
        { commandId: 'intake', arguments: {} }, { commandId: 'shoot', arguments: {} }, { commandId: 'feed', arguments: {}, loop: { until: { kind: 'time', seconds: 0.5 } } }] } },
      { id: 'l', f: 0.6, name: 'Spin up', cmd: 'shoot', invocation: { commandId: 'shoot', arguments: {}, loop: { until: { kind: 'pathEnd' } } } },
      { id: 'end', f: 1, name: 'A very long command name that would never fit in the lane at all', cmd: 'none' },
    ] };
    const d = plan(grouped), t = buildTimeline(d);
    const html = renderToStaticMarkup(React.createElement(PathTimeline, {
      doc: grouped, derived: d, tl: t, robot: corpus.robot, sel: { kind: null, idx: -1 }, select: () => {}, edit: {}, actions: {}, playbackStore: store, catalog }));
    const chips = html.match(/<button[^>]*class="pt-chip[^"]*"[^>]*>/g);
    expect(chips).toHaveLength(3);
    expect(chips[0]).toContain('class="pt-chip group"');
    expect(chips[0]).toMatch(/aria-label="Intake \+ 2, parallel group of 3, 1 command loops, \d+\.\d\d s"/);
    expect(chips[0]).toContain('title="Intake + 2 (parallel group of 3, 1 command loops)\n• Intake\n• Shooter\n• Feed (loops for 0.50 s)"');
    expect(chips[1]).toMatch(/aria-label="Spin up, loops until the path ends, \d+\.\d\d s"/);
    // The last chip faces left so its long name ends at its diamond, inside the lane; its title keeps the full name.
    expect(chips[2]).toContain('class="pt-chip left"');
    expect(chips[2]).toContain('title="A very long command name that would never fit in the lane at all"');
    const [, left, width] = chips[2].match(/left:([\d.]+)px;width:([\d.]+)px/).map(Number);
    expect(left + width).toBeLessThanOrEqual(900 - 4);
    expect(width).toBeLessThanOrEqual(168);
    const extents = html.match(/class="pt-extent[^"]*"[^>]*>/g);
    expect(extents).toHaveLength(2);
    expect(extents[1]).toContain('class="pt-extent loop"');
    const [, barLeft, barWidth] = extents[1].match(/left:([\d.]+)px;width:([\d.]+)px/).map(Number);
    expect(barLeft + barWidth).toBeCloseTo(900 - 14, 6);
  });
  it('lists every member as its own menu item, selectable by its marker index', () => {
    const members = [1, 2, 3, 4, 5, 6, 7].map((i) => ({ index: i, t: 1.28 + (i > 5 ? 0.01 * (i - 5) : 0), marker: { id: 'm' + i }, label: 'Cmd ' + i }));
    const html = renderToStaticMarkup(React.createElement(CommandStackMenu, {
      stack: { key: 'k', members, t: 1.28 }, at: (t) => ', ' + t.toFixed(2) + ' s', selectedIndex: 3, style: {}, onChoose: () => {}, onClose: () => {} }));
    expect(html).toContain('role="menu" aria-label="7 commands, 1.28 s"');
    const items = html.match(/role="menuitemradio"[^>]*>/g);
    expect(items).toHaveLength(7);
    expect(items.map((item) => item.match(/data-selection="em:(\d+)"/)[1])).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    expect(items.filter((item) => item.includes('aria-checked="true"'))).toHaveLength(1);
    expect(items[2]).toContain('aria-checked="true"');
  });
});

// Max distance from each point of `pts` to the polyline `ref`.
function deviation(pts, ref) {
  let worst = 0;
  for (const q of pts) {
    let best = Infinity;
    for (let i = 1; i < ref.length; i++) {
      const a = ref[i - 1], b = ref[i], dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy;
      const u = l > 0 ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / l)) : 0;
      best = Math.min(best, Math.hypot(q.x - a.x - u * dx, q.y - a.y - u * dy));
    }
    worst = Math.max(worst, best);
  }
  return worst;
}
// The field's exact on-path insertion (App prepareWaypointInsertion, bezier branch): de Casteljau at the visit.
function splitAt(doc, check) {
  const wps = structuredClone(doc.waypoints), seg = check.segment, a = wps[seg], b = wps[seg + 1];
  const t = Math.max(0.001, Math.min(0.999, check.visit.t));
  const split = PM.splitBezier(a, a.nextC, b.prevC, b, t);
  const nw = { x: split.point.x, y: split.point.y, linked: true, thetaOn: false, theta: 0, stop: false, segType: a.segType || 'bezier', prevC: split.left[2], nextC: split.right[1] };
  a.nextC = split.left[1]; b.prevC = split.right[2];
  wps.splice(check.index, 0, nw);
  return { wps, nw };
}

describe('adding a waypoint at a timeline time', () => {
  for (const id of ['corpus-neutral-slalom', 'corpus-blue-table-bump', 'corpus-neutral-stop']) {
    it(id + ': lands on the timed position, between the right neighbours, keeping the path shape', () => {
      const doc = pathOf(id), derived = plan(doc), tl = buildTimeline(derived);
      expect(tl.empty).toBe(false);
      const length = derived.sample.length;
      const before = sample(doc.waypoints, 200, true).pts;
      let tried = 0;
      for (const share of [0.12, 0.3, 0.47, 0.63, 0.81, 0.93]) {
        const t = share * tl.total, check = waypointInsertionAt(tl, derived, doc, t);
        if (!check.ok) { expect(['near', 'end']).toContain(check.code); continue; }
        tried++;
        // Time -> distance comes from the timed samples, not from t / total.
        expect(check.visit.f).toBeCloseTo(fAtT(tl, t), 12);
        const at = PM.pointAtFraction(check.visit.f, derived.sample.pts);
        expect(Math.hypot(at.x - check.visit.x, at.y - check.visit.y)).toBeLessThan(1e-9);
        // Inserted between the waypoints whose distances bracket it.
        expect(derived.wpFrac[check.segment] * length).toBeLessThan(check.visit.s);
        expect(derived.wpFrac[check.segment + 1] * length).toBeGreaterThan(check.visit.s);
        expect(check.index).toBe(check.segment + 1);
        const { wps, nw } = splitAt(doc, check);
        expect(wps).toHaveLength(doc.waypoints.length + 1);
        expect(wps[check.index]).toBe(nw);
        // The new point sits on the displayed curve and the resampled path keeps its shape and length. Next to
        // a smoothed (curvature-matched) bezier joint the sampler's quintic lift is spread over the shorter
        // halves, so the shared exact split moves the drawn curve by millimetres there; elsewhere it is exact.
        const lifted = [check.segment, check.segment + 1].some((k) => k > 0 && k < doc.waypoints.length - 1
          && doc.waypoints[k].linked && !doc.waypoints[k].stop && !doc.waypoints[k].corner);
        const tolerance = lifted ? 0.01 : 0.0005;
        expect(Math.hypot(nw.x - check.visit.x, nw.y - check.visit.y)).toBeLessThan(tolerance);
        const after = sample(wps, 200, true);
        expect(deviation(after.pts, before)).toBeLessThan(tolerance);
        expect(deviation(before, after.pts)).toBeLessThan(tolerance);
        expect(Math.abs(after.length - sample(doc.waypoints, 200, true).length)).toBeLessThan(tolerance);
      }
      expect(tried).toBeGreaterThan(2);
    });
  }

  it('maps through stop waits by time: inside a hold the robot is at the stop, so nothing is added', () => {
    const doc = pathOf('corpus-neutral-stop'), derived = plan(doc), tl = buildTimeline(derived);
    const hold = derived.prof.holds?.[0];
    expect(hold && hold.t1 > hold.t0).toBe(true);
    const check = waypointInsertionAt(tl, derived, doc, (hold.t0 + hold.t1) / 2);
    expect(check).toMatchObject({ ok: false, code: 'near', index: 1 });
    expect(insertionReason(check, doc)).toMatch(/^Too close to /);
  });

  it('refuses the exact start and end, and spots within the minimum gap of a waypoint', () => {
    const doc = pathOf('corpus-neutral-slalom'), derived = plan(doc), tl = buildTimeline(derived);
    expect(waypointInsertionAt(tl, derived, doc, 0)).toMatchObject({ ok: false, code: 'start' });
    expect(waypointInsertionAt(tl, derived, doc, tl.total)).toMatchObject({ ok: false, code: 'end' });
    expect(insertionReason({ ok: false, code: 'start' }, doc)).toBe('The path starts here');
    expect(insertionReason({ ok: false, code: 'end' }, doc)).toBe('The path ends here');
    const s1 = derived.wpFrac[1] * derived.sample.length;
    const tNear = tl.points.find((p) => p.f * derived.sample.length > s1 - MIN_WAYPOINT_GAP / 2).t;
    expect(waypointInsertionAt(tl, derived, doc, tNear)).toMatchObject({ ok: false, code: 'near', index: 1 });
  });

  it('refuses arc and clothoid segments, whose split can reshape them, and bezier segments without handles', () => {
    for (const type of ['arc', 'clothoid']) {
      const doc = pathOf('corpus-neutral-slalom');
      doc.waypoints[1].segType = type;
      const derived = plan(doc), tl = buildTimeline(derived);
      const mid = (derived.wpFrac[1] + derived.wpFrac[2]) / 2;
      const t = tl.points.find((p) => p.f >= mid).t;
      const check = waypointInsertionAt(tl, derived, doc, t);
      expect(check).toMatchObject({ ok: false, code: 'segtype', segType: type, segment: 1 });
      expect(insertionReason(check, doc)).toContain('Alt-click the path on the field');
    }
    const doc = pathOf('corpus-neutral-slalom'), derived = plan(doc), tl = buildTimeline(derived);
    const bare = structuredClone(doc); delete bare.waypoints[0].nextC;
    const interior = tl.points.find((point) => point.f >= (derived.wpFrac[0] + derived.wpFrac[1]) / 2).t;
    expect(waypointInsertionAt(tl, derived, bare, interior)).toMatchObject({ ok: false, code: 'handles' });
  });

  it('refuses while the path has no sampled geometry', () => {
    const doc = pathOf('corpus-neutral-slalom');
    const tl = buildTimeline(null);
    expect(waypointInsertionAt(tl, { sample: { pts: [] } }, doc, 0.5)).toMatchObject({ ok: false, code: 'unplanned' });
    expect(insertionReason({ ok: false, code: 'unplanned' }, doc)).toBe('Waiting for the path to plan');
  });
});
