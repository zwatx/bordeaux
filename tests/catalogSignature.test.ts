import { describe, expect, it } from "vitest";
import { robotCatalogSemanticSignature } from "../src/core/agent/catalogSignature";
import type { RobotCommandCatalog, RobotCommandDescriptor } from "../src/core/types";

function command(overrides: Partial<RobotCommandDescriptor> = {}): RobotCommandDescriptor {
  return {
    id: "robot.shoot",
    label: "Shoot",
    aliases: ["fire", "shoot"],
    semanticTags: ["score", "shoot-fuel"],
    ownerType: "robot.Actions",
    member: "shoot",
    kind: "factory",
    confidence: "confirmed",
    runtimeReady: true,
    parameters: [{
      name: "options",
      valueType: "robot.ShotOptions",
      role: "argument",
      defaultValue: { rpm: 4000, location: [1, 2] },
      schema: {
        kind: "object",
        valueType: "robot.ShotOptions",
        fields: [
          { name: "rpm", schema: { kind: "number", valueType: "DBL" } },
          { name: "location", schema: { kind: "array", valueType: "double[]", element: { kind: "number", valueType: "DBL" } } },
        ],
      },
    }],
    source: { file: "robot/Actions.vi", line: 10 },
    ...overrides,
  };
}

function catalog(commands = [command()]): RobotCommandCatalog {
  return {
    projectName: "Robot",
    sourceFileCount: 1,
    scannedAt: "2026-08-10T00:00:00.000Z",
    generatedSchemaVersion: "1.0",
    catalogId: "robot-catalog",
    supportVersion: "1.0",
    catalogHash: `sha256:${"a".repeat(64)}`,
    authoritative: true,
    commands,
    warnings: [],
  };
}

describe("Robot catalog semantic signature", () => {
  it("normalizes non-semantic ordering and changes for command invocation semantics", () => {
    const second = command({ id: "robot.intake", label: "Intake", aliases: ["collect"], semanticTags: ["intake-fuel"], parameters: [] });
    const original = catalog([command(), second]);
    const reordered = {
      ...catalog([
        second,
        command({
          aliases: ["shoot", "fire"],
          semanticTags: ["shoot-fuel", "score"],
          parameters: [{
            ...command().parameters[0],
            defaultValue: { location: [1, 2], rpm: 4000 },
            schema: { ...command().parameters[0].schema, fields: [...(command().parameters[0].schema.fields ?? [])].reverse() },
          }],
          source: { file: "moved/Actions.vi", line: 99 },
        }),
      ]),
      scannedAt: "2026-08-10T01:00:00.000Z",
      catalogHash: `sha256:${"b".repeat(64)}`,
      warnings: ["scan-only warning"],
    };
    expect(robotCatalogSemanticSignature(reordered)).toBe(robotCatalogSemanticSignature(original));

    const changedParameter = structuredClone(original);
    changedParameter.commands[0].parameters[0].schema.fields![0].schema.valueType = "float";
    expect(robotCatalogSemanticSignature(changedParameter)).not.toBe(robotCatalogSemanticSignature(original));

    const removedCommand = { ...original, commands: [original.commands[1]] };
    expect(robotCatalogSemanticSignature(removedCommand)).not.toBe(robotCatalogSemanticSignature(original));

    const withoutDefault = catalog([command({ parameters: [{ ...command().parameters[0] }] })]);
    delete withoutDefault.commands[0].parameters[0].defaultValue;
    const explicitObjectDefault = structuredClone(withoutDefault);
    explicitObjectDefault.commands[0].parameters[0].defaultValue = { absent: true };
    expect(robotCatalogSemanticSignature(explicitObjectDefault)).not.toBe(robotCatalogSemanticSignature(withoutDefault));

    const enumParameter = { ...command().parameters[0], defaultValue: undefined, schema: { kind: "enum" as const, valueType: "robot.Mode", enumValues: ["SPEAKER", "AMP"] } };
    delete enumParameter.defaultValue;
    const enumCatalog = catalog([command({ parameters: [enumParameter] })]);
    const reorderedEnum = structuredClone(enumCatalog);
    reorderedEnum.commands[0].parameters[0].schema.enumValues!.reverse();
    expect(robotCatalogSemanticSignature(reorderedEnum)).not.toBe(robotCatalogSemanticSignature(enumCatalog));
  });
});
