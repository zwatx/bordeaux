import { describe, expect, it, vi } from 'vitest';
import { compareCommandOutput, executeRoutine, selectCommandOutputRoute } from '../src/shared/routineExecution';
import type { RoutineExecutionAdapters, RoutineCommandRequest } from '../src/shared/routineExecution';
import type { AutonomousRoutine, RobotCommandDescriptor, RobotValueSchema, RoutineCommandOutputBranch, RoutineFunctionNode, RoutineNode, RoutineRepeatNode } from '../src/shared/types';

const boolean: RobotValueSchema = { kind: 'boolean', valueType: 'Boolean' };
const descriptor = (schema = boolean): RobotCommandDescriptor => ({ id: 'inspect', label: 'Inspect', ownerType: 'LabVIEW', member: 'Inspect.vi', kind: 'factory', confidence: 'confirmed', parameters: [], outputs: [{ name: 'finished', schema }], source: { file: 'Inspect.vi', line: 1 } });
const command = (id = 'C'): RoutineFunctionNode => ({ id, type: 'function', cat: 'command', invocation: { commandId: 'inspect', arguments: {} } });
const branch = (schema = boolean): RoutineCommandOutputBranch => ({ output: 'finished', schema, routes: [
  { id: 'yes', label: 'Yes', operator: 'eq', value: true, nodes: [] }, { id: 'no', label: 'No', operator: 'eq', value: false, nodes: [] },
] });
const loop = (): RoutineRepeatNode => ({ id: 'loop', type: 'repeat', nodes: [{ id: 'A', type: 'path', ref: 'A' }, { id: 'B', type: 'path', ref: 'B' }, command()], until: { source: 'output', nodeId: 'C', output: 'finished', schema: boolean, operator: 'eq', value: true } });
const routine = (nodes: RoutineNode[]): AutonomousRoutine => ({ id: 'r', name: 'R', nodes });
const host = (answer: (request: RoutineCommandRequest) => unknown = () => true): RoutineExecutionAdapters => ({
  path: vi.fn(async () => {}), wait: vi.fn(async () => {}),
  command: vi.fn<RoutineExecutionAdapters['command']>(async request => ({ invocationId: request.invocationId, status: 'completed', outputs: { finished: answer(request) } })),
});
const run = (nodes: RoutineNode[], adapters = host(), signal = new AbortController().signal, descriptors = [descriptor()]) => executeRoutine(routine(nodes), descriptors, new Set(['A', 'B']), adapters, signal);

