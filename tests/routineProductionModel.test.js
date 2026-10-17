import { describe, expect, it, vi } from 'vitest';
import { AUTO } from '../src/renderer/lib/routineModel';
import { PM } from '../src/renderer/lib/pathMath';
import { createDemoProject } from '../src/shared/project/defaults';
import { referencingRoutines } from '../src/renderer/components/EditorLibrary';
import { deploymentInputKey } from '../src/renderer/lib/deploymentStatus';

const wait = (id, durationS = 1) => ({ id, type: 'builtin', builtinId: 'bordeaux.wait', arguments: { durationS } });
const exit = id => ({ id, type: 'end', scope: 'repeat' });
const end = id => ({ id, type: 'end', scope: 'routine' });
const repeat = (id, nodes, times = 2, until) => ({ id, type: 'repeat', times, nodes, ...(until ? { until } : {}) });
const decision = (id, then, otherwise = []) => ({ id, type: 'decision', cond: 'ready', thenLabel: 'Yes', elseLabel: 'No', then, else: otherwise });
const command = (id, patch = {}) => ({ id, type: 'function', cat: 'command', invocation: { commandId: 'Acquire', arguments: {} }, ...patch });
const routine = nodes => ({ id: 'routine', name: 'Routine', nodes });
const run = (nodes, choices = {}, options = {}) => AUTO.buildRun(routine(nodes), [], {}, choices, undefined, null, undefined, options);
const reject = (source, operation, reason) => {
  const before = structuredClone(source), result = AUTO.editRoutine(source, operation);
  expect(result).toMatchObject({ changed: false, routine: source }); expect(result.routine).toBe(source);
  expect(source).toEqual(before); if (reason) expect(result.reason).toMatch(reason);
  expect(AUTO.checkEdit(source, operation).allowed).toBe(false);
};

