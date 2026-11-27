import { describe, expect, it } from 'vitest';
import { buildRoutineRuntime } from '../src/core/export/routineRuntime';
import { buildRobotBinary, encodeBdxArgument } from '../src/core/export/robotBinary';
import { routineBindingsFromBinary, routineEvidenceSnapshot } from '../src/electron/routineBindings';
import { routineRuntimeFixture } from './fixtures/routineRuntimeFixture';
import { routineCommandIds } from '../src/electron/routineSelection';
import type { RoutineNode } from '../src/core/types';
import { buildWaypoints } from '../src/core/project/defaults';

describe('self-contained runtime routine compiler', () => {
  it.each([false, true])('embeds exact standalone position-follow bytes (mixed modes: %s)', mixed => {
    const f = routineRuntimeFixture(), path = f.project.paths[0];
    path.followMode = 'position';
    path.waypoints = buildWaypoints([
      { x: 2, y: 2, segType: 'line', ...(mixed ? { segmentFollowMode: 'time' as const } : {}) },
      { x: 4, y: 2, segType: 'line' },
      { x: 6, y: 2, stop: true, wait: .1 },
    ]);
    f.project.routines[0].nodes = [{ id: 'path', type: 'path', ref: path.id }];
    const original = structuredClone(f.project);
    const standalone = buildRobotBinary(f.project, { kind: 'path', id: path.id }, f.binary);
    expect(standalone.document.paths[0].followSections.map(section => section.mode)).toEqual(mixed ? ['time', 'position', 'time'] : ['position', 'position', 'time']);
    const built = buildRoutineRuntime(f.project, 'routine', f.bindings);
    expect(built.document.schema).toBe('bordeaux-routine-runtime/1');
    expect(built.document.paths).toEqual([{ name: standalone.name, sha256: standalone.sha256, bdxHex: Buffer.from(standalone.bytes).toString('hex') }]);
    expect(built.document.nodes[0]).toMatchObject({ op: 1, path: 0 });
    expect(f.project).toEqual(original);
  });
  it('rejects a degenerate position section before producing a routine file', () => {
    const f = routineRuntimeFixture(), path = f.project.paths[0];
    path.followMode = 'position';
    path.waypoints = buildWaypoints([{ x: 2, y: 2, segType: 'line' }, { x: 2, y: 2 }]);
    f.project.routines[0].nodes = [{ id: 'path', type: 'path', ref: path.id }];
    expect(() => buildRoutineRuntime(f.project, 'routine', f.bindings)).toThrow(/position-follow segment 1/);
  });
  it('does not request NI evidence for a command-free selected graph or unrelated drafts', () => {
    const f = routineRuntimeFixture();
    f.project.routines[0].nodes = [{ id: 'path', type: 'path', ref: f.project.paths[0].id }, { id: 'wait', type: 'builtin', builtinId: 'bordeaux.wait', arguments: { durationS: .02 } }];
    f.project.routines.push({ id: 'draft', name: 'Unrelated command', nodes: [{ id: 'unrelated', type: 'function', cat: 'command', invocation: f.invocation() }] });
    expect(routineCommandIds(f.project, 'routine').size).toBe(0);
    expect([...routineCommandIds(f.project, 'draft')]).toEqual([f.command.id]);
  });
  it('rejects real embedded trajectories beyond per-path and total runtime sample budgets', () => {
    const f = routineRuntimeFixture(), path = f.project.paths[0];
    path.constraints.maxVel = .02;
    f.project.routines[0].nodes = [{ id: 'path', type: 'path', ref: path.id }];
    expect(buildRobotBinary(f.project, { kind: 'path', id: path.id }, f.binary).sampleCount).toBeGreaterThan(4096);
    expect(() => buildRoutineRuntime(f.project, 'routine', f.bindings)).toThrow(/4096 samples per path/);
    path.constraints.maxVel = .05;
    expect(buildRobotBinary(f.project, { kind: 'path', id: path.id }, f.binary).sampleCount).toBeLessThanOrEqual(4096);
    f.project.paths = Array.from({ length: 6 }, (_, index) => ({ ...structuredClone(path), id: `path-${index}` }));
    f.project.routines[0].nodes = f.project.paths.map(item => ({ id: item.id, type: 'path', ref: item.id }));
    expect(() => buildRoutineRuntime(f.project, 'routine', f.bindings)).toThrow(/16384 samples total/);
  });
  it('emits a fixed-shape preorder graph with exact paths, explicit saved defaults and typed routes/repeat stops', () => {
    const f = routineRuntimeFixture(), schema = f.command.outputs![0].schema;
    f.project.routines[0].nodes = [{ id: 'path', type: 'path', ref: f.project.paths[0].id },
      { id: 'loop', type: 'repeat', times: 3, until: { source: 'output', nodeId: 'command', output: 'Result', schema, operator: 'gte', value: '18446744073709551615' }, nodes: [
        { id: 'command', type: 'function', cat: 'command', invocation: f.invocation(), outputBranch: { output: 'Result', schema, routes: [
          { id: 'hit', label: 'Maximum', operator: 'eq', value: '18446744073709551615', nodes: [{ id: 'exit', type: 'end', scope: 'repeat' }] },
          { id: 'else', label: 'Otherwise', operator: 'otherwise', nodes: [{ id: 'wait', type: 'builtin', builtinId: 'bordeaux.wait', arguments: { durationS: .02 } }] },
        ] } },
      ] }, { id: 'end', type: 'end', scope: 'routine' }];
    const original = structuredClone(f.project), built = buildRoutineRuntime(f.project, 'routine', f.bindings), d = built.document;
    expect(f.project).toEqual(original);
    expect(d.nodes.map(item => [item.id, item.op, item.parent, item.firstChild, item.nextSibling])).toEqual([
      ['path', 1, -1, -1, 1], ['loop', 4, -1, 2, 7], ['command', 2, 1, 3, -1], ['hit', 7, 2, 4, 5], ['exit', 5, 3, -1, -1], ['else', 7, 2, 6, -1], ['wait', 3, 5, -1, -1], ['end', 6, -1, -1, -1],
    ]);
    const standalone = buildRobotBinary(f.project, { kind: 'path', id: f.project.paths[0].id }, f.binary);
    expect(d.paths[0].bdxHex).toBe(Buffer.from(standalone.bytes).toString('hex'));
    expect(d.commands[0]).toMatchObject({ vi: 'Inspect.vi', statusInput: 8, statusOutput: 0, statusInputName: 'Info In', statusOutputName: 'Info Out',
      inputs: [{ name: 'Sequence', terminal: 11, tag: 8, valueHex: '7fffffffffffffff' }, { name: 'Enabled', tag: 1, valueHex: '01' }, { name: 'Mode', tag: 14, valueHex: '0001' }] });
    expect(d.commands[0].outputs[1]).toMatchObject({ fieldPath: ['Info Out', 'Status'], niType: 'EW', tag: 14, choices: ['Successful', 'Aborted', 'Incomplete'] });
    expect(d.comparisons).toEqual([{ producer: 2, output: 0, operator: 1, tag: 9, valueHex: 'ffffffffffffffff' }, { producer: 2, output: 0, operator: 0, tag: 0, valueHex: '' }, { producer: 2, output: 0, operator: 6, tag: 9, valueHex: 'ffffffffffffffff' }]);
    expect(d.nodes.every(item => Object.keys(item).length === 10)).toBe(true);
    expect(JSON.parse(Buffer.from(built.bytes).toString('utf8'))).toEqual(d);
    expect(built.fileName).toBe('Typed-runtime-routine.bdr');
    expect(JSON.stringify(d)).not.toMatch(/runtimeReady|commandId|labview\.legacy|C:\\\\Test/);
  });
  it('reinitializes complete inputs for each command invocation and retains output-only repeats', () => {
    const f = routineRuntimeFixture(), schema = f.command.outputs![0].schema;
    f.project.routines[0].nodes = [{ id: 'loop', type: 'repeat', until: { source: 'output', nodeId: 'a', output: 'Result', schema, operator: 'eq', value: '0' }, nodes: [
      { id: 'a', type: 'function', cat: 'command', invocation: { ...f.invocation(), arguments: { Enabled: false, Sequence: '-9223372036854775808' } } },
      { id: 'b', type: 'function', cat: 'command', invocation: f.invocation() },
    ] }];
    const d = buildRoutineRuntime(f.project, 'routine', f.bindings).document;
    expect(d.nodes[0].count).toBe(0); expect(d.nodes[0].stop).toBe(0);
    expect(d.commands[0].inputs[0].valueHex).toBe('8000000000000000');
    expect(d.commands[0].inputs[1].valueHex).toBe('00'); expect(d.commands[1].inputs[1].valueHex).toBe('01');
  });
  it('compiles Boolean exhaustive routes and named completion-status enum outcomes', () => {
    const f = routineRuntimeFixture(), raw = f.command.labviewConnector!;
    raw.terminalNumbers.push(13); raw.directions.push(1); raw.requirements.push(1); raw.captions.push('Ready');
    raw.typeXml.push('<Boolean><Name>Ready</Name></Boolean>'); raw.extendedInfo.push([[]]);
    const booleanSchema = { kind: 'boolean' as const, valueType: 'Boolean' };
    f.command.outputs!.push({ name: 'Ready', schema: booleanSchema, terminalNumber: 13 });
    const status = f.command.outputs![1];
    f.project.routines[0].nodes = [{ id: 'a', type: 'function', cat: 'command', invocation: f.invocation(), outputBranch: { output: 'Ready', schema: booleanSchema, routes: [
      { id: 'true', label: 'Ready', operator: 'eq', value: true, nodes: [{ id: 'b', type: 'function', cat: 'command', invocation: f.invocation(), outputBranch: { output: status.name, schema: status.schema, routes: [
        { id: 'success', label: 'Successful', operator: 'eq', value: 'Successful', nodes: [] }, { id: 'other-status', label: 'Otherwise', operator: 'otherwise', nodes: [] },
      ] } }] }, { id: 'false', label: 'Not ready', operator: 'eq', value: false, nodes: [] },
    ] } }];
    const document = buildRoutineRuntime(f.project, 'routine', routineBindingsFromBinary(f.binary)).document;
    expect(document.comparisons.map(item => [item.operator, item.tag, item.valueHex])).toEqual([[1, 1, '01'], [1, 14, '0000'], [0, 0, ''], [1, 1, '00']]);
    const commandNode = f.project.routines[0].nodes[0];
    if (commandNode.type !== 'function') throw new Error('Expected command fixture');
    commandNode.outputBranch!.routes.pop();
    expect(() => buildRoutineRuntime(f.project, 'routine', routineBindingsFromBinary(f.binary))).toThrow(/2 to 256 routes/);
  });
  it('retains saved branch routes and only exports controller sources used by a comparison', () => {
    const f = routineRuntimeFixture();
    const name = 'Very cool condition Out', schema = { kind: 'boolean' as const, valueType: 'Boolean' };
    f.command.outputs!.push({ name, schema, labviewControllerBoolean: true });
    f.project.routines[0].nodes = [
      { id: 'a', type: 'function', cat: 'command', invocation: f.invocation(), outputBranch: { output: name, schema, routes: [
        { id: 'true', label: 'True', operator: 'eq', value: true, nodes: [] },
        { id: 'false', label: 'False', operator: 'eq', value: false, nodes: [] },
      ] } },
      { id: 'b', type: 'function', cat: 'command', invocation: f.invocation() },
      { id: 'repeat', type: 'repeat', times: 2, until: { source: 'output', nodeId: 'c', output: name, schema, operator: 'eq', value: true }, nodes: [
        { id: 'c', type: 'function', cat: 'command', invocation: f.invocation() },
      ] },
    ];
    const { commands, nodes, comparisons } = buildRoutineRuntime(f.project, 'routine', routineBindingsFromBinary(f.binary)).document;
    expect(nodes.map((node) => node.id)).toEqual(['a', 'true', 'false', 'b', 'repeat', 'c']);
    expect(comparisons.map(({ producer, output, valueHex }) => [producer, output, valueHex])).toEqual([[0, 2, '01'], [0, 2, '00'], [5, 2, '01']]);
    expect(commands.map((command) => command.outputs.find((output) => output.name === name)?.terminal)).toEqual([-1, undefined, -1]);
  });
  it('bounds the complete node graph and rejects invalid scalar input/default evidence', () => {
    const f = routineRuntimeFixture();
    f.project.routines[0].nodes = Array.from({ length: 4097 }, (_, i) => ({ id: String(i), type: 'end', scope: 'routine' }));
    expect(() => buildRoutineRuntime(f.project, 'routine', f.bindings)).toThrow(/4096 nodes/);
    f.command.labviewConnector!.defaults.Sequence = '1';
    expect(() => routineBindingsFromBinary(f.binary)).toThrow(/saved default evidence changed/);
    const unsupported = routineRuntimeFixture();
    unsupported.command.labviewConnector!.typeXml[2] = '<Cluster><Name>Sequence</Name><NumElts>0</NumElts></Cluster>';
    expect(() => routineBindingsFromBinary(unsupported.binary)).toThrow(/schema disagrees/);
  });
  it.each([
    { id: 'old', type: 'decision', conditionId: 'legacy', then: [], else: [] },
    { id: 'generated', type: 'generatedTrajectory' },
    { id: 'exit', type: 'end', scope: 'repeat' },
    { id: 'wait', type: 'builtin', builtinId: 'bordeaux.wait', arguments: { durationS: 0 } },
  ])('rejects the entire artifact for unsupported or malformed instruction $type', raw => {
    const f = routineRuntimeFixture(); f.project.routines[0].nodes = [raw as RoutineNode];
    expect(() => buildRoutineRuntime(f.project, 'routine', f.bindings)).toThrow();
  });
  it('rejects missing saved defaults, changed output schemas and ambiguous VI basenames', () => {
    const f = routineRuntimeFixture(); f.project.routines[0].nodes = [{ id: 'a', type: 'function', cat: 'command', invocation: f.invocation() }];
    delete f.command.parameters[0].defaultValue;
    expect(() => buildRoutineRuntime(f.project, 'routine', f.bindings)).toThrow(/no inspected saved default/);
    const other = routineRuntimeFixture(); other.binary.catalog.commands.push({ ...other.command, id: 'collision', labviewConnector: { ...other.command.labviewConnector!, file: 'Other/Inspect.vi' } });
    expect(routineBindingsFromBinary(other.binary).commands).toEqual({});
    const typed = routineRuntimeFixture(); typed.command.outputs![0].schema.valueType = 'I64';
    expect(() => routineBindingsFromBinary(typed.binary)).toThrow(/schema disagrees/);
    const duplicate = routineRuntimeFixture(); duplicate.binary.catalog.commands.push({ ...duplicate.command, labviewConnector: { ...duplicate.command.labviewConnector!, file: 'Other.vi' } });
    expect(() => routineBindingsFromBinary(duplicate.binary)).toThrow(/command ID is ambiguous/);
  });
  it('rejects path marker commands in routines while preserving standalone BDX event export', () => {
    const f = routineRuntimeFixture(); f.project.paths[0].markers = [{ id: 'event', name: 'Command event', f: .5, invocation: { ...f.invocation(), arguments: { Sequence: '1', Enabled: true, Mode: 'Active' } } }];
    f.project.routines[0].nodes = [{ id: 'path', type: 'path', ref: f.project.paths[0].id }];
    expect(() => buildRoutineRuntime(f.project, 'routine', f.bindings)).toThrow(/move path marker commands into routine command steps/);
    expect(buildRobotBinary(f.project, { kind: 'path', id: f.project.paths[0].id }, f.binary).eventCount).toBe(1);
  });
  it('uses output and lifecycle evidence in revalidation, separate from BDX input provenance', () => {
    const f = routineRuntimeFixture(), before = routineEvidenceSnapshot(f.binary);
    f.command.outputs![0].terminalNumber = 13;
    expect(routineEvidenceSnapshot(f.binary)).not.toBe(before);
    expect(Buffer.from(encodeBdxArgument({ niType: 'DBL' }, 1).bytes).toString('hex')).toBe('3ff0000000000000');
  });
});
