import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { RobotCommandDescriptor } from "../src/core/types";
import {
  readWrapperReferencesDigest, syncLabviewWrapperReferences, wrapperReferencesDescription, wrapperReferencesDigest, WRAPPER_REFERENCES_FILE,
} from "../src/electron/labviewWrapperReferences";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

// The saved VI is binary; the description sits in it as plain bytes, which is all Bordeaux reads.
const savedVi = (description: string) => Buffer.concat([Buffer.from("RSRC\r\n\0\x03LVINLBVW"), Buffer.from(description, "latin1"), Buffer.from([0, 1, 2])]);
const command = (file: string, target = "Target") => ({ labviewConnector: { file, target } }) as RobotCommandDescriptor;

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-references-"))); roots.push(root);
  const project = path.join(root, "Robot.lvproj"), references = path.join(root, WRAPPER_REFERENCES_FILE);
  await fs.mkdir(path.join(root, "Intake", "Commands"), { recursive: true });
  await fs.mkdir(path.join(root, "Drive"), { recursive: true });
  await fs.writeFile(path.join(root, "Intake", "Commands", "Start Intake_wrapper.vi"), "wrapper");
  await fs.writeFile(path.join(root, "Drive", "Calibrate_wrapper.vi"), "wrapper");
  const commands = [command("Intake/Commands/Start Intake.vi"), command("Drive/Calibrate.vi"), command("Drive/Reserve Drive.vi"), command("Drive/Calibrate.vi")];
  const wanted = ["Drive/Calibrate_wrapper.vi", "Intake/Commands/Start Intake_wrapper.vi"];
  // Stands in for UpdateCommandWrapperReferences.vi: it saves the requested description into the managed VI.
  const adapter = vi.fn(async (requestFile: string, responseFile: string) => {
    const request = JSON.parse(await fs.readFile(requestFile, "utf8"));
    expect(await readWrapperReferencesDigest(request.referencesFile)).not.toBeNull();
    await fs.writeFile(request.referencesFile, savedVi(request.description));
    await fs.writeFile(responseFile, JSON.stringify({ schemaVersion: request.schemaVersion, referencesFile: request.referencesFile, referenceCount: request.wrapperFiles.length }));
  });
  return { root, project, references, commands, wanted, adapter, guard: vi.fn(), cache: path.join(root, "cache") };
}

it("creates the managed VI from the template and references every existing wrapper once", async () => {
  const f = await fixture();
  expect(await syncLabviewWrapperReferences(f.project, { commands: f.commands }, f.cache, f.guard, f.adapter)).toEqual({ file: f.references, created: true, updated: true });
  const [[requestFile]] = f.adapter.mock.calls as unknown as Array<[string]>;
  expect(path.dirname(path.dirname(requestFile))).toBe(f.cache);
  expect(await readWrapperReferencesDigest(f.references)).toBe(wrapperReferencesDigest(f.wanted));
  expect(await fs.readdir(f.cache)).toEqual([]);
  expect((await fs.readdir(f.root)).some(name => name.startsWith(".bordeaux-references-"))).toBe(false);
});

it("sends the robot target, absolute wrapper paths and a description that records the digest", async () => {
  const f = await fixture(); let sent: Record<string, unknown> = {};
  const adapter = vi.fn(async (requestFile: string, responseFile: string) => { sent = JSON.parse(await fs.readFile(requestFile, "utf8")); await f.adapter(requestFile, responseFile); });
  await syncLabviewWrapperReferences(f.project, { commands: f.commands }, f.cache, f.guard, adapter);
  expect(sent).toEqual({ schemaVersion: "bordeaux-ni-wrapper-references/1", sources: [], projectFile: f.project, referencesFile: f.references, target: "Target",
    wrapperFiles: f.wanted.map(file => path.join(f.root, ...file.split("/"))), description: wrapperReferencesDescription(wrapperReferencesDigest(f.wanted)), marker: "bordeaux-command-wrappers/1" });
});

it("leaves a current VI alone without starting LabVIEW, and rewrites it when a wrapper is added", async () => {
  const f = await fixture();
  await fs.writeFile(f.references, savedVi(wrapperReferencesDescription(wrapperReferencesDigest(f.wanted))));
  expect(await syncLabviewWrapperReferences(f.project, { commands: f.commands }, f.cache, f.guard, f.adapter)).toEqual({ file: f.references, created: false, updated: false });
  expect(f.adapter).not.toHaveBeenCalled();
  await fs.writeFile(path.join(f.root, "Drive", "Reserve Drive_wrapper.vi"), "wrapper");
  expect(await syncLabviewWrapperReferences(f.project, { commands: f.commands }, f.cache, f.guard, f.adapter)).toEqual({ file: f.references, created: false, updated: true });
  expect(await readWrapperReferencesDigest(f.references)).toBe(wrapperReferencesDigest([...f.wanted, "Drive/Reserve Drive_wrapper.vi"]));
});

it("does not create the VI while no wrapper exists, but empties an existing one", async () => {
  const f = await fixture();
  await fs.rm(path.join(f.root, "Drive"), { recursive: true }); await fs.rm(path.join(f.root, "Intake"), { recursive: true });
  expect((await syncLabviewWrapperReferences(f.project, { commands: f.commands }, f.cache, f.guard, f.adapter))?.updated).toBe(false);
  await expect(fs.stat(f.references)).rejects.toMatchObject({ code: "ENOENT" });
  await fs.writeFile(f.references, savedVi(wrapperReferencesDescription(wrapperReferencesDigest(f.wanted))));
  expect((await syncLabviewWrapperReferences(f.project, { commands: f.commands }, f.cache, f.guard, f.adapter))?.updated).toBe(true);
  expect(await readWrapperReferencesDigest(f.references)).toBe(wrapperReferencesDigest([]));
});

