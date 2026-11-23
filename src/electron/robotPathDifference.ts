import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { DecodedBdxArgument, DecodedBdxEvent } from "../core/export/bdxReader";
import type { RobotPathComparison, RobotPathEventChange, RobotPathFact, RobotPathRoute } from "../core/robotFileDelivery";
import { inspectRobotPath } from "./robotPathBinary";

type PathBinary = ReturnType<typeof inspectRobotPath>;
type Point = [number, number];
const identity = (bytes: Uint8Array) => ({ size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
const message = (error: unknown) => error instanceof Error ? error.message : "Invalid BDX path data";
const firstLine = (error: unknown) => message(error).split("\n")[0].slice(0, 400);

function route(path: PathBinary): RobotPathRoute {
  const count = Math.min(path.samples.length, 400);
  return {
    field: path.field,
    endHeading: path.samples.at(-1)!.headingRad, width: path.robot.widthM, length: path.robot.lengthM,
    points: Array.from({ length: count }, (_, i) => {
      const { x, y } = path.samples[Math.round(i * (path.samples.length - 1) / (count - 1))];
      return [x, y];
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

function argumentValue(argument: DecodedBdxArgument | undefined): string {
  if (!argument) return "—";
  if ("choiceIndex" in argument) return "choice #" + argument.choiceIndex;
  if (argument.niType === "String") {
    const text = argument.value;
    return JSON.stringify(text.length > 40 ? text.slice(0, 39) + "…" : text);
  }
  return String(argument.value);
}

const EVENT_PREVIEW_LIMIT = 24;
const eventVersion = ({ name, timeS }: DecodedBdxEvent) => ({ name, time: timeS });
const eventsById = (events: DecodedBdxEvent[]) => new Map(events.map(event => [event.eventId, event]));
const schedule = ({ fraction, repeatEveryS, endTimeS, trigger, cancelOnPathEnd, conditionId }: DecodedBdxEvent) =>
  [fraction, repeatEveryS, endTimeS, trigger, cancelOnPathEnd, conditionId];

function eventDifferences(local: PathBinary, robot: PathBinary, result: Binaries) {
  const aEvents = eventsById(local.events), bEvents = eventsById(robot.events);
  const rows: RobotPathEventChange[] = [];
  let omitted = 0, unchanged = 0;
  const robotOnly = [...bEvents.keys()].filter(id => !aEvents.has(id));
  const localOnly = [...aEvents.keys()].filter(id => !bEvents.has(id));
  const shared = [...aEvents.keys()].filter(id => bEvents.has(id));
  const timeSorted = (ids: string[], events: Map<string, DecodedBdxEvent>) =>
    ids.sort((a, b) => events.get(a)!.timeS - events.get(b)!.timeS);
  const robotOrder = [...bEvents.keys()].filter(id => aEvents.has(id));
  const orderChanged = shared.some((id, index) => id !== robotOrder[index]);
  for (const id of [...timeSorted(robotOnly, bEvents), ...timeSorted(localOnly, aEvents), ...timeSorted(shared, aEvents)]) {
    const a = aEvents.get(id), b = bEvents.get(id);
    const values: RobotPathEventChange["values"] = [], notes: RobotPathEventChange["notes"] = [];
    if (a && b) {
      if (a.vi !== b.vi) values.push(["Command", a.vi, b.vi]);
      if (!isDeepStrictEqual(schedule(a), schedule(b))) notes.push(["Schedule", "Different"]);
      if (!isDeepStrictEqual(a.loop, b.loop) || !isDeepStrictEqual(a.group, b.group)) notes.push(["Loop or group", "Different"]);
      let inputChanges = 0;
      const aArgs = new Map(a.arguments.map(arg => [arg.key, arg])), bArgs = new Map(b.arguments.map(arg => [arg.key, arg]));
      for (const key of new Set([...aArgs.keys(), ...bArgs.keys()])) {
        const before = aArgs.get(key), after = bArgs.get(key);
        if (isDeepStrictEqual(before, after)) continue;
        if (++inputChanges > 3) continue;
        const previous = argumentValue(before), next = argumentValue(after);
        if (previous === next) notes.push([key, "Different value"]);
        else values.push([key, previous, next]);
      }
      const extraInputs = inputChanges - 3;
      if (extraInputs > 0) notes.push(["", "+" + extraInputs + (extraInputs === 1 ? " more input" : " more inputs")]);
      if (a.name === b.name && a.timeS === b.timeS && !values.length && !notes.length) {
        unchanged++;
        continue;
      }
    }
    if (rows.length === EVENT_PREVIEW_LIMIT) omitted++;
    else rows.push({ id, local: a && eventVersion(a), robot: b && eventVersion(b), values, notes });
  }
  if (rows.length || orderChanged) result.eventChanges = { rows, omitted, unchanged, orderChanged };
}

const frameName = ({ id, revision, coordinateSchemaId }: PathBinary["field"]) => [id, revision, coordinateSchemaId].join(" · ");
const peakSpeed = (path: PathBinary | undefined) => path?.samples.reduce((peak, sample) => Math.max(peak, sample.velocityMps), 0);

function describe(local: PathBinary | undefined, robot: PathBinary | undefined, result: Binaries) {
  const { facts, notes, routes } = result;
  if (!local && !robot) return;
  const add = (label: string, a: string | number | undefined, b: string | number | undefined, unit?: RobotPathFact[3]) =>
    facts.push([label, a ?? "—", b ?? "—", unit]);
  add("Duration", local?.totalTimeS, robot?.totalTimeS, "s");
  add("Distance", local?.totalDistanceM, robot?.totalDistanceM, "m");
  add("Peak speed", peakSpeed(local), peakSpeed(robot), "m/s");
  add("Events", local?.events.length, robot?.events.length);
  if (robot && !local) {
    add("Field frame", undefined, frameName(robot.field));
    add("Planner", undefined, robot.planner);
    add("Format", undefined, `BDX 1.${robot.minor}`);
  }
  if (!local || !robot || result.verdict === "same") return;

  const sameFrame = isDeepStrictEqual(local.field, robot.field);
  const differentSamples = !isDeepStrictEqual(local.samples, robot.samples);
  if (sameFrame && result.verdict !== "otherPath" && routes?.local && routes.robot && differentSamples) {
    const a = routes.local.points, b = routes.robot.points;
    const fromLocal = directedGap(a, b), fromRobot = directedGap(b, a);
    const gap = Math.max(fromLocal.distance, fromRobot.distance);
    if (Number.isFinite(gap) && gap >= 0.001) {
      result.widestGap = fromLocal.distance >= fromRobot.distance
        ? { local: fromLocal.from, robot: fromLocal.to } : { local: fromRobot.to, robot: fromRobot.from };
      add("Approx. route gap", undefined, gap, "m");
    }
    for (const [label, i] of [["Start", 0], ["End", -1]] as const) {
      const localPose = local.samples.at(i)!, robotPose = robot.samples.at(i)!;
      for (const axis of ["x", "y"] as const) {
        const a = localPose[axis], b = robotPose[axis];
        if (Math.abs(a - b) > 0.001) add(`${label} ${axis.toUpperCase()}`, a, b, "m");
      }
      const degrees = (radians: number) => (radians % (2 * Math.PI)) * 180 / Math.PI;
      const a = degrees(localPose.headingRad), b = degrees(robotPose.headingRad);
      if (Math.abs(((a - b + 900) % 360) - 180) > 0.1) add(`${label} heading`, a.toFixed(1) + "°", b.toFixed(1) + "°");
    }
  }
  if (!sameFrame) add("Field frame", frameName(local.field), frameName(robot.field));
  if (local.samples.length !== robot.samples.length) add("Samples", local.samples.length, robot.samples.length);
  if (local.minor !== robot.minor) add("Format", `BDX 1.${local.minor}`, `BDX 1.${robot.minor}`);
  if (local.planner !== robot.planner) add("Planner", local.planner, robot.planner);
  for (const [field, label, unit] of [["widthM", "Robot width", "m"], ["lengthM", "Robot length", "m"], ["maxSpeedMps", "Robot speed limit", "m/s"]] as const) {
    if (local.robot[field] !== robot.robot[field]) add(label, local.robot[field], robot.robot[field], unit);
  }
  eventDifferences(local, robot, result);
  if (local.commandProtocolId !== robot.commandProtocolId || local.catalogHash !== robot.catalogHash) notes.push("Command definitions differ.");
  if (!isDeepStrictEqual(local.followSections, robot.followSections)) notes.push("Follow section boundaries or modes differ.");
  if (differentSamples) notes.push("Trajectory samples or wheel forces differ.");
}

export function inspectDeployedPath(bytes: Uint8Array) {
  const file = identity(bytes);
  try { return { file, path: inspectRobotPath(bytes) }; }
  catch (error) { return { file, error: firstLine(error) }; }
}

type Binaries = Omit<RobotPathComparison, "id" | "endpoint" | "readAt" | "name" | "fileName">;
export function compareRobotPath(
  pathId: string | undefined, local: Buffer | { error: unknown } | undefined, robot: Uint8Array | null,
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
  if (result.verdict === "robotOnly" && robotPath?.events.length) {
    const events = [...robotPath.events].sort((a, b) => a.timeS - b.timeS);
    result.eventChanges = {
      rows: events.slice(0, EVENT_PREVIEW_LIMIT).map(event => ({ id: event.eventId, robot: eventVersion(event), values: [], notes: [] })),
      omitted: Math.max(0, events.length - EVENT_PREVIEW_LIMIT),
    };
  }
  if (result.verdict === "different" && result.facts.length === 4 && result.notes.length === 0 && !result.eventChanges) result.notes.push("The BDX metadata or binary encoding differs.");
  return result;
}
