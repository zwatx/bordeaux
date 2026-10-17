import { createHash, randomUUID } from "node:crypto";
import { analyzePath } from "../shared/agent/pathAnalysis";
import { robotFootprintVertices } from "../shared/agent/robotFootprint";
import { generateRepairCandidates } from "../shared/agent/pathRepair";
import { generateRouteCandidates } from "../shared/agent/routeCandidates";
import type {
  AgentContext,
  AgentProposal,
  AgentSessionSnapshot,
  BlockedPlanningOutcome,
  CandidateSummary,
  NeedsInputOutcome,
  PathAnalysis,
  PathProposal,
  PlanPathRequest,
  ProposalSummary,
  RobotProfileProposal,
  StaleContextOutcome,
} from "../shared/agent/types";
import { REBUILT_2026_FIELD } from "../shared/field/rebuilt2026";
import { resolveProjectFieldTerm, withAllianceView } from "../shared/field/vocabulary";
import type { RobotRelativePose } from "../shared/field/types";
import { clone } from "../shared/project/defaults";
import type { RobotCommandCatalog, RobotPlanningProfile } from "../shared/types";
import { defaultRobotCommandArguments, robotInvocationErrors } from "../shared/robotCommands";
import { validateProject, validateProjectSource } from "../shared/validation";
import { robotCatalogSemanticSignature } from "../shared/agent/catalogSignature";

const MAX_PROPOSALS = 24;
const MAX_CONCURRENT_ANALYSES = 2;
const PROPOSAL_TTL_MS = 30 * 60 * 1_000;

function canceledRequestError(): Error {
  return new Error("Agent request was canceled.");
}

function waitForAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(canceledRequestError());
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(canceledRequestError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

export type AgentRequest =
  | { method: "inspect_session" }
  | { method: "field_pack" }
  | { method: "commands" }
  | { method: "inspect_robot_profile" }
  | { method: "propose_robot_profile"; params: { context?: AgentContext; intent: string; planning: RobotPlanningProfile } }
  | { method: "resolve_field_terms"; params: { phrases: string[]; alliance?: "blue" | "red"; pose?: RobotRelativePose; relativeDistanceM?: number; robotHeightM?: number } }
  | { method: "analyze_path"; params: { context?: AgentContext; pathId?: string; detail?: "summary" | "samples"; sampleLimit?: number; minimumClearanceM?: number } }
  | { method: "repair_path"; params: { context?: AgentContext; pathId?: string; findingIds: string[]; minimumClearanceM?: number } }
  | { method: "plan_path"; params: PlanPathRequest }
  | { method: "get_proposal"; params: { proposalId: string; detail?: "summary" | "full" } }
  | { method: "get_current_proposal" }
  | { method: "get_proposal_candidate"; params: { proposalId: string; candidateId: string } };

export type AgentPlanningJob =
  | { kind: "analyze"; snapshot: AgentSessionSnapshot; pathId: string; sampleLimit?: number; minimumClearanceM?: number }
  | { kind: "repair"; snapshot: AgentSessionSnapshot; pathId: string; findingIds: string[]; minimumClearanceM?: number }
  | { kind: "route"; snapshot: AgentSessionSnapshot; request: PlanPathRequest };

export type AgentPlanningRunner = (job: AgentPlanningJob, signal?: AbortSignal) => Promise<unknown>;

export async function runAgentPlanningJobDirect(job: AgentPlanningJob): Promise<unknown> {
  if (job.kind === "analyze") {
    return analyzePath(job.snapshot.project, job.pathId, {
      sampleLimit: job.sampleLimit,
      minimumClearanceM: job.minimumClearanceM,
    });
  }
  if (job.kind === "repair") {
    return generateRepairCandidates(job.snapshot.project, job.pathId, job.findingIds, job.minimumClearanceM);
  }
  return generateRouteCandidates(job.snapshot.project, job.request);
}

function requireSnapshot(snapshot: AgentSessionSnapshot | null): AgentSessionSnapshot {
  if (!snapshot) throw new Error("Open a Bordeaux project and wait for the editor to finish loading, then retry.");
  return snapshot;
}

function publicSession(snapshot: AgentSessionSnapshot, catalog: RobotCommandCatalog | null) {
  return {
    context: snapshotContext(snapshot),
    sessionId: snapshot.sessionId,
    revision: snapshot.revision,
    projectName: snapshot.project.name,
    activePathId: snapshot.activePathId,
    paths: snapshot.project.paths.map((path) => ({ id: path.id, name: path.name, waypointCount: path.waypoints.length })),
    robot: snapshot.project.robot,
    robotCollisionModel: {
      localFrame: "+X forward, +Y left, meters from the robot reference point",
      shape: snapshot.project.robot.footprint?.kind ?? "rectangle",
      verticesM: robotFootprintVertices(snapshot.project.robot),
      heightM: snapshot.project.robot.heightM ?? null,
      heightKnown: snapshot.project.robot.heightM !== undefined,
    },
    plannerId: snapshot.project.plannerId,
    allianceView: snapshot.allianceView,
    coordinateContext: {
      authoredFrame: "Bordeaux overhead-image coordinates: red is low-X/left, blue is high-X/right, +Y is screen-up.",
      displayFrame: snapshot.allianceView === "red" ? "Red view rotates authored points 180 degrees for display only." : "Blue view displays authored points without rotation.",
      ownershipRule: "An explicit red/blue term selects that physical field structure; allianceView never changes ownership.",
    },
    fieldPack: snapshot.fieldPack,
    robotCatalog: catalog ? { catalogId: catalog.catalogId, catalogHash: catalog.catalogHash, commandCount: catalog.commands.length, authoritative: catalog.authoritative === true } : null,
    strategy: snapshot.project.strategy ?? null,
  };
}

function snapshotContext(snapshot: AgentSessionSnapshot): AgentContext {
  return { sessionId: snapshot.sessionId, revision: snapshot.revision, activePathId: snapshot.activePathId };
}

function proposalMatchesSnapshot(proposal: AgentProposal, snapshot: AgentSessionSnapshot | null): boolean {
  return Boolean(snapshot
    && proposal.baseSessionId === snapshot.sessionId
    && proposal.baseRevision === snapshot.revision
    && proposal.baseActivePathId === snapshot.activePathId);
}

function robotCatalogFingerprint(catalog: RobotCommandCatalog | null): string | null {
  if (!catalog) return null;
  return `sha256:${createHash("sha256").update(robotCatalogSemanticSignature(catalog), "utf8").digest("hex")}`;
}

function proposalMatchesCatalogFingerprint(proposal: AgentProposal, fingerprint: string | null): boolean {
  if (!("baseRobotCatalogFingerprint" in proposal) || !proposal.baseRobotCatalogFingerprint) return true;
  return proposal.baseRobotCatalogFingerprint === fingerprint;
}

function proposalMatchesCatalog(proposal: AgentProposal, catalog: RobotCommandCatalog | null): boolean {
  return proposalMatchesCatalogFingerprint(proposal, robotCatalogFingerprint(catalog));
}

function findingCounts(analysis: PathAnalysis): CandidateSummary["findingCounts"] {
  return analysis.findings.reduce((counts, finding) => {
    if (finding.severity === "error") counts.errors += 1;
    else if (finding.severity === "warning") counts.warnings += 1;
    else counts.notes += 1;
    return counts;
  }, { errors: 0, warnings: 0, notes: 0 });
}

function candidateSummary(candidate: PathProposal["candidates"][number]): CandidateSummary {
  if ("analysis" in candidate) {
    return {
      id: candidate.id,
      label: candidate.label,
      valid: candidate.valid,
      ...(candidate.requiredPortalIds ? { requiredPortalIds: [...candidate.requiredPortalIds] } : {}),
      metrics: { ...candidate.metrics },
      findingCounts: findingCounts(candidate.analysis),
      ...(candidate.rejectionReason ? { rejectionReason: candidate.rejectionReason } : {}),
    };
  }
  return {
    id: candidate.id,
    label: candidate.label,
    valid: candidate.valid,
    changedFields: [...candidate.changedFields],
    findingCounts: findingCounts(candidate.after),
    ...(candidate.rejectionReason ? { rejectionReason: candidate.rejectionReason } : {}),
  };
}

function proposalSummary(proposal: AgentProposal, supersededProposalId?: string): ProposalSummary {
  const expiresAt = new Date(Date.parse(proposal.createdAt) + PROPOSAL_TTL_MS).toISOString();
  if (proposal.operation === "configureRobot") {
    return {
      status: proposal.status,
      proposalId: proposal.id,
      proposalUri: `bordeaux://proposals/${proposal.id}`,
      baseContext: { sessionId: proposal.baseSessionId, revision: proposal.baseRevision, activePathId: proposal.baseActivePathId },
      intent: proposal.intent,
      operation: proposal.operation,
      recommendedCandidate: null,
      candidates: [],
      summary: [...proposal.summary],
      ...(supersededProposalId ? { supersededProposalId } : {}),
      createdAt: proposal.createdAt,
      expiresAt,
    };
  }
  const candidates = proposal.candidates.map(candidateSummary);
  return {
    status: proposal.status,
    proposalId: proposal.id,
    proposalUri: `bordeaux://proposals/${proposal.id}`,
    baseContext: {
      sessionId: proposal.baseSessionId,
      revision: proposal.baseRevision,
      activePathId: proposal.baseActivePathId,
    },
    intent: proposal.intent,
    operation: proposal.operation,
    ...(proposal.targetPathId ? { targetPathId: proposal.targetPathId } : {}),
    recommendedCandidate: candidates.find((candidate) => candidate.id === proposal.recommendedCandidateId) ?? null,
    candidates,
    recommendationReason: proposal.recommendationReason,
    ...(proposal.blockingIssues ? { blockingIssues: [...proposal.blockingIssues] } : {}),
    ...(proposal.advisories ? { advisories: [...proposal.advisories] } : {}),
    ...(supersededProposalId ? { supersededProposalId } : {}),
    createdAt: proposal.createdAt,
    expiresAt,
  };
}

function analysisSummary(analysis: PathAnalysis) {
  return {
    status: "complete" as const,
    pathId: analysis.pathId,
    pathName: analysis.pathName,
    analysisUri: `bordeaux://paths/${analysis.pathId}/analysis`,
    planner: analysis.planner,
    totalTimeS: analysis.totalTimeS,
    totalDistanceM: analysis.totalDistanceM,
    sampleCount: analysis.sampleCount,
    samplesAvailable: analysis.rawSamples.length,
    samplesTruncated: analysis.samplesTruncated,
    extrema: analysis.extrema,
    findings: analysis.findings,
    plannerDiagnostics: analysis.plannerDiagnostics,
    ...(analysis.optimization ? { optimization: analysis.optimization } : {}),
  };
}

function staleContext(snapshot: AgentSessionSnapshot, context: AgentContext | undefined): StaleContextOutcome | null {
  if (!context) return null;
  if (context.sessionId === snapshot.sessionId && context.revision === snapshot.revision && context.activePathId === snapshot.activePathId) return null;
  return {
    status: "stale_context",
    code: "STALE_CONTEXT",
    message: "The Bordeaux editor context changed. Inspect the session and retry with the current context handle.",
    currentContext: snapshotContext(snapshot),
  };
}

function planPreflight(snapshot: AgentSessionSnapshot, request: PlanPathRequest): NeedsInputOutcome | null {
  const collecting = Boolean(request.collectFuel) || request.steps?.some((step) => Boolean(step.collectFuel)) === true;
  const questions: string[] = [];
  if (collecting && !snapshot.project.robot.planning?.intake) {
    questions.push("Where is the primary intake in the robot-local frame (+X forward, +Y left), which direction does it collect, how wide is its effective opening, and what is the maximum safe collection speed?");
  }
  if (request.finishFacing && !snapshot.project.robot.planning?.shooter) {
    questions.push("Which robot-relative direction does the shooter fire, must that direction face the target, and is there a preferred shooting range?");
  }
  if (questions.length) {
    return { status: "needs_input", code: "ROBOT_PROFILE_INCOMPLETE", baseContext: snapshotContext(snapshot), questions };
  }
  const semanticTag = request.endAction?.semanticTag ?? request.endActionIntent?.semanticTag;
  if (semanticTag === "shoot-fuel" && snapshot.project.robot.planning?.shooter?.requiresTargetFacing && !request.finishFacing) {
    return {
      status: "needs_input",
      code: "TARGET_FACING_REQUIRED",
      baseContext: snapshotContext(snapshot),
      questions: ["Which official HUB reference should the configured shooter face at the final pose?"],
    };
  }
  return null;
}

function routeRecommendationReason(candidates: ReturnType<typeof generateRouteCandidates>, recommendedCandidateId: string): string {
  const winner = candidates.find((candidate) => candidate.id === recommendedCandidateId)!;
  const valid = candidates.filter((candidate) => candidate.valid);
  if (!winner.valid) return `No generated candidate passed validation; ${winner.label} is shown only for diagnosis.`;
  const fastest = valid.reduce((best, candidate) => candidate.metrics.totalTimeS < best.metrics.totalTimeS ? candidate : best, valid[0]);
  if (fastest.id === winner.id) return `${winner.label} is the fastest of ${valid.length} valid generated candidates at ${winner.metrics.totalTimeS.toFixed(2)} s.`;
  const margin = (winner.metrics.totalTimeS - fastest.metrics.totalTimeS).toFixed(2);
  if (winner.metrics.minimumClearanceM > fastest.metrics.minimumClearanceM + 1e-6) return `${winner.label} is within ${margin} s of the fastest generated candidate and has greater modeled clearance (${winner.metrics.minimumClearanceM.toFixed(2)} m).`;
  if (winner.metrics.peakCurvatureInvM < fastest.metrics.peakCurvatureInvM - 1e-6) return `${winner.label} is within ${margin} s of the fastest generated candidate and has lower peak curvature (${winner.metrics.peakCurvatureInvM.toFixed(3)} 1/m).`;
  if (winner.metrics.peakAngularVelocityRadps < fastest.metrics.peakAngularVelocityRadps - 1e-6) return `${winner.label} is within ${margin} s of the fastest generated candidate and has lower peak angular velocity (${winner.metrics.peakAngularVelocityRadps.toFixed(3)} rad/s).`;
  if (winner.metrics.waypointCount < fastest.metrics.waypointCount) return `${winner.label} is within ${margin} s of the fastest generated candidate and uses fewer waypoints (${winner.metrics.waypointCount}).`;
  return `${winner.label} is within ${margin} s of the fastest generated candidate and won the deterministic candidate-ID tie-break after all safety metrics tied.`;
}

export class AgentSessionService {
  private snapshot: AgentSessionSnapshot | null = null;
  private readonly proposals = new Map<string, AgentProposal>();
  private readonly planningAborts = new Set<AbortController>();
  private previewPlanningAbort: AbortController | null = null;
  private activeAnalyses = 0;
  private previewGeneration = 0;
  private committedPreviewId: string | null = null;
  private access = { enabled: false, generation: 0 };

  constructor(
    private readonly sendProposal: (proposal: AgentProposal, requireReceipt: boolean) => void | Promise<void>,
    private readonly getRobotCatalog: () => RobotCommandCatalog | null,
    private readonly runPlanning: AgentPlanningRunner = runAgentPlanningJobDirect,
  ) {}

  clearSnapshot(): void {
    this.abortPlanning();
    this.previewGeneration += 1;
    this.committedPreviewId = null;
    this.snapshot = null;
    for (const proposal of this.proposals.values()) {
      if (proposal.status === "ready") proposal.status = "stale";
    }
  }

  publishSnapshot(value: AgentSessionSnapshot): void {
    try {
      if (!value || typeof value.sessionId !== "string" || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error("Agent session snapshot is invalid");
      // Inspection follows editable source; selected-path planning/export enforce execution readiness.
      const validation = validateProjectSource(value.project);
      if (!validation.ok) throw new Error("Agent session project snapshot is invalid");
      if (!value.project.paths.some((path) => path.id === value.activePathId)) throw new Error("Agent session active path does not exist");
    } catch (error) {
      // The previous document is no longer evidence of what the editor currently contains.
      this.clearSnapshot();
      throw error;
    }
    const previous = this.snapshot;
    this.snapshot = value;
    if (!previous || previous.sessionId !== value.sessionId || previous.revision !== value.revision || previous.activePathId !== value.activePathId) {
      this.abortPlanning();
      this.previewGeneration += 1;
      const committed = this.committedPreviewId ? this.proposals.get(this.committedPreviewId) : undefined;
      if (!committed || !proposalMatchesSnapshot(committed, value)) this.committedPreviewId = null;
      for (const proposal of this.proposals.values()) {
        if (proposal.status === "ready" && !proposalMatchesSnapshot(proposal, value)) {
          proposal.status = "stale";
          void Promise.resolve(this.sendProposal(proposal, false)).catch(() => undefined);
        }
      }
    }
    this.expireProposals();
  }

  refreshRobotCatalog(): void {
    let displacedPendingPreview = false;
    const fingerprint = robotCatalogFingerprint(this.getRobotCatalog());
    for (const proposal of this.proposals.values()) {
      if (proposal.status !== "ready" || proposalMatchesCatalogFingerprint(proposal, fingerprint)) continue;
      proposal.status = "stale";
      if (proposal.id === this.committedPreviewId) this.committedPreviewId = null;
      else displacedPendingPreview = true;
      void Promise.resolve().then(() => this.sendProposal(proposal, false)).catch(() => undefined);
    }
    if (displacedPendingPreview) this.restoreCommittedPreview();
  }

  tryPublishSnapshot(value: AgentSessionSnapshot): boolean {
    try {
      this.publishSnapshot(value);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Starts a new MCP access period. Earlier snapshots, planning and previews
   * are discarded, so requests report the editor as unavailable until it
   * publishes for this period.
   */
  resetAccess(enabled: boolean): { enabled: boolean; generation: number } {
    this.clearSnapshot();
    this.access = { enabled, generation: this.access.generation + 1 };
    return this.accessStatus();
  }

  accessStatus(): { enabled: boolean; generation: number } {
    return { ...this.access };
  }

  /** Editor snapshots count only while access is on and only for the current period. */
  publishEditorSnapshot(value: unknown): "published" | "ignored" | "invalid" {
    if (!value || typeof value !== "object") return "invalid";
    const { accessGeneration, ...snapshot } = value as AgentSessionSnapshot & { accessGeneration?: unknown };
    if (!this.access.enabled || accessGeneration !== this.access.generation) return "ignored";
    return this.tryPublishSnapshot(snapshot) ? "published" : "invalid";
  }

  updateProposalStatus(proposalId: string, status: "applied" | "rejected" | "stale", appliedRevision?: number): void {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) return;
    proposal.status = status;
    if (proposalId === this.committedPreviewId) this.committedPreviewId = null;
    if (status === "applied" && Number.isSafeInteger(appliedRevision)) proposal.appliedRevision = appliedRevision;
  }

  acknowledgeProposal(proposalId: string, sessionId: string, revision: number, activePathId: string, accepted = true): void {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== "ready") return;
    if (!accepted || proposal.baseSessionId !== sessionId || proposal.baseRevision !== revision || proposal.baseActivePathId !== activePathId) {
      proposal.status = "stale";
    }
  }

  getActiveProposal(): AgentProposal | null {
    this.refreshRobotCatalog();
    this.expireProposals();
    const proposals = [...this.proposals.values()];
    for (let index = proposals.length - 1; index >= 0; index -= 1) {
      const proposal = proposals[index];
      if (proposal.status === "ready" && proposalMatchesSnapshot(proposal, this.snapshot) && proposalMatchesCatalog(proposal, this.getRobotCatalog())) return proposal;
    }
    return null;
  }

  private expireProposals(): void {
    const cutoff = Date.now() - PROPOSAL_TTL_MS;
    for (const proposal of this.proposals.values()) {
      if (Date.parse(proposal.createdAt) >= cutoff) continue;
      if (proposal.status === "ready") proposal.status = "expired";
      if (proposal.id === this.committedPreviewId) this.committedPreviewId = null;
    }
    while (this.proposals.size > MAX_PROPOSALS) {
      let proposalId: string | undefined;
      for (const id of this.proposals.keys()) {
        if (id !== this.committedPreviewId) {
          proposalId = id;
          break;
        }
      }
      if (!proposalId) break;
      this.proposals.delete(proposalId);
    }
  }

  private claimPreviewOwnership(signal?: AbortSignal): number {
    if (signal?.aborted) throw canceledRequestError();
    this.previewPlanningAbort?.abort();
    this.previewGeneration += 1;
    let displacedPendingPreview = false;
    for (const proposal of this.proposals.values()) {
      if (proposal.status !== "ready" || proposal.id === this.committedPreviewId) continue;
      proposal.status = "stale";
      displacedPendingPreview = true;
      void Promise.resolve(this.sendProposal(proposal, false)).catch(() => undefined);
    }
    if (displacedPendingPreview) this.restoreCommittedPreview();
    return this.previewGeneration;
  }

  private restoreCommittedPreview(): void {
    if (!this.committedPreviewId || !this.snapshot) return;
    const committed = this.proposals.get(this.committedPreviewId);
    if (!committed || !proposalMatchesSnapshot(committed, this.snapshot) || !proposalMatchesCatalog(committed, this.getRobotCatalog())) {
      this.committedPreviewId = null;
      return;
    }
    committed.status = "ready";
    void Promise.resolve(this.sendProposal(committed, false)).catch(() => undefined);
  }

  private async stage<T extends AgentProposal>(proposal: T, previewGeneration: number, signal?: AbortSignal): Promise<{ proposal: T; supersededProposalId?: string }> {
    if (signal?.aborted) throw canceledRequestError();
    if (previewGeneration !== this.previewGeneration) {
      throw new Error("Agent preview request was superseded by a newer request.");
    }
    if (!proposalMatchesSnapshot(proposal, this.snapshot) || !proposalMatchesCatalog(proposal, this.getRobotCatalog())) {
      throw new Error("The Bordeaux editor session changed while the proposal was being generated. Retry against the current session.");
    }
    let supersededProposalId: string | undefined;
    for (const existing of this.proposals.values()) {
      if (existing.status !== "ready") continue;
      supersededProposalId = existing.id;
      existing.status = "stale";
      void Promise.resolve(this.sendProposal(existing, false)).catch(() => undefined);
    }
    this.proposals.set(proposal.id, proposal);
    this.expireProposals();
    try {
      await waitForAbort(Promise.resolve(this.sendProposal(proposal, true)), signal);
      if (signal?.aborted) throw canceledRequestError();
      if (previewGeneration !== this.previewGeneration) {
        throw new Error("Agent preview request was superseded by a newer request.");
      }
      if (!proposalMatchesSnapshot(proposal, this.snapshot) || !proposalMatchesCatalog(proposal, this.getRobotCatalog()) || proposal.status !== "ready") {
        throw new Error("The Bordeaux editor session changed before it acknowledged the proposal. Retry against the current session.");
      }
    } catch (error) {
      const contextStillCurrent = proposalMatchesSnapshot(proposal, this.snapshot);
      const stillOwnsPreview = previewGeneration === this.previewGeneration;
      if (contextStillCurrent && stillOwnsPreview) {
        proposal.status = "stale";
        void Promise.resolve(this.sendProposal(proposal, false)).catch(() => undefined);
        this.restoreCommittedPreview();
      }
      throw error;
    }
    this.committedPreviewId = proposal.id;
    return { proposal, ...(supersededProposalId ? { supersededProposalId } : {}) };
  }

  private abortPlanning(): void {
    for (const controller of this.planningAborts) controller.abort();
    this.planningAborts.clear();
    this.previewPlanningAbort = null;
  }

  private async executePlanning<T>(job: AgentPlanningJob, snapshot: AgentSessionSnapshot, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new Error("Agent planning was canceled.");
    const producesPreview = job.kind !== "analyze";
    if (!producesPreview && this.activeAnalyses >= MAX_CONCURRENT_ANALYSES) {
      throw new Error(`Bordeaux is already running ${MAX_CONCURRENT_ANALYSES} path analyses. Wait for one to finish and retry.`);
    }
    if (!producesPreview) this.activeAnalyses += 1;
    if (producesPreview) this.previewPlanningAbort?.abort();
    const controller = new AbortController();
    this.planningAborts.add(controller);
    if (producesPreview) this.previewPlanningAbort = controller;
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await this.runPlanning(job, controller.signal) as T;
      if (controller.signal.aborted) throw new Error("Agent planning was canceled.");
      if (!this.snapshot || this.snapshot.sessionId !== snapshot.sessionId || this.snapshot.revision !== snapshot.revision || this.snapshot.activePathId !== snapshot.activePathId) {
        throw new Error("The Bordeaux editor session changed while planning. Retry against the current session.");
      }
      return result;
    } finally {
      if (!producesPreview) this.activeAnalyses -= 1;
      signal?.removeEventListener("abort", onAbort);
      this.planningAborts.delete(controller);
      if (this.previewPlanningAbort === controller) this.previewPlanningAbort = null;
    }
  }

  async request(request: AgentRequest, signal?: AbortSignal): Promise<unknown> {
    this.refreshRobotCatalog();
    this.expireProposals();
    if (request.method === "field_pack") return REBUILT_2026_FIELD;
    if (request.method === "get_current_proposal") {
      const proposal = this.getActiveProposal();
      return proposal ? proposalSummary(proposal) : null;
    }
    if (request.method === "get_proposal") {
      const proposal = this.proposals.get(request.params.proposalId);
      if (!proposal) throw new Error("That proposal does not exist or has expired.");
      return request.params.detail === "full" ? proposal : proposalSummary(proposal);
    }
    if (request.method === "get_proposal_candidate") {
      const proposal = this.proposals.get(request.params.proposalId);
      if (!proposal || proposal.operation === "configureRobot") throw new Error("That path proposal does not exist or has expired.");
      const candidate = proposal.candidates.find((item) => item.id === request.params.candidateId);
      if (!candidate) throw new Error("That proposal candidate does not exist.");
      return candidate;
    }
    const snapshot = requireSnapshot(this.snapshot);
    if (request.method === "inspect_session") return publicSession(snapshot, this.getRobotCatalog());
    if (request.method === "commands") return this.getRobotCatalog() ?? { authoritative: false, commands: [], warnings: ["Link and build a generated Robot command catalog to expose team actions."] };
    if (request.method === "inspect_robot_profile") {
      const planning = snapshot.project.robot.planning;
      const missing = [
        ...(!planning?.intake ? ["intake"] : []),
        ...(!planning?.shooter ? ["shooter"] : []),
      ];
      const requiredQuestions = [
        ...(!planning?.intake ? [
          "Where is the primary intake in the robot-local frame (+X forward, +Y left), which direction does it collect, how wide is its effective opening, and what is the maximum safe collection speed?",
        ] : []),
        ...(!planning?.shooter ? [
          "Which robot-relative direction does the shooter fire, must that direction face the target, and is there a preferred shooting range?",
        ] : []),
      ];
      return {
        planning: planning ?? null,
        completeForFuelCollection: Boolean(planning?.intake),
        missing,
        requiredQuestions,
        questions: requiredQuestions,
        optionalQuestions: ["Are there any additional strategy constraints or mechanism details the path planner should honor?"],
        coordinateFrame: "+X forward, +Y left, positions in meters, directions in degrees counterclockwise from +X.",
      };
    }
    if (request.method === "propose_robot_profile") {
      const stale = staleContext(snapshot, request.params.context);
      if (stale) return stale;
      if (!request.params.intent.trim()) throw new Error("A robot-profile intent is required.");
      const planning: RobotPlanningProfile = {
        ...(snapshot.project.robot.planning ?? {}),
        ...clone(request.params.planning),
      };
      const candidateProject = clone(snapshot.project);
      candidateProject.robot.planning = planning;
      const validation = validateProject(candidateProject);
      const planningIssues = validation.issues.filter((item) => item.path.startsWith("$.robot.planning"));
      if (planningIssues.length) throw new Error(planningIssues.map((item) => `${item.path}: ${item.message}`).join("; "));
      const summary = [
        planning.intake
          ? `${planning.intake.name}: ${planning.intake.captureWidthM.toFixed(2)} m capture width, ${planning.intake.maxCollectSpeedMps.toFixed(2)} m/s collection limit, ${planning.intake.directionDeg.toFixed(0)}° from robot forward.`
          : "No intake is configured; FUEL-collection heading cannot be certified.",
        planning.shooter
          ? `Shooter direction ${planning.shooter.directionDeg.toFixed(0)}°${planning.shooter.requiresTargetFacing ? " must face its target" : " does not require target-facing heading"}.`
          : "No shooter geometry is configured.",
        ...(planning.notes?.trim() ? [planning.notes.trim()] : []),
      ];
      const proposal: RobotProfileProposal = {
        id: `proposal_${randomUUID()}`,
        baseSessionId: snapshot.sessionId,
        baseRevision: snapshot.revision,
        baseActivePathId: snapshot.activePathId,
        intent: request.params.intent,
        operation: "configureRobot",
        planning: clone(planning),
        summary,
        status: "ready",
        createdAt: new Date().toISOString(),
      };
      const previewGeneration = this.claimPreviewOwnership(signal);
      const staged = await this.stage(proposal, previewGeneration, signal);
      return proposalSummary(staged.proposal, staged.supersededProposalId);
    }
    if (request.method === "resolve_field_terms") {
      if (!Array.isArray(request.params.phrases) || request.params.phrases.length < 1 || request.params.phrases.length > 24) throw new Error("Provide between 1 and 24 field phrases.");
      return request.params.phrases.map((phrase) => withAllianceView(resolveProjectFieldTerm(phrase, snapshot.project.strategy, {
        alliance: request.params.alliance,
        allianceView: snapshot.allianceView,
        pose: request.params.pose,
        relativeDistanceM: request.params.relativeDistanceM,
        robotHeightM: snapshot.project.robot.heightM ?? request.params.robotHeightM,
      }), snapshot.allianceView));
    }
    const requestContext = "context" in request.params ? request.params.context : undefined;
    const stale = staleContext(snapshot, requestContext);
    if (stale) return stale;
    const pathId = "pathId" in request.params && request.params.pathId
      ? request.params.pathId
      : requestContext?.activePathId ?? snapshot.activePathId;
    if (request.method === "analyze_path" || request.method === "repair_path") {
      const path = snapshot.project.paths.find((candidate) => candidate.id === pathId);
      if (!path) throw new Error(`Path ${pathId} does not exist in the current project.`);
      if (path.waypoints.length < 2) throw new Error("Add at least two waypoints before analyzing or repairing this path.");
    }
    if (request.method === "analyze_path") {
      const analysis = await this.executePlanning<PathAnalysis>({
        kind: "analyze", snapshot, pathId,
        sampleLimit: request.params.sampleLimit,
        minimumClearanceM: request.params.minimumClearanceM,
      }, snapshot, signal);
      return request.params.detail === "samples" ? analysis : analysisSummary(analysis);
    }
    if (request.method === "repair_path") {
      const previewGeneration = this.claimPreviewOwnership(signal);
      const candidates = await this.executePlanning<ReturnType<typeof generateRepairCandidates>>({
        kind: "repair", snapshot, pathId,
        findingIds: request.params.findingIds,
        minimumClearanceM: request.params.minimumClearanceM,
      }, snapshot, signal);
      if (candidates.length === 0) throw new Error("Bordeaux could not generate a targeted repair for those findings without changing unrelated intent.");
      const valid = candidates.filter((candidate) => candidate.valid);
      if (valid.length === 0) {
        const outcome: BlockedPlanningOutcome = {
          status: "blocked",
          code: "NO_VALID_CANDIDATE",
          proposalId: null,
          baseContext: snapshotContext(snapshot),
          candidates: candidates.map(candidateSummary),
          blockingIssues: [...new Set(candidates.map((candidate) => candidate.rejectionReason ?? "The generated repair did not pass validation."))],
        };
        return outcome;
      }
      const proposal: PathProposal = {
        id: `proposal_${randomUUID()}`,
        baseSessionId: snapshot.sessionId,
        baseRevision: snapshot.revision,
        baseActivePathId: snapshot.activePathId,
        intent: `Repair ${request.params.findingIds.join(", ")} on ${pathId}`,
        operation: "replace",
        targetPathId: pathId,
        candidates,
        recommendedCandidateId: valid[0].id,
        recommendationReason: `${valid[0].label} materially improves the requested finding without introducing a worse error or warning.`,
        status: "ready",
        createdAt: new Date().toISOString(),
      };
      const staged = await this.stage(proposal, previewGeneration, signal);
      return proposalSummary(staged.proposal, staged.supersededProposalId);
    }
    if (request.method !== "plan_path") throw new Error("Unsupported Bordeaux agent request.");
    const preflight = planPreflight(snapshot, request.params);
    if (preflight) return preflight;
    if (request.params.endAction && request.params.endActionIntent) throw new Error("Provide either a verified endAction binding or an unresolved endActionIntent, not both.");
    const planningRequest: PlanPathRequest = request.params.basePathId || !request.params.context
      ? request.params
      : { ...request.params, basePathId: request.params.context.activePathId };
    const previewGeneration = this.claimPreviewOwnership(signal);
    const candidates = await this.executePlanning<ReturnType<typeof generateRouteCandidates>>({
      kind: "route", snapshot, request: planningRequest,
    }, snapshot, signal);
    if (candidates.length === 0) throw new Error("Bordeaux could not generate route candidates for that request.");
    const valid = candidates.filter((candidate) => candidate.valid);
    if (valid.length === 0) {
      const outcome: BlockedPlanningOutcome = {
        status: "blocked",
        code: "NO_VALID_CANDIDATE",
        proposalId: null,
        baseContext: snapshotContext(snapshot),
        candidates: candidates.map(candidateSummary),
        blockingIssues: [...new Set(candidates.map((candidate) => candidate.rejectionReason ?? "The generated route did not pass validation."))],
      };
      return outcome;
    }
    let baseRobotCatalogFingerprint: string | undefined;
    if (request.params.endAction) {
      const catalog = this.getRobotCatalog();
      if (!catalog?.authoritative) throw new Error("Link and build an authoritative Robot command catalog before binding an end action.");
      baseRobotCatalogFingerprint = robotCatalogFingerprint(catalog) ?? undefined;
      const endAction = request.params.endAction;
      const tagged = catalog.commands.filter((item) => item.runtimeReady === true && item.semanticTags?.includes(endAction.semanticTag));
      const binding = snapshot.project.strategy?.actionBindings?.find((item) => item.semanticTag === endAction.semanticTag);
      if (!binding && tagged.length !== 1) throw new Error(`Semantic action ${endAction.semanticTag} must match exactly one runtime-ready command or have one explicit project strategy binding; found ${tagged.length}.`);
      const selectedCommandId = binding?.commandId ?? tagged[0].id;
      if (endAction.commandId !== selectedCommandId) throw new Error(`Semantic action ${endAction.semanticTag} is explicitly bound to ${selectedCommandId}, not ${endAction.commandId}.`);
      const command = catalog.commands.find((item) => item.id === selectedCommandId && item.runtimeReady === true);
      if (!command) throw new Error("The requested end action is not a runtime-ready command in the linked catalog.");
      if (!command.semanticTags?.includes(endAction.semanticTag)) throw new Error(`Command ${command.id} does not explicitly advertise ${endAction.semanticTag}.`);
      const invocation = {
        commandId: command.id,
        arguments: endAction.arguments ?? defaultRobotCommandArguments(command),
        cancelOnPathEnd: endAction.cancelOnPathEnd,
      };
      const invocationErrors = robotInvocationErrors(invocation, command);
      if (invocationErrors.length) throw new Error(`End action is invalid: ${invocationErrors.join("; ")}`);
      candidates.forEach((candidate) => {
        candidate.path.markers.push({ id: `event_${randomUUID()}`, f: 1, name: command.label, invocation });
        candidate.analysis.authoredPath = candidate.path;
      });
    }
    if (request.params.endActionIntent) {
      const actionIntent = request.params.endActionIntent;
      candidates.forEach((candidate) => {
        candidate.path.markers.push({
          id: `event_${randomUUID()}`,
          f: 1,
          name: actionIntent.description,
          cmd: "none",
          group: "sequential",
          actionIntent: { ...actionIntent },
        });
        candidate.analysis.authoredPath = candidate.path;
      });
    }
    const recommendedCandidateId = valid[0].id;
    const advisories = request.params.endActionIntent ? [
      `Action pending: “${request.params.endActionIntent.description}” (${request.params.endActionIntent.semanticTag}) is preserved at the path endpoint but has no robot command yet. Link an authoritative Robot command before export.`,
    ] : [];
    const proposal: PathProposal = {
      id: `proposal_${randomUUID()}`,
      baseSessionId: snapshot.sessionId,
      baseRevision: snapshot.revision,
      baseActivePathId: snapshot.activePathId,
      ...(baseRobotCatalogFingerprint ? { baseRobotCatalogFingerprint } : {}),
      intent: request.params.intent,
      operation: "add",
      candidates,
      recommendedCandidateId,
      recommendationReason: routeRecommendationReason(candidates, recommendedCandidateId),
      ...(advisories.length ? { advisories } : {}),
      status: "ready",
      createdAt: new Date().toISOString(),
    };
    const staged = await this.stage(proposal, previewGeneration, signal);
    return proposalSummary(staged.proposal, staged.supersededProposalId);
  }
}
