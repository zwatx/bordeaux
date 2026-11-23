import { FIELD_H, clampWorldPoint } from "../math/fieldBounds";
import { clone } from "../project/defaults";
import type { BordeauxProject, PathDoc } from "../types";
import { analyzePath } from "./pathAnalysis";
import type { PathAnalysis, PathAnalysisFinding, RepairCandidate } from "./types";

function findingRatio(finding: PathAnalysisFinding | undefined): number {
  if (finding?.measured === undefined) return finding ? 1 : 0;
  if (finding.id === "geometry:field-obstacle-clearance" && finding.limit !== undefined) return Math.max(0, finding.limit - finding.measured);
  if (!finding.limit) return finding ? 1 : 0;
  return Math.max(0, finding.measured / finding.limit - 1);
}

function severityRank(finding: PathAnalysisFinding | undefined): number {
  if (!finding) return 0;
  return finding.severity === "error" ? 3 : finding.severity === "warning" ? 2 : 1;
}

function targetImproved(before: PathAnalysis, after: PathAnalysis, ids: readonly string[]): boolean {
  return ids.every((id) => {
    const beforeFinding = before.findings.find((item) => item.id === id);
    const afterFinding = after.findings.find((item) => item.id === id);
    return !afterFinding
      || severityRank(afterFinding) < severityRank(beforeFinding)
      || findingRatio(afterFinding) <= findingRatio(beforeFinding) * 0.75;
  });
}

function hasNewOrWorseError(before: PathAnalysis, after: PathAnalysis, targetIds: ReadonlySet<string>): boolean {
  return after.findings.some((finding) => {
    if (finding.severity === "note" || targetIds.has(finding.id)) return false;
    const prior = before.findings.find((item) => item.id === finding.id);
    return !prior || severityRank(finding) > severityRank(prior) || findingRatio(finding) > findingRatio(prior) + 0.01;
  });
}

function localSpeedRepair(path: PathDoc, finding: PathAnalysisFinding, scale: number): { path: PathDoc; fields: string[] } | null {
  if (!finding.sample || !finding.metric || !["acceleration", "deceleration", "angularVelocity", "angularAcceleration", "angularDeceleration", "jerk", "angularJerk"].includes(finding.metric)) return null;
  const repaired = clone(path);
  const fraction = finding.sample.fraction;
  repaired.ranges.push({
    anchor: "param",
    f0: Math.max(0, fraction - 0.1),
    f1: Math.min(1, fraction + 0.1),
    maxVel: repaired.constraints.maxVel * scale,
    maxAccel: repaired.constraints.maxAccel,
    maxDecel: repaired.constraints.maxDecel,
    maxAngVel: repaired.constraints.maxAngVel,
    maxAngAccel: repaired.constraints.maxAngAccel,
    name: "Agent repair preview",
  });
  return { path: repaired, fields: ["ranges"] };
}

function geometryRepair(path: PathDoc, finding: PathAnalysisFinding, direction: -1 | 1): { path: PathDoc; fields: string[] } | null {
  if (!finding.sample || finding.kind !== "geometry") return null;
  const repaired = clone(path);
  const index = finding.sample.nearestWaypointIndex;
  if (index <= 0 || index >= repaired.waypoints.length - 1) return null;
  const waypoint = repaired.waypoints[index];
  const moved = clampWorldPoint({ x: waypoint.x, y: waypoint.y + direction * Math.min(1.6, FIELD_H * 0.2) });
  const dx = moved.x - waypoint.x;
  const dy = moved.y - waypoint.y;
  repaired.waypoints[index] = {
    ...waypoint,
    ...moved,
    prevC: { x: waypoint.prevC.x + dx, y: waypoint.prevC.y + dy },
    nextC: { x: waypoint.nextC.x + dx, y: waypoint.nextC.y + dy },
  };
  return { path: repaired, fields: [`waypoints[${index}].y`, `waypoints[${index}].prevC`, `waypoints[${index}].nextC`] };
}

export function generateRepairCandidates(
  project: BordeauxProject,
  pathId: string,
  findingIds: readonly string[],
  minimumClearanceM = 0,
): RepairCandidate[] {
  if (findingIds.length === 0 || findingIds.length > 8) throw new Error("Choose between 1 and 8 analysis findings to repair.");
  const path = project.paths.find((item) => item.id === pathId);
  if (!path) throw new Error(`Path ${pathId} does not exist in the current project.`);
  const before = analyzePath(project, pathId, { minimumClearanceM });
  const findings = findingIds.map((id) => before.findings.find((item) => item.id === id));
  if (findings.some((finding) => !finding)) throw new Error("A requested finding is stale or does not belong to this path analysis.");
  const primary = findings[0]!;
  const mutations = [
    localSpeedRepair(path, primary, 0.75),
    localSpeedRepair(path, primary, 0.6),
    geometryRepair(path, primary, -1),
    geometryRepair(path, primary, 1),
  ].filter((item): item is { path: PathDoc; fields: string[] } => item !== null);
  const targets = new Set(findingIds);
  return mutations.map((mutation, index) => {
    const candidateProject = { ...project, paths: project.paths.map((item) => item.id === pathId ? mutation.path : item) };
    const after = analyzePath(candidateProject, pathId, { minimumClearanceM });
    const improved = targetImproved(before, after, findingIds);
    const noWorse = !hasNewOrWorseError(before, after, targets);
    const valid = improved && noWorse;
    return {
      id: `repair_${index + 1}_${pathId}`,
      label: mutation.fields[0] === "ranges" ? `Localized speed repair ${index + 1}` : `Geometry repair ${index + 1}`,
      path: mutation.path,
      targetFindingIds: [...findingIds],
      before,
      after,
      changedFields: mutation.fields,
      valid,
      ...(valid ? {} : { rejectionReason: improved ? "The candidate introduced a new or worse error." : "The target finding did not improve by at least 25%." }),
    };
  });
}
