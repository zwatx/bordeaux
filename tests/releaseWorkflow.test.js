import { readFileSync } from "node:fs";
import vm from "node:vm";
import yaml from "js-yaml";
import { expect, it } from "vitest";

const workflow = (name) => yaml.load(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8"));

it("publishes only after validation, every package, and one complete CI route succeed", () => {
  const beta = workflow("prerelease");
  expect(beta.jobs.build.needs).toBe("validate");
  expect(new Set(beta.jobs.publish.needs)).toEqual(new Set(["validate", "build", "ci", "verified-ci"]));
  const expression = beta.jobs.publish.if.trim().replace(/^\$\{\{\s*|\s*\}\}$/g, "")
    .replace(/needs\.([\w-]+)/g, (_match, job) => `needs[${JSON.stringify(job)}]`);
  const states = ["success", "failure", "cancelled", "skipped"];
  for (const validate of states) for (const build of states) for (const ci of states) for (const reused of states) {
    const needs = { validate: { result: validate }, build: { result: build }, ci: { result: ci }, "verified-ci": { result: reused } };
    for (const cancelled of [true, false]) {
      const allowed = vm.runInNewContext(expression, { needs, always: () => true, cancelled: () => cancelled });
      expect(allowed, JSON.stringify({ validate, build, ci, reused, cancelled })).toBe(
        !cancelled && validate === "success" && build === "success" && (ci === "success" || reused === "success"),
      );
    }
  }
  expect(beta.jobs.ci.uses).toBe("./.github/workflows/ci.yml");
  expect(beta.jobs.ci.if).toBe("needs.validate.outputs.ci-run-id == ''");
  expect(beta.jobs["verified-ci"].if).toBe("needs.validate.outputs.ci-run-id != ''");
  expect(beta.permissions.actions).toBe("read");
});

it("keeps all platform artifacts and verification before uploads in both release flows", () => {
  for (const name of ["prerelease", "package"]) {
    const release = workflow(name), job = release.jobs[name === "package" ? "package" : "build"];
    expect(job.strategy.matrix.include.map(({ platform }) => platform)).toEqual(["mac", "windows", "linux"]);
    const upload = job.steps.findIndex(({ uses }) => uses === "actions/upload-artifact@v7");
    const beforeUpload = job.steps.slice(0, upload).map(({ run }) => run ?? "").join("\n");
    for (const command of ["verify:package", "verify-update-manifest.mjs linux-arm64", "verify-release-signatures.mjs mac", "verify-release-signatures.mjs windows", "notarize-release-dmgs.mjs", "block return out quick proto udp from any to any port 443"]) {
      expect(beforeUpload).toContain(command);
    }
    expect(job.steps[upload].with["if-no-files-found"]).toBe("error");
    expect(release.jobs.publish.needs).toContain(name === "package" ? "package" : "build");
  }
});

it("keeps required CI job identities, all shards, and all desktop scripts", () => {
  const ci = workflow("ci");
  expect(Object.keys(ci.jobs)).toEqual(["checks", "unit", "desktop"]);
  expect(ci.jobs.unit.strategy.matrix.shard).toEqual([1, 2, 3, 4]);
  const groups = ci.jobs.desktop.strategy.matrix.include;
  expect(groups.map(({ group }) => group)).toEqual(["library", "planning", "workflows"]);
  const desktopScripts = groups.flatMap(({ checks }) => checks.trim().split("\n"));
  expect(desktopScripts).toHaveLength(23);
  expect(new Set(desktopScripts).size).toBe(23);
  expect(desktopScripts).toContain("scripts/verify-key-bindings.mjs");
  expect(ci.jobs.desktop.env.BORDEAUX_KEY_BINDINGS_OUTPUT).toBe(".ui-artifacts/key-bindings");
  expect(desktopScripts).toContain("scripts/verify-rotation-focus-ui.mjs");
  expect(desktopScripts).toContain("scripts/verify-routine-scrubber-ui.mjs");
  expect(ci.jobs.desktop.env.BORDEAUX_ROTATION_FOCUS_UI_OUTPUT).toBe(".ui-artifacts/rotation-focus");
  expect(ci.jobs.desktop.env.BORDEAUX_ROUTINE_SCRUBBER_UI_OUTPUT).toBe(".ui-artifacts/routine-scrubber");
  expect(desktopScripts).toContain("scripts/verify-notification-ui.mjs");
  expect(ci.jobs.desktop.env.BORDEAUX_NOTIFICATION_UI_OUTPUT).toBe(".ui-artifacts/notifications");
  expect(desktopScripts).toContain("scripts/verify-systemcore-web.mjs");
  expect(ci.jobs.desktop.env.BORDEAUX_SYSTEMCORE_OUTPUT).toBe(".ui-artifacts/systemcore");
  expect(desktopScripts).toContain("scripts/verify-command-search-ui.mjs");
  expect(ci.jobs.desktop.env.BORDEAUX_COMMAND_SEARCH_UI_OUTPUT).toBe(".ui-artifacts/command-search");
  expect(desktopScripts).toContain("scripts/verify-editor-interactions.mjs");
  expect(desktopScripts).toContain("scripts/verify-windows-chrome.mjs");
  expect(desktopScripts).toContain("scripts/verify-robot-electrical-ui.mjs");
  expect(desktopScripts).toContain("scripts/verify-timeline-commands-ui.mjs");
  expect(ci.jobs.desktop.env.BORDEAUX_TIMELINE_COMMANDS_UI_OUTPUT).toBe(".ui-artifacts/timeline-commands");
  const checks = ci.jobs.checks.steps.map(({ run }) => run ?? "").join("\n");
  for (const command of ["verify:license", "typecheck", "certify-field.mjs", "npm run build", "npm run audit:dependencies"]) expect(checks).toContain(command);
  expect(ci.jobs.desktop.steps.some(({ run }) => run === "xvfb-run -a npm run test:smoke:built")).toBe(true);
});
