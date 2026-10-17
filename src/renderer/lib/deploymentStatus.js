import { routineChildLists } from "../../shared/routineChildren";

function pathInput(path) {
  if (!path) return null;
  return Object.fromEntries(Object.entries(path).filter(([key]) => key !== 'folderId' && !key.startsWith('_')));
}

function referencedPaths(nodes, ids = new Set()) {
  const pending = [nodes || []]; let count = 0;
  while (pending.length && count < 100000) {
    for (const node of pending.pop()) {
      count++;
      if (node.type === 'path') ids.add(node.ref);
      for (const list of routineChildLists(node)) pending.push(list.nodes);
    }
  }
  return ids;
}

// Used only to invalidate a verified compiled comparison, never to claim robot equality.
export function deploymentInputKey(project, kind, id, catalogKey) {
  const { planning, footprintPreset, ...robot } = project.robot || {};
  const context = { robot, field: project.field, catalogKey };
  if (kind === 'path') return JSON.stringify({ ...context, path: pathInput(project.paths.find((path) => path.id === id)) });
  const routine = project.routines.find((item) => item.id === id);
  const ids = referencedPaths(routine?.nodes);
  let expanded;
  do {
    expanded = false;
    for (const link of project.pathLinks || []) {
      if (!ids.has(link.fromPathId) && !ids.has(link.toPathId)) continue;
      for (const pathId of [link.fromPathId, link.toPathId]) if (!ids.has(pathId)) { ids.add(pathId); expanded = true; }
    }
  } while (expanded);
  return JSON.stringify({ ...context, routine, paths: project.paths.filter((path) => ids.has(path.id)).map(pathInput) });
}

export function deploymentInputKeys(project, catalogKey) {
  return {
    paths: Object.fromEntries(project.paths.map((path) => [path.id, deploymentInputKey(project, 'path', path.id, catalogKey)])),
    routines: Object.fromEntries(project.routines.map((routine) => [routine.id, deploymentInputKey(project, 'routine', routine.id, catalogKey)])),
  };
}

export function deploymentItemStatus(comparison, sourceKey, currentKey, verifiedAt, now = Date.now()) {
  if (!comparison || !verifiedAt) return { label: 'Unknown', detail: 'Refresh the robot library to compare this item.', tone: 'muted' };
  const when = Date.parse(verifiedAt);
  const checked = 'Checked ' + new Date(when).toLocaleTimeString();
  if (now - when > 60_000) return { label: 'Unknown', detail: checked + '. Refresh to verify the current robot revision.', tone: 'muted' };
  if (sourceKey !== currentKey) return { label: 'Changed', detail: 'Local inputs changed since the last comparison. ' + checked, tone: 'changed' };
  const labels = { matches: 'Matches robot', changed: 'Changed', missing: 'Not on robot', invalid: 'Needs attention', unknown: 'Unknown' };
  return { label: labels[comparison.state] || 'Unknown', detail: comparison.message || checked,
    tone: comparison.state === 'matches' ? 'success' : comparison.state === 'invalid' ? 'error' : comparison.state === 'changed' ? 'changed' : 'muted' };
}
