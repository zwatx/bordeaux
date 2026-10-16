import { loadProjectSelection } from "../src/electron/projectOpening";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import { expect, it } from "vitest";
import { ProjectStartup } from "../src/electron/projectStartup";
import { ProjectPersistence } from "../src/electron/projectPersistence";
import { ProjectSourcePersistence } from "../src/electron/projectSourcePersistence";
import { ProjectRecoveryStore } from "../src/electron/projectRecoveryStore";
import { autosaveProjectFolder, projectWorkspacePath } from "../src/electron/projectFiles";
import { createDemoProject } from "../src/shared/project/defaults";
import type { ProjectLocation } from "../src/shared/project/desktopProjects";
import type { ProjectStartupDetachResult, ProjectStartupRequest } from "../src/shared/project/projectPersistence";

it("executes the actual main startup-detach handler before blank persistence without touching the retained source", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-startup-main-")));
  try {
    const folder = path.join(root, "Retained"); await fs.mkdir(folder);
    const original = createDemoProject(); original.paths[0].name = "Retained source";
    await autosaveProjectFolder(folder, original, null);
    let context = { windowEpoch: randomUUID(), documentSessionId: randomUUID(), targetGeneration: 1 };
    let location: ProjectLocation = { folderPath: folder, projectPath: projectWorkspacePath(folder) };
    const recovery = new ProjectRecoveryStore(path.join(root, "recovery"));
    const source = new ProjectSourcePersistence({ getContext: () => context, commit: (_capture, _project, target) => ({
      context, location: { folderPath: path.dirname(target), projectPath: target },
    }) });
    const persistence = new ProjectPersistence({ source, recovery, getContext: () => context, getLocation: () => location, onUpdate: () => undefined });
    persistence.admitSource(context, (await loadProjectSelection(folder)).sourceEvidence);
    await persistence.checkpoint({ context, snapshotRevision: 1, project: original });
    const beforeBytes = await fs.readFile(projectWorkspacePath(folder));
    const previous = { session: persistence.getSession(), pendingWrites: source.pendingWrites() };
    const startup = new ProjectStartup({ getSession: () => persistence.getSession(), isTransitionCurrent: persistence.isTransitionCurrent.bind(persistence),
      readRecents: async () => { throw new Error("Fixture unreadable recents"); }, getResume: () => null,
      listRecoveries: async () => ({ entries: [], limited: false }), assertReadable: async () => undefined,
      activate: async () => { throw new Error("Unavailable startup must not activate"); } });
    const owner = { context: { ...context }, transition: persistence.beginTransition(context) };
    expect(await startup.probe(owner)).toMatchObject({ status: "unavailable", reason: "recents-unavailable" });

    // Execute the product's actual IPC listener with real helpers/filesystem.
    // Electron's trusted-frame handle wrapper and native delivery are separate integration checks.
    const contents = await fs.readFile(path.resolve("src/electron/main.ts"), "utf8");
    const ast = ts.createSourceFile("main.ts", contents, ts.ScriptTarget.Latest, true);
    const statement = ast.statements.find(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
      && node.expression.expression.getText(ast) === "handle" && node.expression.arguments[0]?.getText(ast) === '"project:startupDetach"');
    if (!statement || !ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) throw new Error("Actual startup-detach handler missing");
    const listener = statement.expression.arguments[1].getText(ast);
    let clearLinkCalls = 0;
    const sandbox = { projectStartup: startup, retiredProjectResume: previous, projectPersistence: persistence, dirty: true,
      captureProjectResumeDescriptor: () => ({ session: persistence.getSession(), pendingWrites: source.pendingWrites() }),
      activateProjectTarget: () => { location = { folderPath: null, projectPath: null }; context = { ...context, targetGeneration: context.targetGeneration + 1 }; },
      replaceProjectSession: () => { context = { ...context, documentSessionId: randomUUID() }; persistence.contextChanged(true); },
      clearLinkedRobotProject: () => { clearLinkCalls++; },
      detach: undefined as unknown as (event: unknown, request: ProjectStartupRequest) => ProjectStartupDetachResult,
    };
    vm.runInNewContext(ts.transpileModule(`globalThis.detach = ${listener};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
    const detached = sandbox.detach(undefined, owner);
    expect(detached.previous).toEqual(previous); expect(sandbox.retiredProjectResume).toBeNull(); expect(sandbox.dirty).toBe(false); expect(clearLinkCalls).toBe(1);
    expect(detached.session.location).toEqual({ folderPath: null, projectPath: null }); expect(context.documentSessionId).not.toBe(owner.context.documentSessionId);
    expect(persistence.isTransitionCurrent(owner.transition)).toBe(true);
    const blank = createDemoProject(); blank.paths[0].waypoints = [];
    expect(await persistence.checkpoint({ context, snapshotRevision: 2, project: blank })).toMatchObject({ source: "unavailable", recovery: "saved" });
    expect(await fs.readFile(projectWorkspacePath(folder))).toEqual(beforeBytes); expect((await recovery.listSnapshots()).entries).toHaveLength(2);
    const active = persistence.getSession(); expect(() => sandbox.detach(undefined, owner)).toThrow("no longer current"); expect(persistence.getSession()).toEqual(active);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
