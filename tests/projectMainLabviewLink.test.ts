import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createHash, randomUUID } from "node:crypto";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";
import * as links from "../src/electron/projectLabviewLink";
import * as bookmarks from "../src/electron/robotProjectBookmarks";
import { resolveLabviewProject, statLabviewLocalPath } from "../src/electron/labviewProjectDiscovery";
import { discoverLabviewProject, LABVIEW_CATALOG_SOURCE } from "../src/electron/labviewProject";
import { robotCatalogSemanticSignature } from "../src/shared/agent/catalogSignature";
import { sameProjectContext, canonicalProjectDigest, ProjectSourcePersistence } from "../src/electron/projectSourcePersistence";
import { ProjectPersistence } from "../src/electron/projectPersistence";
import { ProjectRecoveryStore } from "../src/electron/projectRecoveryStore";
import { ProjectDepartureCoordinator } from "../src/electron/projectDeparture";
// @ts-expect-error The renderer lifecycle is a JavaScript module.
import { createPersistenceQueue, createCheckpointChannel, checkpointMatch } from "../src/renderer/lib/projectLifecycle";
import { withRobotLink } from "../src/renderer/lib/projectRobotLink";
import { createDemoProject } from "../src/shared/project/defaults";
import { autosaveProjectFolder, openProjectFolder, projectWorkspacePath } from "../src/electron/projectFiles";
import { loadProjectSelection } from "../src/electron/projectOpening";
import { projectWriteFactFromMessage } from "../src/shared/project/writeErrors";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.promises.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), "bordeaux-main-link-"))); roots.push(root);
  const folder = path.join(root, "repo", "PathsProject"); await fs.promises.mkdir(folder, { recursive: true });
  const file = path.join(folder, "Robot.lvproj"); await fs.promises.writeFile(file, "<Project/>");
  let context = { windowEpoch: randomUUID(), documentSessionId: randomUUID(), targetGeneration: 1 };
  const handlers = new Map<string, (...args: any[]) => any>();
  const sandbox: Record<string, any> = {
    ...links, ...bookmarks, fs, path, createHash, randomUUID, console, Error, Object,
    resolveLabviewProject, statLabviewLocalPath, robotCatalogSemanticSignature, LABVIEW_CATALOG_SOURCE, sameProjectContext,
    projectContext: () => ({ ...context, targetGeneration: sandbox.projectTargetGeneration }), currentProjectFolder: folder, projectTargetGeneration: 1,
    currentProjectPath: projectWorkspacePath(folder), currentLegacyFile: null, recentFiles: [], rememberFile: vi.fn(async () => {}),
    currentRobotEditor: { labviewProjectPath: "Robot.lvproj" }, linkedRobotContext: null, suggestedRobotProject: null,
    linkedRobotProjectPath: null, linkedLabviewProjectFile: null, linkedRobotProjectBookmarkId: null, linkedRobotCatalog: null,
    robotConnectionGeneration: 0, robotProjectBookmarks: [],
    projectSources: { revalidateExports: vi.fn() }, agentSessions: { refreshRobotCatalog: vi.fn() },
    robotProjectBookmarksFile: () => path.join(root, "bookmarks.json"), labviewDiscoveryCacheDirectory: () => path.join(root, "cache"),
    discoverRobotProject: vi.fn(discoverLabviewProject),
    withCachedLabviewCommands: vi.fn(async (_selection, catalog) => catalog),
    syncLabviewCommands: vi.fn(() => { throw new Error("Automatic restoration must not inspect NI"); }),
    handle: (channel: string, listener: (...args: any[]) => any) => handlers.set(channel, listener),
    autosaveProjectFolder,
  };
  // Execute the real main functions/IPC listeners and write hook, not a copied implementation.
  const text = await fs.promises.readFile("src/electron/main.ts", "utf8"), ast = ts.createSourceFile("main.ts", text, ts.ScriptTarget.Latest, true);
  const evaluate = (text: string) => vm.runInNewContext(ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, sandbox);
  for (const name of ["readableRobotProjectError", "activateProjectTarget", "clearLinkedRobotProject", "rememberLinkedRobotProject", "assertRobotProjectContext", "linkedProjectMatches", "connectRobotProject", "replaceRobotProject", "rememberExplicitRobotLink", "restoreProjectRobotCode", "captureLinkedProject", "exportSaved"]) {
    const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (!node) throw new Error(`Missing actual main function ${name}`);
    evaluate(node.getText(ast));
  }
  for (const statement of ast.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
    const call = statement.expression;
    if (call.expression.getText(ast) === "handle" && ts.isStringLiteral(call.arguments[0]) && ["robotProject:restore", "robotProject:useSuggested", "robotProject:link", "robotProject:refresh", "robotProject:buildCatalog"].includes(call.arguments[0].text)) evaluate(statement.getText(ast));
  }
  const declaration = ast.statements.flatMap(node => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : []).find(node => node.name.getText(ast) === "projectSources");
  const initializer = declaration?.initializer;
  if (!initializer || !ts.isNewExpression(initializer) || !initializer.arguments?.[0] || !ts.isObjectLiteralExpression(initializer.arguments[0])) throw new Error("Missing actual source persistence configuration");
  const write = initializer.arguments[0].properties.find(node => ts.isPropertyAssignment(node) && node.name.getText(ast) === "write");
  if (!write || !ts.isPropertyAssignment(write)) throw new Error("Missing actual source write hook");
  evaluate(`globalThis.writeSource = ${write.initializer.getText(ast)};`);
  const commit = initializer.arguments[0].properties.find(node => ts.isPropertyAssignment(node) && node.name.getText(ast) === "commit");
  if (!commit || !ts.isPropertyAssignment(commit)) throw new Error("Missing actual source commit hook");
  evaluate(`globalThis.commitSource = ${commit.initializer.getText(ast)};`);
  sandbox.projectLocation = () => ({ folderPath: sandbox.currentProjectFolder, projectPath: sandbox.currentProjectPath });
  const activate = (nextFolder = folder, editor = { labviewProjectPath: "Robot.lvproj" }) => {
    sandbox.clearLinkedRobotProject(); context = { ...context, documentSessionId: randomUUID(), targetGeneration: context.targetGeneration + 1 };
    sandbox.currentProjectFolder = nextFolder; sandbox.currentRobotEditor = editor; sandbox.projectTargetGeneration = context.targetGeneration;
  };
  return { root, folder, file, sandbox, handlers, activate, get context() { return sandbox.projectContext() as typeof context; } };
}

