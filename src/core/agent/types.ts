import type {
  BordeauxProject,
  PathDoc,
  PlannerOptimizationDiagnostics,
  RobotPlanningProfile,
  TrajectoryPlannerId,
  TrajectorySample,
  ValidationIssue,
} from "../types";
import type * as z from "zod/v4";
import type {
  agentContextSchema,
  fuelCollectionIntentSchema,
  routeLocationSchema,
  routeStepSchema,
} from "./schemas";

export type AllianceColor = "blue" | "red";

export type AgentContext = z.infer<typeof agentContextSchema>;

export interface AgentSessionSnapshot {
  sessionId: string;
  revision: number;
  project: BordeauxProject;
  activePathId: string;
  allianceView: AllianceColor;
  fieldPack: {
    id: "2026-rebuilt";
    revision: string;
  };
}

export interface PathSampleReference {
  index: number;
  timeS: number;
  distanceM: number;
  fraction: number;
  x: number;
  y: number;
  physicalHeadingRad: number;
  segmentIndex: number;
  nearestWaypointIndex: number;
}

export type PathAnalysisMetric =
  | "velocity"
  | "acceleration"
  | "deceleration"
  | "angularVelocity"
  | "angularAcceleration"
  | "angularDeceleration"
  | "jerk"
  | "angularJerk"
  | "curvature";

export interface PathAnalysisExtremum {
  metric: PathAnalysisMetric;
  value: number;
  unit: string;
  sample: PathSampleReference;
}

export interface PathAnalysisFinding {
  id: string;
  severity: ValidationIssue["severity"] | "note";
  kind: "structure" | "planner" | "constraint" | "geometry";
  message: string;
  metric?: PathAnalysisMetric;
  measured?: number;
  limit?: number;
  unit?: string;
  sample?: PathSampleReference;
  sourcePath: string;
}

export interface PathAnalysis {
  pathId: string;
  pathName: string;
  authoredPath: PathDoc;
  planner: TrajectoryPlannerId;
  totalTimeS: number | null;
  totalDistanceM: number | null;
  sampleCount: number;
  samplesTruncated: boolean;
  rawSamples: TrajectorySample[];
  extrema: PathAnalysisExtremum[];
  findings: PathAnalysisFinding[];
  plannerDiagnostics: ValidationIssue[];
  optimization?: PlannerOptimizationDiagnostics;
}

export type FieldPointInput = Extract<z.infer<typeof routeLocationSchema>, { x: number }>;

export type FieldTermInput = Extract<z.infer<typeof routeLocationSchema>, { term: string }>;

export type RouteLocationInput = z.infer<typeof routeLocationSchema>;

export type RouteTraversal = "direct" | "trench-table" | "trench-away" | "bump-table" | "bump-away";

export type FuelCollectionIntent = z.infer<typeof fuelCollectionIntentSchema>;

export type RouteStep = z.infer<typeof routeStepSchema>;

export interface PlanPathRequest {
  context?: AgentContext;
  intent: string;
  name?: string;
  alliance: AllianceColor;
  start?: RouteLocationInput;
  /** Legacy simple route input. Use steps whenever route legs have different crossings or a named maneuver. */
  goals?: RouteLocationInput[];
  /** Ordered route contract. Bordeaux validates these crossings and maneuvers in sequence. */
  steps?: RouteStep[];
  traversal?: "fastest" | "trench" | "bump" | "compare";
  minimumClearanceM?: number;
  maximumCandidates?: number;
  nearTieWindowS?: number;
  basePathId?: string;
  robotHeightM?: number;
  finishFacing?: {
    mechanism: "shooter";
    target: RouteLocationInput;
    maxHeadingErrorDeg?: number;
  };
  collectFuel?: FuelCollectionIntent;
  endAction?: {
    commandId: string;
    semanticTag: string;
    arguments?: Record<string, import("../types").CommandArgumentValue>;
    cancelOnPathEnd?: boolean;
  };
  endActionIntent?: {
    semanticTag: string;
    description: string;
  };
}

export interface RouteCandidateMetrics {
  totalTimeS: number;
  totalDistanceM: number;
  minimumClearanceM: number;
  waypointCount: number;
  peakCurvatureInvM: number;
  peakAngularVelocityRadps: number;
  /** Approximate unique intake swath coverage; retracing the same cells is counted once. */
  estimatedCollectionAreaM2?: number;
  shootingRangeM?: number;
  preferredShootingRangeErrorM?: number;
}

export interface RouteCandidate {
  id: string;
  label: string;
  traversal: RouteTraversal | "ordered";
  requiredPortalIds?: string[];
  path: PathDoc;
  metrics: RouteCandidateMetrics;
  analysis: PathAnalysis;
  diagnostics: ValidationIssue[];
  valid: boolean;
  rejectionReason?: string;
}

export interface RepairCandidate {
  id: string;
  label: string;
  path: PathDoc;
  targetFindingIds: string[];
  before: PathAnalysis;
  after: PathAnalysis;
  changedFields: string[];
  valid: boolean;
  rejectionReason?: string;
}

export interface PathProposal {
  id: string;
  baseSessionId: string;
  baseRevision: number;
  baseActivePathId: string;
  baseRobotCatalogFingerprint?: string;
  intent: string;
  operation: "add" | "replace";
  targetPathId?: string;
  candidates: Array<RouteCandidate | RepairCandidate>;
  recommendedCandidateId: string;
  recommendationReason: string;
  blockingIssues?: string[];
  advisories?: string[];
  status: "ready" | "stale" | "applied" | "rejected" | "expired";
  createdAt: string;
  appliedRevision?: number;
}

export interface CandidateSummary {
  id: string;
  label: string;
  valid: boolean;
  requiredPortalIds?: string[];
  metrics?: RouteCandidateMetrics;
  changedFields?: string[];
  rejectionReason?: string;
  findingCounts: {
    errors: number;
    warnings: number;
    notes: number;
  };
}

export interface ProposalSummary {
  status: "ready" | "stale" | "applied" | "rejected" | "expired";
  proposalId: string;
  proposalUri: string;
  baseContext: AgentContext;
  intent: string;
  operation: PathProposal["operation"] | RobotProfileProposal["operation"];
  targetPathId?: string;
  recommendedCandidate: CandidateSummary | null;
  candidates: CandidateSummary[];
  recommendationReason?: string;
  blockingIssues?: string[];
  advisories?: string[];
  summary?: string[];
  supersededProposalId?: string;
  createdAt: string;
  expiresAt: string;
}

export interface BlockedPlanningOutcome {
  status: "blocked";
  code: "NO_VALID_CANDIDATE";
  proposalId: null;
  baseContext: AgentContext;
  candidates: CandidateSummary[];
  blockingIssues: string[];
}

export interface NeedsInputOutcome {
  status: "needs_input";
  code: "ROBOT_PROFILE_INCOMPLETE" | "TARGET_FACING_REQUIRED";
  baseContext: AgentContext;
  questions: string[];
}

export interface StaleContextOutcome {
  status: "stale_context";
  code: "STALE_CONTEXT";
  message: string;
  currentContext: AgentContext;
}

export interface RobotProfileProposal {
  id: string;
  baseSessionId: string;
  baseRevision: number;
  baseActivePathId: string;
  intent: string;
  operation: "configureRobot";
  planning: RobotPlanningProfile;
  summary: string[];
  status: "ready" | "stale" | "applied" | "rejected" | "expired";
  createdAt: string;
  appliedRevision?: number;
}

export type AgentProposal = PathProposal | RobotProfileProposal;
