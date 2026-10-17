import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLabviewCatalog, discoverLabviewProject, isLabviewProject, resolveLabviewProject } from "../src/electron/labviewProject";

const roots: string[] = [];
async function fixture(xml: string) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-lv-discovery-")));
  roots.push(root);
  await fs.writeFile(path.join(root, "Robot.lvproj"), xml);
  return root;
}
async function write(root: string, file: string, contents = "source hashing sentinel; not a LabVIEW binary") {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), contents);
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

describe("native LabVIEW project source discovery", () => {
  it("preserves distinct differently cased files on a case-sensitive host filesystem", async ({ skip }) => {
    const root = await fixture("<Project/>"), upper = path.join(root, "Robot.lvproj"), lower = path.join(root, "robot.lvproj");
    try { await fs.writeFile(lower, "<Project/>", { flag: "wx" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return skip(); throw error; }
    expect((await resolveLabviewProject(upper, { canonical: true })).projectFile).toBe(upper);
    expect((await resolveLabviewProject(lower, { canonical: true })).projectFile).toBe(lower);
  });

  it("canonicalizes Windows drive and parent spelling only after original-component checks (simulated filesystem)", async () => {
    // Run the actual exported resolver with win32 path semantics and a declared case-insensitive FS adapter.
    // This is not native Windows, an NI test, or a substitute for the real Link/Save/export host regression.
    const selected = "c:\\repo\\pathSproject\\rOBOT.lvproj", canonical = "C:\\Repo\\PathsProject\\Robot.lvproj";
    const seen: string[] = [];
    const lstat = vi.fn(async (file: string) => {
      seen.push(file);
      const isFile = path.win32.extname(file).toLowerCase() === ".lvproj";
      return { isFile: () => isFile, isDirectory: () => !isFile, isSymbolicLink: (): boolean => false, dev: 1, ino: isFile ? 2 : 1 };
    });
    const realpath = vi.fn(async (file: string) => { expect(seen).toContain(selected); expect(file).toBe(selected); return canonical; });
    const sandbox = { fs: { lstat, realpath }, path: path.win32, exports: {} as Record<string, (...args: any[]) => any> };
    const text = await fs.readFile("src/electron/labviewProjectDiscovery.ts", "utf8");
    const ast = ts.createSourceFile("labviewProjectDiscovery.ts", text, ts.ScriptTarget.Latest, true);
    for (const name of ["statLabviewLocalPath", "resolveLabviewProject"]) {
      const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
      if (!declaration) throw new Error(`Missing actual resolver function ${name}`);
      vm.runInNewContext(ts.transpileModule(declaration.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, sandbox);
    }
    expect(await sandbox.exports.resolveLabviewProject(selected, { canonical: true })).toEqual({ root: path.win32.dirname(canonical), projectFile: canonical });
    expect(realpath).toHaveBeenCalledOnce();
    expect(seen).toContain("c:\\repo"); expect(seen).toContain(canonical);
    realpath.mockClear();
    expect(await sandbox.exports.resolveLabviewProject(selected)).toEqual({ root: path.win32.dirname(selected), projectFile: selected });
    expect(realpath).not.toHaveBeenCalled();
    lstat.mockImplementation(async () => ({ isFile: () => false, isDirectory: () => true, isSymbolicLink: () => true, dev: 1, ino: 1 }));
    await expect(sandbox.exports.resolveLabviewProject(selected, { canonical: true })).rejects.toThrow("links and junctions");
    expect(realpath).not.toHaveBeenCalled();
  });

  it("expands NI.DISK folders using document-file relative URLs and preserves source previews", async () => {
    const root = await fixture(`<Project><Item Name="My Computer" Type="My Computer"><Item Name="Timer.vi" Type="VI" URL="../Support Code/Timer.vi"/></Item>
      <Item Name="Target" Type="RT myRIO"><Item Name="Drive" Type="Folder" URL="../Drive"><Property Name="NI.DISK" Type="Bool">true</Property></Item>
      <Item Name="Dependencies" Type="Dependencies"><Item Name="Dependency.vi" Type="VI" URL="../Dependency.vi"/></Item>
      <Item Name="Build Specifications" Type="Build"><Item Name="Build.vi" Type="VI" URL="../Build.vi"/></Item></Item></Project>`);
    await write(root, "Support Code/Timer.vi");
    await write(root, "Drive/Commands/Start.vi");
    await write(root, "Drive/Commands/Start_wrapper.vi");
    await write(root, "Drive/Commands/Template.vit");
    await write(root, "Drive/Command Status Info.ctl");
    await write(root, "Dependency.vi");
    await write(root, "Build.vi");
    const catalog = await discoverLabviewProject(root);
    expect(catalog.projectName).toBe("Robot");
    expect(catalog.sourceFileCount).toBe(3);
    expect(catalog.labviewDiscovery?.targets).toEqual([{ name: "My Computer", type: "My Computer" }, { name: "Target", type: "RT myRIO" }]);
    expect(catalog.labviewDiscovery?.items).toContainEqual(expect.objectContaining({ file: "Drive/Commands/Start.vi", target: "Target", origin: "autoFolder", status: "present" }));
    expect(catalog.labviewDiscovery?.items.some((item) => /Dependency|Build\.vi/.test(item.name))).toBe(false);
    expect(catalog.commands).toEqual([]);
    expect(catalog.authoritative).toBe(false);
    expect(catalog.labviewDiscovery?.commandContract.status).toBe("requires-declaration");
  });

  it("scans a project-directory auto folder and expands library and class members for each target", async () => {
    const root = await fixture(`<Project><Item Name="Computer" Type="My Computer"><Item Name="Planner" Type="Folder" URL=".."><Property Name="NI.DISK" Type="Bool">true</Property></Item></Item>
      <Item Name="Robot" Type="RT myRIO"><Item Name="Shared" Type="Library" URL="../Libraries/Shared.lvlib"/></Item></Project>`);
    await write(root, "Libraries/Shared.lvlib", `<Library><Item Name="Virtual" Type="Folder"><Item Name="External.vi" Type="VI" URL="../../Members/External.vi"/></Item><Item Name="Child" Type="LVClass" URL="../Child.lvclass"/></Library>`);
    await write(root, "Libraries/Child.lvclass", `<LVClass><Item Name="Method.vi" Type="VI" URL="../../Members/Method.vi"/><Item Name="Cycle" Type="Library" URL="../Shared.lvlib"/></LVClass>`);
    await write(root, "Members/External.vi");
    await write(root, "Members/Method.vi");
    const catalog = await discoverLabviewProject(root);
    const member = catalog.labviewDiscovery!.items.filter((item) => item.file === "Members/External.vi" && item.origin === "library");
    expect(member.map((item) => item.target).sort()).toEqual(["Computer", "Robot"]);
    expect(catalog.labviewDiscovery!.items.filter((item) => item.file === "Members/Method.vi" && item.origin === "library")).toHaveLength(2);
    expect(catalog.sourceFileCount).toBe(2);
    expect(catalog.labviewDiscovery!.truncated).toBe(false);
  });

  it("reports missing and unsupported references without following network paths or junctions", async () => {
    const root = await fixture(`<Project><Item Name="Target" Type="RT myRIO">
      <Item Name="Missing.vi" Type="VI" URL="../Missing.vi"/>
      <Item Name="Remote.vi" Type="VI" URL="//server/share/Remote.vi"/>
      <Item Name="NI.vi" Type="VI" URL="&lt;vilib&gt;/NI.vi"/>
      <Item Name="Linked.vi" Type="VI" URL="../linked/Linked.vi"/>
      <Item Name="Malformed.lvlib" Type="Library" URL="../Malformed.lvlib"/>
      </Item></Project>`);
    const outside = await fixture("<Project/>");
    await write(outside, "Linked.vi");
    await fs.symlink(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    await write(root, "Malformed.lvlib", "<Library><Item Name=\"Broken\">");
    const catalog = await discoverLabviewProject(root);
    expect(catalog.labviewDiscovery?.items.map((item) => [item.name, item.status])).toEqual([
      ["Missing.vi", "missing"], ["Remote.vi", "unsupported"], ["NI.vi", "unsupported"], ["Linked.vi", "unsupported"], ["Malformed.lvlib", "unsupported"],
    ]);
    expect(catalog.sourceFileCount).toBe(0);
    expect(catalog.warnings.some((warning) => warning.includes("junction"))).toBe(true);
  });

  it("reads explicit external relative members and XML escaped names without guessing from other project copies", async () => {
    const parent = await fixture("<Project/>");
    const root = path.join(parent, "Robot Code");
    await write(root, "Robot.lvproj", `<Project><Item Name="Target" Type="RT myRIO"><Item Name="Swerve &amp; Drive.vi" Type="VI" URL="../../shared/Swerve &amp; Drive.vi"/></Item></Project>`);
    await write(parent, "shared/Swerve & Drive.vi");
    const catalog = await discoverLabviewProject(path.join(root, "Robot.lvproj"));
    expect(catalog.labviewDiscovery!.items[0]).toMatchObject({ name: "Swerve & Drive.vi", file: "../shared/Swerve & Drive.vi", status: "present" });
    expect(catalog.sourceFileCount).toBe(1);
  });

  it("preserves nested FPGA target identity beneath an RT chassis", async () => {
    const root = await fixture('<Project><Item Name="Robot" Type="RT myRIO"><Item Name="Chassis" Type="Chassis"><Item Name="FPGA" Type="FPGA Target"><Item Name="Logic.vi" Type="VI" URL="../Logic.vi"/></Item></Item><Item Name="Virtual folder" Type="Folder"><Item Name="Logic.vi" Type="VI" URL="../Logic.vi"/></Item></Item></Project>');
    await write(root, "Logic.vi");
    const result = await discoverLabviewProject(root);
    expect(result.labviewDiscovery?.targets).toEqual([{ name: "Robot", type: "RT myRIO" }, { name: "Robot/Chassis/FPGA", type: "FPGA Target" }]);
    expect(result.labviewDiscovery?.items.filter((item) => item.file === "Logic.vi").map((item) => item.target)).toEqual(["Robot/Chassis/FPGA", "Robot"]);
  });

  it("requires explicit selection for multiple projects and binds builds to the selected project", async () => {
    const root = await fixture("<Project/>");
    await write(root, "Other.lvproj", "<Project/>");
    await write(root, "Handler.vi");
    await write(root, "bordeaux-catalog.json", JSON.stringify({ schemaVersion: "bordeaux-labview-catalog/1", catalogId: "robot", commands: [{ id: "start", label: "Start", vi: "Handler.vi" }] }));
    const selected = path.join(root, "Robot.lvproj");
    expect(await isLabviewProject(root)).toBe(true);
    expect(await isLabviewProject(selected)).toBe(true);
    await expect(resolveLabviewProject(root)).rejects.toThrow(/multiple/);
    await buildLabviewCatalog(selected);
    expect((await discoverLabviewProject(selected)).authoritative).toBe(true);
    expect((await discoverLabviewProject(path.join(root, "Other.lvproj"))).authoritative).toBe(false);
  });

  it("surfaces missing declared handlers before a first build, and invalidates edited VI bindings", async () => {
    const root = await fixture("<Project/>");
    await write(root, "bordeaux-catalog.json", JSON.stringify({ schemaVersion: "bordeaux-labview-catalog/1", catalogId: "robot", commands: [{ id: "start", label: "Start", vi: "Handler.vi" }] }));
    const missing = await discoverLabviewProject(root);
    expect(missing.commands[0].runtimeReady).toBe(false);
    expect(missing.warnings.some((warning) => warning.includes("Handler.vi"))).toBe(true);
    await expect(buildLabviewCatalog(root)).rejects.toThrow(/ENOENT/);
    await write(root, "Handler.vi");
    await buildLabviewCatalog(root);
    expect((await discoverLabviewProject(root)).authoritative).toBe(true);
    await write(root, "Handler.vi", "changed hashing sentinel");
    expect((await discoverLabviewProject(root)).authoritative).toBe(false);
  });

  it("rejects malformed, entity-bearing and excessive-depth project XML", async () => {
    for (const xml of ["<Project><Item>", '<!DOCTYPE Project [<!ENTITY x "value">]><Project/>', `<Project>${"<Item>".repeat(50)}${"</Item>".repeat(50)}</Project>`]) {
      await expect(discoverLabviewProject(await fixture(xml))).rejects.toThrow();
    }
  });

  it("limits deep auto-populating trees and explains incomplete previews", async () => {
    const root = await fixture('<Project><Item Name="Computer" Type="My Computer"><Item Name="Sources" Type="Folder" URL="../Sources"><Property Name="NI.DISK" Type="Bool">true</Property></Item></Item></Project>');
    await write(root, `Sources/${Array.from({ length: 50 }, () => "a").join("/")}/Deep.vi`);
    const catalog = await discoverLabviewProject(root);
    expect(catalog.labviewDiscovery?.truncated).toBe(true);
    expect(catalog.warnings.some((warning) => warning.includes("incomplete"))).toBe(true);
    expect(catalog.commands).toEqual([]);
  });
});