describe('lossless structural edits', () => {
  it('preserves arbitrary delimiter IDs and full payload in a valid cross-list move', () => {
    const node = { ...wait('x:then:body'), payload: { keep: ['exact', 2] } };
    const source = routine([node, decision('d:then', [], [])]);
    const result = AUTO.editRoutine(source, { kind: 'move', nodeId: node.id, listRef: { kind: 'decision', nodeId: 'd:then', route: 'else' }, index: 0 });
    expect(result.changed).toBe(true); expect(result.focusId).toBe(node.id);
    expect(result.routine.nodes[0].else).toEqual([node]); expect(source.nodes[0]).toBe(node);
    expect(AUTO.locate(result.routine, node.id)).toMatchObject({ index: 0, listRef: { kind: 'decision', nodeId: 'd:then', route: 'else' }, repeatIds: [] });
  });
  it('rejects descendant Exit retargeting but permits moving its whole repeat', () => {
    const branch = decision('branch', [exit('exit')]);
    const source = routine([repeat('outer', [branch]), repeat('other', [])]);
    reject(source, { kind: 'move', nodeId: 'branch', listRef: { kind: 'root' }, index: 2 }, /which repeat/);
    reject(source, { kind: 'move', nodeId: 'branch', listRef: { kind: 'repeat', nodeId: 'other' }, index: 0 }, /which repeat/);
    const moved = AUTO.editRoutine(source, { kind: 'move', nodeId: 'outer', listRef: { kind: 'repeat', nodeId: 'other' }, index: 0 });
    expect(moved.changed).toBe(true); expect(AUTO.locate(moved.routine, 'exit').repeatIds).toEqual(['other', 'outer']);
    reject(source, { kind: 'move', nodeId: 'outer', listRef: { kind: 'decision', nodeId: 'branch', route: 'else' }, index: 0 }, /itself/);
  });
  it('rejects duplicate/noncontiguous/reversed/cross-list/stale wrap selections unchanged', () => {
    const source = routine([wait('a'), wait('b'), wait('c'), decision('branch', [wait('child')])]);
    for (const nodeIds of [['a', 'a'], ['a', 'c'], ['b', 'a'], ['a', 'child'], ['missing']]) reject(source, { kind: 'wrapRepeat', nodeIds });
    reject(source, { kind: 'move', nodeId: 'a', listRef: { kind: 'repeat', nodeId: 'gone' }, index: 0 });
    reject(source, { kind: 'move', nodeId: 'a', listRef: { kind: 'root' }, index: 1 });
  });
  it('wraps and unwraps one coherent subtree-preserving edit and rejects Exit meaning changes', () => {
    const source = routine([wait('a'), decision('b', [wait('nested')]), wait('c')]);
    const wrapped = AUTO.editRoutine(source, { kind: 'wrapRepeat', nodeIds: ['a', 'b'], repeatId: 'loop' });
    expect(wrapped.routine.nodes[0]).toEqual(repeat('loop', source.nodes.slice(0, 2)));
    const unwrapped = AUTO.editRoutine(wrapped.routine, { kind: 'unwrapRepeat', nodeId: 'loop' });
    expect(unwrapped.routine).toEqual(source);
    const exits = routine([repeat('loop', [decision('b', [exit('exit')])])]);
    reject(exits, { kind: 'unwrapRepeat', nodeId: 'loop' }, /Move or remove/);
    reject(exits, { kind: 'wrapRepeat', nodeIds: ['b'] }, /which repeat/);
    const nested = routine([repeat('outer', [repeat('inner', [exit('exit')])])]);
    const outer = AUTO.editRoutine(nested, { kind: 'unwrapRepeat', nodeId: 'outer' });
    expect(outer.changed).toBe(true); expect(AUTO.locate(outer.routine, 'exit').repeatIds).toEqual(['inner']);
  });
  it('keeps generator fallback descendants read-only insertion and movement targets', () => {
    const source = routine([{ id: 'generator', type: 'generatedTrajectory', fallback: { type: 'branch', nodes: [decision('fallback-branch', [wait('retained')])] } }, wait('outside')]);
    expect(AUTO.locate(source, 'retained').readOnly).toBe(true);
    reject(source, { kind: 'move', nodeId: 'outside', listRef: { kind: 'decision', nodeId: 'fallback-branch', route: 'else' }, index: 0 }, /read-only/);
    reject(source, { kind: 'move', nodeId: 'retained', listRef: { kind: 'root' }, index: 0 }, /read-only/);
  });
  it('retains direct-body output producer scope, including consumer outside moved subtree', () => {
    const source = routine([repeat('loop', [command('producer'), decision('branch', [])], 2, { source: 'output', nodeId: 'producer', output: 'ok', operator: 'eq', value: true })]);
    reject(source, { kind: 'move', nodeId: 'producer', listRef: { kind: 'decision', nodeId: 'branch', route: 'then' }, index: 0 }, /directly/);
    reject(source, { kind: 'wrapRepeat', nodeIds: ['producer'] }, /directly/);
    reject(source, { kind: 'insert', listRef: { kind: 'root' }, index: 0, node: exit('new') }, /enclosing/);
    reject(source, { kind: 'wrapRepeat', nodeIds: ['loop'], repeatId: 'producer' }, /unique/);
  });
});

