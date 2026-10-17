import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { createDemoProject } from "../src/shared/project/defaults";
import { autosaveProjectFolder, projectWorkspacePath, writeBufferAtomically, writeProjectFolderBdx } from "../src/electron/projectFiles";
import { projectFolderIdentity } from "../src/electron/projectFolderIdentity";
import { ProjectSourcePersistence } from "../src/electron/projectSourcePersistence";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const output = (fileName: string, text: string) => ({ fileName, bytes: Buffer.from(text) });

async function fixture() {
  const folder = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-selected-export-"))); roots.push(folder);
  const project = createDemoProject(); await autosaveProjectFolder(folder, project, null);
  await writeProjectFolderBdx(folder, [output("Selected.bdx", "old"), output("Sibling.bdx", "sibling")]);
  const context = { windowEpoch: "window", documentSessionId: "document", targetGeneration: 1 };
  const source = new ProjectSourcePersistence({ getContext: () => context, commit: () => ({ context, location: { folderPath: folder, projectPath: projectWorkspacePath(folder) } }) });
  let target = path.join(folder, "Paths", "Selected.bdx"), review: () => Promise<void> = async () => {};
  let handler!: (_event: unknown, project: unknown, id: string) => Promise<unknown>;
  // Execute the actual IPC listener and writer routing; only native dialogs and compiler bytes are supplied.
  const sandbox = { fs: { promises: fs }, path, createHash, smokeDirectory: null, mainWindow: {}, projectSources: source,
    projectWorkspacePath, projectFolderIdentity, writeBufferAtomically, writeProjectFolderBdx,
    captureLinkedProject: () => ({ isCurrent: () => true, bindingOptions: () => ({ projectFile: null }) }),
    prepareBdxBindings: async () => ({ definitionJson: "fixture" }),
    buildBdxOffThread: async () => ({ fileName: "Selected.bdx", bytes: Buffer.from("explicit"), sha256: "fixture", pathCount: 1, eventCount: 0, sampleCount: 2 }),
    dialog: { showSaveDialog: async () => ({ canceled: false, filePath: target }), showMessageBox: async () => { await review(); return { response: 1 }; } },
    handle: (_channel: string, listener: typeof handler) => { handler = listener; } };
  const text = await fs.readFile(path.resolve("src/electron/main.ts"), "utf8"), ast = ts.createSourceFile("main.ts", text, ts.ScriptTarget.Latest, true);
  const statements = ast.statements.filter(node => ts.isFunctionDeclaration(node)
    ? ["robotExportTargetSnapshot", "writeSelectedProjectBdx"].includes(node.name?.text ?? "")
    : ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(ast) === "handle" && node.expression.arguments[0]?.getText(ast) === '"project:exportBdx"');
  vm.runInNewContext(ts.transpileModule(statements.map(node => node.getText(ast)).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, sandbox);
  return { folder, project, source, export: () => handler(null, project, project.paths[0].id), setTarget: (value: string) => { target = value; }, setReview: (value: typeof review) => { review = value; } };
}

it.each(["existing", "new"])("selected Export into a %s managed output preserves siblings and permits subsequent ordinary Save", async kind => {
  const f = await fixture(), selected = kind === "new" ? "New.bdx" : "Selected.bdx";
  f.setTarget(path.join(f.folder, "Paths", selected));
  expect(await f.export()).toMatchObject({ exported: true });
  expect(await fs.readFile(path.join(f.folder, "Paths", selected), "utf8")).toBe("explicit");
  expect(await fs.readFile(path.join(f.folder, "Paths", "Sibling.bdx"), "utf8")).toBe("sibling");
  f.project.paths[0].waypoints[1].x += 1;
  await autosaveProjectFolder(f.folder, f.project, projectWorkspacePath(f.folder));
  await writeProjectFolderBdx(f.folder, [output(selected, "ordinary save"), output("Sibling.bdx", "sibling")]);
  expect(await fs.readFile(path.join(f.folder, "Paths", selected), "utf8")).toBe("ordinary save");
  expect(await f.source.isBusy(f.folder)).toBe(false);
});

it.each(["before", "during"])("selected Export preserves external changes made %s replacement review", async when => {
  const f = await fixture(), target = path.join(f.folder, "Paths", "Selected.bdx");
  if (when === "before") await fs.writeFile(target, "external");
  else f.setReview(async () => { await fs.writeFile(target, "external"); });
  await expect(f.export()).rejects.toThrow(/changed outside Bordeaux|changed during review/);
  expect(await fs.readFile(target, "utf8")).toBe("external");
  expect(await fs.readFile(path.join(f.folder, "Paths", "Sibling.bdx"), "utf8")).toBe("sibling");
  expect(await f.source.isBusy(f.folder)).toBe(false);
});

it("selected Export respects the project's physical export lease", async () => {
  const f = await fixture(), release = await f.source.holdExport(f.folder);
  try { await expect(f.export()).rejects.toThrow("Folder is busy"); }
  finally { release(); }
  expect(await fs.readFile(path.join(f.folder, "Paths", "Selected.bdx"), "utf8")).toBe("old");
  expect(await f.source.isBusy(f.folder)).toBe(false);
});
