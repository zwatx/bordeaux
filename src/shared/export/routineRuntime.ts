import { createHash } from 'node:crypto';
import type { BordeauxProject, CommandInvocation, RoutineNode, RoutineOutputStop } from '../types';
import { commandInvocationValueErrors, robotParameterValueError } from '../robotCommands';
import { preflightRoutine } from '../routineExecution';
import { routineChildLists } from '../routineChildren';
import { binaryFileName, buildRobotBinary, encodeBdxArgument, type BinaryBindings } from './robotBinary';

export const ROUTINE_RUNTIME_SCHEMA = 'bordeaux-routine-runtime/1';
/** Written only when a routine uses a group or a command loop, so robots that read /1 keep reading older files. */
export const ROUTINE_RUNTIME_SCHEMA_V2 = 'bordeaux-routine-runtime/2';
/** `loop` codes in /2 nodes. */
export const RUNTIME_LOOP = { none: 0, time: 1, output: 4 } as const;
export const MAX_ROUTINE_BYTES = 16 * 1024 * 1024;
export interface RuntimeScalar { name: string; terminal: number; niType: string; tag: number; choices: string[] }
export interface RuntimeInput extends RuntimeScalar { valueHex: string }
export interface RuntimeOutput extends RuntimeScalar { fieldPath: string[] }
export interface RuntimeCommand {
  vi: string; statusInput: number; statusOutput: number; statusInputName: string; statusOutputName: string;
  inputs: RuntimeInput[]; outputs: RuntimeOutput[];
}
export interface RuntimeNode {
  id: string; op: number; parent: number; firstChild: number; nextSibling: number;
  path: number; command: number; wait: number; count: number; stop: number;
  /** /2 only, on every node: loop kind (0 none, 1 time, 4 output) and its DBL seconds limit (0 when unused). */
  loop?: number; limit?: number;
}
export interface RuntimeComparison { producer: number; output: number; operator: number; tag: number; valueHex: string }
export interface RoutineRuntimeDocument {
  schema: typeof ROUTINE_RUNTIME_SCHEMA | typeof ROUTINE_RUNTIME_SCHEMA_V2; name: string; catalogHash: string; root: number;
  nodes: RuntimeNode[]; paths: Array<{ name: string; sha256: string; bdxHex: string }>;
  commands: RuntimeCommand[]; comparisons: RuntimeComparison[];
}
/** Saved NI evidence, checked by the host. It does not grant robot readiness. */
export interface RoutineRuntimeBindings {
  binary: BinaryBindings;
  commands: Record<string, Omit<RuntimeCommand, 'inputs'> & { inputs: RuntimeScalar[] }>;
  definitionJson: string;
}
export interface BuiltRoutineRuntime { bytes: Uint8Array; sha256: string; name: string; fileName: string; pathCount: number; nodeCount: number; commandCount: number; document: RoutineRuntimeDocument }
const boundedText = (value: string, label: string) => {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value) > 1024) throw new Error(`${label} must be nonempty text of at most 1024 UTF-8 bytes`);
};
const operations = ['otherwise', 'eq', 'neq', 'lt', 'lte', 'gt', 'gte'];