describe('bounded chosen preview and freshness intent', () => {
  it('unwinds End and only nearest Exit through decision/output routes, skipping later passes', () => {
    const outputBranch = { routes: [{ id: 'ok', nodes: [exit('exit')] }] };
    const nodes = [repeat('outer', [repeat('inner', [command('cmd', { outputBranch }), wait('skipped')], 3), wait('outer-after')], 2), wait('after')];
    expect(run(nodes).steps.map(s => s.nodeId)).toEqual(['outer', 'inner', 'cmd', 'exit', 'outer-after', 'outer', 'inner', 'cmd', 'exit', 'outer-after', 'after']);
    const ended = run([repeat('loop', [decision('branch', [end('end')]), wait('skip')], 3), wait('after')]);
    expect(ended.steps.map(s => s.nodeId)).toEqual(['loop', 'branch', 'end']); expect(ended.stopReason).toBe('endStep');
  });
  it('caps nested/empty expansion before every marker, distinguishes exact limit completion', () => {
    const exactly = run(Array.from({ length: 2000 }, (_, i) => wait(String(i), .02)));
    expect(exactly).toMatchObject({ truncated: false, stopReason: 'complete' });
    const empty = run([...Array.from({ length: 1999 }, (_, i) => wait(String(i), .02)), repeat('empty', [], 50)]);
    expect(empty.steps).toHaveLength(2000); expect(empty).toMatchObject({ truncated: true, stopReason: 'limit' });
    const explosive = run([repeat('outer', [repeat('middle', [repeat('inner', [wait('w')], 50)], 50)], 50)]);
    expect(explosive.steps).toHaveLength(2000); expect(explosive.workCount).toBeLessThanOrEqual(8001); expect(explosive.stopReason).toBe('limit');
    let deep = wait('leaf'); for (let i = 0; i < 66; i++) deep = repeat('d' + i, [deep]);
    expect(run([deep])).toMatchObject({ blocked: true, stopReason: 'invalid' });
  });
  it('gives repeated steps unique occurrences and full pass stacks without saving choices', () => {
    const source = routine([repeat('outer', [repeat('inner', [wait('w')], 2)], 2)]), before = structuredClone(source);
    const trace = AUTO.buildRun(source, [], {}, {}, undefined);
    expect(new Set(trace.steps.map(s => s.occurrenceId)).size).toBe(trace.steps.length);
    expect(trace.steps.filter(s => s.nodeId === 'w').map(s => s.passStack)).toEqual([
      [{ repeatId: 'outer', pass: 1 }, { repeatId: 'inner', pass: 1 }], [{ repeatId: 'outer', pass: 1 }, { repeatId: 'inner', pass: 2 }],
      [{ repeatId: 'outer', pass: 2 }, { repeatId: 'inner', pass: 1 }], [{ repeatId: 'outer', pass: 2 }, { repeatId: 'inner', pass: 2 }],
    ]); expect(source).toEqual(before);
    const conditional = [repeat('until', [wait('w')], 3, { source: 'condition', conditionId: 'ready' })];
    expect(run(conditional).total).toBe(1); expect(run(conditional, {}, { repeatPasses: { until: 2 } }).total).toBe(2);
    expect(run([repeat('fixed', [wait('w')], 3)], {}, { repeatPasses: { fixed: 1 } }).total).toBe(3);
  });
  it('uses upper bounds and unknown timing while assuming natural output completion', () => {
    const trace = run([wait('exact', 1), { ...wait('conditional', 2), ends: { endWhen: { source: 'condition', conditionId: 'ready' } } }, command('limited', { ends: { timeoutS: 3, onTimeout: 'endRoutine' }, outputBranch: { routes: [{ id: 'ok', nodes: [wait('route', 4)] }] } }), command('unknown')]);
    expect(trace.total).toBe(10); expect(trace.duration).toEqual({ minS: 5, maxS: null, unknownCount: 1, usesLimits: true });
    expect(trace.steps.map(s => s.timing)).toEqual(['exact', 'upperBound', 'upperBound', 'exact', 'unknown']);
    expect(trace.steps.map(s => s.nodeId)).toContain('route'); expect(trace.assumptions.join(' ')).toMatch(/naturally/);
    const untimed = run([command('c'), decision('d', []), end('e')]);
    expect(untimed).toMatchObject({ total: 0, timedPlayable: false }); expect(AUTO.poseAt(untimed, 0)).toBeNull(); expect(AUTO.stepAt(untimed, 0)).toBe(2);
  });
  it('describes saved references as kept when no robot code is loaded, and unavailable only against a linked catalog', () => {
    const message = (nodes, code, catalog) => AUTO.analyze(routine(nodes), [], catalog).find(issue => issue.code === code)?.message;
    const stop = { source: 'output', nodeId: 'producer', output: 'counter', schema: { kind: 'boolean' }, operator: 'eq', value: true };
    expect(message([command('c')], 'command-unavailable')).toBe('The saved command is kept; no robot code is loaded.');
    expect(message([decision('d', [])], 'condition-unavailable')).toBe('The saved condition is kept; no robot code is loaded.');
    expect(message([repeat('loop', [command('producer')], 2, stop)], 'stop-output-unavailable')).toBe('The saved stop output is kept; no robot code is loaded.');
    const linked = { commands: [] };
    expect(message([command('c')], 'command-unavailable', linked)).toBe('The saved command is unavailable in the linked catalog.');
    expect(message([decision('d', [])], 'condition-unavailable', linked)).toBe('The saved condition is unavailable in the linked catalog.');
    expect(message([repeat('loop', [command('producer')], 2, stop)], 'stop-output-unavailable', linked)).toBe('The saved stop output is unavailable in the linked catalog.');
  });
  it('keeps missing/schema-drift output stops recoverable and never chooses a fallback from data', () => {
    const schema = { kind: 'integerString', valueType: 'I64' };
    const stop = { source: 'output', nodeId: 'producer', output: 'counter', schema, operator: 'gte', value: '9007199254740993' };
    const source = routine([repeat('loop', [command('producer')], 2, stop)]);
    const absent = AUTO.analyze(source);
    expect(absent.some(issue => issue.code === 'stop-output-unavailable')).toBe(true);
    const catalog = { commands: [{ id: 'Acquire', outputs: [{ name: 'counter', schema: { kind: 'number', valueType: 'DBL' } }] }] };
    expect(AUTO.analyze(source, [], catalog).some(issue => issue.code === 'stop-schema-changed')).toBe(true);
    expect(source.nodes[0].until).toEqual(stop);
    const removed = AUTO.remove(source, 'producer');
    expect(removed.nodes[0].until).toEqual(stop); expect(AUTO.analyze(removed).some(issue => issue.code === 'stop-producer-scope')).toBe(true);
    const outputBranch = { routes: [{ id: 'match', nodes: [wait('matched')] }, { id: 'otherwise', nodes: [wait('fallback')] }] };
    const trace = run([command('c', { outputBranch, outputValue: undefined, ends: { timeoutS: 2, onTimeout: 'endRoutine' } })]);
    expect(trace.steps.map(step => step.nodeId)).toEqual(['c', 'matched']);
    expect(trace.steps[0]).not.toHaveProperty('completed'); expect(trace.steps[0]).not.toHaveProperty('result');
    expect(trace.assumptions.join(' ')).toMatch(/outputs are not evaluated/);
  });
  it('retains an Exit route outcome when later siblings End the routine', () => {
    const source = routine([repeat('loop', [decision('choose', [exit('exit')], []), end('later-end')]), wait('after-loop')]);
    const issues = AUTO.analyze(source);
    expect(issues.some(issue => issue.nodeId === 'after-loop' && issue.code === 'unreachable')).toBe(false);
    expect(run(source.nodes).steps.map(step => step.nodeId)).toEqual(['loop', 'choose', 'exit', 'after-loop']);
  });
  it('marks incompatible result consumer endings and unreachable checks without dropping drafts', () => {
    const catalog = { authoritative: true, generatedSchemaVersion: '1.3', conditions: [{ id: 'ready', label: 'Ready' }], commands: [{ id: 'Acquire', outputs: [{ name: 'ok', schema: { kind: 'boolean', valueType: 'Boolean' } }] }] };
    const source = routine([repeat('loop', [end('early'), command('producer', { ends: { timeoutS: 2, onTimeout: 'continue', endWhen: { source: 'condition', conditionId: 'ready' } } })], 2, { source: 'output', nodeId: 'producer', output: 'ok', schema: { kind: 'boolean', valueType: 'Boolean' }, operator: 'eq', value: true })]);
    const issues = AUTO.analyze(source, [], catalog);
    expect(issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'result-needs-completion', severity: 'error' }), expect.objectContaining({ code: 'stop-check-unreachable' }), expect.objectContaining({ nodeId: 'producer', code: 'unreachable' })]));
    expect(AUTO.newCommandEnds(source, 'producer')).toEqual({ timeoutS: 2, onTimeout: 'endRoutine' });
    const repaired = AUTO.update(source, 'producer', { ends: { timeoutS: 2, onTimeout: 'endRoutine' } });
    expect(AUTO.analyze(repaired, [], catalog).some(i => i.code === 'result-needs-completion')).toBe(false);
  });
});

