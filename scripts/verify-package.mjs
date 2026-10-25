import { extractFile, listPackage } from "@electron/asar";
import fs from "node:fs";
import path from "node:path";

const MAX_ASAR_BYTES = 8 * 1024 * 1024;
const rendererEntry = "dist-renderer/index.html";
const repositoryManifest = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
if (repositoryManifest.dependencies?.ssh2 === "1.17.0" && repositoryManifest.build?.npmRebuild !== false) {
  throw new Error("ssh2 uses its reviewed JavaScript fallback; Electron packaging must not rebuild optional native accelerators");
}
const requiredEntries = [
  "package.json",
  repositoryManifest.main,
  "dist-electron/electron/agentPlanningWorker.js",
  "dist-electron/electron/bdxWorker.js",
  rendererEntry,
  "node_modules/@modelcontextprotocol/server/package.json",
  "node_modules/electron-updater/package.json",
  "node_modules/js-yaml/index.js",
  "node_modules/js-yaml/lib/loader.js",
  "node_modules/ssh2/package.json",
  "node_modules/zod/package.json",
  "node_modules/zod/index.cjs",
  "node_modules/zod/v4/index.cjs",
  "node_modules/zod/v4/classic/external.cjs",
  "node_modules/zod/v4/core/index.cjs",
];
const requiredResources = [
  "LICENSE",
  "NOTICE",
  "RIGHTS.md",
  "licenses/OFL-1.1.txt",
  "licenses/ssh2-MIT.txt",
  "labview-inspection/InspectCommands.ps1",
];

function collectArchives(target, archives) {
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    if (path.basename(target) === "app.asar") archives.push(target);
    return;
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    collectArchives(path.join(target, entry.name), archives);
  }
}

function extractArchiveFile(archive, entry) {
  return extractFile(archive, entry.replaceAll("/", path.sep));
}

const args = process.argv.slice(2);
const storeBuild = args[0] === "--store";
const targets = storeBuild ? args.slice(1) : args;
if (targets.length === 0) targets.push("release");
const archives = [];
for (const target of targets) {
  const resolved = path.resolve(target);
  if (!fs.existsSync(resolved)) throw new Error(`Packaged output does not exist: ${target}`);
  collectArchives(resolved, archives);
}
if (archives.length === 0) throw new Error(`No app.asar found under: ${targets.join(", ")}`);

