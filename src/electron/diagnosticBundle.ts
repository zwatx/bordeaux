import { randomBytes } from "node:crypto";
import { ACTIVE_FIELD_REFERENCE } from "../shared/field/rebuilt2026";

export const DIAGNOSTIC_FILE_NAME = "bordeaux-beta-diagnostic.json";

type BuildKind = "packaged" | "development";
type Channel = "beta" | "latest";
type PreflightState = "passed" | "failed" | "unavailable";

export interface DiagnosticBundleInput {
  generatedAt: string;
  app: { version: string; build: BuildKind; channel: Channel };
  os: { platform: string; release: string; arch: string };
  fieldPin: { id: string; revision: string; coordinateSchemaId: string } | null;
  catalog: { schemaVersion: "1.0" | "1.1" | "1.2" | "1.3"; catalogId: string; catalogHash: string; supportVersion: string } | null;
  export: { state: "generated"; sha256: string; pathCount: number; eventCount: number; sampleCount: number } | { state: "unavailable" } | { state: "invalid"; issueCount: number };
  routinePreflight: { state: PreflightState; issueCount: number };
  robotAcknowledgement: DiagnosticRobotAcknowledgement;
}

export type DiagnosticRobotAcknowledgement =
  | { state: "not-observed" }
  | { state: "active"; observedAt: string; teamNumber: number; revisionId: string; payloadSha256: string; catalogId: string; catalogHash: string; supportVersion: string }
  | { state: "rejected"; observedAt: string; teamNumber: number; revisionId: string; payloadSha256: string; catalogId: string; catalogHash: string; supportVersion: string; boundary: "activation" | "mailbox" }
  | { state: "staged" | "failed" | "cancelled"; observedAt: string; boundary: "upload" | "staging" | "acknowledgement" };

export interface DiagnosticRobotPushIdentity {
  teamNumber: number;
  revisionId: string;
  payloadSha256: string;
  catalogId: string;
  catalogHash: string;
  supportVersion: string;
}

const HASH = /^sha256:[a-f0-9]{64}$/;
const TEXT = /^[A-Za-z0-9._:-]{1,256}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function text(value: string, name: string): string {
  if (typeof value !== "string" || !TEXT.test(value)) throw new Error(`Diagnostic ${name} is invalid`);
  return value;
}

function time(value: string): string {
  if (typeof value !== "string" || !ISO_TIME.test(value)) throw new Error("Diagnostic timestamp is invalid");
  return value;
}

function hash(value: string, name: string): string {
  if (typeof value !== "string" || !HASH.test(value)) throw new Error(`Diagnostic ${name} is invalid`);
  return value;
}

function count(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) throw new Error(`Diagnostic ${name} is invalid`);
  return value;
}

function teamNumber(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 99_999) throw new Error("Diagnostic team number is invalid");
  return value;
}

function fieldPin(value: DiagnosticBundleInput["fieldPin"] & object): NonNullable<DiagnosticBundleInput["fieldPin"]> {
  if (value.id !== ACTIVE_FIELD_REFERENCE.id || value.revision !== ACTIVE_FIELD_REFERENCE.revision
    || value.coordinateSchemaId !== ACTIVE_FIELD_REFERENCE.coordinateSchemaId) {
    throw new Error("Diagnostic field identity is invalid");
  }
  return { ...ACTIVE_FIELD_REFERENCE };
}

function identity(value: DiagnosticRobotPushIdentity) {
  return {
    teamNumber: teamNumber(value.teamNumber),
    revisionId: hash(value.revisionId, "revision ID"),
    payloadSha256: hash(value.payloadSha256, "payload hash"),
    catalogId: text(value.catalogId, "catalog ID"),
    catalogHash: hash(value.catalogHash, "catalog hash"),
    supportVersion: text(value.supportVersion, "support version"),
  };
}

function acknowledgement(value: DiagnosticRobotAcknowledgement): DiagnosticRobotAcknowledgement {
  if (value.state === "not-observed") return { state: "not-observed" };
  const observedAt = time(value.observedAt);
  if (value.state === "active" || value.state === "rejected") {
    const details = identity(value);
    if (value.state === "active") return { state: "active", observedAt, ...details };
    if (value.boundary !== "activation" && value.boundary !== "mailbox") throw new Error("Diagnostic rejection boundary is invalid");
    return { state: "rejected", observedAt, ...details, boundary: value.boundary };
  }
  if ((value.state !== "staged" && value.state !== "failed" && value.state !== "cancelled")
    || (value.boundary !== "upload" && value.boundary !== "staging" && value.boundary !== "acknowledgement")) {
    throw new Error("Diagnostic robot acknowledgment is invalid");
  }
  return { state: value.state, observedAt, boundary: value.boundary };
}

/**
 * Builds the beta bundle by copying only fixed, reviewable fields. This module
 * deliberately has no project, file, network, or robot transport dependency.
 */
