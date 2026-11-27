import { describe, expect, it, vi } from 'vitest';
import { buildRoutineRuntime } from '../src/core/export/routineRuntime';
import { executeRoutine, preflightRoutine } from '../src/core/routineExecution';
import type { RoutineCommandCompletion, RoutineCommandRequest, RoutineExecutionAdapters } from '../src/core/routineExecution';
import { validateProject } from '../src/core/validation';
import { createDemoProject } from '../src/core/project/defaults';
import { routineFeaturesRequireV11 } from '../src/core/project/routineSchema';
import { projectCommandIds } from '../src/electron/usedCommands';
// @ts-expect-error Routine authoring remains a legacy JavaScript module.
import { AUTO } from '../src/renderer/lib/routineModel';
import { routineRuntimeFixture } from './fixtures/routineRuntimeFixture';
import type { AutonomousRoutine, RobotCommandDescriptor, RobotValueSchema, RoutineNode } from '../src/core/types';

type Step = { nodeId: string; t0: number; t1: number };
const boolean: RobotValueSchema = { kind: 'boolean', valueType: 'Boolean' };
const wait = (id: string, durationS = 1): RoutineNode => ({ id, type: 'builtin', builtinId: 'bordeaux.wait', arguments: { durationS } });
const cmd = (id: string, extra: Record<string, unknown> = {}): RoutineNode => ({ id, type: 'function', cat: 'command', title: id, invocation: { commandId: 'inspect', arguments: {}, ...extra } } as RoutineNode);
const group = (id: string, mode: 'parallel' | 'sequential', nodes: RoutineNode[], title?: string): RoutineNode => ({ id, type: 'group', mode, nodes, ...(title ? { title } : {}) });
const timeLoop = (seconds: number) => ({ loop: { until: { kind: 'time' as const, seconds } } });
const doneLoop = { loop: { until: { kind: 'output' as const, output: 'finished', schema: boolean, operator: 'eq' as const, value: true } } };

describe('routine group and loop validation', () => {
  const project = (nodes: RoutineNode[]) => { const p = createDemoProject(); p.routines[0].nodes = nodes; return p; };
  const messages = (nodes: RoutineNode[]) => validateProject(project(nodes)).issues.map(issue => issue.message);

  it('accepts groups of commands, waits and nested groups, with time and output loops', () => {
    expect(validateProject(project([group('g', 'parallel', [cmd('a', timeLoop(5)), group('s', 'sequential', [wait('w'), cmd('b', doneLoop)])], 'Intake and aim')])).issues).toEqual([]);
  });
  it('rejects paths, repeats, ends and branching commands inside a group', () => {
    const pathId = createDemoProject().paths[0].id;
    const branching = { ...cmd('c'), outputBranch: { output: 'finished', schema: boolean, routes: [
      { id: 't', label: 'Yes', operator: 'eq', value: true, nodes: [] }, { id: 'f', label: 'No', operator: 'eq', value: false, nodes: [] }] } } as RoutineNode;
    expect(messages([group('g', 'parallel', [{ id: 'p', type: 'path', ref: pathId }])])).toContain("Paths cannot run inside a group. To run commands while driving, add them to the path's Commands lane in Paths.");
    expect(messages([group('g', 'parallel', [{ id: 'r', type: 'repeat', times: 2, nodes: [wait('w')] }])])).toContain('Repeats cannot go inside a group.');
    expect(messages([group('g', 'sequential', [{ id: 'e', type: 'end', scope: 'routine' }])])).toContain('End routine and Exit repeat cannot go inside a group.');
    expect(messages([group('g', 'parallel', [branching])])).toContain('A command in a group cannot branch on its output.');
    expect(messages([{ id: 'g', type: 'group', mode: 'sideways', nodes: [] } as unknown as RoutineNode])).toContain('Group must run in parallel or in sequence');
  });
  it('rejects path-only loop limits and loops that branch', () => {
    expect(messages([cmd('a', { loop: { until: { kind: 'distance', meters: 1.5 } } })])).toContain('Distance and path end loops apply only to path commands');
    expect(messages([cmd('a', { loop: { until: { kind: 'pathEnd' } } })])).toContain('Distance and path end loops apply only to path commands');
    const looping = { ...cmd('a', timeLoop(2)), outputBranch: { output: 'finished', schema: boolean, routes: [
      { id: 't', label: 'Yes', operator: 'eq', value: true, nodes: [] }, { id: 'f', label: 'No', operator: 'eq', value: false, nodes: [] }] } } as RoutineNode;
    expect(messages([looping])).toContain('A looping command cannot branch on its output');
  });
  it('marks groups and loops as source 1.1 features and still finds grouped command IDs', () => {
    const p = project([group('g', 'parallel', [cmd('a')])]);
    expect(routineFeaturesRequireV11(p)).toBe(true);
    expect(routineFeaturesRequireV11(project([cmd('a', timeLoop(1))]))).toBe(true);
    expect(routineFeaturesRequireV11(project([cmd('a')]))).toBe(false);
    expect([...projectCommandIds(p, { routineId: p.routines[0].id })]).toEqual(['inspect']);
  });
});

