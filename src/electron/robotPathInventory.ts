import type { RobotPathFiles, RobotPathRow } from "../core/robotFileDelivery";
import { binaryFileName } from "../core/export/robotBinary";

export interface LocalRobotPath { id: string; name: string; pushable: boolean }

export function pairRobotPathFiles(local: LocalRobotPath[], remote: RobotPathFiles): RobotPathRow[] {
  const names = new Map<string, LocalRobotPath[]>();
  for (const path of local) {
    const fileName = binaryFileName(path.name);
    const competing = names.get(fileName);
    if (competing) competing.push(path);
    else names.set(fileName, [path]);
  }
  const rows: RobotPathRow[] = [];
  const add = (fileName: string, robot?: RobotPathFiles["files"][number]) => {
    const paths = names.get(fileName);
    if (!paths) {
      if (robot) rows.push({ fileName, name: fileName, kind: "robotOnly", robot });
    } else if (paths.length > 1) {
      rows.push({ fileName, name: paths.map(path => path.name).join(" · "), kind: "conflict", robot,
        detail: `${paths.length} local paths use this filename` });
    } else {
      const path = paths[0];
      rows.push({ fileName, name: path.name, pathId: path.id, robot, kind: robot ? "paired" : "localOnly",
        detail: !robot && !path.pushable ? "Finish the local path before pushing" : undefined });
    }
    names.delete(fileName);
  };
  for (const file of remote.files) add(file.fileName, file);
  // A partial listing cannot establish that an unlisted local file is absent.
  if (!remote.truncated) for (const fileName of names.keys()) add(fileName);
  const priority = { robotOnly: 0, conflict: 0, paired: 1, localOnly: 2 };
  return rows.sort((a, b) => priority[a.kind] - priority[b.kind] || a.name.localeCompare(b.name));
}

export function findLocalRobotPath<T extends Pick<LocalRobotPath, "id" | "name">>(paths: T[], id?: string): T | undefined {
  if (id === undefined) return undefined;
  const matches = paths.filter(path => path?.id === id && typeof path.name === "string");
  return matches.length === 1 ? matches[0] : undefined;
}

export function matchLocalRobotPath<T extends Pick<LocalRobotPath, "id" | "name">>(
  paths: T[], fileName: string, selected: T | undefined, deployedId?: string,
): T | undefined {
  return findLocalRobotPath(paths, deployedId) ?? (selected && binaryFileName(selected.name) === fileName ? selected : undefined);
}