describe('reference planning and pose continuity', () => {
  it('plans unique authored paths once across all repeat routes and protects every reference', () => {
    const project = createDemoProject(), path = project.paths[0];
    const source = routine([repeat('loop', [decision('branch', [{ id: 'a', type: 'path', ref: path.id }], [{ id: 'b', type: 'path', ref: path.id }])], 3)]);
    project.routines = [source]; project.activeRoutineId = source.id;
    expect(AUTO.planningPaths(source, project.paths)).toEqual([path]); expect(referencingRoutines([source], path.id)).toEqual([source]);
    const key = deploymentInputKey(project, 'routine', source.id, 'catalog');
    project.paths[0] = { ...path, constraints: { ...path.constraints, maxVel: path.constraints.maxVel / 2 } };
    expect(deploymentInputKey(project, 'routine', source.id, 'catalog')).not.toBe(key);
    const derive = vi.spyOn(PM, 'derivePath');
    try { expect(AUTO.buildRun(source, project.paths, project.robot, {}, project.plannerId).segs).toHaveLength(3); expect(derive).toHaveBeenCalledOnce(); }
    finally { derive.mockRestore(); }
    expect(AUTO.buildRun(source, [], project.robot, {}, project.plannerId)).toMatchObject({ blocked: true, stopReason: 'invalid' });
  });
  it('blocks malformed ready plans without crashing or substituting provisional geometry', () => {
    const path = { id: 'p', name: 'Path' }, source = routine([{ id: 'drive', type: 'path', ref: 'p' }]);
    expect(AUTO.buildRun(source, [path], {}, {}, undefined, null, { status: 'ready', values: { p: {} } })).toMatchObject({ blocked: true, stopReason: 'invalid', timedPlayable: false });
    expect(AUTO.buildRun(source, [path], {}, {}, undefined, null, { status: 'pending', values: { p: {} } })).toMatchObject({ blocked: true, planningStatus: 'pending' });
  });
  it('holds reference pose through control ties, preserves authoritative samples, warns loop-return jump', () => {
    const path = { id: 'p', name: 'Path' }, samples = [{ t: 0, x: 1, y: 2, headingRad: Math.PI - .0002, velocityMps: 0, s: 0, f: 0 }, { t: 2, x: 2, y: 2, headingRad: -Math.PI + .0002, velocityMps: 0, s: 1, f: 1 }];
    const plan = { finalTrajectory: { samples, totalTimeS: 2, totalDistanceM: 1 } };
    const source = routine([repeat('loop', [{ id: 'drive', type: 'path', ref: 'p' }, decision('d', []), wait('hold', 1)], 2), end('stop')]);
    const trace = AUTO.buildRun(source, [path], {}, {}, undefined, null, { status: 'ready', values: { p: plan } });
    expect(trace.segs[0].pts).toBe(samples); expect(trace.segs[0].trajectory).toBe(plan.finalTrajectory);
    expect(trace.issues).toEqual([expect.objectContaining({ code: 'reference-discontinuity', distanceM: 1, nodeId: 'drive' })]);
    expect(AUTO.poseAt(trace, 2)).toMatchObject({ x: 2, y: 2, speed: 0 }); expect(AUTO.poseAt(trace, 6)).toMatchObject({ x: 2, y: 2, speed: 0 });
    expect(AUTO.stepAt(trace, 2)).toBe(3); expect(AUTO.fieldOverlay(trace).map(s => s.occurrenceId)).toEqual(trace.segs.map(s => s.occurrenceId));
  });
});
