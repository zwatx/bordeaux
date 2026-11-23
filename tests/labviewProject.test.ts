import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildLabviewCatalog, compileLabviewCatalog, discoverLabviewProject, isLabviewProject, safeLabviewPath } from "../src/electron/labviewProject";
import { parseGeneratedRobotCatalog } from "../src/electron/robotGeneratedCatalog";
import { rememberRobotProject, readRobotProjectBookmarks, writeRobotProjectBookmarks } from "../src/electron/robotProjectBookmarks";
import { createDemoProject } from "../src/core/project/defaults";
import { buildRobotTrajectory } from "../src/core/export/robotTrajectory";
import { robotInvocationErrors } from "../src/core/robotCommands";

const dirs: string[] = [];
async function temp() { const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-labview-"))); dirs.push(dir); return dir; }
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });
function source() { return { schemaVersion: "bordeaux-labview-catalog/1", catalogId: "team-robot", commands: [{ id: "shoot", label: "Shoot", vi: "Commands/Shoot.vi", semanticTags: ["shoot-fuel"], parameters: [
  { name: "count", schema: { kind: "integerString" }, defaultValue: "9007199254740993", min: "1", max: "9223372036854775807" },
  { name: "target", schema: { kind: "object", fields: [{ name: "enabled", schema: { kind: "optional", element: { kind: "boolean" } } }] }, defaultValue: { enabled: null } },
] }], conditions: [{ id: "loaded", label: "Loaded", vi: "Conditions/Loaded.vi" }], trajectoryGenerators: [] }; }
async function fixture() {
  const root = await temp(); await fs.writeFile(path.join(root, "Robot.lvproj"), "<Project/>"); await fs.mkdir(path.join(root, "Commands")); await fs.mkdir(path.join(root, "Conditions")); await fs.writeFile(path.join(root, "Commands/Shoot.vi"), "VI fixture bytes"); await fs.writeFile(path.join(root, "Conditions/Loaded.vi"), "VI fixture bytes"); await fs.writeFile(path.join(root, "bordeaux-catalog.json"), JSON.stringify(source())); return root;
}
describe("LabVIEW declarative catalog", () => {
  it("preserves exact unsigned integers and explicit floating point types", () => {
    const declaration = {
      schemaVersion: "bordeaux-labview-catalog/1", catalogId: "numeric-types",
      commands: [{ id: "numbers", label: "Numbers", vi: "Numbers.vi", parameters: [
        { name: "big", schema: { kind: "integerString", exactIntegerType: "U64" }, defaultValue: "18446744073709551615" },
        { name: "single", schema: { kind: "number", numberType: "SGL" }, defaultValue: 1.5 },
      ] }],
    };
    const result = compileLabviewCatalog(declaration);
    expect(result.runtimeConfig.commands[0].parameters.big.valueType).toBe("U64");
    expect(result.runtimeConfig.commands[0].parameters.single.valueType).toBe("SGL");
    declaration.commands[0].parameters[1].schema.numberType = "half";
    expect(() => compileLabviewCatalog(declaration)).toThrow(/numberType/);
    declaration.commands[0].parameters[1].schema.numberType = "SGL";
    declaration.commands[0].parameters[0].schema.exactIntegerType = "I64";
    expect(() => compileLabviewCatalog(declaration)).toThrow(/64-bit/);
  });
  it("uses the shared catalog identity and preserves exact values and nested schemas", () => {
    const result = compileLabviewCatalog(source());
    expect(parseGeneratedRobotCatalog(result.document).catalogHash).toBe(result.catalog.catalogHash);
    expect(result.catalog.commands[0].parameters[0].defaultValue).toBe("9007199254740993");
    expect(result.runtimeConfig.commands[0].parameters.count).toMatchObject({ kind: "integerString", valueType: "I64", min: "1" });
    expect(result.runtimeConfig.commands[0].parameters.target.fields?.[0].schema.element?.kind).toBe("boolean");
    expect(robotInvocationErrors({ commandId: "shoot", arguments: { count: "0", target: { enabled: null } } }, result.catalog.commands[0])).toContain("count must be at least 1");
  });
  it("rejects ambiguous, unbounded and invalid declarations", () => {
    const raw = source(); raw.commands.push(raw.commands[0]); expect(() => compileLabviewCatalog(raw)).toThrow(/duplicated/);
    expect(() => compileLabviewCatalog({ ...source(), script: "do not execute" })).toThrow(/unknown field/);
    const traversal = source(); traversal.commands[0].vi = "../Outside.vi"; expect(() => compileLabviewCatalog(traversal)).toThrow(/relative/);
    const badDefault = source(); badDefault.commands[0].parameters[0].defaultValue = "9223372036854775808"; expect(() => compileLabviewCatalog(badDefault)).toThrow(/64-bit/);
    const malformed = source(); malformed.commands[0].parameters[0].schema = { kind: "number", element: { kind: "boolean" } } as never; expect(() => compileLabviewCatalog(malformed)).toThrow(/unknown field/);
  });
  it("keeps source preview unready until build, then detects stale declarations and restores bookmarks", async () => {
    const root = await fixture(); expect(await isLabviewProject(root)).toBe(true);
    expect((await discoverLabviewProject(root)).authoritative).toBe(false);
    await buildLabviewCatalog(root); const built = await discoverLabviewProject(root); expect(built.authoritative).toBe(true); expect(built.runtime).toBe("labview");
    const bookmarks = rememberRobotProject([], root, "Robot"); const file = path.join(await temp(), "bookmarks.json"); await writeRobotProjectBookmarks(file, bookmarks);
    const restored = await readRobotProjectBookmarks(file); expect((await discoverLabviewProject(restored[0].projectPath)).catalogHash).toBe(built.catalogHash);
    const changed = source(); changed.commands[0].label = "Shoot again"; await fs.writeFile(path.join(root, "bordeaux-catalog.json"), JSON.stringify(changed)); expect((await discoverLabviewProject(root)).authoritative).toBe(false);
  });
  it("exports LabVIEW commands and conditions through the shared trajectory contract", async () => {
    const root = await fixture(); await buildLabviewCatalog(root); const catalog = await discoverLabviewProject(root);
    const project = createDemoProject();
    project.paths[0].markers = [{ id: "event", f: 0.5, name: "Shoot", cmd: "shoot", invocation: { commandId: "shoot", arguments: { count: "9007199254740993", target: { enabled: null } } }, schedule: { conditionId: "loaded" } }];
    const exported = buildRobotTrajectory(project, catalog).document;
    expect(exported.catalog.catalogHash).toBe(catalog.catalogHash);
    expect(JSON.stringify(exported)).toContain("9007199254740993");
    project.paths[0].markers[0].invocation!.commandId = "missing";
    expect(() => buildRobotTrajectory(project, catalog)).toThrow(/not in the linked generated catalog/);
  });
  it("invalidates compiled bindings when a VI changes and rejects missing handlers", async () => {
    const root = await fixture(); await buildLabviewCatalog(root);
    await fs.writeFile(path.join(root, "Commands/Shoot.vi"), "changed VI");
    expect((await discoverLabviewProject(root)).authoritative).toBe(false);
    await fs.rm(path.join(root, "Commands/Shoot.vi")); await expect(buildLabviewCatalog(root)).rejects.toThrow(/ENOENT/);
    await fs.writeFile(path.join(root, "bordeaux-catalog.json"), '{"schemaVersion":"bordeaux-labview-catalog/1","commands":[],"commands":[]}');
    await expect(discoverLabviewProject(root)).rejects.toThrow(/duplicate JSON key commands/);
  });
  it("links an empty LabVIEW project without creating support files", async () => {
    const root = await temp(); await fs.writeFile(path.join(root, "Robot.lvproj"), "<Project/>");
    expect((await discoverLabviewProject(root)).commands).toEqual([]);
    expect(await fs.readdir(root)).toEqual(["Robot.lvproj"]);
  });
  it("rejects symlinked source and output directories", async () => {
    const root = await fixture(); const outside = await temp(); await fs.symlink(outside, path.join(root, "bordeaux"), "dir"); await expect(buildLabviewCatalog(root)).rejects.toThrow(/regular/);
    await expect(safeLabviewPath(root, "../escape.json", true)).rejects.toThrow(/inside/);
    await expect(safeLabviewPath(root, "bordeaux\\escape.json", true)).rejects.toThrow(/inside/);
  });
});
