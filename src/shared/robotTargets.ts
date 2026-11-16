/**
 * Robot controllers that receive path files over SSH/SFTP. Each target owns the account
 * Bordeaux logs in as and the directories an upload may write at or below. Uploads never
 * create an account or system root; they only create folders inside an existing one.
 */
export interface RobotTarget {
  label: string;
  username: string;
  password: string;
  /** Uploads may write only at or below one of these absolute directories. */
  directoryRoots: readonly string[];
  /** Where the robot runtime reads path and routine files by default. */
  defaultDirectory: string;
  hostPlaceholder: string;
}

export const ROBOT_TARGETS = {
  roborio: {
    label: "roboRIO",
    username: "admin",
    password: "",
    directoryRoots: ["/natinst/bin/Paths", "/home/lvuser"],
    defaultDirectory: "/home/lvuser/natinst/bin/Paths",
    hostPlaceholder: "roborio-2468-frc.local",
  },
  // LabVIEW runs in a container that mounts the host's /home at the same path, so files
  // below /home/systemcore are visible to the robot code unchanged.
  systemcore: {
    label: "Systemcore",
    username: "systemcore",
    password: "systemcore",
    directoryRoots: ["/home/systemcore"],
    defaultDirectory: "/home/systemcore/bordeaux/paths",
    hostPlaceholder: "robot.local",
  },
} as const satisfies Record<string, RobotTarget>;

export type RobotTargetId = keyof typeof ROBOT_TARGETS;
export type RobotTargetUsername = (typeof ROBOT_TARGETS)[RobotTargetId]["username"];

/** Settings saved before robot types existed always described a roboRIO. */
export const LEGACY_ROBOT_TARGET: RobotTargetId = "roborio";

export const isRobotTargetId = (value: unknown): value is RobotTargetId =>
  typeof value === "string" && Object.hasOwn(ROBOT_TARGETS, value);

/** Every root any target allows: the SFTP session's last guard against arbitrary remote paths. */
export const ROBOT_DIRECTORY_ROOTS: readonly string[] = [...new Set(Object.values(ROBOT_TARGETS).flatMap((target) => target.directoryRoots))];
