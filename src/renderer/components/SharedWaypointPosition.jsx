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
  const [name, setName] = React.useState(waypoint.positionName || '');
  React.useEffect(() => setName(waypoint.positionName || ''), [doc.id, index, waypoint.positionName]);
  const { candidates, members } = sharedPositionChoices(project, doc.id, index);
  const saveName = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== waypoint.positionName) { onName(index, trimmed); setName(trimmed); }
    else setName(waypoint.positionName || '');
  };
  return h('div', { className: 'shared-waypoint-position' },
    h('div', { className: 'inrow first' },
      h('span', { className: 'inrow-l' }, 'Name this point'),
      h(UI.Toggle, { on: !!waypoint.positionName, ariaLabel: 'Name this point', onChange: (on) => onName(index, on ? waypointName(index, doc.waypoints.length) : undefined) })),
    waypoint.positionName && h('label', { className: 'linkable-name' }, 'Point name',
      h('input', { className: 'textinput', 'aria-label': 'Linkable point name', maxLength: 80, value: name,
        onChange: (event) => setName(event.target.value), onBlur: saveName,
        onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } if (event.key === 'Escape') { event.stopPropagation(); setName(waypoint.positionName); } } })),

    onOpen ? h('button', { type: 'button', className: 'qbtn', onClick: () => onOpen(doc.id, index) }, members.length ? 'Manage linked points…' : 'Link points…') : h(UI.ChoiceBrowser, { id: 'waypoint-position-link', label: 'Linked position', value: members[0]?.value || '', resetKey: doc.id + ':' + index,
      placeholder: 'Search named points', emptyText: 'Name a shared point in another path to link it here.',
      items: [...members.slice(0, 1), ...candidates],
      onChange: (value) => { const target = candidates.find((item) => item.value === value); if (target) onLink(index, target); } }),
    (waypoint.positionLink || members.length > 0) && h('div', { className: 'inrow' },
      h('span', { className: 'inrow-l', style: { minWidth: 0, overflowWrap: 'anywhere' }, title: members.map((item) => item.label).join('\n') },
        members.length ? 'Linked to ' + members.length + ' other ' + (members.length === 1 ? 'point' : 'points') : 'No other linked waypoints'),
      h('button', { type: 'button', className: 'choice-change', onClick: () => onLink(index, null) }, 'Unlink')),
    h('div', { className: 'seg-hint' }, members.length ? 'Position is shared. Facing and tangents stay independent.' : ''));
}
