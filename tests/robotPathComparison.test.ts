import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
// @ts-expect-error The renderer component is a JSX module.
import { RobotPathField } from "../src/renderer/components/RobotPathField";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { crc32 } from "../src/core/export/binaryCodec";
import type { RobotFileConnection } from "../src/core/robotFileDelivery";
import { RobotFileDelivery } from "../src/electron/robotFileDelivery";
import { inspectRobotPath } from "../src/electron/robotPathBinary";
import { matchLocalRobotPath, pairRobotPathFiles } from "../src/electron/robotPathInventory";
import { compareRobotPath } from "../src/electron/robotPathDifference";
import { saveReviewedRobotCopy } from "../src/electron/robotPathCopy";
import { projectWorkspacePath } from "../src/electron/projectFiles";
import { binaryWriterFixture } from "./fixtures/binaryWriterFixture";
import { binaryFileName, buildRobotBinary } from "../src/core/export/robotBinary";
import { ACTIVE_FIELD_REFERENCE } from "../src/core/field/rebuilt2026";

const fixture = (version: string) => fs.readFile(path.join("labview/tests/fixtures/binary", version, "straight-events.bdx"));
const compiled = async () => {
  const bytes = await fixture("forces-v1.1-centered");
  const binary = inspectRobotPath(bytes);
  return { bytes, binary, path: { id: binary.id, name: binary.name } };
};

