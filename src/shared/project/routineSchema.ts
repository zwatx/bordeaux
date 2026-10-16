const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Inspect only actual authored node positions, using normalization's effective
 * routine source. Wrapper/opaque payload fields never acquire node semantics. */
export function routineFeaturesRequireV11(project: unknown): boolean {
  if (!record(project)) return false;
  const routines = Array.isArray(project.routines) && project.routines.length
    ? project.routines : record(project.routine) ? [project.routine] : [];
  // Match source validity bounds without inspecting ignored or invalid wrappers.
  for (const routine of routines.slice(0, 1024)) {
    if (!record(routine) || !Array.isArray(routine.nodes)) continue;
    const pending = [{ nodes: routine.nodes, index: 0, depth: 0 }];
    let count = 0;
    while (pending.length && count < 100000) {
      const frame = pending[pending.length - 1];
      if (frame.depth > 64 || frame.index >= frame.nodes.length) { pending.pop(); continue; }
      const node: unknown = frame.nodes[frame.index++]; count++;
      if (!record(node)) continue;
      if (node.type === 'repeat' || node.type === 'end') return true;
      const command = node.type === 'function' && node.cat === 'command';
      const wait = node.type === 'builtin' && node.builtinId === 'bordeaux.wait';
      if ((command || wait) && Object.hasOwn(node, 'ends')) return true;
      const children: unknown[] = [];
      if (node.type === 'decision') children.push(node.then, node.else);
      if (command && record(node.outputBranch) && Array.isArray(node.outputBranch.routes)) {
        for (const route of node.outputBranch.routes.slice(0, 256)) if (record(route)) children.push(route.nodes);
      }
      if (node.type === 'generatedTrajectory' && record(node.fallback) && node.fallback.type === 'branch') children.push(node.fallback.nodes);
      for (const nodes of children) if (Array.isArray(nodes)) pending.push({ nodes, index: 0, depth: frame.depth + 1 });
    }
  }
  return false;
}

/** Retain source 1.1 once adopted; codec owns rejection of unsupported versions. */
export function promoteRoutineProjectSchema<T extends { schemaVersion?: string }>(project: T): T {
  return (project.schemaVersion === undefined || project.schemaVersion === '1.0') && routineFeaturesRequireV11(project)
    ? { ...project, schemaVersion: '1.1' } : project;
}
