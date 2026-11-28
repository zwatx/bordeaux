import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { RobotCommandCatalog } from "../core/types";
import { assertMacLabviewReferenceSaveVersion, statLabviewLocalPath } from "./labviewProjectDiscovery";
import { labviewInspectionResource, runLabviewNiAdapter } from "./labviewNiInspection";
import { writeJsonAtomically } from "./projectFiles";
import { commandWrapperPath } from "./labviewWrappers";

/*
 * Bordeaux keeps one VI beside the .lvproj that holds a Static VI Reference to every command wrapper. The team places
 * it once on Autonomous.vi, so a run from the LabVIEW project loads (and deploys) every wrapper while Bordeaux, not the
 * team's Autonomous.vi, owns the list. Its VI description records a digest of that list; LabVIEW stores the
 * description as plain bytes, so Bordeaux can tell whether the saved VI is current without starting LabVIEW.
 */
export const WRAPPER_REFERENCES_FILE = "Bordeaux Command Wrappers.vi";
export const WRAPPER_REFERENCES_MARKER = "bordeaux-command-wrappers/1";
const REQUEST_VERSION = "bordeaux-ni-wrapper-references/1";
const MAX_VI_BYTES = 32 * 1024 * 1024;
const MAX_WRAPPERS = 1000;
const DIGEST = new RegExp(`${WRAPPER_REFERENCES_MARKER.replace("/", "\\/")} sha256:([0-9a-f]{64}|none)`, "g");

export function wrapperReferencesPath(projectFile: string): string {
  return path.join(path.dirname(projectFile), WRAPPER_REFERENCES_FILE);
}

/** Digest of project-relative, `/`-separated wrapper paths in UTF-16 code-unit order. */
export function wrapperReferencesDigest(wrappers: string[]): string {
  return createHash("sha256").update([...wrappers].sort((a, b) => a < b ? -1 : a > b ? 1 : 0).join("\n")).digest("hex");
}

export function wrapperReferencesDescription(digest: string): string {
  return "Managed by Bordeaux. Holds a static VI reference to every command wrapper so that running from the LabVIEW project "
    + "loads and deploys them. Place this VI once on the Autonomous.vi block diagram. Bordeaux rewrites it when wrappers "
    + `change; do not edit it.\n\n${WRAPPER_REFERENCES_MARKER} sha256:${digest}`;
}

/** The digest recorded in the saved VI: `null` when absent, `"none"` for the empty template. Refuses a VI Bordeaux didn't make. */
export async function readWrapperReferencesDigest(file: string): Promise<string | null> {
  let stat;
  try { stat = await statLabviewLocalPath(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_VI_BYTES) throw new Error(`${WRAPPER_REFERENCES_FILE} beside the project is not a usable VI file. Bordeaux left it unchanged.`);
  const digests = new Set([...(await fs.readFile(file)).toString("latin1").matchAll(DIGEST)].map(match => match[1]));
  if (digests.size !== 1) throw new Error(`${WRAPPER_REFERENCES_FILE} beside the project wasn’t made by Bordeaux. Rename it so Bordeaux can keep the command wrapper references there.`);
  return [...digests][0];
}

type Catalog = Pick<RobotCommandCatalog, "commands" | "labviewDiscovery">;
interface Wrapper { file: string; relative: string; target: string }

/**
 * Wrappers that exist on disk: the sibling `<command>_wrapper.vi` of each inspected command, plus any `_wrapper.vi`
 * the project lists under a command's target. Listed wrappers keep their reference even while their command is not
 * inspected (unsupported, moved to an excluded folder), since robot code still resolves them by name.
 */
async function existingWrappers(projectFile: string, catalog: Catalog): Promise<Wrapper[]> {
  const root = path.dirname(projectFile), byPath = new Map<string, Wrapper>();
  const add = async (file: string, target: string) => {
    const key = process.platform === "win32" ? file.toLowerCase() : file;
    if (byPath.has(key)) return;
    try { if (!(await statLabviewLocalPath(file)).isFile()) return; }
    catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return; throw error; }
    byPath.set(key, { file, relative: path.relative(root, file).split(path.sep).join("/"), target });
  };
  const targets = new Set<string>();
  for (const command of catalog.commands) {
    const connector = command.labviewConnector;
    if (!connector?.file || !/\.vi$/i.test(connector.file) || /_wrapper\.vi$/i.test(connector.file)) continue;
    targets.add(connector.target);
    await add(commandWrapperPath(projectFile, command).wrapper, connector.target);
  }
  for (const item of catalog.labviewDiscovery?.items ?? []) {
    // Cancel wrappers are never called by robot code.
    if (item.status === "present" && item.file && targets.has(item.target) && /_wrapper\.vi$/i.test(item.file) && !/_cancel_wrapper\.vi$/i.test(item.file)) {
      await add(path.resolve(root, item.file), item.target);
    }
  }
  const wrappers = [...byPath.values()].sort((a, b) => a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0);
  if (wrappers.length > MAX_WRAPPERS) throw new Error(`Bordeaux keeps references to at most ${MAX_WRAPPERS} command wrappers.`);
  return wrappers;
}

