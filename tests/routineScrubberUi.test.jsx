import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, vi } from 'vitest';
import { RoutineTransport, StepInspector } from '../src/renderer/components/RoutineInspector';
import { routinePathChoices, routinePathUses } from '../src/renderer/lib/routinePathChoices';
import { AUTO } from '../src/renderer/lib/routineModel';

const h = React.createElement;
const timedRun = () => ({
  total: 6, timedPlayable: true, issues: [], duration: { maxS: 6, unknownCount: 0, usesLimits: false },
  steps: [
    { kind: 'path', t0: 0, t1: 4, label: 'Leave the zone', node: { id: 'a', type: 'path' }, occurrenceId: 'a' },
    { kind: 'wait', t0: 4, t1: 6, label: 'Wait', node: { id: 'b', type: 'builtin' }, occurrenceId: 'b' },
  ],
});
const slider = (html) => html.match(/<div[^>]*role="slider"[^>]*>/)[0];

describe('routine transport scrubber', () => {
  it('is a slider whose value names the step playing there', () => {
    const html = renderToStaticMarkup(h(RoutineTransport, { run: timedRun(), time: 2, playing: false, running: true, controls: {} }));
    const element = slider(html);
    expect(element).toContain('aria-label="Routine playback position"');
    expect(element).toContain('aria-valuemax="6"'); expect(element).toContain('aria-valuenow="2"');
    expect(element).toContain('aria-valuetext="2.00 s of 6.00 s, Leave the zone"');
    expect(element).toContain('tabindex="0"'); expect(element).not.toContain('aria-disabled');
    expect(html).toContain('class="rt-timeline-now">Leave the zone<'); expect(html).toContain('>1 of 2<');
    expect(html).toContain('class="rt-timeline-playhead"');
    expect(html).toMatch(/class="rt-timeline-span path on"[^>]*title="Leave the zone"/);
  });

  it('draws textless step segments, stacks a parallel group in rows inside its outline, and marks instant commands', () => {
    const node = (id, extra = {}) => ({ id, type: 'function', cat: 'command', invocation: { commandId: 'x', arguments: {} }, ...extra });
    const run = {
      total: 6, timedPlayable: true, issues: [], duration: { maxS: 6, unknownCount: 1, usesLimits: false },
      groupSpans: [{ nodeId: 'g', occurrenceId: 'g:0', mode: 'parallel', t0: 2, t1: 5 }],
      steps: [
        { kind: 'path', t0: 0, t1: 2, label: 'Leave the zone', node: { id: 'a', type: 'path' }, occurrenceId: 'a' },
        { kind: 'event', t0: 2, t1: 5, timing: 'exact', label: 'Spin up', node: node('b', { invocation: { commandId: 'x', arguments: {}, loop: { until: { kind: 'time', seconds: 3 } } } }), occurrenceId: 'b' },
        { kind: 'wait', t0: 2, t1: 3, label: 'Wait', node: { id: 'c', type: 'builtin' }, occurrenceId: 'c' },
        { kind: 'event', t0: 5, t1: 5, timing: 'unknown', label: 'Aim', node: node('d'), occurrenceId: 'd' },
        { kind: 'event', t0: 6, t1: 6, timing: 'unknown', label: 'Celebrate', node: node('e'), occurrenceId: 'e' },
      ],
    };
    const html = renderToStaticMarkup(h(RoutineTransport, { run, time: 2.5, playing: false, running: true, controls: {} }));
    const blocks = html.match(/<span class="rt-timeline-span[^"]*"[^>]*>/g);
    expect(blocks).toHaveLength(3);
    // Both children of the parallel group are lit while it runs, in two rows.
    expect(blocks.filter((block) => block.includes(' on"'))).toHaveLength(2);
    // Two 6px rows 2px apart, centered a little low in the 40px row so marks fit above them.
    expect(new Set(blocks.map((block) => block.match(/top:(\d+)px/)[1]))).toEqual(new Set(['16', '24']));
    // Segments carry no text: names are in their titles and the hover readout.
    expect(blocks.every((block) => block.endsWith('></span>') || !block.includes('rt-timeline-name'))).toBe(true);
    expect(html).not.toContain('rt-timeline-name');
    expect(html).toContain('title="Leave the zone"');
    expect(html).toContain('title="Spin up, loops for 3.00 s"');
    expect(html).toMatch(/class="rt-timeline-group" title="Parallel group" style="[^"]*top:16px;height:14px/);
    const marks = html.match(/<span class="rt-timeline-mark[^"]*"[^>]*>/g);
    expect(marks).toHaveLength(2);
    expect(marks[0]).toContain('class="rt-timeline-mark cmd"'); expect(marks[0]).toContain('title="Aim (untimed)"');
    // The mark at the very end stays inside the track's inset (600px default width, 10px inset), above the segments.
    expect(marks[1]).toContain('title="Celebrate (untimed)"'); expect(marks[1]).toMatch(/left:590px;top:7px/);
  });

  it('gives five simultaneous steps their own rows instead of overlapping them', () => {
    const run = {
      total: 5, timedPlayable: true, issues: [], duration: { maxS: 5, unknownCount: 0, usesLimits: false },
      groupSpans: [{ nodeId: 'g', occurrenceId: 'g:0', mode: 'parallel', t0: 0, t1: 5 }],
      steps: [1, 2, 3, 4, 5].map((n) => ({ kind: 'wait', t0: 0, t1: 5, label: 'Wait ' + n, node: { id: 'w' + n, type: 'builtin' }, occurrenceId: 'w' + n })),
    };
    const html = renderToStaticMarkup(h(RoutineTransport, { run, time: 1, playing: false, running: true, controls: {} }));
    const blocks = html.match(/<span class="rt-timeline-span[^"]*"[^>]*>/g);
    expect(blocks).toHaveLength(5);
    const tops = blocks.map((block) => Number(block.match(/top:(\d+)px/)[1]));
    expect(new Set(tops).size).toBe(5);
    // Five rows share the four-row height; each is still listed by name in its tooltip.
    expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(4 * 20);
    expect(blocks.every((block, i) => block.includes('title="Wait ' + (i + 1) + '"'))).toBe(true);
  });

  it('shows the run size before playback and no handle when nothing is timed', () => {
    const idle = renderToStaticMarkup(h(RoutineTransport, { run: timedRun(), time: 0, playing: false, running: false, controls: {} }));
    expect(idle).toContain('<small>2 steps</small>'); expect(idle).not.toContain('rt-timeline-now');
    const run = AUTO.buildRun({ nodes: [{ id: 'cmd', type: 'function', cat: 'command', invocation: { commandId: 'x', arguments: {} } }] }, [], {}, {});
    const untimed = renderToStaticMarkup(h(RoutineTransport, { run, time: 0, playing: false, running: false, controls: {} }));
    expect(slider(untimed)).toContain('aria-disabled="true"'); expect(slider(untimed)).toContain('tabindex="-1"');
    expect(untimed).toContain('Nothing to scrub: no step in this preview has a duration');
    expect(untimed).not.toContain('rt-timeline-playhead');
  });
});