export function buildDiagnosticBundle(input: DiagnosticBundleInput): string {
  const app = input.app;
  if ((app.build !== "packaged" && app.build !== "development") || (app.channel !== "beta" && app.channel !== "latest")) {
    throw new Error("Diagnostic app identity is invalid");
  }
  const os = input.os;
  const bundle = {
    schemaVersion: "bordeaux-beta-diagnostic/1.0" as const,
    generatedAt: time(input.generatedAt),
    app: { version: text(app.version, "app version"), build: app.build, channel: app.channel },
    os: { platform: text(os.platform, "platform"), release: text(os.release, "release"), arch: text(os.arch, "architecture") },
    fieldPin: input.fieldPin === null ? null : fieldPin(input.fieldPin),
    catalog: input.catalog === null ? null : {
      schemaVersion: input.catalog.schemaVersion,
      catalogId: text(input.catalog.catalogId, "catalog ID"),
      catalogHash: hash(input.catalog.catalogHash, "catalog hash"),
      supportVersion: text(input.catalog.supportVersion, "support version"),
    },
    export: input.export.state === "generated" ? {
      state: "generated" as const,
      sha256: hash(input.export.sha256, "export hash"),
      pathCount: count(input.export.pathCount, "path count"),
      eventCount: count(input.export.eventCount, "event count"),
      sampleCount: count(input.export.sampleCount, "sample count"),
    } : input.export.state === "invalid"
      ? { state: "invalid" as const, issueCount: count(input.export.issueCount, "export issue count") }
      : { state: input.export.state },
    routinePreflight: {
      state: input.routinePreflight.state,
      issueCount: count(input.routinePreflight.issueCount, "routine issue count"),
    },
    robotAcknowledgement: acknowledgement(input.robotAcknowledgement),
  };
  if (bundle.routinePreflight.state !== "passed" && bundle.routinePreflight.state !== "failed" && bundle.routinePreflight.state !== "unavailable") {
    throw new Error("Diagnostic routine preflight is invalid");
  }
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Extracts only the field identity from a project-shaped value. */
export function diagnosticFieldPin(project: unknown): DiagnosticBundleInput["fieldPin"] {
  const field = record(record(project)?.field);
  if (!field || typeof field.id !== "string" || typeof field.revision !== "string" || typeof field.coordinateSchemaId !== "string") {
    return null;
  }
  try {
    return fieldPin({ id: field.id, revision: field.revision, coordinateSchemaId: field.coordinateSchemaId });
  } catch {
    return null;
  }
}

/** Reduces an already-completed local push result; it never contacts the robot. */
export function reduceRobotAcknowledgement(
  result: unknown,
  expected: DiagnosticRobotPushIdentity,
  observedAt: string,
): DiagnosticRobotAcknowledgement {
  const source = record(result);
  const state = source?.state;
  if (state === "active") return { state: "active", observedAt: time(observedAt), ...identity(expected) };
  if (state === "rejected") {
    const boundary = source?.boundary;
    if (boundary === "activation" || boundary === "mailbox") return { state: "rejected", observedAt: time(observedAt), ...identity(expected), boundary };
    return { state: "failed", observedAt: time(observedAt), boundary: "acknowledgement" };
  }
  if (state === "staged") return { state: "staged", observedAt: time(observedAt), boundary: "acknowledgement" };
  if (state === "cancelled") return { state: "cancelled", observedAt: time(observedAt), boundary: source?.boundary === "staging" ? "staging" : "upload" };
  return { state: "failed", observedAt: time(observedAt), boundary: source?.boundary === "staging" ? "staging" : "upload" };
}

export class DiagnosticBundleCapability {
  private pending: { previewId: string; contents: string } | null = null;

  constructor(private readonly createPreviewId: () => string = () => randomBytes(18).toString("hex")) {}

  preview(contents: string): { previewId: string; contents: string; fileName: typeof DIAGNOSTIC_FILE_NAME } {
    if (typeof contents !== "string" || !contents.endsWith("\n")) throw new Error("Diagnostic preview contents are invalid");
    const previewId = this.createPreviewId();
    if (!/^[a-f0-9]{24,128}$/.test(previewId)) throw new Error("Diagnostic preview ID is invalid");
    this.pending = { previewId, contents };
    return { previewId, contents, fileName: DIAGNOSTIC_FILE_NAME };
  }

  peek(previewId: unknown): string {
    if (typeof previewId !== "string" || !this.pending || previewId !== this.pending.previewId) {
      throw new Error("This diagnostic preview is no longer current; preview it again");
    }
    return this.pending.contents;
  }

  consume(previewId: unknown): string {
    const contents = this.peek(previewId);
    this.pending = null;
    return contents;
  }

  clear(): void {
    this.pending = null;
  }
}

export async function saveDiagnosticPreview(
  previewId: unknown,
  capability: DiagnosticBundleCapability,
  selectTarget: (fileName: typeof DIAGNOSTIC_FILE_NAME) => Promise<string | null>,
  writeAtomically: (target: string, bytes: Uint8Array) => Promise<void>,
): Promise<{ saved: false } | { saved: true }> {
  capability.peek(previewId);
  const target = await selectTarget(DIAGNOSTIC_FILE_NAME);
  if (!target) return { saved: false };
  const contents = capability.consume(previewId);
  await writeAtomically(target, Buffer.from(contents, "utf8"));
  return { saved: true };
}