describe('routine group model operations', () => {
  const routine = (): AutonomousRoutine => ({ id: 'r', name: 'R', nodes: [cmd('a'), wait('w'), group('g', 'parallel', [cmd('b')]), { id: 'p', type: 'path', ref: 'path' }] });

  it('inserts and moves only group-legal steps into a group, leaving the source unchanged', () => {
    const source = routine(), before = structuredClone(source);
    const inside = { kind: 'group', nodeId: 'g' };
    expect(AUTO.editRoutine(source, { kind: 'insert', listRef: inside, index: 1, node: AUTO.newNode('path', null, 'path') })).toMatchObject({ changed: false, reason: "Paths cannot run inside a group. To run commands while driving, add them to the path's Commands lane in Paths." });
    expect(AUTO.editRoutine(source, { kind: 'insert', listRef: inside, index: 0, node: AUTO.newNode('repeat') }).changed).toBe(false);
    expect(AUTO.checkEdit(source, { kind: 'move', nodeId: 'p', listRef: inside, index: 0 })).toMatchObject({ allowed: false, reason: "Paths cannot run inside a group. To run commands while driving, add them to the path's Commands lane in Paths." });
    const moved = AUTO.editRoutine(source, { kind: 'move', nodeId: 'w', listRef: inside, index: 1 });
    expect(moved.changed).toBe(true);
    expect((AUTO.locate(moved.routine, 'g')!.node as { nodes: RoutineNode[] }).nodes.map((node: RoutineNode) => node.id)).toEqual(['b', 'w']);
    expect(AUTO.locate(moved.routine, 'w')).toMatchObject({ groupIds: ['g'], parent: { id: 'g' } });
    const nested = AUTO.editRoutine(moved.routine, { kind: 'insert', listRef: inside, index: 2, node: AUTO.newNode('group', 'sequential') });
    expect(nested.changed).toBe(true);
    // Undo is the owner's history restoring the earlier routine object; no edit mutated it.
    expect(source).toEqual(before);
  });
  it('wraps a contiguous range in a group, switches its mode and ungroups it again', () => {
    const wrapped = AUTO.editRoutine(routine(), { kind: 'wrapGroup', nodeIds: ['a', 'w'], mode: 'parallel', groupId: 'new' });
    expect(wrapped.changed).toBe(true);
    expect(wrapped.routine.nodes.map((node: RoutineNode) => node.id)).toEqual(['new', 'g', 'p']);
    expect(wrapped.focusId).toBe('new');
    expect(AUTO.editRoutine(routine(), { kind: 'wrapGroup', nodeIds: ['g', 'p'], mode: 'parallel' })).toMatchObject({ changed: false, reason: "Paths cannot run inside a group. To run commands while driving, add them to the path's Commands lane in Paths." });
    const sequential = AUTO.editRoutine(wrapped.routine, { kind: 'setGroupMode', nodeId: 'new', mode: 'sequential' });
    expect(AUTO.locate(sequential.routine, 'new')!.node).toMatchObject({ mode: 'sequential' });
    expect(AUTO.editRoutine(sequential.routine, { kind: 'setGroupMode', nodeId: 'new', mode: 'sequential' }).changed).toBe(false);
    const ungrouped = AUTO.editRoutine(sequential.routine, { kind: 'unwrapGroup', nodeId: 'new' });
    expect(ungrouped.routine.nodes.map((node: RoutineNode) => node.id)).toEqual(['a', 'w', 'g', 'p']);
  });
  it('deletes, nudges and duplicates group children like repeat bodies', () => {
    expect(AUTO.remove(routine(), 'b').nodes[2]).toMatchObject({ id: 'g', nodes: [] });
    expect(AUTO.move(AUTO.insertAfter(routine(), 'b', wait('x')), 'x', -1).nodes[2]).toMatchObject({ nodes: [{ id: 'x' }, { id: 'b' }] });
    expect(AUTO.findNode(routine(), 'b')).toMatchObject({ id: 'b' });
    expect(AUTO.countSteps(routine())).toBe(5);
    expect(AUTO.analyze({ id: 'r', name: 'R', nodes: [group('g', 'parallel', [])] }).map((issue: { code: string }) => issue.code)).toContain('group-empty');
  });
  it('previews a parallel group as long as its longest step and a sequence as their sum', () => {
    const run = (mode: 'parallel' | 'sequential') => AUTO.buildRun({ nodes: [wait('before', .5), group('g', mode, [wait('w1', 1), cmd('c', timeLoop(3)), wait('w2', 2)]), wait('after', .5)] }, [], {}, {}, 'profiledSpline', null, {});
    const parallel = run('parallel'), sequence = run('sequential');
    expect(parallel.total).toBeCloseTo(4);
    expect(sequence.total).toBeCloseTo(7);
    expect(parallel.groupSpans).toEqual([expect.objectContaining({ nodeId: 'g', mode: 'parallel', t0: .5, t1: 3.5 })]);
    const starts = Object.fromEntries(parallel.steps.map((step: Step) => [step.nodeId, [step.t0, step.t1]]));
    expect(starts).toMatchObject({ w1: [.5, 1.5], c: [.5, 3.5], w2: [.5, 2.5], after: [3.5, 4] });
    // Steps stay ordered by end time so the playhead lookup remains exact.
    expect(parallel.steps.map((step: Step) => step.t1)).toEqual([...parallel.steps.map((step: Step) => step.t1)].sort((a, b) => a - b));
    expect(AUTO.stepAt(parallel, 2) >= 0 && parallel.steps[AUTO.stepAt(parallel, 2)].nodeId).toBe('w2');
    // The time loop is drawn for its limit, but its last run finishes on its own, so the total isn't claimed as known.
    expect(parallel.duration).toMatchObject({ unknownCount: 1, maxS: null });
    expect(run('parallel').steps.find((step: Step) => step.nodeId === 'c')).toMatchObject({ timing: 'unknown', dur: 3 });
  });
  it('keeps a time loop across a command change and an output loop only on a matching output', () => {
    const command = { id: 'next', outputs: [{ name: 'finished', schema: boolean }] };
    expect(AUTO.carryLoop(timeLoop(4).loop, { id: 'other', outputs: [] })).toEqual(timeLoop(4).loop);
    expect(AUTO.carryLoop(doneLoop.loop, command)).toEqual(doneLoop.loop);
    expect(AUTO.carryLoop(doneLoop.loop, { id: 'other', outputs: [{ name: 'finished', schema: { kind: 'integer', valueType: 'I32' } }] })).toBeUndefined();
    expect(AUTO.loopSummary(timeLoop(5).loop, null)).toBe('for 5.00 s');
    expect(AUTO.loopSummary(doneLoop.loop, command)).toBe('until finished = true');
  });
});

