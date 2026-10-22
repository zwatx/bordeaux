import { describe, expect, it, vi } from "vitest";
import { findReleaseCi, matchesReleaseCommit, requireReleaseCi } from "../scripts/release-ci.mjs";

const repository = "zwatx/bordeaux", sha = "a".repeat(40);
const identity = { repository, sha };
function run(changes = {}) {
  return { id: 42, head_sha: sha, head_branch: "main", event: "push", path: ".github/workflows/ci.yml",
    repository: { full_name: repository }, head_repository: { full_name: repository },
    status: "completed", conclusion: "success", ...changes };
}

describe("release CI identity and gate", () => {
  it.each([
    { head_sha: "b".repeat(40) }, { head_branch: "feature" }, { event: "pull_request" },
    { path: ".github/workflows/other.yml" }, { repository: { full_name: "other/repo" } },
    { head_repository: { full_name: "fork/bordeaux" } }, { head_repository: null },
  ])("rejects mismatched run identity %j", async (changes) => {
    expect(matchesReleaseCommit(run(changes), repository, sha)).toBe(false);
    await expect(requireReleaseCi({ ...identity, runId: 42, request: async () => run(changes) })).rejects.toThrow(/identity/);
  });

  it("uses the newest matching run, never an older success in preference to a failed rerun", async () => {
    const request = vi.fn(async () => ({ workflow_runs: [run(), run({ id: 43, conclusion: "failure" }), run({ id: 44, head_sha: "b".repeat(40) })] }));
    expect(await findReleaseCi({ ...identity, request })).toBe(43);
    expect(request.mock.calls[0][0]).toContain(`head_sha=${sha}&branch=main&event=push`);
  });

  it("selects full local CI when no eligible main push run exists", async () => {
    expect(await findReleaseCi({ ...identity, request: async () => ({ workflow_runs: [run({ event: "workflow_dispatch" })] }) })).toBe("");
  });

  it("waits for the selected main run and accepts only success", async () => {
    const request = vi.fn().mockResolvedValueOnce(run({ status: "queued", conclusion: null }))
      .mockResolvedValueOnce(run({ status: "in_progress", conclusion: null })).mockResolvedValueOnce(run());
    const wait = vi.fn();
    await expect(requireReleaseCi({ ...identity, runId: 42, request, wait })).resolves.toMatchObject({ id: 42 });
    expect(wait.mock.calls).toEqual([[15_000], [15_000]]);
    expect(request.mock.calls.every(([url]) => url.endsWith("/runs/42"))).toBe(true);
  });

  it.each(["failure", "cancelled", "skipped", "neutral", "timed_out", null])("blocks publication on %s", async (conclusion) => {
    await expect(requireReleaseCi({ ...identity, runId: 42, request: async () => run({ conclusion }) })).rejects.toThrow(/release blocked/);
  });

  it("bounds waiting and fails closed on API errors", async () => {
    const wait = vi.fn(), request = vi.fn(async () => run({ status: "in_progress", conclusion: null }));
    await expect(requireReleaseCi({ ...identity, runId: 42, request, wait, maxPolls: 2 })).rejects.toThrow(/Timed out/);
    expect(request).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledTimes(1);
    await expect(findReleaseCi({ ...identity, request: async () => { throw Error("HTTP 403"); } })).rejects.toThrow("HTTP 403");
    await expect(requireReleaseCi({ ...identity, runId: "42/other", request })).rejects.toThrow(/Invalid CI run ID/);
  });
});
