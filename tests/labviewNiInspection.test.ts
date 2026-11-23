import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeLabviewNiInspection } from "../src/electron/labviewNiTypes";
import { eligibleLabviewLegacySource, inspectLabviewCommands, labviewCommandSourceChanges, refreshLabviewCommands, withCachedLabviewCommands, withSessionLabviewCommands } from "../src/electron/labviewNiInspection";
import { discoverLabviewProject } from "../src/electron/labviewProject";
import { bdxBindingsFromCatalog, commandListEvidence, prepareBdxBindings, prepareCommandListBindings } from "../src/electron/bdxBindings";
import { robotInvocationErrors } from "../src/core/robotCommands";
import { buildRobotBinary } from "../src/core/export/robotBinary";
import { decodeCommandsFile, encodeCommandsFile } from "../src/core/export/commandsFile";
import { binaryWriterFixture } from "./fixtures/binaryWriterFixture";

// Sanitized shape of NI 2025 _ExportInterface2 output. No private VI binary is included.
const statusXml = (name: string) => `<Cluster><Name>${name}</Name><NumElts>3</NumElts><String><Name>Name</Name><Val/></String><EW><Name>Status</Name><Choice>Successful</Choice><Choice>Aborted</Choice><Choice>Incomplete</Choice><Val>0</Val></EW><Refnum><Name>notifier out</Name><RefKind>Notifier</RefKind><Val>0x00000000</Val></Refnum></Cluster>`;
const statusMetadata = (name: string) => [[[[name], "C:\\NI\\Framework\\Command Status Info.ctl", false, 0, []]]];
const source = { file: "Intake/Commands/Start.vi", target: "Robot" };
const completionOutput = { name: "Command Info Out.Status", label: "Completion status", terminalNumber: 0,
  fieldPath: ["Command Info Out", "Status"], schema: { kind: "enum", valueType: "Enum", enumValues: ["Successful", "Aborted", "Incomplete"] } };
function row(extraXml = "<DBL><Name>Setpoint</Name><Val>0</Val></DBL>") {
  return { ...source, name: "Start.vi", description: "Immediate subsystem action", execState: 1, status: "inspected", modifiedBefore: false, modifiedAfter: false,
    dependenciesAvailable: true, dependencies: [], defaults: { Setpoint: 0, Description: "" } as Record<string, unknown>,
    connector: { numConnections: 4, captions: ["Description", "Command Info Out", "Command Info In", "Setpoint"],
      wireRequirements: [1, 1, 1, 1], ioStatus: [0, 1, 0, 0], conNum: [7, 0, 8, 11],
      dataTypes: ["<String><Name>Description</Name><Val/></String>", statusXml("Command Info Out"), statusXml("Command Info In"), extraXml],
      extendedInformation: [[[]], statusMetadata("Command Info Out"), statusMetadata("Command Info In"), [[]]] as unknown[],
    } };
}
/** The report row with its status typedefs at the fixture's real path (absolute on every platform). */
function fixtureRow(typedef: string) {
  const vi = row();
  vi.connector.extendedInformation[1] = [[[["Command Info Out"], typedef, false, 0, []]]];
  vi.connector.extendedInformation[2] = [[[["Command Info In"], typedef, false, 0, []]]];
  return vi;
}
function addOutput(vi: ReturnType<typeof row>, name: string, xml: string, terminalNumber = 12) {
  vi.connector.numConnections += 1;
  vi.connector.captions.push(name); vi.connector.wireRequirements.push(1); vi.connector.ioStatus.push(1); vi.connector.conNum.push(terminalNumber);
  vi.connector.dataTypes.push(xml); vi.connector.extendedInformation.push([[]]);
}
function report(vi = row()) {
  return { schemaVersion: "bordeaux-ni-inspection/1", projectFile: "C:\\Robot\\Robot.lvproj", labviewVersion: "25.3.3f3", inspectedAt: "2026-09-07T12:00:00.000Z", dirtyContext: false, vis: [vi] };
}
function decode(value = report()) { return decodeLabviewNiInspection(value, "C:\\Robot\\Robot.lvproj", [source]); }
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
async function cacheFixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-ni-cache-"))); roots.push(root);
  const project = path.join(root, "Robot.lvproj");
  const cache = path.join(root, "cache");
  const typedef = path.join(root, "Command Status Info.ctl");
  await fs.mkdir(path.join(root, "Intake/Commands"), { recursive: true });
  await fs.writeFile(path.join(root, source.file), "hashing sentinel, not a LabVIEW binary");
  await fs.writeFile(typedef, "type hashing sentinel, not a LabVIEW binary");
  // A typedef saved during an inspection stays unverified; this one was saved well before.
  const earlier = new Date(Date.now() - 3600_000); await fs.utimes(typedef, earlier, earlier);
  await fs.writeFile(project, '<Project><Item Name="Robot" Type="RT myRIO"><Item Name="Command Status Info.ctl" Type="VI" URL="../Command Status Info.ctl"/><Item Name="Intake" Type="Folder" URL="../Intake"><Property Name="NI.DISK" Type="Bool">true</Property></Item></Item></Project>');
  const adapter = async (requestFile: string, responseFile: string) => {
    const request = JSON.parse(await fs.readFile(requestFile, "utf8"));
    expect(request.sources.map((item: { file: string; target: string }) => ({ file: item.file, target: item.target }))).toEqual([source]);
    const vi = row();
    addOutput(vi, "Acquired", "<Boolean><Name>Acquired</Name><Val>0</Val></Boolean>");
    vi.connector.extendedInformation[1] = [[[["Command Info Out"], typedef, false, 0, []]]];
    vi.connector.extendedInformation[2] = [[[["Command Info In"], typedef, false, 0, []]]];
    await fs.writeFile(responseFile, JSON.stringify({ ...report(vi), projectFile: project }));
  };
  return { root, project, cache, typedef, adapter };
}

