/**
 * A robot's details as a readable `.robot` file: `Robots/<name>.robot` in a project folder, and `<name>.robot` beside
 * the paths a Push sends. It holds the robot's name and details only. Its address, host keys and passwords belong to
 * each computer, and `id` and `estimatesFrom` are project ids that mean nothing outside the project, so none of them
 * is ever written (see ROBOT_DETAILS). Command power estimates stay on the command uses in paths and routines.
 */
import type { BreakerModel, BordeauxProject, CommandLoad, RobotCamera, RobotConfig, RobotPlanningProfile, ValidationIssue } from "../types";
import { portableFileStem } from "../portableFileName";
import { utf8ByteLength } from "../bytes";
import { ROBOT_NAME_MAX, projectRobots } from "./robots";

export const ROBOT_FILE_FORMAT = "bordeaux-robot/1";
/** A robot file is small; this bounds what a Pull reads and parses. */
export const MAX_ROBOT_FILE_BYTES = 1024 * 1024;

/*
 * What a robot file carries: an explicit allowlist of the robot's transferable details, nested objects included, so a
 * field the editor or a hand-edited file holds besides them (an address, a host key, a password, the project-only `id`
 * and `estimatesFrom`, anything unknown) is never written, pushed or read. The shape is typed as well as named: `true`
 * keeps a scalar (string, number or boolean), an object keeps only its own listed keys, `[shape]` keeps a list item by
 * item, and `byKind` keeps a variant's own fields for its `kind` (a trapezoid preset has no `vertices`). A value of the
 * wrong type for its place is dropped, so nothing nested ever rides along under a listed key. The types make a new
 * RobotConfig or drive model field fail to compile until it is listed here, so no detail is dropped unseen.
 */
type Shape = true | readonly [Shape] | ByKind | { readonly [key: string]: Shape };
class ByKind { constructor(readonly kinds: { readonly [kind: string]: { readonly [key: string]: Shape } }) {} }
type Fields<T> = { readonly [K in keyof T]-?: Shape };
type Preset = NonNullable<RobotConfig["footprintPreset"]>;
const POINT = { x: true, y: true } as const;
const BREAKER = { ratedCurrentA: true, tripTimeAt2xS: true, initialHeat: true } as const satisfies Fields<BreakerModel>;
type DriveModel = NonNullable<RobotConfig["driveModel"]>;
const DRIVE_MODEL = {
  motorId: true, motorFreeRpm: true, motorMaxTorqueNm: true, motorCount: true, gearRatio: true, wheelDiameterM: true, massKg: true,
  moiKgM2: true, wheelbaseM: true, trackwidthM: true, wheelFrictionCoefficient: true, cgHeightM: true, motorStallCurrentA: true,
  motorFreeCurrentA: true, driveCurrentLimitA: true, batteryVoltageV: true, batteryResistanceOhm: true, otherLoadA: true,
  driveEfficiency: true, controlReserve: true, minimumBusVoltageV: true,
  commandLoads: [{ commandId: true, currentA: true, runTimeS: true } satisfies Fields<CommandLoad>],
  loadBursts: [{ startTimeS: true, endTimeS: true, currentA: true }], driveBreaker: BREAKER, mainBreaker: BREAKER,
} as const satisfies Fields<DriveModel>;
const CAMERA = { id: true, name: true, horizontalFovDeg: true, verticalFovDeg: true, positionM: { x: true, y: true, z: true }, yawDeg: true,
  pitchDeg: true, maxRangeM: true } as const satisfies Fields<RobotCamera>;
const PRESET_KINDS = {
  round: { kind: true, vertices: true }, trapezoid: { kind: true, frontWidthM: true, rearWidthM: true }, custom: { kind: true },
} as const satisfies { [K in Preset["kind"]]: Fields<Extract<Preset, { kind: K }>> };
const ROBOT_DETAILS = {
  drive: true, w: true, l: true, heightM: true, maxSpeed: true,
  footprint: new ByKind({ polygon: { kind: true, verticesM: [POINT] } satisfies Fields<NonNullable<RobotConfig["footprint"]>> }),
  footprintPreset: new ByKind(PRESET_KINDS),
  planning: {
    intake: { name: true, centerM: POINT, directionDeg: true, captureWidthM: true, maxCollectSpeedMps: true },
    shooter: { directionDeg: true, requiresTargetFacing: true, preferredRangeM: true }, notes: true,
  } satisfies Fields<RobotPlanningProfile>,
  cameras: [CAMERA], driveModel: DRIVE_MODEL,
} as const satisfies Fields<Omit<RobotConfig, "id" | "estimatesFrom">>;

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function pickFields(value: Record<string, unknown>, shape: { readonly [key: string]: Shape }): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(shape)) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const picked = pick(value[key], child);
    if (picked !== undefined) kept[key] = picked;
  }
  return kept;
}

/** `value` as `shape` allows it, or undefined when its type doesn't fit its place. */
function pick(value: unknown, shape: Shape): unknown {
  if (shape === true) return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : undefined;
  if (Array.isArray(shape)) return Array.isArray(value) ? value.map((item) => pick(item, shape[0])).filter((item) => item !== undefined) : undefined;
  if (!isObject(value)) return undefined;
  // An unknown kind keeps only the kind, so the validator names it rather than the file losing it unseen.
  if (shape instanceof ByKind) return pickFields(value, typeof value.kind === "string" && Object.hasOwn(shape.kinds, value.kind) ? shape.kinds[value.kind] : { kind: true });
  return pickFields(value, shape as { readonly [key: string]: Shape });
}

