import { McpServer, ResourceTemplate, type CallToolResult, type JSONValue } from "@modelcontextprotocol/server";
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import type { AgentRequest } from "../electron/agentSession";
import {
  agentContextSchema,
  analyzePathInputSchema,
  getProposalInputSchema,
  inspectRobotProfileInputSchema,
  inspectSessionInputSchema,
  planPathRequestSchema,
  proposeRobotProfileInputSchema,
  repairPathInputSchema,
  resolveFieldTermsInputSchema,
} from "../shared/agent/schemas";

export interface BordeauxMcpBridge {
  request(request: AgentRequest, signal?: AbortSignal): Promise<unknown>;
}

function jsonValue(value: unknown): JSONValue {
  return JSON.parse(JSON.stringify(value)) as JSONValue;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function resultText(value: unknown): string {
  const object = objectValue(value);
  if (object?.status === "ready" && typeof object.proposalId === "string") {
    const recommended = objectValue(object.recommendedCandidate);
    return `Proposal ${object.proposalId} is ready${recommended && typeof recommended.id === "string" ? `; recommended candidate ${recommended.id}` : ""}. Detailed data is available from ${String(object.proposalUri)}.`;
  }
  if (object?.status === "blocked") return `No proposal was staged. ${Array.isArray(object.blockingIssues) ? object.blockingIssues.join(" ") : "No generated candidate passed validation."}`;
  if (object?.status === "needs_input") return `Planning needs input: ${Array.isArray(object.questions) ? object.questions.join(" ") : "inspect the structured result"}`;
  if (object?.status === "stale_context") return String(object.message ?? "The editor context changed; inspect the session and retry.");
  if (object?.status === "complete" && typeof object.pathId === "string") return `Analysis complete for ${object.pathId}; inspect structuredContent for measured findings and extrema.`;
  if (object?.context && typeof object.projectName === "string") return `Bordeaux project ${object.projectName}, revision ${String(object.revision)}, active path ${String(object.activePathId)}.`;
  if (typeof object?.completeForFuelCollection === "boolean") return object.completeForFuelCollection ? "The robot profile is complete for FUEL collection." : "The robot profile has required unanswered questions.";
  if (Array.isArray(value)) {
    const resolved = value.filter((item) => objectValue(item)?.status === "resolved").length;
    return `Resolved ${resolved} of ${value.length} field terms. Inspect structuredContent for coordinates and diagnostics.`;
  }
  return "Bordeaux returned structured data.";
}

function toolResult(value: unknown): CallToolResult {
  const object = objectValue(value);
  const content: CallToolResult["content"] = [{ type: "text", text: resultText(value) }];
  if (typeof object?.proposalUri === "string" && typeof object.proposalId === "string") {
    content.push({ type: "resource_link", name: `Proposal ${object.proposalId}`, uri: object.proposalUri, mimeType: "application/json", description: "Full staged Bordeaux proposal." });
  }
  if (typeof object?.analysisUri === "string" && typeof object.pathId === "string") {
    content.push({ type: "resource_link", name: `Analysis ${object.pathId}`, uri: object.analysisUri, mimeType: "application/json", description: "Detailed path analysis with bounded samples." });
  }
  return { content, structuredContent: jsonValue(value) };
}

function errorCode(message: string): { code: string; retryable: boolean } {
  if (/finish loading|Open a Bordeaux project/.test(message)) return { code: "SESSION_NOT_READY", retryable: true };
  if (/changed while|changed before|stale/i.test(message)) return { code: "STALE_CONTEXT", retryable: true };
  if (/canceled|timed out/i.test(message)) return { code: "CANCELED", retryable: true };
  if (/does not exist|expired/.test(message)) return { code: "NOT_FOUND", retryable: false };
  if (/authoritative Robot|runtime-ready command|Semantic action/.test(message)) return { code: "ACTION_BINDING_REQUIRED", retryable: true };
  return { code: "REQUEST_FAILED", retryable: true };
}

function toolError(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const classified = errorCode(message);
  const value = { status: "error", error: { ...classified, message } };
  return { isError: true, content: [{ type: "text", text: `${classified.code}: ${message}` }], structuredContent: value };
}

async function callBridge(bridge: BordeauxMcpBridge, request: AgentRequest, signal?: AbortSignal): Promise<CallToolResult> {
  try { return toolResult(await bridge.request(request, signal)); }
  catch (error) { return toolError(error); }
}

function jsonResource(uri: URL, value: unknown) {
  return { contents: [{ uri: uri.toString(), mimeType: "application/json", text: JSON.stringify(value, null, 2) }] };
}

const localRead = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const localPreview = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

const errorOutputSchema = z.object({
  status: z.literal("error"),
  error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }),
});
const staleContextOutputSchema = z.object({ status: z.literal("stale_context"), code: z.literal("STALE_CONTEXT"), message: z.string(), currentContext: agentContextSchema });
const candidateSummaryOutputSchema = z.object({
  id: z.string(),
  label: z.string(),
  valid: z.boolean(),
  requiredPortalIds: z.array(z.string()).optional(),
  metrics: z.object({
    totalTimeS: z.number(), totalDistanceM: z.number(), minimumClearanceM: z.number(), waypointCount: z.number(), peakCurvatureInvM: z.number(), peakAngularVelocityRadps: z.number(),
    estimatedCollectionAreaM2: z.number().optional(), shootingRangeM: z.number().optional(), preferredShootingRangeErrorM: z.number().optional(),
  }).optional(),
  changedFields: z.array(z.string()).optional(),
  rejectionReason: z.string().optional(),
  findingCounts: z.object({ errors: z.number().int(), warnings: z.number().int(), notes: z.number().int() }),
});
const proposalSummaryOutputSchema = z.object({
  status: z.enum(["ready", "stale", "applied", "rejected", "expired"]),
  proposalId: z.string(),
  proposalUri: z.string(),
  baseContext: agentContextSchema,
  intent: z.string(),
  operation: z.enum(["add", "replace", "configureRobot"]),
  targetPathId: z.string().optional(),
  recommendedCandidate: candidateSummaryOutputSchema.nullable(),
  candidates: z.array(candidateSummaryOutputSchema),
  recommendationReason: z.string().optional(),
  blockingIssues: z.array(z.string()).optional(),
  advisories: z.array(z.string()).optional(),
  summary: z.array(z.string()).optional(),
  supersededProposalId: z.string().optional(),
  createdAt: z.string(),
  expiresAt: z.string(),
});
const blockedPlanningOutputSchema = z.object({
  status: z.literal("blocked"),
  code: z.literal("NO_VALID_CANDIDATE"),
  proposalId: z.null(),
  baseContext: agentContextSchema,
  candidates: z.array(candidateSummaryOutputSchema),
  blockingIssues: z.array(z.string()),
});
const needsInputOutputSchema = z.object({
  status: z.literal("needs_input"),
  code: z.enum(["ROBOT_PROFILE_INCOMPLETE", "TARGET_FACING_REQUIRED"]),
  baseContext: agentContextSchema,
  questions: z.array(z.string()),
});
const proposalOutcomeOutputSchema = z.union([proposalSummaryOutputSchema, blockedPlanningOutputSchema, needsInputOutputSchema, staleContextOutputSchema, errorOutputSchema]);

