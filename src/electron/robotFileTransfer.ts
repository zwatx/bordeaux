import { randomBytes } from "node:crypto";
import type { RobotFileConnection, RobotFileEndpoint } from "../core/robotFileDelivery";
import { ROBOT_TARGETS, allowsCustomPassword, isRobotTargetId } from "../core/robotTargets";
import { RobotTransportError, type RobotConnectRequest, type RobotRemoteFile, type RobotSftpSession, type RobotSftpSessionFactory } from "./robotSftpTransport";
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
  if (!isRobotTargetId(value.target)) {
    throw new RobotTransportError("invalid_request", `Robot type must be one of ${Object.values(ROBOT_TARGETS).map((target) => target.label).join(", ")}`);
  }
  const target = ROBOT_TARGETS[value.target];
  return { target: value.target, host: value.host, port: value.port!, directory: validateRobotFileDirectory(value.directory, target.directoryRoots) };
}

/** Refuses a custom password for robot types that log in without one, before any connection. */
function requirePasswordSupport(endpoint: RobotFileEndpoint, password: string | null): void {
  if (password !== null && !allowsCustomPassword(endpoint.target)) {
    throw new RobotTransportError("invalid_request", `${ROBOT_TARGETS[endpoint.target].label} logs in without a password`);
  }
}

/**
 * Logs in with the endpoint's robot account, using `password` instead of the type's default
 * when given. A refused login names the robot type to check.
 */
async function connect(factory: RobotSftpSessionFactory, endpoint: RobotFileEndpoint, request: Omit<RobotConnectRequest, "endpoint" | "credentials">, password: string | null): Promise<RobotSftpSession> {
  const target = ROBOT_TARGETS[endpoint.target];
  try {
    return await factory({ ...request, endpoint, credentials: { username: target.username, password: password ?? target.password } });
  } catch (error) {
    if (!(error instanceof RobotTransportError) || error.code !== "auth_rejected") throw error;
    // The dialog shows only the first sentence, so it carries the action.
    const check = target.password ? "check the robot type and password" : "check the robot type";
    const detail = password !== null ? " with a custom password" : target.password ? ` with the default ${target.label} password` : "";
    throw new RobotTransportError("auth_rejected",
      `${target.label} login refused; ${check}. The robot rejected SSH login for ${target.username}${detail}.`, { cause: error });
  }
}

function requireDirectories(session: RobotSftpSession) {
  if (!session.ensureDirectory) throw new RobotTransportError("unavailable", "Robot SFTP directory inspection is unavailable");
  return session.ensureDirectory.bind(session);
}

export async function probeRobotFiles(
  endpoint: RobotFileEndpoint,
  factory: RobotSftpSessionFactory = connectRobotSftp,
  timeoutMs = TIMEOUT_MS,
  password: string | null = null,
  expectedHostKeyFingerprint?: string,
): Promise<RobotFileConnection> {
  const validated = validateRobotFileEndpoint(endpoint);
  requirePasswordSupport(validated, password);
  const signal = AbortSignal.timeout(timeoutMs);
  const session = await connect(factory, validated, { signal, timeoutMs, expectedHostKeyFingerprint }, password);
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
  password: string | null = null,
): Promise<{ directoryCreated: boolean }> {
  const endpoint = validateRobotFileEndpoint(connection.endpoint);
  requirePasswordSupport(endpoint, password);
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
    session = await connect(factory, endpoint, { expectedHostKeyFingerprint: connection.hostKeyFingerprint, signal: connecting.signal, timeoutMs: TIMEOUT_MS }, password);
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