describe('completed command output decisions', () => {
  it('routes true and false without truthiness coercion', () => {
    expect(selectCommandOutputRoute(branch(), descriptor(), { finished: true }).id).toBe('yes');
    expect(selectCommandOutputRoute(branch(), descriptor(), { finished: false }).id).toBe('no');
    for (const value of [undefined, null, 'true', 1]) expect(() => selectCommandOutputRoute(branch(), descriptor(), { finished: value })).toThrow();
    expect(() => selectCommandOutputRoute(branch(), descriptor(), {})).toThrow(/did not return/);
  });
  it('uses enum cases, ordered double comparisons, and Otherwise only for valid values', () => {
    const schema: RobotValueSchema = { kind: 'enum', valueType: 'Enum', enumValues: ['Left', 'Right', 'None'] };
    const named = { ...branch(schema), routes: [{ ...branch().routes[0], value: 'Left' }, { id: 'other', label: 'Other', operator: 'otherwise' as const, nodes: [] }] };
    expect(selectCommandOutputRoute(named, descriptor(schema), { finished: 'Left' }).id).toBe('yes');
    expect(selectCommandOutputRoute(named, descriptor(schema), { finished: 'Right' }).id).toBe('other');
    expect(() => selectCommandOutputRoute(named, descriptor(schema), { finished: 'Unknown' })).toThrow();
    const dbl: RobotValueSchema = { kind: 'number', valueType: 'DBL' };
    const numeric: RoutineCommandOutputBranch = { output: 'finished', schema: dbl, routes: [
      { id: 'exact', label: 'Exact', operator: 'eq', value: 2.5, nodes: [] },
      { id: 'high', label: 'High', operator: 'gte', value: 2.5, nodes: [] },
      { id: 'low', label: 'Low', operator: 'otherwise', nodes: [] },
    ] };
    expect([2.5, 3, 1].map(value => selectCommandOutputRoute(numeric, descriptor(dbl), { finished: value }).id)).toEqual(['exact', 'high', 'low']);
    for (const value of [NaN, Infinity, '2.5']) expect(() => selectCommandOutputRoute(numeric, descriptor(dbl), { finished: value })).toThrow();
    expect(() => selectCommandOutputRoute({ ...numeric, routes: [numeric.routes[2], numeric.routes[0]] }, descriptor(dbl), { finished: 1 })).toThrow(/Otherwise/);
  });
  it('preserves exact 64-bit and extended precision numeric comparisons', () => {
    expect(compareCommandOutput({ kind: 'integerString', valueType: 'U64' }, '18446744073709551615', 'gt', '18446744073709551614')).toBe(true);
    expect(compareCommandOutput({ kind: 'integerString', valueType: 'I64' }, '-9223372036854775808', 'lt', '-9223372036854775807')).toBe(true);
    expect(compareCommandOutput({ kind: 'decimalString', valueType: 'EXT' }, '1.0000000000000000001', 'gt', '1')).toBe(true);
    expect(compareCommandOutput({ kind: 'decimalString', valueType: 'EXT' }, '1e-1000', 'eq', '10e-1001')).toBe(true);
    expect(() => compareCommandOutput({ kind: 'number', valueType: 'SGL' }, 1e100, 'gt', 0)).toThrow(/SGL range/);
  });
  it('waits for completion, then runs only the selected route and rejoins', async () => {
    let complete!: () => void;
    const adapters = host();
    adapters.command = vi.fn<RoutineExecutionAdapters['command']>(async request => { await new Promise<void>(resolve => { complete = resolve; }); return { invocationId: request.invocationId, status: 'completed', outputs: { finished: true } }; });
    const node = { ...command(), outputBranch: branch() };
    node.outputBranch.routes[0].nodes = [{ id: 'take-A', type: 'path', ref: 'A' }];
    node.outputBranch.routes[1].nodes = [{ id: 'take-B', type: 'path', ref: 'B' }];
    const execution = run([node, { id: 'join', type: 'builtin', builtinId: 'bordeaux.wait', arguments: { durationS: .25 } }], adapters);
    expect(adapters.path).not.toHaveBeenCalled(); complete();
    expect(await execution).toBe('completed');
    expect(adapters.path).toHaveBeenCalledExactlyOnceWith('A', expect.any(AbortSignal));
    expect(adapters.wait).toHaveBeenCalledExactlyOnceWith(.25, expect.any(AbortSignal));
  });
});

