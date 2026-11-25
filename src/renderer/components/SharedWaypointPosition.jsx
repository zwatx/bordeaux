import * as React from "react";
import { PathLinks } from "../lib/pathLinks";
import { UI } from "./ui";

const h = React.createElement;
const waypointName = (index, count) => index === 0 ? 'Start' : index === count - 1 ? 'End' : 'Waypoint ' + index;

export function sharedPositionChoices(project, pathId, index) {
  const allWaypoints = project.paths.flatMap((path) => path.waypoints.flatMap((point, at) =>
    path.id === pathId && at === index ? [] : [{
      value: JSON.stringify([path.id, at]), label: point.positionName || (point.positionLink
        ? PathLinks.waypointName(project, path, at) : path.name + ' / ' + waypointName(at, path.waypoints.length)),
      meta: path.name + ' / ' + waypointName(at, path.waypoints.length), positionName: point.positionName,
      pathId: path.id, index: at, positionLink: point.positionLink,
    }]));
  const connected = PathLinks.positionMembers(project, pathId, index);
  const members = allWaypoints.filter((item) => connected.some((member) => member.pathId === item.pathId && member.index === item.index));
  const seen = new Set();
  const candidates = allWaypoints.filter((item) => {
    if (!item.positionName || members.includes(item)) return false;
    const key = item.positionLink || item.value;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  return { candidates, members };
}

export function SharedWaypointPosition({ project, doc, index, onLink, onName, onOpen }) {
  const waypoint = doc.waypoints[index];
  // The field always shows the point's name: its own, a linked point's, or its place in the path. Typing a different
  // name names the point; clearing it returns to the default. As a project draft, Save and selection commit it.
  const shownName = PathLinks.waypointName(project, doc, index);
  const { candidates, members } = sharedPositionChoices(project, doc.id, index);
  const saveName = (raw) => {
    const trimmed = raw.trim();
    if (!trimmed) { if (waypoint.positionName) onName(index, undefined); }
    else if (trimmed !== shownName) onName(index, trimmed);
  };
  return h('div', { className: 'shared-waypoint-position' },
    h('label', { className: 'linkable-name' }, 'Point name',
      h(UI.DraftText, { className: 'textinput', maxLength: 80, spellCheck: false, value: shownName, owner: doc.id + ':' + index, onCommit: saveName })),

    onOpen ? h('div', { className: 'inrow' },
      h('span', { className: 'inrow-l' }, 'Linked position',
        h('small', { style: { overflowWrap: 'anywhere' } }, members.length ? 'With ' + members.map((item) => waypointName(item.index, project.paths.find((path) => path.id === item.pathId).waypoints.length) + ' · ' + (item.pathId === doc.id ? 'this path' : project.paths.find((path) => path.id === item.pathId).name)).join(', ') : 'Independent')),
      h('button', { type: 'button', id: 'inspector-waypoint-link', className: 'choice-change', onClick: () => onOpen(doc.id, index) }, members.length ? 'Manage…' : 'Link…'))
      : h(UI.ChoiceBrowser, { id: 'waypoint-position-link', label: 'Linked position', value: members[0]?.value || '', resetKey: doc.id + ':' + index,
      placeholder: 'Search named points', emptyText: 'Name a shared point in another path to link it here.',
      items: [...members.slice(0, 1), ...candidates],
      onChange: (value) => { const target = candidates.find((item) => item.value === value); if (target) onLink(index, target); } }),
    !onOpen && (waypoint.positionLink || members.length > 0) && h('div', { className: 'inrow' },
      h('span', { className: 'inrow-l', style: { minWidth: 0, overflowWrap: 'anywhere' }, title: members.map((item) => item.label).join('\n') },
        members.length ? 'Linked to ' + members.length + ' other ' + (members.length === 1 ? 'point' : 'points') : 'No other linked waypoints'),
      h('button', { type: 'button', className: 'choice-change', onClick: () => onLink(index, null) }, 'Unlink')),
    !onOpen && h('div', { className: 'seg-hint' }, members.length ? 'Position is shared. Facing and tangents stay independent.' : ''));
}
