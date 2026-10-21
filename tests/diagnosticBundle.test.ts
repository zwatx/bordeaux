import { describe, expect, it } from "vitest";
import fs from "node:fs";
import {
  DiagnosticBundleCapability,
  buildDiagnosticBundle,
  diagnosticFieldPin,
  reduceRobotAcknowledgement,
  saveDiagnosticPreview,
  type DiagnosticBundleInput,
} from "../src/electron/diagnosticBundle";

const hash = `sha256:${"a".repeat(64)}`;

function input(overrides: Partial<DiagnosticBundleInput> = {}): DiagnosticBundleInput {
  return {
    generatedAt: "2026-08-14T19:20:00.000Z",
    app: { version: "0.2.0-beta.1", build: "development", channel: "beta" },
    os: { platform: "test-platform", release: "test-release", arch: "test-arch" },
    fieldPin: { id: "2026-rebuilt", revision: "2026-manual-tu19-welded-4", coordinateSchemaId: "wpilib-blue-origin/2026-welded/1" },
    catalog: { schemaVersion: "1.2", catalogId: "competition-robot", catalogHash: hash, supportVersion: "0.2.0" },
    export: { state: "generated", sha256: hash, pathCount: 2, eventCount: 3, sampleCount: 48 },
    routinePreflight: { state: "passed", issueCount: 0 },
    robotAcknowledgement: { state: "active", observedAt: "2026-08-14T19:19:00.000Z", teamNumber: 2468, revisionId: hash, payloadSha256: hash, catalogId: "competition-robot", catalogHash: hash, supportVersion: "0.2.0" },
    ...overrides,
  };
}

function expectExactKeys(value: unknown, expected: Record<string, string[] | null>): void {
  const visit = (item: unknown, path: string): void => {
    expect(item).toBeTypeOf("object");
    expect(item).not.toBeNull();
    expect(Array.isArray(item)).toBe(false);
    const keys = Object.keys(item as Record<string, unknown>).sort();
    expect(keys).toEqual((expected[path] ?? []).sort());
    for (const key of keys) {
      const child = (item as Record<string, unknown>)[key];
      const childPath = `${path}.${key}`;
      if (expected[childPath]) visit(child, childPath);
    }
  };
  visit(value, "$");
}

