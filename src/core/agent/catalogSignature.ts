import type {
  CommandArgumentValue,
  RobotCommandCatalog,
  RobotCommandDescriptor,
  RobotCommandParameter,
  RobotValueSchema,
} from "../types";

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedTerms(values: string[] | undefined): string[] {
  return [...new Set(values ?? [])].sort(compareText);
}

function normalizeArgument(value: CommandArgumentValue): CommandArgumentValue {
  if (Array.isArray(value)) return value.map(normalizeArgument);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalizeArgument(value[key])])) as CommandArgumentValue;
}

function semanticSchema(schema: RobotValueSchema): unknown {
  return {
    kind: schema.kind,
    valueType: schema.valueType,
    // The first enum value is the generated default when a parameter has no explicit default.
    enumValues: schema.enumValues ? [...schema.enumValues] : [],
    element: schema.element ? semanticSchema(schema.element) : null,
    value: schema.value ? semanticSchema(schema.value) : null,
    fields: (schema.fields ?? [])
      .map((field) => ({ name: field.name, schema: semanticSchema(field.schema) }))
      .sort((left, right) => compareText(left.name, right.name)),
  };
}

function semanticParameter(parameter: RobotCommandParameter): unknown {
  return {
    name: parameter.name,
    label: parameter.label ?? null,
    description: parameter.description ?? null,
    unit: parameter.unit ?? null,
    defaultValue: Object.hasOwn(parameter, "defaultValue")
      ? { present: true, value: normalizeArgument(parameter.defaultValue ?? null) }
      : { present: false },
    min: parameter.min ?? null,
    max: parameter.max ?? null,
    valueType: parameter.valueType,
    role: parameter.role,
    schema: semanticSchema(parameter.schema),
  };
}

function semanticCommand(command: RobotCommandDescriptor): unknown {
  return {
    id: command.id,
    label: command.label,
    description: command.description ?? null,
    aliases: sortedTerms(command.aliases),
    semanticTags: sortedTerms(command.semanticTags),
    ownerType: command.ownerType,
    member: command.member,
    kind: command.kind,
    confidence: command.confidence,
    runtimeReady: command.runtimeReady === true,
    parameters: command.parameters.map(semanticParameter),
  };
}

/** Canonical semantic content used to bind end-action proposals to a Robot catalog. */
export function robotCatalogSemanticSignature(catalog: RobotCommandCatalog | null): string {
  if (!catalog) return "null";
  const commands = catalog.commands
    .map((command) => ({ command, semantic: semanticCommand(command) }))
    .sort((left, right) => compareText(left.command.id, right.command.id) || compareText(JSON.stringify(left.semantic), JSON.stringify(right.semantic)))
    .map(({ semantic }) => semantic);
  return JSON.stringify({
    authoritative: catalog.authoritative === true,
    catalogId: catalog.catalogId ?? null,
    generatedSchemaVersion: catalog.generatedSchemaVersion ?? null,
    supportVersion: catalog.supportVersion ?? null,
    commands,
  });
}
