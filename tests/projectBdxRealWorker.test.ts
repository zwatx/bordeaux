import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { runWorkerTask } from "../src/electron/workerTask";
import { bdxBindingsFromCatalog } from "../src/electron/bdxBindings";
import { blankPath, createDemoProject } from "../src/shared/project/defaults";
import { buildRobotBinary, type BuiltRobotBinary } from "../src/shared/export/robotBinary";
import { autosaveProjectFolder, projectWorkspacePath, writeProjectFolderBdx } from "../src/electron/projectFiles";
let root: string, worker: string;
beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-real-bdx-")));
  worker = path.join(root, "worker.cjs");
  // Transpile the real worker and its real shared dependencies without a standard build or a replacement planner.
  await fs.writeFile(worker, `const ts=require(${JSON.stringify(require.resolve("typescript"))});const fs=require('node:fs');
    require.extensions['.ts']=(module,file)=>module._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);
    require(${JSON.stringify(path.resolve("src/electron/bdxWorker.ts"))});`);
});
afterAll(async () => { await fs.rm(root, { recursive: true, force: true }); });
it("builds 65 real paths in existing 64+1 batches with exact bytes and selected order, then writes Git-shareable local BDX", async () => {
  const project = createDemoProject(); project.paths = Array.from({ length: 65 }, (_, index) => ({ ...blankPath(`Path ${index}`), id: `path-${index}` }));
  project.editor!.activePathId = project.paths[0].id;
  const bindings = bdxBindingsFromCatalog(null), selections = [...project.paths].reverse().map(item => ({ kind: "path" as const, id: item.id }));
  const result: BuiltRobotBinary[] = [], signal = new AbortController().signal;
  for (let start = 0; start < selections.length; start += 64) result.push(...await runWorkerTask<BuiltRobotBinary[]>(worker, { project, selections: selections.slice(start, start + 64), bindings }, "Real BDX", signal, { waitForTermination: true }));
  const expected = selections.map(selection => buildRobotBinary(project, selection, bindings));
  expect(result.map(item => item.fileName)).toEqual(expected.map(item => item.fileName));
  result.forEach((item, index) => { expect(Buffer.from(item.bytes)).toEqual(Buffer.from(expected[index].bytes)); expect({ ...item, bytes: undefined }).toEqual({ ...expected[index], bytes: undefined }); });
  const folder = path.join(root, "Project"); await fs.mkdir(folder); await autosaveProjectFolder(folder, project, null);
  await writeProjectFolderBdx(folder, result);
  expect((await fs.readdir(path.join(folder, "Paths"))).filter(file => file.endsWith(".bdx"))).toHaveLength(65);
  for (const item of result) expect(await fs.readFile(path.join(folder, "Paths", item.fileName))).toEqual(Buffer.from(item.bytes));
  expect(await fs.stat(projectWorkspacePath(folder))).toMatchObject({ size: expect.any(Number) });
}, 20_000);
