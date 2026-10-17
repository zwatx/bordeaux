import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { createDemoProject } from "../src/shared/project/defaults";
import { autosaveProjectFolder, openProjectFolder } from "../src/electron/projectFiles";
import { projectFolderIdentity, sameProjectFolder } from "../src/electron/projectFolderIdentity";
import { loadProjectSelection } from "../src/electron/projectOpening";
import { completeProjectActivation } from "../src/electron/projectActivation";
import { ProjectActivationFolderChanged } from "../src/electron/projectSourceActions";
import { ProjectSourcePersistence, sameProjectContext } from "../src/electron/projectSourcePersistence";
import { ProjectPersistence } from "../src/electron/projectPersistence";
import { ProjectRecoveryStore } from "../src/electron/projectRecoveryStore";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
it.each(["window", "transition", "activation-preflight"])("fences an old Open after %s ownership changes, before it can redirect autosave", async boundary => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-open-owner-"))); roots.push(root);
  const a = path.join(root, "A"), b = path.join(root, "B"); await fs.mkdir(a); await fs.mkdir(b);
  const projectA = createDemoProject(), projectB = createDemoProject(); projectA.paths[0].name = "A original"; projectB.paths[0].name = "B original";
  await autosaveProjectFolder(a, projectA, null); await autosaveProjectFolder(b, projectB, null);
  const entered = gate(), release = gate(); let epoch = randomUUID(), document = randomUUID(), transition: string | null = "first", held = false;
  const window = () => ({ isDestroyed: () => false, webContents: { isDestroyed: () => false, isCrashed: () => false } });
  const s: Record<string, any> = { fs: { promises: fs }, path, console, mainWindow: window(), projectTargetGeneration: 1,
    currentProjectPath: null, currentProjectFolder: null, currentLegacyFile: null, retiredProjectResume: null, dirty: false,
    projectContext: () => ({ windowEpoch: epoch, documentSessionId: document, targetGeneration: s.projectTargetGeneration }),
    projectFolderIdentity: async (...args: Parameters<typeof projectFolderIdentity>) => {
      const result = await projectFolderIdentity(...args);
      if (boundary === "activation-preflight" && args[0] === a && held) { held = false; entered.resolve(); await release.promise; }
      return result;
    },
    loadProjectSelection: async (selected: string, options: Parameters<typeof loadProjectSelection>[1]) => {
      const result = await loadProjectSelection(selected, options);
      if (selected === a) { if (boundary === "activation-preflight") held = true; else { entered.resolve(); await release.promise; } }
      return result;
    },
    clearLinkedRobotProject() {}, replaceProjectSession: () => { document = randomUUID(); persistence.contextChanged(true); },
    projectLocation: () => ({ folderPath: s.currentProjectFolder, projectPath: s.currentProjectPath }), rememberFile: async () => {}, sameProjectContext, sameProjectFolder, completeProjectActivation, ProjectActivationFolderChanged,
  };
  const source = new ProjectSourcePersistence({ getContext: s.projectContext, commit: (capture, _project, target) => {
    if (s.currentProjectPath !== target) s.activateProjectTarget(target);
    persistence.sourceTargetCommitted(capture.operationId, s.projectContext()); return { context: s.projectContext(), location: s.projectLocation() };
  } });
  const persistence = new ProjectPersistence({ source, recovery: new ProjectRecoveryStore(path.join(root, "recovery")), getContext: s.projectContext, getLocation: s.projectLocation, onUpdate() {} });
  Object.assign(s, { projectSources: source, projectPersistence: persistence });
  persistence.getTransitionId = () => transition;
  const text = await fs.readFile(path.resolve("src/electron/main.ts"), "utf8"), ast = ts.createSourceFile("main.ts", text, ts.ScriptTarget.Latest, true);
  const names = ["captureProjectActivation", "openProjectFile", "assertProjectSourceReadable", "activateProjectSelection", "activateProjectTarget"];
  const extracted = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? "")).map(node => node.getText(ast)).join("\n");
  vm.runInNewContext(ts.transpileModule(extracted, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, s);
  const abandoned = s.openProjectFile(a); const outcome = abandoned.then(() => "activated", () => "rejected"); await entered.promise;
  transition = "replacement";
  if (boundary !== "transition") { epoch = randomUUID(); s.mainWindow = window(); s.activateProjectTarget(null); s.replaceProjectSession(); }
  const shown = await s.openProjectFile(b);
  expect(shown.session).toEqual(persistence.getSession());
  release.resolve(); expect(await outcome).toBe("rejected"); expect(s.projectLocation().folderPath).toBe(b);
  shown.project.paths[0].name = "B edit";
  expect((await persistence.checkpoint({ context: persistence.getSession().context, snapshotRevision: 1, project: shown.project })).source).toBe("saved");
  expect((await openProjectFolder(a)).project?.paths[0].name).toBe("A original");
  expect((await openProjectFolder(b)).project?.paths[0].name).toBe("B edit");
});

it("refuses a physical replacement between exact selection read and actual main activation", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-open-physical-"))); roots.push(root);
  const folder = path.join(root, "Autos"); await fs.mkdir(folder); await autosaveProjectFolder(folder, createDemoProject(), null);
  const selection = await loadProjectSelection(folder);
  await fs.rename(folder, path.join(root, "Archived")); await fs.mkdir(folder); await autosaveProjectFolder(folder, createDemoProject(), null);
  const calls: string[] = [], context = { windowEpoch: randomUUID(), documentSessionId: randomUUID(), targetGeneration: 1 };
  const source = new ProjectSourcePersistence({ getContext: () => context, commit: () => { throw new Error("Activation cannot write source"); } });
  const sandbox: Record<string, any> = { ProjectActivationFolderChanged, projectFolderIdentity, sameProjectFolder, projectSources: source,
    projectPersistence: { admitSource() { calls.push("admit"); } }, clearLinkedRobotProject() { calls.push("robot"); },
    activateProjectTarget() { calls.push("target"); }, replaceProjectSession() { calls.push("session"); } };
  const text = await fs.readFile(path.resolve("src/electron/main.ts"), "utf8"), ast = ts.createSourceFile("main.ts", text, ts.ScriptTarget.Latest, true);
  const actual = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "activateProjectSelection")!;
  vm.runInNewContext(ts.transpileModule(actual.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, sandbox);
  await expect(sandbox.activateProjectSelection(selection, { assertCurrent() {} })).rejects.toThrow("folder changed"); expect(calls).toEqual([]);
});