it("refuses a same-named VI that Bordeaux didn't make", async () => {
  const f = await fixture(); await fs.writeFile(f.references, savedVi("Team-written references"));
  await expect(syncLabviewWrapperReferences(f.project, { commands: f.commands }, f.cache, f.guard, f.adapter)).rejects.toThrow("wasn’t made by Bordeaux");
  expect(f.adapter).not.toHaveBeenCalled(); expect((await fs.readFile(f.references)).toString("latin1")).toContain("Team-written references");
});

it("rejects wrappers from more than one project target", async () => {
  const f = await fixture();
  await expect(syncLabviewWrapperReferences(f.project, { commands: [command("Drive/Calibrate.vi"), command("Intake/Commands/Start Intake.vi", "Other")] }, f.cache, f.guard, f.adapter))
    .rejects.toThrow("more than one project target (Target, Other)");
});

it("fails when LabVIEW does not confirm every reference or the saved digest", async () => {
  const f = await fixture();
  const short = async (requestFile: string, responseFile: string) => { await f.adapter(requestFile, responseFile); const response = JSON.parse(await fs.readFile(responseFile, "utf8")); response.referenceCount--; await fs.writeFile(responseFile, JSON.stringify(response)); };
  await expect(syncLabviewWrapperReferences(f.project, { commands: f.commands }, f.cache, f.guard, short)).rejects.toThrow("did not confirm every reference");
  await fs.writeFile(f.references, savedVi(wrapperReferencesDescription("0".repeat(64))));
  const unsaved = async (requestFile: string, responseFile: string) => { await f.adapter(requestFile, responseFile); await fs.writeFile(f.references, savedVi(wrapperReferencesDescription("0".repeat(64)))); };
  await expect(syncLabviewWrapperReferences(f.project, { commands: f.commands }, f.cache, f.guard, unsaved)).rejects.toThrow("was not saved with the current command wrappers");
  expect(await fs.readdir(f.cache)).toEqual([]);
});

it("stops when the project or document context changes during scripting", async () => {
  const f = await fixture(); let current = true;
  const adapter = async (requestFile: string, responseFile: string) => { await f.adapter(requestFile, responseFile); current = false; };
  await expect(syncLabviewWrapperReferences(f.project, { commands: f.commands }, f.cache, () => { if (!current) throw Error("stale context"); }, adapter)).rejects.toThrow("stale context");
});

it("removes a template it placed when LabVIEW fails, and reports the VI as new once LabVIEW fills it", async () => {
  const f = await fixture();
  const closed = vi.fn(async () => { throw new Error("The selected project is not already open in LabVIEW. Open it, then inspect again."); });
  await expect(syncLabviewWrapperReferences(f.project, { commands: f.commands }, f.cache, f.guard, closed)).rejects.toThrow("not already open");
  await expect(fs.stat(f.references)).rejects.toMatchObject({ code: "ENOENT" });
  // A template left unfilled by an older build (digest "none") still counts as new.
  await fs.copyFile(path.join("resources", "labview-inspection", "CommandWrapperReferences.vi"), f.references);
  expect(await syncLabviewWrapperReferences(f.project, { commands: f.commands }, f.cache, f.guard, f.adapter)).toEqual({ file: f.references, created: true, updated: true });
});

it("never removes a VI it did not place when LabVIEW fails", async () => {
  const f = await fixture(); await fs.writeFile(f.references, savedVi(wrapperReferencesDescription("0".repeat(64))));
  await expect(syncLabviewWrapperReferences(f.project, { commands: f.commands }, f.cache, f.guard, async () => { throw new Error("LabVIEW failed"); })).rejects.toThrow("LabVIEW failed");
  expect(await readWrapperReferencesDigest(f.references)).toBe("0".repeat(64));
});

it("keeps a project-listed wrapper whose command is not inspected, and skips cancel wrappers and other targets", async () => {
  const f = await fixture();
  await fs.mkdir(path.join(f.root, "Support Code")); await fs.writeFile(path.join(f.root, "Support Code", "testCommand_wrapper.vi"), "wrapper");
  await fs.writeFile(path.join(f.root, "Drive", "Stop_cancel_wrapper.vi"), "wrapper");
  const item = (file: string, target = "Target") => ({ name: path.basename(file), type: "VI", target, projectPath: file, file, status: "present" as const, origin: "project" as const });
  const labviewDiscovery = { items: [item("Support Code/testCommand_wrapper.vi"), item("Drive/Stop_cancel_wrapper.vi"), item("Drive/Calibrate_wrapper.vi", "My Computer"), item("Missing_wrapper.vi")] };
  await syncLabviewWrapperReferences(f.project, { commands: f.commands, labviewDiscovery } as never, f.cache, f.guard, f.adapter);
  expect(await readWrapperReferencesDigest(f.references)).toBe(wrapperReferencesDigest([...f.wanted, "Support Code/testCommand_wrapper.vi"]));
});

it.skipIf(process.platform === "win32")("leaves an out-of-date VI for Windows without starting LabVIEW", async () => {
  const f = await fixture();
  expect(await syncLabviewWrapperReferences(f.project, { commands: f.commands }, f.cache, f.guard)).toBeNull();
  await expect(fs.stat(f.references)).rejects.toMatchObject({ code: "ENOENT" });
});

it("ships an empty template that carries the marker", async () => {
  const template = path.join("resources", "labview-inspection", "CommandWrapperReferences.vi");
  expect(await readWrapperReferencesDigest(template)).toBe("none");
});