for (const archive of archives) {
  const archiveBytes = fs.statSync(archive).size;
  if (archiveBytes > MAX_ASAR_BYTES) {
    throw new Error(`${archive} is ${archiveBytes.toLocaleString()} bytes; budget is ${MAX_ASAR_BYTES.toLocaleString()} bytes`);
  }

  const entries = listPackage(archive, { isPack: false })
    .map((entry) => entry.replace(/^[/\\]+/, "").replaceAll("\\", "/"));
  const entrySet = new Set(entries);
  const staleOutput = entries.find((entry) => entry.startsWith('dist-electron/') && entry.endsWith('.js')
    && !fs.existsSync(path.resolve('src', entry.slice('dist-electron/'.length).replace(/\.js$/, '.ts'))));
  if (staleOutput) throw new Error(`${archive} contains compiled output with no source: ${staleOutput}`);
  for (const required of requiredEntries) {
    if (!entrySet.has(required)) throw new Error(`${archive} is missing required entry: ${required}`);
  }
  const optionalNativeSshEntry = entries.find((entry) => /^(?:node_modules\/(?:buildcheck|cpu-features|nan))(?:\/|$)/.test(entry));
  if (optionalNativeSshEntry) {
    throw new Error(`${archive} contains an excluded optional ssh2 native accelerator: ${optionalNativeSshEntry}`);
  }
  const unusedMcpEsmEntry = entries.find((entry) => /^node_modules\/@modelcontextprotocol\/(?:core|server)\/.*\.mjs$/.test(entry));
  if (unusedMcpEsmEntry) {
    throw new Error(`${archive} contains an unused ESM MCP dependency variant: ${unusedMcpEsmEntry}`);
  }
  const unusedYamlBundle = entries.find((entry) => entry.startsWith("node_modules/js-yaml/dist/"));
  if (unusedYamlBundle) {
    throw new Error(`${archive} contains an unused YAML browser/ESM bundle: ${unusedYamlBundle}`);
  }
  const unusedZodEsmEntry = entries.find((entry) => entry.startsWith("node_modules/zod/") && entry.endsWith(".js"));
  if (unusedZodEsmEntry) {
    throw new Error(`${archive} contains an unused Zod ESM dependency variant: ${unusedZodEsmEntry}`);
  }

  const forbidden = entries.find((entry) =>
    /(^|\/)(?:tests?|__tests__)\//i.test(entry)
    || /\.(?:test|spec)\.[^/]+$/i.test(entry)
    || /\.(?:map|d\.[cm]?ts|[cm]?ts|tsx)$/i.test(entry)
    || /react(?:-dom)?\.development(?:\.min)?\.js$/i.test(entry)
    || /^(?:public|src)\/renderer\//i.test(entry));
  if (forbidden) throw new Error(`${archive} contains development-only content: ${forbidden}`);

  const packagedManifest = JSON.parse(extractArchiveFile(archive, "package.json").toString("utf8"));
  for (const field of ["name", "version", "main"]) {
    if (packagedManifest[field] !== repositoryManifest[field]) {
      throw new Error(`${archive} package.json has unexpected ${field}: ${packagedManifest[field]}`);
    }
  }

  const rendererHtml = extractArchiveFile(archive, rendererEntry).toString("utf8");
  const scriptTags = [...rendererHtml.matchAll(/<script\b[^>]*>/gi)].map((match) => match[0]);
  const scriptSources = scriptTags.flatMap((tag) => {
    const match = tag.match(/\bsrc\s*=\s*(["'])(.*?)\1/i);
    return match ? [match[2]] : [];
  });
  const stylesheetSources = [...rendererHtml.matchAll(/<link\b[^>]*>/gi)]
    .map((match) => match[0])
    .filter((tag) => /\brel\s*=\s*(["'])stylesheet\1/i.test(tag))
    .flatMap((tag) => {
      const match = tag.match(/\bhref\s*=\s*(["'])(.*?)\1/i);
      return match ? [match[2]] : [];
    });
  if (!rendererHtml.includes("Content-Security-Policy") || scriptSources.length === 0 || stylesheetSources.length === 0
      || scriptTags.some((tag) => !/\btype\s*=\s*(["'])module\1/i.test(tag) || !/\bsrc\s*=/i.test(tag))) {
    throw new Error(`${archive} renderer is not a CSP-protected production module build`);
  }
  const rendererAssets = [...scriptSources, ...stylesheetSources].map((resource) => {
    if (/^[a-z][a-z\d+.-]*:/i.test(resource) || resource.startsWith("//") || /[?#]/.test(resource)) {
      throw new Error(`${archive} renderer references a non-local resource: ${resource}`);
    }
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rendererEntry), resource));
    if (!resolved.startsWith("dist-renderer/") || !entrySet.has(resolved)) {
      throw new Error(`${archive} renderer is missing built resource: ${resource}`);
    }
    return resolved;
  });
  const rendererJavaScript = rendererAssets
    .filter((entry) => entry.endsWith(".js"))
    .map((entry) => extractArchiveFile(archive, entry).toString("utf8"))
    .join("\n");
  if (/react(?:-dom)?\.development(?:\.min)?\.js/i.test(rendererJavaScript)) {
    throw new Error(`${archive} renderer includes a development React payload`);
  }

  const resourcesDirectory = path.dirname(archive);
  for (const resource of requiredResources) {
    const file = path.join(resourcesDirectory, resource);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new Error(`${archive} is missing packaged resource: ${resource}`);
    }
  }

  const updateConfigPath = path.join(resourcesDirectory, "app-update.yml");
  if (storeBuild) {
    if (fs.existsSync(updateConfigPath)) throw new Error(`${archive} must not include GitHub update configuration in a Store build`);
    console.log(`Verified ${path.relative(process.cwd(), archive)} (${entries.length} entries, ${archiveBytes.toLocaleString()} bytes)`);
    continue;
  }
  if (!fs.existsSync(updateConfigPath)) throw new Error(`${archive} is missing packaged resource: app-update.yml`);
  const updateConfig = fs.readFileSync(updateConfigPath, "utf8");
  const prerelease = packagedManifest.version.includes("-");
  for (const [field, value] of Object.entries({
    provider: "github",
    owner: "zwatx",
    repo: "bordeaux",
    channel: prerelease ? "beta" : "latest",
    releaseType: prerelease ? "prerelease" : "release",
  })) {
    if (!new RegExp(`^${field}:\\s*${value}\\s*$`, "m").test(updateConfig)) {
      throw new Error(`${archive} app-update.yml has unexpected ${field}`);
    }
  }

  console.log(`Verified ${path.relative(process.cwd(), archive)} (${entries.length} entries, ${archiveBytes.toLocaleString()} bytes)`);
}
