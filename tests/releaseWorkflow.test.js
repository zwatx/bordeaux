import { readFileSync } from "node:fs";
import vm from "node:vm";
import yaml from "js-yaml";
import { expect, it } from "vitest";

const workflow = (name) => yaml.load(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8"));

it("packages macOS DMG and ZIP targets only for Apple Silicon", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  expect(manifest.build.mac.target).toEqual([
    { target: "dmg", arch: ["arm64"] },
    { target: "zip", arch: ["arm64"] },
  ]);
  for (const name of ["package:mac", "package:mac:ci"]) {
    const macFlags = manifest.scripts[name].split(" ").filter((argument) => ["--arm64", "--x64", "--universal"].includes(argument));
    expect(macFlags).toEqual(["--arm64"]);
  }
});

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
    expect(job.steps.slice(0, upload).some(({ run, if: when }) => run === "npm run package:systemcore" && when === "matrix.platform == 'linux'")).toBe(true);
    expect(job.steps[upload].with.path).toContain("release/*.ipk");
    expect(job.steps[upload].with["if-no-files-found"]).toBe("error");
    expect(release.jobs.publish.needs).toContain(name === "package" ? "package" : "build");
  }
});

it("builds, tests and tags the beta's version commit, never the dispatched commit", () => {
  const beta = workflow("prerelease"), ci = workflow("ci");
  const releaseSha = "${{ needs.validate.outputs.sha }}", releaseVersion = "${{ needs.validate.outputs.version }}";
  expect(beta.on.workflow_dispatch.inputs.version.required).toBe(false);
  expect(beta.jobs.validate.permissions.contents).toBe("write");

  const validate = beta.jobs.validate.steps;
  const step = (id) => validate.findIndex((candidate) => candidate.id === id);
  expect(validate[step("version")].run).toBe("node scripts/resolve-prerelease-version.mjs");
  expect(validate[step("commit")].run).toContain("git push origin HEAD:refs/heads/main");
  expect(validate[step("ci")].env.RELEASE_SHA).toBe("${{ steps.commit.outputs.sha }}");
  expect(step("version")).toBeLessThan(step("commit"));
  expect(step("commit")).toBeLessThan(step("ci"));

  for (const name of ["build", "verified-ci", "publish"]) {
    const checkouts = beta.jobs[name].steps.filter(({ uses }) => uses?.startsWith("actions/checkout@"));
    expect(checkouts, name).toHaveLength(1);
    expect(checkouts[0].with?.ref, name).toBe(releaseSha);
  }
  expect(beta.jobs.ci.with.ref).toBe(releaseSha);
  expect(ci.on.workflow_call.inputs.ref.default).toBe("");
  for (const job of Object.values(ci.jobs)) {
    for (const checkout of job.steps.filter(({ uses }) => uses?.startsWith("actions/checkout@"))) expect(checkout.with.ref).toBe("${{ inputs.ref }}");
  }

  expect(beta.jobs.build.steps.find(({ run }) => run === "node scripts/verify-prerelease-version.mjs").env.RELEASE_VERSION).toBe(releaseVersion);
  expect(beta.jobs["verified-ci"].steps.find(({ run }) => run === "node scripts/release-ci.mjs require").env.RELEASE_SHA).toBe(releaseSha);
  const publish = beta.jobs.publish.steps.find(({ name }) => name === "Publish GitHub prerelease");
  expect(publish.env).toMatchObject({ RELEASE_SHA: releaseSha, RELEASE_VERSION: releaseVersion });
  // Only the resolver reads the raw input; everything after it uses the resolved version.
  expect(validate[step("version")].env.RELEASE_VERSION).toBe("${{ inputs.version }}");
  expect(readFileSync(new URL("../.github/workflows/prerelease.yml", import.meta.url), "utf8").match(/inputs\.version/g)).toHaveLength(1);
});

it("keeps required CI job identities, all shards, and all desktop scripts", () => {
  const ci = workflow("ci");
  expect(Object.keys(ci.jobs)).toEqual(["checks", "unit", "desktop"]);
  expect(ci.jobs.unit.strategy.matrix.shard).toEqual([1, 2, 3, 4]);
  const groups = ci.jobs.desktop.strategy.matrix.include;
  expect(groups.map(({ group }) => group)).toEqual(["library", "planning", "workflows"]);
  const desktopScripts = groups.flatMap(({ checks }) => checks.trim().split("\n"));
  expect(desktopScripts).toHaveLength(28);
  expect(new Set(desktopScripts).size).toBe(28);
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
  expect(desktopScripts).toContain("scripts/verify-robot-list-ui.mjs");
  expect(desktopScripts).toContain("scripts/verify-timeline-commands-ui.mjs");
  expect(ci.jobs.desktop.env.BORDEAUX_TIMELINE_COMMANDS_UI_OUTPUT).toBe(".ui-artifacts/timeline-commands");
  expect(desktopScripts).toContain("scripts/verify-field-layers-ui.mjs");
  expect(ci.jobs.desktop.env.BORDEAUX_FIELD_LAYERS_UI_OUTPUT).toBe(".ui-artifacts/field-layers");
  const checks = ci.jobs.checks.steps.map(({ run }) => run ?? "").join("\n");
  for (const command of ["verify:license", "typecheck", "certify-field.mjs", "npm run build", "npm run audit:dependencies"]) expect(checks).toContain(command);
  expect(ci.jobs.desktop.steps.some(({ run }) => run === "xvfb-run -a npm run test:smoke:built")).toBe(true);
});
