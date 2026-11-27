import { projectRobots } from '../../core/project/robots';
import { robotFileContents, robotPushFileConflict, robotPushFileName } from '../../core/project/robotFile';
import { sha256Hex } from '../../core/bytes';

/*
 * What this session knows a robot's push folder holds under a `.robot` name: the SHA-256 of the bytes a Push verified
 * there or a Pull read back. An observation belongs to one robot connection: its address and folder and the host key
 * verified for it, so another machine answering at the same address never counts as the same robot. A Pull that finds
 * the file missing forgets it, and so does a Push of it that failed (it may have replaced the file). Everything is forgotten when Bordeaux closes, so an unknown file counts as changed and
 * the next Push includes it.
 */
const known = new Map();
const folder = (directory) => String(directory).replace(/\/+$/, '') || '/';
const key = (connection, fileName) => {
  const endpoint = connection?.endpoint;
  return endpoint && [endpoint.target, endpoint.host.toLowerCase(), endpoint.port, folder(endpoint.directory), connection.hostKeyFingerprint ?? '', fileName].join('|');
};

/** `connection` is the RobotFileConnection (endpoint and verified host key) the bytes were verified or read through. */
export function rememberRobotFile(connection, fileName, sha256) {
  const at = fileName && key(connection, fileName);
  if (at && sha256) known.set(at, sha256);
}

/** Nothing is known about the file at that name any more: a read found none, or a Push of it may have replaced it. */
export function forgetRobotFile(connection, fileName) {
  const at = fileName && key(connection, fileName);
  if (at) known.delete(at);
}

/**
 * The selected robot's `.robot` file as Push would send it, or null for a project without robot details. `conflict`
 * says why it can't be sent when another robot's name maps to the same file (robotPushFileConflict).
 */
export function selectedRobotFile(project) {
  const robot = project?.robot ? projectRobots(project).find((entry) => entry.selected) : null;
  if (!robot?.robot) return null;
  const contents = robotFileContents(robot.name, robot.robot), conflict = robotPushFileConflict(project, robot.id);
  return { robotId: robot.id, name: robot.name, fileName: robotPushFileName(robot.name), size: new TextEncoder().encode(contents).length, sha256: sha256Hex(contents),
    ...(conflict ? { conflict } : {}) };
}

/** 'same' when the robot is known to hold exactly this file, 'changed' when it holds other bytes, 'unknown' otherwise. */
export function robotFileStatus(connection, file) {
  const at = file && key(connection, file.fileName);
  const held = at ? known.get(at) : undefined;
  return held === undefined ? 'unknown' : held === file.sha256 ? 'same' : 'changed';
}