describe("robot path differences", () => {
  it.each([["", 0], ["blue-origin", 0], ["forces-v1.1", 1]] as const)("reads the published %s BDX fixture", async (version, minor) => {
    const bytes = await fixture(version), info = inspectRobotPath(bytes);
    expect(info.minor).toBe(minor);
    expect(info.events).toHaveLength(2);
    expect(info.samples.length).toBeGreaterThan(2);
    expect(compareRobotPath(info.id, bytes, bytes).verdict).toBe("same");
  });

  it("shows changed route geometry and a same-name file from another authored path", async () => {
    const { binary, bytes } = await compiled();
    const robot = Buffer.from(bytes), sampleStart = 32 + 4 + robot.readUInt32BE(32) + 4;
    const sampleSize = binary.minor === 0 ? 88 : 120;
    for (let offset = sampleStart; offset < sampleStart + binary.samples.length * sampleSize; offset += sampleSize) {
      robot.writeDoubleBE(robot.readDoubleBE(offset + 32) + 0.4, offset + 32);
    }
    robot.writeUInt32BE(crc32(robot.subarray(32)), 20);
    const changed = compareRobotPath(binary.id, bytes, robot);
    expect(changed.verdict).toBe("different");
    const { local, robot: deployed } = changed.routes!;
    expect(local?.field).toEqual(ACTIVE_FIELD_REFERENCE);
    expect(deployed?.field).toEqual(local?.field);
    expect(local?.points.length).toBeLessThanOrEqual(400);
    const pointAt = (index: number) => [binary.samples[index].x, binary.samples[index].y];
    expect(local?.points[0]).toEqual(pointAt(0));
    expect(local?.points.at(-1)).toEqual(pointAt(binary.samples.length - 1));
    expect(deployed?.points.at(-1)?.[1]).toBeCloseTo(pointAt(binary.samples.length - 1)[1] + 0.4);
    expect(changed.facts.find(([label]) => label === "Approx. route gap")?.[2]).toBeCloseTo(0.4);
    expect(changed.widestGap?.robot[1]).toBeCloseTo(changed.widestGap!.local[1] + 0.4);
    expect(local?.endHeading).toBe(binary.samples.at(-1)!.headingRad);
    expect(local?.width).toBe(binary.robot.widthM);
    expect(local?.length).toBe(binary.robot.lengthM);
    expect(changed.facts.some(([label]) => label === "End Y")).toBe(true);
    const conflict = compareRobotPath("another-id", bytes, robot);
    expect(conflict).toMatchObject({ verdict: "otherPath", robotName: binary.name });
    expect(conflict.widestGap).toBeUndefined();
    expect(conflict.routes).toEqual(changed.routes);
  });

  it("keeps each preview's field reference when the frames differ", async () => {
    const { bytes, binary } = await compiled(), legacy = await fixture("");
    const diff = compareRobotPath(binary.id, bytes, legacy);
    expect(diff.routes?.local?.field).toEqual(ACTIVE_FIELD_REFERENCE);
    expect(diff.routes?.robot?.field.coordinateSchemaId).toBe("bordeaux-field/1.0");
    expect(diff.facts.some(([label]) => label === "Field frame")).toBe(true);
    expect(diff.widestGap).toBeUndefined();
    expect(diff.notes).not.toContain("Trajectory samples or wheel forces differ.");
    const blueOrigin = await fixture("forces-v1.1");
    const mixed = compareRobotPath(binary.id, bytes, blueOrigin);
    const frame = mixed.facts.find(([label]) => label === "Field frame");
    expect(frame?.[1]).toContain("wpilib-center-origin/2026-andymark/1");
    expect(frame?.[2]).toContain("wpilib-blue-origin/2026-welded/1");
    expect(mixed.widestGap).toBeUndefined();
    expect(mixed.notes).toContain("Trajectory comparison requires matching field frames.");
    const markup = renderToStaticMarkup(createElement(RobotPathField, { routes: mixed.routes, verdict: mixed.verdict }));
    expect(markup).toContain('<g data-route="local">');
    expect(markup).not.toContain('<g data-route="robot">');
    expect(markup).toContain("unsupported frame");
    expect(diff.facts.some(([label]) => label === "Approx. route gap" || label === "End X")).toBe(false);
  });

  it("identifies a moved command by stable event ID and displays exact 64-bit input changes", () => {
    const fixture = binaryWriterFixture();
    const build = () => Buffer.from(buildRobotBinary(fixture.project, { kind: "path", id: fixture.path.id }, fixture.bindings).bytes);
    const local = build();
    fixture.path.markers[0].f += 0.05;
    fixture.path.markers[0].name = "Renamed event";
    fixture.path.markers[0].invocation!.arguments.sequence = "9007199254740995";
    const changed = compareRobotPath(fixture.path.id, local, build());
    expect(changed.verdict).toBe("different");
    const row = changed.eventChanges?.rows[0];
    expect(changed.eventChanges?.rows).toHaveLength(1);
    expect(row?.local?.name).toBe("Timed event");
    expect(row?.robot?.name).toBe("Renamed event");
    expect(row?.robot?.time).toBeGreaterThan(row!.local!.time);
    expect(row?.values).toContainEqual(["sequence", "9007199254740993", "9007199254740995"]);
  });

  it("keeps events present on only one side distinct from renamed events", () => {
    const fixture = binaryWriterFixture();
    const build = () => Buffer.from(buildRobotBinary(fixture.project, { kind: "path", id: fixture.path.id }, fixture.bindings).bytes);
    const local = build();
    fixture.path.markers[1].id = "replacement-event";
    fixture.path.markers[1].name = "Replacement event";
    const rows = compareRobotPath(fixture.path.id, local, build()).eventChanges?.rows;
    expect(rows).toHaveLength(2);
    expect(rows?.[0]?.local).toBeUndefined();
    expect(rows?.[0]?.robot?.name).toBe("Replacement event");
    expect(rows?.[1]?.robot).toBeUndefined();
    expect(rows?.[1]?.local?.name).toBe("Repeated event");
  });

  it("compares the current BDX 1.2 command loop extension", () => {
    const fixture = binaryWriterFixture();
    const build = () => Buffer.from(buildRobotBinary(fixture.project, { kind: "path", id: fixture.path.id }, fixture.bindings).bytes);
    fixture.path.markers[0].invocation!.loop = { until: { kind: "time", seconds: 1.5 } };
    const local = build();
    expect(inspectRobotPath(local).minor).toBe(2);
    expect(inspectRobotPath(local).events).toHaveLength(2);
    fixture.path.markers[0].invocation!.loop = { until: { kind: "time", seconds: 2 } };
    const result = compareRobotPath(fixture.path.id, local, build());
    expect(result.verdict).toBe("different");
    expect(result.eventChanges?.rows[0]?.notes).toContainEqual(["Loop or group", "Different"]);
  });

  it("rejects decoded geometry that cannot describe a valid path comparison", async () => {
    const { bytes, binary } = await compiled();
    const invalid = Buffer.from(bytes), startOfSamples = 36 + invalid.readUInt32BE(32) + 4;
    invalid.writeDoubleBE(-1, startOfSamples);
    invalid.writeUInt32BE(crc32(invalid.subarray(32)), 20);
    expect(compareRobotPath(binary.id, bytes, invalid)).toMatchObject({
      verdict: "robotUnreadable", robotError: expect.stringContaining("zero time and distance"),
    });
  });

  it("preserves evidence for missing, unsupported, corrupted and unbuildable files", async () => {
    const { bytes, binary } = await compiled();
    const corrupted = Buffer.from(bytes);
    corrupted[corrupted.length - 1] ^= 1;
    const missing = compareRobotPath(binary.id, bytes, null);
    expect(missing).toMatchObject({ verdict: "missing", local: { size: bytes.length } });
    expect(missing.routes?.local?.points.length).toBeGreaterThan(1);
    expect(missing.routes?.robot).toBeUndefined();
    expect(compareRobotPath(binary.id, bytes, corrupted)).toMatchObject({
      verdict: "robotUnreadable", robot: { size: corrupted.length }, robotError: expect.stringMatching(/checksum/),
    });
    expect(compareRobotPath(binary.id, bytes, Buffer.from("legacy file")).verdict).toBe("robotUnreadable");
    expect(() => inspectRobotPath(bytes.subarray(0, -1))).toThrow(/cut short/);
    expect(() => inspectRobotPath(Buffer.concat([bytes, Buffer.alloc(1)]))).toThrow(/extra bytes/);
    expect(compareRobotPath(binary.id, { error: new Error("No NI command inputs") }, bytes)).toMatchObject({
      verdict: "localFailed", localError: "No NI command inputs", robot: { size: bytes.length },
      facts: expect.arrayContaining([["Duration", "—", binary.totalTimeS, "s"]]),
    });
  });
});

