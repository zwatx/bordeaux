// Project-local shared positions. Heading and tangent geometry belong to each waypoint.
  const positionChanged = (before, after) => !!before && !!after && (before.x !== after.x || before.y !== after.y);

  // Retain the existing API name for endpoint-link callers; only position is shared.
  function copyPose(target, source) {
    const next = { ...target }, dx = source.x - target.x, dy = source.y - target.y;
    next.x = source.x; next.y = source.y;
    if (next.prevC) next.prevC = { x: next.prevC.x + dx, y: next.prevC.y + dy };
    if (next.nextC) next.nextC = { x: next.nextC.x + dx, y: next.nextC.y + dy };
    return next;
  }

  function positionGraph(project) {
    const members = new Map(), adjacent = new Map(), groups = new Map();
    const join = (a, b) => {
      if (!members.has(a) || !members.has(b)) return;
      if (!adjacent.has(a)) adjacent.set(a, new Set());
      if (!adjacent.has(b)) adjacent.set(b, new Set());
      adjacent.get(a).add(b); adjacent.get(b).add(a);
    };
    project.paths.forEach((path, pi) => path.waypoints.forEach((waypoint, wi) => {
      const key = pi + ':' + wi;
      members.set(key, { pi, wi, waypoint });
      if (!waypoint.positionLink) return;
      const group = groups.get(waypoint.positionLink) || [];
      if (group.length) join(group[0], key);
      group.push(key); groups.set(waypoint.positionLink, group);
    }));
    (project.pathLinks || []).forEach((link) => {
      const from = project.paths.findIndex((path) => path.id === link.fromPathId);
      const to = project.paths.findIndex((path) => path.id === link.toPathId);
      if (from >= 0 && to >= 0) join(from + ':' + (project.paths[from].waypoints.length - 1), to + ':0');
    });
    return { members, adjacent, groups };
  }

  function propagate(project, graph, seeds) {
    const paths = project.paths.slice(), copiedPaths = new Set(), visited = new Set();
    // Each connected set is visited once, including cycles mixing endpoint and position links.
    for (const { key, position } of seeds) {
      const queue = [key];
      for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const current = queue[cursor];
        if (visited.has(current)) continue;
        const member = graph.members.get(current); if (!member) continue;
        visited.add(current);
        const { pi, wi } = member;
        if (positionChanged(paths[pi].waypoints[wi], position)) {
          if (!copiedPaths.has(pi)) { paths[pi] = { ...paths[pi], waypoints: paths[pi].waypoints.slice() }; copiedPaths.add(pi); }
          paths[pi].waypoints[wi] = copyPose(paths[pi].waypoints[wi], position);
        }
        for (const next of graph.adjacent.get(current) || []) queue.push(next);
      }
    }
    return copiedPaths.size ? { ...project, paths } : project;
  }

  function connectedKeys(graph, seeds) {
    const queue = seeds.slice(), visited = new Set();
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const key = queue[cursor];
      if (visited.has(key) || !graph.members.has(key)) continue;
      visited.add(key);
      for (const next of graph.adjacent.get(key) || []) queue.push(next);
    }
    return visited;
  }

  function positionMembers(project, pathId, index) {
    const pi = project.paths.findIndex((path) => path.id === pathId), key = pi + ':' + index;
    const graph = positionGraph(project);
    return [...connectedKeys(graph, [key])].filter((memberKey) => memberKey !== key).map((memberKey) => {
      const member = graph.members.get(memberKey);
      return { pathId: project.paths[member.pi].id, index: member.wi };
    });
  }

  function groupOccurrences(path) {
    const groups = new Map();
    path.waypoints.forEach((waypoint, index) => {
      if (!waypoint.positionLink) return;
      const members = groups.get(waypoint.positionLink) || [];
      members.push({ waypoint, index }); groups.set(waypoint.positionLink, members);
    });
    return groups;
  }

  function sync(project, changedId, before) {
    const pi = project.paths.findIndex((path) => path.id === changedId);
    if (pi < 0 || !before) return project;
    const current = project.paths[pi], seeds = [];
    const add = (index, position) => seeds.push({ key: pi + ':' + index, position });
    for (const [oldIndex, newIndex] of [[0, 0], [before.waypoints.length - 1, current.waypoints.length - 1]]) {
      if (positionChanged(before.waypoints[oldIndex], current.waypoints[newIndex])) add(newIndex, current.waypoints[newIndex]);
    }
    const previousGroups = groupOccurrences(before);
    for (const [id, members] of groupOccurrences(current)) {
      const previous = previousGroups.get(id);
      if (!previous) continue;
      // Indices may shift after insertion/deletion; compare occurrences within the same group.
      // A structural count change retains the prior anchor rather than broadcasting a new copy.
      if (members.length !== previous.length) { add(members[0].index, previous[0].waypoint); continue; }
      const moved = members.find((member, index) => positionChanged(previous[index].waypoint, member.waypoint));
      if (moved) add(moved.index, moved.waypoint);
    }
    return seeds.length ? propagate(project, positionGraph(project), seeds) : project;
  }

  function reconcile(project) {
    const graph = positionGraph(project), seeds = [];
    // Existing endpoint links retain their source-first load behavior.
    (project.pathLinks || []).forEach((link) => {
      const pi = project.paths.findIndex((path) => path.id === link.fromPathId);
      if (pi < 0) return;
      const wi = project.paths[pi].waypoints.length - 1;
      if (wi >= 0) seeds.push({ key: pi + ':' + wi, position: project.paths[pi].waypoints[wi] });
    });
    for (const members of graph.groups.values()) seeds.push({ key: members[0], position: graph.members.get(members[0]).waypoint });
    return propagate(project, graph, seeds);
  }

  function linkPosition(project, pathId, index, targetPathId, targetIndex, groupId) {
    const source = project.paths.find((path) => path.id === pathId)?.waypoints[index];
    const target = project.paths.find((path) => path.id === targetPathId)?.waypoints[targetIndex];
    if (!source || !target || (pathId === targetPathId && index === targetIndex)) return project;
    const id = target.positionLink || source.positionLink || groupId;
    if (typeof id !== 'string' || !id.trim()) return project;
    const sourceIndex = project.paths.findIndex((path) => path.id === pathId), targetPathIndex = project.paths.findIndex((path) => path.id === targetPathId);
    const merged = connectedKeys(positionGraph(project), [sourceIndex + ':' + index, targetPathIndex + ':' + targetIndex]);
    const paths = project.paths.map((path, pi) => {
      let changed = false;
      const waypoints = path.waypoints.map((waypoint, wi) => {
        if (!merged.has(pi + ':' + wi)) return waypoint;
        changed = true; return { ...waypoint, positionLink: id };
      });
      return changed ? { ...path, waypoints } : path;
    });
    const linked = { ...project, paths }, graph = positionGraph(linked);
    return propagate(linked, graph, [{ key: graph.groups.get(id)[0], position: target }]);
  }

  function unlinkPosition(project, pathId, index) {
    const pi = project.paths.findIndex((path) => path.id === pathId), waypoint = project.paths[pi]?.waypoints[index];
    if (!waypoint) return project;
    const pathLinks = (project.pathLinks || []).filter((link) => !((index === 0 && link.toPathId === pathId) || (index === project.paths[pi].waypoints.length - 1 && link.fromPathId === pathId)));
    if (!waypoint.positionLink && pathLinks.length === (project.pathLinks || []).length) return project;
    const paths = project.paths.slice();
    if (waypoint.positionLink) {
      const next = { ...waypoint }; delete next.positionLink;
      const waypoints = paths[pi].waypoints.slice(); waypoints[index] = next;
      paths[pi] = { ...paths[pi], waypoints };
    }
    return { ...project, paths, pathLinks };
  }

