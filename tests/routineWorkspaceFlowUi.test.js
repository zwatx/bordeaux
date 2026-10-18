import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StepInspector, RoutineTransport } from '../src/renderer/components/RoutineInspector';
import { RoutinePanel, addMenuSteps } from '../src/renderer/components/RoutinePanel';
import { PREVIEW_HELP, RoutineWorkspace } from '../src/renderer/components/RoutineWorkspace';
import { AUTO } from '../src/renderer/lib/routineModel';
import { createDemoProject } from '../src/shared/project/defaults';

// Routine flow redesign: closings and loop-backs follow authored flow (AUTO.flowSummary), never the preview route,
// and unsupported saved data is described truthfully.
const catalog = { authoritative: true, generatedSchemaVersion: '1.2', commands: [],
  conditions: [{ id: 'full', label: 'Enough pieces' }], builtIns: [{ id: 'bordeaux.wait', kind: 'wait' }] };
const paths = [{ id: 'a', name: 'Score path' }, { id: 'b', name: 'Collect path' }, { id: 'c', name: 'Return path' }];
const path = (id, ref) => ({ id, type: 'path', ref });
const end = (id, scope = 'routine') => ({ id, type: 'end', scope });
const decision = (id, then, otherwise, labels = {}) => ({ id, type: 'decision', cond: 'full', then, else: otherwise, ...labels });
const repeat = (id, nodes, extra = {}) => ({ id, type: 'repeat', times: 3, nodes, ...extra });
const wait = (id) => ({ id, type: 'builtin', builtinId: 'bordeaux.wait', arguments: { durationS: 1 } });
const text = (html) => html.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