/** Compile the whole selected graph before producing any publishable file. */
export function buildRoutineRuntime(source: BordeauxProject, routineId: string, bindings: RoutineRuntimeBindings): BuiltRoutineRuntime {
  const project = structuredClone(source);
  const matches = project.routines.filter(item => item.id === routineId);
  if (matches.length !== 1) throw new Error('Selected routine is missing or ambiguous');
  const routine = matches[0]; boundedText(routine.name, 'Routine name');
  const descriptors = new Map(bindings.binary.catalog.commands.map(command => [command.id, command]));
  const materialize = (invocation: CommandInvocation): CommandInvocation => {
    const descriptor = descriptors.get(invocation?.commandId), evidence = bindings.commands[invocation?.commandId];
    if (!descriptor || !evidence) throw new Error('Command lacks inspected scalar NI binding evidence');
    if (!invocation.arguments || typeof invocation.arguments !== 'object' || Array.isArray(invocation.arguments)) throw new Error('Command arguments must be a JSON object');
    if (invocation.cancelOnPathEnd) throw new Error('Routine commands cannot use CancelOnPathEnd');
    const args = { ...invocation.arguments };
    for (const parameter of descriptor.parameters.filter(item => item.role === 'argument')) {
      if (!Object.hasOwn(args, parameter.name)) {
        // No synthetic zero, first-enum-item or empty-string fallback at this boundary.
        if (!Object.hasOwn(parameter, 'defaultValue') || !Object.hasOwn(descriptor.labviewConnector!.defaults, parameter.name)) throw new Error(`${descriptor.label}.${parameter.name}: no inspected saved default; enter an explicit value`);
        args[parameter.name] = structuredClone(parameter.defaultValue!);
      }
    }
    const result = { ...invocation, arguments: args };
    const errors = commandInvocationValueErrors(result, descriptor);
    if (errors.length) throw new Error(errors.join('; '));
    return result;
  };
  const selectedPaths = new Set<string>();
  const pending = [{ nodes: routine.nodes, depth: 0 }]; let budget = 0, extended = false;
  while (pending.length) {
    const frame = pending.pop()!;
    if (frame.depth > 64 || !Array.isArray(frame.nodes)) throw new Error('Routine exceeds supported depth or has invalid children');
    for (const node of frame.nodes) {
      if (++budget > 4096) throw new Error('Routine exceeds 4096 nodes');
      if (node.type === 'path') selectedPaths.add(node.ref);
      if (node.type === 'group' || (node.type === 'function' && node.invocation?.loop !== undefined)) extended = true;
      if (node.type === 'function' && node.cat === 'command') node.invocation = materialize(node.invocation!);
      for (const child of routineChildLists(node)) pending.push({ nodes: child.nodes, depth: frame.depth + 1 });
    }
  }
  preflightRoutine(routine, descriptors, new Set(project.paths.filter(item => item.exportable !== false).map(item => item.id)));
  if (selectedPaths.size > 64) throw new Error('Routine exceeds 64 embedded paths');
  const document: RoutineRuntimeDocument = { schema: extended ? ROUTINE_RUNTIME_SCHEMA_V2 : ROUTINE_RUNTIME_SCHEMA, name: routine.name,
    catalogHash: createHash('sha256').update(bindings.definitionJson).digest('hex'), root: routine.nodes.length ? 0 : -1,
    nodes: [], paths: [], commands: [], comparisons: [] };
  const pathIndices = new Map<string, number>();
  let sampleCount = 0;
  for (const id of selectedPaths) {
    const paths = project.paths.filter(item => item.id === id);
    if (paths.length !== 1) throw new Error('Routine path is missing or ambiguous');
    if (paths[0].markers.some(marker => marker.invocation || marker.commandGroup)) throw new Error(`${paths[0].name}: move path marker commands into routine command steps before exporting a routine; embedded path commands do not yet support routine cancellation`);
    const built = buildRobotBinary(project, { kind: 'path', id }, bindings.binary);
    if (built.sampleCount > 4096 || (sampleCount += built.sampleCount) > 16384) throw new Error('Runtime routine paths support at most 4096 samples per path and 16384 samples total');
    pathIndices.set(id, document.paths.length);
    document.paths.push({ name: built.name, sha256: built.sha256, bdxHex: Buffer.from(built.bytes).toString('hex') });
    if (document.paths.reduce((bytes, item) => bytes + item.bdxHex.length, 0) > MAX_ROUTINE_BYTES) throw new Error('Routine exceeds the 16 MiB runtime file limit');
  }
  const indices = new Map<string, number>(), depths: number[] = [];
  const allocate = (id: string, op: number, parent: number): number => {
    boundedText(id, 'Node ID');
    if (document.nodes.length >= 4096 || indices.has(id)) throw new Error('Routine exceeds 4096 nodes or has duplicate route/node IDs');
    const index = document.nodes.length; indices.set(id, index);
    const depth = parent < 0 ? 0 : depths[parent] + 1;
    if (depth > 64) throw new Error('Routine exceeds flattened depth 64');
    depths.push(depth);
    document.nodes.push({ id, op, parent, firstChild: -1, nextSibling: -1, path: -1, command: -1, wait: 0, count: 0, stop: -1, ...(extended ? { loop: RUNTIME_LOOP.none, limit: 0 } : {}) });
    return index;
  };
  const comparison = (producer: number, command: RuntimeCommand, output: string, operator: string, value: unknown): number => {
    const outputIndex = command.outputs.findIndex(item => item.name === output), binding = command.outputs[outputIndex];
    if (!binding) throw new Error(`Missing inspected output ${output}`);
    const operatorIndex = operations.indexOf(operator);
    if (operatorIndex < 0) throw new Error('Unsupported comparison operator');
    const encoded = operatorIndex ? encodeBdxArgument(binding, value) : { tag: 0, bytes: Buffer.alloc(0) };
    const index = document.comparisons.length;
    document.comparisons.push({ producer, output: outputIndex, operator: operatorIndex, tag: encoded.tag, valueHex: encoded.bytes.toString('hex') });
    return index;
  };
  const list = (nodes: RoutineNode[], parent: number): number => {
    let first = -1, previous = -1;
    for (const node of nodes) {
      const op = node.type === 'path' ? 1 : node.type === 'function' ? 2 : node.type === 'builtin' ? 3 : node.type === 'repeat' ? 4
        : node.type === 'group' ? (node.mode === 'parallel' ? 8 : 9) : node.type === 'end' && node.scope === 'repeat' ? 5 : 6;
      const index = allocate(node.id, op, parent), target = document.nodes[index];
      if (first < 0) first = index;
      if (previous >= 0) document.nodes[previous].nextSibling = index;
      previous = index;
      if (node.type === 'path') target.path = pathIndices.get(node.ref)!;
      else if (node.type === 'builtin') target.wait = node.arguments.durationS;
      else if (node.type === 'function') {
        const evidence = bindings.commands[node.invocation!.commandId], descriptor = descriptors.get(node.invocation!.commandId)!;
        const command: RuntimeCommand = { ...structuredClone(evidence), inputs: evidence.inputs.map(input => {
          const parameter = descriptor.parameters.find(item => item.name === input.name && item.role === 'argument')!;
          const value = node.invocation!.arguments[input.name], error = robotParameterValueError(value, parameter);
          if (error) throw new Error(error);
          const encoded = encodeBdxArgument(input, value);
          return { ...input, tag: encoded.tag, valueHex: encoded.bytes.toString('hex') };
        }) };
        target.command = document.commands.length; document.commands.push(command);
        const until = node.invocation!.loop?.until;
        if (until?.kind === 'time') { target.loop = RUNTIME_LOOP.time; target.limit = until.seconds; }
        else if (until?.kind === 'output') {
          // The looping command is its own producer; preflight already rejected output routes on it.
          target.loop = RUNTIME_LOOP.output;
          target.stop = comparison(index, command, until.output, until.operator, until.value);
        }
        let previousRoute = -1;
        for (const route of node.outputBranch?.routes ?? []) {
          const routeIndex = allocate(route.id, 7, index);
          if (target.firstChild < 0) target.firstChild = routeIndex;
          if (previousRoute >= 0) document.nodes[previousRoute].nextSibling = routeIndex;
          previousRoute = routeIndex;
          document.nodes[routeIndex].stop = comparison(index, command, node.outputBranch!.output, route.operator, route.value);
          document.nodes[routeIndex].firstChild = list(route.nodes, routeIndex);
        }
      } else if (node.type === 'group') {
        target.firstChild = list(node.nodes, index);
      } else if (node.type === 'repeat') {
        target.count = node.times ?? 0; target.firstChild = list(node.nodes, index);
        if (node.until?.source === 'output') {
          const stop = node.until as RoutineOutputStop, producer = indices.get(stop.nodeId)!;
          target.stop = comparison(producer, document.commands[document.nodes[producer].command], stop.output, stop.operator, stop.value);
        }
      }
    }
    return first;
  };
  list(routine.nodes, -1);
  const bytes = Buffer.from(JSON.stringify(document), 'utf8');
  if (bytes.length > MAX_ROUTINE_BYTES) throw new Error('Routine exceeds the 16 MiB runtime file limit');
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), document, name: routine.name,
    fileName: binaryFileName(routine.name).replace(/\.bdx$/, '.bdr'), pathCount: document.paths.length, nodeCount: document.nodes.length, commandCount: document.commands.length };
}
