import { randomBytes } from "node:crypto";
import type { RobotFileConnection, RobotFileEndpoint } from "../shared/robotFileDelivery";
import { RobotTransportError, type RobotRemoteFile, type RobotSftpSession, type RobotSftpSessionFactory } from "./robotSftpTransport";
import { connectRobotSftp, validateRobotFileDirectory, validateRobotFileName } from "./robotSsh2Session";

const MAX_BYTES = 24 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

export function validateRobotFileEndpoint(raw: unknown): RobotFileEndpoint {
  const value = raw as Partial<RobotFileEndpoint> | null;
  if (!value || typeof value !== "object" || typeof value.host !== "string"
    || value.host.length > 253 || !/^[A-Za-z0-9][A-Za-z0-9.:-]*$/.test(value.host)
    || !Number.isInteger(value.port) || value.port! < 1 || value.port! > 65535) {
    throw new RobotTransportError("invalid_request", "Robot endpoint must contain a hostname or IP address and valid SSH port");
  }
  return { host: value.host, port: value.port!, directory: validateRobotFileDirectory(value.directory) };
}

function requireDirectories(session: RobotSftpSession) {
  if (!session.ensureDirectory) throw new RobotTransportError("unavailable", "Robot SFTP directory inspection is unavailable");
  return session.ensureDirectory.bind(session);
}

export async function probeRobotFiles(
  endpoint: RobotFileEndpoint,
  factory: RobotSftpSessionFactory = connectRobotSftp,
  timeoutMs = TIMEOUT_MS,
): Promise<RobotFileConnection> {
  const validated = validateRobotFileEndpoint(endpoint);
  const signal = AbortSignal.timeout(timeoutMs);
  const session = await factory({ endpoint: validated, credentials: { username: "admin", password: "" }, signal, timeoutMs });
  try {
    await requireDirectories(session)(validated.directory, false, signal);
    return { endpoint: validated, hostKeyFingerprint: session.hostKeyFingerprint };
  } finally { await session.close(); }
}

/** Publishes each reviewed BDX file independently; never activates robot code. */
export async function uploadRobotFiles(
  connection: RobotFileConnection,
  files: Array<{ fileName: string; contents: Buffer }>,
  signal?: AbortSignal,
  factory: RobotSftpSessionFactory = connectRobotSftp,
): Promise<{ directoryCreated: boolean }> {
  const endpoint = validateRobotFileEndpoint(connection.endpoint);
  if (!/^SHA256:[A-Za-z0-9+/]{20,128}$/.test(connection.hostKeyFingerprint)) {
    throw new RobotTransportError("invalid_request", "Review the robot SSH identity before transferring files");
  }
  if (!Array.isArray(files) || files.length < 1 || files.length > 64) {
    throw new RobotTransportError("invalid_request", "Select between 1 and 64 robot path files");
  }
  const names = new Set<string>();
  let total = 0;
  for (const file of files) {
    validateRobotFileName(file.fileName);
    if (names.has(file.fileName) || !Buffer.isBuffer(file.contents) || file.contents.length === 0
      || file.contents.length > MAX_BYTES || (total += file.contents.length) > MAX_BYTES) {
      throw new RobotTransportError("invalid_request", "Robot files must have distinct names and total at most 24 MiB");
    }
    names.add(file.fileName);
  }
  const deadline = AbortSignal.timeout(TIMEOUT_MS);
  const operation = signal ? AbortSignal.any([signal, deadline]) : deadline;
  operation.throwIfAborted();
  // Cancel connection establishment, then keep the session alive briefly for cleanup.
  const connecting = new AbortController();
  const abortConnect = () => connecting.abort();
  operation.addEventListener("abort", abortConnect, { once: true });
  let session: RobotSftpSession;
  try {
    session = await factory({ endpoint, credentials: { username: "admin", password: "" }, expectedHostKeyFingerprint: connection.hostKeyFingerprint,
      signal: connecting.signal, timeoutMs: TIMEOUT_MS });
  } finally { operation.removeEventListener("abort", abortConnect); }
  let temporary: RobotRemoteFile | undefined;
  const published: string[] = [];
  let publishing: string | undefined;
  let stage = "check the destination directory";
  let directoryCreated = false;
  try {
    operation.throwIfAborted();
    if (session.hostKeyFingerprint !== connection.hostKeyFingerprint) {
      throw new RobotTransportError("re_pair_required", "The robot SSH host key changed; connect again before transferring files");
    }
    const directory = requireDirectories(session);
    directoryCreated = (await directory(endpoint.directory, true, operation)).created;
    for (const file of files) {
      operation.throwIfAborted();
      stage = "check the destination directory";
      await directory(endpoint.directory, false, operation);
      const destination: RobotRemoteFile = { kind: "pathFile", directory: endpoint.directory, fileName: file.fileName };
      // Reject non-regular destinations, including symbolic links, before any replacement.
      stage = `check ${file.fileName}`;
      await session.exists(destination, operation);
      temporary = { kind: "pathTemporary", directory: endpoint.directory, fileName: file.fileName, token: randomBytes(16).toString("hex") };
      stage = `upload ${file.fileName}`;
      await session.write(temporary, file.contents, operation);
      stage = `read back the uploaded ${file.fileName}`;
      if (!(await session.read(temporary, MAX_BYTES, operation)).equals(file.contents)) {
        throw new RobotTransportError("transfer_failed", `SFTP read-back did not match ${file.fileName}; its destination was not replaced`);
      }
      operation.throwIfAborted();
      publishing = file.fileName;
      stage = `publish ${file.fileName}`;
      await session.renameSameDirectory(temporary, destination, operation);
      temporary = undefined;
      stage = `verify ${file.fileName} at its destination`;
      if (!(await session.read(destination, MAX_BYTES, operation)).equals(file.contents)) {
        throw new RobotTransportError("transfer_failed", `Published SFTP read-back did not match ${file.fileName}`);
      }
      published.push(file.fileName);
      publishing = undefined;
    }
    return { directoryCreated };
  } catch (error) {
    const reason = deadline.aborted ? "SFTP transfer timed out" : signal?.aborted ? "SFTP transfer was cancelled"
      : error instanceof Error ? error.message : "SFTP transfer failed";
    const code = deadline.aborted ? "timed_out" : signal?.aborted ? "cancelled"
      : error instanceof RobotTransportError ? error.code : "transfer_failed";
    throw new RobotTransportError(code,
      `Could not ${stage}: ${reason}. ${published.length} of ${files.length} files verified on the robot${published.length ? ` (${published.join(", ")})` : ""}.${publishing ? ` ${publishing} may have been replaced; its final bytes were not verified.` : ""}${directoryCreated ? ` Created robot folder ${endpoint.directory}.` : ""}`,
      { cause: error });
  } finally {
    if (temporary) {
      try { await session.remove(temporary, AbortSignal.timeout(2_000)); }
      catch { /* Preserve the original error; a hidden temporary file cannot activate a path. */ }
    }
    await session.close();
  }
}
