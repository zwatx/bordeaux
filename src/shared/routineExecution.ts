import type { AutonomousRoutine, CommandInvocation, RobotCommandDescriptor, RobotCommandOutput, RobotValueSchema, RoutineCommandOutputBranch, RoutineCommandOutputRoute, RoutineNode, RoutineOutputStop } from './types';
import { commandInvocationValueErrors, compareExactDecimals, robotParameterValueError, robotSchemaValueError } from './robotCommands';
import { robotValueSchemasEqual } from './robotValueSchema';
import { routineChildLists } from './routineChildren';

const numeric = (schema: RobotValueSchema) => ['number', 'integer', 'integerString', 'decimalString'].includes(schema.kind);
const operators = ['eq', 'neq', 'lt', 'lte', 'gt', 'gte'];

function checkComparison(schema: RobotValueSchema, operator: string, value: unknown): void {
  if (!numeric(schema) && !['boolean', 'enum'].includes(schema.kind)) throw new Error('Unsupported comparison output type');
  if (!(numeric(schema) ? operators : ['eq']).includes(operator)) throw new Error('Unsupported output comparison');
  const error = robotSchemaValueError(value, schema, 'Comparison value');
  if (error) throw new Error(error);
  if (schema.valueType === 'SGL' && !Number.isFinite(Math.fround(value as number))) throw new Error('Comparison value is outside the SGL range');
}

/** Exact typed comparisons: no truthiness, string-to-number coercion, or rounded I64/U64 thresholds. */
export function compareCommandOutput(schema: RobotValueSchema, actual: unknown, operator: RoutineOutputStop['operator'], expected: unknown): boolean {
  checkComparison(schema, operator, expected);
  const error = robotSchemaValueError(actual, schema, 'Command output');
  if (error) throw new Error(error);
  if (schema.valueType === 'SGL' && !Number.isFinite(Math.fround(actual as number))) throw new Error('Command output is outside the SGL range');
  const comparison = schema.kind === 'integerString' || schema.kind === 'decimalString'
    ? compareExactDecimals(actual as string, expected as string)
    : actual === expected ? 0 : (actual as number) < (expected as number) ? -1 : 1;
  return ({ eq: comparison === 0, neq: comparison !== 0, lt: comparison < 0, lte: comparison <= 0, gt: comparison > 0, gte: comparison >= 0 })[operator];
}

function checkedOutput(command: RobotCommandDescriptor, name: string, schema: RobotValueSchema): RobotCommandOutput {
  const output = command.outputs?.find(item => item.name === name);
  if (!output || !robotValueSchemasEqual(output.schema, schema)) throw new Error(`${command.label}: command output is missing or its type changed`);
  if (!numeric(schema) && !['boolean', 'enum'].includes(schema.kind)) throw new Error('Unsupported branch output type');
  return output;
}

function checkBranch(branch: RoutineCommandOutputBranch, command: RobotCommandDescriptor): RobotCommandOutput {
  const output = checkedOutput(command, branch.output, branch.schema);
  if (!Array.isArray(branch.routes) || branch.routes.length < 2 || branch.routes.length > 256) throw new Error('Output branch requires 2 to 256 routes');
  const ids = new Set<string>(), values = new Set<unknown>(); let otherwise = 0;
  for (const [index, route] of branch.routes.entries()) {
    if (!route.id?.trim() || ids.has(route.id) || !route.label?.trim() || !Array.isArray(route.nodes)) throw new Error('Invalid output route identity or contents');
    ids.add(route.id);
    if (route.operator === 'otherwise') {
      otherwise++;
      if (index !== branch.routes.length - 1 || route.value !== undefined) throw new Error('Otherwise must be final and have no comparison value');
    } else {
      checkComparison(branch.schema, route.operator, route.value);
      const error = robotParameterValueError(route.value, output);
      if (error) throw new Error(error);
      if (!numeric(branch.schema) && values.has(route.value)) throw new Error('Duplicate output outcome');
      values.add(route.value);
    }
  }
  if (branch.schema.kind === 'boolean' ? otherwise !== 0 || branch.routes.length !== 2 || !values.has(true) || !values.has(false) : otherwise !== 1) throw new Error('Output branch does not cover its outcomes');
  return output;
}

function completedOutput(command: RobotCommandDescriptor, output: RobotCommandOutput, outputs: Record<string, unknown>, context = ''): unknown {
  if (Object.hasOwn(outputs, output.name)) return outputs[output.name];
  if (output.fieldPath?.length) {
    let value: unknown = outputs;
    for (const field of output.fieldPath) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, field)) {
        throw new Error(`${command.label}: completed command did not return ${output.name}${context}`);
      }
      value = (value as Record<string, unknown>)[field];
    }
    return value;
  }
  throw new Error(`${command.label}: completed command did not return ${output.name}${context}`);
}

