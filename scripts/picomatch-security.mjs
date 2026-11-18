import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const advisory = "https://github.com/advisories/GHSA-fc5q-39xc-vjpf";
const originalHash = "4e1e05447668aa1e94366c5516a2bcd8f5fff800cc92b1d0cd7d77703b8618c4";
const anchor = '  return { risky: false };\n};\n\n/**\n * Parse the given input string.';
const replacement = `  // Bordeaux: single-branch wildcard repeats also nest unbounded quantifiers.
  // Preserve the safe character-class reduction above; literalize other star
  // bodies, matching upstream's existing treatment of unsafe alternatives.
  if (branches.some(branch => branch.includes('*'))) {
    return { risky: true };
  }

${anchor}`;
const digest = text => createHash("sha256").update(text).digest("hex");
// This constant is reviewed alongside the patch, never inferred from installed code.
const patchedHash = "f1b8027ba8efa246c76bce6fc5a1ee543e2f6210443176f317b4ccd4628aba4b";

export function picomatchPaths(base = root) {
  const lock = JSON.parse(fs.readFileSync(path.join(base, "package-lock.json"), "utf8"));
  const copies = Object.entries(lock.packages).filter(([name]) => name.endsWith("/picomatch"));
  if (!copies.length) throw new Error("Expected locked Picomatch dependency; review/remove the temporary patch");
  for (const [name, entry] of copies) {
    if (entry.version !== "4.0.7") throw new Error(`Review Picomatch patch for ${name}@${entry.version}`);
  }
  return copies.map(([name]) => name);
}

export function verifyPicomatch(base = root, apply = false, omitDev = false) {
  const copies = picomatchPaths(base);
  const lock = JSON.parse(fs.readFileSync(path.join(base, "package-lock.json"), "utf8"));
  const verified = [];
  for (const name of copies) {
    const file = path.join(base, name, "lib/parse.js");
    if (apply && omitDev && lock.packages[name].dev === true && !fs.existsSync(file)) continue;
    verified.push(name);
    const source = fs.readFileSync(file, "utf8");
    if (digest(source) === patchedHash) continue;
    if (!apply || digest(source) !== originalHash) throw new Error(`Unverified Picomatch parser: ${name}`);
    const patched = source.replace(anchor, replacement);
    if (digest(patched) !== patchedHash) throw new Error("Picomatch patch integrity mismatch");
    fs.writeFileSync(file, patched);
  }
  return verified;
}

export function auditFailures(report, copies) {
  if (report.auditReportVersion !== 2 || report.error || !report.vulnerabilities || !report.metadata) {
    throw new Error("Invalid or incomplete npm audit report");
  }
  const entries = report.vulnerabilities;
  const unpatched = (name, visiting = new Set()) => {
    if (visiting.has(name)) return false;
    const entry = entries[name];
    if (!entry || !Array.isArray(entry.via) || !entry.via.length) return true;
    const seen = new Set(visiting).add(name);
    return entry.via.some(via => {
      if (typeof via === "string") return unpatched(via, seen);
      // No package-wide exemption: only this advisory on the verified parser.
      if (["info", "low", "moderate"].includes(via.severity)) return false;
      return !(name === "picomatch" && via.url === advisory && entry.nodes?.length
        && entry.nodes.every(node => copies.includes(node)));
    });
  };
  return Object.keys(entries).filter(name => ["high", "critical"].includes(entries[name].severity) && unpatched(name));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const omitDev = process.env.NODE_ENV === "production" || /(?:^|\s)dev(?:\s|$)/.test(process.env.npm_config_omit ?? "");
  console.log(`Verified Picomatch security patch: ${verifyPicomatch(root, true, omitDev).join(", ") || "development dependencies omitted"}`);
}
