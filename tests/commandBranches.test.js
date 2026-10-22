import { describe, it, expect } from 'vitest';
import { AUTO } from '../src/renderer/lib/routineModel';

const output = (kind, extra = {}) => ({ name: 'result', schema: { kind, ...extra } });
const command = (branch) => ({ id: 'command', type: 'function', cat: 'command', invocation: { commandId: 'scan', arguments: {} }, outputBranch: branch });
describe('command output branching', () => {
  it('offers branch and bounded control authoring alongside commands, paths, and waits', () => {
    expect(AUTO.AUTHORABLE_STEPS.map((step) => step.id)).toEqual(['path', 'command', 'repeat', 'end', 'wait']);
  });
  it('creates boolean and named routes with exact values and numeric fallback', () => {
    expect(AUTO.newOutputBranch(output('boolean')).routes.map((route) => route.value)).toEqual([true, false]);
    const named = AUTO.newOutputBranch(output('enum', { enumValues: ['Success', 'Retry', 'Failed'] }));
    expect(named.routes.map((route) => route.value)).toEqual(['Success', 'Retry', 'Failed', undefined]);
    expect(new Set(named.routes.map((route) => route.id)).size).toBe(4);
    expect(AUTO.newOutputBranch(output('integerString')).routes[0].value).toBe('0');
    expect(AUTO.newOutputBranch(output('number')).routes.at(-1).operator).toBe('otherwise');
  });
  it('edits nested routes without losing siblings or mutating the source', () => {
    const node = command(AUTO.newOutputBranch(output('boolean')));
    const routine = { nodes: [node] };
    const route = node.outputBranch.routes[1].id;
    const a = { id: 'a', type: 'builtin', builtinId: 'bordeaux.wait', arguments: { durationS: 1 } };
    let edited = AUTO.appendBranch(routine, node.id, route, a);
    edited = AUTO.insertAfter(edited, 'a', { ...a, id: 'b' });
    edited = AUTO.move(edited, 'b', -1);
    expect(AUTO.siblingNodes(edited, 'b').map((n) => n.id)).toEqual(['b', 'a']);
    expect(AUTO.countSteps(edited)).toBe(3);
    expect(AUTO.findNode(AUTO.remove(edited, 'a'), 'a')).toBeNull();
    expect(routine.nodes[0].outputBranch.routes[1].nodes).toEqual([]);
  });
  it('previews only the chosen route then rejoins following steps', () => {
    const branch = AUTO.newOutputBranch(output('boolean'));
    const wait = (id, durationS) => ({ id, type: 'builtin', builtinId: 'bordeaux.wait', arguments: { durationS } });
    branch.routes[0].nodes = [wait('yes', 1)];
    branch.routes[1].nodes = [wait('no', 2)];
    const routine = { nodes: [command(branch), wait('join', 3)] };
    const run = AUTO.buildRun(routine, [], {}, { command: branch.routes[1].id });
    expect(run.steps.map((step) => step.node.id)).toEqual(['command', 'no', 'join']);
    expect(run.total).toBe(5);
    expect(run.duration).toEqual({ minS: 5, maxS: null, unknownCount: 1, usesLimits: false });
    expect(AUTO.buildRun(routine, [], {}, { command: 'stale-id' }).steps.map((step) => step.node.id)).toEqual(['command', 'yes', 'join']);
  });
});