/**
 * The first allowlisted field in `value` whose type doesn't fit its place (`driveModel` given as a list, a width given
 * as text), as its dotted path, or null. Unknown fields are not problems: they are dropped. A recognised field of the
 * wrong type must not be dropped on import, or a broken file would read as a request to remove that field.
 */
function shapeProblem(value: unknown, shape: Shape, path: string): string | null {
  if (shape === true) return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? null : path;
  if (Array.isArray(shape)) {
    if (!Array.isArray(value)) return path;
    for (let i = 0; i < value.length; i++) { const problem = shapeProblem(value[i], shape[0], `${path}[${i}]`); if (problem) return problem; }
    return null;
  }
  if (!isObject(value)) return path;
  const fields = shape instanceof ByKind
    ? (typeof value.kind === "string" && Object.hasOwn(shape.kinds, value.kind) ? shape.kinds[value.kind] : { kind: true })
    : shape as { readonly [key: string]: Shape };
  for (const [key, child] of Object.entries(fields)) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const problem = shapeProblem(value[key], child, path ? `${path}.${key}` : key);
    if (problem) return problem;
  }
  return null;
}

/** The robot's details as a file stores them: only the allowlisted, transferable fields. */
export function robotFileDetails(robot: RobotConfig): RobotConfig {
  return pick(robot, ROBOT_DETAILS) as RobotConfig;
}

/** The file's text. Its name comes first so the file reads as that robot's. */
export function robotFileContents(name: string, robot: RobotConfig): string {
  return `${JSON.stringify({ format: ROBOT_FILE_FORMAT, name, ...robotFileDetails(robot) }, null, 2)}\n`;
}

/**
 * The name a robot's file has in a push folder: the plain-ASCII stem a pushed BDX of that name gets (binaryFileName in
 * export/robotBinary.ts, not imported so folder layout stays clear of the planner), with `.robot`.
 */
export function robotPushFileName(name: string): string {
  const base = name.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[._-]+|[._-]+$/g, "").slice(0, 80) || "Bordeaux";
  return `${portableFileStem(base, 80)}.robot`;
}

/**
 * Why `robotId`'s details can't be pushed or pulled, or null when they can: another robot in the project has a name
 * that maps to the same push file (`Comp bot` and `Comp-bot` are both `Comp-bot.robot`), so either robot's Push would
 * replace the other's file and a Pull could read the other's details. Renaming one resolves it. A generated unique
 * name was not used instead: it would depend on the other robot staying in the project under the same name, so a
 * rename or removal would silently move a robot's file to another name on the robot.
 */
export function robotPushFileConflict(project: BordeauxProject, robotId: string): string | null {
  const robots = projectRobots(project), robot = robots.find((entry) => entry.id === robotId);
  if (!robot) return null;
  const fileName = robotPushFileName(robot.name);
  const other = robots.find((entry) => entry.id !== robotId && robotPushFileName(entry.name).toLowerCase() === fileName.toLowerCase());
  return other ? `“${robot.name}” and “${other.name}” would both use ${fileName} on the robot. Rename one of them to push or pull its details.` : null;
}

export const isRobotFileName = (fileName: string): boolean => /\.robot$/i.test(fileName);

/**
 * Reads a robot file's structure: JSON, its format and its name. Throws an Error whose message says why the file can't
 * be used. Its details still need the project validator (`validateRobotDetails` in core/validation.ts, or the host's
 * validateProject in the editor, which keeps the validator out of the page) before they are applied.
 */
export function parseRobotFile(text: string): { name: string; robot: RobotConfig } {
  if (utf8ByteLength(text) > MAX_ROBOT_FILE_BYTES) throw new Error(`It is larger than ${MAX_ROBOT_FILE_BYTES / 1024 / 1024} MiB.`);
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error("It is not valid JSON."); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("It is not a robot file.");
  const { format, name, ...rest } = raw as Record<string, unknown>;
  if (format !== ROBOT_FILE_FORMAT) throw new Error(typeof format === "string" && format.startsWith("bordeaux-robot/")
    ? `It was written by a newer Bordeaux (${format}).` : "It is not a robot file.");
  if (typeof name !== "string" || !name.trim() || name.trim().length > ROBOT_NAME_MAX) throw new Error(`Its robot name must be 1 to ${ROBOT_NAME_MAX} characters.`);
  const wrong = shapeProblem(rest, ROBOT_DETAILS, "");
  if (wrong) throw new Error(`Its ${wrong} has the wrong type.`);
  return { name: name.trim(), robot: robotFileDetails(rest as unknown as RobotConfig) };
}

/**
 * The first validation error about robot details at `base` (`$` for a file's details, `$.robot` for the selected
 * robot in a project), as a sentence naming the field, or null when there is none.
 */
export function robotDetailsProblem(issues: readonly ValidationIssue[], base = "$"): string | null {
  const problem = issues.find((issue) => issue.severity === "error" && (issue.path === base || issue.path.startsWith(base + ".") || issue.path.startsWith(base + "[")));
  if (!problem) return null;
  const field = problem.path.slice(base.length).replace(/^\./, "");
  return `${problem.message.replace(/\.$/, "")}${field ? ` (${field})` : ""}.`;
}