const connection = { endpoint: { target: "roborio" as const, host: "robot.local", port: 22, directory: "/home/lvuser/Paths" }, hostKeyFingerprint: "SHA256:" + "x".repeat(43) };
function deliveryWith(read: (target: RobotFileConnection, fileName: string, signal?: AbortSignal) => Promise<Buffer | null>) {
  const upload = vi.fn();
  return { upload, delivery: new RobotFileDelivery(connection, vi.fn(), {
    probe: vi.fn(), upload, read: async (target, [fileName], signal) => [{ fileName, contents: await read(target, fileName, signal) }],
  }) };
}

describe("robot file inventory", () => {
  it("pairs exact names, preserves robot-only paths and flags collisions", () => {
    const local = [{ id: "a", name: "Opening", pushable: true }, { id: "b", name: "Practice field", pushable: true },
      { id: "c", name: "Double move", pushable: false }, { id: "d", name: "Double-move", pushable: true }];
    const files = ["Opening.bdx", "practice-field.bdx", "Robot path.BDX", "Double-move.bdx"].map(fileName => ({ fileName, size: 150, mtime: 0 }));
    expect(pairRobotPathFiles(local, { files, missing: false, truncated: false })).toEqual(expect.arrayContaining([
      expect.objectContaining({ fileName: "Opening.bdx", kind: "paired", pathId: "a" }),
      expect.objectContaining({ fileName: "Practice-field.bdx", kind: "localOnly", pathId: "b" }),
      expect.objectContaining({ fileName: "practice-field.bdx", kind: "robotOnly" }),
      expect.objectContaining({ fileName: "Robot path.BDX", kind: "robotOnly" }),
      expect.objectContaining({ fileName: "Double-move.bdx", kind: "conflict" }),
    ]));
    const partial = pairRobotPathFiles(local, { files, missing: false, truncated: true });
    expect(partial.some(row => row.kind === "localOnly")).toBe(false);
  });

  it("looks up a renamed path by embedded ID before building its diff", async () => {
    const { bytes, path } = await compiled(), current = { ...path, name: "Renamed path" };
    const { delivery } = deliveryWith(async () => bytes);
    const build = vi.fn(async () => bytes);
    const review = await delivery.reviewPath("review", "Old file name.BDX", id => id === current.id ? current : undefined, build, () => {});
    expect(build).toHaveBeenCalledWith(current.id, expect.any(AbortSignal));
    expect(review).toMatchObject({ verdict: "same", fileName: "Old file name.BDX", expectedFileName: "Renamed-path.bdx", name: current.name });
    await delivery.saveCopy("review", async copy => { expect(copy.robotOnly).toBe(false); return { canceled: true }; });
  });

  it("compares a filename collision with a foreign ID without treating the file as an orphan", async () => {
    const { bytes, path } = await compiled();
    const local = { ...path, id: "recreated-local-path" };
    const fileName = binaryFileName(local.name);
    const { delivery } = deliveryWith(async () => bytes);
    const build = vi.fn(async () => bytes);
    const review = await delivery.reviewPath("collision", fileName, id => matchLocalRobotPath([local], fileName, local, id), build, () => {});
    expect(build).toHaveBeenCalledWith(local.id, expect.any(AbortSignal));
    expect(review).toMatchObject({ verdict: "otherPath", robotOnly: false, fileName });
    expect(review.local).toBeDefined();
  });

  it("inspects and copies an orphaned robot path without building or editing a local path", async () => {
    const { bytes, path } = await compiled(), read = vi.fn(async () => bytes);
    const { delivery, upload } = deliveryWith(read);
    const build = vi.fn();
    const review = await delivery.reviewPath("review", "Old file name.BDX", () => undefined, build, () => {});
    expect(review).toMatchObject({ verdict: "robotOnly", name: path.name, fileName: "Old file name.BDX", robotOnly: true });
    expect(review.facts).toEqual(expect.arrayContaining([["Format", "—", "BDX 1.1", undefined]]));
    expect(review.eventChanges?.rows).toHaveLength(2);
    expect(review.eventChanges?.rows.every(row => row.robot && !row.local)).toBe(true);
    await delivery.saveCopy("review", async copy => {
      expect(copy).toMatchObject({ fileName: "Old file name.BDX", robotOnly: true, bytes });
      return { canceled: true };
    });
    expect(build).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledOnce();
    expect(upload).not.toHaveBeenCalled();
  });
});