describe('runtime routine /2 export', () => {
  it('writes /2 only for groups and loops, with fixed loop/limit fields on every node', () => {
    const f = routineRuntimeFixture(), schema = f.command.outputs![0].schema;
    f.project.routines[0].nodes = [
      { id: 'g', type: 'group', mode: 'parallel', title: 'Not exported', nodes: [
        { id: 'a', type: 'function', cat: 'command', invocation: { ...f.invocation(), loop: { until: { kind: 'time', seconds: 2 } } } },
        { id: 's', type: 'group', mode: 'sequential', nodes: [
          { id: 'w', type: 'builtin', builtinId: 'bordeaux.wait', arguments: { durationS: .5 } },
          { id: 'b', type: 'function', cat: 'command', invocation: { ...f.invocation(), loop: { until: { kind: 'output', output: 'Result', schema, operator: 'gte', value: '5' } } } },
        ] },
      ] },
      { id: 'p', type: 'path', ref: f.project.paths[0].id },
    ];
    const original = structuredClone(f.project), d = buildRoutineRuntime(f.project, 'routine', f.bindings).document;
    expect(f.project).toEqual(original);
    expect(d.schema).toBe('bordeaux-routine-runtime/2');
    expect(d.nodes.map(n => [n.id, n.op, n.parent, n.firstChild, n.nextSibling, n.loop, n.limit, n.stop, n.wait])).toEqual([
      ['g', 8, -1, 1, 5, 0, 0, -1, 0], ['a', 2, 0, -1, 2, 1, 2, -1, 0], ['s', 9, 0, 3, -1, 0, 0, -1, 0],
      ['w', 3, 2, -1, 4, 0, 0, -1, .5], ['b', 2, 2, -1, -1, 4, 0, 0, 0], ['p', 1, -1, -1, -1, 0, 0, -1, 0],
    ]);
    expect(d.nodes.every(n => Object.keys(n).length === 12)).toBe(true);
    expect(d.comparisons).toEqual([{ producer: 4, output: 0, operator: 6, tag: 9, valueHex: '0000000000000005' }]);
    expect(JSON.stringify(d)).not.toContain('Not exported');
  });
  it('keeps /1 output identical for routines without groups or loops', () => {
    const f = routineRuntimeFixture();
    f.project.routines[0].nodes = [{ id: 'a', type: 'function', cat: 'command', invocation: f.invocation() }, { id: 'w', type: 'builtin', builtinId: 'bordeaux.wait', arguments: { durationS: .02 } }];
    const d = buildRoutineRuntime(f.project, 'routine', f.bindings).document;
    expect(d.schema).toBe('bordeaux-routine-runtime/1');
    expect(d.nodes.every(n => Object.keys(n).length === 10 && !('loop' in n) && !('limit' in n))).toBe(true);
  });
  it.each([
    ['an empty group', [{ id: 'g', type: 'group', mode: 'parallel', nodes: [] }], /at least one step/],
    ['a path in a group', [{ id: 'g', type: 'group', mode: 'parallel', nodes: [{ id: 'p', type: 'path', ref: 'PATH' }] }], /Paths cannot run inside a group/],
    ['an end in a group', [{ id: 'g', type: 'group', mode: 'sequential', nodes: [{ id: 'e', type: 'end', scope: 'routine' }] }], /cannot go inside a group/],
    ['a distance loop', [{ id: 'a', type: 'function', cat: 'command', invocation: 'LOOP:distance' }], /apply only to path commands/],
    ['a path end loop', [{ id: 'a', type: 'function', cat: 'command', invocation: 'LOOP:pathEnd' }], /apply only to path commands/],
    ['a too-short time loop', [{ id: 'a', type: 'function', cat: 'command', invocation: 'LOOP:short' }], /Loop time must be/],
  ])('rejects %s before publishing anything', (_label, raw, error) => {
    const f = routineRuntimeFixture();
    const loops: Record<string, unknown> = { 'LOOP:distance': { kind: 'distance', meters: 1 }, 'LOOP:pathEnd': { kind: 'pathEnd' }, 'LOOP:short': { kind: 'time', seconds: .001 } };
    const nodes = JSON.parse(JSON.stringify(raw).replace('"PATH"', JSON.stringify(f.project.paths[0].id)), (key, value) =>
      key === 'invocation' && typeof value === 'string' ? { ...f.invocation(), loop: { until: loops[value] } } : value);
    f.project.routines[0].nodes = nodes;
    expect(() => buildRoutineRuntime(f.project, 'routine', f.bindings)).toThrow(error);
  });
  it('rejects a looping command with routes and a repeat stop that reads a looping command', () => {
    const descriptor: RobotCommandDescriptor = { id: 'inspect', label: 'Inspect', ownerType: 'LabVIEW', member: 'Inspect.vi', kind: 'factory', confidence: 'confirmed', parameters: [], outputs: [{ name: 'finished', schema: boolean }], source: { file: 'Inspect.vi', line: 1 } };
    const commands = new Map([[descriptor.id, descriptor]]);
    const routes = { output: 'finished', schema: boolean, routes: [{ id: 't', label: 'Yes', operator: 'eq', value: true, nodes: [] }, { id: 'f', label: 'No', operator: 'eq', value: false, nodes: [] }] };
    expect(() => preflightRoutine({ id: 'r', name: 'R', nodes: [{ ...cmd('a', timeLoop(1)), outputBranch: routes } as RoutineNode] }, commands, new Set())).toThrow(/cannot branch on its output/);
    expect(() => preflightRoutine({ id: 'r', name: 'R', nodes: [{ id: 'rep', type: 'repeat', until: { source: 'output', nodeId: 'a', output: 'finished', schema: boolean, operator: 'eq', value: true }, nodes: [cmd('a', timeLoop(1))] }] }, commands, new Set())).toThrow(/cannot read a looping command/);
  });
});

