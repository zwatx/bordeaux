import fs from "node:fs/promises";
import path from "node:path";
import { parseXml, type XElement } from "builder-util-runtime/out/xml";
import type { LabviewProjectDiscovery } from "../shared/types";

const MAX_XML_BYTES = 2 * 1024 * 1024;
const MAX_ITEMS = 10000;
const MAX_DEPTH = 48;
const MAX_XML_TOTAL_BYTES = 16 * 1024 * 1024;
const CONTAINERS = new Set([".lvlib", ".lvclass"]);
const SOURCE_EXTENSIONS = new Set([".vi", ".vit", ".ctl", ".ctt", ...CONTAINERS]);
type Item = LabviewProjectDiscovery["items"][number];
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const portable = (file: string) => file.split(path.sep).join("/");
const fileKey = (file: string) => process.platform === "win32" ? file.toLowerCase() : file;
const isTargetType = (type: string) => type === "My Computer" || type.startsWith("RT ") || type === "FPGA Target";

/** Reject links at every component, including ancestor junctions, before any file access. */
export async function statLabviewLocalPath(file: string) {
  if (/^(?:\\\\|\/\/)/.test(file)) throw new Error("Network paths are not supported for LabVIEW discovery");
  const absolute = path.resolve(file);
  const root = path.parse(absolute).root;
  let current = root;
  const parts = absolute.slice(root.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error("Symbolic links and junctions are not scanned");
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error("Path ancestor is not a directory");
  }
  return fs.lstat(absolute);
}

export async function resolveLabviewProject(selection: string, { canonical = false } = {}): Promise<{ root: string; projectFile: string }> {
  let selected = path.resolve(selection);
  let stat = await statLabviewLocalPath(selected);
  if (stat.isDirectory()) {
    const projects = (await fs.readdir(selected, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".lvproj")).map((entry) => entry.name).sort();
    if (!projects.length) throw new Error("Choose a folder containing a LabVIEW .lvproj file");
    if (projects.length > 1) throw new Error("This folder contains multiple LabVIEW projects. Choose the exact .lvproj file.");
    selected = path.join(selected, projects[0]);
    stat = await statLabviewLocalPath(selected);
  }
  if (!stat.isFile() || path.extname(selected).toLowerCase() !== ".lvproj") throw new Error("Choose a LabVIEW .lvproj file or its folder");
  // Existing document links retain their admitted spelling through restore, refresh and build.
  if (!canonical) return { root: path.dirname(selected), projectFile: selected };
  // Check the original spelling first: realpath must not hide a symlink/junction.
  // Match project-folder admission's physical spelling without folding distinct case-sensitive files.
  const projectFile = await fs.realpath(selected);
  const actual = await statLabviewLocalPath(projectFile);
  if (!actual.isFile() || stat.dev !== actual.dev || stat.ino !== actual.ino) throw new Error("LabVIEW project changed while resolving its location");
  return { root: path.dirname(projectFile), projectFile };
}

/** NI serializes a relative URL against the document FILE, not its directory. */
function resolveUrl(document: string, url: string): string {
  if (!url || url.includes("\0") || /^(?:[a-z][a-z0-9+.-]*:|[\\/]|<)/i.test(url) || url.includes(":")) {
    throw new Error("Only local relative LabVIEW item URLs are supported");
  }
  return path.resolve(document, url.replace(/\\/g, "/"));
}

export function parseLabviewXml(contents: string): XElement {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(contents)) throw new Error("DTD and entity declarations are not supported");
  // The existing XML utility does not call SAX.close(); validate completeness and bound depth first.
  const sax = require("sax") as { parser(strict: boolean): {
    onopentag: () => void; onclosetag: () => void; onerror: (error: Error) => void;
    write(text: string): { close(): void };
  } };
  const validator = sax.parser(true);
  let depth = 0;
  validator.onopentag = () => { if (++depth > MAX_DEPTH) throw new Error("LabVIEW XML exceeds the nesting limit"); };
  validator.onclosetag = () => { depth -= 1; };
  validator.onerror = (error) => { throw error; };
  validator.write(contents).close();
  const document = parseXml(contents);
  if (!document) throw new Error("LabVIEW XML document is empty");
  return document;
}

