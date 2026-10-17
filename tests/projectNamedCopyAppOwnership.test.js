import fs from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import * as lifecycleExports from "../src/renderer/lib/projectLifecycle";
import { projectPersistenceStayedCurrent } from "../src/renderer/lib/draftPersistence";

// Named Save copy: the actual App callbacks (and, for a carried switch, the actual sheet submission and attempt) run with
// controlled owners, deferred transitions and deferred checkpoint outcomes. These are not DOM, focus or rendering tests.
async function callback(file, name, dependencies) {
  const source = await fs.readFile(file, "utf8"), ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
  let expression;
  const visit = (node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === name && ts.isArrowFunction(node.initializer)) expression = node.initializer;
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name && node.initializer) {
      expression = ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(ast); if (!expression) throw new Error("Missing actual callback " + name);
  return vm.runInNewContext(ts.transpileModule("(" + expression.getText(ast) + ")", { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { ...lifecycleExports, ...dependencies });
}
const app = "src/renderer/app/App.jsx", sheet = "src/renderer/components/ProjectsDialog.jsx";
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const settle = () => new Promise((resolve) => setImmediate(resolve));
const G = 4, context = { windowEpoch: "w", documentSessionId: "d", targetGeneration: G }, advanced = { ...context, targetGeneration: G + 1 };
const location = { folderPath: "/team/Week 3 copy", projectPath: "/team/Week 3 copy/.bordeaux-workspace.json" };
const values = { name: "Week 3 copy", parentDirectory: "/team" };
const update = (extra) => ({ mode: "background", snapshotRevision: 11, context, ...extra });
const receipt = (capturedAt) => ({ recovery: "saved", recoveryReceipt: { capturedAt, recordId: "r" } });

function checkpoints() {
  const watchers = new Set();
  return {
    watch(match, onUpdate) { const watcher = { match, onUpdate }; watchers.add(watcher); return () => watchers.delete(watcher); },
    emit(next) { for (const watcher of [...watchers]) if (watcher.match(next)) watcher.onUpdate(next); },
    get size() { return watchers.size; },
  };
}

// The App half: ownsCopy, copyLive, copyBody and submitCopy with one bound document at generation G (epoch 7).
async function copyApp({ token = { id: "t" }, ready = null, enqueue, session } = {}) {
  const refs = { documentEpoch: { current: 7 }, sessionContext: { current: context }, projectTransitionRef: { current: null },
    projectRef: { current: { name: "Week 3" } }, draftInputGeneration: { current: 1 } };
  const fx = { setRecoveryState: vi.fn(), refreshSessionRecord: vi.fn(), applySavedSource: vi.fn(), setSaveState: vi.fn(), attachExport: vi.fn(),
    announceAction: vi.fn(), finishEdit: vi.fn(), materializeProject: vi.fn(() => ({ name: "Week 3" })) };
  const saving = deferred(), channel = checkpoints();
  saving.promise.catch(() => undefined);
  const lifecycle = { saveProjectWithCheckpoint: vi.fn(() => saving.promise), getProjectSession: vi.fn(session || (async () => ({ context: refs.sessionContext.current }))) };
  const takeTransition = vi.fn((owner) => {
    const transition = { owner, token: null };
    transition.ready = Promise.resolve(ready?.promise).then(() => { transition.token = token; return token?.id || null; });
    refs.projectTransitionRef.current = transition;
    return transition;
  });
  const releaseTransition = vi.fn((transition) => { if (refs.projectTransitionRef.current === transition) refs.projectTransitionRef.current = null; });
  const deps = { ...refs, ...fx, lifecycle, checkpointChannel: channel, enqueuePersistence: enqueue || ((operation) => Promise.resolve().then(operation)),
    editStore: { getRevision: () => 3, getSnapshot: () => null }, nextSnapshotRevision: () => 11, savedState: () => ({ status: "saved", error: "" }),
    projectFolderName: (place) => place?.folderPath?.split("/").pop() || "", flushProjectDraft: () => true, flushSync: (run) => run(), takeTransition, releaseTransition };
  deps.ownsCopy = await callback(app, "ownsCopy", deps);
  deps.copyLive = await callback(app, "copyLive", deps);
  deps.copyBody = await callback(app, "copyBody", deps);
  deps.submitCopy = await callback(app, "submitCopy", deps);
  const owner = { epoch: 7, context };
  const mutations = () => [fx.applySavedSource, fx.setSaveState, fx.attachExport, fx.announceAction, fx.setRecoveryState].reduce((sum, spy) => sum + spy.mock.calls.length, 0);
  return { refs, fx, saving, channel, lifecycle, deps, owner, mutations, takeTransition, releaseTransition };
}

describe("named Save copy: App ownership", () => {
  it("completes a direct copy once, from its own source commit at exactly G+1", async () => {
    const h = await copyApp(), copying = h.deps.submitCopy(values, h.owner, () => true);
    await settle();
    expect(h.takeTransition).toHaveBeenCalledTimes(1);
    expect(h.lifecycle.saveProjectWithCheckpoint).toHaveBeenCalledTimes(1);
    const request = h.lifecycle.saveProjectWithCheckpoint.mock.calls[0][0];
    expect(request).toMatchObject({ context, snapshotRevision: 11, copyTo: values, transition: { id: "t" } });
    expect(request).not.toHaveProperty("saveAs");
    h.channel.emit(update({ source: "pending", ...receipt("09:00") }));
    expect(h.fx.setRecoveryState).toHaveBeenCalledWith(expect.objectContaining({ status: "saved", at: "09:00" }));
    h.channel.emit(update({ context: advanced, source: "saved", location, ...receipt("09:01") }));
    await expect(copying).resolves.toEqual({ copied: true });
    expect(h.refs.sessionContext.current).toEqual(advanced);
    expect(h.fx.applySavedSource).toHaveBeenCalledTimes(1);
    expect(h.fx.applySavedSource.mock.calls[0][0]).toEqual(location);
    expect(h.fx.setSaveState).toHaveBeenCalledWith({ status: "saved", error: "" }, { user: true });
    expect(h.fx.attachExport).toHaveBeenCalledTimes(1);
    expect(h.fx.attachExport.mock.calls[0][0]).toBe(h.lifecycle.saveProjectWithCheckpoint.mock.results[0].value);
    expect(h.fx.announceAction).toHaveBeenCalledTimes(1);
    expect(h.fx.announceAction).toHaveBeenCalledWith("Saved copy · editing “Week 3 copy”");
    expect(h.fx.setRecoveryState).toHaveBeenLastCalledWith(expect.objectContaining({ at: "09:01" }));
    expect(h.refs.projectTransitionRef.current).toBeNull();
  });

  it.each([
    ["a same-document generation advance", (h) => { h.refs.sessionContext.current = advanced; }],
    ["another document epoch", (h) => { h.refs.documentEpoch.current = 8; }],
    ["a retired form submission", () => undefined, () => false],
  ])("refuses %s before any transition or IPC", async (_, change, current = () => true) => {
    const h = await copyApp(); change(h);
    await expect(h.deps.submitCopy(values, h.owner, current)).resolves.toEqual({ copyFailed: "The project changed" });
    await settle();
    expect(h.takeTransition).not.toHaveBeenCalled(); expect(h.lifecycle.saveProjectWithCheckpoint).not.toHaveBeenCalled();
  });

  it("takes one transition and sends one IPC for two synchronous presses", async () => {
    const h = await copyApp(), first = h.deps.submitCopy(values, h.owner, () => true), second = h.deps.submitCopy(values, h.owner, () => true);
    await expect(second).resolves.toEqual({ busy: true });
    await settle();
    expect(h.takeTransition).toHaveBeenCalledTimes(1); expect(h.lifecycle.saveProjectWithCheckpoint).toHaveBeenCalledTimes(1);
    h.channel.emit(update({ context: advanced, source: "saved", location }));
    await expect(first).resolves.toEqual({ copied: true });
  });

  it("says busy, without IPC, when main refuses the transition", async () => {
    const h = await copyApp({ token: null });
    await expect(h.deps.submitCopy(values, h.owner, () => true)).resolves.toEqual({ copyFailed: "The project is busy · Try again" });
    expect(h.lifecycle.saveProjectWithCheckpoint).not.toHaveBeenCalled(); expect(h.releaseTransition).toHaveBeenCalledTimes(1);
  });

  it("sends nothing when the submission is retired while the transition is pending", async () => {
    const ready = deferred(), h = await copyApp({ ready }), live = { value: true };
    const copying = h.deps.submitCopy(values, h.owner, () => live.value);
    live.value = false; ready.resolve();
    await expect(copying).resolves.toEqual({ copyFailed: "The project changed" });
    expect(h.channel.size).toBe(0); expect(h.fx.materializeProject).not.toHaveBeenCalled(); expect(h.lifecycle.saveProjectWithCheckpoint).not.toHaveBeenCalled();
  });

  it("sends nothing when the submission is retired while its queued step waits", async () => {
    const gate = deferred(), live = { value: true };
    const h = await copyApp({ enqueue: (operation) => gate.promise.then(operation) });
    const copying = h.deps.submitCopy(values, h.owner, () => live.value);
    await settle(); live.value = false; gate.resolve();
    await expect(copying).resolves.toEqual({ copyFailed: "The project changed" });
    expect(h.channel.size).toBe(0); expect(h.fx.materializeProject).not.toHaveBeenCalled(); expect(h.lifecycle.saveProjectWithCheckpoint).not.toHaveBeenCalled();
  });

  it("changes nothing in App when its submission is retired while the source is outstanding", async () => {
    const h = await copyApp(), live = { value: true }, copying = h.deps.submitCopy(values, h.owner, () => live.value);
    await settle(); live.value = false;
    h.channel.emit(update({ source: "pending", ...receipt("09:00") }));
    h.channel.emit(update({ context: advanced, source: "saved", location, ...receipt("09:01") }));
    await expect(copying).resolves.toEqual({ copyFailed: "The project changed" });
    expect(h.mutations()).toBe(0); expect(h.fx.refreshSessionRecord).not.toHaveBeenCalled(); expect(h.refs.sessionContext.current).toEqual(context);
  });

  it.each([
    ["an unrelated refresh adopted G+2", (h) => { h.refs.sessionContext.current = { ...context, targetGeneration: G + 2 }; }, advanced],
    ["the saved update is at G+2", () => undefined, { ...context, targetGeneration: G + 2 }],
    ["the transition was released", (h) => { h.refs.projectTransitionRef.current = null; }, advanced],
    ["the transition was replaced", (h) => { h.refs.projectTransitionRef.current = { owner: "menu" }; }, advanced],
    ["another document was loaded", (h) => { h.refs.documentEpoch.current = 8; }, advanced],
  ])("applies nothing when %s", async (_, change, committed) => {
    const h = await copyApp(), before = h.refs.sessionContext, copying = h.deps.submitCopy(values, h.owner, () => true);
    await settle(); change(h);
    h.channel.emit(update({ context: committed, source: "saved", location, ...receipt("09:01") }));
    await expect(copying).resolves.toEqual({ copyFailed: "The project changed" });
    expect(h.mutations()).toBe(0); expect(before.current).not.toEqual(advanced);
  });

  it("completes normally when a refresh adopted G+1 before its own update acknowledged it", async () => {
    const h = await copyApp(), copying = h.deps.submitCopy(values, h.owner, () => true);
    await settle(); h.refs.sessionContext.current = advanced;
    h.channel.emit(update({ context: advanced, source: "saved", location }));
    await expect(copying).resolves.toEqual({ copied: true });
    expect(h.fx.applySavedSource).toHaveBeenCalledTimes(1); expect(h.fx.announceAction).toHaveBeenCalledTimes(1);
  });

  it("takes recovery receipts only at the entry generation, or with its acknowledged commit", async () => {
    const h = await copyApp(), copying = h.deps.submitCopy(values, h.owner, () => true);
    await settle();
    h.channel.emit(update({ context: advanced, source: "pending", ...receipt("09:00") }));
    h.channel.emit(update({ context: { ...context, targetGeneration: G + 2 }, source: "saved", location, ...receipt("09:01") }));
    await expect(copying).resolves.toEqual({ copyFailed: "The project changed" });
    expect(h.fx.setRecoveryState).not.toHaveBeenCalled();
  });

  it("reports a failed source at the entry generation with its exact receipt, changing no chip or dirty state", async () => {
    const h = await copyApp(), copying = h.deps.submitCopy(values, h.owner, () => true);
    await settle();
    h.channel.emit(update({ source: "failed", sourceFact: "Folder is read-only", ...receipt("09:02") }));
    await expect(copying).resolves.toEqual({ copyFailed: "Folder is read-only" });
    expect(h.fx.setRecoveryState).toHaveBeenCalledWith(expect.objectContaining({ status: "saved", at: "09:02" }));
    expect(h.fx.refreshSessionRecord).toHaveBeenCalledTimes(1);
    expect(h.fx.applySavedSource).not.toHaveBeenCalled(); expect(h.fx.setSaveState).not.toHaveBeenCalled(); expect(h.fx.attachExport).not.toHaveBeenCalled();
    expect(h.refs.sessionContext.current).toEqual(context); expect(h.refs.projectTransitionRef.current).toBeNull();
  });

  it("keeps a retired failure silent", async () => {
    const h = await copyApp(), live = { value: true }, copying = h.deps.submitCopy(values, h.owner, () => live.value);
    await settle(); live.value = false;
    h.channel.emit(update({ source: "timed-out", sourceFact: "Folder isn’t responding", ...receipt("09:02") }));
    await expect(copying).resolves.toEqual({ copyFailed: "The project changed" });
    expect(h.mutations()).toBe(0); expect(h.fx.refreshSessionRecord).not.toHaveBeenCalled();
  });

  describe("an invoke rejection without an update", () => {
    const rejected = new Error("Error invoking remote method 'project:saveWithCheckpoint': Error: Folder is read-only");
    it("is a copy only with this attempt's revision committed at exactly G+1", async () => {
      const h = await copyApp({ session: async () => ({ context: advanced, location, latestSource: { snapshotRevision: 11, context: advanced } }) });
      const copying = h.deps.submitCopy(values, h.owner, () => true);
      await settle(); h.saving.reject(new Error("BDX export failed"));
      await expect(copying).resolves.toEqual({ copied: true });
      expect(h.fx.applySavedSource.mock.calls[0][0]).toEqual(location); expect(h.fx.attachExport).toHaveBeenCalledTimes(1);
      expect(h.refs.sessionContext.current).toEqual(advanced);
    });
    it("reports main's error at the same generation, changing nothing", async () => {
      const h = await copyApp({ session: async () => ({ context, location: { folderPath: "/team/Week 3" } }) });
      const copying = h.deps.submitCopy(values, h.owner, () => true);
      await settle(); h.saving.reject(rejected);
      await expect(copying).resolves.toEqual({ copyFailed: rejected });
      expect(h.mutations()).toBe(0);
    });
    it.each([
      ["the session read fails", async () => { throw new Error("gone"); }],
      ["another document is current", async () => ({ context: { ...advanced, documentSessionId: "other" }, location, latestSource: { snapshotRevision: 11, context: advanced } })],
      ["G+1 carries another revision", async () => ({ context: advanced, location, latestSource: { snapshotRevision: 10, context: advanced } })],
    ])("claims nothing when %s", async (_, session) => {
      const h = await copyApp({ session }), copying = h.deps.submitCopy(values, h.owner, () => true);
      await settle(); h.saving.reject(rejected);
      await expect(copying).resolves.toEqual({ copyFailed: "The project changed" });
      expect(h.mutations()).toBe(0); expect(h.refs.sessionContext.current).toEqual(context);
    });
  });
});

describe("named Save copy: entry routing", () => {
  const route = async ({ api = { getProjectCopyDefaults() {} }, folder = "/team/Week 3", settled = true } = {}) => {
    const fx = { saveProject: vi.fn(), showProjects: vi.fn(), showNoSaveTarget: vi.fn() };
    const request = await callback(app, "requestSaveCopy", { ...fx, lifecycle: api, projectLocationRef: { current: { folderPath: folder } }, startupSettled: { current: settled } });
    return { ...fx, request };
  };
  it("opens the copy form for Save copy and for a Save with no folder", async () => {
    const r = await route(); r.request(); expect(r.showProjects).toHaveBeenLastCalledWith("copy");
    r.request(false); expect(r.saveProject).toHaveBeenLastCalledWith(false);
    const untitled = await route({ folder: null }); untitled.request(false);
    expect(untitled.showProjects).toHaveBeenLastCalledWith("copy"); expect(untitled.saveProject).not.toHaveBeenCalled();
  });
  it("says how to continue before startup settles", async () => {
    const r = await route({ settled: false }); r.request();
    expect(r.showNoSaveTarget).toHaveBeenCalledTimes(1); expect(r.showProjects).not.toHaveBeenCalled();
  });
  it.each([["an older bridge", {}], ["the browser", null]])("keeps the picker for %s", async (_, api) => {
    const r = await route({ api, folder: null }); r.request(); r.request(false);
    expect(r.saveProject.mock.calls).toEqual([[true], [false]]); expect(r.showProjects).not.toHaveBeenCalled();
  });
});

// The real switch with a `before` step: what it returns is a stop result, and nothing opens after one.
async function switchHarness() {
  const refs = { projectTransitionRef: { current: null }, projectLocationRef: { current: { folderPath: "/team/Week 3" } }, dirtyRef: { current: false },
    projectRef: { current: { name: "Week 3" } }, draftInputGeneration: { current: 1 }, startupSettled: { current: true }, startupDetachFailed: { current: false }, bdxSaveFailure: { current: null } };
  const fx = { setProjectTransition: vi.fn(), finishEdit: vi.fn(), setSaveState: vi.fn(), invalidateScheduledAutosave: vi.fn(), updateDirty: vi.fn(), prepareProjectReplacement: vi.fn(),
    setProjectLocation: vi.fn(), loadProject: vi.fn(), persistSource: vi.fn(async () => ({ saved: true })) };
  const takeTransition = vi.fn((owner) => { const transition = { owner, phase: "opening", token: { id: "s" } }; transition.ready = Promise.resolve("s"); refs.projectTransitionRef.current = transition; return transition; });
  const releaseTransition = vi.fn((transition) => { if (refs.projectTransitionRef.current === transition) refs.projectTransitionRef.current = null; });
  const switchProject = await callback(app, "switchProject", { ...refs, ...fx, window: { bordeauxAPI: {} }, flushProjectDraft: () => true, flushSync: (run) => run(),
    editStore: { getSnapshot: () => null, getRevision: () => 3 }, hasProjectInputDraft: () => false, takeTransition, releaseTransition,
    enqueuePersistence: (operation) => Promise.resolve().then(operation), materializeProject: () => ({ name: "Week 3" }), projectFolderName: (place) => place?.folderPath?.split("/").pop() || "",
    projectPersistenceStayedCurrent, operationErrorMessage: (error) => error.message, savedState: () => ({ status: "saved", error: "" }) });
  return { refs, fx, switchProject, takeTransition, releaseTransition };
}

describe("named Save copy: a blocked switch's continuation", () => {
  it("never opens after a stop result from its own `before` step, which receives the transition", async () => {
    const h = await switchHarness(), open = vi.fn(async () => ({ project: { name: "B" }, location: { folderPath: "/team/B" } }));
    const stop = { copyFailed: "Folder is read-only" };
    const before = vi.fn(async (transition) => { expect(transition).toBe(h.refs.projectTransitionRef.current); return stop; });
    await expect(h.switchProject(open, { before, owner: "sheet" })).resolves.toBe(stop);
    expect(before).toHaveBeenCalledTimes(1); expect(open).not.toHaveBeenCalled(); expect(h.fx.loadProject).not.toHaveBeenCalled();
    expect(h.fx.setProjectTransition).toHaveBeenCalledWith(expect.objectContaining({ phase: "saving" }));
    expect(h.refs.projectTransitionRef.current).toBeNull();
  });
  it("opens after a `before` step that returns nothing", async () => {
    const h = await switchHarness(), open = vi.fn(async () => ({ project: { name: "B" }, location: { folderPath: "/team/B" } }));
    await expect(h.switchProject(open, { before: async () => undefined, owner: "sheet" })).resolves.toEqual({ opened: true });
    expect(open).toHaveBeenCalledTimes(1); expect(h.fx.loadProject).toHaveBeenCalledTimes(1);
  });
});

// App's copyBody and switchProject driven by the sheet's actual submission (create), adapter and attempt.
async function carriedHarness({ open, rowId = null, kind = "failed", legacy = false } = {}) {
  // One transition owner for both halves: the switch takes it, and copyBody runs inside it.
  const copy = await copyApp(), sw = await switchHarness();
  const switchProject = await callback(app, "switchProject", { ...sw.refs, projectTransitionRef: copy.refs.projectTransitionRef, ...sw.fx, window: { bordeauxAPI: {} }, flushProjectDraft: () => true,
    flushSync: (run) => run(), editStore: { getSnapshot: () => null, getRevision: () => 3 }, hasProjectInputDraft: () => false, takeTransition: copy.takeTransition,
    releaseTransition: copy.releaseTransition, enqueuePersistence: (operation) => Promise.resolve().then(operation), materializeProject: () => ({ name: "Week 3" }),
    projectFolderName: (place) => place?.folderPath?.split("/").pop() || "", projectPersistenceStayedCurrent, operationErrorMessage: (error) => error.message,
    savedState: () => ({ status: "saved", error: "" }) });
  const opener = open || vi.fn(async () => ({ project: { name: "B" }, location: { folderPath: "/team/B" } }));
  const run = vi.fn((options) => switchProject(opener, options));
  const block = { blocked: kind, subject: "Week 3", message: "Folder is read-only", run, rowId };
  // A sheet without the copy form never has one.
  const state = { copy: legacy ? null : { name: "Week 3 copy", parent: "/team", parentStatus: "ready", error: "", errorField: "name", carried: block }, block: null };
  const sheetRefs = { alive: { current: true }, entry: { current: legacy ? null : { carried: block, touched: {}, owner: copy.owner } }, submitting: { current: null }, modeRef: { current: "list" },
    nameInput: { current: { focus: vi.fn(), select: vi.fn() } }, locationButton: { current: { focus: vi.fn() } }, retryButton: { current: { focus: vi.fn() } }, search: { current: { focus: vi.fn() } } };
  const sheetFx = { onClose: vi.fn(), switchMode: vi.fn((mode) => { sheetRefs.entry.current = null; state.copy = null; state.mode = mode; }), setRowError: vi.fn() };
  const setCopy = (next) => { state.copy = typeof next === "function" ? next(state.copy) : next; };
  // An older bridge or the browser: the sheet has only the picker's Save and Save copy (App's saveProject).
  const pickers = { save: vi.fn(async () => undefined), saveCopy: vi.fn(async () => undefined) };
  const actions = legacy ? pickers : { ownsCopy: copy.deps.ownsCopy, copy: copy.deps.submitCopy, copyInside: copy.deps.copyBody };
  const deps = { ...sheetRefs, ...sheetFx, actions, pending: null, setCopy, setDraft: vi.fn(), setBlock: (next) => { state.block = typeof next === "function" ? next(state.block) : next; },
    requestAnimationFrame: (run) => run(), document: { activeElement: null }, current: { name: "Week 3", folderPath: "/team/Week 3" } };
  deps.entryOwns = await callback(sheet, "entryOwns", deps);
  deps.BAD_NAME = await callback(sheet, "BAD_NAME", {});
  deps.nameError = await callback(sheet, "nameError", deps);
  deps.attempt = await callback(sheet, "attempt", deps);
  deps.copyStart = await callback(sheet, "copyStart", deps);
  deps.enterCopy = await callback(sheet, "enterCopy", deps);
  const view = { ...deps, copy: state.copy, form: state.copy, draft: {}, setForm: setCopy };
  // The render's own submission check, where the source has one.
  view.copyHeld = await callback(sheet, "copyHeld", view).catch(() => undefined);
  const create = await callback(sheet, "create", view);
  return { copy, sw, run, opener, block, state, sheetRefs, sheetFx, create, deps, pickers };
}

describe("named Save copy: carried by a blocked switch, through the actual sheet submission", () => {
  it("copies, then opens the blocked target and closes once without announcing the copy", async () => {
    const h = await carriedHarness();
    h.create(); await settle();
    expect(h.copy.lifecycle.saveProjectWithCheckpoint).toHaveBeenCalledTimes(1);
    h.copy.channel.emit(update({ context: advanced, source: "saved", location }));
    await settle(); await settle();
    expect(h.opener).toHaveBeenCalledTimes(1);
    expect(h.sheetFx.onClose).toHaveBeenCalledTimes(1);
    expect(h.copy.fx.applySavedSource).toHaveBeenCalledTimes(1); expect(h.copy.fx.announceAction).not.toHaveBeenCalled();
    expect(h.copy.takeTransition).toHaveBeenCalledTimes(1);
  });

  it("never opens when its submission was retired during the copy", async () => {
    const h = await carriedHarness();
    h.create(); await settle();
    h.sheetRefs.entry.current = null;
    h.copy.channel.emit(update({ context: advanced, source: "saved", location }));
    await settle(); await settle();
    expect(h.opener).not.toHaveBeenCalled(); expect(h.sheetFx.onClose).not.toHaveBeenCalled(); expect(h.copy.mutations()).toBe(0);
    expect(h.copy.refs.projectTransitionRef.current).toBeNull();
  });

  it("never opens when the submission is retired after the copy succeeded but before the switch continues", async () => {
    const h = await carriedHarness();
    h.copy.fx.refreshSessionRecord.mockImplementation(() => { h.sheetRefs.entry.current = null; });
    h.create(); await settle();
    h.copy.channel.emit(update({ context: advanced, source: "saved", location }));
    await settle(); await settle();
    expect(h.copy.fx.applySavedSource).toHaveBeenCalledTimes(1);
    expect(h.opener).not.toHaveBeenCalled(); expect(h.sheetFx.onClose).not.toHaveBeenCalled();
  });

  it("keeps the form on a failed copy and never opens", async () => {
    const h = await carriedHarness();
    h.create(); await settle();
    h.copy.channel.emit(update({ source: "failed", sourceFact: "Folder is read-only" }));
    await settle(); await settle();
    expect(h.opener).not.toHaveBeenCalled(); expect(h.sheetFx.switchMode).not.toHaveBeenCalled();
    expect(h.state.copy).toMatchObject({ error: "Folder is read-only", errorField: "name", carried: h.block });
  });

  // R3 finding 1: the switch was blocked from the sheet (null), a recent row, or New's Create.
  it.each([[null], ["recent-other"], ["new"]])("shows the list block when Open throws after the copy (row %j), and Retry repeats only the switch", async (rowId) => {
    const h = await carriedHarness({ rowId, open: vi.fn(async () => { throw new Error("That folder is not a project."); }) });
    h.create(); await settle();
    h.copy.channel.emit(update({ context: advanced, source: "saved", location }));
    await settle(); await settle();
    expect(h.opener).toHaveBeenCalledTimes(1);
    expect(h.sheetFx.switchMode).toHaveBeenCalledWith("list"); expect(h.state.copy).toBeNull();
    expect(h.state.block).toEqual({ blocked: "error", message: "That folder is not a project", run: h.run, rowId });
    expect(h.sheetFx.setRowError.mock.calls.filter(([value]) => value)).toEqual([]);
    expect(h.sheetRefs.retryButton.current.focus).toHaveBeenCalledTimes(1); expect(h.sheetRefs.nameInput.current.focus).not.toHaveBeenCalled();
    // The copy stays saved: this document now edits the copy, with its export attached.
    expect(h.copy.refs.sessionContext.current).toEqual(advanced); expect(h.sheetFx.onClose).not.toHaveBeenCalled();
    expect(h.copy.fx.applySavedSource).toHaveBeenCalledTimes(1); expect(h.copy.fx.attachExport).toHaveBeenCalledTimes(1);
    await h.deps.attempt(h.state.block.run, h.state.block.rowId, { retry: true });
    expect(h.run).toHaveBeenCalledTimes(2); expect(h.run.mock.calls[1][0]).not.toHaveProperty("before");
    expect(h.copy.lifecycle.saveProjectWithCheckpoint).toHaveBeenCalledTimes(1); expect(h.opener).toHaveBeenCalledTimes(2);
  });

  // R4 A: the target fails after the copy, its Retry fails again, and a later Retry opens; the copy happens once.
  it.each([[null], ["recent-other"], ["new"]])("keeps the list block when Retry throws again after the copy (row %j), and a later Retry opens without copying again (R4)", async (rowId) => {
    const opener = vi.fn(async () => { throw new Error("That folder is not a project."); }), h = await carriedHarness({ rowId, open: opener });
    h.create(); await settle();
    h.copy.channel.emit(update({ context: advanced, source: "saved", location }));
    await settle(); await settle();
    expect(h.state.block).toEqual({ blocked: "error", message: "That folder is not a project", run: h.run, rowId });
    opener.mockImplementationOnce(async () => { throw new Error("Folder isn’t responding."); });
    await h.deps.attempt(h.state.block.run, h.state.block.rowId, { retry: true });
    expect(h.opener).toHaveBeenCalledTimes(2);
    expect(h.state.block).toEqual({ blocked: "error", message: "Folder isn’t responding", run: h.run, rowId, repeat: 2 });
    expect(h.state.mode).toBe("list"); expect(h.state.copy).toBeNull(); expect(h.deps.setDraft).not.toHaveBeenCalled();
    expect(h.sheetFx.setRowError.mock.calls.filter(([value]) => value)).toEqual([]);
    expect(h.sheetRefs.retryButton.current.focus).toHaveBeenCalledTimes(2);
    expect(h.sheetRefs.nameInput.current.focus).not.toHaveBeenCalled(); expect(h.sheetRefs.locationButton.current.focus).not.toHaveBeenCalled();
    expect(h.sheetFx.onClose).not.toHaveBeenCalled();
    opener.mockImplementationOnce(async () => ({ project: { name: "B" }, location: { folderPath: "/team/B" } }));
    await h.deps.attempt(h.state.block.run, h.state.block.rowId, { retry: true });
    expect(h.opener).toHaveBeenCalledTimes(3); expect(h.state.block).toBeNull(); expect(h.sheetFx.onClose).toHaveBeenCalledTimes(1);
    expect(h.sw.fx.loadProject).toHaveBeenCalledTimes(1);
    expect(h.run).toHaveBeenCalledTimes(3);
    for (const [options] of h.run.mock.calls.slice(1)) { expect(options).not.toHaveProperty("before"); expect(options).toMatchObject({ retry: true, owner: rowId || "sheet" }); }
    // One copy: its saved source and its export stay as they were.
    expect(h.copy.lifecycle.saveProjectWithCheckpoint).toHaveBeenCalledTimes(1);
    expect(h.copy.fx.applySavedSource).toHaveBeenCalledTimes(1); expect(h.copy.fx.applySavedSource.mock.calls[0][0]).toEqual(location);
    expect(h.copy.fx.attachExport).toHaveBeenCalledTimes(1); expect(h.copy.fx.attachExport.mock.calls[0][0]).toBe(h.copy.lifecycle.saveProjectWithCheckpoint.mock.results[0].value);
  });
});

// R3 finding 4, App half (R4): the actual sheet actions offer the copy form only with the same capability as the menu and
// chip (requestSaveCopy); otherwise the sheet keeps the picker's Save and Save copy, which are App's own saveProject.
async function sheetCopyActions(dependencies) {
  const source = await fs.readFile(app, "utf8"), ast = ts.createSourceFile(app, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
  const names = (node) => ts.isObjectLiteralExpression(node) ? node.properties.map((item) => item.name?.getText(ast)) : [];
  let expression;
  const visit = (node) => {
    if (ts.isSpreadAssignment(node) && ts.isParenthesizedExpression(node.expression) && ts.isConditionalExpression(node.expression.expression)) {
      const choice = node.expression.expression;
      if (names(choice.whenTrue).includes("copyOwner") || names(choice.whenFalse).includes("copyOwner")) expression = choice;
    }
    ts.forEachChild(node, visit);
  };
  visit(ast); if (!expression) throw new Error("Missing capability-gated sheet copy actions");
  return vm.runInNewContext(ts.transpileModule("(" + expression.getText(ast) + ")", { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { ...lifecycleExports, ...dependencies });
}

describe("named Save copy: the sheet's block fixes by capability (R4)", () => {
  const wiring = async (lifecycle) => {
    const fx = { saveProject: vi.fn(() => "saving"), showProjects: vi.fn(), showNoSaveTarget: vi.fn(), getProjectCopyDefaults: vi.fn(), readBoundSession: vi.fn(), submitCopy: vi.fn(), copyBody: vi.fn(), ownsCopy: vi.fn() };
    const actions = await sheetCopyActions({ ...fx, lifecycle, api: { getProjectCopyDefaults: fx.getProjectCopyDefaults }, startupSettled: { current: true }, documentEpoch: { current: 7 } });
    const request = await callback(app, "requestSaveCopy", { ...fx, lifecycle, projectLocationRef: { current: { folderPath: null } }, startupSettled: { current: true } });
    return { ...fx, actions, request };
  };
  it("gives a modern bridge the copy form, with no picker save", async () => {
    const w = await wiring({ getProjectCopyDefaults() {} });
    expect(Object.keys(w.actions)).toEqual(expect.arrayContaining(["copyOwner", "ownsCopy", "copyDefaults", "copy", "copyInside"]));
    expect(w.actions).not.toHaveProperty("save"); expect(w.actions).not.toHaveProperty("saveCopy");
    expect(w.actions.copy).toBe(w.submitCopy); expect(w.actions.copyInside).toBe(w.copyBody);
    w.request(); expect(w.showProjects).toHaveBeenCalledWith("copy");
  });
  it.each([["an older bridge", {}], ["the browser", null]])("keeps App's picker save for %s, the same capability as the menu, and never reads copy defaults", async (_, lifecycle) => {
    const w = await wiring(lifecycle);
    expect(Object.keys(w.actions).sort()).toEqual(["save", "saveCopy"]);
    expect(w.actions.save()).toBe("saving"); expect(w.actions.saveCopy()).toBe("saving");
    expect(w.saveProject.mock.calls).toEqual([[false], [true]]);
    w.request(); expect(w.saveProject).toHaveBeenLastCalledWith(true); expect(w.showProjects).not.toHaveBeenCalled();
    expect(w.getProjectCopyDefaults).not.toHaveBeenCalled(); expect(w.readBoundSession).not.toHaveBeenCalled();
  });
});

// R3 finding 4: a bridge without the copy form keeps the picker save inside the blocked switch, which then decides itself.
describe("named Save copy: a blocked switch without the copy form", () => {
  it("saves with the picker inside the switch's own transition, then opens", async () => {
    const h = await carriedHarness({ legacy: true });
    h.sw.refs.dirtyRef.current = true;
    let held;
    h.pickers.saveCopy.mockImplementation(async () => {
      held = h.copy.refs.projectTransitionRef.current;
      h.sw.refs.dirtyRef.current = false; h.sw.refs.projectLocationRef.current = { folderPath: "/team/Week 3 copy" };
    });
    h.state.block = h.block;
    h.deps.enterCopy(h.block); await settle(); await settle();
    expect(h.pickers.saveCopy).toHaveBeenCalledTimes(1); expect(h.pickers.save).not.toHaveBeenCalled();
    expect(held).toBeTruthy(); expect(held.owner).toBe("sheet");
    expect(h.pickers.saveCopy.mock.invocationCallOrder[0]).toBeLessThan(h.opener.mock.invocationCallOrder[0]);
    expect(h.opener).toHaveBeenCalledTimes(1); expect(h.sheetFx.onClose).toHaveBeenCalledTimes(1);
    expect(h.copy.lifecycle.saveProjectWithCheckpoint).not.toHaveBeenCalled(); expect(h.sw.fx.persistSource).not.toHaveBeenCalled();
    expect(h.state.copy).toBeNull(); expect(h.copy.takeTransition).toHaveBeenCalledTimes(1); expect(h.copy.refs.projectTransitionRef.current).toBeNull();
  });

  it("never opens after a cancelled picker leaves Untitled unsaved: the same block comes back", async () => {
    const h = await carriedHarness({ legacy: true, kind: "untitled" });
    h.sw.refs.dirtyRef.current = true; h.sw.refs.projectLocationRef.current = { folderPath: null };
    h.state.block = h.block;
    h.deps.enterCopy(h.block); await settle(); await settle();
    expect(h.pickers.save).toHaveBeenCalledTimes(1); expect(h.pickers.saveCopy).not.toHaveBeenCalled();
    expect(h.opener).not.toHaveBeenCalled(); expect(h.sheetFx.onClose).not.toHaveBeenCalled();
    expect(h.state.block).toMatchObject({ blocked: "untitled", run: h.run, rowId: null });
    expect(h.copy.lifecycle.saveProjectWithCheckpoint).not.toHaveBeenCalled(); expect(h.copy.refs.projectTransitionRef.current).toBeNull();
  });
});