describe('reference interpreter for groups and loops', () => {
  const descriptor: RobotCommandDescriptor = { id: 'inspect', label: 'Inspect', ownerType: 'LabVIEW', member: 'Inspect.vi', kind: 'factory', confidence: 'confirmed', parameters: [], outputs: [{ name: 'finished', schema: boolean }], source: { file: 'Inspect.vi', line: 1 } };
  const execute = (nodes: RoutineNode[], adapters: RoutineExecutionAdapters, signal = new AbortController().signal) => executeRoutine({ id: 'r', name: 'R', nodes }, [descriptor], new Set(), adapters, signal);
  /** A host whose commands and waits finish only when the test releases them, recording what is in flight. */
  function controlledHost() {
    const pending: Array<{ request: RoutineCommandRequest; finish: (finished?: boolean) => void; fail: () => void; cancelled: boolean }> = [], waits: Array<{ seconds: number; done: () => void; signal: AbortSignal }> = [];
    const adapters: RoutineExecutionAdapters = {
      path: vi.fn(async () => {}),
      wait: vi.fn((seconds: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
        waits.push({ seconds, done: resolve, signal });
        signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
      })),
      command: vi.fn((request: RoutineCommandRequest) => new Promise<RoutineCommandCompletion>(resolve => {
        const entry = { request, cancelled: false, finish: (finished = true) => resolve({ invocationId: request.invocationId, status: 'completed' as const, outputs: { finished } }),
          fail: () => resolve({ invocationId: request.invocationId, status: 'failed' as const, outputs: {} }) };
        request.signal.addEventListener('abort', () => { entry.cancelled = true; resolve({ invocationId: request.invocationId, status: 'cancelled', outputs: {} }); }, { once: true });
        pending.push(entry);
      })),
    };
    return { adapters, pending, waits };
  }
  const settle = () => new Promise(resolve => setTimeout(resolve, 5));

  it('waits for a cancelled run to finish cleaning up before the next step starts', async () => {
    const order: string[] = [];
    let release!: () => void;
    const adapters: RoutineExecutionAdapters = {
      path: vi.fn(async () => {}),
      wait: vi.fn(async () => {}),
      command: vi.fn((request: RoutineCommandRequest) => new Promise<RoutineCommandCompletion>(resolve => {
        order.push('start ' + request.nodeId);
        if (request.nodeId === 'fails') { resolve({ invocationId: request.invocationId, status: 'failed', outputs: {} }); return; }
        // Cancellation takes time on the robot: the run settles only after its cleanup is released.
        request.signal.addEventListener('abort', () => { order.push('cancel ' + request.nodeId); release = () => { order.push('cleaned ' + request.nodeId); resolve({ invocationId: request.invocationId, status: 'cancelled', outputs: {} }); }; }, { once: true });
      })),
    };
    // A failing parallel sibling cancels the slow command; the routine reports the failure only after cleanup.
    let settledAt = '';
    const done = execute([group('g', 'parallel', [cmd('slow'), cmd('fails')])], adapters).catch((error: Error) => { settledAt = order.join(','); return error; });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(order).toEqual(['start slow', 'start fails', 'cancel slow']);
    expect(settledAt).toBe('');
    release();
    expect(await done).toBeInstanceOf(Error);
    expect(settledAt).toBe('start slow,start fails,cancel slow,cleaned slow');
  });

  it('starts parallel children together and finishes when the last one finishes', async () => {
    const { adapters, pending } = controlledHost();
    const done = execute([group('g', 'parallel', [cmd('a'), group('s', 'sequential', [cmd('b'), cmd('c')])]), cmd('after')], adapters);
    await settle();
    expect(pending.map(item => item.request.nodeId)).toEqual(['a', 'b']);
    pending[1].finish(); await settle();
    expect(pending.map(item => item.request.nodeId)).toEqual(['a', 'b', 'c']);
    pending[2].finish(); await settle();
    expect(pending).toHaveLength(3);
    pending[0].finish(); await settle();
    expect(pending.at(-1)!.request.nodeId).toBe('after');
    pending.at(-1)!.finish();
    expect(await done).toBe('completed');
  });
  it('cancels running siblings when a parallel child fails', async () => {
    const { adapters, pending } = controlledHost();
    const done = execute([group('g', 'parallel', [cmd('a'), cmd('b')]), cmd('after')], adapters);
    await settle();
    pending[0].fail();
    await expect(done).rejects.toThrow(/did not complete successfully/);
    expect(pending[1].cancelled).toBe(true);
    expect(pending.map(item => item.request.nodeId)).toEqual(['a', 'b']);
  });
  it('restarts a time loop until its limit, then lets the run in progress finish', async () => {
    const { adapters, pending, waits } = controlledHost();
    const done = execute([cmd('a', timeLoop(5)), cmd('after')], adapters);
    await settle();
    expect(waits).toEqual([expect.objectContaining({ seconds: 5 })]);
    pending[0].finish(); await settle();
    pending[1].finish(); await settle();
    expect(pending.map(item => item.request.nodeId)).toEqual(['a', 'a', 'a']);
    waits[0].done(); await settle();
    // The limit is not a cancel: the third run keeps going and nothing else starts until it finishes.
    expect(pending[2].cancelled).toBe(false);
    expect(pending.map(item => item.request.nodeId)).toEqual(['a', 'a', 'a']);
    pending[2].finish(); await settle();
    expect(pending.map(item => item.request.nodeId)).toEqual(['a', 'a', 'a', 'after']);
    pending.at(-1)!.finish();
    expect(await done).toBe('completed');
  });
  it('ends a time loop at once when a run fails, without waiting out the limit, and runs once if the limit passes first', async () => {
    // A host whose wait ignores cancellation: the loop must not depend on it settling.
    const failing: RoutineExecutionAdapters = {
      path: vi.fn(async () => {}), wait: vi.fn(() => new Promise<void>(() => {})),
      command: vi.fn(async (request: RoutineCommandRequest) => ({ invocationId: request.invocationId, status: 'failed' as const, outputs: {} })),
    };
    await expect(execute([cmd('a', timeLoop(3600))], failing)).rejects.toThrow(/did not complete successfully/);
    let finishRun!: () => void; const requests: RoutineCommandRequest[] = [];
    const slow: RoutineExecutionAdapters = {
      path: vi.fn(async () => {}), wait: vi.fn(async () => {}),
      command: vi.fn((request: RoutineCommandRequest) => new Promise<RoutineCommandCompletion>(resolve => {
        requests.push(request); finishRun = () => resolve({ invocationId: request.invocationId, status: 'completed', outputs: { finished: true } });
      })),
    };
    const done = execute([cmd('a', timeLoop(0.02))], slow);
    await settle(); finishRun();
    expect(await done).toBe('completed');
    expect(requests).toHaveLength(1);
    expect(requests[0].signal.aborted).toBe(false);
  });
  it('checks an output loop after each completed run', async () => {
    const { adapters, pending } = controlledHost();
    const done = execute([cmd('a', doneLoop)], adapters);
    await settle(); pending[0].finish(false);
    await settle(); pending[1].finish(false);
    await settle(); pending[2].finish(true);
    expect(await done).toBe('completed');
    expect(pending).toHaveLength(3);
  });
});
