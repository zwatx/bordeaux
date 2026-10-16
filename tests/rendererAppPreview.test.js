import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { App, replaceEditedPath, agentProposalPreviewResult, canApplyAgentProposalCandidate, currentPathLength, requestWaypointPreview, selectedAgentProposalPreview, waypointPreviewResult } from "../src/renderer/app/App";
import { PathPreview } from "../src/renderer/assets/path-preview";
import { ContextInspector } from "../src/renderer/components/ContextInspector";
import { PM } from "../src/renderer/lib/pathMath";
import { buildWaypoints, createDemoProject } from "../src/shared/project/defaults";

// The editor renders server-side here only to observe render-time work; desktop APIs stay absent.
function renderEditor(project, proposal = null) {
  vi.stubGlobal("window", globalThis);
  try { return renderToString(React.createElement(App, { initialProject: project, initialAgentProposal: proposal })); }
  finally { vi.unstubAllGlobals(); }
}

describe("renderer app path preview lifecycle", () => {
  it("waits for the worker instead of rendering a profiled fallback for optimized mode", () => {
    const project = createDemoProject();
    project.plannerId = "optimizedTrajectory";
    const derivePath = vi.spyOn(PM, "derivePath");

    try {
      const html = renderEditor(project);

      // Current geometry draws at once (sampled, never timed, on this thread); timing arrives from the worker.
      expect(html).not.toContain('aria-label="Preparing editor"');
      expect(html).toContain('aria-label="Path details"');
      expect(html).not.toContain("Preparing path preview");
      expect(derivePath).not.toHaveBeenCalled();
    } finally {
      derivePath.mockRestore();
    }
  });

  it("does not derive even a small path during initial render", () => {
    const project = createDemoProject();
    const derivePath = vi.spyOn(PM, "derivePath");

    try {
      const html = renderEditor(project);

      // Current geometry draws at once (sampled, never timed, on this thread); timing arrives from the worker.
      expect(html).not.toContain('aria-label="Preparing editor"');
      expect(html).toContain('aria-label="Path details"');
      expect(html).not.toContain("Preparing path preview");
      expect(derivePath).not.toHaveBeenCalled();
    } finally {
      derivePath.mockRestore();
    }
  });

  it("enables path reversal only from the exact current preview", () => {
    const staleValue = { sample: { length: 12.5 } };
    const pathLength = vi.spyOn(PM, "pathLength");

    try {
      expect(currentPathLength({ current: false, pending: true, value: null })).toBeNull();
      expect(currentPathLength({ current: false, pending: true, value: staleValue })).toBeNull();
      expect(currentPathLength({ current: true, pending: false, value: staleValue })).toBe(12.5);
      expect(pathLength).not.toHaveBeenCalled();

      const project = createDemoProject();
      const actions = new Proxy({ canReversePath: false }, {
        get(target, key) { return key in target ? target[key] : vi.fn(); },
      });
      const html = renderToString(React.createElement(ContextInspector, {
        doc: project.paths[0],
        sel: { kind: null, idx: -1 },
        derived: { prof: { totalTime: 1 }, totalDistance: 3, sample: { length: 3 }, checks: [] },
        actions,
        drive: project.robot.drive,
        robot: project.robot,
        onClose: vi.fn(),
      }));
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Swap start\/end"/);
    } finally {
      pathLength.mockRestore();
    }
  });

  it("shows only the selected candidate after its exact worker result arrives", () => {
    const selected = { id: "candidate_a", label: "Candidate A", valid: true, path: { id: "path_a" } };
    const stale = { id: "candidate_b", label: "Candidate B", valid: true, path: { id: "path_b" } };
    const plannerId = "profiledSpline";
    const derived = { planner: plannerId, sample: { pts: [{ x: 1, y: 1 }, { x: 2, y: 2 }] } };
    const request = {};

    expect(selectedAgentProposalPreview({ status: "ready", key: request, path: stale.path, value: derived }, selected, request, plannerId)).toEqual([]);
    expect(selectedAgentProposalPreview({ status: "ready", key: {}, path: selected.path, value: derived }, selected, request, plannerId)).toEqual([]);
    expect(selectedAgentProposalPreview({ status: "ready", key: request, path: selected.path, value: { ...derived, planner: "optimizedTrajectory" } }, selected, request, plannerId)).toEqual([]);
    expect(selectedAgentProposalPreview({ status: "ready", key: request, path: selected.path, value: derived }, selected, request, plannerId)).toEqual([{
      id: selected.id,
      label: selected.label,
      selected: true,
      valid: true,
      derived,
    }]);
  });

  it("gates path proposal apply on the exact current worker result", () => {
    const proposal = { operation: "replace", status: "ready" };
    const previous = { id: "candidate_a", label: "Candidate A", valid: true, path: { id: "path_a" } };
    const selected = { id: "candidate_b", label: "Candidate B", valid: true, path: { id: "path_b" } };
    const previousRequest = {};
    const request = {};
    const plannerId = "profiledSpline";
    const derived = { planner: plannerId, sample: { pts: [] } };

    const switched = agentProposalPreviewResult({ status: "ready", key: previousRequest, path: previous.path, value: derived }, selected, request, plannerId);
    expect(switched).toMatchObject({ ready: false, pending: true, error: null });
    expect(canApplyAgentProposalCandidate(proposal, selected, switched)).toBe(false);

    const pending = agentProposalPreviewResult({ status: "pending", key: request, path: selected.path, value: derived }, selected, request, plannerId);
    expect(pending).toMatchObject({ ready: false, pending: true, error: null });
    expect(canApplyAgentProposalCandidate(proposal, selected, pending)).toBe(false);

    const oldPlanner = agentProposalPreviewResult({ status: "ready", key: request, path: selected.path, value: { ...derived, planner: "optimizedTrajectory" } }, selected, request, plannerId);
    expect(oldPlanner).toMatchObject({ ready: false, pending: true, error: null });
    expect(canApplyAgentProposalCandidate(proposal, selected, oldPlanner)).toBe(false);

    const error = { message: "preview worker failed" };
    const failed = agentProposalPreviewResult({ status: "error", key: request, path: selected.path, value: derived, errorKey: request, errorPath: selected.path, error }, selected, request, plannerId);
    expect(failed).toMatchObject({ ready: false, pending: false, error });
    expect(canApplyAgentProposalCandidate(proposal, selected, failed)).toBe(false);

    const ready = agentProposalPreviewResult({ status: "ready", key: request, path: selected.path, value: derived }, selected, request, plannerId);
    expect(ready).toMatchObject({ ready: true, pending: false, error: null });
    expect(canApplyAgentProposalCandidate(proposal, selected, ready)).toBe(true);
    expect(canApplyAgentProposalCandidate({ operation: "configureRobot", status: "ready" }, null, switched)).toBe(true);
  });

  it("does not derive maximum-size proposal candidates during render", () => {
    const project = createDemoProject();
    const candidatePath = structuredClone(project.paths[0]);
    candidatePath.headingMode = "tangent";
    candidatePath.targets = [];
    candidatePath.ranges = [];
    candidatePath.waypoints = buildWaypoints(Array.from({ length: 4_096 }, (_, index) => ({
      x: 1 + index * 0.003,
      y: 4,
    })));
    const proposal = {
      id: "proposal",
      operation: "replace",
      status: "ready",
      intent: "Repair path",
      recommendationReason: "Candidate A",
      recommendedCandidateId: "candidate_a",
      candidates: Array.from({ length: 4 }, (_, index) => ({
        id: `candidate_${index}`,
        label: `Candidate ${index}`,
        valid: true,
        path: structuredClone(candidatePath),
      })),
    };
    const derivePath = vi.spyOn(PM, "derivePath");

    try {
      renderEditor(project, proposal);
      expect(derivePath).not.toHaveBeenCalled();
    } finally {
      derivePath.mockRestore();
    }
  });

  it("requests a maximum-size insertion preview without deriving synchronously", () => {
    const project = createDemoProject();
    const path = structuredClone(project.paths[0]);
    path.waypoints = buildWaypoints(Array.from({ length: 4_096 }, (_, index) => ({
      x: 1 + index * 0.003,
      y: 4,
    })));
    const request = { doc: path, message: "Review insertion" };
    const previewer = { request: vi.fn(() => 7) };
    const derivePath = vi.spyOn(PM, "derivePath");

    try {
      expect(requestWaypointPreview(previewer, request, project.robot, project.plannerId)).toBe(7);
      expect(previewer.request).toHaveBeenCalledWith({
        key: request,
        path,
        robot: project.robot,
        plannerId: project.plannerId,
        quality: "final",
      });
      expect(derivePath).not.toHaveBeenCalled();
    } finally {
      derivePath.mockRestore();
    }
  });

  it("accepts only the exact insertion preview request", () => {
    const request = { doc: { id: "candidate" }, message: "Review insertion" };
    const stale = { doc: request.doc, message: "Older insertion" };
    const derived = { sample: { pts: [] } };
    const error = { message: "preview failed" };

    expect(waypointPreviewResult({ status: "ready", key: stale, path: request.doc, value: derived }, request)).toMatchObject({ pending: true, derived: null });
    expect(waypointPreviewResult({ status: "pending", key: request, path: request.doc, value: derived }, request)).toMatchObject({ pending: true, derived: null });
    expect(waypointPreviewResult({ status: "ready", key: request, path: request.doc, value: derived }, request)).toMatchObject({ pending: false, derived });
    expect(waypointPreviewResult({ status: "error", errorKey: request, errorPath: request.doc, error }, request)).toMatchObject({ pending: false, derived: null, error });
  });

  it("renders a pending state for an 890-waypoint path without deriving during render", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.headingMode = "tangent";
    path.targets = [];
    path.ranges = [];
    path.waypoints = buildWaypoints(Array.from({ length: 890 }, (_, index) => ({
      x: 1 + index * 0.01,
      y: 4,
    })));
    expect(PathPreview.directPreviewIsSafe(path, 14)).toBe(false);
    const derivePath = vi.spyOn(PM, "derivePath");

    try {
      const html = renderEditor(project);

      // Current geometry draws at once (sampled, never timed, on this thread); timing arrives from the worker.
      expect(html).not.toContain('aria-label="Preparing editor"');
      expect(html).toContain('aria-label="Path details"');
      expect(html).not.toContain("Preparing path preview");
      expect(derivePath).not.toHaveBeenCalled();
    } finally {
      derivePath.mockRestore();
    }
  });
});


describe("late path edits", () => {
  it("preserves path identities when an edit finishes after selecting another path", () => {
    const source = { ...createDemoProject().paths[0], id: "source", name: "Opening move" };
    const destination = { ...structuredClone(source), id: "destination", name: "Collect second" };
    const project = { ...createDemoProject(), paths: [source, destination], pathLinks: [], editor: { activePathId: destination.id } };
    const edited = structuredClone(source);
    edited.waypoints[1].x += 0.25;
    const next = replaceEditedPath(project, edited);
    expect(next.paths.map((item) => item.id)).toEqual(["source", "destination"]);
    expect(next.paths[0]).toEqual(edited);
    expect(next.paths[1]).toBe(destination);
    expect(next.editor.activePathId).toBe(destination.id);
    const reordered = replaceEditedPath({ ...project, paths: [destination, source] }, edited);
    expect(reordered.paths[0]).toBe(destination);
    expect(reordered.paths[1]).toEqual(edited);
    expect(replaceEditedPath(project, { ...edited, id: "removed" })).toBe(project);
  });
});