/** Read project declarations and auto-populating folders. Never load or execute VI binaries. */
export async function scanLabviewProject(projectFile: string): Promise<{ discovery: LabviewProjectDiscovery; warnings: string[] }> {
  const root = path.dirname(projectFile);
  const discovery: LabviewProjectDiscovery = { projectFile: path.basename(projectFile), targets: [], items: [], viCount: 0, truncated: false,
    commandContract: { kind: "legacy-status-pair", status: "requires-declaration",
      description: "Legacy Bordeaux selects VIs by a connector containing exactly two Command Status Info.ctl parameters, with framework and helper exclusions. Project XML does not contain connector types, typed arguments, or lifecycle behavior. Source VIs are previews; native execution requires declared typed handlers and a built catalog." } };
  const warnings: string[] = [];
  const expanded = new Set<string>();
  const viFiles = new Set<string>();
  let xmlBytes = 0;
  let work = 0;
  const budget = (depth: number) => {
    if (depth > MAX_DEPTH || ++work > MAX_ITEMS) { discovery.truncated = true; return false; }
    return true;
  };
  const warn = (text: string) => { if (warnings.length < 40) warnings.push(text); };
  const readDocument = async (file: string, expected: string) => {
    const stat = await statLabviewLocalPath(file);
    if (!stat.isFile()) throw new Error("LabVIEW document is not a regular file");
    if (stat.size > MAX_XML_BYTES || (xmlBytes += stat.size) > MAX_XML_TOTAL_BYTES) throw new Error("LabVIEW XML exceeds the read limit");
    const document = parseLabviewXml(await fs.readFile(file, "utf8"));
    if (document.name !== expected) throw new Error(`Expected LabVIEW ${expected} XML`);
    return document;
  };
  const fail = (item: Item, error: unknown) => {
    item.status = (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : "unsupported";
    item.reason = item.status === "missing" ? "Referenced file or folder is missing" : message(error);
    warn(`${item.projectPath}: ${item.reason}`);
  };
  const recordFile = async (item: Item, file: string, depth: number, autoFolder = false): Promise<void> => {
    item.file = portable(path.relative(root, file));
    try {
      const stat = await statLabviewLocalPath(file);
      if (autoFolder ? !stat.isDirectory() : !stat.isFile()) throw new Error(autoFolder ? "Auto-populating folder is not a directory" : "Referenced source is not a regular file");
      const extension = path.extname(file).toLowerCase();
      if (extension === ".vi" && !autoFolder) viFiles.add(fileKey(file));
      if (!autoFolder && !CONTAINERS.has(extension)) return;
      // One file can belong to different target application instances.
      const key = `${item.target}\0${fileKey(file)}`;
      if (expanded.has(key)) return;
      expanded.add(key);
      if (autoFolder) {
        const directory = await fs.opendir(file);
        const entries: Array<{ name: string; directory: boolean }> = [];
        for await (const entry of directory) {
          if (!budget(depth)) break;
          if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "bordeaux") continue;
          if (entry.isDirectory() || SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) || entry.isSymbolicLink()) entries.push({ name: entry.name, directory: entry.isDirectory() });
        }
        entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
        for (const entry of entries) {
          if (!budget(depth + 1)) break;
          const child: Item = { name: entry.name, type: entry.directory ? "Folder" : path.extname(entry.name).slice(1).toUpperCase(), target: item.target,
            projectPath: `${item.projectPath}/${entry.name}`, status: "present", origin: "autoFolder" };
          discovery.items.push(child);
          await recordFile(child, path.join(file, entry.name), depth + 1, entry.directory);
        }
      } else {
        const document = await readDocument(file, extension === ".lvclass" ? "LVClass" : "Library");
        await visit(document.getElements("Item"), file, item.target, item.projectPath, "library", depth + 1);
      }
    } catch (error) { fail(item, error); }
  };
  const visit = async (elements: XElement[], document: string, target: string, parent: string, origin: Item["origin"], depth: number): Promise<void> => {
    for (const element of elements) {
      if (!budget(depth)) break;
      const name = element.attributes?.Name ?? "Unnamed item";
      const type = element.attributes?.Type ?? "Unknown";
      // Build properties are destination/target metadata, never source references.
      if (type === "Dependencies" || type === "Build") continue;
      const projectPath = `${parent}/${name}`;
      const nestedTarget = isTargetType(type);
      const currentTarget = nestedTarget ? projectPath : target;
      if (nestedTarget) discovery.targets.push({ name: currentTarget, type });
      const item: Item = { name, type, target: currentTarget, projectPath, status: "present", origin };
      discovery.items.push(item);
      const url = element.attributes?.URL;
      if (url !== undefined && !nestedTarget) {
        const autoFolder = type === "Folder" && element.getElements("Property").some((property) => property.attributes?.Name === "NI.DISK" && property.value.trim().toLowerCase() === "true");
        try { await recordFile(item, resolveUrl(document, url), depth, autoFolder); } catch (error) { fail(item, error); }
      } else if (type !== "Folder" && !nestedTarget && !element.getElements("Item").length) { item.status = "unsupported"; item.reason = "Item has no local source URL"; }
      await visit(element.getElements("Item"), document, currentTarget, item.projectPath, origin, depth + 1);
    }
  };
  const document = await readDocument(projectFile, "Project");
  for (const target of document.getElements("Item")) {
    const name = target.attributes?.Name ?? "Unnamed target";
    const type = target.attributes?.Type ?? "Unknown";
    if (type === "Dependencies" || type === "Build") continue;
    discovery.targets.push({ name, type });
    await visit(target.getElements("Item"), projectFile, name, name, "project", 1);
  }
  discovery.viCount = viFiles.size;
  if (discovery.truncated) warn("LabVIEW discovery reached its item or depth limit; the source preview is incomplete.");
  return { discovery, warnings };
}
