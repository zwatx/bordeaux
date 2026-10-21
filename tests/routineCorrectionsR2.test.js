import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { AUTO } from '../src/renderer/lib/routineModel';
import { createDemoProject } from '../src/shared/project/defaults';
import { decodeProjectValue, encodeProjectFile } from '../src/shared/project/fileFormat';
import { promoteRoutineProjectSchema } from '../src/shared/project/routineSchema';
import { robotValueSchemasEqual } from '../src/shared/robotValueSchema';
import { ProjectRecoveryStore } from '../src/electron/projectRecoveryStore';
const wait = (id = 'wait') => ({ id, type: 'builtin', builtinId: 'bordeaux.wait', arguments: { durationS: 1 } });
const command = (id = 'producer') => ({ id, type: 'function', cat: 'command', invocation: { commandId: 'Acquire', arguments: {} } });
const loop = (nodes = [], until) => ({ id: 'loop', type: 'repeat', times: 2, nodes, ...(until ? { until } : {}) });
const routine = nodes => ({ id: 'r', name: 'R', nodes });
const project = nodes => ({ ...createDemoProject(), routines: [routine(nodes)], activeRoutineId: 'r' });
const hash = value => createHash('sha256').update(value).digest('hex');
const dirs = []; afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });

describe('routine review r2 strict source and feature selection', () => {
  it('rejects array/object enums and schema kinds without guessing an End/Exit intent', () => {
    for (const scope of [['routine'], ['repeat'], { toString: 'routine' }]) expect(() => decodeProjectValue(project([loop([{ id: 'bad', type: 'end', scope }])]))).toThrow(/End scope/);
    expect(AUTO.buildRun(routine([loop([{ id: 'bad', type: 'end', scope: ['routine'] }])]), [], {}, {})).toMatchObject({ blocked: true, stopReason: 'invalid' });
    for (const operator of [['gte'], ['eq'], { operator: 'eq' }]) expect(() => encodeProjectFile(project([loop([], { source: 'output', nodeId: '', output: '', operator })]))).toThrow(/comparison/);
    for (const kind of [['integerString'], ['boolean'], { kind: 'integerString' }]) expect(() => encodeProjectFile(project([loop([], { source: 'output', nodeId: '', output: '', operator: 'eq', schema: { kind, valueType: 'I64' } })]))).toThrow(/schema/);
    for (const onTimeout of [['continue'], ['endRoutine'], { onTimeout: 'continue' }]) expect(() => encodeProjectFile(project([{ ...command(), ends: { timeoutS: 2, onTimeout } }]))).toThrow(/Timeout policy/);
    expect(() => encodeProjectFile(project([{ ...command(), ends: { timeoutS: 2 } }, loop([], { source: 'output', nodeId: '', output: '', operator: 'eq' })]))).not.toThrow();
    for (const [scope, expected] of [['routine', ['loop', 'end']], ['repeat', ['loop', 'end', 'after']]]) {
      const decoded = decodeProjectValue(project([loop([{ id: 'end', type: 'end', scope }, wait('inside')]), wait('after')]));
      expect(AUTO.buildRun(decoded.project.routines[0], [], {}, {}).steps.map(step => step.nodeId)).toEqual(expected);
    }
  });
  it('promotes effective legacy aliases on the first encoding and is idempotent with/without version', () => {
    for (const version of ['1.0', undefined]) {
      const source = project([]); source.routines = []; source.routine = routine([{ ...wait(), ends: { endWhen: { source: 'condition', conditionId: '' } } }]);
      if (version === undefined) delete source.schemaVersion;
      const first = encodeProjectFile(source);
      expect(first.project.schemaVersion).toBe('1.1'); expect(decodeProjectValue(source).migrated).toBe(true);
      expect(encodeProjectFile(first.project).contents).toBe(first.contents);
      expect(encodeProjectFile(decodeProjectValue(JSON.parse(first.contents)).project).contents).toBe(first.contents);
    }
    const canonical = project([wait()]); canonical.routine = routine([loop()]);
    expect(promoteRoutineProjectSchema(canonical)).toBe(canonical); expect(encodeProjectFile(canonical).project.schemaVersion).toBe('1.0');
  });
  it('keeps opaque root/route/branch wrapper fields out of node feature detection', async () => {
    const contents = await fs.readFile(path.resolve('tests/fixtures/projects/routine-opaque-canonical-v1.bordeaux'), 'utf8');
    expect(hash(contents)).toBe('2353c35d3789d3fe6ba6ecea7cfd3462bc695263c9fd0fc4776bb2e5137176af');
    const source = JSON.parse(contents);
    expect(promoteRoutineProjectSchema(source)).toBe(source); expect(encodeProjectFile(source).project.schemaVersion).toBe('1.0');
    expect(encodeProjectFile(source).project.routines).toEqual(source.routines);
    const commandNode = source.routines[0].nodes.at(-1);
    commandNode.outputBranch.routes[1].nodes = [{ ...wait('actual'), ends: {} }];
    expect(promoteRoutineProjectSchema(source).schemaVersion).toBe('1.1');
    delete commandNode.outputBranch.routes[1].nodes[0].ends;
    commandNode.outputBranch.routes[1].nodes = [loop()]; expect(promoteRoutineProjectSchema(source).schemaVersion).toBe('1.1');
    commandNode.outputBranch.routes[1].nodes = [{ id: 'end', type: 'end', scope: 'routine' }]; expect(promoteRoutineProjectSchema(source).schemaVersion).toBe('1.1');
  });
  it('reopens actual prior-codec opaque-wrapper recovery bytes and exact resolution digest', async () => {
    const contents = await fs.readFile(path.resolve('tests/fixtures/projects/routine-opaque-canonical-v1.bordeaux'), 'utf8');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bordeaux-routine-r2-')); dirs.push(root);
    const store = new ProjectRecoveryStore(root), recordId = randomUUID();
    // Real store creates valid metadata; the envelope is then set to frozen PRIOR-codec bytes/digest.
    await store.writeSnapshot({ recordId, revision: 1, capturedAt: '2026-10-12T12:00:00.000Z', displayName: 'Prior opaque source', reason: 'test', origin: { kind: 'untitled', id: randomUUID() }, project: JSON.parse(await fs.readFile(path.resolve('tests/fixtures/projects/routine-canonical-v1.bordeaux'), 'utf8')) });
    const file = path.join(root, recordId + '.json'), envelope = JSON.parse(await fs.readFile(file, 'utf8'));
    envelope.project = JSON.parse(contents); envelope.digest = hash(contents); await fs.writeFile(file, JSON.stringify(envelope));
    const reopened = await new ProjectRecoveryStore(root).readSnapshot(recordId);
    expect(reopened.receipt.digest).toBe(hash(contents)); expect(reopened.project).toEqual(encodeProjectFile(JSON.parse(contents)).project);
    expect(JSON.parse(await fs.readFile(file, 'utf8')).project).toEqual(JSON.parse(contents));
    expect(await store.markResolved(reopened.receipt, { digest: hash(contents), origin: { kind: 'folder', folderPath: root } })).toBe(true);
    expect((await new ProjectRecoveryStore(root).listSnapshots()).entries[0]).toMatchObject({ status: 'available', resolved: { digest: hash(contents), sourceDigest: hash(contents) } });
  });
  it('accepts equivalent reordered schemas in until and output branches without mutating thresholds', () => {
    const schema = { valueType: 'I64', kind: 'integerString' }, stop = { source: 'output', nodeId: 'producer', output: 'count', schema, operator: 'gte', value: '9007199254740993' };
    const producer = command(); producer.outputBranch = { output: 'count', schema, routes: [{ id: 'match', label: 'Match', operator: 'gte', value: '9007199254740993', nodes: [] }, { id: 'otherwise', label: 'Otherwise', operator: 'otherwise', nodes: [] }] };
    const source = routine([loop([producer], stop)]), before = structuredClone(source), catalog = { commands: [{ id: 'Acquire', outputs: [{ name: 'count', schema: { kind: 'integerString', valueType: 'I64' } }] }] };
    expect(AUTO.analyze(source, [], catalog)).toEqual([]); expect(source).toEqual(before);
    catalog.commands[0].outputs[0].schema.valueType = 'U64';
    expect(AUTO.analyze(source, [], catalog).map(issue => issue.code)).toEqual(expect.arrayContaining(['stop-schema-changed', 'output-schema-changed']));
    expect(source).toEqual(before);
  });
});