it("adopts a modeled Link selection before the queued departure saves and grants an exact receipt", async () => {
  // Actual main/App/departure callbacks and storage; modeled dialog completion, no native UI claim.
  const f = await fixture(), project = createDemoProject(); project.name = "Before Link selection"; project.editor = {};
  f.sandbox.currentRobotEditor = {};
  await autosaveProjectFolder(f.folder, project, projectWorkspacePath(f.folder), { createProject: true });
  const selection = await loadProjectSelection(projectWorkspacePath(f.folder), { requireSource: true });
  const initial = (await openProjectFolder(f.folder)).project!;
  let location = { folderPath: f.folder, projectPath: projectWorkspacePath(f.folder) };
  let publish: (update: any) => void = () => {}, persistence!: ProjectPersistence;
  const recovery = new ProjectRecoveryStore(path.join(f.root, "departure-recovery"));
  const source = new ProjectSourcePersistence({ getContext: () => f.context, write: f.sandbox.writeSource,
    commit: (capture, saved, target) => { const result = f.sandbox.commitSource(capture, saved, target); location = result.location; return result; } });
  persistence = new ProjectPersistence({ source, recovery, getContext: () => f.context, getLocation: () => location, onUpdate: update => publish(update) });
  f.sandbox.projectSources = source; f.sandbox.projectPersistence = persistence;
  persistence.admitSource(f.context, selection.sourceEvidence, selection.legacyFile);
  const sender = {}, permits: any[] = [];
  const coordinator = new ProjectDepartureCoordinator({ getContext: () => f.context, getTransitionId: () => null,
    isRendererAlive: epoch => epoch === f.context.windowEpoch, isTrustedSender: value => value === sender,
    onRequest() {}, onCheckpoint: update => persistence.handleDepartureUpdate(update),
    onCancelled: id => persistence.handleDepartureCancelled(id), onContinue: permit => permits.push(permit),
    onFallback: vi.fn(), onDismissFallback() {}, onReopen() {} });
  persistence.attachDepartureCoordinator(coordinator);
  let completeSelection!: (value: any) => void, pickerStarted!: () => void;
  const picker = new Promise(resolve => { completeSelection = resolve; }), began = new Promise<void>(resolve => { pickerStarted = resolve; });
  f.sandbox.smokeDirectory = null; f.sandbox.mainWindow = {};
  f.sandbox.dialog = { showOpenDialog: vi.fn(() => { pickerStarted(); return picker; }) };
  const checkpointProject = vi.fn(request => persistence.checkpoint(request));
  const channel = createCheckpointChannel({ onProjectCheckpoint: (listener: typeof publish) => { publish = listener; return () => { publish = () => {}; }; } });
  const queue = createPersistenceQueue(), capture = vi.fn(() => ({ materialized: structuredClone(renderer.projectRef.current) }));
  const deps: any = { current: { enqueue: queue.enqueue, capture, checkpointTargetReady: () => true, nextRevision: () => 1, channel,
    stayedCurrent: (captured: any) => canonicalProjectDigest(captured.materialized) === canonicalProjectDigest(renderer.projectRef.current),
    api: { checkpointProject, respondProjectDeparture: async (response: any) => ({ accepted: coordinator.respond(sender, response) }) },
    applySavedSource: vi.fn(), sourceFailed: vi.fn() } };
  const renderer: Record<string, any> = { useCallback: (fn: any) => fn, withRobotLink, checkpointMatch, deps,
    persistenceQueue: queue, robotRestoreGeneration: { current: 0 }, sessionContext: { current: f.context },
    projectRef: { current: structuredClone(initial) }, robotProjectState: { status: "unlinked" },
    window: { bordeauxAPI: { linkRobotProject: (context: unknown) => f.handlers.get("robotProject:link")!(null, context) } },
    setExportError() {}, operationErrorMessage: (error: Error) => error.message,
    active: { current: null }, release: vi.fn(), choose: vi.fn(), update() {} };
  renderer.setProject = (value: any) => { renderer.projectRef.current = value; };
  renderer.setRobotProjectState = (value: any) => { renderer.robotProjectState = typeof value === "function" ? value(renderer.robotProjectState) : value; };
  // Extract callback bodies from their production declarations, as in the adjacent main ownership tests.
  for (const [file, names] of [
    ["src/renderer/app/App.jsx", ["applyRobotProjectConnection", "linkRobotProject"]],
    ["src/renderer/hooks/useProjectDeparture.js", ["reply", "receiptReply", "advance", "checkpoint", "approve", "drain"]],
  ] as const) {
    const text = await fs.promises.readFile(file, "utf8"), ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
    for (const name of names) {
      let declaration: ts.VariableDeclaration | undefined;
      const visit = (node: ts.Node) => { if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) declaration = node; ts.forEachChild(node, visit); };
      visit(ast); if (!declaration?.initializer) throw new Error(`Missing actual ${name}`);
      vm.runInNewContext(ts.transpileModule(`globalThis.${name} = ${declaration.initializer.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, renderer);
    }
  }
  try {
    renderer.projectRef.current.paths[0].waypoints[0].x = 11.17;
    const linking = renderer.linkRobotProject(); await began;
    const request = coordinator.request("close")!;
    expect(coordinator.respond(sender, { ...request, outcome: "draining" })).toBe(true);
    const entry = { request, phase: "draining" }; renderer.active.current = entry;
    const departing = renderer.drain(entry);
    await Promise.resolve();
    expect(capture).not.toHaveBeenCalled(); expect(checkpointProject).not.toHaveBeenCalled(); expect(permits).toEqual([]);
    expect(canonicalProjectDigest((await openProjectFolder(f.folder)).project!)).toBe(canonicalProjectDigest(initial));

    completeSelection({ canceled: false, filePaths: [f.file] }); await linking; await departing;
    expect(renderer.robotProjectState.status).toBe("ready");
    expect(capture).toHaveBeenCalledTimes(1); expect(checkpointProject).toHaveBeenCalledTimes(1);
    expect(checkpointProject.mock.calls[0][0].project.editor).toEqual({ labviewProjectPath: "Robot.lvproj" });
    expect(renderer.choose).not.toHaveBeenCalled(); expect(renderer.release).not.toHaveBeenCalled();
    expect(deps.current.sourceFailed).not.toHaveBeenCalled(); expect(permits).toHaveLength(1);
    const permit = permits[0], disk = (await openProjectFolder(f.folder)).project!;
    expect(disk.paths[0].waypoints[0].x).toBe(11.17); expect(disk.editor).toEqual({ labviewProjectPath: "Robot.lvproj" });
    expect(permit.basis).toBe("source"); expect(permit.request.requestId).toBe(request.requestId);
    expect(permit.receipt.digest).toBe(canonicalProjectDigest(disk));
    expect(permit.receipt.context).toEqual(f.context);
    const stored = await recovery.readSnapshot(persistence.getSession().recoveryRecordId);
    expect(stored.project).toEqual(disk); expect(stored.receipt.digest).toBe(permit.receipt.digest);
    expect(f.sandbox.syncLabviewCommands).not.toHaveBeenCalled();
    expect((await fs.promises.readdir(path.join(f.folder, "Paths"))).some(name => name.endsWith(".bdx"))).toBe(false);
  } finally {
    coordinator.editingResumed(f.context.windowEpoch); channel.dispose();
  }
});

it("restores the portable project without changing its editor link or invoking NI, and binds export to that exact selection", async () => {
  const f = await fixture(), before = structuredClone(f.sandbox.currentRobotEditor);
  const result = await f.handlers.get("robotProject:restore")!(null, f.context);
  expect(result.catalog.projectName).toBe("Robot"); expect(result.editorLink).toBeUndefined();
  expect(f.sandbox.currentRobotEditor).toEqual(before); expect(f.sandbox.syncLabviewCommands).not.toHaveBeenCalled();
  const project = createDemoProject(); project.editor = before;
  expect(f.sandbox.captureLinkedProject(project).bindingOptions(true).projectFile).toBe(f.file);
  project.editor = { labviewProjectPath: "Other.lvproj", robotProjectBookmarkId: result.bookmarkId };
  expect(() => f.sandbox.captureLinkedProject(project)).toThrow("does not match");
  const bindings = vi.fn(); f.sandbox.prepareBdxBindings = bindings;
  project.paths[0].markers = [{ id: "marker", invocation: { commandId: "test", arguments: {} } }] as any;
  await expect(f.sandbox.exportSaved({ canonicalProject: project, location: { folderPath: f.folder } }, { assertCurrent() {} })).rejects.toThrow("does not match");
  expect(bindings).not.toHaveBeenCalled();
});

it("proposes an opaque, explicitly accepted candidate and rejects an old context before filesystem work", async () => {
  const f = await fixture(); f.sandbox.currentRobotEditor = { labviewProjectPath: "Missing.lvproj" };
  const proposal = await f.sandbox.restoreProjectRobotCode(f.context);
  expect(proposal).toMatchObject({ status: "missing", error: "", suggestion: { name: "Robot.lvproj" } });
  expect(proposal.suggestion).not.toHaveProperty("file");
  expect(f.sandbox.linkedLabviewProjectFile).toBeNull();
  const accepted = await f.handlers.get("robotProject:useSuggested")!(null, f.context, proposal.suggestion.id);
  expect(accepted.editorLink).toEqual({ labviewProjectPath: "Robot.lvproj" });
  expect(accepted.editorLink).not.toHaveProperty("robotProjectBookmarkId");
  const old = f.context; f.activate();
  const stat = vi.spyOn(fs.promises, "lstat");
  await expect(f.handlers.get("robotProject:useSuggested")!(null, old, proposal.suggestion.id)).rejects.toThrow("changed");
  expect(stat).not.toHaveBeenCalled();
});

it("keeps a differently cased native selection linked through public Save and export on a case-insensitive host filesystem", async ({ skip }) => {
  const f = await fixture();
  const selected = path.join(path.dirname(f.folder), "pATHSpROJECT", "rOBOT.lvproj");
  // Actual host filesystem coverage, not Windows emulation. Case-sensitive hosts cannot admit this alias.
  try { await fs.promises.lstat(selected); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return skip(); throw error; }
  const project = createDemoProject(); project.editor = { labviewProjectPath: "../pATHSpROJECT/rOBOT.lvproj" };
  f.sandbox.currentRobotEditor = project.editor;
  await f.handlers.get("robotProject:restore")!(null, f.context);
  expect(f.sandbox.linkedLabviewProjectFile).toBe(selected);
  // Existing authored links keep their spelling even after explicit Refresh/Build; NI work is mocked here.
  f.sandbox.syncLabviewCommands = vi.fn(async (_file: string, _cache: string, catalog: unknown) => catalog);
  f.sandbox.buildLabviewCatalog = vi.fn(async () => {});
  for (const action of ["robotProject:refresh", "robotProject:buildCatalog"]) {
    const result = await f.handlers.get(action)!(null, f.context);
    expect(result.editorLink).toBeUndefined();
    expect(f.sandbox.captureLinkedProject(project).bindingOptions(true).projectFile).toBe(selected);
    expect(project.editor.labviewProjectPath).toBe("../pATHSpROJECT/rOBOT.lvproj");
  }
  f.sandbox.syncLabviewCommands.mockClear();
  project.editor = {};
  project.paths[0].markers = [{ id: "marker", f: 0.5, name: "Test", invocation: { commandId: "test", arguments: {} } }];
  await autosaveProjectFolder(f.folder, project, projectWorkspacePath(f.folder), { createProject: true });
  const admitted = await loadProjectSelection(projectWorkspacePath(f.folder), { requireSource: true });
  f.sandbox.currentRobotEditor = project.editor;
  f.sandbox.smokeDirectory = null; f.sandbox.mainWindow = {};
  f.sandbox.dialog = { showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [selected] })) };
  const linked = await f.handlers.get("robotProject:link")!(null, f.context);
  expect(linked.editorLink).toEqual({ labviewProjectPath: "Robot.lvproj" });
  expect(f.sandbox.linkedLabviewProjectFile).toBe(f.file);
  project.editor = linked.editorLink;
  const source = new ProjectSourcePersistence({ getContext: () => f.context, write: f.sandbox.writeSource, commit: f.sandbox.commitSource });
  const persistence = new ProjectPersistence({ source, recovery: new ProjectRecoveryStore(path.join(f.root, "recovery")),
    getContext: () => f.context, getLocation: () => f.sandbox.projectLocation(), onUpdate() {} });
  f.sandbox.projectSources = source; f.sandbox.projectPersistence = persistence;
  persistence.admitSource(f.context, admitted.sourceEvidence, admitted.legacyFile);
  const bindings = vi.fn(async (options: { projectFile: string | null }) => {
    expect(options.projectFile).toBe(f.file);
    throw new Error("Reached canonical command binding");
  });
  f.sandbox.prepareBdxBindings = bindings;
  const request = { context: f.context, snapshotRevision: 1, project };
  const saved = await persistence.saveWithExport(request, { folderPath: f.folder, projectPath: projectWorkspacePath(f.folder) }, persistence.captureRequest(request),
    (result, scope) => f.sandbox.exportSaved(result, scope));
  expect(saved).toMatchObject({ saved: true, exportError: expect.stringContaining("Reached canonical command binding") });
  expect(bindings).toHaveBeenCalledOnce();
  expect(f.sandbox.linkedRobotCatalog).toBe(linked.catalog);
  const disk = (await openProjectFolder(f.folder)).project!;
  expect(disk.editor).toEqual(linked.editorLink);
  expect(f.sandbox.captureLinkedProject(disk).bindingOptions(true).projectFile).toBe(f.file);
  expect(f.sandbox.syncLabviewCommands).not.toHaveBeenCalled();
});

it("rejects an A → B → A late catalog reply and keeps the new A export binding", async () => {
  const f = await fixture(); let release!: () => void, entered!: () => void, held = true;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  f.sandbox.discoverRobotProject = vi.fn(async (file: string) => { if (held) { held = false; entered(); await gate; } return discoverLabviewProject(file); });
  const first = f.sandbox.restoreProjectRobotCode(f.context); const rejected = expect(first).rejects.toThrow("changed"); await started;
  const b = path.join(f.root, "B"); await fs.promises.mkdir(b); await fs.promises.writeFile(path.join(b, "Robot.lvproj"), "<Project/>");
  f.activate(b); await f.sandbox.restoreProjectRobotCode(f.context);
  f.activate(f.folder); await f.sandbox.restoreProjectRobotCode(f.context);
  const project = createDemoProject(); project.editor = { labviewProjectPath: "Robot.lvproj" };
  const binding = f.sandbox.captureLinkedProject(project);
  release(); await rejected;
  expect(f.sandbox.linkedLabviewProjectFile).toBe(f.file); expect(binding.isCurrent()).toBe(true);
});

it("keeps read failure as Missing with a recovery action and no active catalog", async () => {
  const f = await fixture(); f.sandbox.discoverRobotProject.mockRejectedValue(new Error("Project XML could not be read"));
  expect(await f.sandbox.restoreProjectRobotCode(f.context)).toMatchObject({ status: "missing", error: "LabVIEW project: Project XML could not be read" });
  expect(f.sandbox.linkedLabviewProjectFile).toBeNull(); expect(f.sandbox.linkedRobotCatalog).toBeNull();
  expect(f.sandbox.suggestedRobotProject).toBeNull();
});

it("writes a copy through the real main hook and public persistence, keeping exact recovery, canonical source and export ownership distinct", async () => {
  const f = await fixture(), project = createDemoProject(); project.editor = { labviewProjectPath: "Robot.lvproj" };
  await autosaveProjectFolder(f.folder, project, projectWorkspacePath(f.folder), { createProject: true });
  const selection = await loadProjectSelection(projectWorkspacePath(f.folder), { requireSource: true });
  let location = { folderPath: f.folder, projectPath: projectWorkspacePath(f.folder) };
  const recovery = new ProjectRecoveryStore(path.join(f.root, "recovery")), updates: any[] = [];
  let persistence!: ProjectPersistence;
  await f.sandbox.restoreProjectRobotCode(f.context);
  const source = new ProjectSourcePersistence({ getContext: () => f.context, write: f.sandbox.writeSource,
    commit: (capture, saved, target) => { const result = f.sandbox.commitSource(capture, saved, target); location = result.location; return result; } });
  persistence = new ProjectPersistence({ source, recovery, getContext: () => f.context, getLocation: () => location, onUpdate: update => updates.push(structuredClone(update)) });
  f.sandbox.projectSources = source; f.sandbox.projectPersistence = persistence;
  persistence.admitSource(f.context, selection.sourceEvidence, selection.legacyFile);
  const to = path.join(f.root, "Copy"); await fs.promises.mkdir(to);
  // A same-named sibling is deliberately a different LabVIEW project.
  await fs.promises.writeFile(path.join(to, "Robot.lvproj"), "<Project/>");
  const request = { context: f.context, snapshotRevision: 1, project }, captured = persistence.captureRequest(request);
  const originalDigest = captured.digest;
  const saved = await persistence.saveWithExport(request, { folderPath: to, projectPath: projectWorkspacePath(to), createProject: true }, captured,
    async (result, scope) => {
      scope.assertCurrent(); expect(f.sandbox.linkedProjectMatches(result.canonicalProject, to)).toBe(true);
      expect(f.sandbox.captureLinkedProject(result.canonicalProject).bindingOptions(true).projectFile).toBe(f.file);
      throw new Error("Injected export failure after source commit");
    });
  expect(saved).toMatchObject({ saved: true, exportError: expect.stringContaining("Injected export failure") });
  if (!("saved" in saved)) throw new Error("Expected source save");
  const canonical = (await openProjectFolder(to)).project!;
  expect(saved.canonicalProject).toEqual(canonical); expect(canonical.editor?.labviewProjectPath).toBe("../repo/PathsProject/Robot.lvproj");
  expect(captured.digest).toBe(originalDigest); expect(captured.project.editor).toEqual(project.editor);
  const kept = await recovery.readSnapshot(persistence.getSession().recoveryRecordId);
  expect(kept.project).toEqual(project); expect(kept.receipt.digest).toBe(canonicalProjectDigest(project));
  expect(persistence.getSession().latestSource?.digest).toBe(canonicalProjectDigest(canonical));
  expect(updates.find(update => update.source === "saved").canonicalProject).toEqual(canonical);
  await source.whenExportsSettled();
  // An ordinary subsequent Save is stable and does not reintroduce the old link.
  const again = { context: f.context, snapshotRevision: 2, project: canonical };
  expect((await persistence.checkpoint(again)).source).toBe("saved");
  expect((await openProjectFolder(to)).project?.editor).toEqual(canonical.editor);
});

it("shows a relative target absent from this checkout as plain Missing, never as a moved project folder", async () => {
  const f = await fixture();
  for (const labviewProjectPath of ["../Robot/Robot.lvproj", "Gone.lvproj"]) {
    f.sandbox.currentRobotEditor = { labviewProjectPath };
    const result = await f.sandbox.restoreProjectRobotCode(f.context);
    expect(result).toMatchObject({ status: "missing", error: "" });
    expect(f.sandbox.linkedRobotCatalog).toBeNull();
  }
});

it("reports a genuinely unreadable linked project as a readable robot-code failure", async () => {
  const f = await fixture(); await fs.promises.writeFile(f.file, "<Project>");
  const result = await f.sandbox.restoreProjectRobotCode(f.context);
  expect(result.status).toBe("missing"); expect(result.error).toMatch(/^LabVIEW project: /);
  expect(projectWriteFactFromMessage(result.error)).toBeNull();
  expect(f.sandbox.linkedRobotCatalog).toBeNull();
});

it("never scans or proposes robot code for a project that has never linked any", async () => {
  const f = await fixture(); f.sandbox.currentRobotEditor = {};
  const stat = vi.spyOn(fs.promises, "lstat"), list = vi.spyOn(fs.promises, "opendir");
  expect(await f.sandbox.restoreProjectRobotCode(f.context)).toEqual({ status: "unlinked", error: "" });
  expect(stat).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled();
  expect(f.sandbox.suggestedRobotProject).toBeNull();
});

it("proposes for an unresolved legacy bookmark and suppresses proposal lookup failures", async () => {
  const f = await fixture(); f.sandbox.currentRobotEditor = { robotProjectBookmarkId: "a".repeat(20) };
  expect(await f.sandbox.restoreProjectRobotCode(f.context)).toMatchObject({ status: "missing", error: "", suggestion: { name: "Robot.lvproj" } });
  f.sandbox.currentRobotEditor = { labviewProjectPath: "Gone.lvproj" };
  f.sandbox.suggestProjectLabviewLink = vi.fn(async () => { throw Object.assign(new Error("EACCES: permission denied, opendir"), { code: "EACCES" }); });
  const result = await f.sandbox.restoreProjectRobotCode(f.context);
  expect(result).toEqual({ status: "missing", error: "" }); expect(f.sandbox.suggestedRobotProject).toBeNull();
});
