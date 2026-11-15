import { describe, expect, it } from "vitest";
import { buildRobotBinary } from "../src/shared/export/robotBinary";
import { buildRobotTrajectory } from "../src/shared/export/robotTrajectory";
import { validateProject } from "../src/shared/validation";
import { normalizeProject } from "../src/shared/project/normalize";
import { validateProjectRobotInvocations } from "../src/shared/robotCommands";
import { projectCommandIds } from "../src/electron/usedCommands";
import { markerInvocations } from "../src/shared/markerCommands";
import { binaryWriterFixture } from "./fixtures/binaryWriterFixture";
import type { CommandInvocation, Marker } from "../src/shared/types";

const build = (fixture: ReturnType<typeof binaryWriterFixture>) => buildRobotBinary(fixture.project, { kind: "path", id: fixture.path.id }, fixture.bindings);
const command = (_fixture: ReturnType<typeof binaryWriterFixture>, patch: Partial<CommandInvocation> = {}): CommandInvocation =>
  ({ ...structuredClone(binaryWriterFixture().path.markers[0].invocation!), ...patch });

/** Independent reader for the published 1.1/1.2 event layout. */
function readEvents(bytes: Uint8Array) {
  const b = Buffer.from(bytes), minor = b.readUInt16BE(10); let offset = 32;
  const u32 = () => { const n = b.readUInt32BE(offset); offset += 4; return n; };
  const u16 = () => { const n = b.readUInt16BE(offset); offset += 2; return n; };
  const dbl = () => { const n = b.readDoubleBE(offset); offset += 8; return n; };
  const text = () => { const length = u32(); const value = b.subarray(offset, offset + length).toString("utf8"); offset += length; return value; };
  offset += 4 + b.readUInt32BE(offset);
  offset += 4 + b.readUInt32BE(offset) * 120;
  offset += 4 + b.readUInt32BE(offset) * 16;
  const events = Array.from({ length: u32() }, () => {
    const end = u32() + offset, ids = Array.from({ length: 4 }, text), schedule = Array.from({ length: 4 }, dbl);
    offset += 2; expect(u16()).toBe(0);
    const args = Array.from({ length: u32() }, () => { const key = text(); u16(); u16(); const size = u32(); offset += size; return key; });
    const extension = minor >= 2 ? { loopKind: b[offset++], groupMode: b[offset++], groupOrder: u16(), loopLimit: dbl(), groupId: text() } : null;
    expect(offset).toBe(end);
    return { eventId: ids[0], name: ids[1], schedule, args, extension };
  });
  expect(offset).toBe(b.length);
  return { minor, events };
}

function groupedFixture() {
  const fixture = binaryWriterFixture();
  const [first, second] = fixture.path.markers;
  first.commandGroup = { mode: "parallel", commands: [command(fixture, { loop: { until: { kind: "time", seconds: 1.5 } } }), command(fixture)] };
  delete first.invocation;
  delete second.schedule!.repeatEveryS;
  second.invocation!.loop = { until: { kind: "distance", meters: 0.5 } };
  return fixture;
}

