import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { usedCommandEvidence } from "../src/electron/bdxBindings";

function fixture() {
  const catalog = { commands: [{ id: "start", labviewConnector: { terminalNumbers: [0, 2] } }] };
  const fresh = { id: "start", labviewConnector: { terminalNumbers: [0, 2, 7] } };
  const handlers = new Map();
  const sandbox = {
    assertRobotProjectContext: vi.fn(), linkedLabviewProjectFile: "Robot.lvproj", linkedRobotCatalog: catalog, robotConnectionGeneration: 1,
    handle: (name: string, fn: unknown) => handlers.set(name, fn),
    queueLabviewOperation: (fn: () => Promise<unknown>) => fn(),
    prepareBdxBindings: vi.fn(async () => ({ catalog: { commands: [fresh] }, definitionJson: "validated" })),
    ensureLabviewCommandWrapper: vi.fn(async () => ({ created: true })), labviewDiscoveryCacheDirectory: () => "cache",
    syncLabviewWrapperReferences: vi.fn(async (): Promise<unknown> => ({ file: "Bordeaux Command Wrappers.vi", created: false, updated: false })),
    // Changed commands are read before entering the LabVIEW queue; the comparison covers only the used commands.
    refreshLinkedCommands: vi.fn(async () => null), usedCommandEvidence,
    labviewScriptingUnavailable: (error: Error) => /not already open/.test(error.message),
  };
  const source = ts.createSourceFile("main.ts", fs.readFileSync("src/electron/main.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const statement = source.statements.find(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.arguments[0]?.getText(source) === '"robotProject:ensureWrappers"');
  if (!statement) throw new Error("Missing actual wrapper IPC");
  vm.runInNewContext(ts.transpileModule(statement.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
  return { sandbox, fresh, run: (ids: unknown = ["start"]) => handlers.get("robotProject:ensureWrappers")(null, {}, ids) };
}
it("uses only freshly validated connectors and deduplicates requested command IDs", async () => {
  const f = fixture(); expect(await f.run(["start", "start"])).toEqual({ created: 1 });
  expect(f.sandbox.ensureLabviewCommandWrapper).toHaveBeenCalledExactlyOnceWith("Robot.lvproj", f.fresh, "cache", expect.any(Function), undefined, expect.any(Function));
});
it("rejects a cached command whose source no longer validates before invoking NI", async () => {
  const f = fixture(); f.sandbox.prepareBdxBindings.mockResolvedValue({ catalog: { commands: [] }, definitionJson: "empty" });
  await expect(f.run()).rejects.toThrow("no longer in the linked LabVIEW project"); expect(f.sandbox.ensureLabviewCommandWrapper).not.toHaveBeenCalled();
});
it("rejects stale project generations after validation and before scripting", async () => {
  const f = fixture(); f.sandbox.prepareBdxBindings.mockImplementation(async () => { f.sandbox.robotConnectionGeneration++; return { catalog: { commands: [f.fresh] }, definitionJson: "validated" }; });
  await expect(f.run()).rejects.toThrow("linked robot project changed"); expect(f.sandbox.ensureLabviewCommandWrapper).not.toHaveBeenCalled();
});
it("rejects renderer-provided unknown commands and invalid ID lists", async () => {
  const f = fixture(); await expect(f.run(["unknown"])).rejects.toThrow("Rescan"); await expect(f.run([{}])).rejects.toThrow("known LabVIEW commands");
  expect(f.sandbox.prepareBdxBindings).not.toHaveBeenCalled(); expect(f.sandbox.ensureLabviewCommandWrapper).not.toHaveBeenCalled();
});
it("retains a revalidation callback that rejects changed evidence during scripting", async () => {
  const f = fixture(); await f.run();
  const validate = (f.sandbox.ensureLabviewCommandWrapper.mock.calls as unknown as Array<[unknown, unknown, unknown, unknown, unknown, () => Promise<void>]>)[0][5];
  f.sandbox.prepareBdxBindings.mockResolvedValue({ catalog: { commands: [] }, definitionJson: "empty" });
  await expect(validate()).rejects.toThrow("changed during wrapper creation");
});
it("updates the wrapper references from the whole validated catalog and reports a newly created VI", async () => {
  const f = fixture(); expect(await f.run()).toEqual({ created: 1 });
  expect(f.sandbox.syncLabviewWrapperReferences).toHaveBeenCalledExactlyOnceWith("Robot.lvproj", { commands: [f.fresh] }, "cache", expect.any(Function));
  f.sandbox.syncLabviewWrapperReferences.mockResolvedValue({ file: "Bordeaux Command Wrappers.vi", created: true, updated: true });
  expect(await f.run()).toEqual({ created: 1, referencesCreated: "Bordeaux Command Wrappers.vi" });
  f.sandbox.syncLabviewWrapperReferences.mockResolvedValue(null);
  expect(await f.run()).toEqual({ created: 1 });
});
it("keeps wrapper results when the references VI can't be updated", async () => {
  const f = fixture();
  f.sandbox.syncLabviewWrapperReferences.mockRejectedValue(new Error("The selected project is not already open in LabVIEW."));
  expect(await f.run()).toEqual({ created: 1 });
  f.sandbox.syncLabviewWrapperReferences.mockRejectedValue(new Error("Bordeaux Command Wrappers.vi has unsaved changes in LabVIEW."));
  expect(await f.run()).toEqual({ created: 1, referencesError: "Bordeaux Command Wrappers.vi has unsaved changes in LabVIEW." });
  f.sandbox.syncLabviewWrapperReferences.mockImplementation(async () => { f.sandbox.robotConnectionGeneration++; throw new Error("anything"); });
  await expect(f.run()).rejects.toThrow("linked robot project changed");
});
