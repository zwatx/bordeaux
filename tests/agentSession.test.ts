import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentBridgeClient, AgentBridgeServer } from "../src/electron/agentBridge";
import { AgentSessionService, runAgentPlanningJobDirect } from "../src/electron/agentSession";
import type { RepairCandidate } from "../src/shared/agent/types";
import { createDemoProject } from "../src/shared/project/defaults";
import type { RobotCommandCatalog, RobotCommandDescriptor } from "../src/shared/types";
import { validateProject, validateProjectSource } from "../src/shared/validation";
import { buildBdxExport } from "../src/shared/export/bdx";

function snapshot(revision = 0) {
  const project = createDemoProject();
  return {
    sessionId: "session_test",
    revision,
    project,
    activePathId: project.paths[0].id,
    allianceView: "blue" as const,
    fieldPack: { id: "2026-rebuilt" as const, revision: "test" },
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function shootCommand(overrides: Partial<RobotCommandDescriptor> = {}): RobotCommandDescriptor {
  return {
    id: "robot.shoot",
    label: "Shoot",
    aliases: ["shoot"],
    semanticTags: ["shoot-fuel"],
    runtimeReady: true,
    ownerType: "robot.Actions",
    member: "shoot",
    kind: "factory",
    confidence: "confirmed",
    parameters: [],
    source: { file: "robot/Actions.vi", line: 1 },
    ...overrides,
  };
}

function authoritativeCatalog(commands: RobotCommandDescriptor[] = [shootCommand()]): RobotCommandCatalog {
  return {
    projectName: "Robot",
    sourceFileCount: 1,
    scannedAt: "2026-08-10T00:00:00.000Z",
    generatedSchemaVersion: "1.0",
    catalogId: "robot-catalog",
    supportVersion: "1.0",
    catalogHash: `sha256:${"a".repeat(64)}`,
    authoritative: true,
    commands,
    warnings: [],
  };
}

describe("agent session and private bridge", () => {
  it("cancels an in-flight planning job when the editor revision changes", async () => {
    let aborted = false;
    const service = new AgentSessionService(() => {}, () => null, (_job, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("planning worker aborted"));
      }, { once: true });
    }));
    const initial = snapshot();
    service.publishSnapshot(initial);

    const pending = service.request({ method: "analyze_path", params: {} });
    service.publishSnapshot({ ...initial, revision: 1 });

    await expect(pending).rejects.toThrow("planning worker aborted");
    expect(aborted).toBe(true);
  });

  it("cancels an in-flight planning job when only the active path changes", async () => {
    const release = deferred<unknown>();
    const service = new AgentSessionService(() => {}, () => null, async () => release.promise);
    const initial = snapshot();
    service.publishSnapshot(initial);
    const pending = service.request({ method: "plan_path", params: {
      intent: "Plan on the original path", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 3, y: 1 }], maximumCandidates: 1,
    } });
    const switched = structuredClone(initial);
    const otherPath = structuredClone(switched.project.paths[0]);
    otherPath.id = "path_other_during_planning";
    otherPath.name = "Other path";
    switched.project.paths.push(otherPath);
    switched.activePathId = otherPath.id;

    service.publishSnapshot(switched);
    release.resolve([]);

    await expect(pending).rejects.toThrow(/planning was canceled|session changed/i);
  });

  it("does not start planning for an already-canceled request", async () => {
    let invoked = false;
    const service = new AgentSessionService(() => {}, () => null, async () => {
      invoked = true;
      return { findings: [] };
    });
    service.publishSnapshot(snapshot());
    const controller = new AbortController();
    controller.abort();

    await expect(service.request({ method: "analyze_path", params: {} }, controller.signal)).rejects.toThrow("Agent planning was canceled");
    expect(invoked).toBe(false);
  });

  it("allows independent read-only planning jobs to complete concurrently", async () => {
    const releases: Array<() => void> = [];
    const signals: AbortSignal[] = [];
    const service = new AgentSessionService(() => {}, () => null, async (job, signal) => {
      if (signal) signals.push(signal);
      await new Promise<void>((resolve) => releases.push(resolve));
      return runAgentPlanningJobDirect(job);
    });
    service.publishSnapshot(snapshot());

    const first = service.request({ method: "analyze_path", params: {} });
    const second = service.request({ method: "analyze_path", params: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(releases).toHaveLength(2);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    releases.forEach((release) => release());
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it("bounds concurrent read-only planning workers", async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    const service = new AgentSessionService(() => {}, () => null, async (job) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return runAgentPlanningJobDirect(job);
    });
    service.publishSnapshot(snapshot());

    const requests = Array.from({ length: 100 }, () => service.request({ method: "analyze_path", params: {} }));
    const settled = Promise.allSettled(requests);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(releases).toHaveLength(2);
    expect(peak).toBe(2);
    releases.forEach((release) => release());
    const results = await settled;
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(98);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: expect.objectContaining({ message: expect.stringContaining("already running 2 path analyses") }),
    });
  });

  it("keeps preview-producing planning jobs newest-wins", async () => {
    const releases: Array<() => void> = [];
    const signals: AbortSignal[] = [];
    const staged: string[] = [];
    const service = new AgentSessionService((proposal) => { staged.push(proposal.intent); }, () => null, (job, signal) => new Promise((resolve, reject) => {
      if (signal) {
        signals.push(signal);
        signal.addEventListener("abort", () => reject(new Error("planning worker aborted")), { once: true });
      }
      releases.push(() => resolve(runAgentPlanningJobDirect(job)));
    }));
    service.publishSnapshot(snapshot());

    const first = service.request({ method: "plan_path", params: {
      intent: "First preview", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 2, y: 1 }], maximumCandidates: 1,
    } });
    const firstRejected = expect(first).rejects.toThrow("planning worker aborted");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = service.request({ method: "plan_path", params: {
      intent: "Second preview", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 3, y: 1 }], maximumCandidates: 1,
    } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    releases[1]();
    await firstRejected;
    await expect(second).resolves.toMatchObject({ status: "ready", intent: "Second preview" });
    expect(staged).toEqual(["Second preview"]);
  });

  it("rejects an explicit stale context before starting planning", async () => {
    let invoked = false;
    const service = new AgentSessionService(() => {}, () => null, async () => {
      invoked = true;
      return {};
    });
    const initial = snapshot();
    service.publishSnapshot(initial);
    const context = { sessionId: initial.sessionId, revision: initial.revision, activePathId: initial.activePathId };
    service.publishSnapshot({ ...initial, revision: 1 });

    const result: any = await service.request({ method: "plan_path", params: {
      context, intent: "Stale request", alliance: "blue", goals: [{ x: 3, y: 1 }],
    } });

    expect(result).toMatchObject({ status: "stale_context", code: "STALE_CONTEXT", currentContext: { revision: 1 } });
    expect(invoked).toBe(false);
  });

  it("keeps field orientation separate from physical alliance ownership", async () => {
    const service = new AgentSessionService(() => {}, () => null);
    const initial = snapshot();
    service.publishSnapshot(initial);
    const uncolored: any[] = await service.request({ method: "resolve_field_terms", params: { phrases: ["left trench"] } }) as any[];
    expect(uncolored[0].status).toBe("unresolved");

    const blue: any[] = await service.request({ method: "resolve_field_terms", params: { phrases: ["left trench"], alliance: "blue" } }) as any[];
    service.publishSnapshot({ ...initial, revision: 1, allianceView: "red" });
    const flippedBlue: any[] = await service.request({ method: "resolve_field_terms", params: { phrases: ["left trench"], alliance: "blue" } }) as any[];
    expect(flippedBlue[0].matches[0].point).toEqual(blue[0].matches[0].point);
    expect(flippedBlue[0].matches[0].displayPoint).not.toEqual(blue[0].matches[0].displayPoint);
  });

  it.each([0, 1])("publishes editable source with a %i-waypoint sibling, including a fresh session", async (count) => {
    const service = new AgentSessionService(() => {}, () => null);
    const access = service.resetAccess(true);
    const initial = snapshot();
    expect(service.publishEditorSnapshot({ ...initial, accessGeneration: access.generation })).toBe("published");
    const next = structuredClone(initial);
    next.revision = 1;
    next.project.name = "Current edited project";
    const unfinished = { ...structuredClone(next.project.paths[0]), id: "unfinished", name: "Unfinished",
      waypoints: next.project.paths[0].waypoints.slice(0, count), markers: [], targets: [], ranges: [] };
    next.project.paths.push(unfinished);
    expect(validateProjectSource(next.project).ok).toBe(true);
    expect(service.publishEditorSnapshot({ ...next, accessGeneration: access.generation })).toBe("published");
    const expected = { revision: 1, projectName: next.project.name,
      paths: expect.arrayContaining([{ id: unfinished.id, name: unfinished.name, waypointCount: count }]) };
    expect(await service.request({ method: "inspect_session" })).toMatchObject(expected);
    expect(await service.request({ method: "analyze_path", params: {} })).toMatchObject({ pathId: initial.activePathId });
    const fresh = new AgentSessionService(() => {}, () => null);
    const freshAccess = fresh.resetAccess(true);
    expect(fresh.publishEditorSnapshot({ ...next, activePathId: unfinished.id, accessGeneration: freshAccess.generation })).toBe("published");
    expect(await fresh.request({ method: "inspect_session" })).toMatchObject({ ...expected, activePathId: unfinished.id });
    expect(await fresh.request({ method: "inspect_robot_profile" })).toHaveProperty("planning", next.project.robot.planning ?? null);
    // Source inspection does not grant execution readiness to an unfinished selected path.
    await expect(fresh.request({ method: "analyze_path", params: {} })).rejects.toThrow("Add at least two waypoints");
    await expect(fresh.request({ method: "repair_path", params: { findingIds: [] } })).rejects.toThrow("Add at least two waypoints");
    expect(() => buildBdxExport({ ...next.project, paths: [unfinished], routines: [] })).toThrow(/at least two waypoints/i);
  });

  it("retires the previous session after an invalid current publication and recovers on valid source", async () => {
    let aborted = false;
    const service = new AgentSessionService(() => {}, () => null, (_job, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true });
    }));
    const initial = snapshot();
    service.publishSnapshot(initial);
    const proposal: any = await service.request({ method: "propose_robot_profile", params: {
      intent: "Configure shooter", planning: { shooter: { directionDeg: 0, requiresTargetFacing: true } },
    } });
    const pending = service.request({ method: "analyze_path", params: {} });

    const invalid = structuredClone(initial);
    invalid.revision = 1;
    invalid.project.paths[0].ranges.push({
      anchor: "param", f0: 0, f1: 1,
      maxVel: -1, maxAccel: 1, maxAngVel: 90, maxAngAccel: 180,
    });

    expect(service.tryPublishSnapshot(invalid)).toBe(false);
    await expect(pending).rejects.toThrow("aborted");
    expect(aborted).toBe(true);
    expect(service.getActiveProposal()).toBeNull();
    expect(await service.request({ method: "get_proposal", params: { proposalId: proposal.proposalId } })).toMatchObject({ status: "stale" });
    await expect(service.request({ method: "inspect_session" })).rejects.toThrow("wait for the editor to finish loading");
    service.publishSnapshot({ ...initial, revision: 2 });
    expect(await service.request({ method: "inspect_session" })).toMatchObject({ revision: 2 });
  });

  it("stages proposals without changing the renderer snapshot and marks them stale on edit", async () => {
    const staged: any[] = [];
    const service = new AgentSessionService((proposal) => { staged.push(proposal); }, () => null);
    const initial = snapshot();
    service.publishSnapshot(initial);
    const proposal: any = await service.request({ method: "plan_path", params: { intent: "Go forward", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 3, y: 1 }], maximumCandidates: 1 } });
    expect(staged).toHaveLength(1);
    expect(service.getActiveProposal()?.id).toBe(proposal.proposalId);
    expect(proposal.recommendedCandidate.valid).toBe(true);
    expect(proposal.candidates[0].path).toBeUndefined();
    expect(JSON.stringify(proposal).length).toBeLessThan(5_000);
    expect(initial.project.paths).toHaveLength(1);
    service.publishSnapshot({ ...initial, revision: 1 });
    expect(service.getActiveProposal()).toBeNull();
    const stale: any = await service.request({ method: "get_proposal", params: { proposalId: proposal.proposalId } });
    expect(stale.status).toBe("stale");

    const nextSession = { ...initial, sessionId: "session_reopened", revision: 0 };
    service.publishSnapshot(nextSession);
    expect((await service.request({ method: "get_proposal", params: { proposalId: proposal.proposalId } }) as any).status).toBe("stale");
  });

  it("marks a proposal stale when the active path changes without a revision change", async () => {
    const service = new AgentSessionService(() => {}, () => null);
    const initial = snapshot();
    service.publishSnapshot(initial);
    const proposal: any = await service.request({ method: "plan_path", params: {
      intent: "Stay on the published path", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 3, y: 1 }], maximumCandidates: 1,
    } });
    const switched = structuredClone(initial);
    const otherPath = structuredClone(switched.project.paths[0]);
    otherPath.id = "path_other";
    otherPath.name = "Other path";
    switched.project.paths.push(otherPath);
    switched.activePathId = otherPath.id;

    service.publishSnapshot(switched);

    expect(service.getActiveProposal()).toBeNull();
    expect(await service.request({ method: "get_proposal", params: { proposalId: proposal.proposalId } })).toMatchObject({ status: "stale" });
  });

  it("returns invalid route candidates as a compact blocked result without staging", async () => {
    const staged: any[] = [];
    const service = new AgentSessionService((proposal) => { staged.push(proposal); }, () => null, async (job, signal) => {
      if (signal?.aborted) throw new Error("planning canceled");
      const result = await runAgentPlanningJobDirect(job);
      if (job.kind !== "route") return result;
      return (result as any[]).map((candidate) => ({ ...candidate, valid: false, rejectionReason: "Forced evaluation failure." }));
    });
    service.publishSnapshot(snapshot());

    const outcome: any = await service.request({ method: "plan_path", params: {
      intent: "Invalid preview", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 3, y: 1 }], maximumCandidates: 1,
    } });

    expect(outcome).toMatchObject({ status: "blocked", code: "NO_VALID_CANDIDATE", proposalId: null });
    expect(outcome.candidates[0]).toMatchObject({ valid: false, rejectionReason: "Forced evaluation failure." });
    expect(outcome.candidates[0].path).toBeUndefined();
    expect(staged).toHaveLength(0);
    expect(service.getActiveProposal()).toBeNull();
  });

  it("does not retain a ready proposal when the editor cannot receive it", async () => {
    const service = new AgentSessionService(() => { throw new Error("editor closed"); }, () => null);
    service.publishSnapshot(snapshot());
    await expect(service.request({ method: "plan_path", params: { intent: "Go", alliance: "blue", goals: [{ x: 3, y: 1 }], maximumCandidates: 1 } })).rejects.toThrow("editor closed");
    service.clearSnapshot();
    await expect(service.request({ method: "inspect_session" })).rejects.toThrow(/finish loading/);
  });

  it("waits for a renderer receipt before returning a ready proposal", async () => {
    let acknowledge: (() => void) | undefined;
    const service = new AgentSessionService((_proposal, requireReceipt) => requireReceipt ? new Promise<void>((resolve) => { acknowledge = resolve; }) : undefined, () => null);
    service.publishSnapshot(snapshot());
    let completed = false;
    const pending = service.request({ method: "plan_path", params: { intent: "Wait for preview", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 3, y: 1 }], maximumCandidates: 1 } }).then((value) => { completed = true; return value; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(completed).toBe(false);
    acknowledge?.();
    expect((await pending as any).status).toBe("ready");
  });

  it("does not return ready when the renderer acknowledges against a stale revision", async () => {
    const notifications: Array<{ intent: string; status: string }> = [];
    let service!: AgentSessionService;
    service = new AgentSessionService((proposal, requireReceipt) => {
      notifications.push({ intent: proposal.intent, status: proposal.status });
      if (requireReceipt && proposal.intent === "Stale provisional preview") {
        service.acknowledgeProposal(proposal.id, proposal.baseSessionId, proposal.baseRevision + 1, proposal.baseActivePathId);
      }
    }, () => null);
    service.publishSnapshot(snapshot());
    const committed: any = await service.request({ method: "plan_path", params: {
      intent: "Committed preview", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 2, y: 1 }], maximumCandidates: 1,
    } });

    await expect(service.request({ method: "plan_path", params: {
      intent: "Stale provisional preview", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 3, y: 1 }], maximumCandidates: 1,
    } })).rejects.toThrow("changed before it acknowledged");

    expect(service.getActiveProposal()?.id).toBe(committed.proposalId);
    expect(notifications.at(-1)).toEqual({ intent: "Committed preview", status: "ready" });
  });

  it("does not return ready when the renderer rejects a matching proposal receipt", async () => {
    let service!: AgentSessionService;
    service = new AgentSessionService((proposal, requireReceipt) => {
      if (requireReceipt) service.acknowledgeProposal(proposal.id, proposal.baseSessionId, proposal.baseRevision, proposal.baseActivePathId, false);
    }, () => null);
    service.publishSnapshot(snapshot());

    await expect(service.request({ method: "plan_path", params: {
      intent: "Rejected renderer preview", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 3, y: 1 }], maximumCandidates: 1,
    } })).rejects.toThrow("changed before it acknowledged");
    expect(service.getActiveProposal()).toBeNull();
  });

  it("does not return ready when the renderer receipt names a different active path", async () => {
    let service!: AgentSessionService;
    service = new AgentSessionService((proposal, requireReceipt) => {
      if (requireReceipt) service.acknowledgeProposal(proposal.id, proposal.baseSessionId, proposal.baseRevision, "path_opened_after_publication");
    }, () => null);
    service.publishSnapshot(snapshot());

    await expect(service.request({ method: "plan_path", params: {
      intent: "Wrong active path receipt", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 3, y: 1 }], maximumCandidates: 1,
    } })).rejects.toThrow("changed before it acknowledged");
    expect(service.getActiveProposal()).toBeNull();
  });

  it("rolls back staging when cancellation arrives during renderer acknowledgment", async () => {
    let waitForReceipt = false;
    let proposalReceived: (() => void) | undefined;
    const notifications: Array<{ id: string; intent: string; status: string }> = [];
    const service = new AgentSessionService((proposal, requireReceipt) => {
      notifications.push({ id: proposal.id, intent: proposal.intent, status: proposal.status });
      if (!requireReceipt || !waitForReceipt) return;
      proposalReceived?.();
      return new Promise<void>(() => {});
    }, () => null);
    service.publishSnapshot(snapshot());
    const first: any = await service.request({ method: "plan_path", params: {
      intent: "Existing preview", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 2, y: 1 }], maximumCandidates: 1,
    } });

    waitForReceipt = true;
    const received = new Promise<void>((resolve) => { proposalReceived = resolve; });
    const controller = new AbortController();
    const pending = service.request({ method: "plan_path", params: {
      intent: "Abandoned preview", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 3, y: 1 }], maximumCandidates: 1,
    } }, controller.signal);
    await received;
    controller.abort();

    await expect(pending).rejects.toThrow("Agent request was canceled");
    expect(service.getActiveProposal()?.id).toBe(first.proposalId);
    expect((await service.request({ method: "get_proposal", params: { proposalId: first.proposalId } }) as any).status).toBe("ready");
    expect(notifications.slice(-2)).toEqual([
      expect.objectContaining({ intent: "Abandoned preview", status: "stale" }),
      expect.objectContaining({ intent: "Existing preview", status: "ready" }),
    ]);
  });

  it.each([
    { change: "revision", settlement: "success" },
    { change: "session", settlement: "failure" },
    { change: "clear", settlement: "cancel" },
  ] as const)("does not restore a preview after a $change change and late $settlement", async ({ change, settlement }) => {
    const receipt = deferred();
    const received = deferred();
    const notifications: Array<{ intent: string; status: string }> = [];
    const service = new AgentSessionService((proposal, requireReceipt) => {
      notifications.push({ intent: proposal.intent, status: proposal.status });
      if (requireReceipt && proposal.intent === "Pending preview") {
        received.resolve();
        return receipt.promise;
      }
    }, () => null);
    const initial = snapshot();
    service.publishSnapshot(initial);
    const committed: any = await service.request({ method: "plan_path", params: {
      intent: "Committed preview", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 2, y: 1 }], maximumCandidates: 1,
    } });
    const controller = new AbortController();
    const pendingRequest = service.request({ method: "plan_path", params: {
      intent: "Pending preview", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 3, y: 1 }], maximumCandidates: 1,
    } }, controller.signal).then(
      () => ({ fulfilled: true as const }),
      (error: unknown) => ({ fulfilled: false as const, error }),
    );
    await received.promise;

    if (change === "revision") service.publishSnapshot({ ...initial, revision: 1 });
    else if (change === "session") service.publishSnapshot({ ...initial, sessionId: "session_reopened" });
    else service.clearSnapshot();
    const notificationsAfterContextChange = notifications.length;
    if (settlement === "success") receipt.resolve();
    else if (settlement === "failure") receipt.reject(new Error("late receipt failure"));
    else controller.abort();

    expect((await pendingRequest).fulfilled).toBe(false);
    receipt.resolve();
    expect(service.getActiveProposal()).toBeNull();
    expect((await service.request({ method: "get_proposal", params: { proposalId: committed.proposalId } }) as any).status).toBe("stale");
    expect(notifications.slice(notificationsAfterContextChange)).not.toContainEqual(expect.objectContaining({ status: "ready" }));
  });

  it("does not let an older staging failure restore a preview superseded by a newer proposal", async () => {
    let rejectOlder: ((error: Error) => void) | undefined;
    let olderReceived: (() => void) | undefined;
    const notifications: Array<{ intent: string; status: string }> = [];
    const service = new AgentSessionService((proposal, requireReceipt) => {
      notifications.push({ intent: proposal.intent, status: proposal.status });
      if (requireReceipt && proposal.intent === "Older pending preview") {
        olderReceived?.();
        return new Promise<void>((_resolve, reject) => { rejectOlder = reject; });
      }
    }, () => null);
    service.publishSnapshot(snapshot());
    const original: any = await service.request({ method: "plan_path", params: {
      intent: "Original preview", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 2, y: 1 }], maximumCandidates: 1,
    } });

    const received = new Promise<void>((resolve) => { olderReceived = resolve; });
    const older = service.request({ method: "plan_path", params: {
      intent: "Older pending preview", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 3, y: 1 }], maximumCandidates: 1,
    } });
    const olderRejected = expect(older).rejects.toThrow("renderer rejected older preview");
    await received;
    const newest: any = await service.request({ method: "plan_path", params: {
      intent: "Newest preview", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 2.5, y: 1 }], maximumCandidates: 1,
    } });
    rejectOlder?.(new Error("renderer rejected older preview"));
    await olderRejected;

    expect(service.getActiveProposal()?.id).toBe(newest.proposalId);
    expect((await service.request({ method: "get_proposal", params: { proposalId: original.proposalId } }) as any).status).toBe("stale");
    expect((await service.request({ method: "get_proposal", params: { proposalId: newest.proposalId } }) as any).status).toBe("ready");
    expect(notifications.at(-1)).toEqual({ intent: "Newest preview", status: "ready" });
  });

  it.each([
    { older: "success", newer: "failure", order: "older-first" },
    { older: "failure", newer: "failure", order: "older-first" },
    { older: "cancel", newer: "failure", order: "older-first" },
    { older: "success", newer: "cancel", order: "newer-first" },
    { older: "failure", newer: "cancel", order: "newer-first" },
    { older: "cancel", newer: "cancel", order: "newer-first" },
  ] as const)("restores only the committed preview when nested staging settles $order ($older/$newer)", async ({ older, newer, order }) => {
    const olderReceipt = deferred();
    const newerReceipt = deferred();
    const olderReceived = deferred();
    const newerReceived = deferred();
    const notifications: Array<{ intent: string; status: string }> = [];
    const service = new AgentSessionService((proposal, requireReceipt) => {
      notifications.push({ intent: proposal.intent, status: proposal.status });
      if (!requireReceipt) return;
      if (proposal.intent === "Older provisional path") {
        olderReceived.resolve();
        return olderReceipt.promise;
      }
      if (proposal.intent === "Newer provisional profile") {
        newerReceived.resolve();
        return newerReceipt.promise;
      }
    }, () => null);
    service.publishSnapshot(snapshot());
    const original: any = await service.request({ method: "plan_path", params: {
      intent: "Committed preview", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 2, y: 1 }], maximumCandidates: 1,
    } });

    const olderController = new AbortController();
    const olderRequest = service.request({ method: "plan_path", params: {
      intent: "Older provisional path", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 3, y: 1 }], maximumCandidates: 1,
    } }, olderController.signal).then(
      () => ({ fulfilled: true as const }),
      (error: unknown) => ({ fulfilled: false as const, error }),
    );
    await olderReceived.promise;

    const newerController = new AbortController();
    const newerRequest = service.request({ method: "propose_robot_profile", params: {
      intent: "Newer provisional profile",
      planning: { intake: { name: "Front intake", centerM: { x: 0.42, y: 0 }, directionDeg: 0, captureWidthM: 0.72, maxCollectSpeedMps: 2 } },
    } }, newerController.signal).then(
      () => ({ fulfilled: true as const }),
      (error: unknown) => ({ fulfilled: false as const, error }),
    );
    await newerReceived.promise;

    const settleOlder = () => {
      if (older === "success") olderReceipt.resolve();
      else if (older === "failure") olderReceipt.reject(new Error("older receipt rejected"));
      else olderController.abort();
    };
    const settleNewer = () => {
      if (newer === "failure") newerReceipt.reject(new Error("newer receipt rejected"));
      else newerController.abort();
    };
    if (order === "older-first") {
      settleOlder();
      expect((await olderRequest).fulfilled).toBe(false);
      settleNewer();
    } else {
      settleNewer();
      expect((await newerRequest).fulfilled).toBe(false);
      settleOlder();
    }
    expect((await olderRequest).fulfilled).toBe(false);
    expect((await newerRequest).fulfilled).toBe(false);
    olderReceipt.resolve();
    newerReceipt.resolve();

    expect(service.getActiveProposal()?.id).toBe(original.proposalId);
    expect((await service.request({ method: "get_proposal", params: { proposalId: original.proposalId } }) as any).status).toBe("ready");
    expect(notifications.at(-1)).toEqual({ intent: "Committed preview", status: "ready" });
  });

  it("does not let an already-canceled proposal invalidate pending staging", async () => {
    const pendingReceipt = deferred();
    const pendingReceived = deferred();
    const notifications: string[] = [];
    const service = new AgentSessionService((proposal, requireReceipt) => {
      notifications.push(proposal.intent);
      if (requireReceipt && proposal.intent === "Pending valid preview") {
        pendingReceived.resolve();
        return pendingReceipt.promise;
      }
    }, () => null);
    service.publishSnapshot(snapshot());
    await service.request({ method: "plan_path", params: {
      intent: "Committed preview", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 2, y: 1 }], maximumCandidates: 1,
    } });

    const pending = service.request({ method: "plan_path", params: {
      intent: "Pending valid preview", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 3, y: 1 }], maximumCandidates: 1,
    } });
    await pendingReceived.promise;
    const controller = new AbortController();
    controller.abort();

    await expect(service.request({ method: "propose_robot_profile", params: {
      intent: "Canceled robot profile",
      planning: { intake: { name: "Front intake", centerM: { x: 0.42, y: 0 }, directionDeg: 0, captureWidthM: 0.72, maxCollectSpeedMps: 2 } },
    } }, controller.signal)).rejects.toThrow("Agent request was canceled");
    pendingReceipt.resolve();
    const result: any = await pending;

    expect(service.getActiveProposal()?.id).toBe(result.proposalId);
    expect(notifications).not.toContain("Canceled robot profile");
    expect(notifications.at(-1)).toBe("Pending valid preview");
  });

  it("preserves the committed rollback preview when failed proposals exceed history capacity", async () => {
    const notifications: Array<{ intent: string; status: string }> = [];
    const service = new AgentSessionService((proposal, requireReceipt) => {
      notifications.push({ intent: proposal.intent, status: proposal.status });
      if (requireReceipt && proposal.intent.startsWith("Failed preview")) throw new Error("renderer rejected preview");
    }, () => null);
    service.publishSnapshot(snapshot());
    const committed: any = await service.request({ method: "plan_path", params: {
      intent: "Committed preview", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 2, y: 1 }], maximumCandidates: 1,
    } });

    for (let index = 0; index < 30; index += 1) {
      await expect(service.request({ method: "plan_path", params: {
        intent: `Failed preview ${index}`, alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 3, y: 1 }], maximumCandidates: 1,
      } })).rejects.toThrow("renderer rejected preview");
    }

    expect(service.getActiveProposal()?.id).toBe(committed.proposalId);
    expect((await service.request({ method: "get_proposal", params: { proposalId: committed.proposalId } }) as any).status).toBe("ready");
    expect(notifications.at(-1)).toEqual({ intent: "Committed preview", status: "ready" });
  });

  it("keeps only the newest proposal ready for the single preview surface", async () => {
    const service = new AgentSessionService(() => {}, () => null);
    service.publishSnapshot(snapshot());
    const first: any = await service.request({ method: "plan_path", params: { intent: "First", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 2, y: 1 }], maximumCandidates: 1 } });
    const second: any = await service.request({ method: "plan_path", params: { intent: "Second", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 3, y: 1 }], maximumCandidates: 1 } });
    expect(second.status).toBe("ready");
    expect(second.supersededProposalId).toBe(first.proposalId);
    expect((await service.request({ method: "get_proposal", params: { proposalId: first.proposalId } }) as any).status).toBe("stale");
  });

  it("interviews for missing robot facts and stages profile answers without mutating the snapshot", async () => {
    const staged: any[] = [];
    const service = new AgentSessionService((proposal) => { staged.push(proposal); }, () => null);
    const initial = snapshot();
    service.publishSnapshot(initial);
    const inspection: any = await service.request({ method: "inspect_robot_profile" });
    expect(inspection.completeForFuelCollection).toBe(false);
    expect(inspection.questions.join(" ")).toContain("maximum safe collection speed");
    const planning = {
      intake: { name: "Front intake", centerM: { x: 0.42, y: 0 }, directionDeg: 0, captureWidthM: 0.72, maxCollectSpeedMps: 2 },
      shooter: { directionDeg: 0, requiresTargetFacing: true, preferredRangeM: 2.5 },
      notes: "Keep the intake down throughout the collection span.",
    };
    const proposal: any = await service.request({ method: "propose_robot_profile", params: { intent: "Use the team's mechanism details", planning } });
    expect(proposal).toMatchObject({ operation: "configureRobot", status: "ready", recommendedCandidate: null });
    expect(staged).toHaveLength(1);
    expect(staged[0].planning).toEqual(planning);
    expect(initial.project.robot.planning).toBeUndefined();
    service.publishSnapshot({ ...initial, revision: 1 });
    expect((await service.request({ method: "get_proposal", params: { proposalId: proposal.proposalId } }) as any).status).toBe("stale");
  });

  it("keeps a newer robot-profile proposal ahead of a non-cooperative older path request", async () => {
    let pathStarted: (() => void) | undefined;
    let finishPath: ((value: unknown) => void) | undefined;
    const started = new Promise<void>((resolve) => { pathStarted = resolve; });
    const notifications: string[] = [];
    const service = new AgentSessionService((proposal) => { notifications.push(proposal.intent); }, () => null, (job) => {
      if (job.kind !== "route") return runAgentPlanningJobDirect(job);
      pathStarted?.();
      return new Promise((resolve) => { finishPath = resolve; });
    });
    service.publishSnapshot(snapshot());

    const olderPath = service.request({ method: "plan_path", params: {
      intent: "Older path preview", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 3, y: 1 }], maximumCandidates: 1,
    } });
    const olderRejected = expect(olderPath).rejects.toThrow("Agent planning was canceled");
    await started;
    const profile: any = await service.request({ method: "propose_robot_profile", params: {
      intent: "Newer robot profile",
      planning: { intake: { name: "Front intake", centerM: { x: 0.42, y: 0 }, directionDeg: 0, captureWidthM: 0.72, maxCollectSpeedMps: 2 } },
    } });
    finishPath?.([]);
    await olderRejected;

    expect(profile).toMatchObject({ status: "ready", operation: "configureRobot" });
    expect(service.getActiveProposal()?.id).toBe(profile.proposalId);
    expect(notifications.at(-1)).toBe("Newer robot profile");
  });

  it("merges partial robot interview answers without erasing existing mechanism facts", async () => {
    const service = new AgentSessionService(() => {}, () => null);
    const initial = snapshot();
    initial.project.robot.planning = {
      intake: { name: "Front intake", centerM: { x: 0.42, y: 0 }, directionDeg: 0, captureWidthM: 0.72, maxCollectSpeedMps: 2 },
      notes: "Keep the intake deployed while collecting.",
    };
    service.publishSnapshot(initial);
    const proposal: any = await service.request({ method: "propose_robot_profile", params: {
      intent: "Add the newly answered shooter details",
      planning: { shooter: { directionDeg: 180, requiresTargetFacing: true, preferredRangeM: 2.4 } },
    } });
    const full: any = await service.request({ method: "get_proposal", params: { proposalId: proposal.proposalId, detail: "full" } });
    expect(full.planning).toEqual({
      ...initial.project.robot.planning,
      shooter: { directionDeg: 180, requiresTargetFacing: true, preferredRangeM: 2.4 },
    });
  });

  it("binds an end action only through an explicit authoritative semantic tag", async () => {
    const catalog: any = {
      authoritative: true,
      commands: [{
        id: "robot.shoot", label: "Shoot", aliases: ["shoot"], semanticTags: ["shoot-fuel"], runtimeReady: true,
        ownerType: "robot.Actions", member: "shoot", kind: "factory", confidence: "confirmed", parameters: [], source: { file: "robot/Actions.vi", line: 1 },
      }],
      warnings: [],
    };
    const service = new AgentSessionService(() => {}, () => catalog);
    service.publishSnapshot(snapshot());
    const proposal: any = await service.request({ method: "plan_path", params: {
      intent: "Drive and shoot", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 3, y: 1 }], maximumCandidates: 1,
      endAction: { commandId: "robot.shoot", semanticTag: "shoot-fuel" },
    } });
    const fullProposal: any = await service.request({ method: "get_proposal", params: { proposalId: proposal.proposalId, detail: "full" } });
    expect(fullProposal.candidates[0].path.markers[0].invocation.commandId).toBe("robot.shoot");
    await expect(service.request({ method: "plan_path", params: {
      intent: "Drive and intake", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 3, y: 1 }], maximumCandidates: 1,
      endAction: { commandId: "robot.shoot", semanticTag: "intake-fuel" },
    } })).rejects.toThrow(/must match exactly one runtime-ready command/);

    catalog.commands.push({ ...catalog.commands[0], id: "robot.shootAlternate" });
    await expect(service.request({ method: "plan_path", params: {
      intent: "Ambiguous shoot", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 3, y: 1 }], maximumCandidates: 1,
      endAction: { commandId: "robot.shoot", semanticTag: "shoot-fuel" },
    } })).rejects.toThrow(/found 2/);

    const bound = snapshot();
    bound.project.strategy = { actionBindings: [{ semanticTag: "shoot-fuel", commandId: "robot.shootAlternate" }] };
    service.publishSnapshot(bound);
    const boundProposal: any = await service.request({ method: "plan_path", params: {
      intent: "Bound shoot", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 3, y: 1 }], maximumCandidates: 1,
      endAction: { commandId: "robot.shootAlternate", semanticTag: "shoot-fuel" },
    } });
    const fullBoundProposal: any = await service.request({ method: "get_proposal", params: { proposalId: boundProposal.proposalId, detail: "full" } });
    expect(fullBoundProposal.candidates[0].path.markers[0].invocation.commandId).toBe("robot.shootAlternate");
  });

  it("stales an end-action proposal when the bound command is removed from the catalog", async () => {
    let catalog = authoritativeCatalog();
    const notifications: Array<{ id: string; status: string }> = [];
    const service = new AgentSessionService((item) => { notifications.push({ id: item.id, status: item.status }); }, () => catalog);
    service.publishSnapshot(snapshot());
    const proposal: any = await service.request({ method: "plan_path", params: {
      intent: "Drive and shoot", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 3, y: 1 }], maximumCandidates: 1,
      endAction: { commandId: "robot.shoot", semanticTag: "shoot-fuel" },
    } });

    catalog = authoritativeCatalog([]);
    service.refreshRobotCatalog();

    expect(service.getActiveProposal()).toBeNull();
    expect(await service.request({ method: "get_proposal", params: { proposalId: proposal.proposalId } })).toMatchObject({ status: "stale" });
    expect(notifications.at(-1)).toEqual({ id: proposal.proposalId, status: "stale" });
  });

  it("does not trust a stale supplied fingerprint after catalog semantics change", async () => {
    const staleFingerprint = `sha256:${"f".repeat(64)}`;
    let catalog = { ...authoritativeCatalog(), semanticFingerprint: staleFingerprint };
    const service = new AgentSessionService(() => {}, () => catalog);
    service.publishSnapshot(snapshot());
    const proposal: any = await service.request({ method: "plan_path", params: {
      intent: "Drive and shoot", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 3, y: 1 }], maximumCandidates: 1,
      endAction: { commandId: "robot.shoot", semanticTag: "shoot-fuel" },
    } });

    catalog = { ...authoritativeCatalog([]), semanticFingerprint: staleFingerprint };

    expect(service.getActiveProposal()).toBeNull();
    expect(await service.request({ method: "get_proposal", params: { proposalId: proposal.proposalId } })).toMatchObject({ status: "stale" });
  });

  it("stales an end-action proposal when the bound command argument schema changes", async () => {
    const parameter = {
      name: "speed", label: "Speed", valueType: "DBL", role: "argument" as const,
      defaultValue: 1, min: 0, max: 10, schema: { kind: "number" as const, valueType: "DBL" },
    };
    let catalog = authoritativeCatalog([shootCommand({ parameters: [parameter] })]);
    const service = new AgentSessionService(() => {}, () => catalog);
    service.publishSnapshot(snapshot());
    const proposal: any = await service.request({ method: "plan_path", params: {
      intent: "Drive and shoot at speed", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 3, y: 1 }], maximumCandidates: 1,
      endAction: { commandId: "robot.shoot", semanticTag: "shoot-fuel" },
    } });

    catalog = authoritativeCatalog([shootCommand({ parameters: [{ ...parameter, max: 5 }] })]);

    expect(service.getActiveProposal()).toBeNull();
    expect(await service.request({ method: "get_proposal", params: { proposalId: proposal.proposalId } })).toMatchObject({ status: "stale" });
  });

  it("keeps an end-action proposal ready across a semantically identical catalog refresh", async () => {
    const alternate = shootCommand({ id: "robot.intake", label: "Intake", aliases: ["collect", "intake"], semanticTags: ["intake-fuel"] });
    let catalog = authoritativeCatalog([shootCommand({ aliases: ["fire", "shoot"], semanticTags: ["score", "shoot-fuel"] }), alternate]);
    const service = new AgentSessionService(() => {}, () => catalog);
    service.publishSnapshot(snapshot());
    const proposal: any = await service.request({ method: "plan_path", params: {
      intent: "Drive and shoot", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 3, y: 1 }], maximumCandidates: 1,
      endAction: { commandId: "robot.shoot", semanticTag: "shoot-fuel" },
    } });

    catalog = {
      ...authoritativeCatalog([alternate, shootCommand({ aliases: ["shoot", "fire"], semanticTags: ["shoot-fuel", "score"] })]),
      scannedAt: "2026-08-10T01:00:00.000Z",
      catalogHash: `sha256:${"b".repeat(64)}`,
    };

    expect(service.getActiveProposal()?.id).toBe(proposal.proposalId);
  });

  it("rejects an end-action proposal when the catalog changes during renderer receipt", async () => {
    let catalog = authoritativeCatalog();
    const receipt = deferred();
    let received = false;
    const service = new AgentSessionService((_proposal, requireReceipt) => {
      if (!requireReceipt) return;
      received = true;
      return receipt.promise;
    }, () => catalog);
    service.publishSnapshot(snapshot());
    const pending = service.request({ method: "plan_path", params: {
      intent: "Drive and shoot", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 3, y: 1 }], maximumCandidates: 1,
      endAction: { commandId: "robot.shoot", semanticTag: "shoot-fuel" },
    } });
    await vi.waitFor(() => expect(received).toBe(true));

    catalog = authoritativeCatalog([]);
    receipt.resolve();

    await expect(pending).rejects.toThrow(/catalog|session changed/i);
    expect(service.getActiveProposal()).toBeNull();
  });

  it("preserves an unbound shooting request without blocking valid geometry", async () => {
    const service = new AgentSessionService(() => {}, () => null);
    service.publishSnapshot(snapshot());
    const proposal: any = await service.request({ method: "plan_path", params: {
      intent: "Drive and shoot", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 3, y: 1 }], maximumCandidates: 1,
      endActionIntent: { semanticTag: "shoot-fuel", description: "shoot into the HUB" },
    } });
    expect(proposal.blockingIssues).toBeUndefined();
    expect(proposal.advisories).toEqual([expect.stringContaining("shoot-fuel")]);
    const full: any = await service.request({ method: "get_proposal", params: { proposalId: proposal.proposalId, detail: "full" } });
    expect(full.candidates[0].path.markers).toEqual([expect.objectContaining({
      f: 1,
      cmd: "none",
      actionIntent: { semanticTag: "shoot-fuel", description: "shoot into the HUB" },
    })]);
  });

  it("requires an explicit shooting target when the robot profile requires target-facing alignment", async () => {
    const service = new AgentSessionService(() => {}, () => null);
    const initial = snapshot();
    initial.project.robot.planning = { shooter: { directionDeg: 0, requiresTargetFacing: true } };
    service.publishSnapshot(initial);
    const outcome: any = await service.request({ method: "plan_path", params: {
      intent: "Drive and shoot", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 3, y: 1 }], maximumCandidates: 1,
      endActionIntent: { semanticTag: "shoot-fuel", description: "shoot into the HUB" },
    } });
    expect(outcome).toMatchObject({ status: "needs_input", code: "TARGET_FACING_REQUIRED" });
  });

  it("authenticates a user-private framed IPC request", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-agent-test-"));
    const alternateTmp = await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-client-tmp-"));
    const originalTmp = process.env.TMPDIR;
    const service = new AgentSessionService(() => {}, () => null);
    service.publishSnapshot(snapshot());
    const server = new AgentBridgeServer(directory, service);
    try {
      await server.start();
      process.env.TMPDIR = alternateTmp;
      const result: any = await new AgentBridgeClient(directory).request({ method: "inspect_session" });
      expect(result.sessionId).toBe("session_test");
    } finally {
      if (originalTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmp;
      await server.stop();
      await fs.rm(directory, { recursive: true, force: true });
      await fs.rm(alternateTmp, { recursive: true, force: true });
    }
  });

  it("does not let an older bridge remove the active runtime descriptor", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-agent-owner-test-"));
    const service = new AgentSessionService(() => {}, () => null);
    service.publishSnapshot(snapshot());
    const older = new AgentBridgeServer(directory, service);
    const active = new AgentBridgeServer(directory, service);
    try {
      await older.start();
      await active.start();
      await older.stop();

      const result: any = await new AgentBridgeClient(directory).request({ method: "inspect_session" });
      expect(result.sessionId).toBe("session_test");
    } finally {
      await older.stop();
      await active.stop();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("closes accepted sockets when descriptor publication fails", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-agent-startup-test-"));
    const service = new AgentSessionService(() => {}, () => null);
    const server = new AgentBridgeServer(directory, service);
    const clients: net.Socket[] = [];
    const rename = vi.spyOn(fs, "rename").mockImplementation(async (source) => {
      const descriptor = JSON.parse(await fs.readFile(source, "utf8"));
      const client = net.createConnection(descriptor.endpoint);
      clients.push(client);
      client.on("error", () => {});
      await new Promise<void>((resolve) => client.once("connect", resolve));
      throw new Error("descriptor publication failed");
    });
    try {
      await expect(server.start()).rejects.toThrow("descriptor publication failed");
      expect(server.enabled).toBe(false);
    } finally {
      rename.mockRestore();
      clients.forEach((client) => client.destroy());
      await server.stop();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("streams a schema-sized repair resource across bounded bridge frames", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-agent-large-test-"));
    const service = new AgentSessionService(() => {}, () => null);
    const project = createDemoProject();
    const authoredPath = structuredClone(project.paths[0]);
    authoredPath.id = "path_large";
    authoredPath.name = "Large";
    authoredPath.waypoints = Array.from({ length: 4_096 }, () => structuredClone(authoredPath.waypoints[0]));
    project.paths = [authoredPath];
    project.editor = { ...project.editor, activePathId: authoredPath.id };
    expect(validateProject(project).ok).toBe(true);
    const analysis = {
      pathId: authoredPath.id, pathName: authoredPath.name, authoredPath, planner: "profiledSpline" as const,
      totalTimeS: null, totalDistanceM: null, sampleCount: 0, samplesTruncated: false,
      rawSamples: [], extrema: [], findings: [], plannerDiagnostics: [],
    };
    const resource: RepairCandidate = {
      id: "repair_large", label: "Large repair", path: authoredPath, targetFindingIds: [],
      before: analysis, after: analysis, changedFields: [], valid: true,
    };
    expect(Buffer.byteLength(JSON.stringify(resource))).toBeGreaterThan(1024 * 1024);
    vi.spyOn(service, "request").mockResolvedValue(resource);
    const server = new AgentBridgeServer(directory, service);
    try {
      await server.start();
      const result: any = await new AgentBridgeClient(directory).request({ method: "inspect_session" });
      expect(result.path.waypoints).toHaveLength(4_096);
      expect(result.before.authoredPath.waypoints).toHaveLength(4_096);
    } finally {
      await server.stop();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("does not open a bridge request when cancellation arrives during descriptor I/O", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-agent-cancel-test-"));
    const service = new AgentSessionService(() => {}, () => null);
    service.publishSnapshot(snapshot());
    const requestSpy = vi.spyOn(service, "request");
    const server = new AgentBridgeServer(directory, service);
    try {
      await server.start();
      const controller = new AbortController();
      const pending = new AgentBridgeClient(directory).request({ method: "inspect_session" }, controller.signal);
      controller.abort();

      await expect(pending).rejects.toThrow("Agent request was canceled");
      await new Promise((resolve) => setImmediate(resolve));
      expect(requestSpy).not.toHaveBeenCalled();
    } finally {
      requestSpy.mockRestore();
      await server.stop();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("settles the response read when a bridge request write fails", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-agent-write-test-"));
    const endpoint = path.join(os.tmpdir(), `bordeaux-mcp-w-${path.basename(directory).slice(-6)}.sock`);
    const transport = net.createServer((socket) => socket.destroy());
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    try {
      await new Promise<void>((resolve, reject) => {
        transport.once("error", reject);
        transport.listen(endpoint, () => { transport.off("error", reject); resolve(); });
      });
      await fs.chmod(endpoint, 0o600);
      await fs.mkdir(path.join(directory, "mcp"), { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(directory, "mcp", "runtime-v1.json"), JSON.stringify({
        schemaVersion: 1,
        protocolVersion: 1,
        pid: process.pid,
        createdAt: new Date().toISOString(),
        instanceId: "write-failure-test",
        endpoint,
        token: "write-failure-test-token",
      }), { mode: 0o600 });
      process.on("unhandledRejection", onUnhandled);

      const largeRequest = { method: "inspect_session" as const, padding: "x".repeat(32 * 1024 * 1024) };
      const request = new AgentBridgeClient(directory).request(largeRequest);
      await expect(request).rejects.toThrow();
      await new Promise((resolve) => setImmediate(resolve));

      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await new Promise<void>((resolve) => transport.close(() => resolve()));
      await fs.rm(endpoint, { force: true });
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
