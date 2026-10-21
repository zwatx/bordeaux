import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { RobotCommandDescriptor } from "../shared/types";
import { statLabviewLocalPath } from "./labviewProjectDiscovery";
import { runLabviewNiAdapter } from "./labviewNiInspection";
import { writeJsonAtomically } from "./projectFiles";

export function commandWrapperPath(projectFile: string, command: RobotCommandDescriptor): { source: string; wrapper: string } {
  const file = command.labviewConnector?.file;
  if (!file || !/\.vi$/i.test(file) || /_wrapper\.vi$/i.test(file)) throw new Error("Rescan command inputs before creating this wrapper.");
  const source = path.resolve(path.dirname(projectFile), file);
  return { source, wrapper: path.join(path.dirname(source), path.basename(source, path.extname(source)) + "_wrapper.vi") };
}

/** Creates only an absent sibling wrapper; existing files are never overwritten or executed. */
export async function ensureLabviewCommandWrapper(projectFile: string, command: RobotCommandDescriptor, cacheDirectory: string,
  assertCurrent: () => void, adapter = runLabviewNiAdapter, validateSnapshot: () => Promise<void> = async () => {}): Promise<{ file: string; created: boolean }> {
  const { source, wrapper } = commandWrapperPath(projectFile, command);
  assertCurrent();
  try {
    const existing = await statLabviewLocalPath(wrapper);
    if (!existing.isFile() || existing.size === 0) throw new Error("The existing command wrapper is not a usable VI file. Bordeaux left it unchanged.");
    assertCurrent(); return { file: wrapper, created: false };
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const terminals = command.labviewConnector!.terminalNumbers;
  if (!terminals?.length || new Set(terminals).size !== terminals.length || terminals.some(number => !Number.isInteger(number) || number < 0 || number > 255)) throw new Error("Rescan command inputs before creating this wrapper.");
  if (process.platform !== "win32" && adapter === runLabviewNiAdapter) throw new Error("Open this robot project in LabVIEW on Windows to create its missing command wrapper.");
  const sourceHash = async () => {
    const stat = await statLabviewLocalPath(source);
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error("Command wrapper source must be a bounded regular VI file.");
    return createHash("sha256").update(await fs.readFile(source)).digest("hex");
  };
  const before = await sourceHash(); assertCurrent();
  await fs.mkdir(cacheDirectory, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(cacheDirectory, "wrapper-"));
  const staged = path.join(path.dirname(source), `.bordeaux-wrapper-${randomUUID()}.vi`);
  try {
    const request = path.join(temporary, "request.json"), response = path.join(temporary, "response.json");
    const terminalCount = terminals.length;
    await writeJsonAtomically(request, { schemaVersion: "bordeaux-ni-wrapper/1", sources: [], projectFile, commandFile: source, wrapperFile: staged, terminalCount, terminalNumbers: terminals });
    await validateSnapshot(); assertCurrent(); await adapter(request, response); assertCurrent();
    const stat = await fs.lstat(response);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new Error("Invalid wrapper scripting response.");
    const result = JSON.parse(await fs.readFile(response, "utf8"));
    if (result.schemaVersion !== "bordeaux-ni-wrapper/1" || result.wrapperFile !== staged || result.terminalCount !== terminalCount) throw new Error("Wrapper scripting did not confirm every command terminal.");
    const generated = await statLabviewLocalPath(staged);
    if (!generated.isFile() || generated.size === 0 || generated.size > 32 * 1024 * 1024) throw new Error("Wrapper scripting did not save a usable VI.");
    if (before !== await sourceHash()) throw new Error("The command changed during wrapper creation. Rescan command inputs and try again.");
    await validateSnapshot();
    assertCurrent();
    // Same-directory publication preserves subVI relative paths; hard-link creation refuses any existing destination.
    try { await fs.link(staged, wrapper); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("A wrapper appeared during creation. Bordeaux left it unchanged; refresh commands."); throw error; }
    return { file: wrapper, created: true };
  } finally {
    await fs.rm(staged, { force: true });
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