// Resolve names through a shared position without copying names into each member.
function waypointName(project, path, index) {
  const waypoint = path?.waypoints?.[index];
  if (waypoint?.positionName) return waypoint.positionName;
  if (project && waypoint?.positionLink) {
    for (const candidate of project.paths || []) {
      const named = candidate.waypoints.find((point) => point.positionLink === waypoint.positionLink && point.positionName);
      if (named) return named.positionName;
    }
  }
  return index === 0 ? 'Start' : index === (path?.waypoints?.length || 0) - 1 ? 'End' : 'Waypoint ' + index;
}

// One choice per connected position, including unnamed points and legacy endpoint links.
function linkChoices(project, pathId, index) {
  const pi = project.paths.findIndex((path) => path.id === pathId), graph = positionGraph(project);
  const selected = pi + ':' + index;
  if (!graph.members.has(selected)) return [];
  const visited = connectedKeys(graph, [selected]), choices = [];
  for (const key of graph.members.keys()) {
    if (visited.has(key)) continue;
    const component = connectedKeys(graph, [key]);
    component.forEach((member) => visited.add(member));
    const members = [...component].map((member) => graph.members.get(member)).sort((a, b) => a.pi - b.pi || a.wi - b.wi);
    const representative = members.find((member) => member.pi !== pi);
    if (!representative) continue;
    const path = project.paths[representative.pi], at = representative.wi;
    const position = at === 0 ? 'Start' : at === path.waypoints.length - 1 ? 'End' : 'Waypoint ' + at;
    const named = members.find((member) => member.waypoint.positionName);
    const paths = [...new Set(members.map((member) => member.pi))];
    choices.push({ value: path.id + ':' + at, pathId: path.id, index: at,
      label: named ? named.waypoint.positionName : path.name + ' · ' + position,
      meta: paths.length > 1 ? paths.length + ' paths' : named ? path.name + ' · ' + position : '',
      searchText: paths.map((member) => project.paths[member].name).join(' ') });
  }
  const order = new Map(project.paths.map((path, at) => [path.id, at]));
  return choices.sort((a, b) => order.get(a.pathId) - order.get(b.pathId) || a.index - b.index);
}

// linkPosition has already merged endpoint-connected members under this group id.
function nameNewSharedPoint(project, pathId, index) {
  const pi = project.paths.findIndex((path) => path.id === pathId), waypoint = project.paths[pi]?.waypoints[index];
  if (!waypoint?.positionLink) return project;
  const points = project.paths.flatMap((path) => path.waypoints);
  if (points.some((point) => point.positionLink === waypoint.positionLink && point.positionName)) return project;
  const names = new Set(points.filter((point) => typeof point.positionName === 'string').map((point) => point.positionName.trim().toLowerCase()));
  let number = 1;
  while (names.has('shared point ' + number)) number += 1;
  const paths = project.paths.slice(), waypoints = paths[pi].waypoints.slice();
  waypoints[index] = { ...waypoint, positionName: 'Shared point ' + number };
  paths[pi] = { ...paths[pi], waypoints };
  return { ...project, paths };
}

export const PathLinks = { copyPose, sync, reconcile, linkPosition, unlinkPosition, positionMembers, waypointName, linkChoices, nameNewSharedPoint };
