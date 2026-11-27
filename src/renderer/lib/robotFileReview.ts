/**
 * What Pull from robot would change: a robot file's details against the robot's, field by field, grouped by the Robot
 * page's sections and shown in display units. Every difference is listed: a field this table does not name appears
 * under Other with its file key, so nothing changes unseen.
 */
import { UnitPrefs } from "./unitPreferences";
import { DRIVE_MOTOR_PRESETS } from "../../core/motorPresets";
import type { BordeauxProject, ValidationIssue } from "../../core/types";

type Value = unknown;
type Fields = Record<string, Value>;
export type RobotFileChange = { label: string; before: string; after: string };
export type RobotFileChangeGroup = { section: string; rows: RobotFileChange[] };

const NOT_SET = "Not set";
const isFields = (value: Value): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);
const at = (robot: Value, path: readonly string[]): Value => path.reduce<Value>((value, key) => isFields(value) ? value[key] : undefined, robot);
const same = (a: Value, b: Value): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Two numbers shown at the field's precision, with more digits when that precision would show different values as the
 * same text.
 */
function numbers(a: Value, b: Value, unit: string, precision: number, imperialUnit?: string, scale = 1): [string, string] {
  // Ratios and percentages read as one token ("5.50:1", "15%"); a coefficient has no unit to show.
  const show = (value: Value, digits: number) => typeof value === "number" && Number.isFinite(value)
    ? (!unit || unit === "μ" ? (value * scale).toFixed(digits) : unit === ":1" || unit === "%" ? (value * scale).toFixed(digits) + unit
      : UnitPrefs.format(value * scale, unit, digits, imperialUnit)) : NOT_SET;
  for (let digits = precision; ; digits++) {
    const pair: [string, string] = [show(a, digits), show(b, digits)];
    if (pair[0] !== pair[1] || same(a, b) || digits >= precision + 6) return pair;
  }
}

type NumberField = [label: string, path: readonly string[], unit: string, precision: number, imperialUnit?: string, scale?: number];
const DIMENSIONS: NumberField[] = [
  ["Width", ["w"], "m", 2, "in"], ["Length", ["l"], "m", 2, "in"], ["Height", ["heightM"], "m", 2, "in"],
  ["Max speed", ["maxSpeed"], "m/s", 2],
];
const DRIVETRAIN: NumberField[] = [
  ["Motor free speed", ["driveModel", "motorFreeRpm"], "RPM", 0], ["Motor torque limit", ["driveModel", "motorMaxTorqueNm"], "N·m", 2],
  ["Drive reduction", ["driveModel", "gearRatio"], ":1", 2], ["Wheel diameter", ["driveModel", "wheelDiameterM"], "m", 4, "in"],
  ["Drive motors", ["driveModel", "motorCount"], "", 0], ["Mass", ["driveModel", "massKg"], "kg", 1],
  ["Moment of inertia", ["driveModel", "moiKgM2"], "kg·m²", 2], ["Wheelbase", ["driveModel", "wheelbaseM"], "m", 3, "in"],
  ["Trackwidth", ["driveModel", "trackwidthM"], "m", 3, "in"], ["Wheel friction", ["driveModel", "wheelFrictionCoefficient"], "μ", 2],
  ["CG height", ["driveModel", "cgHeightM"], "m", 3, "in"],
];
const ELECTRICAL: NumberField[] = [
  ["Motor stall current", ["driveModel", "motorStallCurrentA"], "A", 0], ["Motor free current", ["driveModel", "motorFreeCurrentA"], "A", 1],
  ["Drive current limit", ["driveModel", "driveCurrentLimitA"], "A", 0], ["Battery voltage", ["driveModel", "batteryVoltageV"], "V", 2],
  ["Battery resistance", ["driveModel", "batteryResistanceOhm"], "mΩ", 1, undefined, 1000], ["Other mechanisms", ["driveModel", "otherLoadA"], "A", 0],
  ["Drive efficiency", ["driveModel", "driveEfficiency"], "%", 0, undefined, 100], ["Control reserve", ["driveModel", "controlReserve"], "%", 0, undefined, 100],
  ["Minimum bus voltage", ["driveModel", "minimumBusVoltageV"], "V", 2],
];
const AGENT: NumberField[] = [
  ["Intake local X", ["planning", "intake", "centerM", "x"], "m", 2, "in"], ["Intake local Y", ["planning", "intake", "centerM", "y"], "m", 2, "in"],
  ["Collection direction", ["planning", "intake", "directionDeg"], "°", 0], ["Capture width", ["planning", "intake", "captureWidthM"], "m", 2, "in"],
  ["Collect speed", ["planning", "intake", "maxCollectSpeedMps"], "m/s", 1],
  ["Shooter direction", ["planning", "shooter", "directionDeg"], "°", 0], ["Preferred range", ["planning", "shooter", "preferredRangeM"], "m", 2, "m"],
];
const BREAKER: NumberField[] = [
  ["rating", ["ratedCurrentA"], "A", 0], ["trip time at 2×", ["tripTimeAt2xS"], "s", 1], ["initial heat", ["initialHeat"], "%", 0, undefined, 100],
];
const COMMAND_LOAD: NumberField[] = [["current", ["currentA"], "A", 0], ["run time", ["runTimeS"], "s", 2]];
const TIMED_LOAD: NumberField[] = [["start", ["startTimeS"], "s", 2], ["end", ["endTimeS"], "s", 2], ["current", ["currentA"], "A", 0]];
const TRAPEZOID: NumberField[] = [["Trapezoid front width", ["footprintPreset", "frontWidthM"], "m", 2, "in"], ["Trapezoid rear width", ["footprintPreset", "rearWidthM"], "m", 2, "in"]];
const CAMERA: NumberField[] = [
  ["forward", ["positionM", "x"], "m", 3, "in"], ["left", ["positionM", "y"], "m", 3, "in"], ["height", ["positionM", "z"], "m", 3, "in"],
  ["yaw", ["yawDeg"], "°", 1], ["pitch", ["pitchDeg"], "°", 1], ["horizontal view", ["horizontalFovDeg"], "°", 1],
  ["vertical view", ["verticalFovDeg"], "°", 1], ["range", ["maxRangeM"], "m", 2, "m"],
];