/** Called only with one completed invocation's outputs. Invalid/missing values never become Otherwise. */
export function selectCommandOutputRoute(branch: RoutineCommandOutputBranch, command: RobotCommandDescriptor, outputs: Record<string, unknown>): RoutineCommandOutputRoute {
  const output = checkBranch(branch, command);
  const value = completedOutput(command, output, outputs), error = robotParameterValueError(value, output);
  if (error) throw new Error(error);
  // Validate before evaluating even an unconditional fallback.
  const schemaError = robotSchemaValueError(value, branch.schema, 'Command output');
  if (schemaError) throw new Error(schemaError);
  const route = branch.routes.find(item => item.operator === 'otherwise' || compareCommandOutput(branch.schema, value, item.operator, item.value));
  if (!route) throw new Error('No output route matched');
  return route;
}

export interface RoutineCommandRequest {
  nodeId: string;
  invocationId: string;
  invocation: CommandInvocation;
  signal: AbortSignal;
}
export interface RoutineCommandCompletion {
  invocationId: string;
  status: 'completed' | 'failed' | 'cancelled' | 'timedOut';
  outputs: Record<string, unknown>;
}
/** Host adapters must await real completion and stop their work when signal aborts.
 * This engine owns no transport and grants no robot deployment capability. */
export interface RoutineExecutionAdapters {
  command(request: RoutineCommandRequest): Promise<RoutineCommandCompletion>;
  path(pathId: string, signal: AbortSignal): Promise<void>;
  wait(durationS: number, signal: AbortSignal): Promise<void>;
}

/** Reject every unsupported/malformed branch before the first host operation. */
function preflight(routine: AutonomousRoutine, commands: Map<string, RobotCommandDescriptor>, paths: ReadonlySet<string>): void {
  const pending = [{ nodes: routine.nodes, depth: 0, repeatDepth: 0 }], ids = new Set<string>(); let count = 0;
  while (pending.length) {
    const frame = pending.pop()!;
    if (!Array.isArray(frame.nodes) || frame.depth > 64) throw new Error('Invalid routine child list or depth');
    for (const node of frame.nodes) {
      if (++count > 100000 || !node?.id?.trim() || ids.has(node.id)) throw new Error('Invalid routine node identity or budget');
      ids.add(node.id);
      if (node.type === 'path') { if (!paths.has(node.ref)) throw new Error('Routine path is unavailable'); }
      else if (node.type === 'builtin') {
        if (node.builtinId !== 'bordeaux.wait' || !Number.isFinite(node.arguments?.durationS) || node.arguments.durationS < .02 || node.arguments.durationS > 15 || Object.keys(node.arguments).length !== 1 || node.ends !== undefined) throw new Error('Unsupported Wait instruction');
      } else if (node.type === 'function' && node.cat === 'command') {
        const command = commands.get(node.invocation?.commandId || '');
        const args = node.invocation?.arguments;
        if (!args || typeof args !== 'object' || Array.isArray(args) || ![Object.prototype, null].includes(Object.getPrototypeOf(args))) throw new Error('Command arguments must be a JSON object');
        if (!command || !node.invocation || commandInvocationValueErrors(node.invocation, command).length || node.ends !== undefined) throw new Error('Command is unavailable, invalid, or has unsupported ending rules');
        if (node.outputBranch) checkBranch(node.outputBranch, command);
      } else if (node.type === 'repeat') {
        if (!Array.isArray(node.nodes) || !node.nodes.length || (node.times === undefined ? node.until?.source !== 'output' : !Number.isInteger(node.times) || node.times < 1 || node.times > 50)) throw new Error('Repeat needs a body and a count or command output stop');
        if (node.until) {
          if (node.until.source !== 'output') throw new Error('Repeat stop must read a command output');
          const stop = node.until, producer = node.nodes.find(child => child.id === stop.nodeId && child.type === 'function' && child.cat === 'command');
          const command = producer?.type === 'function' ? commands.get(producer.invocation?.commandId || '') : undefined;
          if (!command || !stop.schema) throw new Error('Repeat stop needs a command directly inside its body');
          const output = checkedOutput(command, stop.output, stop.schema);
          checkComparison(stop.schema, stop.operator, stop.value);
          const error = robotParameterValueError(stop.value, output); if (error) throw new Error(error);
        }
      } else if (node.type === 'end') {
        if (!['routine', 'repeat'].includes(node.scope)) throw new Error('Invalid end scope');
        if (node.scope === 'repeat' && !frame.repeatDepth) throw new Error('Exit repeat has no enclosing repeat');
      } else throw new Error('Saved conditions and legacy routine steps require migration before execution');
      for (const list of routineChildLists(node)) pending.push({ nodes: list.nodes, depth: frame.depth + 1, repeatDepth: frame.repeatDepth + (node.type === 'repeat' ? 1 : 0) });
    }
  }
}