describe("NI legacy connector discovery", () => {
  it("stops scheduling on a fingerprint failure and drains in-flight reads before returning", async () => {
    const f = await cacheFixture();
    for (let index = 1; index < 40; index++) await fs.writeFile(path.join(f.root, "Intake", "Commands", `Extra${index}.vi`), `VI ${index}`);
    await fs.writeFile(f.project, '<Project><Item Name="Robot" Type="RT myRIO"><Item Name="Intake" Type="Folder" URL="../Intake"><Property Name="NI.DISK" Type="Bool">true</Property></Item></Item></Project>');
    const read = fs.readFile.bind(fs), adapter = vi.fn();
    let reads = 0, active = 0;
    const spy = vi.spyOn(fs, "readFile").mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
      if (!String(args[0]).endsWith('.vi')) return read(...args);
      if (++reads === 1) throw Error('fingerprint read failed');
      active++;
      try { await new Promise(resolve => setTimeout(resolve, 20)); return await read(...args); }
      finally { active--; }
    }) as typeof fs.readFile);
    try {
      await expect(inspectLabviewCommands(f.project, f.cache, adapter)).rejects.toThrow('fingerprint read failed');
      expect(active).toBe(0); expect(reads).toBeLessThanOrEqual(8); expect(adapter).not.toHaveBeenCalled();
      const stopped = reads;
      await new Promise(resolve => setTimeout(resolve, 30)); expect(reads).toBe(stopped);
    } finally { spy.mockRestore(); }
  });
  it("bounds concurrent fingerprints and reads each shared VI once per validation snapshot", async () => {
    const f = await cacheFixture();
    try {
      for (let index = 1; index < 20; index++) await fs.writeFile(path.join(f.root, "Intake", "Commands", `Extra${index}.vi`), `VI ${index}`);
      const folder = '<Item Name="Intake" Type="Folder" URL="../Intake"><Property Name="NI.DISK" Type="Bool">true</Property></Item>';
      await fs.writeFile(f.project, `<Project><Item Name="Robot" Type="RT myRIO">${folder}</Item><Item Name="Other" Type="RT roboRIO">${folder}</Item></Project>`);
      const read = fs.readFile.bind(fs);
      let active = 0, peak = 0, reads = 0;
      const spy = vi.spyOn(fs, "readFile").mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
        if (!String(args[0]).endsWith('.vi')) return read(...args);
        reads++; peak = Math.max(peak, ++active);
        try { await new Promise(resolve => setTimeout(resolve, 5)); return await read(...args); }
        finally { active--; }
      }) as typeof fs.readFile);
      try {
        await inspectLabviewCommands(f.project, f.cache, async (requestFile, responseFile) => {
          const request = JSON.parse(await read(requestFile, "utf8"));
          expect(request.sources).toHaveLength(40);
          await fs.writeFile(responseFile, JSON.stringify({ ...report(), projectFile: f.project,
            vis: request.sources.map((item: { file: string; target: string }) => ({ ...item, status: 'nonCommand', viType: 3, modifiedBefore: false, modifiedAfter: false })) }));
        });
        expect(reads).toBe(40); // Twenty unique VIs, before and after inspection; no cross-snapshot memoization.
        expect(peak).toBeGreaterThan(1); expect(peak).toBeLessThanOrEqual(8);
      } finally { spy.mockRestore(); }
    } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  });
  it("exports newly inspected commands by original basename without any filename registration", () => {
    for (const file of ["Intake/Commands/Start.vi", "New subsystem/Brand new action.vi"]) {
      const vi = { ...row(), file, defaults: { Description: "saved text", Setpoint: -0.625 } };
      const result = decodeLabviewNiInspection(report(vi), "C:\\Robot\\Robot.lvproj", [{ file, target: vi.target }]);
      expect(result.commands).toHaveLength(1);
      const command = result.commands[0], f = binaryWriterFixture(false, false);
      expect(command.id).toMatch(/^labview\.legacy\.[0-9a-f]{24}$/);
      f.bindings = bdxBindingsFromCatalog({ ...f.bindings.catalog, commands: result.commands });
      f.path.markers = [{ id: "discovered-event", name: "Independent marker label", f: 1,
        invocation: { commandId: command.id, arguments: {}, cancelOnPathEnd: false } }];
      const built = buildRobotBinary(f.project, { kind: "path", id: f.path.id }, f.bindings);
      const bytes = Buffer.from(built.bytes);
      expect(bytes.includes(Buffer.from(file.split("/").at(-1)!))).toBe(true);
      expect(bytes.includes(Buffer.from(command.id))).toBe(false);
      expect(built.eventCount).toBe(1);
      expect(built.document.paths[0].events[0].arguments).toEqual({ Description: "saved text", Setpoint: -0.625 });
    }
  });

  it("recognizes the exact root typedef pair and preserves typed arguments without authorizing execution", () => {
    const result = decode();
    expect(result.commands).toHaveLength(1);
    const command = result.commands[0];
    expect(command).toMatchObject({ member: source.file, confidence: "confirmed", runtimeReady: false, labviewLegacy: true });
    expect(command.parameters).toMatchObject([{ name: "Description", schema: { kind: "string" }, defaultValue: "" }, { name: "Setpoint", schema: { kind: "number", valueType: "DBL" }, defaultValue: 0 }]);
    expect(command.outputs).toEqual([completionOutput]);
    expect(robotInvocationErrors({ commandId: command.id, arguments: { Description: "", Setpoint: "wrong type" } }, command)).toContain("Setpoint must be a finite number");
    expect(command.labviewConnector).toMatchObject({ terminalNumbers: row().connector.conNum, typeXml: row().connector.dataTypes,
      directions: row().connector.ioStatus, defaults: row().defaults });
    expect(result.cacheable).toBe(true);
    expect(result.dependencyPaths).toEqual(["C:\\NI\\Framework\\Command Status Info.ctl"]);
  });

  it("maps observed EW choices and saved numeric enum defaults to labels", () => {
    const vi = row("<EW><Name>Operation</Name><Choice>Reserve</Choice><Choice>Start</Choice><Val>0</Val></EW>");
    vi.defaults = { Description: "", Operation: 1 };
    const result = decode(report(vi));
    expect(result.commands[0].parameters[1]).toMatchObject({ name: "Operation", schema: { kind: "enum", enumValues: ["Reserve", "Start"] }, defaultValue: "Start" });
    vi.defaults.Operation = 2;
    expect(decode(report(vi)).commands).toEqual([]);
    expect(decode(report(vi)).inspection.unsupported[0].reason).toMatch(/saved enum default/);
  });

  it("retains typed inputs when a legacy command also has additional output terminals", () => {
    const vi = row();
    addOutput(vi, "Sensor reading", "<DBL><Name>Reading</Name><Val>0</Val></DBL>");
    const result = decode(report(vi));
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0].parameters.map((parameter) => parameter.name)).toEqual(["Description", "Setpoint"]);
    expect(result.commands[0].outputs).toEqual([{ name: "Reading", label: "Sensor reading", terminalNumber: 12, schema: { kind: "number", valueType: "DBL" } }, completionOutput]);
    expect(result.commands[0].description).toBe(vi.description);
    expect(result.commands[0].runtimeReady).toBe(false);
    expect(result.inspection.unsupported).toEqual([]);
  });

  it("represents Boolean, named, and numeric results without treating saved indicators as results", () => {
    const vi = row();
    addOutput(vi, "Acquired", "<Boolean><Name>Acquired</Name><Val>1</Val></Boolean>");
    addOutput(vi, "Outcome", "<EW><Name>Outcome</Name><Choice>Ready</Choice><Choice>Empty</Choice><Val>1</Val></EW>", 13);
    addOutput(vi, "Count", "<U64><Name>Count</Name><Val>18446744073709551615</Val></U64>", 14);
    vi.defaults.Outcome = 500;
    const result = decode(report(vi));
    expect(result.commands[0].outputs).toEqual([
      { name: "Acquired", terminalNumber: 12, schema: { kind: "boolean", valueType: "Boolean" } },
      { name: "Outcome", terminalNumber: 13, schema: { kind: "enum", valueType: "Enum", enumValues: ["Ready", "Empty"] } },
      { name: "Count", terminalNumber: 14, min: "0", max: "18446744073709551615", schema: { kind: "integerString", valueType: "U64" } },
      completionOutput,
    ]);
    expect(result.inspection.unsupported).toEqual([]);
  });

  it("offers completion branches for every legacy command even without extra result terminals", () => {
    const vis = ["Calibrate", "Drive Immediate", "Reserve Drive", "Config Drive Pipeline Command"].map(name => ({ ...row(), file: `Drive/Commands/${name}.vi` }));
    const decoded = decodeLabviewNiInspection({ ...report(), vis }, "C:\\Robot\\Robot.lvproj", vis);
    expect(decoded.commands).toHaveLength(4);
    for (const command of decoded.commands) {
      expect(command.outputs).toEqual([completionOutput]);
      expect(command.parameters.some(parameter => parameter.name.includes("Command Info"))).toBe(false);
    }
  });

  it("does not guess between a completion field and a terminal with the same result name", () => {
    const vi = row();
    addOutput(vi, completionOutput.name, `<Boolean><Name>${completionOutput.name}</Name><Val>0</Val></Boolean>`);
    const decoded = decode(report(vi));
    expect(decoded.commands[0].outputs).toEqual([{ name: completionOutput.name, terminalNumber: 12, schema: { kind: "boolean", valueType: "Boolean" } }]);
    expect(decoded.inspection.unsupported[0].reason).toMatch(/conflicts/);
  });

  it("reports unsupported and ambiguous outputs while keeping valid arguments and other results", () => {
    const vi = row();
    addOutput(vi, "Handle", "<Refnum><Name>Handle</Name><RefKind>LV Object</RefKind></Refnum>");
    addOutput(vi, "Ready", "<Boolean><Name>Ready</Name><Val>1</Val></Boolean>", 13);
    addOutput(vi, "Count", "<I32><Name>Count</Name><Val>0</Val></I32>", 14);
    addOutput(vi, "Count again", "<I32><Name>Count</Name><Val>0</Val></I32>", 15);
    const result = decode(report(vi));
    expect(result.commands[0].parameters.map((parameter) => parameter.name)).toEqual(["Description", "Setpoint"]);
    expect(result.commands[0].outputs?.map((output) => output.name)).toEqual(["Ready", completionOutput.name]);
    expect(result.inspection.unsupported).toHaveLength(3);
    expect(result.inspection.unsupported[0].reason).toMatch(/Output Handle \(terminal 12\).*type mapping/);
    expect(result.inspection.unsupported[1].reason).toMatch(/unique terminal names/);
  });

  it("never infers commands from matching status names, nested typedefs, wrappers or plain VIs", () => {
    const vi = row();
    vi.connector.extendedInformation[1] = [[[["Container", "Command Info Out"], "C:\\NI\\Command Status Info.ctl", false, 0, []]]];
    expect(decode(report(vi)).commands).toEqual([]);
    vi.connector.extendedInformation[1] = [[]];
    expect(decode(report(vi)).commands).toEqual([]);
    const wrapper = row();
    wrapper.connector = { numConnections: 0, captions: [], wireRequirements: [], ioStatus: [], conNum: [], dataTypes: [], extendedInformation: [] };
    expect(decode(report(wrapper)).commands).toEqual([]);
  });

  it("retains explanations for unsupported refnums and ambiguous cluster fields", () => {
    for (const xml of ["<Refnum><Name>Robot</Name><RefKind>LV Object</RefKind></Refnum>", "<Cluster><Name>Auto Data</Name><NumElts>2</NumElts><DBL><Name>x</Name><Val/></DBL><DBL><Name>x</Name><Val/></DBL></Cluster>"]) {
      const result = decode(report(row(xml)));
      expect(result.commands).toEqual([]);
      expect(result.inspection.unsupported).toHaveLength(1);
      expect(result.inspection.unsupported[0].reason).toMatch(/type mapping|unique/);
    }
  });

  it("validates named clusters and one-dimensional arrays through shared schemas", () => {
    const vi = row("<Cluster><Name>Options</Name><NumElts>2</NumElts><Boolean><Name>Enabled</Name><Val>1</Val></Boolean><Array><Name>Samples</Name><Dimsize>0</Dimsize><DBL><Name>Value</Name><Val/></DBL></Array></Cluster>");
    vi.defaults = { Description: "" };
    expect(decode(report(vi)).commands[0].parameters[1].schema).toMatchObject({ kind: "object", fields: [{ name: "Enabled", schema: { kind: "boolean" } }, { name: "Samples", schema: { kind: "array", element: { kind: "number" } } }] });
  });

  it("does not lose unsigned bounds inside arrays or clusters", () => {
    for (const type of ["U8", "U16", "U32", "U64"]) {
      for (const xml of [`<Array><Name>Values</Name><Dimsize>0</Dimsize><${type}><Name>Value</Name><Val/></${type}></Array>`, `<Cluster><Name>Options</Name><NumElts>1</NumElts><${type}><Name>Value</Name><Val/></${type}></Cluster>`]) {
        const result = decode(report(row(xml)));
        expect(result.commands).toEqual([]);
        expect(result.inspection.unsupported[0].reason).toMatch(/Nested NI.*bounds/);
      }
    }
    const vi = row("<U8><Name>Value</Name><Val>0</Val></U8>"); vi.defaults = { Description: "", Value: 0 };
    const command = decode(report(vi)).commands[0];
    expect(command.parameters[1]).toMatchObject({ min: 0, max: 255 });
    expect(robotInvocationErrors({ commandId: command.id, arguments: { Description: "", Value: -1 } }, command)).toContain("Value is outside the range for U8");
    expect(robotInvocationErrors({ commandId: command.id, arguments: { Description: "", Value: 256 } }, command)).toContain("Value is outside the range for U8");
  });

  it("rejects unsupported ABI versions, wrong project provenance and incomplete reports", () => {
    const value = report(); value.labviewVersion = "27.0.0b1";
    expect(() => decode(value)).toThrow(/Unsupported NI/);
    value.labviewVersion = "25.3.3f3"; value.projectFile = "C:\\Other.lvproj";
    expect(() => decode(value)).toThrow(/different project/);
    expect(() => decode({ ...report(), vis: [] })).toThrow(/every requested/);
  });

  it("does not accept malformed array layouts, unsafe XML, duplicate names or incorrect status direction", () => {
    const incomplete = row(); incomplete.connector.ioStatus.pop();
    expect(decode(report(incomplete)).inspection.unsupported[0].reason).toMatch(/connector count/);
    const outputPair = row(); outputPair.connector.ioStatus[2] = 1;
    expect(decode(report(outputPair)).commands).toEqual([]);
    const malformed = row("<DBL><Name>Setpoint</Name>");
    expect(decode(report(malformed)).commands).toEqual([]);
    const duplicate = row("<String><Name>Description</Name><Val/></String>");
    expect(decode(report(duplicate)).inspection.unsupported[0].reason).toMatch(/duplicat/i);
  });

  it("explains unavailable metadata for VIs broken only in the desktop inspection context", () => {
    const vi = row(); vi.execState = 0; vi.connector.dataTypes = ["", "", "", ""];
    const result = decode(report(vi));
    expect(result.commands).toEqual([]);
    expect(result.inspection.applicationContext).toBe("My Computer");
    expect(result.inspection.unsupported[0].reason).toBe("NI connector metadata unavailable: VI is broken in the My Computer inspection context; target behavior was not inspected.");
    expect(result.cacheable).toBe(true);
  });

  it("keeps unsaved or unknown dependency state live-only", () => {
    const value = report(); value.dirtyContext = true;
    expect(decode(value)).toMatchObject({ cacheable: false, inspection: { commandCount: 1 } });
    const vi = row(); vi.modifiedBefore = true;
    expect(decode(report(vi)).cacheable).toBe(false);
    vi.modifiedBefore = false; vi.dependenciesAvailable = false;
    expect(decode(report(vi)).cacheable).toBe(false);
  });

  it("caches the verified command subset despite clean global and unsupported non-command sources", () => {
    const global = { file: "Intake/Published Globals.vi", target: "Robot" };
    const unavailable = { file: "Drive/Unavailable.vi", target: "Robot" };
    const value = { ...report(), vis: [row(), { ...global, status: "nonCommand", viType: 3, modifiedBefore: false, modifiedAfter: false },
      { ...unavailable, status: "unsupported", reason: "NI did not expose this connector", modifiedBefore: false, modifiedAfter: false }] };
    const decodeSubset = () => decodeLabviewNiInspection(value, "C:\\Robot\\Robot.lvproj", [source, global, unavailable]);
    expect(decodeSubset()).toMatchObject({ cacheable: true, inspection: { commandCount: 1, unsupported: [{ file: unavailable.file }] } });
    value.vis[1].modifiedBefore = true;
    expect(decodeSubset()).toMatchObject({ cacheable: false, inspection: { commandCount: 1 } });
    expect(decodeSubset().inspection.reason).toContain("NI reports unsaved VI changes");
    value.vis[1].modifiedBefore = false;
    delete (value.vis[2] as Record<string, unknown>).modifiedAfter;
    expect(decodeSubset().cacheable).toBe(false);
    expect(decodeSubset().inspection.reason).toContain("did not provide VI saved-state metadata");
  });

  it("excludes infrastructure and generated wrappers from command discovery", () => {
    const item = { name: "Start_wrapper.vi", type: "VI", target: "Robot", projectPath: "Robot/Intake/Commands/Start_wrapper.vi", file: "Intake/Commands/Start_wrapper.vi", status: "present" as const, origin: "autoFolder" as const };
    expect(eligibleLabviewLegacySource(item)).toBe(false);
    expect(eligibleLabviewLegacySource({ ...item, name: "Start.vi", file: "Intake/Commands/Start.vi" })).toBe(true);
    expect(eligibleLabviewLegacySource({ ...item, projectPath: "Robot/Support Code/Start.vi" })).toBe(false);
    expect(eligibleLabviewLegacySource({ ...item, projectPath: "Robot/Framework/Start.vi" })).toBe(false);
    expect(eligibleLabviewLegacySource({ ...item, name: "Intake Command Helper.vi copy.vi" })).toBe(false);
  });

  it("retains declared IDs while attaching matching saved NI types and rejects conflicting declarations", async () => {
    const fixture = await cacheFixture();
    const declaration = { schemaVersion: "bordeaux-labview-catalog/1", catalogId: "team", commands: [{
      id: "team.intake.start", label: "Team intake", vi: source.file, parameters: [
        { name: "Description", schema: { kind: "string" } },
        { name: "Setpoint", schema: { kind: "number" } },
      ],
    }] };
    await fs.writeFile(path.join(fixture.root, "bordeaux-catalog.json"), JSON.stringify(declaration));
    const inspected = await inspectLabviewCommands(fixture.project, fixture.cache, fixture.adapter);
    expect(inspected.commands).toHaveLength(1);
    expect(inspected.commands[0]).toMatchObject({ id: "team.intake.start", label: "Team intake", labviewConnector: { file: source.file } });
    expect(inspected.commands[0].outputs).toMatchObject([{ name: "Acquired", terminalNumber: 12, schema: { kind: "boolean" } }, completionOutput]);
    const cached = await withCachedLabviewCommands(fixture.project, await discoverLabviewProject(fixture.project), fixture.cache);
    expect(cached.commands[0].outputs).toEqual(inspected.commands[0].outputs);
    expect(bdxBindingsFromCatalog(inspected).parameterTypes["team.intake.start"].Setpoint.niType).toBe("DBL");
    declaration.commands[0].parameters[1].schema.kind = "integer";
    await fs.writeFile(path.join(fixture.root, "bordeaux-catalog.json"), JSON.stringify(declaration));
    const changed = await withCachedLabviewCommands(fixture.project, await discoverLabviewProject(fixture.project), fixture.cache);
    expect(changed.commands[0].labviewConnector).toBeUndefined();
    expect(changed.warnings.join(" ")).toContain("declared parameters");
    expect(bdxBindingsFromCatalog(changed).parameterTypes["team.intake.start"]).toBeUndefined();
  });

  it("keeps session definitions after unrelated edits and reads only new or changed VIs again", async () => {
    const fixture = await cacheFixture();
    const inspected = await inspectLabviewCommands(fixture.project, fixture.cache, fixture.adapter);
    await fs.writeFile(path.join(fixture.root, "Intake/Commands/Start_wrapper.vi"), "generated wrapper sentinel");
    expect((await withSessionLabviewCommands(fixture.project, await discoverLabviewProject(fixture.project)))?.commands.map(command => command.id)).toEqual(inspected.commands.map(command => command.id));
    const requests: string[][] = [];
    const adapter = async (requestFile: string, responseFile: string) => {
      const request = JSON.parse(await fs.readFile(requestFile, "utf8"));
      requests.push(request.sources.map((item: { file: string }) => item.file));
      const vis = request.sources.map((item: { file: string; target: string }) => item.file === source.file ? fixtureRow(fixture.typedef)
        : { file: item.file, target: item.target, status: "nonCommand", viType: 3, modifiedBefore: false, modifiedAfter: false });
      await fs.writeFile(responseFile, JSON.stringify({ ...report(), projectFile: fixture.project, vis }));
    };
    // Generated wrappers are not candidates, so nothing needs reading and LabVIEW is not contacted.
    expect(await refreshLabviewCommands(fixture.project, fixture.cache, adapter)).toBeNull();
    expect(requests).toEqual([]);
    // A new VI elsewhere in the project is read on its own; the command keeps its earlier reading.
    await fs.writeFile(path.join(fixture.root, "Intake/Drive Helper.vi"), "unrelated VI sentinel");
    const afterNew = await refreshLabviewCommands(fixture.project, fixture.cache, adapter);
    expect(requests).toEqual([["Intake/Drive Helper.vi"]]);
    expect(afterNew?.commands.map(command => command.label)).toEqual(["Start"]);
    // A saved edit to the command VI reads only that VI.
    await fs.appendFile(path.join(fixture.root, source.file), "saved command edit");
    expect((await refreshLabviewCommands(fixture.project, fixture.cache, adapter))?.commands).toHaveLength(1);
    expect(requests).toEqual([["Intake/Drive Helper.vi"], [source.file]]);
    // A removed VI is dropped without contacting LabVIEW.
    await fs.rm(path.join(fixture.root, "Intake/Drive Helper.vi"));
    expect((await refreshLabviewCommands(fixture.project, fixture.cache, adapter))?.commands).toHaveLength(1);
    expect(requests).toHaveLength(2);
  });

  it("keeps the last known definitions in the cache after VI and typedef edits", async () => {
    const fixture = await cacheFixture();
    const inspected = await inspectLabviewCommands(fixture.project, fixture.cache, fixture.adapter);
    expect(inspected.labviewDiscovery?.inspection?.status).toBe("available");
    const restore = async () => {
      vi.resetModules();
      const fresh = await import("../src/electron/labviewNiInspection");
      return fresh.withCachedLabviewCommands(fixture.project, await discoverLabviewProject(fixture.project), fixture.cache);
    };
    expect((await restore()).labviewDiscovery?.inspection?.status).toBe("cached");
    await fs.writeFile(fixture.typedef, "changed type hashing sentinel");
    await fs.writeFile(path.join(fixture.root, source.file), "changed VI hashing sentinel");
    const restored = await restore();
    expect(restored.labviewDiscovery?.inspection?.status).toBe("cached");
    expect(restored.commands.map(command => command.labviewConnector?.file)).toEqual([source.file]);
  });

  it("restores confirmed commands alongside clean unsupported sources on passive refresh", async () => {
    const fixture = await cacheFixture();
    await fs.writeFile(path.join(fixture.root, "Intake/Published Globals.vi"), "global source hashing sentinel");
    const adapter = async (requestFile: string, responseFile: string) => {
      const request = JSON.parse(await fs.readFile(requestFile, "utf8"));
      const command = row();
      command.connector.extendedInformation[1] = [[[["Command Info Out"], fixture.typedef, false, 0, []]]];
      command.connector.extendedInformation[2] = [[[["Command Info In"], fixture.typedef, false, 0, []]]];
      const vis = request.sources.map((item: { file: string; target: string }) => item.file === source.file ? command
        : { file: item.file, target: item.target, status: "nonCommand", viType: 3, modifiedBefore: false, modifiedAfter: false });
      await fs.writeFile(responseFile, JSON.stringify({ ...report(), projectFile: fixture.project, vis }));
    };
    expect((await inspectLabviewCommands(fixture.project, fixture.cache, adapter)).commands).toHaveLength(1);
    const restored = await withCachedLabviewCommands(fixture.project, await discoverLabviewProject(fixture.project), fixture.cache);
    expect(restored.commands).toHaveLength(1);
    expect(restored.labviewDiscovery?.inspection?.status).toBe("cached");
  });

  it("keeps live-only definitions across restart and reads a used command again once it is saved", async () => {
    const fixture = await cacheFixture();
    const live = await inspectLabviewCommands(fixture.project, fixture.cache, async (request, response) => {
      await fixture.adapter(request, response);
      const raw = JSON.parse(await fs.readFile(response, "utf8"));
      raw.dirtyContext = true;
      await fs.writeFile(response, JSON.stringify(raw));
    });
    expect(live.labviewDiscovery?.inspection).toMatchObject({ status: "available", liveOnly: true });
    const restored = await withCachedLabviewCommands(fixture.project, await discoverLabviewProject(fixture.project), fixture.cache);
    expect(restored.labviewDiscovery?.inspection).toMatchObject({ status: "cached", liveOnly: true });
    const id = restored.commands[0].id;
    expect(await labviewCommandSourceChanges(fixture.project, restored, [id])).toEqual({ changed: [], missing: [] });
    await fs.appendFile(path.join(fixture.root, source.file), "saved command edit");
    expect((await labviewCommandSourceChanges(fixture.project, restored, [id])).changed.map(command => command.id)).toEqual([id]);
    expect((await refreshLabviewCommands(fixture.project, fixture.cache, fixture.adapter))?.labviewDiscovery?.inspection?.liveOnly).toBeUndefined();
  });

  it("accepts a full project response larger than 8 MB and refreshes outputs from it", async () => {
    const fixture = await cacheFixture();
    const refreshed = await refreshLabviewCommands(fixture.project, fixture.cache, async (request, response) => {
      await fixture.adapter(request, response);
      await fs.appendFile(response, " ".repeat(10 * 1024 * 1024));
    });
    expect(refreshed?.commands[0].outputs?.map(output => output.name)).toContain("Acquired");
    const restored = await withCachedLabviewCommands(fixture.project, await discoverLabviewProject(fixture.project), fixture.cache);
    expect(restored.commands[0].outputs?.map(output => output.name)).toContain("Acquired");
  });

  it("rejects concurrent source changes and propagates explicit adapter failures", async () => {
    const fixture = await cacheFixture();
    await expect(inspectLabviewCommands(fixture.project, fixture.cache, async (request, response) => {
      await fixture.adapter(request, response);
      await fs.writeFile(path.join(fixture.root, source.file), "source changed while NI inspected it");
    })).rejects.toThrow(/changed during NI inspection/);
    await expect(inspectLabviewCommands(fixture.project, fixture.cache, async () => { throw new Error("NI is unavailable"); })).rejects.toThrow("NI is unavailable");
    expect(await fs.readdir(fixture.cache)).toEqual([]);
  });

  it("checks only the commands an export uses; unrelated project edits never block it", async () => {
    const fixture = await cacheFixture();
    const activeCatalog = await inspectLabviewCommands(fixture.project, fixture.cache, fixture.adapter);
    const id = activeCatalog.commands[0].id;
    const options = { projectFile: fixture.project, inspectionCacheDirectory: fixture.cache, activeCatalog: { ...activeCatalog } };
    const f = binaryWriterFixture(false, false);
    f.path.markers = [{ id: "event1", name: "event1", f: .5, invocation: { commandId: id, arguments: {}, cancelOnPathEnd: false } }];
    const bindings = await prepareBdxBindings({ ...options, commandIds: [id] });
    const built = buildRobotBinary(f.project, { kind: "path", id: f.path.id }, bindings);
    expect(built.eventCount).toBe(1);
    expect(Buffer.from(built.bytes).includes(Buffer.from("Start.vi"))).toBe(true);
    // Edits to the project file, other VIs and typedefs no command uses leave the export unchanged.
    await fs.appendFile(fixture.project, "\n");
    await fs.writeFile(path.join(fixture.root, "Intake/Drive Helper.vi"), "unrelated VI sentinel");
    expect((await prepareBdxBindings({ ...options, commandIds: [] })).definitionJson).toBe(bindings.definitionJson);
    // A definition copy without session evidence still exports from the saved definitions.
    expect((await prepareBdxBindings({ ...options, activeCatalog: structuredClone(activeCatalog), commandIds: [id] })).catalog.commands).toHaveLength(1);
    // A changed command VI is read again when LabVIEW is available, and noted when it is not.
    await fs.appendFile(path.join(fixture.root, source.file), "saved command edit");
    // Enum orders and saved defaults may have changed, so a used command LabVIEW can't read again is named, not guessed.
    await expect(prepareBdxBindings({ ...options, commandIds: [id], refresh: async () => null })).rejects.toThrow(/Start changed in LabVIEW since Bordeaux last read it\. Open the robot project in LabVIEW/);
    await expect(prepareBdxBindings({ ...options, commandIds: [id] })).rejects.toThrow(/Start changed in LabVIEW/);
    const anyAdapter = async (requestFile: string, responseFile: string) => {
      const request = JSON.parse(await fs.readFile(requestFile, "utf8"));
      const vis = request.sources.map((item: { file: string; target: string }) => item.file === source.file ? fixtureRow(fixture.typedef)
        : { file: item.file, target: item.target, status: "nonCommand", viType: 3, modifiedBefore: false, modifiedAfter: false });
      await fs.writeFile(responseFile, JSON.stringify({ ...report(), projectFile: fixture.project, vis }));
    };
    const refresh = vi.fn(() => refreshLabviewCommands(fixture.project, fixture.cache, anyAdapter));
    const reread = await prepareBdxBindings({ ...options, commandIds: [id], refresh });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(reread.catalog.commands).toHaveLength(1);
    // A later check of the earlier linked catalog sees the newer reading (as a push confirmation would).
    expect((await prepareBdxBindings({ ...options, commandIds: [id] })).definitionJson).toBe(reread.definitionJson);
    // A used command whose VI is gone names itself; one no export uses does not matter.
    await fs.rm(path.join(fixture.root, source.file));
    await expect(prepareBdxBindings({ ...options, commandIds: [id] })).rejects.toThrow(/Start \(Intake\/Commands\/Start\.vi\) is no longer in the LabVIEW project/);
    await expect(prepareBdxBindings({ ...options, commandIds: [] })).resolves.toBeTruthy();
    expect((await prepareBdxBindings({ ...options, projectFile: null })).catalog.commands).toEqual([]);
  });

  it("lists for a SystemCore only commands whose saved VI still matches what Bordeaux read", async () => {
    const fixture = await cacheFixture();
    const activeCatalog = await inspectLabviewCommands(fixture.project, fixture.cache, fixture.adapter);
    const options = { projectFile: fixture.project, inspectionCacheDirectory: fixture.cache, activeCatalog: { ...activeCatalog } };
    const current = await prepareCommandListBindings(options);
    expect(current.omitted).toEqual([]);
    // A push re-reads the list before upload; an unchanged project confirms although its scan time is new.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const again = (await prepareCommandListBindings(options)).bindings;
    expect(again.catalog.scannedAt).not.toBe(current.bindings.catalog.scannedAt);
    expect(commandListEvidence(again)).toBe(commandListEvidence(current.bindings));
    expect(current.bindings.catalog.commands.map((command) => command.id)).toEqual([activeCatalog.commands[0].id]);
    // An edited VI that LabVIEW can't read again (closed) is left out and named, never sent with its old types.
    await fs.appendFile(path.join(fixture.root, source.file), "saved command edit");
    const stale = await prepareCommandListBindings({ ...options, refresh: async () => null });
    expect(stale.omitted).toEqual(["Start"]);
    expect(stale.bindings.catalog.commands).toEqual([]);
    expect(stale.bindings.definitionJson).not.toBe(current.bindings.definitionJson);
    expect(commandListEvidence(stale.bindings)).not.toBe(commandListEvidence(current.bindings));
    // With every command left out, the list the robot gets is empty but still valid, replacing any stale one.
    expect(decodeCommandsFile(encodeCommandsFile(stale.bindings)).catalog.commands).toEqual([]);
    // A removed VI is left out too.
    await fs.rm(path.join(fixture.root, source.file));
    expect((await prepareCommandListBindings(options)).omitted).toEqual(["Start"]);
  });

  it("uses another project's own definitions instead of a linked catalog from a different project", async () => {
    const fixture = await cacheFixture();
    const activeCatalog = await inspectLabviewCommands(fixture.project, fixture.cache, fixture.adapter);
    const other = await cacheFixture();
    const bindings = await prepareBdxBindings({ projectFile: other.project, inspectionCacheDirectory: other.cache, activeCatalog, commandIds: [activeCatalog.commands[0].id] });
    expect(bindings.catalog.commands).toEqual([]);
  });

  it("applies declaration edits without reading LabVIEW again", async () => {
    const fixture = await cacheFixture();
    const declaration = path.join(fixture.root, "bordeaux-catalog.json");
    const activeCatalog = await inspectLabviewCommands(fixture.project, fixture.cache, fixture.adapter);
    const options = { projectFile: fixture.project, inspectionCacheDirectory: fixture.cache, activeCatalog, commandIds: activeCatalog.commands.map(command => command.id) };
    await fs.writeFile(declaration, JSON.stringify({ schemaVersion: "bordeaux-labview-catalog/1", catalogId: "team", commands: [] }));
    await expect(prepareBdxBindings(options)).resolves.toBeTruthy();
    await fs.appendFile(declaration, "\n");
    await expect(prepareBdxBindings(options)).resolves.toBeTruthy();
    await fs.rm(declaration);
    expect((await prepareBdxBindings(options)).catalog.commands).toHaveLength(1);
  });

  it("reads definitions taken from unsaved VIs again after a restart, even when the saved file never changed", async () => {
    const fixture = await cacheFixture();
    const live = await inspectLabviewCommands(fixture.project, fixture.cache, async (request, response) => {
      await fixture.adapter(request, response);
      const raw = JSON.parse(await fs.readFile(response, "utf8"));
      raw.vis[0].modifiedBefore = true;
      await fs.writeFile(response, JSON.stringify(raw));
    });
    const id = live.commands[0].id;
    // This session keeps the live reading, as before.
    expect(await labviewCommandSourceChanges(fixture.project, live, [id])).toEqual({ changed: [], missing: [] });
    vi.resetModules();
    const fresh = await import("../src/electron/labviewNiInspection");
    const restored = await fresh.withCachedLabviewCommands(fixture.project, await discoverLabviewProject(fixture.project), fixture.cache);
    expect((await fresh.labviewCommandSourceChanges(fixture.project, restored, [id])).changed.map(command => command.id)).toEqual([id]);
  });

  it("leaves a typedef saved during inspection unverified so its commands are read again", async () => {
    const fixture = await cacheFixture();
    const inspected = await inspectLabviewCommands(fixture.project, fixture.cache, async (request, response) => {
      await fixture.adapter(request, response);
      await fs.writeFile(fixture.typedef, "typedef saved while NI was reading");
    });
    const id = inspected.commands[0].id;
    expect((await labviewCommandSourceChanges(fixture.project, inspected, [id])).changed.map(command => command.id)).toEqual([id]);
    const earlier = new Date(Date.now() - 3600_000); await fs.utimes(fixture.typedef, earlier, earlier);
    const reread = await refreshLabviewCommands(fixture.project, fixture.cache, fixture.adapter);
    expect(await labviewCommandSourceChanges(fixture.project, reread!, [id])).toEqual({ changed: [], missing: [] });
  });

  it("keeps an unsaved reading flagged through a timestamp-only change and an unrelated refresh", async () => {
    const fixture = await cacheFixture();
    const anyAdapter = (dirty: boolean) => async (requestFile: string, responseFile: string) => {
      const request = JSON.parse(await fs.readFile(requestFile, "utf8"));
      const vis = request.sources.map((item: { file: string; target: string }) => item.file === source.file ? { ...fixtureRow(fixture.typedef), modifiedBefore: dirty }
        : { file: item.file, target: item.target, status: "nonCommand", viType: 3, modifiedBefore: false, modifiedAfter: false });
      await fs.writeFile(responseFile, JSON.stringify({ ...report(), projectFile: fixture.project, vis }));
    };
    const live = await inspectLabviewCommands(fixture.project, fixture.cache, anyAdapter(true));
    const id = live.commands[0].id, later = new Date(Date.now() + 60_000);
    await fs.utimes(path.join(fixture.root, source.file), later, later);
    await fs.writeFile(path.join(fixture.root, "Intake/Drive Helper.vi"), "unrelated VI sentinel");
    expect(await refreshLabviewCommands(fixture.project, fixture.cache, anyAdapter(false))).not.toBeNull();
    vi.resetModules();
    const fresh = await import("../src/electron/labviewNiInspection");
    const restored = await fresh.withCachedLabviewCommands(fixture.project, await discoverLabviewProject(fixture.project), fixture.cache);
    expect((await fresh.labviewCommandSourceChanges(fixture.project, restored, [id])).changed.map(command => command.id)).toEqual([id]);
  });

  it("treats a new VI sharing a used command's basename as a change to the reviewed evidence", async () => {
    const { usedCommandEvidence } = await import("../src/electron/bdxBindings");
    const fixture = await cacheFixture();
    const catalog = await inspectLabviewCommands(fixture.project, fixture.cache, fixture.adapter);
    const id = catalog.commands[0].id, before = bdxBindingsFromCatalog(catalog);
    const twin = { ...catalog.commands[0], id: "labview.legacy.twin", labviewConnector: { ...catalog.commands[0].labviewConnector!, file: "Drive/Start.vi" } };
    const unrelated = { ...catalog.commands[0], id: "labview.legacy.other", labviewConnector: { ...catalog.commands[0].labviewConnector!, file: "Drive/Stop.vi" } };
    expect(usedCommandEvidence(bdxBindingsFromCatalog({ ...catalog, commands: [...catalog.commands, unrelated] }), [id])).toBe(usedCommandEvidence(before, [id]));
    expect(usedCommandEvidence(bdxBindingsFromCatalog({ ...catalog, commands: [...catalog.commands, twin] }), [id])).not.toBe(usedCommandEvidence(before, [id]));
  });
});
