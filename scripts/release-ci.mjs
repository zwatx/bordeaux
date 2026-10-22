import { appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workflowPath = ".github/workflows/ci.yml";

export function matchesReleaseCommit(run, repository, sha) {
  return run.head_sha === sha && run.head_branch === "main" && run.event === "push"
    && run.path === workflowPath && run.repository?.full_name?.toLowerCase() === repository.toLowerCase()
    && run.head_repository?.full_name?.toLowerCase() === repository.toLowerCase();
}

// Only main push CI is reusable. PR merge refs, other workflows and older commits
// cannot authorize a release. No downloads or executable artifacts cross runs.
export async function findReleaseCi({ request, repository, sha }) {
  const query = new URLSearchParams({ head_sha: sha, branch: "main", event: "push", per_page: "100" });
  const result = await request(`/repos/${repository}/actions/workflows/ci.yml/runs?${query}`);
  const runs = result.workflow_runs.filter((run) => matchesReleaseCommit(run, repository, sha));
  return runs.sort((a, b) => b.id - a.id)[0]?.id ?? "";
}

export async function requireReleaseCi({ request, repository, sha, runId,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), maxPolls = 80 }) {
  if (!/^\d+$/.test(String(runId))) throw new Error("Invalid CI run ID");
  for (let poll = 0; poll < maxPolls; poll += 1) {
    const run = await request(`/repos/${repository}/actions/runs/${runId}`);
    if (!matchesReleaseCommit(run, repository, sha)) throw new Error("CI run identity does not match the release commit");
    if (run.status === "completed") {
      if (run.conclusion !== "success") throw new Error(`Main CI ${runId} concluded ${run.conclusion}; release blocked`);
      return run;
    }
    if (poll + 1 < maxPolls) await wait(15_000);
  }
  throw new Error(`Timed out waiting for main CI ${runId}; release blocked`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { GITHUB_REPOSITORY: repository, GITHUB_SHA: sha, GH_TOKEN: token } = process.env;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "") || !/^[a-f\d]{40}$/.test(sha ?? "") || !token) {
    throw new Error("Release CI requires repository, full commit SHA and Actions read token");
  }
  const request = async (endpoint) => {
    const response = await fetch(`https://api.github.com${endpoint}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`CI API request failed: HTTP ${response.status}`);
    return response.json();
  };
  if (process.argv[2] === "find") {
    const runId = await findReleaseCi({ request, repository, sha });
    await appendFile(process.env.GITHUB_OUTPUT, `run-id=${runId}\n`);
    console.log(runId ? `Reusing main CI run ${runId} for ${sha}` : `No main push CI for ${sha}; full CI will run here`);
  } else if (process.argv[2] === "require") {
    const run = await requireReleaseCi({ request, repository, sha, runId: process.env.CI_RUN_ID });
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `Main CI passed for release commit ${sha}: ${run.html_url}\n`);
    console.log(`Verified main CI ${run.id} for ${sha}`);
  } else {
    throw new Error("Usage: release-ci.mjs find|require");
  }
}