// Path plans are pending in these fixtures; flow structure and closings do not depend on them.
function panel(nodes, extra = {}, planning = { status: 'pending', values: {} }) {
  const routine = { id: 'r', name: 'R', nodes };
  const run = AUTO.buildRun(routine, [], {}, {}, 'profiledSpline', catalog, planning);
  const issues = AUTO.analyze(routine, paths, catalog);
  const html = renderToStaticMarkup(React.createElement(RoutinePanel, { routine, run, issues, paths, time: 0, running: false, acq: { outcomes: {} }, catalog, ...extra }));
  const closings = [...html.matchAll(/<div class="rt-close[^"]*"[^>]*>([\s\S]*?)<\/span><\/div>/g)].map((match) => text(match[1]));
  return { html, closings, plain: text(html) };
}

describe('routine flow closings follow authored outcomes', () => {
  it('joins only the route that falls through and names the shared continuation', () => {
    const { closings, html } = panel([decision('d', [end('stop')], [path('p', 'b')], { thenLabel: 'Full', elseLabel: 'Keep collecting' }), path('after', 'c')]);
    expect(closings).toEqual(['Only Keep collecting continues to Return path']);
    expect(html).not.toMatch(/Both routes|rejoin/);
    // The terminal route says where it goes; the empty-or-continuing one does not pretend to stop.
    expect(html).toMatch(/rt-brcount">Previewing · 1 step · ends routine</);
    expect(html).toMatch(/rt-brcount">1 step</);
  });

  it('says no route continues when every route is terminal, and later steps stay marked unreachable', () => {
    const { closings, html } = panel([decision('d', [end('stop')], [end('stop2')]), path('after', 'c')]);
    expect(closings).toEqual(['No route continues; every route ends the routine']);
    expect(html).toMatch(/data-id="after"[\s\S]*?rt-step-meta muted">This step cannot be reached\./);
  });

  it('names both routes and the end of the routine or pass when the branch is last', () => {
    expect(panel([decision('d', [], [path('p', 'a')])]).closings).toEqual(['Both routes finish the routine']);
    expect(panel([repeat('loop', [decision('d', [path('p', 'a')], [])])]).closings[0]).toBe('Both routes finish the pass');
  });

  it('suppresses the loop-back when no pass can complete, keeping a nested Exit distinct', () => {
    const always = panel([repeat('loop', [path('p', 'a'), end('exit', 'repeat')]), path('after', 'c')]);
    expect(always.closings).toEqual(['Never loops back; the first pass always leaves the repeat']);
    expect(always.plain).not.toContain('Back to the top');
    expect(always.html).toMatch(/data-id="exit"[\s\S]*?rt-step-meta">Leaves the repeat and continues to “Return path”</);

    const mixed = panel([repeat('loop', [decision('d', [end('exit', 'repeat')], [end('stop')])])]);
    expect(mixed.closings).toContain('Never loops back; the first pass always ends the routine or leaves the repeat');
    expect(mixed.closings).toContain('No route continues; every route ends the routine or leaves the repeat');
  });

  it('runs a one-pass repeat once without promising a loop, with or without a stop check', () => {
    for (const until of [undefined, { source: 'condition', conditionId: 'full' }]) {
      const { closings, html } = panel([repeat('once', [wait('w')], { times: 1, until })], {}, null);
      expect(closings).toEqual(['Runs once, then continues']);
      expect(html).not.toContain('Back to the top');
    }
  });

  it('identifies a missing stop condition without presenting its internal ID as valid', () => {
    const { closings } = panel([repeat('loop', [wait('w')], { until: { source: 'condition', conditionId: 'gone' } })], {}, null);
    expect(closings[0]).toContain('until the saved condition (unavailable)');
    expect(closings[0]).not.toContain('gone');
  });

  it('loops back until the stop rule, with the preview pass choice kept separate from authored flow', () => {
    // A timed body gives a complete trace, so the chosen preview pass count is known.
    const { closings, html } = panel([repeat('loop', [wait('w')], { until: { source: 'condition', conditionId: 'full' } })], {}, null);
    expect(closings).toEqual(['Back to the top until Enough pieces · up to 3 passes · previewing 1']);
    expect(html).toMatch(/rt-step-meta">Until Enough pieces · checked after each pass</);
    expect(panel([repeat('loop', [path('p', 'a')])]).closings).toEqual(['Back to the top · 3 passes']);
  });
});

describe('routine flow insertion and empty states', () => {
  it('keeps one root Add row as a direct list child and labels destinations for assistive technology', () => {
    const { html } = panel([decision('d', [], []), path('after', 'c')], {});
    expect(html).toMatch(/<div class="rt-list"[^>]*>[\s\S]*<div class="rt-addwrap" data-list="\{&quot;kind&quot;:&quot;root&quot;\}"/);
    expect(html).toContain('aria-label="Add step to the True route"');
    expect(html).toContain('aria-label="Add step at the end"');
  });

  it('explains an empty routine, a project without paths and missing robot code', () => {
    const empty = (paths_, catalog_) => text(renderToStaticMarkup(React.createElement(RoutinePanel, {
      routine: { id: 'r', name: 'R', nodes: [] }, run: AUTO.buildRun({ nodes: [] }, [], {}, {}), paths: paths_, time: 0, running: false, acq: { outcomes: {} }, catalog: catalog_ })));
    expect(empty(paths, catalog)).toContain('Start with the path the robot drives first');
    expect(empty(paths, catalog)).not.toContain('linked robot code');
    expect(empty([], null)).toContain('This project has no paths yet.');
    expect(empty([], null)).toContain('Commands and robot conditions come from linked robot code.');
  });

  it('flags missing catalog entries in Add without hiding local authoring', () => {
    const items = addMenuSteps({ nodes: [] }, { list: { kind: 'root' } }, null);
    expect(items.find((item) => item.kind === 'command')).toMatchObject({ meta: 'Needs linked robot code' });
    expect(items.find((item) => item.kind === 'decision')).toMatchObject({ meta: 'Needs linked robot code' });
    expect(items.find((item) => item.kind === 'decision').disabled).toBeUndefined();
    expect(addMenuSteps({ nodes: [] }, { list: { kind: 'root' } }, catalog).find((item) => item.kind === 'decision').meta).toBeUndefined();
  });
});

describe('unsupported saved steps are described, not promoted', () => {
  it('labels legacy categories as ignored by the preview while keeping removal-only editing', () => {
    const { html } = panel([{ id: 'legacy', type: 'function', cat: 'velocity', scale: 0.5 }]);
    expect(html).toMatch(/rt-step-meta warn">Legacy velocity step · ignored by the preview</);
    const inspector = renderToStaticMarkup(React.createElement(StepInspector, { node: { id: 'legacy', type: 'function', cat: 'terminate' }, acq: {} }));
    expect(inspector).toContain('The preview ignores it and it has no robot contract.');
    expect(inspector).toContain('Remove unsupported step');
    expect(inspector).not.toContain('<input');
  });

  it('describes a legacy generate preview as a timed saved reference, not live generation or an ignored step', () => {
    const project = createDemoProject();
    const node = { id: 'legacy-ref', type: 'function', cat: 'generate', funcRef: 'GeneratePath', preview: project.paths[0] };
    const routine = { id: 'r', name: 'R', nodes: [node] };
    const run = AUTO.buildRun(routine, project.paths, project.robot, {});
    expect(run.segs[0]).toMatchObject({ kind: 'gen', label: 'Saved reference: ' + project.paths[0].name });
    expect(run.segs[0].t1).toBeGreaterThan(run.segs[0].t0);
    const { plain } = panel([node], { run });
    expect(plain).toContain('Legacy generate step · preview plays its saved reference path');
    expect(plain).not.toContain('ignored by the preview');
    const inspector = text(renderToStaticMarkup(React.createElement(StepInspector, { node, routine, paths, acq: {}, run, robotProject: { catalog } })));
    expect(inspector).toContain('The preview plays the path saved with it; nothing is generated.');
    expect(inspector).toContain('Remove unsupported step');
    expect(inspector).not.toContain('The preview ignores it');
  });

  it('describes a typed generated trajectory as an unsupported saved definition', () => {
    const node = { id: 'dynamic', type: 'generatedTrajectory', generatorId: 'drive', arguments: {}, fallback: { type: 'safeStop' } };
    const { plain } = panel([node]);
    expect(plain).toContain('Unsupported saved definition · Bordeaux cannot generate or preview it');
    const inspector = text(renderToStaticMarkup(React.createElement(StepInspector, { node, routine: { nodes: [node] }, paths: [], acq: {}, run: { segs: [] }, robotProject: { catalog } })));
    expect(inspector).toContain('Not supported');
    expect(inspector).toContain('Bordeaux cannot generate or preview it, and no robot runner supports it yet.');
    expect(inspector).toContain('Saved fallback: safe stop');
    expect(`${plain} ${inspector}`).not.toMatch(/validated|Generated on the robot/);
  });
});

describe('preview boundary is stated once', () => {
  it('drops the per-step preview banner from the inspector', () => {
    const node = repeat('loop', [path('p', 'a')]);
    const html = renderToStaticMarkup(React.createElement(StepInspector, { node, routine: { nodes: [node] }, paths, acq: { outcomes: {}, passes: {} }, run: { segs: [] }, robotProject: { catalog } }));
    expect(html).not.toContain('Preview only');
    expect(html).not.toContain('rt-insp-support');
  });

  it('keeps the preview boundary to a closed two-sentence help popover', () => {
    const routine = { id: 'r', name: 'R', nodes: [repeat('routine_node_7f0c', [wait('w')], { until: { source: 'condition', conditionId: 'full' } })] };
    const run = AUTO.buildRun(routine, [], {}, {}, 'profiledSpline', catalog, undefined, { repeatPasses: { routine_node_7f0c: 2 } });
    const workspace = renderToStaticMarkup(React.createElement(RoutineWorkspace, { routine, run, flow: null, field: null, transport: null, status: null }));
    // The trigger keeps a stable controlled region; the native popover starts closed and sits outside the flow.
    expect(workspace).toMatch(/<button type="button" class="routine-workspace-about" popovertarget="routine-preview-notes" aria-expanded="false" aria-controls="routine-preview-notes">/);
    expect(workspace).toMatch(/<div id="routine-preview-notes" class="routine-preview-help" popover="auto" role="note" aria-label="About the local preview"><p>[^<]+<\/p><\/div>/);
    expect(workspace.indexOf('routine-preview-notes"')).toBeLessThan(workspace.indexOf('routine-workspace-body'));
    const help = text(workspace.match(/<div id="routine-preview-notes"[^>]*>([\s\S]*?)<\/div>/)[1]);
    expect(help).toBe(PREVIEW_HELP);
    expect(help.split(/(?<=[.!?])\s+/)).toHaveLength(2);
    expect(help).toContain('it doesn’t run commands or check conditions');
    expect(help).toContain('The robot doesn’t run routines yet.');
    // No assumptions list, per-repeat pass counts, internal IDs or repeated save/pose disclaimers.
    expect(workspace).not.toMatch(/<ul|<li/);
    expect(help).not.toMatch(/routine_node_7f0c|previews 2 passes|Saving|Poses|Untimed/);
  });

  it('names the routine once, without a kicker repeating the Routines place', () => {
    const name = 'Collect until full, choose a route, then return to the alliance zone along the protected crossing';
    const workspace = renderToStaticMarkup(React.createElement(RoutineWorkspace, { routine: { id: 'r', name, nodes: [] }, flow: null, field: null, transport: null, status: null }));
    expect(workspace).toContain('<div class="routine-workspace-title"><strong>' + name + '</strong></div>');
    expect(text(workspace.match(/<header[\s\S]*?<\/header>/)[0])).not.toMatch(/^Routine\b/);
  });

  it('offers only the flow for an empty routine, and both views with playback once it has a step', () => {
    const render = (nodes) => renderToStaticMarkup(React.createElement(RoutineWorkspace, { routine: { id: 'r', name: 'R', nodes }, flow: null, field: null, transport: 'TRANSPORT', status: null }));
    const empty = render([]), filled = render([path('p', 'a')]);
    expect(empty).not.toContain('routine-workspace-views');
    expect(empty).not.toContain('TRANSPORT');
    expect(empty).toContain('Local preview');
    expect(filled).toMatch(/class="seg routine-workspace-views"[\s\S]*aria-pressed="true"[^>]*>Flow<[\s\S]*>Field preview</);
    expect(filled).toContain('TRANSPORT');
  });

  it('counts untimed steps as not counted rather than as zero-time commands', () => {
    const routine = { nodes: [{ id: 'cmd', type: 'function', cat: 'command', invocation: { commandId: 'x', arguments: {} } }] };
    const run = AUTO.buildRun(routine, [], {}, {});
    const html = text(renderToStaticMarkup(React.createElement(RoutineTransport, { run, time: 0, playing: false, running: false, controls: {} })));
    // Time reads like the Paths transport: elapsed / total, without a redundant label.
    expect(html).toContain('0.00 / 0.00 s');
    expect(html).toContain('1 untimed step not counted');
  });
});
