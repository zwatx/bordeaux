import fs from "node:fs";
import path from "node:path";

// Bounds all application JS, including dialogs, rather than only the initial chunk.
// Reviewed P2 problem controls cost 5,158 bytes above the 671,700-byte baseline; Focus adds 1,200.
// Focus preserves mounted library state, input ownership and stable sizing without new dependencies.
// P3 hover adds 5,932 measured bytes; the complete Problems menu with native trigger association adds 3,986.
// Precise local-deletion Undo and readable compact Push states bring the integrated app to 693,062 bytes.
// Named Save copy measured 697,860 bytes; the owner approved 684 KiB for this feature.
// Command placement, linked-point editing and explicit linked-path Include measured 705,119 bytes;
// the owner approved 690 KiB for the combined interaction improvements.
// Project row actions, portable LabVIEW links and precise Details measured 712,224 bytes;
// the owner approved 696 KiB for this combined increment.
// Every app chunk stays counted; worker/CSS ceilings are unchanged. Future growth needs review.
// The owner approved 708/204/141 KiB for waypoint-route optimization and the Routine redesign
// on 2026-10-17: measured app 724,077 B, worker 208,519 B and CSS 143,705 B.
// The owner approved 720/205/146 KiB later on 2026-10-17 for drag-preview parity, timeline
// command stacks and waypoint insertion, the split Push control, and the menu/Routine redesigns:
// measured app 734,507 B, worker 208,908 B and CSS 148,643 B.
const APPLICATION_JAVASCRIPT_BUDGET_BYTES = 720 * 1024;
// Accepted-artifact validation, resumable search, and best-effort editing planning stay off the UI thread.
// Adding planPath and current geometry overlays costs about 20 KB versus the legacy worker.
// The measured worker is 195,729 bytes; 200 KiB keeps bounded headroom without removing the gate.
const WORKER_JAVASCRIPT_BUDGET_BYTES = 205 * 1024;
const CSS_BUDGET_BYTES = 146 * 1024;
const rendererDirectory = path.resolve("dist-renderer");
const renderer = path.join(rendererDirectory, "index.html");

if (!fs.existsSync(renderer)) {
  throw new Error("Built renderer is missing; run npm run build:renderer first");
}

const html = fs.readFileSync(renderer, "utf8");

function tagResources(tagName, attribute) {
  const tags = [...html.matchAll(new RegExp(`<${tagName}\\b[^>]*>`, "gi"))].map((match) => match[0]);
  return tags.flatMap((tag) => {
    const match = tag.match(new RegExp(`\\b${attribute}\\s*=\\s*(["'])(.*?)\\1`, "i"));
    return match ? [match[2]] : [];
  });
}

function resolveRendererResource(resource, baseDirectory = rendererDirectory) {
  if (/^[a-z][a-z\d+.-]*:/i.test(resource) || resource.startsWith("//") || /[?#]/.test(resource)) {
    throw new Error(`Renderer resources must be local files without query strings: ${resource}`);
  }
  const file = path.resolve(baseDirectory, resource);
  const relative = path.relative(rendererDirectory, file);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
      || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`Missing or unsafe renderer resource: ${resource}`);
  }
  return file;
}

function collectFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? collectFiles(file) : [file];
  });
}

