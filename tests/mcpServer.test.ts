import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import type { AgentRequest } from "../src/electron/agentSession";
import { buildMcpServer } from "../src/mcp/server";

describe("Bordeaux MCP surface", () => {
  it("lists the safe tool boundary and forwards structured requests", async () => {
    const requests: AgentRequest[] = [];
    const context = { sessionId: "session_test", revision: 3, activePathId: "path_test" };
    const proposal = {
      status: "ready" as const,
      proposalId: "proposal_test",
      proposalUri: "bordeaux://proposals/proposal_test",
      baseContext: context,
      intent: "Test path",
      operation: "add" as const,
      recommendedCandidate: {
        id: "candidate_test", label: "Test candidate", valid: true,
        metrics: { totalTimeS: 2, totalDistanceM: 3, minimumClearanceM: 0.2, waypointCount: 2, peakCurvatureInvM: 0.1, peakAngularVelocityRadps: 0.2 },
        findingCounts: { errors: 0, warnings: 0, notes: 0 },
      },
      candidates: [],
      recommendationReason: "Valid test candidate.",
      createdAt: "2026-08-10T00:00:00.000Z",
      expiresAt: "2026-08-10T00:30:00.000Z",
    };
    const server = buildMcpServer({ request: async (request) => {
      requests.push(request);
      if (request.method === "inspect_session") return { context, sessionId: context.sessionId, revision: context.revision, projectName: "Test", activePathId: context.activePathId };
      if (request.method === "propose_robot_profile") return { ...proposal, operation: "configureRobot", recommendedCandidate: null };
      if (request.method === "get_current_proposal") return proposal;
      return proposal;
    } });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["inspect_session", "inspect_robot_profile", "propose_robot_profile", "resolve_field_terms", "analyze_path", "repair_path", "plan_path", "get_proposal"]));
      expect(tools.tools.map((tool) => tool.name)).not.toContain("save_project");
      expect(tools.tools.every((tool) => tool.outputSchema)).toBe(true);
      expect(tools.tools.every((tool) => tool.annotations?.openWorldHint === false)).toBe(true);
      const authoring = await client.readResource({ uri: "bordeaux://guidance/path-authoring" });
      expect(authoring.contents[0]).toMatchObject({ mimeType: "application/json" });
      expect("text" in authoring.contents[0] ? authoring.contents[0].text : "").toContain("72 inches deep");
      expect("text" in authoring.contents[0] ? authoring.contents[0].text : "").toContain("configured robot footprint and height");
      const prompt = await client.getPrompt({ name: "author_autonomous_path" });
      expect(prompt.messages[0].content).toMatchObject({ type: "text" });
      expect(prompt.messages[0].content.type === "text" ? prompt.messages[0].content.text : "").toContain("much shallower than the full 283-inch NEUTRAL ZONE");
      expect(prompt.messages[0].content.type === "text" ? prompt.messages[0].content.text : "").toContain("allows valid geometry to be added");
      expect(prompt.messages[0].content.type === "text" ? prompt.messages[0].content.text : "").toContain("mark collectFuel only on steps intended to sweep ball-bearing space");
      expect(prompt.messages[0].content.type === "text" ? prompt.messages[0].content.text : "").toContain("across the full half through the CENTER LINE");
      const setupPrompt = await client.getPrompt({ name: "configure_robot_for_planning" });
      expect(setupPrompt.messages[0].content.type === "text" ? setupPrompt.messages[0].content.text : "").toContain("Do not guess");
      const result = await client.callTool({ name: "inspect_session", arguments: {} });
      expect(result.structuredContent).toMatchObject({ context, projectName: "Test" });
      expect(result.content[0]).toMatchObject({ type: "text" });
      expect(result.content[0].type === "text" ? result.content[0].text.length : Number.POSITIVE_INFINITY).toBeLessThan(200);
      expect(requests[0]).toEqual({ method: "inspect_session" });
      const planned = await client.callTool({ name: "plan_path", arguments: {
        intent: "Drive and shoot", alliance: "blue", goals: [{ x: 5.2705, y: 3.0345 }],
        endAction: { commandId: "robot.shoot", semanticTag: "shoot-fuel" },
      } });
      expect(planned.structuredContent).toMatchObject({ proposalId: "proposal_test", recommendedCandidate: { valid: true } });
      expect(planned.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "resource_link", uri: "bordeaux://proposals/proposal_test" })]));
      expect(requests[1]).toMatchObject({ method: "plan_path", params: { endAction: { commandId: "robot.shoot", semanticTag: "shoot-fuel" } } });
      await client.callTool({ name: "plan_path", arguments: {
        intent: "Mixed route", alliance: "red", start: { term: "red left trench" },
        steps: [
          { kind: "swoosh", at: { term: "far side of the neutral zone" }, traversal: "trench-table", turn: "clockwise", radiusM: 0.8, insetM: 1, collectFuel: { maxHeadingErrorDeg: 8 } },
          { kind: "travel", to: { x: 6.0705, y: -1.4155 }, traversal: "bump-table" },
        ],
        endActionIntent: { semanticTag: "shoot-fuel", description: "shoot into the red HUB" },
      } });
      expect(requests[2]).toMatchObject({ method: "plan_path", params: { steps: [{ kind: "swoosh", collectFuel: { maxHeadingErrorDeg: 8 } }, { kind: "travel" }], endActionIntent: { semanticTag: "shoot-fuel" } } });
      const conflictingTraversal = await client.callTool({ name: "plan_path", arguments: {
        intent: "Conflicting route", alliance: "red", steps: [{ kind: "travel", to: { x: 8, y: 4 }, traversal: "bump-table" }], traversal: "trench",
      } });
      expect(conflictingTraversal.isError).toBe(true);
      const invalidPose = await client.callTool({ name: "resolve_field_terms", arguments: { phrases: ["front of bot"], pose: { headingSource: "physical", x: -9, y: 1, physicalHeadingRad: 0 } } });
      expect(invalidPose.isError).toBe(true);
      await client.callTool({ name: "propose_robot_profile", arguments: {
        intent: "Configure the front intake",
        planning: { intake: { name: "Front intake", centerM: { x: 0.42, y: 0 }, directionDeg: 0, captureWidthM: 0.7, maxCollectSpeedMps: 2 } },
      } });
      expect(requests.at(-1)).toMatchObject({ method: "propose_robot_profile", params: { planning: { intake: { directionDeg: 0, maxCollectSpeedMps: 2 } } } });
      const currentProposal = await client.readResource({ uri: "bordeaux://proposals/current" });
      expect("text" in currentProposal.contents[0] ? currentProposal.contents[0].text : "").toContain("proposal_test");
      expect(requests.at(-1)).toEqual({ method: "get_current_proposal" });
      await client.readResource({ uri: "bordeaux://proposals/proposal_test/candidates/candidate_test" });
      expect(requests.at(-1)).toEqual({ method: "get_proposal_candidate", params: { proposalId: "proposal_test", candidateId: "candidate_test" } });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("forwards resource cancellation to bridge-backed analysis", async () => {
    let analysisStarted: (() => void) | undefined;
    let analysisCanceled: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { analysisStarted = resolve; });
    const canceled = new Promise<void>((resolve) => { analysisCanceled = resolve; });
    const server = buildMcpServer({ request: (request, signal) => {
      if (request.method !== "analyze_path") return Promise.resolve({});
      analysisStarted?.();
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          analysisCanceled?.();
          reject(new Error("analysis canceled"));
        }, { once: true });
      });
    } });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const controller = new AbortController();
      const reading = client.readResource({ uri: "bordeaux://paths/path_test/analysis" }, { signal: controller.signal });
      await started;
      controller.abort();
      await canceled;
      await expect(reading).rejects.toThrow();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
