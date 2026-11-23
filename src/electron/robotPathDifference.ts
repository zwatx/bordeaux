import { createHash } from "node:crypto";
import type { RobotPathComparison, RobotPathEventChange, RobotPathFact, RobotPathRoute } from "../core/robotFileDelivery";
import { inspectRobotPath } from "./robotPathBinary";

type PathBinary = ReturnType<typeof inspectRobotPath>;
type Point = [number, number];
const identity = (bytes: Buffer) => ({ size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
const message = (error: unknown) => error instanceof Error ? error.message : "Invalid BDX path data";
const firstLine = (error: unknown) => message(error).split("\n")[0].slice(0, 400);

function coordinate(path: PathBinary, index: number, offset: number) {
  return path.samples.readDoubleBE(index * path.stride + offset);
}

function route(path: PathBinary): RobotPathRoute {
  const count = Math.min(path.sampleCount, 400);
  return {
    field: { id: path.field, revision: path.revision, coordinateSchemaId: path.coordinates },
    endHeading: coordinate(path, path.sampleCount - 1, 40), width: path.width, length: path.length,
    points: Array.from({ length: count }, (_, i) => {
      const index = Math.round(i * (path.sampleCount - 1) / (count - 1));
      return [coordinate(path, index, 24), coordinate(path, index, 32)];
    }),
  };
}

function directedGap(from: Point[], to: Point[]) {
  let largest = 0, worst = from[0], closest = to[0];
  for (const point of from) {
    const [x, y] = point;
    let nearest = Infinity, projected = to[0];
    for (let i = 1; i < to.length; i++) {
      const [ax, ay] = to[i - 1];
      const dx = to[i][0] - ax, dy = to[i][1] - ay;
      const lengthSquared = dx * dx + dy * dy;
      const along = lengthSquared ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSquared)) : 0;
      const px = ax + along * dx, py = ay + along * dy;
      const distanceSquared = (x - px) ** 2 + (y - py) ** 2;
      if (distanceSquared < nearest) {
        nearest = distanceSquared;
        projected = [px, py];
      }
    }
    if (nearest > largest) {
      largest = nearest;
      worst = point;
      closest = projected;
    }
  }
  return { distance: Math.sqrt(largest), from: worst, to: closest };
}

function argumentValue(argument: Buffer | undefined): string {
  if (!argument) return "—";
  const tag = argument.readUInt16BE(), value = argument.subarray(8);
  if (tag === 1) return String(value[0] === 1);
  if (tag === 8) return String(value.readBigInt64BE());
  if (tag === 9) return String(value.readBigUInt64BE());
  if (tag === 10) return String(value.readFloatBE());
  if (tag === 11) return String(value.readDoubleBE());
  if (tag === 12) {
    const text = value.toString("utf8");
    return JSON.stringify(text.length > 40 ? text.slice(0, 39) + "…" : text);
  }
  if (tag >= 13) return "choice #" + value.readUIntBE(0, value.length);
  return String(tag % 2 === 0 ? value.readIntBE(0, value.length) : value.readUIntBE(0, value.length));
}

const EVENT_PREVIEW_LIMIT = 24;
const eventVersion = ({ name, time }: { name: string; time: number }) => ({ name, time });

function eventDifferences(local: PathBinary, robot: PathBinary, result: Binaries) {
  const rows: RobotPathEventChange[] = [];
  let omitted = 0, unchanged = 0;
  const robotOnly = [...robot.events.keys()].filter(id => !local.events.has(id));
  const localOnly = [...local.events.keys()].filter(id => !robot.events.has(id));
  const shared = [...local.events.keys()].filter(id => robot.events.has(id));
  const timeSorted = (ids: string[], events: PathBinary["events"]) =>
    ids.sort((a, b) => events.get(a)!.time - events.get(b)!.time);
  const robotOrder = [...robot.events.keys()].filter(id => local.events.has(id));
  const orderChanged = shared.some((id, index) => id !== robotOrder[index]);
  for (const id of [...timeSorted(robotOnly, robot.events), ...timeSorted(localOnly, local.events), ...timeSorted(shared, local.events)]) {
    const a = local.events.get(id), b = robot.events.get(id);
    const values: RobotPathEventChange["values"] = [], notes: RobotPathEventChange["notes"] = [];
    if (a && b) {
      if (a.command !== b.command) values.push(["Command", a.command, b.command]);
      if (a.schedule.some((value, i) => value !== b.schedule[i])) notes.push(["Schedule", "Different"]);
      if (a.extension.some((value, i) => value !== b.extension[i])) notes.push(["Loop or group", "Different"]);
      let inputChanges = 0;
      for (const key of new Set([...a.args.keys(), ...b.args.keys()])) {
        const before = a.args.get(key), after = b.args.get(key);
        if (before && after && before.equals(after)) continue;
        if (++inputChanges > 3) continue;
        const previous = argumentValue(before), next = argumentValue(after);
        if (previous === next) notes.push([key, "Different value"]);
        else values.push([key, previous, next]);
      }
      const extraInputs = inputChanges - 3;
      if (extraInputs > 0) notes.push(["", "+" + extraInputs + (extraInputs === 1 ? " more input" : " more inputs")]);
      if (a.name === b.name && a.time === b.time && !values.length && !notes.length) {
        unchanged++;
        continue;
      }
    }
    if (rows.length === EVENT_PREVIEW_LIMIT) omitted++;
    else rows.push({ id, local: a && eventVersion(a), robot: b && eventVersion(b), values, notes });
  }
  if (rows.length || orderChanged) result.eventChanges = { rows, omitted, unchanged, orderChanged };
}

