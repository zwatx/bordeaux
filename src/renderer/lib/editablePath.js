import { clone } from "../../core/project/defaults";

/** Deep-copies a path's authored data for editing and history. */
export function editablePath(path) {
  return clone(path);
}
