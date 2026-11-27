import { randomBytes } from "node:crypto";
import type { RobotFileConnection, RobotFileEndpoint, RobotPathFiles } from "../core/robotFileDelivery";
import { ROBOT_TARGETS, allowsCustomPassword, isRobotTargetId } from "../core/robotTargets";
import { COMMANDS_FILE_NAME } from "../core/export/commandsFile";
import { RobotFileKeptError, RobotTransportError, type RobotConnectRequest, type RobotRemoteFile, type RobotSftpSession, type RobotSftpSessionFactory } from "./robotSftpTransport";
import { connectRobotSftp, isDeployedPathName, validateRobotFileDirectory, validateRobotFileName } from "./robotSsh2Session";

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

async function withPinnedReadSession<T>(
  connection: RobotFileConnection, signal: AbortSignal | undefined, factory: RobotSftpSessionFactory, password: string | null,
  read: (session: RobotSftpSession, directory: string, operation: AbortSignal) => Promise<T>,
): Promise<T> {
  const endpoint = validateRobotFileEndpoint(connection.endpoint);
  requirePasswordSupport(endpoint, password);
  if (!/^SHA256:[A-Za-z0-9+/]{20,128}$/.test(connection.hostKeyFingerprint)) {
    throw new RobotTransportError("invalid_request", "Review the robot SSH identity before transferring files");
  }
  const deadline = AbortSignal.timeout(TIMEOUT_MS);
  const operation = signal ? AbortSignal.any([signal, deadline]) : deadline;
  operation.throwIfAborted();
  const session = await connect(factory, endpoint, { expectedHostKeyFingerprint: connection.hostKeyFingerprint,
    signal: operation, timeoutMs: TIMEOUT_MS }, password);
  try {
    operation.throwIfAborted();
    if (session.hostKeyFingerprint !== connection.hostKeyFingerprint) {
      throw new RobotTransportError("re_pair_required", "The robot SSH host key changed; connect again before transferring files");
    }
    await requireDirectories(session)(endpoint.directory, false, operation);
    const result = await read(session, endpoint.directory, operation);
    operation.throwIfAborted();
    return result;
  } finally { await session.close(); }
}

export async function listRobotPathFiles(
  connection: RobotFileConnection, signal?: AbortSignal, factory: RobotSftpSessionFactory = connectRobotSftp, password: string | null = null,
): Promise<RobotPathFiles> {
  return withPinnedReadSession(connection, signal, factory, password, (session, directory, operation) => {
    if (!session.listPathFiles) throw new RobotTransportError("unavailable", "Robot path listing is unavailable");
    return session.listPathFiles(directory, operation);
  });
}

/**
 * Read the named path, routine and robot files without changing the robot. Missing files are null. When a `.robot`
 * file is missing, `robotConfigs` lists the `.robot` files the folder holds, so the user can choose one.
 */
export async function readRobotFiles(
  connection: RobotFileConnection, fileNames: readonly string[], signal?: AbortSignal,
  factory: RobotSftpSessionFactory = connectRobotSftp, password: string | null = null,
): Promise<{ files: Array<{ fileName: string; contents: Buffer | null }>; robotConfigs?: string[] }> {
  if (!Array.isArray(fileNames) || fileNames.length < 1 || fileNames.length > 64 || fileNames.includes(COMMANDS_FILE_NAME)
    || new Set(fileNames.map((name) => isDeployedPathName(name) ? name : validateRobotFileName(name))).size !== fileNames.length) {
    throw new RobotTransportError("invalid_request", "Name between 1 and 64 different .bdx, .bdr or .robot robot files to read");
  }
  return withPinnedReadSession(connection, signal, factory, password, async (session, directory, operation) => {
    const files: Array<{ fileName: string; contents: Buffer | null }> = [];
    let total = 0;
    for (const fileName of fileNames) {
      const file: RobotRemoteFile = { kind: "pathFile", directory, fileName };
      let contents: Buffer | null;
      try {
        contents = await session.exists(file, operation) ? await session.read(file, MAX_BYTES, operation) : null;
      } catch (error) {
        const code = error instanceof RobotTransportError ? error.code : "transfer_failed";
        const detail = error instanceof Error ? error.message : "SFTP read failed";
        throw new RobotTransportError(code, `Could not read ${fileName} from the robot: ${detail}`, { cause: error });
      }
      total += contents?.length ?? 0;
      if (total > MAX_BYTES) throw new RobotTransportError("transfer_failed", "The robot's files total more than 24 MiB; read fewer at once");
      files.push({ fileName, contents });
    }
    if (!files.some((file) => file.contents === null && /\.robot$/i.test(file.fileName))) return { files };
    if (!session.listPathFiles) throw new RobotTransportError("unavailable", "Robot file listing is unavailable");
    const listed = await session.listPathFiles(directory, operation, true);
    return { files, robotConfigs: listed.files.map((file) => file.fileName).sort((a, b) => a.localeCompare(b)).slice(0, 64) };
  });
}

/** Review one deployed path through the same reader as a named batch. */
export async function readRobotPathFile(
  connection: RobotFileConnection, fileName: string, signal?: AbortSignal,
  factory: RobotSftpSessionFactory = connectRobotSftp, password: string | null = null,
): Promise<Buffer | null> {
  if (!isDeployedPathName(fileName)) throw new RobotTransportError("invalid_request", "Choose a safe BDX path basename");
  const { files: [file] } = await readRobotFiles(connection, [fileName], signal, factory, password);
  return file.contents;
}

/** Publishes each reviewed file (paths, routines, a robot's `.robot` file) independently; never activates robot code. */
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
  const paths = Array.isArray(files) ? files.filter((file) => file?.fileName !== COMMANDS_FILE_NAME && !/\.robot$/i.test(file?.fileName ?? "")).length : 0;
  if (paths < 1 || paths > 64) {
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
    // The transport refused before touching the destination, so the file is not "possibly replaced".
    if (error instanceof RobotFileKeptError && error.fileName === publishing) publishing = undefined;
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
