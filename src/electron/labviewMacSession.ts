import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { LabviewViServer, LabviewViServerError } from "./labviewViServer";

const exec = promisify(execFile);
const INSTALL_ROOT = "/Applications/National Instruments";
const LABVIEW_2026 = /^LabVIEW 2026(?: 64-bit)?$/;
const LABVIEW_APP = /^LabVIEW(?:Community)?\.app$/;
const SERVER_SETUP = "In LabVIEW, open Tools → Options → VI Server, enable TCP/IP, and allow 127.0.0.1. Then refresh commands.";

interface MacLabview {
  pid: string;
  version: string;
  port: number;
}

async function runningLabview(): Promise<MacLabview> {
  const uid = String(process.getuid!());
  const { stdout } = await exec("/bin/ps", ["-axww", "-o", "pid=,uid=,comm="], { timeout: 5000 });
  const matches: Array<{ pid: string; bundle: string }> = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match || match[2] !== uid) continue;
    const executable = match[3];
    const bundle = path.dirname(path.dirname(path.dirname(executable)));
    const installation = path.dirname(bundle);
    if (path.dirname(installation) !== INSTALL_ROOT || !LABVIEW_2026.test(path.basename(installation)) || !LABVIEW_APP.test(path.basename(bundle))) continue;
    if (executable !== path.join(bundle, "Contents", "MacOS", path.basename(bundle, ".app"))) continue;
    matches.push({ pid: match[1], bundle });
  }
  if (matches.length !== 1) throw new Error("Open the selected project in one instance of LabVIEW 2026 in this desktop session.");
  const { pid, bundle } = matches[0];
  const name = path.basename(bundle);
  const preferences = path.join(os.homedir(), "Library", "Preferences", `${name} 2026 Preferences`);
  const settings = await fs.readFile(preferences, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const port = Number(/^server\.tcp\.port\s*=\s*"?(\d+)"?\s*$/im.exec(settings)?.[1] ?? 3363);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`LabVIEW has an invalid VI Server port. ${SERVER_SETUP}`);
  const versions = await fs.readFile(path.join(path.dirname(bundle), "VERSIONS.txt"), "utf8");
  const version = /^EDITOR_VERSION=(26\.[\w.]+)\s*$/m.exec(versions)?.[1];
  if (!version) throw new Error("Bordeaux could not identify the running LabVIEW 2026 installation.");
  return { pid, port, version };
}

export async function connectMacLabview(): Promise<{ server: LabviewViServer; version: string }> {
  const { port, pid, version } = await runningLabview();
  // Check the same user's actual listener before sending LabVIEW messages. In particular, a second
  // service that happens to use the configured port must not be handed paths from a linked project.
  const { stdout } = await exec("/usr/sbin/lsof", ["-nP", `-i4TCP:${port}`, "-sTCP:LISTEN", "-Fpn"], { timeout: 5000 })
    .catch((error: { code?: number; stdout?: string }) => {
      if (error.code === 1) return { stdout: error.stdout ?? "" };
      throw error;
    });
  const listeners = new Set<string>();
  let owner = "";
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) owner = line.slice(1);
    if (line === `n127.0.0.1:${port}` || line === `n*:${port}`) listeners.add(owner);
  }
  if (!listeners.size) throw new Error(SERVER_SETUP);
  if (listeners.size !== 1 || !listeners.has(pid)) throw new Error(`VI Server port ${port} is in use by another process. Choose a free port in LabVIEW, then refresh commands.`);
  try { return { server: await LabviewViServer.connect(port), version }; }
  catch (error) {
    if (error instanceof LabviewViServerError && error.code === 1032) throw new Error(SERVER_SETUP);
    throw error;
  }
}
