import path from "node:path";
import { createHash } from "node:crypto";
import { compareExactDecimals, robotParameterValueError } from "../core/robotCommands";
import type { RobotBuiltInDescriptor, RobotCommandDescriptor, RobotCommandParameter, RobotConditionDescriptor, RobotTrajectoryGeneratorDescriptor, RobotTrajectoryGeneratorLimits, RobotValueSchema } from "../core/types";

const MAX_COMMANDS = 5_000;
const MAX_CONDITIONS = 5_000;
const MAX_PARAMETERS = 256;
const MAX_SCHEMA_DEPTH = 24;
const MAX_OBJECT_FIELDS = 256;
const MAX_ENUM_VALUES = 1_024;
const MAX_TRAJECTORY_GENERATORS = 1_024;
const MAX_GENERATOR_INPUTS = 16;

interface GeneratedRobotCatalog {
  schemaVersion: "1.0" | "1.1" | "1.2" | "1.3";
  catalogId: string;
  supportVersion: string;
  catalogHash: string;
  commands: RobotCommandDescriptor[];
  conditions: RobotConditionDescriptor[];
  builtIns: RobotBuiltInDescriptor[];
  trajectoryGenerators: RobotTrajectoryGeneratorDescriptor[];
}

export const BORDEAUX_WAIT: RobotBuiltInDescriptor = {
  id: "bordeaux.wait",
  kind: "wait",
  label: "Wait",
  description: "Pause the routine before its next step.",
  parameters: [{
    name: "durationS",
    label: "Duration",
    description: "Time to wait before continuing the routine.",
    unit: "s",
    defaultValue: 1,
    min: 0.02,
    max: 15,
    role: "argument",
    valueType: "DBL",
    schema: { kind: "number", valueType: "DBL" },
  }],
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) throw new Error(`Generated Robot catalog ${label} has unexpected field ${unexpected}`);
}

function text(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) throw new Error(`Generated Robot catalog ${label} is invalid`);
  return value;
}

function optionalText(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  return text(value, label, maxLength);
}

function optionalTerms(value: unknown, label: string, kebabCase = false): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 16) throw new Error(`Generated Robot catalog ${label} is invalid`);
  const terms = value.map((item) => text(item, label, 64));
  const normalized = terms.map((item) => item.toLocaleLowerCase("en-US"));
  if (new Set(normalized).size !== terms.length || (kebabCase && terms.some((item) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item)))) {
    throw new Error(`Generated Robot catalog ${label} is invalid`);
  }
  return terms;
}

