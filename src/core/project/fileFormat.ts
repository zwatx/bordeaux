import type { BordeauxProject } from "../types";
import { ACTIVE_FIELD_REFERENCE, BLUE_ORIGIN_FIELD_SCHEMA_ID, WELDED_FIELD_REVISION } from "../field/rebuilt2026";
import { validateProjectSource } from "../validation";
import { promoteRoutineProjectSchema } from "./routineSchema";
import { normalizeProject } from "./normalize";
import { migrateLegacyOptimizations } from "./legacyOptimization";
import { LEGACY_FIELD_SCHEMA, migrateFieldProject } from "./fieldMigration";
import { storedRobotDetails } from "./robots";

const CURRENT_PROJECT_SCHEMA_VERSION = "1.0" as const;

export interface DecodedProjectFile {
  project: BordeauxProject;
  migrated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertSupportedFieldReference(value: unknown): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new Error("Bordeaux field compatibility error: the field reference must be an object.");
  if (value.id !== ACTIVE_FIELD_REFERENCE.id) {
    throw new Error(`Bordeaux field compatibility error: unsupported field ID ${JSON.stringify(value.id)}.`);
  }
  const historical = value.coordinateSchemaId === BLUE_ORIGIN_FIELD_SCHEMA_ID || value.coordinateSchemaId === LEGACY_FIELD_SCHEMA;
  if (value.revision !== (historical ? WELDED_FIELD_REVISION : ACTIVE_FIELD_REFERENCE.revision)) {
    throw new Error(`Bordeaux field compatibility error: unsupported field revision ${JSON.stringify(value.revision)}.`);
  }
  if (value.coordinateSchemaId !== ACTIVE_FIELD_REFERENCE.coordinateSchemaId && value.coordinateSchemaId !== BLUE_ORIGIN_FIELD_SCHEMA_ID && value.coordinateSchemaId !== LEGACY_FIELD_SCHEMA) {
    throw new Error(`Bordeaux field compatibility error: unsupported coordinate schema ${JSON.stringify(value.coordinateSchemaId)}.`);
  }
}

function hasNumericRoutineReference(nodes: unknown, depth = 0): boolean {
  if (!Array.isArray(nodes)) return false;
  if (depth > 64) return false;
  return nodes.some((node) => {
    if (!isRecord(node)) return false;
    if (node.type === "path") return typeof node.ref === "number";
    if (node.type === "repeat" || node.type === "group") return hasNumericRoutineReference(node.nodes, depth + 1);
    if (node.type === "decision") {
      return hasNumericRoutineReference(node.then, depth + 1) || hasNumericRoutineReference(node.else, depth + 1);
    }
    if (isRecord(node.outputBranch) && Array.isArray(node.outputBranch.routes)) {
      return node.outputBranch.routes.some((route) => isRecord(route) && hasNumericRoutineReference(route.nodes, depth + 1));
    }
    return false;
  });
}

function needsV1Migration(value: Record<string, unknown>): boolean {
  const hasMissingPathId = Array.isArray(value.paths) && value.paths.some((path) =>
    isRecord(path) && (typeof path.id !== "string" || !path.id.trim()),
  );
  const routines = Array.isArray(value.routines) ? value.routines : [];
  const routineIds = new Set(routines.flatMap((routine) =>
    isRecord(routine) && typeof routine.id === "string" && routine.id.trim() ? [routine.id] : [],
  ));
  const hasInvalidRoutineState = routines.length === 0
    || routines.some((routine) => !isRecord(routine) || typeof routine.id !== "string" || !routine.id.trim())
    || typeof value.activeRoutineId !== "string"
    || !routineIds.has(value.activeRoutineId);
  const hasNumericReference = routines.some((routine) => isRecord(routine) && hasNumericRoutineReference(routine.nodes))
    || (isRecord(value.routine) && hasNumericRoutineReference(value.routine.nodes));
  const hasInvalidPlanner = value.plannerId !== "profiledSpline" && value.plannerId !== "optimizedTrajectory";
  const hasLegacyAngularDeceleration = Array.isArray(value.paths) && value.paths.some((path) => (
    isRecord(path) && isRecord(path.constraints) && path.constraints.maxAngDecel === 0
  ));
  return hasMissingPathId || "routine" in value || hasInvalidRoutineState || hasNumericReference
    || hasInvalidPlanner || hasLegacyAngularDeceleration;
}

