import type {
  BordeauxProject,
  CommandArgumentValue,
  CommandInvocation,
  RobotCommandCatalog,
  RobotCommandDescriptor,
  RobotCommandParameter,
  RobotValueSchema,
  ValidationIssue,
} from "./types";
import { activeRoutine } from "./project/routines";

const MAX_SCHEMA_DEPTH = 24;
const MAX_ARRAY_ITEMS = 1_024;
const MAX_MAP_ENTRIES = 256;

function integerRange(valueType: string): readonly [number, number] | null {
  const ranges: Record<string, readonly [number, number]> = {
    I8: [-128, 127], U8: [0, 255], I16: [-32768, 32767], U16: [0, 65535],
    I32: [-2147483648, 2147483647], U32: [0, 4294967295],
  };
  return ranges[valueType] ?? null;
}

function exactIntegerError(value: unknown, valueType: string): string | null {
  if (typeof value !== "string" || !/^[+-]?\d+$/.test(value)) return "must be a whole number written as digits";
  if (value.length > 1_024) return "cannot exceed 1024 characters";
  const ranges: Record<string, readonly [bigint, bigint]> = {
    I64: [-9223372036854775808n, 9223372036854775807n], U64: [0n, 18446744073709551615n], U32: [0n, 4294967295n],
  };
  const range = ranges[valueType];
  const parsed = BigInt(value);
  if (range && (parsed < range[0] || parsed > range[1])) return `must fit the ${valueType === "I64" ? "signed 64-bit" : valueType === "U64" ? "unsigned 64-bit" : "unsigned 32-bit"} range`;
  return null;
}

function exactDecimalError(value: unknown): string | null {
  if (typeof value !== "string" || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) {
    return "must be a decimal number written as text";
  }
  if (value.length > 1_024) return "cannot exceed 1024 characters";
  const exponent = /[eE]([+-]?\d+)$/.exec(value);
  if (exponent && Math.abs(Number(exponent[1])) > 10_000) return "exponent cannot exceed 10000 in magnitude";
  return null;
}

export function compareExactDecimals(left: string, right: string): number {
  const parse = (value: string) => {
    const match = /^([+-])?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(value);
    if (!match) throw new Error("Invalid exact decimal");
    const fraction = match[3] ?? match[4] ?? "";
    const rawDigits = `${match[2] ?? "0"}${fraction}`.replace(/^0+/, "") || "0";
    const exponent = Number(match[5] ?? 0) - fraction.length;
    return { sign: rawDigits === "0" ? 0 : match[1] === "-" ? -1 : 1, digits: rawDigits, exponent };
  };
  const a = parse(left);
  const b = parse(right);
  if (a.sign !== b.sign) return a.sign < b.sign ? -1 : 1;
  if (a.sign === 0) return 0;
  const aPower = a.digits.length + a.exponent;
  const bPower = b.digits.length + b.exponent;
  let magnitude = aPower === bPower ? 0 : aPower < bPower ? -1 : 1;
  if (magnitude === 0) {
    const length = Math.max(a.digits.length, b.digits.length);
    for (let index = 0; index < length; index += 1) {
      const aDigit = a.digits[index] ?? "0";
      const bDigit = b.digits[index] ?? "0";
      if (aDigit !== bDigit) {
        magnitude = aDigit < bDigit ? -1 : 1;
        break;
      }
    }
  }
  return a.sign < 0 ? -magnitude : magnitude;
}