function finiteOptional(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Generated Robot catalog ${label} must be finite`);
  return value;
}

function exactBound(value: unknown, label: string, integer: boolean): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 128) throw new Error(`Generated Robot catalog ${label} must be a bounded exact decimal string`);
  const pattern = integer ? /^[+-]?\d+$/ : /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
  if (!pattern.test(value)) throw new Error(`Generated Robot catalog ${label} is not a valid exact ${integer ? "integer" : "decimal"}`);
  const exponent = /[eE]([+-]?\d+)$/.exec(value);
  if (exponent && Math.abs(Number(exponent[1])) > 10_000) throw new Error(`Generated Robot catalog ${label} exponent is too large`);
  return value;
}

function parseSchema(raw: unknown, depth = 0): RobotValueSchema {
  if (depth > MAX_SCHEMA_DEPTH) throw new Error(`Generated Robot catalog schema exceeds ${MAX_SCHEMA_DEPTH} levels`);
  const value = record(raw);
  if (!value) throw new Error("Generated Robot catalog parameter schema must be an object");
  const kind = text(value.kind, "schema kind", 32) as RobotValueSchema["kind"];
  if (!["boolean", "integer", "integerString", "decimalString", "number", "string", "enum", "array", "map", "optional", "object", "opaque"].includes(kind)) {
    throw new Error(`Generated Robot catalog schema kind ${kind} is unsupported`);
  }
  if (kind === "opaque") throw new Error("Generated robot bindings cannot expose opaque parameter schemas");
  const schema: RobotValueSchema = { kind, valueType: text(value.valueType, "Robot type", 512) };
  if (kind === "enum") {
    if (!Array.isArray(value.enumValues) || value.enumValues.length === 0 || value.enumValues.length > MAX_ENUM_VALUES) throw new Error("Generated Robot catalog enum values are invalid");
    schema.enumValues = value.enumValues.map((item) => text(item, "enum value", 256));
  }
  if (kind === "array" || kind === "optional") schema.element = parseSchema(value.element, depth + 1);
  if (kind === "map") schema.value = parseSchema(value.value, depth + 1);
  if (kind === "object") {
    if (!Array.isArray(value.fields) || value.fields.length > MAX_OBJECT_FIELDS) throw new Error("Generated Robot catalog object fields are invalid");
    const names = new Set<string>();
    schema.fields = value.fields.map((rawField) => {
      const field = record(rawField);
      if (!field) throw new Error("Generated Robot catalog object field must be an object");
      const name = text(field.name, "field name", 256);
      if (names.has(name)) throw new Error(`Generated Robot catalog object field ${name} is duplicated`);
      names.add(name);
      return { name, schema: parseSchema(field.schema, depth + 1) };
    });
  }
  return schema;
}

function parseParameter(raw: unknown): RobotCommandParameter {
  const value = record(raw);
  if (!value) throw new Error("Generated Robot catalog parameter must be an object");
  const role = text(value.role, "parameter role", 32);
  if (role !== "argument" && role !== "dependency") throw new Error(`Generated Robot catalog parameter role ${role} is unsupported`);
  const parameter: RobotCommandParameter = {
    name: text(value.name, "parameter name", 256),
    valueType: text(value.valueType, "parameter Robot type", 512),
    role,
    schema: parseSchema(value.schema),
  };
  parameter.label = optionalText(value.label, "parameter label", 256);
  parameter.description = optionalText(value.description, "parameter description", 2_048);
  parameter.unit = optionalText(value.unit, "parameter unit", 64);
  const exact = parameter.schema.kind === "integerString" || parameter.schema.kind === "decimalString";
  parameter.min = exact ? exactBound(value.min, "parameter minimum", parameter.schema.kind === "integerString") : finiteOptional(value.min, "parameter minimum");
  parameter.max = exact ? exactBound(value.max, "parameter maximum", parameter.schema.kind === "integerString") : finiteOptional(value.max, "parameter maximum");
  if (typeof parameter.min === "number" && typeof parameter.max === "number" && parameter.min > parameter.max) throw new Error(`Generated Robot catalog parameter ${parameter.name} has an inverted range`);
  if (typeof parameter.min === "string" && typeof parameter.max === "string" && compareExactDecimals(parameter.min, parameter.max) > 0) {
    throw new Error(`Generated Robot catalog parameter ${parameter.name} has an inverted range`);
  }
  if (Object.hasOwn(value, "defaultValue")) {
    const error = robotParameterValueError(value.defaultValue, parameter);
    if (error) throw new Error(`Generated Robot catalog default ${error}`);
    parameter.defaultValue = value.defaultValue as RobotCommandParameter["defaultValue"];
  }
  return parameter;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = record(value);
  if (!object) throw new Error("Generated Robot catalog hash input is not JSON-compatible");
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

export function generatedCatalogHash(commands: unknown, conditions?: unknown, builtIns?: unknown, trajectoryGenerators?: unknown): string {
  const input = trajectoryGenerators !== undefined
    ? { builtIns, commands, conditions, trajectoryGenerators }
    : builtIns === undefined
    ? conditions === undefined ? commands : { commands, conditions }
    : { builtIns, commands, conditions };
  return `sha256:${createHash("sha256").update(canonicalJson(input), "utf8").digest("hex")}`;
}

const GENERATOR_LIMITS: ReadonlyArray<readonly [keyof RobotTrajectoryGeneratorLimits, number, number, boolean]> = [
  ["timeoutMs", 1, 100, true],
  ["maxSamples", 2, 4_096, true],
  ["maxDurationS", 0.02, 15, false],
  ["maxDistanceM", 0, 54, false],
  ["maxVelocityMps", 0, 10, false],
  ["maxAccelerationMps2", 0, 30, false],
  ["maxCentripetalAccelerationMps2", 0, 30, false],
  ["maxAngularVelocityRadps", 0, 25, false],
  ["maxAngularAccelerationRadps2", 0, 100, false],
  ["minClearanceM", 0, 2, false],
];

function parseTrajectoryGenerator(raw: unknown): RobotTrajectoryGeneratorDescriptor {
  const value = record(raw);
  if (!value) throw new Error("Generated Robot catalog trajectory generator must be an object");
  assertExactKeys(value, ["id", "label", "description", "aliases", "semanticTags", "ownerType", "member", "inputs", "preview", "fallbackPolicy", "limits", "source"], "trajectory generator");
  const id = text(value.id, "trajectory generator ID", 256);
  if (!/^[A-Za-z0-9_.:#()$,-]+$/.test(id)) throw new Error(`Generated Robot catalog trajectory generator ID ${id} contains unsupported characters`);
  const aliases = optionalTerms(value.aliases, "trajectory generator aliases");
  const semanticTags = optionalTerms(value.semanticTags, "trajectory generator semantic tags", true);
  for (const [label, terms] of [["aliases", aliases], ["semantic tags", semanticTags]] as const) {
    if (terms && terms.some((term, index) => index > 0 && term <= terms[index - 1])) {
      throw new Error(`Generated Robot catalog trajectory generator ${label} must be sorted and unique`);
    }
  }
  if (!Array.isArray(value.inputs) || value.inputs.length > MAX_GENERATOR_INPUTS) {
    throw new Error(`Generated Robot catalog trajectory generator ${id} cannot declare more than ${MAX_GENERATOR_INPUTS} inputs`);
  }
  let previousInput: string | null = null;
  const inputs = value.inputs.map((rawInput) => {
    const input = record(rawInput);
    if (!input) throw new Error(`Generated Robot catalog trajectory generator ${id} input must be an object`);
    assertExactKeys(input, ["name", "label", "description", "unit", "min", "max", "valueType", "role", "schema"], `trajectory generator ${id} input`);
    const parameter = parseParameter(input);
    if (parameter.role !== "argument" || !["boolean", "enum", "integer", "integerString", "decimalString", "number"].includes(parameter.schema.kind)) {
      throw new Error(`Generated Robot catalog trajectory generator ${id} input ${parameter.name} must be a boolean, enum, or numeric scalar argument`);
    }
    const schema = record(input.schema)!;
    const schemaKeys = parameter.schema.kind === "enum" ? ["kind", "valueType", "enumValues"] : ["kind", "valueType"];
    assertExactKeys(schema, schemaKeys, `trajectory generator ${id} input ${parameter.name} schema`);
    if (parameter.schema.kind === "enum" && parameter.schema.enumValues!.some((enumValue, index, values) => index > 0 && enumValue <= values[index - 1])) {
      throw new Error(`Generated Robot catalog trajectory generator ${id} input ${parameter.name} enum values must be sorted and unique`);
    }
    if (["integer", "integerString", "decimalString", "number"].includes(parameter.schema.kind) && (parameter.min === undefined || parameter.max === undefined)) {
      throw new Error(`Generated Robot catalog trajectory generator ${id} numeric input ${parameter.name} requires a minimum and maximum`);
    }
    if (Object.hasOwn(input, "defaultValue")) throw new Error(`Generated Robot catalog trajectory generator ${id} inputs cannot declare defaults`);
    if (previousInput !== null && parameter.name <= previousInput) throw new Error(`Generated Robot catalog trajectory generator ${id} inputs must be sorted by unique name`);
    previousInput = parameter.name;
    return parameter;
  });
  const preview = record(value.preview);
  if (!preview || preview.kind !== "runtimeDynamic") throw new Error(`Generated Robot catalog trajectory generator ${id} preview must be runtimeDynamic`);
  assertExactKeys(preview, ["kind"], `trajectory generator ${id} preview`);
  const fallbackPolicy = text(value.fallbackPolicy, "trajectory generator fallback policy", 32);
  if (fallbackPolicy !== "safeStopOnly" && fallbackPolicy !== "validatedBranch") throw new Error(`Generated Robot catalog trajectory generator ${id} fallback policy is invalid`);
  const rawLimits = record(value.limits);
  if (!rawLimits) throw new Error(`Generated Robot catalog trajectory generator ${id} limits are required`);
  assertExactKeys(rawLimits, GENERATOR_LIMITS.map(([name]) => name), `trajectory generator ${id} limits`);
  const limits = {} as RobotTrajectoryGeneratorLimits;
  for (const [name, minimum, maximum, integer] of GENERATOR_LIMITS) {
    const limit = rawLimits[name];
    if (typeof limit !== "number" || !Number.isFinite(limit) || (integer && !Number.isInteger(limit)) || limit < minimum || limit > maximum) {
      throw new Error(`Generated Robot catalog trajectory generator ${id} ${name} must be ${integer ? "an integer " : ""}from ${minimum} to ${maximum}`);
    }
    limits[name] = limit;
  }
  const source = record(value.source);
  if (!source) throw new Error(`Generated Robot catalog trajectory generator ${id} source is invalid`);
  assertExactKeys(source, ["file", "line"], `trajectory generator ${id} source`);
  const sourceFile = text(source.file, "trajectory generator source path", 1_024);
  if (path.isAbsolute(sourceFile) || sourceFile.split(/[\\/]/).includes("..")) throw new Error(`Generated Robot catalog trajectory generator source path ${sourceFile} must be relative`);
  if (!Number.isInteger(source.line) || (source.line as number) < 0) throw new Error(`Generated Robot catalog trajectory generator ${id} source line is invalid`);
  return {
    id,
    label: text(value.label, "trajectory generator label", 256),
    description: optionalText(value.description, "trajectory generator description", 2_048),
    aliases,
    semanticTags,
    ownerType: text(value.ownerType, "trajectory generator owner", 512),
    member: text(value.member, "trajectory generator member", 256),
    inputs,
    preview: { kind: "runtimeDynamic" },
    fallbackPolicy,
    limits,
    source: { file: sourceFile, line: (source.line as number) > 0 ? source.line as number : 1 },
  };
}

export function parseGeneratedRobotCatalog(raw: unknown): GeneratedRobotCatalog {
  const value = record(raw);
  const schemaVersion = value?.schemaVersion;
  if (!value || (schemaVersion !== "1.0" && schemaVersion !== "1.1" && schemaVersion !== "1.2" && schemaVersion !== "1.3") || !Array.isArray(value.commands) || value.commands.length > MAX_COMMANDS) {
    throw new Error("Generated Robot catalog must use schema version 1.0, 1.1, 1.2, or 1.3 and contain a bounded commands array");
  }
  const supportVersion = text(value.supportVersion, "support version", 64);
  if (!((schemaVersion === "1.0" && supportVersion === "0.1.0") || (schemaVersion === "1.1" && supportVersion === "0.2.0") || (schemaVersion === "1.2" && supportVersion === "0.3.0") || (schemaVersion === "1.3" && supportVersion === "0.4.0"))) {
    throw new Error(`Generated Robot catalog schema ${schemaVersion} requires its matching supported runtime version`);
  }
  const catalogId = text(value.catalogId, "catalog ID", 256);
  const catalogHash = text(value.catalogHash, "catalog hash", 96);
  if (!/^sha256:[0-9a-f]{64}$/.test(catalogHash)) throw new Error("Generated Robot catalog hash is invalid");
  if (schemaVersion === "1.0" && value.conditions !== undefined) throw new Error("Legacy generated Robot catalog 1.0 cannot declare conditions");
  if (schemaVersion !== "1.0" && (!Array.isArray(value.conditions) || value.conditions.length > MAX_CONDITIONS)) {
    throw new Error(`Generated Robot catalog ${schemaVersion} must contain a bounded conditions array`);
  }
  if (schemaVersion !== "1.2" && schemaVersion !== "1.3" && value.builtIns !== undefined) throw new Error("Generated Robot catalog built-ins require schema 1.2 or newer");
  if ((schemaVersion === "1.2" || schemaVersion === "1.3") && (!Array.isArray(value.builtIns) || canonicalJson(value.builtIns) !== canonicalJson([BORDEAUX_WAIT]))) {
    throw new Error(`Generated Robot catalog ${schemaVersion} must declare the exact Bordeaux-owned built-in capabilities`);
  }
  if (schemaVersion !== "1.3" && value.trajectoryGenerators !== undefined) throw new Error("Generated Robot catalog trajectory generators require schema 1.3");
  if (schemaVersion === "1.3" && (!Array.isArray(value.trajectoryGenerators) || value.trajectoryGenerators.length > MAX_TRAJECTORY_GENERATORS)) throw new Error("Generated Robot catalog 1.3 must contain a bounded trajectoryGenerators array");
  const rawConditions = schemaVersion === "1.0" ? [] : value.conditions as unknown[];
  const rawBuiltIns = schemaVersion === "1.2" || schemaVersion === "1.3" ? value.builtIns as unknown[] : [];
  const rawTrajectoryGenerators = schemaVersion === "1.3" ? value.trajectoryGenerators as unknown[] : [];
  const expectedHash = schemaVersion === "1.0"
    ? generatedCatalogHash(value.commands)
    : schemaVersion === "1.1"
      ? generatedCatalogHash(value.commands, rawConditions)
      : schemaVersion === "1.2"
        ? generatedCatalogHash(value.commands, rawConditions, rawBuiltIns)
        : generatedCatalogHash(value.commands, rawConditions, rawBuiltIns, rawTrajectoryGenerators);
  if (catalogHash !== expectedHash) throw new Error("Generated Robot catalog hash does not match its declared capabilities");
  const ids = new Set<string>();
  const commands = value.commands.map((rawCommand) => {
    const command = record(rawCommand);
    if (!command) throw new Error("Generated Robot catalog command must be an object");
    const id = text(command.id, "command ID", 256);
    if (!/^[A-Za-z0-9_.:#()$,-]+$/.test(id)) throw new Error(`Generated Robot catalog command ID ${id} contains unsupported characters`);
    if (ids.has(id)) throw new Error(`Generated Robot catalog command ID ${id} is duplicated`);
    ids.add(id);
    const kind = text(command.kind, "command kind", 32) as RobotCommandDescriptor["kind"];
    if (kind !== "factory" && kind !== "constructor") throw new Error(`Generated Robot catalog command kind ${kind} is unsupported`);
    const confidence = text(command.confidence, "command confidence", 32) as RobotCommandDescriptor["confidence"];
    if (confidence !== "confirmed" && confidence !== "inferred") throw new Error(`Generated Robot catalog command confidence ${confidence} is unsupported`);
    if (!Array.isArray(command.parameters) || command.parameters.length > MAX_PARAMETERS) throw new Error(`Generated Robot catalog command ${id} has too many parameters`);
    const parameterNames = new Set<string>();
    const parameters = command.parameters.map((item) => {
      const parameter = parseParameter(item);
      if (parameterNames.has(parameter.name)) throw new Error(`Generated Robot catalog command ${id} duplicates parameter ${parameter.name}`);
      parameterNames.add(parameter.name);
      return parameter;
    });
    const source = record(command.source);
    const sourceFile = source && typeof source.file === "string" && source.file.length <= 1_024 ? source.file : "declared in the LabVIEW command catalog";
    if (path.isAbsolute(sourceFile) || sourceFile.split(/[\\/]/).includes("..")) throw new Error(`Generated Robot catalog source path ${sourceFile} must be relative`);
    return {
      id,
      label: text(command.label, "command label", 256),
      description: optionalText(command.description, "command description", 2_048),
      aliases: optionalTerms(command.aliases, "command aliases"),
      semanticTags: optionalTerms(command.semanticTags, "command semantic tags", true),
      ownerType: text(command.ownerType, "command owner", 512),
      member: text(command.member, "command member", 256),
      kind,
      confidence,
      runtimeReady: true,
      parameters,
      source: {
        file: sourceFile,
        line: source && Number.isInteger(source.line) && (source.line as number) > 0 ? source.line as number : 1,
      },
    };
  });
  const conditionIds = new Set<string>();
  let previousConditionId: string | null = null;
  const conditions: RobotConditionDescriptor[] = schemaVersion !== "1.0"
    ? rawConditions.map((rawCondition) => {
      const condition = record(rawCondition);
      if (!condition) throw new Error("Generated Robot catalog condition must be an object");
      const id = text(condition.id, "condition ID", 256);
      if (!/^[A-Za-z0-9_.:#()$,-]+$/.test(id)) throw new Error(`Generated Robot catalog condition ID ${id} contains unsupported characters`);
      if (conditionIds.has(id)) throw new Error(`Generated Robot catalog condition ID ${id} is duplicated`);
      if (ids.has(id)) throw new Error(`Generated Robot catalog capability ID ${id} collides across commands and conditions`);
      if (previousConditionId !== null && id <= previousConditionId) throw new Error("Generated Robot catalog conditions must be sorted by ID");
      conditionIds.add(id);
      previousConditionId = id;
      const source = record(condition.source);
      if (!source) throw new Error(`Generated Robot catalog condition ${id} source is invalid`);
      const sourceFile = text(source.file, "condition source path", 1_024);
      if (path.isAbsolute(sourceFile) || sourceFile.split(/[\\/]/).includes("..")) throw new Error(`Generated Robot catalog condition source path ${sourceFile} must be relative`);
      if (!Number.isInteger(source.line) || (source.line as number) < 0) throw new Error(`Generated Robot catalog condition ${id} source line is invalid`);
      return {
        id,
        label: text(condition.label, "condition label", 256),
        description: optionalText(condition.description, "condition description", 2_048),
        aliases: optionalTerms(condition.aliases, "condition aliases"),
        semanticTags: optionalTerms(condition.semanticTags, "condition semantic tags", true),
        ownerType: text(condition.ownerType, "condition owner", 512),
        member: text(condition.member, "condition member", 256),
        source: { file: sourceFile, line: (source.line as number) > 0 ? source.line as number : 1 },
      };
    })
    : [];
  let previousGeneratorId: string | null = null;
  const trajectoryGenerators = rawTrajectoryGenerators.map((rawGenerator) => {
    const generator = parseTrajectoryGenerator(rawGenerator);
    if (ids.has(generator.id) || conditionIds.has(generator.id)) throw new Error(`Generated Robot catalog capability ID ${generator.id} collides across commands, conditions, and trajectory generators`);
    if (previousGeneratorId !== null && generator.id <= previousGeneratorId) throw new Error("Generated Robot catalog trajectory generators must be sorted by unique ID");
    previousGeneratorId = generator.id;
    return generator;
  });
  return {
    schemaVersion,
    catalogId,
    supportVersion,
    catalogHash,
    commands,
    conditions,
    builtIns: schemaVersion === "1.2" || schemaVersion === "1.3"
      ? [{ ...BORDEAUX_WAIT, parameters: [{ ...BORDEAUX_WAIT.parameters[0], schema: { ...BORDEAUX_WAIT.parameters[0].schema } }] }]
      : [],
    trajectoryGenerators,
  };
}