// Whole, never shortened: two notes that differ only late must not read the same. The table wraps them.
const text = (value: Value) => typeof value === "string" && value.trim() ? value : NOT_SET;
const drive = (value: Value) => value === "swerve" ? "Swerve" : value === "tank" ? "Tank" : text(value);
const motor = (value: Value) => DRIVE_MOTOR_PRESETS.find((preset) => preset.id === value)?.label ?? (value === "custom" ? "Custom motor" : text(value));
const yesNo = (value: Value) => value === true ? "Yes" : value === false ? "No" : NOT_SET;
const list = (robot: Value, path: readonly string[]): Fields[] => { const value = at(robot, path); return Array.isArray(value) ? value.filter(isFields) : []; };
const one = (value: Value, unit: string, precision: number, imperialUnit?: string) => numbers(value, value, unit, precision, imperialUnit)[0];
function shape(robot: Value): string {
  const preset = at(robot, ["footprintPreset"]), vertices = at(robot, ["footprint", "verticesM"]);
  if (!Array.isArray(vertices)) return "Rectangle";
  if (isFields(preset) && preset.kind === "round") return `Round, ${vertices.length} vertices`;
  if (isFields(preset) && preset.kind === "trapezoid") return "Trapezoid";
  return `Custom, ${vertices.length} vertices`;
}
/** Two vertices as "x, y", each coordinate with the digits that tell them apart. */
function vertices(a: Value, b: Value): [string, string] {
  const x = numbers(isFields(a) ? a.x : undefined, isFields(b) ? b.x : undefined, "m", 3, "in");
  const y = numbers(isFields(a) ? a.y : undefined, isFields(b) ? b.y : undefined, "m", 3, "in");
  return [isFields(a) ? `${x[0]}, ${y[0]}` : NOT_SET, isFields(b) ? `${x[1]}, ${y[1]}` : NOT_SET];
}
const commandLoad = (load: Fields | undefined) => !load ? NOT_SET : one(load.currentA, "A", 0) + (load.runTimeS === undefined ? "" : " · " + one(load.runTimeS, "s", 2));
const timedLoad = (load: Fields | undefined) => !load ? NOT_SET : `${one(load.startTimeS, "s", 2).replace(/ s$/, "")}–${one(load.endTimeS, "s", 2)} · ${one(load.currentA, "A", 0)}`;

/**
 * The differences between `current` (the robot as it is) and `incoming` (the file's details), in section order.
 * Empty when Apply would change nothing.
 */
