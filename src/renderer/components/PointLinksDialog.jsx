import * as React from 'react';
import { PathLinks } from '../lib/pathLinks';
import { UnitPrefs } from '../lib/unitPreferences';
import { UI } from './ui';
import '../styles/point-links.css';

const h = React.createElement;
const location = (point) => UnitPrefs.format(point.x, 'm', 2) + ', ' + UnitPrefs.format(point.y, 'm', 2);
const position = (path, index) => index === 0 ? 'Start' : index === path.waypoints.length - 1 ? 'End' : 'Waypoint ' + index;

/** Linking is a reviewed position change. Heading, speed and handles remain local to each visit. */
export function PointLinksDialog({ project, request, onApply, onClose }) {
  const ref = React.useRef(null);
  const [index, setIndex] = React.useState(request.index);
  const [query, setQuery] = React.useState('');
  const [choice, setChoice] = React.useState(null);
  const path = project.paths.find(path => path.id === request.pathId);
  const point = path?.waypoints[index];
  const members = point ? PathLinks.positionMembers(project, path.id, index) : [];
  const choices = point ? PathLinks.linkChoices(project, path.id, index) : [];
  const target = choices.find(item => item.value === choice);
  const targetPoint = target && project.paths.find(path => path.id === target.pathId)?.waypoints[target.index];
  const filtered = choices.filter(item => (item.label + ' ' + item.meta + ' ' + item.searchText).toLowerCase().includes(query.trim().toLowerCase()));
  const groups = new Map();
  filtered.forEach(item => { if (!groups.has(item.pathId)) groups.set(item.pathId, []); groups.get(item.pathId).push(item); });
  React.useEffect(() => { ref.current.showModal(); }, []);
  return h('dialog', { ref, className: 'point-links', 'aria-labelledby': 'point-links-title', onCancel: event => { event.preventDefault(); onClose(); }, onKeyDown: event => event.stopPropagation() },
    h('header', null, h('div', null, h('h2', { id: 'point-links-title' }, 'Link points'), h('p', null, 'Share a position between any waypoints. Moving either point moves the others.')),
      h('button', { type: 'button', className: 'quiet', 'aria-label': 'Close point links', onClick: onClose }, h(UI.Icon, { name: 'x', size: 16 }))),
    h('div', { className: 'point-links-body' },
      h('section', { className: 'point-links-source', 'aria-label': 'Point to link' },
        h('h3', null, path?.name || 'Path unavailable'),
        path?.waypoints.length ? h(React.Fragment, null,
          h('label', { htmlFor: 'link-source-point' }, 'Point to link'),
          h('select', { id: 'link-source-point', value: index, onChange: event => { setIndex(Number(event.target.value)); setChoice(null); } },
            path.waypoints.map((point, at) => h('option', { key: at, value: at }, position(path, at) + (point.positionName ? ' · ' + point.positionName : '')))),
          point && h('p', { className: 'num' }, location(point)),
          h('h3', null, 'Linked points'),
          members.length ? h(React.Fragment, null,
            h('ul', null, members.map(member => {
              const memberPath = project.paths.find(path => path.id === member.pathId);
              return h('li', { key: member.pathId + ':' + member.index }, h('strong', null, memberPath.name), h('span', null, position(memberPath, member.index)));
            })),
            h('button', { type: 'button', className: 'qbtn', onClick: () => { onApply(path.id, index, null); setChoice(null); } }, 'Unlink this point'))
            : h('p', null, 'This point is independent.'))
          : h('p', null, 'Place a waypoint before linking this path.')),
      h('section', { className: 'point-links-target', 'aria-label': 'Link destination' },
        h('label', { htmlFor: 'link-point-search' }, 'Link to'),
        h('input', { id: 'link-point-search', type: 'search', placeholder: 'Search paths or points', value: query, onChange: event => setQuery(event.target.value) }),
        h('div', { className: 'point-links-choices', role: 'group', 'aria-label': 'Available points' }, filtered.length ? [...groups].map(([pathId, items]) => {
          const targetPath = project.paths.find(path => path.id === pathId);
          return h('section', { key: pathId, 'aria-label': targetPath.name }, h('h3', null, targetPath.name), items.map(item =>
            h('button', { type: 'button', key: item.value, 'data-link-target': item.value, 'aria-pressed': choice === item.value, onClick: () => setChoice(item.value) },
              h('strong', null, position(targetPath, item.index) + (targetPath.waypoints[item.index].positionName ? ' · ' + targetPath.waypoints[item.index].positionName : '')),
              h('span', { className: 'num' }, location(targetPath.waypoints[item.index]) + (item.meta.endsWith(' paths') ? ' · ' + item.meta : '')))));
        }) : h('p', null, query ? 'No matching points.' : 'No other unlinked points. Add another path to link its waypoints.')))),
    h('div', { className: 'point-links-review', role: 'status' }, targetPoint
      ? h(React.Fragment, null, h('strong', null, 'Move ' + (members.length + 1) + ' point' + (members.length ? 's' : '') + ' to ' + location(targetPoint)),
        h('span', null, 'The destination stays in place. Each point keeps its facing and tangent shape. Undo restores the whole change.'))
      : 'Choose a destination to review the link.'),
    h('footer', null, h('button', { type: 'button', className: 'qbtn', onClick: onClose }, 'Cancel'),
      h('button', { type: 'button', className: 'qbtn primary', disabled: !point || !targetPoint, onClick: () => { if (onApply(path.id, index, target) === 'applied') onClose(); } }, 'Link points')));
}
