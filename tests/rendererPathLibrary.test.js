import { describe, expect, it } from "vitest";
import { duplicatePathForLibrary } from "../src/renderer/app/App";
import { createDemoProject } from "../src/core/project/defaults";
import { validateProject } from "../src/core/validation";

describe("renderer path library", () => {
  it("regenerates marker IDs when duplicating a path", () => {
    const project = createDemoProject();
    const source = project.paths[0];
    source.markers = [
      {
        id: "event_first",
        f: 0.25,
        name: "intake",
        cmd: "Intake",
        group: "parallel",
        schedule: { trigger: "position", repeatEveryS: 0.4, endTimeS: 2.5 },
      },
      {
        id: "event_second",
        f: 0.75,
        name: "score",
        invocation: { commandId: "frc.robot.Score#run", arguments: { level: 4 } },
      },
    ];
    const before = structuredClone(source);

    const duplicate = duplicatePathForLibrary(source, "NewPath copy");
    const allMarkerIds = [...source.markers, ...duplicate.markers].map((marker) => marker.id);
    const markerBehavior = (marker) => { const { id: _id, ...behavior } = marker; return behavior; };

    expect(source).toEqual(before);
    expect(duplicate.id).not.toBe(source.id);
    expect(duplicate.name).toBe("NewPath copy");
    expect(duplicate.markers.map(markerBehavior)).toEqual(source.markers.map(markerBehavior));
    expect(new Set(allMarkerIds).size).toBe(allMarkerIds.length);
    expect(validateProject({ ...project, paths: [source, duplicate] })).toEqual({ ok: true, issues: [] });
  });
});
