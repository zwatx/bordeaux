import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { commandWrapperPath, ensureLabviewCommandWrapper } from "../src/electron/labviewWrappers";
import type { RobotCommandDescriptor } from "../src/shared/types";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-wrappers-"))); roots.push(root);
  const project = path.join(root, "Robot.lvproj"), source = path.join(root, "Calibrate.vi"), wrapper = path.join(root, "Calibrate_wrapper.vi");
  await fs.writeFile(source, "synthetic source bytes");
  const command = { labviewConnector: { file: "Calibrate.vi", terminalNumbers: [7, 0, 8, 11] } } as RobotCommandDescriptor;
  const guard = vi.fn();
  const adapter = vi.fn(async (requestFile: string, responseFile: string) => {
    const request = JSON.parse(await fs.readFile(requestFile, "utf8"));
    expect(request).toMatchObject({ schemaVersion: "bordeaux-ni-wrapper/1", projectFile: project, commandFile: source, terminalCount: 4, terminalNumbers: [7, 0, 8, 11] });
    expect(path.dirname(request.wrapperFile)).toBe(root);
    await fs.writeFile(request.wrapperFile, "synthetic generated VI bytes");
    await fs.writeFile(responseFile, JSON.stringify({ schemaVersion: request.schemaVersion, wrapperFile: request.wrapperFile, terminalCount: 4 }));
  });
  return { root, project, source, wrapper, command, guard, adapter, cache: path.join(root, "cache") };
}
it("names the sibling from the original command basename and scripts only an absent wrapper", async () => {
  const f = await fixture();
  expect(commandWrapperPath(f.project, f.command)).toEqual({ source: f.source, wrapper: f.wrapper });
  expect(await ensureLabviewCommandWrapper(f.project, f.command, f.cache, f.guard, f.adapter)).toEqual({ file: f.wrapper, created: true });
  expect(await fs.readFile(f.wrapper, "utf8")).toBe("synthetic generated VI bytes");
  expect(await ensureLabviewCommandWrapper(f.project, f.command, f.cache, f.guard, f.adapter)).toEqual({ file: f.wrapper, created: false });
  expect(f.adapter).toHaveBeenCalledOnce();
  expect((await fs.readdir(f.root)).some(name => name.startsWith(".bordeaux-wrapper-"))).toBe(false);
  expect(await fs.readdir(f.cache)).toEqual([]);
});
it("preserves an existing team wrapper without invoking NI", async () => {
  const f = await fixture(); await fs.writeFile(f.wrapper, "team wrapper");
  expect((await ensureLabviewCommandWrapper(f.project, f.command, f.cache, f.guard, f.adapter)).created).toBe(false);
  expect(f.adapter).not.toHaveBeenCalled(); expect(await fs.readFile(f.wrapper, "utf8")).toBe("team wrapper");
});
it("preserves an unusable existing wrapper and reports it", async () => {
  const f = await fixture(); await fs.writeFile(f.wrapper, "");
  await expect(ensureLabviewCommandWrapper(f.project, f.command, f.cache, f.guard, f.adapter)).rejects.toThrow("left it unchanged");
  expect(f.adapter).not.toHaveBeenCalled();
});
it("rejects a wrapper as a command source", async () => {
  const f = await fixture(); f.command.labviewConnector!.file = "Calibrate_wrapper.vi";
  await expect(ensureLabviewCommandWrapper(f.project, f.command, f.cache, f.guard, f.adapter)).rejects.toThrow("Rescan command inputs");
});
it("does not publish if the command changes while NI is scripting", async () => {
  const f = await fixture(); const adapter = async (request: string, response: string) => { await f.adapter(request, response); await fs.writeFile(f.source, "changed source"); };
  await expect(ensureLabviewCommandWrapper(f.project, f.command, f.cache, f.guard, adapter)).rejects.toThrow("command changed");
  await expect(fs.stat(f.wrapper)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readdir(f.cache)).toEqual([]);
});
it("does not publish after the document or project context changes", async () => {
  const f = await fixture(); let current = true;
  const adapter = async (request: string, response: string) => { await f.adapter(request, response); current = false; };
  await expect(ensureLabviewCommandWrapper(f.project, f.command, f.cache, () => { if (!current) throw Error("stale context"); }, adapter)).rejects.toThrow("stale context");
  await expect(fs.stat(f.wrapper)).rejects.toMatchObject({ code: "ENOENT" });
});
it("revalidates declaration and dependency evidence after scripting, before publication", async () => {
  const f = await fixture();
  const validate = vi.fn(async () => { if (f.adapter.mock.calls.length) throw Error("type evidence changed"); });
  await expect(ensureLabviewCommandWrapper(f.project, f.command, f.cache, f.guard, f.adapter, validate)).rejects.toThrow("type evidence changed");
  expect(validate).toHaveBeenCalledTimes(2); await expect(fs.stat(f.wrapper)).rejects.toMatchObject({ code: "ENOENT" });
});
it("never replaces a wrapper that appeared during scripting", async () => {
  const f = await fixture(); const adapter = async (request: string, response: string) => { await f.adapter(request, response); await fs.writeFile(f.wrapper, "new team wrapper"); };
  await expect(ensureLabviewCommandWrapper(f.project, f.command, f.cache, f.guard, adapter)).rejects.toThrow("appeared during creation");
  expect(await fs.readFile(f.wrapper, "utf8")).toBe("new team wrapper");
});
it("refuses an incomplete NI response and cleans up staging files", async () => {
  const f = await fixture(); const adapter = async (request: string, response: string) => { await f.adapter(request, response); const report = JSON.parse(await fs.readFile(response, "utf8")); report.terminalCount--; await fs.writeFile(response, JSON.stringify(report)); };
  await expect(ensureLabviewCommandWrapper(f.project, f.command, f.cache, f.guard, adapter)).rejects.toThrow("confirm every command terminal");
  expect((await fs.readdir(f.root)).some(name => name.startsWith(".bordeaux-wrapper-"))).toBe(false);
  await expect(fs.stat(f.wrapper)).rejects.toMatchObject({ code: "ENOENT" });
});