describe('dynamic output-driven repeats', () => {
  it('runs A, B, C on each pass, stops on this pass’s finished output, then continues', async () => {
    const order: string[] = []; let count = 0;
    const adapters = host(() => { order.push('C'); return ++count === 3; });
    adapters.path = vi.fn(async id => { order.push(id); });
    adapters.wait = vi.fn(async () => { order.push('join'); });
    expect(await run([loop(), { id: 'join', type: 'builtin', builtinId: 'bordeaux.wait', arguments: { durationS: .25 } }], adapters)).toBe('completed');
    expect(order).toEqual(['A', 'B', 'C', 'A', 'B', 'C', 'A', 'B', 'C', 'join']);
    const requests = vi.mocked(adapters.command).mock.calls.map(([request]) => request.invocationId);
    expect(new Set(requests).size).toBe(3);
  });
  it('has no hidden 50-pass limit, while fixed repeats retain their count', async () => {
    let count = 0; const adapters = host(() => ++count === 55);
    expect(await run([loop()], adapters)).toBe('completed'); expect(count).toBe(55);
    count = 0;
    expect(await run([{ ...loop(), times: 2 }], adapters)).toBe('completed'); expect(count).toBe(2);
  });
  it('never reuses an earlier pass or invocation’s output', async () => {
    let count = 0; const adapters = host();
    adapters.command = vi.fn<RoutineExecutionAdapters['command']>(async request => ({ invocationId: request.invocationId, status: 'completed', outputs: ++count === 1 ? { finished: false } : {} }));
    await expect(run([loop()], adapters)).rejects.toThrow(/from this pass/); expect(count).toBe(2);
    adapters.command = vi.fn<RoutineExecutionAdapters['command']>(async () => ({ invocationId: 'previous-invocation', status: 'completed', outputs: { finished: true } }));
    await expect(run([loop()], adapters)).rejects.toThrow(/this invocation/);
  });
  it.each(['failed', 'cancelled', 'timedOut'] as const)('does not branch on a %s command result', async status => {
    const adapters = host(); adapters.command = vi.fn(async request => ({ invocationId: request.invocationId, status, outputs: { finished: true } }));
    await expect(run([loop()], adapters)).rejects.toThrow(/did not complete/);
  });
  it('cancels an indefinite loop and a pending command without reading late output', async () => {
    const abort = new AbortController(); let count = 0;
    const adapters = host(() => { if (++count === 3) abort.abort(); return false; });
    expect(await run([loop()], adapters, abort.signal)).toBe('cancelled'); expect(count).toBe(3);
    const pending = new AbortController(); const waiting = host(); waiting.command = vi.fn(() => new Promise<never>(() => {}));
    const execution = run([loop()], waiting, pending.signal); pending.abort(); expect(await execution).toBe('cancelled');
  });
  it('rejects changed types, orphan exits and invalid hidden routes before any host operation', async () => {
    const adapters = host(); const changed = { ...command(), outputBranch: branch({ kind: 'number', valueType: 'DBL' }) };
    await expect(run([{ id: 'early', type: 'path', ref: 'A' }, changed], adapters)).rejects.toThrow(/type changed/);
    await expect(run([{ id: 'early', type: 'path', ref: 'A' }, { id: 'exit', type: 'end', scope: 'repeat' }], adapters)).rejects.toThrow(/no enclosing/);
    expect(adapters.path).not.toHaveBeenCalled(); expect(adapters.command).not.toHaveBeenCalled();
  });
  it('keeps nested repeat results separate and consumes Exit repeat at the closest loop', async () => {
    const order: string[] = [], adapters = host(request => { order.push(request.nodeId); return true; });
    const inner: RoutineRepeatNode = { ...loop(), id: 'inner', nodes: [command('inner-C')], until: { source: 'output', nodeId: 'inner-C', output: 'finished', schema: boolean, operator: 'eq', value: true } };
    const outer: RoutineRepeatNode = { id: 'outer', type: 'repeat', times: 2, nodes: [inner, command('outer-C')] };
    expect(await run([outer], adapters)).toBe('completed');
    expect(order).toEqual(['inner-C', 'outer-C', 'inner-C', 'outer-C']);
    const exit = { ...command('exit-command'), outputBranch: branch() };
    exit.outputBranch.routes[0].nodes = [{ id: 'leave-inner', type: 'end', scope: 'repeat' }];
    const repeat: RoutineRepeatNode = { id: 'exit-loop', type: 'repeat', times: 3, nodes: [exit, { id: 'skipped', type: 'path', ref: 'A' }] };
    await run([repeat, { id: 'after', type: 'path', ref: 'B' }], adapters);
    expect(adapters.path).toHaveBeenCalledExactlyOnceWith('B', expect.any(AbortSignal));
  });
  it('freezes source intent across an asynchronous command completion', async () => {
    const node = { ...command(), outputBranch: branch() };
    node.outputBranch.routes[0].nodes = [{ id: 'chosen', type: 'path', ref: 'A' }];
    const adapters = host(() => {
      node.outputBranch.routes[0].nodes[0] = { id: 'replacement', type: 'path', ref: 'B' };
      return true;
    });
    expect(await run([node], adapters)).toBe('completed');
    expect(adapters.path).toHaveBeenCalledExactlyOnceWith('A', expect.any(AbortSignal));
  });
  it('yields within a large terminal pass so queued cancellation stops it partway', async () => {
    const stop = new AbortController(), adapters = host();
    const large = Array.from({ length: 1000 }, (_, index) => command('C-' + index));
    const terminal: RoutineRepeatNode = { id: 'large-loop', type: 'repeat', nodes: large,
      until: { source: 'output', nodeId: 'C-999', output: 'finished', schema: boolean, operator: 'eq', value: true } };
    setTimeout(() => stop.abort(), 0);
    expect(await run([terminal], adapters, stop.signal)).toBe('cancelled');
    expect(vi.mocked(adapters.command).mock.calls.length).toBeGreaterThan(0);
    expect(vi.mocked(adapters.command).mock.calls.length).toBeLessThan(64);
  });
  it.each([[], null, 'text', 1, new Date()].map(value => [value]))('rejects malformed command argument records before any host operation: %j', async argumentsValue => {
    const adapters = host(), malformed = { ...command(), invocation: { commandId: 'inspect', arguments: argumentsValue } } as unknown as RoutineFunctionNode;
    await expect(run([{ id: 'before', type: 'path', ref: 'A' }, malformed], adapters)).rejects.toThrow(/arguments must be a JSON object/);
    expect(adapters.path).not.toHaveBeenCalled(); expect(adapters.command).not.toHaveBeenCalled();
  });
});