describe("reviewed robot copy", () => {
  it("saves the frozen bytes without reading the robot again, and rejects a dismissed review", async () => {
    const { bytes, path } = await compiled();
    const remote = Buffer.from(bytes), read = vi.fn(async () => remote);
    const { delivery, upload } = deliveryWith(read);
    const comparison = await delivery.reviewPath("review", binaryFileName(path.name), () => path, async () => bytes, () => {});
    remote.fill(0);
    const save = vi.fn(async ({ bytes: copy, sha256 }, assertCurrent: () => void) => {
      assertCurrent();
      expect(copy.equals(bytes)).toBe(true);
      expect(sha256).toBe(comparison.robot?.sha256);
      return { canceled: true } as const;
    });
    await expect(delivery.saveCopy("review", save)).resolves.toEqual({ canceled: true });
    expect(read).toHaveBeenCalledOnce();
    expect(upload).not.toHaveBeenCalled();
    delivery.cancelCompare("review");
    await expect(delivery.saveCopy("review", save)).rejects.toThrow("Read the robot path again");
  });

  it("cancels a read, allows a new comparison and leaves its review intact", async () => {
    const { path, bytes } = await compiled();
    let release!: (value: typeof bytes) => void;
    const read = vi.fn(async () => bytes).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const { delivery } = deliveryWith(read);
    const old = delivery.reviewPath("old", binaryFileName(path.name), () => path, async () => bytes, () => {});
    const canceled = expect(old).rejects.toThrow();
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    await expect(delivery.saveSettings(connection.endpoint)).rejects.toThrow("Finish the current robot operation");
    delivery.cancelCompare("old");
    await expect(delivery.reviewPath("new", binaryFileName(path.name), () => path, async () => bytes, () => {})).resolves.toMatchObject({ verdict: "same" });
    release(bytes);
    await canceled;
    await expect(delivery.saveCopy("new", async () => ({ canceled: true }))).resolves.toEqual({ canceled: true });
  });

  it("writes a verified local copy, protects generated Paths, and confirms replacements", async () => {
    const { bytes } = await compiled();
    const copy = { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-path-copy-"));
    try {
      const generated = path.join(folder, "Paths"), backup = path.join(folder, "opening.robot");
      await fs.mkdir(generated);
      await fs.writeFile(projectWorkspacePath(folder), "{}");
      const confirm = vi.fn(async () => false), current = () => {};
      await expect(saveReviewedRobotCopy(path.join(generated, "opening.bdx"), copy, null, current, confirm)).rejects.toThrow(/rebuilt/);
      if (process.platform !== "win32") {
        const alias = path.join(folder, "alias");
        await fs.symlink(generated, alias);
        await expect(saveReviewedRobotCopy(path.join(alias, "opening.bdx"), copy, folder, current, confirm)).rejects.toThrow(/rebuilt/);
      }
      await expect(saveReviewedRobotCopy(backup, copy, folder, current, confirm)).resolves.toMatchObject({
        name: "opening.robot.bdx", size: bytes.length,
      });
      expect(confirm).not.toHaveBeenCalled();
      const destination = backup + ".bdx";
      expect(await fs.readFile(destination)).toEqual(bytes);
      await fs.writeFile(destination, "existing");
      await expect(saveReviewedRobotCopy(backup, copy, folder, current, confirm)).resolves.toEqual({ canceled: true });
      expect(await fs.readFile(destination, "utf8")).toBe("existing");
      await expect(saveReviewedRobotCopy(backup, copy, folder, current, async () => {
        await fs.writeFile(destination, "changed during review");
        return true;
      })).rejects.toThrow("The destination changed");
      expect(await fs.readFile(destination, "utf8")).toBe("changed during review");
      await expect(saveReviewedRobotCopy(backup, copy, folder, current, async () => true)).resolves.toMatchObject({ size: bytes.length });
      expect(await fs.readFile(destination)).toEqual(bytes);
    } finally { await fs.rm(folder, { recursive: true, force: true }); }
  });
});
