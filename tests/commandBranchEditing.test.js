import { describe, expect, it } from 'vitest';
import { AUTO } from '../src/renderer/lib/routineModel';

const output = (kind = 'integer', extra = {}) => ({ name: 'score', schema: { kind, valueType: kind === 'integerString' ? 'I64' : 'I32' }, ...extra });
const nested = [{ id: 'repeat', type: 'repeat', times: 2, nodes: [{ id: 'decision', type: 'decision', then: [{ id: 'exit', type: 'end', scope: 'repeat' }], else: [] }] }];
function populated() {
  const branch = AUTO.newOutputBranch(output());
  branch.routes[0].nodes = structuredClone(nested);
  const other = AUTO.newOutputBranch(output()).routes[0];
  other.label = 'Second'; other.nodes = [{ id: 'wait', type: 'builtin', builtinId: 'bordeaux.wait', arguments: { durationS: .11 } }];
  branch.routes.splice(1, 0, other);
  return branch;
}

describe('checked command branch edits', () => {
  it('counts complete nested subtrees and replaces outputs without mutating source', () => {
    const branch = populated(), before = structuredClone(branch);
    const next = { name: 'ready', schema: { kind: 'boolean', valueType: 'Boolean' } };
    expect(AUTO.routeSteps(branch.routes)).toBe(4);
    const result = AUTO.branchEdit(branch, [next], { kind: 'output', output: next.name });
    expect(result.status).toBe('applied'); expect(result.removed).toBe(4);
    expect(result.branch.output).toBe('ready'); expect(result.branch.routes.map(r => r.value)).toEqual([true, false]);
    expect(result.branch.routes.every(r => !branch.routes.some(old => old.id === r.id))).toBe(true);
    expect(branch).toEqual(before);
    expect(AUTO.branchEdit(branch, [], { kind: 'output', output: '' })).toEqual({ status: 'applied', removed: 4, branch: undefined });
    expect(AUTO.branchEdit(undefined, [], { kind: 'output', output: '' }).status).toBe('unchanged');
  });
  it('preserves unavailable saved output data until an explicit supported replacement', () => {
    const branch = populated();
    expect(AUTO.branchEdit(branch, [], { kind: 'output', output: branch.output }).status).toBe('unchanged');
    expect(AUTO.branchEdit(branch, [], { kind: 'output', output: 'unknown' }).status).toBe('refused');
    expect(AUTO.branchEdit(branch, [], { kind: 'rebuild' }).status).toBe('unchanged');
    expect(AUTO.branchEdit(branch, [output()], { kind: 'rebuild' }).status).toBe('unchanged');
    const result = AUTO.branchEdit(branch, [output('integerString')], { kind: 'rebuild' });
    expect(result.status).toBe('applied'); expect(result.removed).toBe(4);
    expect(result.branch.schema.valueType).toBe('I64');
    expect(result.branch.routes[0].id).not.toBe(branch.routes[0].id);
  });
  it('removes only the requested comparison and protects Otherwise and the last comparison', () => {
    const branch = populated(), id = branch.routes[0].id;
    const result = AUTO.branchEdit(branch, [output()], { kind: 'removeRoute', routeId: id });
    expect(result.status).toBe('applied'); expect(result.removed).toBe(3);
    expect(result.branch.routes).toEqual(branch.routes.slice(1));
    expect(AUTO.branchEdit(result.branch, [], { kind: 'removeRoute', routeId: result.branch.routes[0].id }).status).toBe('refused');
    expect(AUTO.branchEdit(branch, [], { kind: 'removeRoute', routeId: branch.routes.at(-1).id }).status).toBe('refused');
    expect(AUTO.branchEdit(branch, [], { kind: 'removeRoute', routeId: 'missing' }).status).toBe('refused');
  });
  it('merges only allowed fields into live routes, retaining every live nested step', () => {
    const branch = populated(), route = branch.routes[0], id = route.id;
    route.nodes.push({ id: 'later', type: 'path', ref: 'path-new' });
    let result = AUTO.branchEdit(branch, [output()], { kind: 'patchRoute', routeId: id, patch: { label: ' New name ', nodes: [] } });
    expect(result.status).toBe('applied'); expect(result.removed).toBe(0);
    expect(result.branch.routes[0].label).toBe('New name'); expect(result.branch.routes[0].nodes).toBe(route.nodes);
    expect(result.branch.routes[1]).toBe(branch.routes[1]);
    result = AUTO.branchEdit(result.branch, [output()], { kind: 'patchRoute', routeId: id, patch: { value: 7, operator: 'lt' } });
    expect(result.branch.routes[0]).toMatchObject({ label: 'New name', value: 7, operator: 'lt' });
    expect(result.branch.routes[0].nodes).toBe(route.nodes);
    expect(AUTO.branchEdit(branch, [], { kind: 'patchRoute', routeId: id, patch: { label: ' ', nodes: [] } }).status).toBe('unchanged');
    expect(AUTO.branchEdit(branch, [], { kind: 'patchRoute', routeId: 'missing', patch: { label: 'New' } }).status).toBe('refused');
  });
  it('validates numeric bounds and exact integer strings without converting them', () => {
    const branch = populated(), id = branch.routes[0].id;
    for (const value of [1.1, NaN, Infinity, 2147483648, 11]) {
      expect(AUTO.branchEdit(branch, [output('integer', { max: 10 })], { kind: 'patchRoute', routeId: id, patch: { value } }).status).toBe('refused');
    }
    const exact = output('integerString', { min: '9007199254740993', max: '9223372036854775807' });
    const b = AUTO.newOutputBranch(exact), routeId = b.routes[0].id;
    const result = AUTO.branchEdit(b, [exact], { kind: 'patchRoute', routeId, patch: { value: '9007199254740993' } });
    expect(result.status).toBe('applied'); expect(result.branch.routes[0].value).toBe('9007199254740993');
    for (const value of ['9007199254740992', '9223372036854775808', 9007199254740992, '1e16']) {
      expect(AUTO.branchEdit(b, [exact], { kind: 'patchRoute', routeId, patch: { value } }).status).toBe('refused');
    }
  });
  it('uses only compatible catalog bounds for a retained branch schema', () => {
    const original = output('integerString'), branch = AUTO.newOutputBranch(original), routeId = branch.routes[0].id;
    const changed = { name: original.name, schema: { kind: 'number', valueType: 'DBL' }, min: .5, max: 1.5 };
    const patch = { kind: 'patchRoute', routeId, patch: { value: '2' } };
    // Catalog sync preserves authored routes until explicit rebuild. Its new bounds belong to the new schema.
    const result = AUTO.branchEdit(branch, [changed], patch);
    expect(result.status).toBe('applied'); expect(result.branch.routes[0].value).toBe('2');
    expect(AUTO.branchEdit(branch, [{ ...original, min: '3' }], patch).status).toBe('refused');
    expect(branch.schema.valueType).toBe('I64');
  });
  it('validates only supplied fields and keeps Otherwise editable by name only', () => {
    const branch = populated(), routeId = branch.routes[0].id;
    expect(AUTO.branchEdit(branch, [], { kind: 'patchRoute', routeId, patch: { operator: 'neq' } }).branch.routes[0].operator).toBe('neq');
    expect(AUTO.branchEdit(branch, [], { kind: 'patchRoute', routeId, patch: { value: 9 } }).branch.routes[0].value).toBe(9);
    expect(AUTO.branchEdit(branch, [], { kind: 'patchRoute', routeId, patch: { operator: 'otherwise' } }).status).toBe('refused');
    const otherwise = branch.routes.at(-1).id;
    expect(AUTO.branchEdit(branch, [], { kind: 'patchRoute', routeId: otherwise, patch: { label: 'Fallback' } }).branch.routes.at(-1).label).toBe('Fallback');
    expect(AUTO.branchEdit(branch, [], { kind: 'patchRoute', routeId: otherwise, patch: { value: 1 } }).status).toBe('refused');
  });
  it('retains exact decimal bounds and refuses SGL overflow', () => {
    const exact = output('decimalString', { schema: { kind: 'decimalString', valueType: 'EXT' }, min: '0.1', max: '0.2' });
    const branch = AUTO.newOutputBranch(exact), routeId = branch.routes[0].id;
    const patch = (value) => AUTO.branchEdit(branch, [exact], { kind: 'patchRoute', routeId, patch: { value } });
    expect(patch('0.10000000000000000001').branch.routes[0].value).toBe('0.10000000000000000001');
    expect(patch('0.20000000000000000001').status).toBe('refused');
    const single = output('number', { schema: { kind: 'number', valueType: 'SGL' } });
    const sgl = AUTO.newOutputBranch(single);
    expect(AUTO.branchEdit(sgl, [single], { kind: 'patchRoute', routeId: sgl.routes[0].id, patch: { value: 3.5e38 } }).status).toBe('refused');
    expect(AUTO.branchEdit(sgl, [single], { kind: 'patchRoute', routeId: sgl.routes[0].id, patch: { value: 3.4e38 } }).status).toBe('applied');
  });
  it('reorders only comparisons and adds a fresh empty route before Otherwise', () => {
    const branch = populated();
    let result = AUTO.branchEdit(branch, [], { kind: 'routeEarlier', routeId: branch.routes[1].id });
    expect(result.branch.routes).toEqual([branch.routes[1], branch.routes[0], branch.routes[2]]);
    expect(result.removed).toBe(0);
    expect(AUTO.branchEdit(branch, [], { kind: 'routeEarlier', routeId: branch.routes[0].id }).status).toBe('unchanged');
    expect(AUTO.branchEdit(branch, [], { kind: 'routeEarlier', routeId: branch.routes.at(-1).id }).status).toBe('refused');
    result = AUTO.branchEdit(branch, [], { kind: 'addComparison' });
    expect(result.branch.routes.slice(0, 2)).toEqual(branch.routes.slice(0, 2));
    expect(result.branch.routes.at(-1)).toBe(branch.routes.at(-1));
    expect(result.branch.routes[2].nodes).toEqual([]); expect(result.branch.routes[2].id).not.toBe(branch.routes[0].id);
    const full = { ...branch, routes: Array.from({ length: 256 }, (_, i) => ({ ...branch.routes[0], id: String(i) })) };
    expect(AUTO.branchEdit(full, [], { kind: 'addComparison' }).status).toBe('unchanged');
    const bool = AUTO.newOutputBranch({ name: 'ready', schema: { kind: 'boolean', valueType: 'Boolean' } });
    expect(AUTO.branchEdit(bool, [], { kind: 'addComparison' }).status).toBe('refused');
    expect(AUTO.branchEdit(bool, [], { kind: 'patchRoute', routeId: bool.routes[0].id, patch: { value: false } }).status).toBe('refused');
  });
});