describe('routine path choices', () => {
  const paths = [
    { id: 'p1', name: 'Collect', folderId: 'f', waypoints: [{}, {}] },
    { id: 'p2', name: 'Score', waypoints: [{}, {}] },
    { id: 'p3', name: 'Draft', waypoints: [{}] },
  ];
  const routine = { nodes: [{ id: 'a', type: 'path', ref: 'p1' }, { id: 'r', type: 'repeat', times: 2, nodes: [{ id: 'b', type: 'path', ref: 'p1' }, { id: 'c', type: 'path', ref: 'p2' }] }] };

  it('describes folder, library time and use in this routine', () => {
    const uses = routinePathUses(routine);
    expect([...uses]).toEqual([['p1', 2], ['p2', 1]]);
    const choices = routinePathChoices(paths, { folders: [{ id: 'f', name: 'Collection' }], times: { p1: { status: 'ready', seconds: 4 }, p2: { status: 'pending' } }, uses });
    expect(choices.map((choice) => choice.meta)).toEqual(['Collection · 4.00 s · Used 2× in this routine', 'In this routine', 'Not timed yet']);
  });

  it('names the chosen path, lists its facts, and opens the path library from Change path; names a deleted path', () => {
    const acq = { set: vi.fn(), select() {}, del() {}, openInEditor() {} };
    const render = (ref, extra = {}) => renderToStaticMarkup(h(StepInspector, { node: { id: 'a', type: 'path', ref }, routine, paths, pathFolders: [{ id: 'f', name: 'Collection' }], pathTimes: {}, acq, run: { segs: [], issues: [] }, onChangePath() {}, ...extra }));
    const chosen = render('p1');
    expect(chosen).toMatch(/<span class="ctxinsp-t" title="Collect">Collect<\/span><span class="ctxinsp-kind" title="Path">Path<\/span>/);
    expect(chosen).toContain('<dl class="rt-kv routine-path-facts"><div><dt>Folder</dt><dd class="text">Collection</dd></div><div><dt>In this routine</dt><dd>2×</dd></div></dl>');
    // Change opens the library in the left rail; the inspector holds no list of its own.
    expect(chosen).toMatch(/<div class="rt-insp-actions"><button type="button" class="qbtn routine-change-path"[^>]*>Change path<\/button><button type="button" class="qbtn routine-open-path">Open in Paths<\/button><\/div>/);
    expect(chosen).not.toContain('role="listbox"');
    const missing = render('gone');
    expect(missing).not.toContain('rt-kv'); expect(missing).not.toContain('Open in Paths');
    expect(missing).toContain('The referenced path is unavailable.');
    expect(missing).toMatch(/class="qbtn wide routine-change-path"[^>]*>Choose a path</);
    expect(render('gone', { paths: [] })).toContain('No paths yet. Create one in Paths.');
  });
});
