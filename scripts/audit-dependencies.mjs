import { spawnSync } from "node:child_process";
import { auditFailures, verifyPicomatch } from "./picomatch-security.mjs";

// Fail closed if install scripts were skipped, a copy changed, or audit failed.
const copies = verifyPicomatch();
const result = spawnSync("npm audit --json", { shell: true, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
if (result.error || ![0, 1].includes(result.status)) throw result.error ?? new Error(result.stderr || "npm audit failed");
const report = JSON.parse(result.stdout);
const failures = auditFailures(report, copies);
console.log(JSON.stringify(report, null, 2));
console.log("GHSA-fc5q-39xc-vjpf: installed parser matches the verified Bordeaux patch.");
if (failures.length) throw new Error(`Unpatched high/critical audit findings: ${failures.join(", ")}`);
console.log("Dependency audit passed: no unpatched high/critical findings.");