/** Copies the empty template into place without replacing anything; returns the new file's identity. */
async function publishTemplate(file: string) {
  const staged = path.join(path.dirname(file), `.bordeaux-references-${randomUUID()}.vi`);
  try {
    await fs.copyFile(await labviewInspectionResource("CommandWrapperReferences.vi"), staged, fs.constants.COPYFILE_EXCL);
    await fs.chmod(staged, 0o644); // an installer's read-only resource attribute would stop LabVIEW saving the copy
    // A hard link refuses an existing destination, so a file that appeared meanwhile is never replaced.
    try { await fs.link(staged, file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${WRAPPER_REFERENCES_FILE} appeared while Bordeaux was creating it. Bordeaux left it unchanged; refresh commands.`); throw error; }
    return (await fs.stat(file)).ino;
  } finally { await fs.rm(staged, { force: true }); }
}

export interface WrapperReferencesResult { file: string; created: boolean; updated: boolean }

/**
 * Brings `Bordeaux Command Wrappers.vi` up to date with the wrappers that exist. Nothing is written when the saved
 * digest already matches, or when no wrapper exists and the VI was never created. Rewriting needs the project open
 * in LabVIEW 2025 on Windows or a 2026-format project open in LabVIEW 2026 on macOS.
 * `created` means the VI had never listed wrappers, so the team still has to place it on Autonomous.vi.
 */
export async function syncLabviewWrapperReferences(projectFile: string, catalog: Catalog, cacheDirectory: string,
  assertCurrent: () => void, adapter = runLabviewNiAdapter): Promise<WrapperReferencesResult | null> {
  const file = wrapperReferencesPath(projectFile);
  const wrappers = await existingWrappers(projectFile, catalog);
  const digest = wrapperReferencesDigest(wrappers.map(wrapper => wrapper.relative));
  const saved = await readWrapperReferencesDigest(file);
  assertCurrent();
  if (saved === digest || (saved === null && !wrappers.length)) return { file, created: false, updated: false };
  if (process.platform !== "win32" && process.platform !== "darwin" && adapter === runLabviewNiAdapter) return null;
  // With no wrapper left, the commands' own target still says where the (now empty) VI is loaded.
  const targets = [...new Set(wrappers.length ? wrappers.map(wrapper => wrapper.target) : catalog.commands.flatMap(command => command.labviewConnector?.target ?? []))];
  if (targets.length > 1) throw new Error(`Command wrappers belong to more than one project target (${targets.join(", ")}); ${WRAPPER_REFERENCES_FILE} can serve only one.`);
  if (!targets.length) throw new Error("Rescan command inputs before updating command wrapper references.");
  if (process.platform === "darwin" && adapter === runLabviewNiAdapter) {
    await assertMacLabviewReferenceSaveVersion(projectFile);
    assertCurrent();
  }
  const published = saved === null ? await publishTemplate(file) : null;
  try {
    assertCurrent();
    await fs.mkdir(cacheDirectory, { recursive: true });
    const temporary = await fs.mkdtemp(path.join(cacheDirectory, "references-"));
    try {
      const request = path.join(temporary, "request.json"), response = path.join(temporary, "response.json");
      await writeJsonAtomically(request, { schemaVersion: REQUEST_VERSION, sources: [], projectFile, referencesFile: file, target: targets[0],
        wrapperFiles: wrappers.map(wrapper => wrapper.file), description: wrapperReferencesDescription(digest), marker: WRAPPER_REFERENCES_MARKER });
      await adapter(request, response);
      assertCurrent();
      const stat = await fs.lstat(response);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new Error("Invalid wrapper references scripting response.");
      const result = JSON.parse(await fs.readFile(response, "utf8"));
      const same = (a: unknown) => typeof a === "string" && (process.platform === "win32" ? path.resolve(a).toLowerCase() === file.toLowerCase() : a === file);
      if (result.schemaVersion !== REQUEST_VERSION || !same(result.referencesFile) || result.referenceCount !== wrappers.length) throw new Error(`LabVIEW did not confirm every reference in ${WRAPPER_REFERENCES_FILE}.`);
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  } catch (error) {
    // A template this call placed and LabVIEW never filled is removed again, so a failure leaves no new file behind.
    if (published !== null) {
      const current = await fs.stat(file).catch(() => null);
      if (current?.ino === published && await readWrapperReferencesDigest(file).catch(() => null) === "none") await fs.rm(file, { force: true });
    }
    throw error;
  }
  if (await readWrapperReferencesDigest(file) !== digest) throw new Error(`${WRAPPER_REFERENCES_FILE} was not saved with the current command wrappers. Refresh commands to try again.`);
  return { file, created: saved === null || saved === "none", updated: true };
}