export function robotSchemaValueError(value: unknown, schema: RobotValueSchema, valuePath = "Value", depth = 0): string | null {
  if (depth > MAX_SCHEMA_DEPTH) return `${valuePath} exceeds the supported nesting depth`;
  if (value === undefined) return `${valuePath} is required`;
  if (schema.kind === "opaque") return isJsonValue(value, depth) ? null : `${valuePath} must be JSON-compatible`;
  if (schema.kind === "optional") return value === null ? null : robotSchemaValueError(value, schema.element!, valuePath, depth + 1);
  if (schema.kind === "boolean") return typeof value === "boolean" ? null : `${valuePath} must be true or false`;
  if (schema.kind === "integer") {
    if (!Number.isSafeInteger(value)) return `${valuePath} must be a safe whole number`;
    const range = integerRange(schema.valueType);
    return !range || ((value as number) >= range[0] && (value as number) <= range[1]) ? null : `${valuePath} is outside the range for ${schema.valueType}`;
  }
  if (schema.kind === "integerString") {
    const error = exactIntegerError(value, schema.valueType);
    return error ? `${valuePath} ${error}` : null;
  }
  if (schema.kind === "decimalString") {
    const error = exactDecimalError(value);
    return error ? `${valuePath} ${error}` : null;
  }
  if (schema.kind === "number") return typeof value === "number" && Number.isFinite(value) ? null : `${valuePath} must be a finite number`;
  if (schema.kind === "string") return typeof value === "string" ? null : `${valuePath} must be text`;
  if (schema.kind === "enum") return typeof value === "string" && (schema.enumValues ?? []).includes(value) ? null : `${valuePath} must be one of the discovered enum values`;
  if (schema.kind === "array") {
    if (!Array.isArray(value)) return `${valuePath} must be a JSON array`;
    if (value.length > MAX_ARRAY_ITEMS) return `${valuePath} cannot contain more than ${MAX_ARRAY_ITEMS} items`;
    for (let index = 0; index < value.length; index += 1) {
      const error = robotSchemaValueError(value[index], schema.element!, `${valuePath}[${index}]`, depth + 1);
      if (error) return error;
    }
    return null;
  }
  if (schema.kind === "map") {
    if (!isObject(value)) return `${valuePath} must be a JSON object with string keys`;
    if (Object.keys(value).length > MAX_MAP_ENTRIES) return `${valuePath} cannot contain more than ${MAX_MAP_ENTRIES} entries`;
    for (const [key, item] of Object.entries(value)) {
      const error = robotSchemaValueError(item, schema.value!, `${valuePath}.${key}`, depth + 1);
      if (error) return error;
    }
    return null;
  }
  if (schema.kind === "object") {
    if (!isObject(value)) return `${valuePath} must be a JSON object`;
    const fields = schema.fields ?? [];
    const names = new Set(fields.map((field) => field.name));
    const extra = Object.keys(value).find((key) => !names.has(key));
    if (extra) return `${valuePath}.${extra} is not part of the discovered type`;
    for (const field of fields) {
      const error = robotSchemaValueError(value[field.name], field.schema, `${valuePath}.${field.name}`, depth + 1);
      if (error) return error;
    }
    return null;
  }
  return `${valuePath} uses an unsupported parameter schema`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonValue(value: unknown, depth: number): boolean {
  if (depth > MAX_SCHEMA_DEPTH) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= MAX_ARRAY_ITEMS && value.every((item) => isJsonValue(item, depth + 1));
  return isObject(value) && Object.keys(value).length <= MAX_MAP_ENTRIES && Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

export function defaultRobotSchemaValue(schema: RobotValueSchema, depth = 0): CommandArgumentValue {
  if (depth > MAX_SCHEMA_DEPTH) return null;
  if (schema.kind === "boolean") return false;
  if (schema.kind === "integer" || schema.kind === "number") return 0;
  if (schema.kind === "integerString" || schema.kind === "decimalString") return "0";
  if (schema.kind === "string") return "";
  if (schema.kind === "enum") return schema.enumValues?.[0] ?? "";
  if (schema.kind === "array") return [];
  if (schema.kind === "map" || schema.kind === "opaque") return {};
  if (schema.kind === "optional") return null;
  if (schema.kind === "object") {
    return Object.fromEntries((schema.fields ?? []).map((field) => [field.name, defaultRobotSchemaValue(field.schema, depth + 1)]));
  }
  return null;
}

export function defaultRobotCommandArguments(command: RobotCommandDescriptor): Record<string, CommandArgumentValue> {
  return Object.fromEntries(command.parameters
    .filter((parameter) => parameter.role === "argument")
    .map((parameter) => [
      parameter.name,
      Object.hasOwn(parameter, "defaultValue") ? parameter.defaultValue! : defaultRobotSchemaValue(parameter.schema),
    ]));
}

function parameterLimitError(value: CommandArgumentValue, parameter: RobotCommandParameter): string | null {
  if (parameter.min === undefined && parameter.max === undefined) return null;
  if (parameter.schema.kind === "integerString" && typeof value === "string" && /^[+-]?\d+$/.test(value)) {
    const comparable = BigInt(value);
    if (parameter.min !== undefined && comparable < BigInt(parameter.min)) return `${parameter.name} must be at least ${parameter.min}`;
    if (parameter.max !== undefined && comparable > BigInt(parameter.max)) return `${parameter.name} must be at most ${parameter.max}`;
    return null;
  }
  if (parameter.schema.kind === "decimalString" && typeof value === "string") {
    if (parameter.min !== undefined && compareExactDecimals(value, String(parameter.min)) < 0) return `${parameter.name} must be at least ${parameter.min}`;
    if (parameter.max !== undefined && compareExactDecimals(value, String(parameter.max)) > 0) return `${parameter.name} must be at most ${parameter.max}`;
    return null;
  }
  let comparable: number | null = null;
  if (typeof value === "number" && Number.isFinite(value)) comparable = value;
  else if (typeof value === "string" && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) comparable = Number(value);
  if (comparable === null || !Number.isFinite(comparable)) return null;
  if (parameter.min !== undefined && comparable < Number(parameter.min)) return `${parameter.name} must be at least ${parameter.min}`;
  if (parameter.max !== undefined && comparable > Number(parameter.max)) return `${parameter.name} must be at most ${parameter.max}`;
  return null;
}

export function robotParameterValueError(value: unknown, parameter: RobotCommandParameter): string | null {
  const schemaError = robotSchemaValueError(value, parameter.schema, parameter.label || parameter.name);
  return schemaError ?? parameterLimitError(value as CommandArgumentValue, parameter);
}

export function robotInvocationErrors(invocation: CommandInvocation, command: RobotCommandDescriptor): string[] {
  const errors: string[] = [];
  if (command.runtimeReady !== true) errors.push(command.labviewLegacy
    ? `${command.label} cannot export yet because LabVIEW command execution is not connected`
    : `${command.label} has no generated robot binding; build the command catalog first`);
  return [...errors, ...commandInvocationValueErrors(invocation, command)];
}

/** Validate wire values without granting runtime binding authority. */
export function commandInvocationValueErrors(invocation: CommandInvocation, command: RobotCommandDescriptor): string[] {
  const errors: string[] = [];
  const parameters = command.parameters.filter((parameter) => parameter.role === "argument");
  const names = new Set(parameters.map((parameter) => parameter.name));
  for (const name of Object.keys(invocation.arguments)) {
    if (!names.has(name)) errors.push(`${name} is not a parameter of ${command.label}`);
  }
  for (const parameter of parameters) {
    const value = invocation.arguments[parameter.name];
    const error = robotParameterValueError(value, parameter);
    if (error) errors.push(error);
  }
  return errors;
}

/** Caller owns binding readiness; this validates the complete selected command/graph contract. */
export function validateProjectRobotInvocations(project: BordeauxProject, catalog: RobotCommandCatalog | null, commandErrors = commandInvocationValueErrors): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const commands = new Map((catalog?.commands ?? []).map((command) => [command.id, command]));
  const conditions = new Map((catalog?.conditions ?? []).map((condition) => [condition.id, condition]));
  const trajectoryGenerators = new Map((catalog?.trajectoryGenerators ?? []).map((generator) => [generator.id, generator]));
  const validateCondition = (conditionId: unknown, path: string, usage: string) => {
    if (typeof conditionId !== "string" || !conditionId.trim()) {
      issues.push({ path, message: `${usage} needs a registered condition ID`, severity: "error" });
      return;
    }
    if (!/^[A-Za-z0-9_.:#()$,-]{1,256}$/.test(conditionId)) {
      issues.push({ path, message: `${usage} condition ID is invalid`, severity: "error" });
      return;
    }
    if (catalog?.generatedSchemaVersion !== "1.1" && catalog?.generatedSchemaVersion !== "1.2" && catalog?.generatedSchemaVersion !== "1.3") {
      issues.push({ path, message: `${usage} condition catalog is stale; build generated catalog schema 1.1 or newer before export`, severity: "error" });
      return;
    }
    if (!conditions.has(conditionId)) {
      issues.push({ path, message: `Condition ${conditionId} is not in the linked generated catalog`, severity: "error" });
    }
  };
  project.paths.forEach((path, pathIndex) => path.markers.forEach((marker, markerIndex) => {
    const base = `$.paths[${pathIndex}].markers[${markerIndex}]`;
    if (marker.schedule?.conditionId !== undefined) {
      validateCondition(marker.schedule.conditionId, `${base}.schedule.conditionId`, "Event schedule");
    }
    if (marker.actionIntent && !marker.invocation) {
      issues.push({ path: `${base}.actionIntent`, message: `Action ${marker.actionIntent.semanticTag} is still an intent; bind it to a registered robot command before export`, severity: "error" });
      return;
    }
    if (!marker.invocation && marker.cmd && marker.cmd !== "none") {
      issues.push({ path: `${base}.cmd`, message: `Legacy command ${marker.cmd} must be replaced with a registered robot invocation before export`, severity: "error" });
      return;
    }
    if (!marker.invocation) return;
    const invocationBase = `${base}.invocation`;
    const command = commands.get(marker.invocation.commandId);
    if (!command) {
      issues.push({ path: `${invocationBase}.commandId`, message: `Command ${marker.invocation.commandId} is not in the linked generated catalog`, severity: "error" });
      return;
    }
    if (marker.actionIntent && !command.semanticTags?.includes(marker.actionIntent.semanticTag)) {
      issues.push({
        path: `${base}.actionIntent`,
        message: `Command ${command.label} does not advertise the required ${marker.actionIntent.semanticTag} capability`,
        severity: "error",
      });
    }
    for (const message of commandErrors(marker.invocation, command)) {
      issues.push({ path: invocationBase, message, severity: "error" });
    }
  }));
  // This is the single export boundary for routine nodes. Loading deliberately keeps
  // older and future node shapes intact, while exporting the active routine reports
  // every incompatible branch in one pass instead of failing at the first serializer error.
  const exportablePathIds = new Set(project.paths.filter((path) => path.exportable !== false).map((path) => path.id));
  const routineNodeIds = new Set<string>();
  const registerNodeId = (node: Record<string, unknown>, base: string): void => {
    if (typeof node.id !== "string" || !node.id.trim()) {
      issues.push({ path: `${base}.id`, message: "Routine step needs a stable ID", severity: "error" });
    } else if (routineNodeIds.has(node.id)) {
      issues.push({ path: `${base}.id`, message: `Routine step ID ${node.id} must be globally unique, including fallback branches`, severity: "error" });
    } else {
      routineNodeIds.add(node.id);
    }
  };
  const terminalPathStates = (nodes: unknown[], startsWithPath: boolean): Set<boolean> => {
    let states = new Set([startsWithPath]);
    for (const rawNode of nodes) {
      if (!rawNode || typeof rawNode !== "object" || Array.isArray(rawNode)) continue;
      const node = rawNode as Record<string, unknown>;
      if (node.type === "path") {
        states = new Set([true]);
      } else if (node.type === "decision") {
        const thenNodes = Array.isArray(node.then) ? node.then : [];
        const elseNodes = Array.isArray(node.else) ? node.else : [];
        const outcomes = new Set<boolean>();
        states.forEach((state) => {
          terminalPathStates(thenNodes, state).forEach((outcome) => outcomes.add(outcome));
          terminalPathStates(elseNodes, state).forEach((outcome) => outcomes.add(outcome));
        });
        states = outcomes;
      }
    }
    return states;
  };
  let routineWork = 0;
  const validateRoutineNodes = (nodes: unknown, path: string, fallback?: { count: { value: number; overflow?: boolean }; depth: number }, depth = 0): void => {
    if (depth > 64 || routineWork >= 100000) { issues.push({ path, message: "Routine exceeds supported depth or node budget", severity: "error" }); return; }
    if (!Array.isArray(nodes)) {
      issues.push({ path, message: "Routine branch must be an array of deployable steps", severity: "error" });
      return;
    }
    nodes.forEach((value, index) => {
      const base = `${path}[${index}]`;
      if (++routineWork > 100000) {
        if (routineWork === 100001) issues.push({ path, message: "Routine exceeds supported depth or node budget", severity: "error" });
        return;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        issues.push({ path: base, message: "Routine step is malformed and cannot deploy", severity: "error" });
        return;
      }
      const node = value as Record<string, unknown>;
      if (fallback && fallback.count.value >= 128) {
        if (!fallback.count.overflow) issues.push({ path: base, message: "Generated trajectory fallback cannot exceed 128 nodes", severity: "error" });
        fallback.count.overflow = true;
        return;
      }
      registerNodeId(node, base);
      if (fallback) {
        fallback.count.value += 1;
        if (fallback.depth > 8) issues.push({ path: base, message: "Generated trajectory fallback cannot exceed 8 decision levels", severity: "error" });
      }
      const nodeId = typeof node.id === "string" && node.id ? node.id : "unknown";
      if (node.type === "repeat" || node.type === "end" || node.ends !== undefined) {
        issues.push({ path: base, message: "Routine repeats, end steps, and ending conditions are local authoring and preview only; robot execution support is not available yet", severity: "error" });
      }
      if (node.type === "repeat") { validateRoutineNodes(node.nodes, `${base}.nodes`, fallback, depth + 1); return; }
      if (node.type === "end") return;

      if (node.outputBranch !== undefined) {
        issues.push({ path: `${base}.outputBranch`, message: "Command output branching is available for local authoring and preview only; robot execution support is not available yet", severity: "error" });
        const branch = node.outputBranch as { routes?: Array<{ nodes?: unknown }> };
        if (Array.isArray(branch?.routes)) branch.routes.forEach((route, index) => validateRoutineNodes(route.nodes, `${base}.outputBranch.routes[${index}].nodes`, fallback, depth + 1));
      }
      if (node.type === "path") {
        if (typeof node.ref !== "string" || !exportablePathIds.has(node.ref)) {
          issues.push({ path: `${base}.ref`, message: "Routine path reference must identify an exported path", severity: "error" });
        }
        return;
      }
      if (node.type === "decision") {
        if (fallback && fallback.depth + 1 > 8) issues.push({ path: base, message: "Generated trajectory fallback cannot exceed 8 decision levels", severity: "error" });
        validateCondition(node.cond, `${base}.cond`, `Routine decision ${nodeId}`);
        const childFallback = fallback ? { count: fallback.count, depth: fallback.depth + 1 } : undefined;
        validateRoutineNodes(node.then, `${base}.then`, childFallback, depth + 1);
        validateRoutineNodes(node.else, `${base}.else`, childFallback, depth + 1);
        return;
      }
      if (node.type === "builtin") {
        const argumentsValue = node.arguments;
        const durationS = argumentsValue && typeof argumentsValue === "object" && !Array.isArray(argumentsValue)
          ? (argumentsValue as Record<string, unknown>).durationS : undefined;
        if ((catalog?.generatedSchemaVersion !== "1.2" && catalog?.generatedSchemaVersion !== "1.3")
          || !catalog.builtIns?.some((builtIn) => builtIn.id === "bordeaux.wait" && builtIn.kind === "wait")) {
          issues.push({ path: `${base}.builtinId`, message: "Routine built-ins require generated catalog schema 1.2 with bordeaux.wait before export", severity: "error" });
        }
        if (node.builtinId !== "bordeaux.wait" || !Number.isFinite(durationS) || (durationS as number) < 0.02 || (durationS as number) > 15
          || !argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue) || Object.keys(argumentsValue).length !== 1) {
          issues.push({ path: `${base}.arguments`, message: "Wait must declare only a finite durationS from 0.02 to 15 seconds", severity: "error" });
        }
        return;
      }
      if (node.type === "generatedTrajectory") {
        if (fallback) {
          issues.push({ path: base, message: "Generated trajectory fallback cannot contain a nested generated trajectory", severity: "error" });
          return;
        }
        const unexpected = Object.keys(node).find((key) => !["id", "type", "generatorId", "arguments", "fallback"].includes(key));
        if (unexpected) issues.push({ path: `${base}.${unexpected}`, message: `Generated trajectory step has unsupported free-form field ${unexpected}`, severity: "error" });
        if (catalog?.generatedSchemaVersion !== "1.3" || catalog.supportVersion !== "0.4.0") {
          issues.push({ path: `${base}.generatorId`, message: "Generated trajectories require catalog schema 1.3 with support 0.4.0", severity: "error" });
        }
        const generator = typeof node.generatorId === "string" ? trajectoryGenerators.get(node.generatorId) : undefined;
        if (!generator) {
          issues.push({ path: `${base}.generatorId`, message: `Trajectory generator ${String(node.generatorId)} is not in the linked generated catalog`, severity: "error" });
        }
        const argumentsValue = node.arguments;
        if (!argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) {
          issues.push({ path: `${base}.arguments`, message: "Generated trajectory arguments must be an object", severity: "error" });
        } else if (generator) {
          const argumentRecord = argumentsValue as Record<string, unknown>;
          const names = new Set(generator.inputs.map((input) => input.name));
          Object.keys(argumentRecord).filter((name) => !names.has(name)).forEach((name) =>
            issues.push({ path: `${base}.arguments.${name}`, message: `${name} is not an input of ${generator.label}`, severity: "error" }));
          generator.inputs.forEach((input) => {
            const message = robotParameterValueError(argumentRecord[input.name], input);
            if (message) issues.push({ path: `${base}.arguments.${input.name}`, message, severity: "error" });
          });
        }
        const fallbackValue = node.fallback;
        if (!fallbackValue || typeof fallbackValue !== "object" || Array.isArray(fallbackValue)) {
          issues.push({ path: `${base}.fallback`, message: "Generated trajectory fallback must be safeStop or a validated branch", severity: "error" });
          return;
        }
        const fallbackRecord = fallbackValue as Record<string, unknown>;
        if (fallbackRecord.type === "safeStop") {
          if (Object.keys(fallbackRecord).length !== 1) issues.push({ path: `${base}.fallback`, message: "Safe-stop fallback cannot contain extra fields", severity: "error" });
          if (generator?.fallbackPolicy === "validatedBranch") issues.push({ path: `${base}.fallback`, message: "Generator policy validatedBranch requires an embedded fallback branch", severity: "error" });
        } else if (fallbackRecord.type === "branch") {
          if (Object.keys(fallbackRecord).some((key) => key !== "type" && key !== "nodes")) issues.push({ path: `${base}.fallback`, message: "Fallback branch cannot contain free-form references", severity: "error" });
          if (generator?.fallbackPolicy === "safeStopOnly") issues.push({ path: `${base}.fallback`, message: "Generator policy safeStopOnly does not permit a fallback branch", severity: "error" });
          const branchNodes = fallbackRecord.nodes;
          const count: { value: number; overflow?: boolean } = { value: 0 };
          validateRoutineNodes(branchNodes, `${base}.fallback.nodes`, { count, depth: 0 }, depth + 1);
          if (!count.overflow && Array.isArray(branchNodes) && terminalPathStates(branchNodes, false).has(false)) {
            issues.push({ path: `${base}.fallback.nodes`, message: "Every generated trajectory fallback route must reach an exported static path", severity: "error" });
          }
        } else {
          issues.push({ path: `${base}.fallback.type`, message: "Generated trajectory fallback must be safeStop or a validated branch", severity: "error" });
        }
        return;
      }
      if (node.type !== "function" || node.cat !== "command") {
        issues.push({ path: base, message: "Legacy or unsupported routine step cannot deploy; replace it with a Path, Decision, Command, or Wait", severity: "error" });
        return;
      }
      const invocation = node.invocation;
      if (!invocation || typeof invocation !== "object" || Array.isArray(invocation)) {
        issues.push({ path: `${base}.invocation`, message: "Between-path command must be bound before export", severity: "error" });
        return;
      }
      const invocationArguments = (invocation as Record<string, unknown>).arguments;
      if (!invocationArguments || typeof invocationArguments !== "object" || Array.isArray(invocationArguments)) {
        issues.push({ path: `${base}.invocation.arguments`, message: "Between-path command arguments must be an object", severity: "error" });
        return;
      }
      const typedInvocation = invocation as CommandInvocation;
      const command = commands.get(typedInvocation.commandId);
      if (!command) {
        issues.push({ path: `${base}.invocation.commandId`, message: `Command ${String(typedInvocation.commandId)} is not in the linked generated catalog`, severity: "error" });
        return;
      }
      commandErrors(typedInvocation, command).forEach((message) =>
        issues.push({ path: `${base}.invocation`, message, severity: "error" }));
    });
  };
  const routine = activeRoutine(project);
  if (routine) validateRoutineNodes(routine.nodes, `$.routines[${project.routines.indexOf(routine)}].nodes`);
  return issues;
}
