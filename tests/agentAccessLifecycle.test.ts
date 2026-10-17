import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSessionService } from "../src/electron/agentSession";
// @ts-expect-error The renderer session sync is JavaScript.
import { createAgentSessionSync } from "../src/renderer/lib/agentSessionSync";
import { createDemoProject } from "../src/shared/project/defaults";

function editorSnapshot(revision: number, accessGeneration: number, project = createDemoProject()) {
  return {
    sessionId: "session_editor",
    revision,
    accessGeneration,
    project,
    activePathId: project.paths[0].id,
    allianceView: "blue" as const,
    fieldPack: { id: "2026-rebuilt" as const, revision: "test" },
  };
}

function editorSync(forward?: (snapshot: any) => unknown) {
  const send = vi.fn((snapshot: any) => forward?.(snapshot));
  const project = createDemoProject();
  const materialized = { ...project };
  const events = new EventTarget();
  const onPublish = vi.fn();
  const onAccessChange = vi.fn();
  const sync = createAgentSessionSync({
    send,
    sessionId: "session_editor",
    capture: () => ({ project, materialized, activePathId: project.paths[0].id, editRevision: 3 }),
    onPublish,
    onAccessChange,
    events,
  });
  return { sync, send, project, materialized, events, onPublish, onAccessChange };
}

afterEach(() => { vi.useRealTimers(); });

describe("main-process agent access periods", () => {
  it("ignores editor snapshots while access is off", async () => {
    const service = new AgentSessionService(() => {}, () => null);
    const disabled = service.resetAccess(false);

    expect(service.publishEditorSnapshot(editorSnapshot(0, disabled.generation))).toBe("ignored");
    await expect(service.request({ method: "inspect_session" })).rejects.toThrow(/finish loading/);
  });

  it("reports the editor unavailable until it publishes for the new period, never reusing an earlier snapshot", async () => {
    const service = new AgentSessionService(() => {}, () => null);
    const first = service.resetAccess(true);
    expect(service.publishEditorSnapshot(editorSnapshot(0, first.generation))).toBe("published");
    expect(await service.request({ method: "inspect_session" })).toMatchObject({ revision: 0 });

    service.resetAccess(false);
    const second = service.resetAccess(true);
    await expect(service.request({ method: "inspect_session" })).rejects.toThrow(/finish loading/);
    // A snapshot sent during the earlier period arrives late.
    expect(service.publishEditorSnapshot(editorSnapshot(1, first.generation))).toBe("ignored");
    await expect(service.request({ method: "inspect_session" })).rejects.toThrow(/finish loading/);

    expect(service.publishEditorSnapshot(editorSnapshot(2, second.generation))).toBe("published");
    expect(await service.request({ method: "inspect_session" })).toMatchObject({ revision: 2 });
    // Invalid data from a retired access period cannot retire current evidence.
    expect(service.publishEditorSnapshot({ ...editorSnapshot(3, first.generation), activePathId: "missing" })).toBe("ignored");
    expect(await service.request({ method: "inspect_session" })).toMatchObject({ revision: 2 });
    expect(service.publishEditorSnapshot({ ...editorSnapshot(3, second.generation), activePathId: "missing" })).toBe("invalid");
    await expect(service.request({ method: "inspect_session" })).rejects.toThrow(/finish loading/);
    expect(service.publishEditorSnapshot(null)).toBe("invalid");
  });

  it("cancels in-flight planning and stales ready proposals when access is turned off", async () => {
    let aborted = false;
    const service = new AgentSessionService(() => {}, () => null, (_job, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true });
    }));
    const access = service.resetAccess(true);
    service.publishEditorSnapshot(editorSnapshot(0, access.generation));
    const analysis = service.request({ method: "analyze_path", params: {} });
    await Promise.resolve();

    service.resetAccess(false);

    await expect(analysis).rejects.toThrow();
    expect(aborted).toBe(true);
    expect(service.accessStatus()).toEqual({ enabled: false, generation: access.generation + 1 });
  });

  it("does not revive a proposal from an earlier period", async () => {
    const service = new AgentSessionService(() => {}, () => null);
    const first = service.resetAccess(true);
    const published = editorSnapshot(0, first.generation);
    service.publishEditorSnapshot(published);
    const proposal: any = await service.request({ method: "plan_path", params: {
      intent: "Go", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 3, y: 1 }], maximumCandidates: 1,
    } });
    expect(service.getActiveProposal()?.id).toBe(proposal.proposalId);

    const second = service.resetAccess(true);
    service.publishEditorSnapshot({ ...published, accessGeneration: second.generation });

    expect(service.getActiveProposal()).toBeNull();
    expect((await service.request({ method: "get_proposal", params: { proposalId: proposal.proposalId } }) as any).status).toBe("stale");
  });
});

