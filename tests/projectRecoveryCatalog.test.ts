import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectRecoveryStore } from "../src/electron/projectRecoveryStore";
import { ProjectRecoveryCatalog } from "../src/electron/projectRecoveryCatalog";
import { createDemoProject } from "../src/shared/project/defaults";

const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(value => fs.rm(value, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-recovery-catalog-")); directories.push(root);
  const store = new ProjectRecoveryStore(root), revealed: string[] = [], catalog = new ProjectRecoveryCatalog(root, store, filename => revealed.push(filename));
  const input = { recordId: randomUUID(), revision: 1, capturedAt: "2026-10-12T12:00:00.000Z", displayName: "Available copy", reason: "checkpoint", origin: { kind: "legacy" as const, folderPath: path.join(root, "missing-origin"), legacyFile: path.join(root, "missing-origin", "Autos.bordeaux.json") }, project: createDemoProject() };
  await store.writeSnapshot(input); return { root, store, catalog, revealed, input };
}
describe("read-only recovery UI catalog", () => {
  it("adapts actual metadata without invented persistence state and reveals only main-listed IDs", async () => {
    const f = await fixture(), corrupt = randomUUID();
    await fs.writeFile(path.join(f.root, corrupt + ".json"), "private malformed contents"); await fs.writeFile(path.join(f.root, "private-name.tmp"), "private payload");
    const result = await f.catalog.list();
    expect(result.entries.find(entry => entry.id === f.input.recordId)).toMatchObject({ available: true, updatedAt: f.input.capturedAt, origin: f.input.origin, receipt: { revision: 1 } });
    expect(JSON.stringify(result)).not.toContain("private-name"); expect(JSON.stringify(result)).not.toContain("state");
    const bad = result.entries.find(entry => entry.recordId === corrupt)!;
    expect(bad).toMatchObject({ available: false, code: "invalid-record" });
    await f.catalog.reveal(f.input.recordId); await f.catalog.reveal(bad.id);
    expect(f.revealed).toEqual([path.join(f.root, f.input.recordId + ".json"), path.join(f.root, corrupt + ".json")]);
    await expect(f.catalog.reveal("../../private.txt")).rejects.toThrow("displayed list");
    await expect(f.catalog.reveal(path.join(f.root, f.input.recordId + ".json"))).rejects.toThrow("displayed list");
    expect(await fs.readdir(f.root)).toHaveLength(3);
  });
  it("keeps directory failures visible and revokes its old reveal allowlist", async () => {
    const f = await fixture(); await f.catalog.list();
    vi.spyOn(f.store, "listSnapshots").mockRejectedValue(new Error("Recovery storage is unavailable"));
    await expect(f.catalog.list()).rejects.toThrow("unavailable");
    await expect(f.catalog.reveal(f.input.recordId)).rejects.toThrow("displayed list"); expect(f.revealed).toEqual([]);
  });
  it("refuses revealing through a replaced symlink root", async () => {
    const f = await fixture(); await f.catalog.list();
    const moved = f.root + "-retained"; directories.push(moved); await fs.rename(f.root, moved); await fs.symlink(moved, f.root);
    await expect(f.catalog.reveal(f.input.recordId)).rejects.toThrow("unavailable"); expect(f.revealed).toEqual([]);
  });
});