/** Reference interpreter for the host runtime adapter. Desktop preview never calls this.
 * Each invocation has a fresh ID; each loop pass has a fresh result scope. */
export async function executeRoutine(source: AutonomousRoutine, descriptors: RobotCommandDescriptor[], pathIds: ReadonlySet<string>, host: RoutineExecutionAdapters, signal: AbortSignal): Promise<'completed' | 'ended' | 'cancelled'> {
  const routine = structuredClone(source), commands = new Map(structuredClone(descriptors).map(command => [command.id, command]));
  preflight(routine, commands, pathIds);
  const runId = crypto.randomUUID(); let occurrence = 0, stepsSinceYield = 0;
  const checked = () => { if (signal.aborted) throw new DOMException('Routine cancelled', 'AbortError'); };
  const call = async <T>(work: () => Promise<T>): Promise<T> => {
    checked();
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(new DOMException('Routine cancelled', 'AbortError')); signal.addEventListener('abort', abort, { once: true }); });
    try { const result = await Promise.race([work(), cancelled]); checked(); return result; }
    finally { signal.removeEventListener('abort', abort); }
  };
  type Flow = 'normal' | 'routine' | 'repeat';
  const list = async (nodes: RoutineNode[], results: Map<string, RoutineCommandCompletion>): Promise<Flow> => {
    for (const node of nodes) {
      checked();
      // Immediate adapters still consume time. Bound a pass's uninterrupted work
      // so disable/cancel tasks can run before a large terminal pass completes.
      if (++stepsSinceYield >= 64) { stepsSinceYield = 0; await call(() => new Promise<void>(resolve => setTimeout(resolve, 0))); }
      if (node.type === 'path') await call(() => host.path(node.ref, signal));
      else if (node.type === 'builtin') await call(() => host.wait(node.arguments.durationS, signal));
      else if (node.type === 'end') return node.scope;
      else if (node.type === 'repeat') {
        for (let pass = 0; node.times === undefined || pass < node.times; pass++) {
          const fresh = new Map<string, RoutineCommandCompletion>(), flow = await list(node.nodes, fresh);
          if (flow === 'routine') return flow;
          if (flow === 'repeat') break;
          if (node.until?.source === 'output') {
            const stop = node.until, completion = fresh.get(stop.nodeId);
            if (!completion) throw new Error('Repeat stop has no completed command result from this pass');
            const producer = node.nodes.find(child => child.id === stop.nodeId)!;
            const descriptor = commands.get((producer as Extract<RoutineNode, { type: 'function' }>).invocation!.commandId)!;
            const output = checkedOutput(descriptor, stop.output, stop.schema!), value = completedOutput(descriptor, output, completion.outputs, ' from this pass');
            const error = robotParameterValueError(value, output);
            if (error) throw new Error(error);
            if (compareCommandOutput(stop.schema!, value, stop.operator, stop.value)) break;
          }
          // Yield even for immediate adapters so a dynamic loop can observe disable/cancel.
          await call(() => new Promise<void>(resolve => setTimeout(resolve, 0)));
        }
      } else if (node.type === 'function' && node.cat === 'command') {
        const invocationId = `${runId}:${++occurrence}`;
        const completion = await call(() => host.command({ nodeId: node.id, invocationId, invocation: structuredClone(node.invocation!), signal }));
        if (completion.invocationId !== invocationId || completion.status !== 'completed') throw new Error('Command did not complete successfully for this invocation');
        const owned = structuredClone(completion); results.set(node.id, owned);
        if (node.outputBranch) {
          const route = selectCommandOutputRoute(node.outputBranch, commands.get(node.invocation!.commandId)!, owned.outputs);
          const flow = await list(route.nodes, results); if (flow !== 'normal') return flow;
        }
      }
    }
    return 'normal';
  };
  try {
    const flow = await list(routine.nodes, new Map());
    if (flow === 'repeat') throw new Error('Exit repeat has no enclosing repeat');
    return flow === 'routine' ? 'ended' : 'completed';
  } catch (error) { if (signal.aborted) return 'cancelled'; throw error; }
}