function describe(local: PathBinary | undefined, robot: PathBinary | undefined, result: Binaries) {
  const { facts, notes, routes } = result;
  if (!local && !robot) return;
  const add = (label: string, a: string | number | undefined, b: string | number | undefined, unit?: RobotPathFact[3]) =>
    facts.push([label, a ?? "—", b ?? "—", unit]);
  add("Duration", local?.duration, robot?.duration, "s");
  add("Distance", local?.distance, robot?.distance, "m");
  add("Peak speed", local?.peakSpeed, robot?.peakSpeed, "m/s");
  add("Events", local?.eventCount, robot?.eventCount);
  if (robot && !local) {
    add("Field frame", undefined, [robot.field, robot.revision, robot.coordinates].join(" · "));
    add("Planner", undefined, robot.planner);
    add("Format", undefined, `BDX 1.${robot.minor}`);
  }
  if (!local || !robot) return;

  const sameFrame = local.coordinates === robot.coordinates && local.field === robot.field && local.revision === robot.revision;
  if (sameFrame && result.verdict !== "otherPath" && routes?.local && routes.robot && (local.stride !== robot.stride || !local.samples.equals(robot.samples))) {
    const a = routes.local.points, b = routes.robot.points;
    const fromLocal = directedGap(a, b), fromRobot = directedGap(b, a);
    const gap = Math.max(fromLocal.distance, fromRobot.distance);
    if (Number.isFinite(gap) && gap >= 0.001) {
      result.widestGap = fromLocal.distance >= fromRobot.distance
        ? { local: fromLocal.from, robot: fromLocal.to } : { local: fromRobot.to, robot: fromRobot.from };
      add("Approx. route gap", undefined, gap, "m");
    }
    for (const [label, i, j] of [["Start", 0, 0], ["End", local.sampleCount - 1, robot.sampleCount - 1]] as const) {
      for (const [axis, offset] of [["X", 24], ["Y", 32]] as const) {
        const a = coordinate(local, i, offset), b = coordinate(robot, j, offset);
        if (Math.abs(a - b) > 0.001) add(`${label} ${axis}`, a, b, "m");
      }
      const degrees = (radians: number) => (radians % (2 * Math.PI)) * 180 / Math.PI;
      const a = degrees(coordinate(local, i, 40)), b = degrees(coordinate(robot, j, 40));
      if (Math.abs(((a - b + 900) % 360) - 180) > 0.1) add(`${label} heading`, a.toFixed(1) + "°", b.toFixed(1) + "°");
    }
  }
  if (!sameFrame) add("Field frame", [local.field, local.revision, local.coordinates].join(" · "), [robot.field, robot.revision, robot.coordinates].join(" · "));
  if (local.sampleCount !== robot.sampleCount) add("Samples", local.sampleCount, robot.sampleCount);
  if (local.minor !== robot.minor) add("Format", `BDX 1.${local.minor}`, `BDX 1.${robot.minor}`);
  if (local.planner !== robot.planner) add("Planner", local.planner, robot.planner);
  for (const [field, label, unit] of [["width", "Robot width", "m"], ["length", "Robot length", "m"], ["maxSpeed", "Robot speed limit", "m/s"]] as const) {
    if (local[field] !== robot[field]) add(label, local[field], robot[field], unit);
  }
  eventDifferences(local, robot, result);
  if (local.catalog !== robot.catalog || local.catalogHash !== robot.catalogHash) notes.push("Command definitions differ.");
  if (!local.following.equals(robot.following)) notes.push("Follow section boundaries or modes differ.");
  if (local.stride !== robot.stride || !local.samples.equals(robot.samples)) notes.push("Trajectory samples or wheel forces differ.");
}

export function inspectDeployedPath(bytes: Buffer) {
  const file = identity(bytes);
  try { return { file, path: inspectRobotPath(bytes) }; }
  catch (error) { return { file, error: firstLine(error) }; }
}

type Binaries = Omit<RobotPathComparison, "id" | "endpoint" | "readAt" | "name" | "fileName">;
export function compareRobotPath(
  pathId: string | undefined, local: Buffer | { error: unknown } | undefined, robot: Buffer | null,
  deployed = robot === null ? null : inspectDeployedPath(robot),
): Binaries {
  const result: Binaries = { verdict: "missing", facts: [], notes: [] };
  let localPath;
  if (Buffer.isBuffer(local)) {
    result.local = identity(local);
    try { localPath = inspectRobotPath(local); } catch (error) { result.localError = firstLine(error); }
  } else if (local) result.localError = firstLine(local.error);
  const robotPath = deployed?.path;
  if (deployed) {
    result.robot = deployed.file;
    result.robotError = deployed.error;
    result.verdict = !robotPath ? "robotUnreadable" : !pathId ? "robotOnly" : robotPath.id !== pathId ? "otherPath"
      : !localPath ? "localFailed" : result.local?.sha256 === result.robot.sha256 ? "same" : "different";
    result.robotName = robotPath?.name;
    result.robotOnly = !pathId;
  }
  if (localPath || robotPath) result.routes = {
    local: localPath && route(localPath),
    robot: robotPath && route(robotPath),
  };
  describe(localPath, robotPath, result);
  if (result.verdict === "robotOnly" && robotPath?.events.size) {
    const events = [...robotPath.events].sort(([, a], [, b]) => a.time - b.time);
    result.eventChanges = {
      rows: events.slice(0, EVENT_PREVIEW_LIMIT).map(([id, event]) => ({ id, robot: eventVersion(event), values: [], notes: [] })),
      omitted: Math.max(0, events.length - EVENT_PREVIEW_LIMIT),
    };
  }
  if (result.verdict === "different" && result.facts.length === 4 && result.notes.length === 0 && !result.eventChanges) result.notes.push("The BDX metadata or binary encoding differs.");
  return result;
}
