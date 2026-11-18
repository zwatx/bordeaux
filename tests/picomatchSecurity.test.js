import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("bounds single-branch repeated extglobs while preserving ordinary file globs", () => {
  const result = spawnSync(process.execPath, ["-e", `
    const assert = require('node:assert/strict');
    const pm = require('picomatch');
    for (const glob of ['+(*a)', '*(*a)', '+(*)', '*(*)', 'src/+(*a).js', '+(@(*a))']) {
      assert.equal(pm(glob)('src/' + 'a'.repeat(100) + '!.js'), false);
      assert.equal(pm(glob)('a'.repeat(100) + '!'), false);
    }
    assert.equal(pm('src/**/*.ts')('src/shared/planner.ts'), true);
    assert.equal(pm('**/*.{js,ts}')('src/main.js'), true);
    assert.equal(pm('+(a|b)')('abba'), true);
    assert.equal(pm('+(*(a)|*(b))')('abba'), true);
    assert.equal(pm('!**/*.test.*')('main.js'), true);
  `], { timeout: 3000, encoding: "utf8" });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});

it("rejects unpatched copies and any other high advisory, including on Picomatch", async () => {
  const { auditFailures, advisory, verifyPicomatch } = await import("../scripts/picomatch-security.mjs");
  const copies = verifyPicomatch();
  const finding = { severity: "high", nodes: copies, via: [{ url: advisory, severity: "high" }] };
  const report = { auditReportVersion: 2, metadata: {}, vulnerabilities: { picomatch: finding,
    vite: { severity: "high", via: ["picomatch"] } } };
  expect(auditFailures(report, copies)).toEqual([]);
  const other = { url: "https://github.com/advisories/GHSA-new", severity: "high" };
  expect(auditFailures({ ...report, vulnerabilities: { picomatch: { ...finding, via: [...finding.via, other] } } }, copies)).toEqual(["picomatch"]);
  expect(auditFailures({ ...report, vulnerabilities: { unrelated: { severity: "critical", via: [other] } } }, copies)).toEqual(["unrelated"]);
  expect(auditFailures(report, ["node_modules/elsewhere/picomatch"])).toEqual(["picomatch", "vite"]);
  expect(() => auditFailures({ error: {} }, copies)).toThrow();
  expect(() => auditFailures({ ...report, vulnerabilities: undefined }, copies)).toThrow();
});

it("applies the pinned patch idempotently and fails closed on changed parsers", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { verifyPicomatch } = await import("../scripts/picomatch-security.mjs");
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "bordeaux-picomatch-"));
  try {
    fs.mkdirSync(path.join(folder, "node_modules/picomatch/lib"), { recursive: true });
    fs.writeFileSync(path.join(folder, "package-lock.json"), JSON.stringify({ packages: { "node_modules/picomatch": { version: "4.0.7" } } }));
    const parser = path.join(folder, "node_modules/picomatch/lib/parse.js");
    fs.copyFileSync("node_modules/picomatch/lib/parse.js", parser);
    expect(verifyPicomatch(folder, true)).toEqual(["node_modules/picomatch"]);
    fs.appendFileSync(parser, "\n// changed");
    expect(() => verifyPicomatch(folder)).toThrow("Unverified");
    expect(() => verifyPicomatch(folder, true)).toThrow("Unverified");
    fs.unlinkSync(parser);
    const lockFile = path.join(folder, "package-lock.json");
    fs.writeFileSync(lockFile, JSON.stringify({ packages: { "node_modules/picomatch": { version: "4.0.7", dev: true } } }));
    expect(verifyPicomatch(folder, true, true)).toEqual([]);
    expect(() => verifyPicomatch(folder)).toThrow();
    expect(() => verifyPicomatch(folder, true)).toThrow();
    fs.writeFileSync(lockFile, JSON.stringify({ packages: { "node_modules/picomatch": { version: "4.0.7", dev: false } } }));
    expect(() => verifyPicomatch(folder, true, true)).toThrow();
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});