export function buildMcpServer(bridge: BordeauxMcpBridge): McpServer {
  const server = new McpServer({ name: "Bordeaux", version: "0.1.0" });
  server.registerResource("Current Bordeaux session", "bordeaux://session/current", { mimeType: "application/json", description: "Current live editor session, active path, planner, robot, and revision." }, async (uri, ctx) => jsonResource(uri, await bridge.request({ method: "inspect_session" }, ctx.mcpReq.signal)));
  server.registerResource("Robot planning profile", "bordeaux://robot/planning-profile", { mimeType: "application/json", description: "Configured intake/shooter geometry plus the unanswered setup questions an agent should ask the team." }, async (uri, ctx) => jsonResource(uri, await bridge.request({ method: "inspect_robot_profile" }, ctx.mcpReq.signal)));
  server.registerResource("2026 REBUILT field", "bordeaux://field/2026-rebuilt", { mimeType: "application/json", description: "Source-pinned field vocabulary and geometry with explicit Bordeaux display transform." }, async (uri, ctx) => jsonResource(uri, await bridge.request({ method: "field_pack" }, ctx.mcpReq.signal)));
  server.registerResource("Path authoring contract", "bordeaux://guidance/path-authoring", { mimeType: "application/json", description: "Required coordinate, vocabulary, ordered-route, maneuver, and action-binding rules for every fresh agent context." }, async (uri) => jsonResource(uri, {
    coordinateFrame: "Canonical Bordeaux coordinates match the overhead image: red is left/low-X, blue is right/high-X, and +Y is screen-up. Red view rotates only the displayed overlay.",
    rules: [
      "Inspect the live session and field pack before planning.",
      "An explicit red/blue phrase selects physical ownership and must never be replaced by allianceView.",
      "Resolve alliance-left/right through vocabulary; never infer it from screen left/right.",
      "Use ordered steps when outbound and inbound crossings differ. Never compress mixed TRENCH/BUMP intent into one global traversal.",
      "Represent swoosh as the typed 180-degree maneuver with explicit clockwise/counterclockwise direction and radius. Use insetM at a zone boundary to preserve robot-footprint clearance; never invent a free-form loop.",
      "When the user wants to collect initial FUEL, preserve collection as the route objective and use the official initial FUEL staging band (approximately 72 inches deep around the CENTER LINE), not the full 283-inch NEUTRAL ZONE depth. Resolve its near/far edge explicitly. If the user selects one field half, distribute distinct lanes across that half through the CENTER LINE using the configured intake capture width and footprint, rather than hugging the wall-side edge or retracing one lane.",
      "A proposal must validate the exact ordered portal sequence before it can be recommended.",
      "Preserve requested robot actions. Use endAction only after an authoritative Robot binding; otherwise use endActionIntent so Bordeaux retains a pending endpoint marker while allowing valid path geometry to be added.",
      "Plan against the configured robot footprint and height. Never replace project dimensions with a guessed centerline radius; BUMPs are traversable portals, TRENCHes are width- and height-limited portals, and HUBs plus field walls are solid.",
      "The field pack also inventories DEPOTS, OUTPOST CHUTE/CORRAL, TOWER RUNGS, DRIVER STATIONS, official off-field areas, HUB faces, and AprilTags 1-32. Respect navigable:false; a tag or structure face is a perception/aiming reference, not a chassis pose. DEPOT barrier dimensions are known but its floor polygon is intentionally uncertified, so do not invent one.",
      "Before planning FUEL collection, inspect the robot planning profile. Ask the returned missing questions, then stage the answers with propose_robot_profile for explicit in-app approval.",
      "For collection, set collectFuel only on route steps intended to sweep ball-bearing space. Bordeaux clips intake heading and the configured collection-speed cap to the portions of those steps inside the official initial-FUEL region; approach, exit, and BUMP travel outside that region keep their own limits. Do not author a crosswise collection heading unless the user explicitly approves allowCrosswiseHeading.",
      "Use smooth, lane-following waypoint tangents. Heading describes the robot's physical orientation; it is not interchangeable with the curve tangent unless the configured mechanism direction makes them equivalent.",
      "When shooting ends a route, use finishFacing with the configured shooter and physical HUB target. Bordeaux begins the HUB-facing rotation only after leaving the final collection lane and completes it while driving; it must not manufacture visible low-speed heading-transition ranges or defer the whole turn until after stopping.",
    ],
  }));
  server.registerResource("Current Robot commands", "bordeaux://commands/current", { mimeType: "application/json", description: "Authoritative linked Robot commands, or an empty catalog when none is linked." }, async (uri, ctx) => jsonResource(uri, await bridge.request({ method: "commands" }, ctx.mcpReq.signal)));
  server.registerResource("Path analysis", new ResourceTemplate("bordeaux://paths/{id}/analysis", { list: undefined }), { mimeType: "application/json", description: "Detailed authored path data, bounded raw planner samples, extrema, and measured findings." }, async (uri, variables, ctx) => jsonResource(uri, await bridge.request({ method: "analyze_path", params: { pathId: String(variables.id), detail: "samples" } }, ctx.mcpReq.signal)));
  server.registerResource("Current proposal", "bordeaux://proposals/current", { mimeType: "application/json", description: "The active reviewable proposal summary, or null when no proposal is active." }, async (uri, ctx) => jsonResource(uri, await bridge.request({ method: "get_current_proposal" }, ctx.mcpReq.signal)));
  server.registerResource("Proposal", new ResourceTemplate("bordeaux://proposals/{id}", { list: undefined }), { mimeType: "application/json", description: "A full staged proposal and its current application status." }, async (uri, variables, ctx) => jsonResource(uri, await bridge.request({ method: "get_proposal", params: { proposalId: String(variables.id), detail: "full" } }, ctx.mcpReq.signal)));
  server.registerResource("Proposal candidate", new ResourceTemplate("bordeaux://proposals/{proposalId}/candidates/{candidateId}", { list: undefined }), { mimeType: "application/json", description: "One full path or repair candidate, including its detailed analysis." }, async (uri, variables, ctx) => jsonResource(uri, await bridge.request({ method: "get_proposal_candidate", params: { proposalId: String(variables.proposalId), candidateId: String(variables.candidateId) } }, ctx.mcpReq.signal)));

  server.registerTool("inspect_session", {
    title: "Inspect Bordeaux session",
    description: "Inspect the live project and obtain the context handle required for retry-safe planning. This never changes the editor.",
    inputSchema: inspectSessionInputSchema,
    outputSchema: z.union([z.object({ context: agentContextSchema, sessionId: z.string(), revision: z.number(), projectName: z.string(), activePathId: z.string() }).passthrough(), errorOutputSchema]),
    annotations: localRead,
  }, async (_args, ctx) => callBridge(bridge, { method: "inspect_session" }, ctx.mcpReq.signal));
  server.registerTool("inspect_robot_profile", {
    title: "Inspect robot planning profile",
    description: "Inspect intake and shooter geometry. requiredQuestions contains only unanswered facts; optionalQuestions are never planning blockers.",
    inputSchema: inspectRobotProfileInputSchema,
    outputSchema: z.union([z.object({ completeForFuelCollection: z.boolean(), missing: z.array(z.string()), requiredQuestions: z.array(z.string()), questions: z.array(z.string()), optionalQuestions: z.array(z.string()) }).passthrough(), errorOutputSchema]),
    annotations: localRead,
  }, async (_args, ctx) => callBridge(bridge, { method: "inspect_robot_profile" }, ctx.mcpReq.signal));
  server.registerTool("propose_robot_profile", {
    title: "Propose robot planning profile",
    description: "Stage team-provided intake, shooter, and planning details for explicit Robot-page review. Pass inspect_session.context to reject stale editor state. This supersedes any current preview and never changes the project directly.",
    inputSchema: proposeRobotProfileInputSchema,
    outputSchema: z.union([proposalSummaryOutputSchema, staleContextOutputSchema, errorOutputSchema]),
    annotations: localPreview,
  }, async (args, ctx) => callBridge(bridge, { method: "propose_robot_profile", params: args }, ctx.mcpReq.signal));
  server.registerTool("resolve_field_terms", {
    title: "Resolve Bordeaux field terms",
    description: "Resolve game-manual and robot-relative vocabulary to authoritative field locations. Explicit red/blue ownership is independent of the editor view; alliance-left/right is driver-relative.",
    inputSchema: resolveFieldTermsInputSchema,
    outputSchema: z.union([z.array(z.object({ phrase: z.string(), status: z.enum(["resolved", "unresolved", "ambiguous"]), matches: z.array(z.object({ id: z.string(), label: z.string(), point: z.object({ x: z.number(), y: z.number() }) }).passthrough()) }).passthrough()), errorOutputSchema]),
    annotations: localRead,
  }, async (args, ctx) => callBridge(bridge, { method: "resolve_field_terms", params: args }, ctx.mcpReq.signal));
  server.registerTool("analyze_path", {
    title: "Analyze Bordeaux path",
    description: "Analyze a live path without mutation. The default summary omits raw samples; request detail=samples only when exact trajectory samples are needed.",
    inputSchema: analyzePathInputSchema,
    outputSchema: z.json(),
    annotations: localRead,
  }, async (args, ctx) => callBridge(bridge, { method: "analyze_path", params: args }, ctx.mcpReq.signal));
  server.registerTool("repair_path", {
    title: "Propose Bordeaux path repair",
    description: "Generate bounded repairs for named findings. Pass inspect_session.context. Invalid candidates return status=blocked and are not staged; a ready result supersedes the current preview.",
    inputSchema: repairPathInputSchema,
    outputSchema: proposalOutcomeOutputSchema,
    annotations: localPreview,
  }, async (args, ctx) => callBridge(bridge, { method: "repair_path", params: args }, ctx.mcpReq.signal));
  server.registerTool("plan_path", {
    title: "Propose Bordeaux autonomous path",
    description: "Validate and stage planner-scored path previews. Pass inspect_session.context. Use ordered steps for mixed crossings, keep collection only on FUEL-sweeping steps, and use a separate final approach for finishFacing. Missing facts return needs_input; invalid candidates return blocked without staging; ready results supersede the current preview. This is not a global optimum.",
    inputSchema: planPathRequestSchema,
    outputSchema: proposalOutcomeOutputSchema,
    annotations: localPreview,
  }, async (args, ctx) => callBridge(bridge, { method: "plan_path", params: args }, ctx.mcpReq.signal));
  server.registerTool("get_proposal", {
    title: "Inspect Bordeaux proposal",
    description: "Read a compact proposal summary by default. Use detail=full only when the complete paths and analyses are required; candidate resources are usually more efficient.",
    inputSchema: getProposalInputSchema,
    outputSchema: z.json(),
    annotations: localRead,
  }, async (args, ctx) => callBridge(bridge, { method: "get_proposal", params: args }, ctx.mcpReq.signal));
  server.registerPrompt("configure_robot_for_planning", { description: "Interview the team for missing robot facts, then stage a reviewable Robot-page proposal." }, async () => ({ messages: [{ role: "user", content: { type: "text", text: "Read bordeaux://robot/planning-profile and bordeaux://session/current. Ask only requiredQuestions from the profile resource; optionalQuestions are not blockers. Explain that +X is robot forward, +Y is robot left, and directions are counterclockwise degrees from +X. Do not guess. After the user answers, call propose_robot_profile with the current context handle. Tell the user to review and apply it on Bordeaux's Robot page; never apply, save, or export it yourself." } }] }));
  server.registerPrompt("author_autonomous_path", { description: "Required safe workflow for coordinate-correct, topology-preserving path authoring and in-app approval." }, async () => ({ messages: [{ role: "user", content: { type: "text", text: "Read bordeaux://session/current, bordeaux://robot/planning-profile, bordeaux://field/2026-rebuilt, and bordeaux://guidance/path-authoring before planning. If the robot profile reports missing facts relevant to the request, ask the user those exact questions and stage their answers with propose_robot_profile; never guess mechanism geometry. Canonical Bordeaux coordinates use the fixed official blue-origin frame: blue is low-X, red is high-X, +Y away from the scoring table, zero heading toward red and positive headings counterclockwise. Flip is an explicit undoable 180-degree edit of all authored paths; it changes saved coordinates. Official +Y is away from the scoring table. Resolve every game-manual term explicitly and respect navigable:false on fiducials, structure faces, and off-field areas. Treat alliance-left/right as driver-relative vocabulary, not screen-relative guessing. Plan against the configured robot-local footprint and height: the full oriented polygon must fit, BUMPs are traversable surfaces with full depth, TRENCHes are width- and height-limited overhead passages, and HUBs plus field walls are solid. Never substitute a guessed centerline radius or an uncertified DEPOT polygon. If outbound and inbound crossings differ, use ordered steps with a traversal on each leg; never use legacy goals or a single global traversal. Encode a swoosh only with the typed 180-degree swoosh step, explicit turn direction, radius, and a footprint-safe inset when its named extent is a zone boundary—never with guessed loop coordinates. If the user wants to collect initial FUEL, keep collection as the route objective, mark collectFuel only on steps intended to sweep ball-bearing space, and resolve both edges of the official approximately 72-inch-deep FUEL band around the CENTER LINE. This band is much shallower than the full 283-inch NEUTRAL ZONE. Route the outbound and return lanes inside that green region. If one field half is requested, distribute those lanes across the full half through the CENTER LINE using the configured intake capture width and robot footprint; do not hug only the wall-side portion. Bordeaux clips the intake-speed and intake-heading rules to the actual in-region portions, so never extend collection caps through empty approaches, TRENCHes, BUMPs, or alliance zones. Use distinct collection lanes with little retracing. Treat authored heading as physical robot orientation. Tangents control geometry, while swerve heading may rotate independently after collection. Use finishFacing so Bordeaux begins rotating toward the HUB after leaving the final FUEL lane and completes the alignment while still driving; never request manufactured low-speed heading-transition ranges or a full stationary endpoint turn. Confirm the proposal's requiredPortalIds match the requested order before recommending it. Preserve requested actions: bind endAction only through an authoritative Robot command; otherwise send endActionIntent so Bordeaux saves a pending endpoint marker, allows valid geometry to be added, and requires binding before Robot export. Analyze existing paths before repairs, recommend only a valid candidate, and tell the user to review Apply/Reject in Bordeaux. Never claim global optimality or attempt file, export, build, or deploy operations." } }] }));
  return server;
}

export function serveBordeauxMcp(bridge: BordeauxMcpBridge) {
  return serveStdio(() => buildMcpServer(bridge), {
    transport: new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 1024 * 1024 }),
    onerror: (error) => console.error("Bordeaux MCP error:", error instanceof Error ? error.message : String(error)),
  });
}