function validatedProject(value: unknown, migrated: boolean): DecodedProjectFile {
  const prepared = migrateFieldProject(value);
  const needsFieldMigration = prepared !== value;
  const routinePromoted = isRecord(prepared) ? promoteRoutineProjectSchema(prepared) : prepared;
  // A robot list needs 1.3, so builds without robot lists refuse the file instead of saving it without them.
  const hasRobotList = isRecord(routinePromoted) && routinePromoted.robots !== undefined;
  const promoted = hasRobotList && isRecord(routinePromoted) && routinePromoted.schemaVersion !== "1.3"
    ? { ...routinePromoted, schemaVersion: "1.3" } : routinePromoted;
  const project = normalizeProject(promoted);
  const validation = validateProjectSource(project);
  if (!validation.ok) {
    const message = validation.issues.map((item) => `${item.path}: ${item.message}`).join("\n");
    throw new Error(`Invalid Bordeaux project:\n${message}`);
  }
  const hydrated = migrateLegacyOptimizations(project as BordeauxProject, routinePromoted, needsFieldMigration);
  return { project: hydrated, migrated: migrated || needsFieldMigration || promoted !== prepared || hydrated !== project };
}

export function decodeProjectValue(value: unknown): DecodedProjectFile {
  if (!isRecord(value)) return validatedProject(value, false);
  assertSupportedFieldReference(value.field);

  if (value.schemaVersion !== undefined) {
    if (value.schemaVersion !== "1.0" && value.schemaVersion !== "1.1" && value.schemaVersion !== "1.2" && value.schemaVersion !== "1.3") {
      throw new Error(
        `Unsupported Bordeaux project schema version ${JSON.stringify(value.schemaVersion)}. ` +
        `This version of Bordeaux supports 1.0, 1.1, 1.2 and 1.3.`,
      );
    }
    return validatedProject(value, needsV1Migration(value));
  }

  if (Array.isArray(value.paths)) {
    return validatedProject(
      { ...value, schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION },
      true,
    );
  }

  if (Array.isArray(value.waypoints) && value.version !== undefined) {
    if (value.version !== "2.0" && value.version !== "2.1") {
      throw new Error(
        `Unsupported Bordeaux path version ${JSON.stringify(value.version)}. This version of Bordeaux supports path versions 2.0 and 2.1.`,
      );
    }
    const { version: _version, robot, field, fieldMigration, ...path } = value;
    const name = typeof value.name === "string" && value.name.trim() ? value.name : "Imported Path";
    return validatedProject(
      {
        schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION,
        name,
        robot,
        ...(field !== undefined ? { field } : {}),
        ...(fieldMigration !== undefined ? { fieldMigration } : {}),
        paths: [path],
        plannerId: "profiledSpline",
      },
      true,
    );
  }

  return validatedProject(value, false);
}

export function decodeProjectFile(contents: string): DecodedProjectFile {
  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch {
    throw new Error("Invalid Bordeaux project: the file is not valid JSON.");
  }
  return decodeProjectValue(value);
}

/** The normalized, validated project that `encodeProjectFile` would write. */
export function prepareProjectFile(value: unknown): BordeauxProject {
  // Normalization strips editor state; the copy keeps a queued save unaffected
  // by later edits to the caller's objects.
  const decoded = decodeProjectValue(structuredClone(value));
  return decoded.project;
}

/**
 * A prepared project as every file stores it: without the selected robot's in-memory `id` (see storedRobotDetails).
 * Loading (`normalizeProject`) derives the id again, so a stored project loads back to the same in-memory project.
 * Use it wherever a project is written: the project file, a folder workspace, a recovery record.
 */
export function storedProject(project: BordeauxProject): BordeauxProject {
  const robot = storedRobotDetails(project.robot);
  const listed = project.robots?.some((entry) => entry.robot?.id !== undefined);
  if (robot === project.robot && !listed) return project;
  return { ...project, robot, ...(listed ? { robots: project.robots!.map((entry) => entry.robot ? { ...entry, robot: storedRobotDetails(entry.robot) } : entry) } : {}) };
}

/** The prepared project (in memory, with the selected robot's id) and the file contents (`storedProject`). */
export function encodeProjectFile(value: unknown): { project: BordeauxProject; contents: string } {
  const project = prepareProjectFile(value);
  return { project, contents: `${JSON.stringify(storedProject(project), null, 2)}\n` };
}
