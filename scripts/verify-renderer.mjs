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
// Blue-origin controls and guarded worker Flip add ~1 KiB beyond the previous application cap.
// Custom Windows chrome, dynamic-repeat controls and focused Space admission measure
// 742,860 application bytes together. The Robot page electrical drive model and its
// shared hard-limit physics bring the total to 747,485 bytes; keep every chunk counted
// with a 730 KiB cap. Combined CG load transfer, live robot reachability and the
// nonmodal update popover use a 736 KiB cap, with every chunk counted.
// Power settings/report controls add ~10 KiB; trajectory/routine analysis runs in the shared worker.
// Every application chunk remains counted.
// Point-link review, continuous playback and the Windows menu add the separately reviewed 8 KiB allowance.
// The styled tooltip layer and the toolbar update icon add 2 KiB.
// Includes explicit routine export controls and completion/error notices.
// Command search indexes and bounded Add result pages add 2 KiB.
// Directed headings, Focus recovery, routine seeking/path context and notice fixes measure 789,156 B.
// The independent UI review accepted this bounded increment; every application chunk stays counted.
// The routine Add filter, one-pick catalog commands, lane route focus/preview radios, insert-before and
// compatible-branch carry add 4,683 B (measured against HEAD at 789,213 B).
// Path/routine command groups and loops, the redesigned Commands lane and routine scrubber, and the inline
// loop/group editors measure 823,261 B (2026-11-14); 808 KiB keeps ~4 KiB headroom.
// The subsystem-aware command palette (shared command index and ranking, subsystem scope, detail column,
// keep-open Add and ranked Change command) measures 839,968 B (2026-11-14); 824 KiB keeps ~3.7 KiB headroom.
// Tangent editing, inline routine insertion, and compact status and Power reports use about 845 KB.
// The routine insertion slot and its left-rail path and command libraries (replacing the inline Add list) measure
// about 853 KB; 836 KiB keeps bounded headroom.
// Library folder drag and drop, sidebar range selection, batch deletion and the inline Move to menu measure
// 861,088 B against 853,185 B at HEAD (2026-11-18); 844 KiB keeps ~3 KiB headroom.
// Robot files inventory, comparison, and local copy add one 9 KiB allowance. Decoding and diff stay in main.
// Field-first comparison measures about 878.5 KB across all application chunks.
// Aligned, expandable event differences add about 1.8 KiB of application JavaScript.
// The key binding registry (rules, parsers, matching and labels) measures 886,016 B against 880,668 B at HEAD
// (2026-11-23); 866 KiB keeps under 1 KiB of headroom.
// Editing keys in the shortcuts dialog (recording, moving a key with Undo, Settings entry, and the keys a focused
// control declares for itself) measures 895,502 B against 886,374 B before it; 876 KiB keeps under 2 KiB of headroom.
// The sidebar refresh, linked-point picker and per-path Flip sheet measure about 909 KB together.
const APPLICATION_JAVASCRIPT_BUDGET_BYTES = 889 * 1024;
// Accepted-artifact validation, resumable search, and best-effort editing planning stay off the UI thread.
// Adding planPath and current geometry overlays costs about 20 KB versus the legacy worker.
// The measured worker is 195,729 bytes; 200 KiB keeps bounded headroom without removing the gate.
// Blue-origin Flip qualifies and rotates applied routes in the worker, outside the UI bundle.
// The default electrical drive model (motor presets, planning defaults and motoring-only
// module limits) measures 215,130 worker bytes.
// Load-dependent traction and force allocation bring the worker to 226,971 bytes.
// Shared-bus validation and on-demand thermal analysis bring the worker to ~234 KiB decimal.
// Dense trajectory validation preserves waypoint correspondence across sample grids (235,619 B).
// Shared solves, a faster reachability boundary search and leaner sample validation measure 238,219 B;
// 234 KiB keeps ~1.4 KiB headroom.
// The parallel route search (candidate pool, warm-up and a persistent optimizer worker) measures 243,763 B;
// 239 KiB keeps ~1 KiB headroom.
const WORKER_JAVASCRIPT_BUDGET_BYTES = 239 * 1024;
// Native Windows chrome and the stable project/section header use a bounded 148 KiB CSS allowance.
// Preserve the reviewed 4 KiB increment for point links and the inset Windows menu.
// Direction controls, the routine scrubber and compact-label fixes measure 157,863 B.
// The routine Add filter, preview radios and the current route block add 1,082 B.
// Group/loop editors, the redesigned Commands lane and routine scrubber bring CSS to 163,823 B (2026-11-14).
// The routine insertion slot and its left-rail source library replace the inline Add styles at about 172 KB.
// The field comparison and changed-values layout measure about 176.5 KB.
// Event groups reuse the comparison table and add less than 1 KiB of styles.
// The editable shortcuts dialog measures 179,282 B against 177,817 B before it. Closed-right disclosure chevrons
// (popup triggers stay down) add little; 176 KiB still fits the combined styles (2026-11-24).
// Shared rail styles and the linked-point and Flip sheets measure about 186 KB together.
const CSS_BUDGET_BYTES = 183 * 1024;
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
