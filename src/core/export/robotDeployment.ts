export type RobotPushScope = { kind: "paths"; pathIds: string[] } | { kind: "routine"; routineId: string } | { kind: "project" };
export interface RobotDeploymentSummary {
  kind: RobotPushScope["kind"];
  selectedNames: string[];
  pathIds: string[];
  addedNames: string[];
  updatedNames: string[];
  preservedPathCount: number;
  previousRoutine: string | null;
  routine: string | null;
  dependencyNames: string[];
}
export interface RobotDeploymentItemStatus {
  state: "matches" | "changed" | "missing" | "invalid" | "unknown";
  message?: string;
}
export interface RobotDeploymentComparison {
  paths: Record<string, RobotDeploymentItemStatus>;
  routines: Record<string, RobotDeploymentItemStatus>;
}