describe("beta diagnostic bundle", () => {
  it("records schema 1.3 catalog identity without copying generator details", () => {
    const bundle = JSON.parse(buildDiagnosticBundle(input({ catalog: { schemaVersion: "1.3", catalogId: "competition-robot", catalogHash: hash, supportVersion: "0.4.0" } })));

    expect(bundle.catalog).toEqual({ schemaVersion: "1.3", catalogId: "competition-robot", catalogHash: hash, supportVersion: "0.4.0" });
    expect(bundle.catalog).not.toHaveProperty("trajectoryGenerators");
  });

  it("emits the stable v1 allowlist and excludes hostile project and transport values", () => {
    const contents = buildDiagnosticBundle(input({
      // These hostile values intentionally live outside the typed allowlist. A future
      // implementation must not start recursively serializing its input.
      ...( {
        projectName: "Drive Team Secrets",
        path: "/Users/alice/Documents/private.bordeaux.json",
        token: "robot-token-123",
        hostKey: "SHA256:host-key",
        nonce: "push-secret-nonce",
        error: "ssh://10.24.68.2:22/raw failure",
        project: { paths: [{ name: "Offensive strategy", notes: "private scouting notes" }] },
      } as object),
    }));

    expect(contents).toBe(`{
  "schemaVersion": "bordeaux-beta-diagnostic/1.0",
  "generatedAt": "2026-08-14T19:20:00.000Z",
  "app": {
    "version": "0.2.0-beta.1",
    "build": "development",
    "channel": "beta"
  },
  "os": {
    "platform": "test-platform",
    "release": "test-release",
    "arch": "test-arch"
  },
  "fieldPin": {
    "id": "2026-rebuilt",
    "revision": "2026-manual-tu19-welded-4",
    "coordinateSchemaId": "wpilib-blue-origin/2026-welded/1"
  },
  "catalog": {
    "schemaVersion": "1.2",
    "catalogId": "competition-robot",
    "catalogHash": "sha256:${"a".repeat(64)}",
    "supportVersion": "0.2.0"
  },
  "export": {
    "state": "generated",
    "sha256": "sha256:${"a".repeat(64)}",
    "pathCount": 2,
    "eventCount": 3,
    "sampleCount": 48
  },
  "routinePreflight": {
    "state": "passed",
    "issueCount": 0
  },
  "robotAcknowledgement": {
    "state": "active",
    "observedAt": "2026-08-14T19:19:00.000Z",
    "teamNumber": 2468,
    "revisionId": "sha256:${"a".repeat(64)}",
    "payloadSha256": "sha256:${"a".repeat(64)}",
    "catalogId": "competition-robot",
    "catalogHash": "sha256:${"a".repeat(64)}",
    "supportVersion": "0.2.0"
  }
}
`);
    for (const forbidden of ["Drive Team Secrets", "/Users/alice", "robot-token-123", "host-key", "push-secret-nonce", "10.24.68.2", "raw failure", "private scouting notes"]) {
      expect(contents).not.toContain(forbidden);
    }
    const parsed = JSON.parse(contents);
    expect(parsed).toEqual({
      schemaVersion: "bordeaux-beta-diagnostic/1.0",
      generatedAt: "2026-08-14T19:20:00.000Z",
      app: { version: "0.2.0-beta.1", build: "development", channel: "beta" },
      os: { platform: "test-platform", release: "test-release", arch: "test-arch" },
      fieldPin: { id: "2026-rebuilt", revision: "2026-manual-tu19-welded-4", coordinateSchemaId: "wpilib-blue-origin/2026-welded/1" },
      catalog: { schemaVersion: "1.2", catalogId: "competition-robot", catalogHash: hash, supportVersion: "0.2.0" },
      export: { state: "generated", sha256: hash, pathCount: 2, eventCount: 3, sampleCount: 48 },
      routinePreflight: { state: "passed", issueCount: 0 },
      robotAcknowledgement: { state: "active", observedAt: "2026-08-14T19:19:00.000Z", teamNumber: 2468, revisionId: hash, payloadSha256: hash, catalogId: "competition-robot", catalogHash: hash, supportVersion: "0.2.0" },
    });
    expectExactKeys(parsed, {
      "$": ["schemaVersion", "generatedAt", "app", "os", "fieldPin", "catalog", "export", "routinePreflight", "robotAcknowledgement"],
      "$.app": ["version", "build", "channel"],
      "$.os": ["platform", "release", "arch"],
      "$.fieldPin": ["id", "revision", "coordinateSchemaId"],
      "$.catalog": ["schemaVersion", "catalogId", "catalogHash", "supportVersion"],
      "$.export": ["state", "sha256", "pathCount", "eventCount", "sampleCount"],
      "$.routinePreflight": ["state", "issueCount"],
      "$.robotAcknowledgement": ["state", "observedAt", "teamNumber", "revisionId", "payloadSha256", "catalogId", "catalogHash", "supportVersion"],
    });
  });

  it.each([
    ["unavailable", { state: "unavailable" }, { state: "unavailable", issueCount: 0 }],
    ["invalid", { state: "invalid" }, { state: "failed", issueCount: 2 }],
  ] as const)("records a %s export without its project contents", (_name, exportState, preflight) => {
    const bundle = JSON.parse(buildDiagnosticBundle(input({ export: exportState, routinePreflight: preflight, fieldPin: null, catalog: null, robotAcknowledgement: { state: "not-observed" } })));
    expect(bundle.export).toEqual(exportState);
    expect(bundle.routinePreflight).toEqual(preflight);
    expect(bundle.fieldPin).toBeNull();
    expect(bundle.catalog).toBeNull();
  });

  it.each([
    ["active", { state: "active", acknowledgement: { teamNumber: 2468, revisionId: hash, payloadSha256: hash, catalogId: "robot", catalogHash: hash, supportVersion: "0.2.0", nonce: "forbidden", runtimeId: "forbidden" } }, "active"],
    ["rejected", { state: "rejected", boundary: "mailbox", message: "secret path /home/lvuser" }, "rejected"],
    ["staged", { state: "staged", boundary: "acknowledgement", message: "secret" }, "staged"],
  ] as const)("reduces %s robot results without raw messages or identity secrets", (_name, result, state) => {
    const reduced = reduceRobotAcknowledgement(result, { teamNumber: 2468, revisionId: hash, payloadSha256: hash, catalogId: "robot", catalogHash: hash, supportVersion: "0.2.0" }, "2026-08-14T19:21:00.000Z");
    expect(reduced).toMatchObject({ state, observedAt: "2026-08-14T19:21:00.000Z" });
    expect(JSON.stringify(reduced)).not.toContain("secret");
    expect(JSON.stringify(reduced)).not.toContain("forbidden");
  });

  it("makes save a one-preview capability and never accepts renderer bytes", () => {
    let nextId = 0;
    const capability = new DiagnosticBundleCapability(() => `${++nextId}`.repeat(32));
    const first = capability.preview(buildDiagnosticBundle(input()));
    const second = capability.preview(buildDiagnosticBundle(input({ export: { state: "unavailable" }, routinePreflight: { state: "unavailable", issueCount: 0 } })));

    expect(first.previewId).toBe("1".repeat(32));
    expect(second.previewId).toBe("2".repeat(32));
    expect(() => capability.consume(first.previewId)).toThrow(/no longer current/i);
    expect(capability.consume(second.previewId)).toBe(second.contents);
    expect(() => capability.consume(second.previewId)).toThrow(/no longer current/i);
  });

  it("does not write after cancellation and writes the selected target with the preview's exact bytes", async () => {
    const capability = new DiagnosticBundleCapability(() => "b".repeat(32));
    const preview = capability.preview(buildDiagnosticBundle(input()));
    const writes: Array<{ target: string; contents: string }> = [];

    await expect(saveDiagnosticPreview(preview.previewId, capability, async () => null, async (target, bytes) => {
      writes.push({ target, contents: Buffer.from(bytes).toString("utf8") });
    })).resolves.toEqual({ saved: false });
    expect(writes).toEqual([]);

    await expect(saveDiagnosticPreview(preview.previewId, capability, async () => "/chosen/beta.json", async (target, bytes) => {
      writes.push({ target, contents: Buffer.from(bytes).toString("utf8") });
    })).resolves.toEqual({ saved: true });
    expect(writes).toEqual([{ target: "/chosen/beta.json", contents: preview.contents }]);
  });

  it("has no robot or network dependency", () => {
    const source = fs.readFileSync(new URL("../src/electron/diagnosticBundle.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/robotSftp|connectRobot|\bfetch\s*\(|https?:\/\//);
  });

  it("copies a valid field identity even when an export cannot be built", () => {
    expect(diagnosticFieldPin({
      field: { id: "2026-rebuilt", revision: "2026-manual-tu19-welded-4", coordinateSchemaId: "wpilib-blue-origin/2026-welded/1" },
      paths: [{ name: "must not be copied" }],
    })).toEqual({ id: "2026-rebuilt", revision: "2026-manual-tu19-welded-4", coordinateSchemaId: "wpilib-blue-origin/2026-welded/1" });
    expect(diagnosticFieldPin({ field: { id: "bad field id", revision: "2026-manual-tu19-welded-4", coordinateSchemaId: "wpilib-blue-origin/2026-welded/1" } })).toBeNull();
    expect(diagnosticFieldPin({ field: { id: "PrivateStrategy", revision: "ScoutNotes", coordinateSchemaId: "Secret" } })).toBeNull();
  });
});
