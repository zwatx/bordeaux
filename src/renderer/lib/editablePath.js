import { clone } from "../../core/project/defaults";

/**
 * Deep-copies a path's authored data for editing and history. The accepted
 * artifact is immutable output, so every copy shares it by reference; editing
 * code replaces `optimization.accepted` and never mutates it.
 */
export function editablePath(path) {
  const accepted = path.optimization?.accepted;
  if (!accepted) return clone(path);
  const copy = clone({ ...path, optimization: { ...path.optimization, accepted: undefined } });
  copy.optimization.accepted = accepted;
  return copy;
}