describe("path command groups and loops", () => {
  it("validates loop limits and group shape structurally", () => {
    const fixture = groupedFixture();
    expect(validateProject(fixture.project).issues.filter((item) => item.severity === "error")).toEqual([]);
    const errors = (mutate: (group: Marker, single: Marker) => void) => {
      const project = structuredClone(fixture.project), [group, single] = project.paths[0].markers;
      mutate(group, single);
      return validateProject(project).issues.filter((item) => item.severity === "error").map((item) => `${item.path}: ${item.message}`);
    };
    expect(errors((group) => { group.commandGroup!.commands[0].loop = { until: { kind: "output", output: "done", operator: "eq", value: true } }; }))
      .toEqual([expect.stringMatching(/commandGroup\.commands\[0\]\.loop\.until\.kind: Loop conditions are routine-only/)]);
    expect(errors((group) => { group.commandGroup!.commands[0].loop = { until: { kind: "time", seconds: 0.01 } }; })).toEqual([expect.stringMatching(/Loop time must be from 0.02 to 3600 seconds/)]);
    expect(errors((_, single) => { single.invocation!.loop = { until: { kind: "distance", meters: 0 } }; })).toEqual([expect.stringMatching(/Loop distance must be greater than zero/)]);
    expect(errors((group) => { group.commandGroup!.commands.pop(); })).toEqual([expect.stringMatching(/needs 2 to 16 commands/)]);
    expect(errors((group) => { group.invocation = command(fixture); })).toEqual([expect.stringMatching(/either one command or a command group/)]);
    expect(errors((group) => { (group.commandGroup as unknown as Record<string, unknown>).mode = "deadline"; })).toEqual([expect.stringMatching(/parallel or in sequence/)]);
    expect(errors((_, single) => { (single.invocation as unknown as Record<string, unknown>).loop = { until: { kind: "forever" } }; })).toEqual([expect.stringMatching(/Loop limit must be/)]);
  });

  it("round-trips groups and loops through project loading", () => {
    const fixture = groupedFixture();
    const loaded = normalizeProject(JSON.parse(JSON.stringify(fixture.project))) as typeof fixture.project;
    expect(validateProject(loaded).ok).toBe(true);
    expect(loaded.paths[0].markers[0].commandGroup).toEqual(fixture.path.markers[0].commandGroup);
    expect(loaded.paths[0].markers[1].invocation!.loop).toEqual({ until: { kind: "distance", meters: 0.5 } });
  });

  it("checks every grouped command against the catalog and counts it as used", () => {
    const fixture = groupedFixture();
    fixture.path.markers[0].commandGroup!.commands[1] = { commandId: "missing.command", arguments: {} };
    expect(validateProjectRobotInvocations(fixture.project, fixture.bindings.catalog).map((item) => item.path))
      .toEqual(["$.paths[0].markers[0].commandGroup.commands[1].commandId"]);
    expect([...projectCommandIds(fixture.project, { pathIds: [fixture.path.id] })].sort()).toEqual(["fixture.command", "missing.command"]);
    expect(markerInvocations(fixture.path.markers[0]).map((item) => item.commandId)).toEqual(["fixture.command", "missing.command"]);
  });

  it("keeps BDX 1.1 bytes when no event loops or groups", () => {
    const plain = binaryWriterFixture(), built = build(plain), wire = readEvents(built.bytes);
    expect(wire.minor).toBe(1);
    expect(wire.events.map((event) => event.extension)).toEqual([null, null]);
    expect(built.document.paths[0].events.every((event) => !("loop" in event) && !("group" in event))).toBe(true);
  });

  it("writes BDX 1.2 records for grouped and looping events", () => {
    const fixture = groupedFixture(), built = build(fixture), wire = readEvents(built.bytes), path = built.document.paths[0];
    expect(wire.minor).toBe(2);
    expect(wire.events.map((event) => [event.eventId, event.extension])).toEqual([
      ["fixture-event-0#0", { loopKind: 1, groupMode: 1, groupOrder: 0, loopLimit: 1.5, groupId: "fixture-event-0" }],
      ["fixture-event-0#1", { loopKind: 0, groupMode: 1, groupOrder: 1, loopLimit: 0, groupId: "fixture-event-0" }],
      ["fixture-event-1", { loopKind: 2, groupMode: 0, groupOrder: 0, loopLimit: 0.5, groupId: "" }],
    ]);
    // Group members share the event's time and fraction, and keep their own arguments.
    expect(wire.events[0].schedule).toEqual(wire.events[1].schedule);
    expect(wire.events[0].args).toEqual(["enabled", "power", "count", "sequence", "mode", "label"]);
    expect(path.events.map((event) => event.group)).toEqual([{ id: "fixture-event-0", mode: "parallel", order: 0 }, { id: "fixture-event-0", mode: "parallel", order: 1 }, undefined]);
  });

  it("orders sequential members by group order and encodes path end loops", () => {
    const fixture = groupedFixture(), group = fixture.path.markers[0].commandGroup!;
    group.mode = "sequential";
    group.commands = Array.from({ length: 12 }, (_, index) => command(fixture, index === 11 ? { loop: { until: { kind: "pathEnd" } } } : {}));
    const trajectory = buildRobotTrajectory(fixture.project, fixture.bindings.catalog, { requireGeneratedBindings: false });
    expect(trajectory.eventCount).toBe(13);
    const wire = readEvents(build(fixture).bytes);
    const members = wire.events.filter((event) => event.extension!.groupId === "fixture-event-0");
    expect(members.map((event) => event.extension!.groupOrder)).toEqual([...Array(12).keys()]);
    expect(members.every((event) => event.extension!.groupMode === 2)).toBe(true);
    expect(members[11].extension).toMatchObject({ loopKind: 3, loopLimit: 0 });
  });

  it("rejects loops the robot cannot honor", () => {
    const repeated = groupedFixture();
    repeated.path.markers[1].schedule = { trigger: "time", repeatEveryS: 0.2 };
    expect(() => build(repeated)).toThrow(/looping command cannot also repeat on a schedule/);
    const far = groupedFixture();
    far.path.markers[1].invocation!.loop = { until: { kind: "distance", meters: 1000 } };
    expect(() => build(far)).toThrow(/loop distance must be greater than zero and at most the .* m left on the path/);
    const condition = groupedFixture();
    condition.path.markers[1].invocation!.loop = { until: { kind: "output", output: "done", operator: "eq", value: true } };
    expect(() => build(condition)).toThrow(/Loop conditions are routine-only|loop conditions are routine-only/);
    // In a sequence, a path end loop before other commands would keep them from ever starting.
    const blocked = groupedFixture(), group = blocked.path.markers[0].commandGroup!;
    group.mode = "sequential";
    group.commands = [command(blocked, { loop: { until: { kind: "pathEnd" } } }), command(blocked)];
    expect(() => build(blocked)).toThrow(/command 1 loops until the path ends, so the commands after it in this sequence would never start/);
    group.mode = "parallel";
    expect(() => build(blocked)).not.toThrow();
  });
});