describe('schema domain agreement', () => {
  it('ignores object key order recursively while preserving array order and meaningful constraints', () => {
    const left = { kind: 'object', valueType: 'Cluster', fields: [{ name: 'count', schema: { kind: 'integerString', valueType: 'I64', min: '9007199254740993', max: '9223372036854775807' } }, { name: 'state', schema: { kind: 'enum', valueType: 'State', enumValues: ['First', 'Second'] } }] };
    const right = { fields: [{ schema: { max: '9223372036854775807', valueType: 'I64', min: '9007199254740993', kind: 'integerString' }, name: 'count' }, { schema: { enumValues: ['First', 'Second'], valueType: 'State', kind: 'enum' }, name: 'state' }], valueType: 'Cluster', kind: 'object' };
    const before = structuredClone([left, right]);
    expect(robotValueSchemasEqual(left, right)).toBe(true); expect([left, right]).toEqual(before);
    const changed = structuredClone(right); changed.fields[0].schema.min = '9007199254740994'; expect(robotValueSchemasEqual(left, changed)).toBe(false);
    changed.fields[0].schema.min = 9007199254740993; expect(robotValueSchemasEqual(left, changed)).toBe(false);
    const enums = structuredClone(right); enums.fields[1].schema.enumValues.reverse(); expect(robotValueSchemasEqual(left, enums)).toBe(false);
    const fields = structuredClone(right); fields.fields.reverse(); expect(robotValueSchemasEqual(left, fields)).toBe(false);
    expect(robotValueSchemasEqual({ kind: 'array', valueType: 'A', element: left }, { element: right, kind: 'array', valueType: 'A' })).toBe(true);
    expect(robotValueSchemasEqual({ kind: 'number', valueType: 'DBL', extra: undefined }, { valueType: 'DBL', kind: 'number' })).toBe(true);
  });
  it('declines malformed/nonfinite/cyclic/excessively nested schema agreement within fixed budgets', () => {
    expect(robotValueSchemasEqual({ kind: ['number'], valueType: 'DBL' }, { kind: 'number', valueType: 'DBL' })).toBe(false);
    expect(robotValueSchemasEqual({ kind: 'array', valueType: 'A' }, { kind: 'array', valueType: 'A' })).toBe(false);
    expect(robotValueSchemasEqual({ kind: 'number', valueType: 'DBL', max: NaN }, { kind: 'number', valueType: 'DBL', max: NaN })).toBe(false);
    const cycle = { kind: 'optional', valueType: 'Option' }; cycle.element = cycle; expect(robotValueSchemasEqual(cycle, cycle)).toBe(false);
    let deep = { kind: 'number', valueType: 'DBL' }; for (let index = 0; index < 66; index++) deep = { kind: 'array', valueType: 'A', element: deep };
    expect(robotValueSchemasEqual(deep, deep)).toBe(false);
    const broad = { kind: 'object', valueType: 'Cluster', fields: Array.from({ length: 5000 }, (_, i) => ({ name: String(i), schema: { kind: 'number', valueType: 'DBL' } })) };
    expect(robotValueSchemasEqual(broad, broad)).toBe(false);
  });
});
