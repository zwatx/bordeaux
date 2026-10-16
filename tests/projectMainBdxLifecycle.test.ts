import { loadProjectSelection } from "../src/electron/projectOpening";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectSourcePersistence } from "../src/electron/projectSourcePersistence";
import { ProjectPersistence } from "../src/electron/projectPersistence";
import { ProjectRecoveryStore } from "../src/electron/projectRecoveryStore";
import { ProjectBdxChangedError } from "../src/electron/projectBdxExport";
import { createDemoProject } from "../src/shared/project/defaults";
import { validateProjectSource } from "../src/shared/validation";
import { openProjectFolder, projectWorkspacePath, writeProjectFolderBdx } from "../src/electron/projectFiles";
const roots: string[] = [];
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
it.each(["first-bindings", "worker", "second-bindings"])("actual extracted main Save fences %s before any BDX write while retaining successful source", async phase => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-main-bdx-"))); roots.push(root);
  const folder = path.join(root, "Autos"); await fs.mkdir(folder);
  let context = { windowEpoch: randomUUID(), documentSessionId: randomUUID(), targetGeneration: 1 }, location = { folderPath: folder, projectPath: null as string | null };
  const entered = gate(), release = gate(); let bindings = 0, workers = 0, writers = 0; let workerSignal: AbortSignal | undefined;
  // Inject only passive binding/worker boundaries. Production source, recovery, lease and folder writer are unchanged.
  const sandbox: Record<string, any> = { validateProjectSource, ProjectBdxChangedError, projectTargetGeneration: 1, projectContext: () => context, compatibilitySnapshotRevision: 0,
    currentLegacyFile: null, currentProjectPath: null, currentProjectFolder: folder, smokeDirectory: null, path, projectWorkspacePath, openProjectFolder,
    robotConnectionGeneration: 0, linkedLabviewProjectFile: null, linkedRobotProjectBookmarkId: null, labviewDiscoveryCacheDirectory: () => path.join(root, "cache"), MAX_BDX_BATCH: 64,
    prepareBdxBindings: async () => { bindings++; if ((phase === "first-bindings" && bindings === 1) || (phase === "second-bindings" && bindings === 2)) { entered.resolve(); await release.promise; } return { definitionJson: "fixture" }; },
    buildBdxBatchOffThread: async (_job: unknown, signal: AbortSignal) => { workers++; workerSignal = signal; if (phase === "worker") { entered.resolve(); await release.promise; } return [{ fileName: "Fixture.bdx", bytes: new Uint8Array([1]) }]; },
    writeProjectFolderBdx: async (...args: Parameters<typeof writeProjectFolderBdx>) => { writers++; return writeProjectFolderBdx(...args); } };
  let persistence!: ProjectPersistence;
  const source = new ProjectSourcePersistence({ getContext: () => context, commit: (capture, _project, target) => {
    context = { ...context, targetGeneration: context.targetGeneration + 1 }; location = { folderPath: folder, projectPath: target };
    sandbox.projectTargetGeneration = context.targetGeneration; sandbox.currentProjectPath = target;
    persistence.sourceTargetCommitted(capture.operationId, context); return { context, location };
  } });
  const recovery = new ProjectRecoveryStore(path.join(root, "recovery"));
  persistence = new ProjectPersistence({ source, recovery, getContext: () => context, getLocation: () => location, onUpdate: () => undefined, exportLimits: { phaseMs: 50, batchMs: 50 } });
  persistence.admitSource(context, (await loadProjectSelection(folder)).sourceEvidence);
  Object.assign(sandbox, { projectSources: source, projectPersistence: persistence });
  const text = await fs.readFile(path.resolve("src/electron/main.ts"), "utf8"), ast = ts.createSourceFile("main.ts", text, ts.ScriptTarget.Latest, true);
  for (const name of ["exportSaved", "captureBinding", "saveProjectWithSourceCheckpoint"]) {
    const statement = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)!;
    vm.runInNewContext(ts.transpileModule(statement.getText(ast), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
  }
  vi.useFakeTimers(); const project = createDemoProject(); project.paths[0].name = "Saved source";
  const pending = sandbox.saveProjectWithSourceCheckpoint(project, false); await entered.promise;
  expect(persistence.getSession().latestSource).toBeDefined(); expect((await openProjectFolder(folder)).project?.paths[0].name).toBe("Saved source");
  await vi.advanceTimersByTimeAsync(51); expect(await pending).toMatchObject({ saved: true, location: { folderPath: folder }, exportDetails: { code: "timed-out", partial: false } });
  expect(await source.isBusy(folder)).toBe(true); if (workerSignal) expect(workerSignal.aborted).toBe(true);
  const sourceReceipt = persistence.getSession().latestSource;
  release.resolve(); await source.whenExportsSettled(); expect(writers).toBe(0); expect(workers).toBe(phase === "first-bindings" ? 0 : 1);
  expect(persistence.getSession().latestSource).toEqual(sourceReceipt); expect(await source.isBusy(folder)).toBe(false);
});