const scriptTags = [...html.matchAll(/<script\b[^>]*>/gi)].map((match) => match[0]);
const sources = tagResources("script", "src");
const linkTags = [...html.matchAll(/<link\b[^>]*>/gi)].map((match) => match[0]);
const stylesheets = linkTags
  .filter((tag) => /\brel\s*=\s*(["'])stylesheet\1/i.test(tag))
  .flatMap((tag) => {
    const match = tag.match(/\bhref\s*=\s*(["'])(.*?)\1/i);
    return match ? [match[2]] : [];
  });
const modulePreloads = linkTags
  .filter((tag) => /\brel\s*=\s*(["'])modulepreload\1/i.test(tag))
  .flatMap((tag) => {
    const match = tag.match(/\bhref\s*=\s*(["'])(.*?)\1/i);
    return match ? [match[2]] : [];
  });

if (!html.includes("Content-Security-Policy")) throw new Error("The renderer must define a Content Security Policy");
if (!html.includes('<div id="root"></div>')) throw new Error("The renderer is missing its root element");
if (/<style\b/i.test(html) || scriptTags.some((tag) => !/\bsrc\s*=/i.test(tag))) {
  throw new Error("Renderer code and styles must stay outside index.html");
}
if (scriptTags.some((tag) => !/\btype\s*=\s*(["'])module\1/i.test(tag))) {
  throw new Error("Every renderer script must be an ES module");
}
if (sources.length === 0) throw new Error("The renderer has no application scripts");
if (stylesheets.length === 0) throw new Error("The renderer has no stylesheet");
if (new Set([...stylesheets, ...modulePreloads, ...sources]).size !== stylesheets.length + modulePreloads.length + sources.length) {
  throw new Error("The renderer loads the same resource more than once");
}

for (const resource of [...stylesheets, ...modulePreloads, ...sources]) resolveRendererResource(resource);

for (const stylesheet of stylesheets) {
  const file = resolveRendererResource(stylesheet);
  const css = fs.readFileSync(file, "utf8");
  for (const match of css.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) {
    const resource = match[2];
    if (resource.startsWith("data:")) continue;
    resolveRendererResource(resource, path.dirname(file));
  }
}

const files = collectFiles(rendererDirectory);
const forbidden = files.find((file) => /\.(?:map|d\.[cm]?ts|[cm]?ts|tsx)$/i.test(file)
  || /react(?:-dom)?\.development(?:\.min)?\.js$/i.test(file));
if (forbidden) throw new Error(`Renderer output contains development-only content: ${path.relative(rendererDirectory, forbidden)}`);

const javascript = files.filter((file) => file.endsWith(".js"));
const css = files.filter((file) => file.endsWith(".css"));
const javascriptBytes = javascript.reduce((total, file) => total + fs.statSync(file).size, 0);
const workerJavascript = javascript.filter((file) => /^path-preview-worker-[^.]+\.js$/.test(path.basename(file)));
const applicationJavascript = javascript.filter((file) => !workerJavascript.includes(file));
const applicationJavascriptBytes = applicationJavascript.reduce((total, file) => total + fs.statSync(file).size, 0);
const workerJavascriptBytes = workerJavascript.reduce((total, file) => total + fs.statSync(file).size, 0);
const cssBytes = css.reduce((total, file) => total + fs.statSync(file).size, 0);
if (applicationJavascriptBytes > APPLICATION_JAVASCRIPT_BUDGET_BYTES) {
  throw new Error(`Renderer application JavaScript is ${applicationJavascriptBytes.toLocaleString()} bytes; budget is ${APPLICATION_JAVASCRIPT_BUDGET_BYTES.toLocaleString()} bytes`);
}
if (workerJavascriptBytes > WORKER_JAVASCRIPT_BUDGET_BYTES) {
  throw new Error(`Renderer worker JavaScript is ${workerJavascriptBytes.toLocaleString()} bytes; budget is ${WORKER_JAVASCRIPT_BUDGET_BYTES.toLocaleString()} bytes`);
}
if (cssBytes > CSS_BUDGET_BYTES) {
  throw new Error(`Renderer CSS is ${cssBytes.toLocaleString()} bytes; budget is ${CSS_BUDGET_BYTES.toLocaleString()} bytes`);
}

const builtJavaScript = javascript.map((file) => fs.readFileSync(file, "utf8")).join("\n");
if (/react(?:-dom)?\.development(?:\.min)?\.js/i.test(builtJavaScript)) {
  throw new Error("Development React must not ship in the renderer bundle");
}

console.log(`Verified built renderer (${applicationJavascript.length} application JavaScript file, ${applicationJavascriptBytes.toLocaleString()} bytes; ${workerJavascript.length} worker JavaScript file, ${workerJavascriptBytes.toLocaleString()} bytes; ${javascriptBytes.toLocaleString()} total JS bytes; ${css.length} stylesheet, ${cssBytes.toLocaleString()} CSS bytes)`);
