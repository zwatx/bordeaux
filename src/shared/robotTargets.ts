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
} as const satisfies Record<string, RobotTarget>;

export type RobotTargetId = keyof typeof ROBOT_TARGETS;
export type RobotTargetUsername = (typeof ROBOT_TARGETS)[RobotTargetId]["username"];

/** Every root any target allows: the SFTP session's last guard against arbitrary remote paths. */
export const ROBOT_DIRECTORY_ROOTS: readonly string[] = [...new Set(Object.values(ROBOT_TARGETS).flatMap((target) => target.directoryRoots))];