describe("renderer agent session sync", () => {
  it("does no snapshot work while access is off", () => {
    vi.useFakeTimers();
    const { sync, send, onAccessChange } = editorSync();
    sync.setAccess({ enabled: false, generation: 1 });
    const cancel = sync.schedule();
    vi.advanceTimersByTime(1000);
    cancel();

    expect(send).not.toHaveBeenCalled();
    expect(sync.published()).toBeNull();
    expect(onAccessChange).toHaveBeenCalledWith(false);
  });

  it("publishes the current editor state as soon as access turns on, without a JSON copy", () => {
    const { sync, send, project, materialized, onPublish } = editorSync();
    sync.setAccess({ enabled: true, generation: 4 });

    expect(send).toHaveBeenCalledOnce();
    const sent = send.mock.calls[0][0];
    expect(sent).toMatchObject({ sessionId: "session_editor", revision: 0, accessGeneration: 4, activePathId: project.paths[0].id, allianceView: "blue" });
    expect(sent.project).toBe(materialized);
    expect(sync.published()).toEqual({ revision: 0, project, activePathId: project.paths[0].id, editRevision: 3 });
    expect(onPublish).toHaveBeenCalledWith(0);
  });

  it("debounces edits and flushes on pointer release while enabled", () => {
    vi.useFakeTimers();
    const { sync, send, events } = editorSync();
    sync.setAccess({ enabled: true, generation: 1 });
    send.mockClear();

    const cancel = sync.schedule();
    events.dispatchEvent(new Event("pointerup"));
    vi.advanceTimersByTime(500);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0].revision).toBe(1);
    cancel();

    sync.schedule()();
    vi.advanceTimersByTime(500);
    expect(send).toHaveBeenCalledOnce();
  });

  it("forgets the published context on disable and drops a publish scheduled before it", () => {
    vi.useFakeTimers();
    const { sync, send, onAccessChange } = editorSync();
    sync.setAccess({ enabled: true, generation: 1 });
    sync.schedule();
    sync.setAccess({ enabled: false, generation: 2 });
    vi.advanceTimersByTime(500);

    expect(send).toHaveBeenCalledOnce();
    expect(sync.published()).toBeNull();
    expect(onAccessChange.mock.calls).toEqual([[true], [false]]);
  });

  it("ignores out-of-order status replies and repeats", () => {
    const { sync, send, onAccessChange } = editorSync();
    sync.setAccess({ enabled: true, generation: 3 });
    sync.setAccess({ enabled: false, generation: 2 });
    sync.setAccess({ enabled: true, generation: 3 });
    expect(sync.enabled()).toBe(true);
    expect(onAccessChange).toHaveBeenCalledOnce();

    sync.setAccess({ enabled: false, generation: 4 });
    sync.setAccess({ enabled: true, generation: 5 });
    expect(send.mock.calls.map(([snapshot]) => [snapshot.revision, snapshot.accessGeneration])).toEqual([[0, 3], [1, 5]]);
  });

  it("round-trips through the main-process gate across rapid toggles", async () => {
    const service = new AgentSessionService(() => {}, () => null);
    const { sync } = editorSync((snapshot) => service.publishEditorSnapshot(snapshot));
    sync.setAccess(service.resetAccess(true));
    const stale = service.accessStatus();
    sync.setAccess(service.resetAccess(false));
    const current = service.resetAccess(true);
    // The renderer has not heard about the latest period yet.
    sync.setAccess(stale);
    await expect(service.request({ method: "inspect_session" })).rejects.toThrow(/finish loading/);

    sync.setAccess(current);
    expect(await service.request({ method: "inspect_session" })).toMatchObject({ revision: sync.revision() });
  });
});