export function robotFileChanges(current: Fields, incoming: Fields): RobotFileChangeGroup[] {
  const groups = new Map<string, RobotFileChange[]>();
  const covered: string[][] = [["id"], ["estimatesFrom"]];
  const add = (section: string, label: string, before: string, after: string) => {
    if (!groups.has(section)) groups.set(section, []);
    groups.get(section)!.push({ label, before, after });
  };
  const numberRows = (section: string, fields: NumberField[], a: Value = current, b: Value = incoming, prefix = "") => {
    for (const [label, path, unit, precision, imperialUnit, scale] of fields) {
      if (a === current) covered.push([...path]);
      const before = at(a, path), after = at(b, path);
      if (!same(before, after)) add(section, prefix + label, ...numbers(before, after, unit, precision, imperialUnit, scale));
    }
  };
  const valueRow = (section: string, label: string, paths: string[][], show: (robot: Value) => string) => {
    covered.push(...paths);
    if (paths.every((path) => same(at(current, path), at(incoming, path)))) return;
    add(section, label, show(current), show(incoming));
  };

  // The outline: its kind, a trapezoid's widths and each vertex, so a changed corner is shown, not just "changed".
  covered.push(["footprint"], ["footprintPreset"]);
  if (shape(current) !== shape(incoming)) add("Dimensions", "Bumper shape", shape(current), shape(incoming));
  numberRows("Dimensions", TRAPEZOID);
  // A round bumper's Curve detail is saved apart from its outline (the shape row counts the outline's vertices), and the
  // Robot page redraws the outline from it, so it is compared on its own.
  const curve = (robot: Value) => at(robot, ["footprintPreset", "kind"]) === "round" ? at(robot, ["footprintPreset", "vertices"]) : undefined;
  const curveText = (value: Value) => typeof value === "number" ? `${value} vertices` : "Not set";
  if (!same(curve(current), curve(incoming))) add("Dimensions", "Curve detail", curveText(curve(current)), curveText(curve(incoming)));
  const outline = (robot: Value) => { const value = at(robot, ["footprint", "verticesM"]); return Array.isArray(value) ? value : []; };
  for (let index = 0; index < Math.max(outline(current).length, outline(incoming).length); index++) {
    const a = outline(current)[index], b = outline(incoming)[index];
    if (!same(a, b)) add("Dimensions", `Bumper vertex ${index + 1}`, ...vertices(a, b));
  }
  numberRows("Dimensions", DIMENSIONS);

  // Cameras pair by id, so a rename (even of case only) is a changed name, not a camera removed and another added. An
  // added or removed camera lists each field it has, so its mount and view are reviewed like a changed one's.
  covered.push(["cameras"]);
  const cameras = (robot: Value) => list(robot, ["cameras"]);
  const id = (camera: Fields) => String(camera.id);
  const before = cameras(current), after = cameras(incoming);
  // The Robot page lists cameras in their saved order and opens on the first, so the same cameras in another order differ.
  const order = (list: Fields[]) => list.map((camera) => String(camera.name ?? camera.id));
  const kept = (list: Fields[], others: Fields[]) => list.filter((camera) => others.some((other) => id(other) === id(camera)));
  if (kept(before, after).map(id).join("\n") !== kept(after, before).map(id).join("\n")) add("Cameras", "Order", order(before).join(", "), order(after).join(", "));
  for (const camera of [...after, ...before.filter((item) => !after.some((other) => id(other) === id(item)))]) {
    const old = before.find((item) => id(item) === id(camera)), next = after.find((item) => id(item) === id(camera));
    const name = String((old ?? camera).name ?? "Camera");
    if (!old || !next) add("Cameras", name, old ? "Present" : "Not present", next ? "Added" : "Removed");
    else if (old.name !== next.name) add("Cameras", name + " name", text(old.name), text(next.name));
    numberRows("Cameras", CAMERA, old ?? {}, next ?? {}, name + " ");
  }

  valueRow("Drivetrain", "Drive type", [["drive"]], (robot) => drive(at(robot, ["drive"])));
  valueRow("Drivetrain", "Drive motor", [["driveModel", "motorId"]], (robot) => motor(at(robot, ["driveModel", "motorId"])));
  numberRows("Drivetrain", DRIVETRAIN);
  numberRows("Electrical", ELECTRICAL);
  // Breakers field by field; command loads paired by command, timed loads by position, each field shown.
  const section = "Loads and breakers";
  for (const [key, name] of [["driveBreaker", "Drive breaker"], ["mainBreaker", "Main breaker"]] as const) {
    covered.push(["driveModel", key]);
    numberRows(section, BREAKER, at(current, ["driveModel", key]) ?? {}, at(incoming, ["driveModel", key]) ?? {}, name + " ");
  }
  covered.push(["driveModel", "commandLoads"], ["driveModel", "loadBursts"]);
  const loadsBefore = list(current, ["driveModel", "commandLoads"]), loadsAfter = list(incoming, ["driveModel", "commandLoads"]);
  const commandIds = [...new Set([...loadsBefore, ...loadsAfter].map((load) => String(load.commandId)))];
  for (const id of commandIds) {
    const old = loadsBefore.find((load) => String(load.commandId) === id), next = loadsAfter.find((load) => String(load.commandId) === id);
    if (!old || !next) add(section, `Command ${id}`, commandLoad(old), commandLoad(next));
    else numberRows(section, COMMAND_LOAD, old, next, `Command ${id} `);
  }
  const burstsBefore = list(current, ["driveModel", "loadBursts"]), burstsAfter = list(incoming, ["driveModel", "loadBursts"]);
  for (let index = 0; index < Math.max(burstsBefore.length, burstsAfter.length); index++) {
    const old = burstsBefore[index], next = burstsAfter[index];
    if (!old || !next) add(section, `Timed load ${index + 1}`, timedLoad(old), timedLoad(next));
    else numberRows(section, TIMED_LOAD, old, next, `Timed load ${index + 1} `);
  }
  valueRow("Agent profile", "Intake name", [["planning", "intake", "name"]], (robot) => text(at(robot, ["planning", "intake", "name"])));
  numberRows("Agent profile", AGENT);
  valueRow("Agent profile", "Shooter must face the target", [["planning", "shooter", "requiresTargetFacing"]], (robot) => yesNo(at(robot, ["planning", "shooter", "requiresTargetFacing"])));
  valueRow("Agent profile", "Planning notes", [["planning", "notes"]], (robot) => text(at(robot, ["planning", "notes"])));

  // Anything else the two hold differently, by its file key.
  const leaves = (value: Value, path: string[] = []): string[][] => isFields(value)
    ? Object.keys(value).flatMap((child) => leaves(value[child], [...path, child])) : path.length ? [path] : [];
  const isCovered = (path: string[]) => covered.some((prefix) => prefix.every((part, index) => path[index] === part));
  const others = new Map<string, string[]>();
  for (const path of [...leaves(current), ...leaves(incoming)]) if (!isCovered(path)) others.set(path.join("."), path);
  for (const [label, path] of others) {
    const a = at(current, path), b = at(incoming, path);
    if (!same(a, b)) add("Other", label, a === undefined ? NOT_SET : text(JSON.stringify(a)), b === undefined ? NOT_SET : text(JSON.stringify(b)));
  }
  return ["Dimensions", "Cameras", "Drivetrain", "Electrical", "Loads and breakers", "Agent profile", "Other"]
    .filter((section) => groups.has(section)).map((section) => ({ section, rows: groups.get(section)! }));
}

/**
 * Errors the project would have after Apply that it does not have now, outside the robot's own details (those make the
 * file unusable instead): a tank drive pulled into a project with an endpoint jiggle, for example. Each names the path
 * or routine it belongs to. Apply is refused while there are any, because Save would then refuse the project.
 */
export function introducedProblems(project: BordeauxProject, before: readonly ValidationIssue[], after: readonly ValidationIssue[]): string[] {
  const key = (issue: ValidationIssue) => issue.path + "\u0000" + issue.message;
  const existing = new Set(before.filter((issue) => issue.severity === "error").map(key));
  const owner = (path: string) => {
    const match = /^\$\.(paths|routines)\[(\d+)\]/.exec(path);
    const item = match && (match[1] === "paths" ? project.paths : project.routines ?? [])[Number(match[2])];
    return item ? `“${item.name}”: ` : "";
  };
  return [...new Set(after.filter((issue) => issue.severity === "error" && !existing.has(key(issue)))
    .map((issue) => owner(issue.path) + issue.message.replace(/\.$/, "") + "."))];
}
