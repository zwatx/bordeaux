import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { expect, it } from "vitest";
import type { RobotCommandCatalog, RobotCommandDescriptor } from "../src/core/types";

// Exercise the production join without making its internal helper a public API.
const text = fs.readFileSync("src/electron/labviewNiInspection.ts", "utf8");
const ast = ts.createSourceFile("inspection.ts", text, ts.ScriptTarget.Latest, true);
const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "merge");
if (!node) throw new Error("Missing production catalog merge");
const merge = vm.runInNewContext(ts.transpileModule(`${node.getText(ast)}; merge;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText) as (catalog: RobotCommandCatalog, inspected: RobotCommandDescriptor[], inspection: object) => RobotCommandCatalog;
const command = (id: string, member = "Drive/Start.vi") => ({ id, member, label: id,
  parameters: [{ name: "speed", role: "argument", schema: { kind: "number" } }],
  labviewConnector: { file: member }, outputs: [{ name: "done" }],
}) as RobotCommandDescriptor;
const catalog = (commands: RobotCommandDescriptor[]): RobotCommandCatalog => ({ projectName: "Fixture", sourceFileCount: 0,
  scannedAt: "2026-11-07T00:00:00Z", commands, warnings: [], labviewDiscovery: {
    projectFile: "Robot.lvproj", targets: [], items: [], viCount: 0, truncated: false,
    commandContract: { kind: "legacy-status-pair", status: "requires-declaration", description: "Fixture" },
  },
});

it("keeps declared order and IDs while matching normalized members and appending new commands", () => {
  const declared = [command("declared", "DRIVE\\Start.vi"), command("untouched", "Other.vi")];
  const inspected = [command("extra", "Extra.vi"), command("ni")];
  const result = merge(catalog(declared), inspected, { status: "available" });
  expect(result.commands.map(item => item.id)).toEqual(["declared", "untouched", "extra"]);
  expect(result.commands[0].labviewConnector).toEqual(inspected[1].labviewConnector);
  expect(result.commands[1]).toBe(declared[1]);
});

it("refuses ambiguous VI matches and strips prior connector evidence", () => {
  const result = merge(catalog([command("declared")]), [command("one"), command("two", "DRIVE\\Start.vi")], {});
  expect(result.commands).toHaveLength(1);
  expect(result.commands[0].labviewConnector).toBeUndefined();
  expect(result.warnings.join(" ")).toContain("unambiguous inspected VI");
});

it("refuses duplicate argument names even when argument counts agree", () => {
  const declared = command("declared"), inspected = command("ni");
  declared.parameters.push({ ...declared.parameters[0], name: "other" });
  inspected.parameters.push({ ...inspected.parameters[0] });
  expect(merge(catalog([declared]), [inspected], {}).commands[0].labviewConnector).toBeUndefined();
});

it("retains schema comparison independent of object key order", () => {
  const declared = command("declared"), inspected = command("ni");
  declared.parameters[0].schema = { kind: "number", valueType: "DBL" };
  inspected.parameters[0].schema = { valueType: "DBL", kind: "number" };
  expect(merge(catalog([declared]), [inspected], {}).commands[0].labviewConnector).toBeDefined();
  inspected.parameters[0].schema.valueType = "SGL";
  expect(merge(catalog([declared]), [inspected], {}).commands[0].labviewConnector).toBeUndefined();
});
