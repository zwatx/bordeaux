import * as React from 'react';
import { PathLinks } from '../lib/pathLinks';
import { UnitPrefs } from '../lib/unitPreferences';
import { UI } from './ui';
import '../styles/point-links.css';

const h = React.createElement;
const length = (value) => UnitPrefs.format(value, 'm', 2);
const location = (point) => length(point.x) + ', ' + length(point.y);
const position = (path, index) => index === 0 ? 'Start' : index === path.waypoints.length - 1 ? 'End' : 'Waypoint ' + index;
const plural = (count, word) => count + ' ' + word + (count === 1 ? '' : 's');
const pointsOf = (count) => plural(count, 'point');
const signed = (value) => (value >= 0 ? '+' : '−') + length(Math.abs(value));
// The field draws +x right and +y up; the arrow points the way the source moves on screen.
function Move({ from, to }) {
  const dx = to.x - from.x, dy = to.y - from.y, distance = Math.hypot(dx, dy);
  if (distance < 5e-4) return h('span', { className: 'pl-move', 'data-none': true }, 'Same place');
  const turn = 90 - Math.atan2(dy, dx) * 180 / Math.PI;
  return h('span', { className: 'pl-move', title: 'Δx ' + signed(dx) + ', Δy ' + signed(dy) },
    h('svg', { width: 12, height: 12, viewBox: '0 0 24 24', 'aria-hidden': true, focusable: false, style: { transform: 'rotate(' + turn.toFixed(1) + 'deg)' } },
      h('path', { d: 'M12 20V4M5 11l7-7 7 7', fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round' })),
    h('span', { className: 'num' }, length(distance)), h('span', { className: 'sr-only' }, ' away'));
}

/**
 * Links one waypoint's position to a point in another path. The source is the waypoint the
 * dialog was opened from; the destination stays where it is and the source (with any points
 * already linked to it) moves there as one Undo step. Heading, speed and tangents stay per visit.
 */
export function PointLinksDialog({ project, request, onApply, onClose }) {
  const ref = React.useRef(null), search = React.useRef(null), list = React.useRef(null), commit = React.useRef(null);
  const [query, setQuery] = React.useState('');
  const [choice, setChoice] = React.useState(null);
  const [cursor, setCursor] = React.useState(null);
  const [notice, setNotice] = React.useState('');
  const path = project.paths.find(item => item.id === request.pathId);
  const index = request.index, point = path?.waypoints[index];
  const pathOf = (id) => project.paths.find(item => item.id === id);
  const members = point ? PathLinks.positionMembers(project, path.id, index) : [];
  const groupName = point && (point.positionLink || members.length) ? PathLinks.waypointName(project, path, index) : '';
  const named = groupName && groupName !== position(path, index) ? groupName : '';
  const choices = point ? PathLinks.linkChoices(project, path.id, index) : [];
  const needle = query.trim().toLowerCase();
  const filtered = choices.filter(item => !needle || (item.label + ' ' + item.meta + ' ' + item.searchText + ' ' + position(pathOf(item.pathId), item.index)).toLowerCase().includes(needle));
  const groups = new Map();
  filtered.forEach(item => { if (!groups.has(item.pathId)) groups.set(item.pathId, []); groups.get(item.pathId).push(item); });
  // A destination hidden by the search is not what the review describes, so it is not chosen.
  const target = filtered.find(item => item.value === choice);
  const targetPath = target && pathOf(target.pathId), targetPoint = targetPath?.waypoints[target.index];
  const moving = members.length + 1;
  const active = filtered.some(item => item.value === cursor) ? cursor : target ? choice : filtered[0]?.value;

  React.useEffect(() => { ref.current.showModal(); search.current?.focus(); }, []);
  const row = (value) => list.current?.querySelector('[data-link-target="' + CSS.escape(value) + '"]');
  const focusRow = (value) => { if (value == null) return; setCursor(value); row(value)?.focus(); };
  const choose = (value) => { setChoice(value); setCursor(value); setNotice(''); };
  const apply = () => { if (point && targetPoint && onApply(path.id, index, target) === 'applied') onClose(); };
  const unlink = () => {
    if (onApply(path.id, index, null) !== 'applied') return;
    setChoice(null);
    setNotice(h(React.Fragment, null, position(path, index) + ' is independent and stays at ', h('span', { className: 'num' }, location(point))));
    search.current?.focus();
  };
  const listKeys = (event) => {
    const at = filtered.findIndex(item => item.value === event.currentTarget.dataset.linkTarget);
    const move = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: filtered.length - 1, PageDown: at + 8, PageUp: at - 8 }[event.key];
    if (move != null) {
      event.preventDefault();
      if (move < 0) { search.current.focus(); return; }
      focusRow(filtered[Math.min(move, filtered.length - 1)].value);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault(); choose(event.currentTarget.dataset.linkTarget);
      // The next Enter links; the review above the button says exactly what moves.
      requestAnimationFrame(() => commit.current?.focus());
    } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) search.current.focus();
  };
  const searchKeys = (event) => {
    if (event.key === 'ArrowDown' && filtered.length) { event.preventDefault(); focusRow(active); }
    else if (event.key === 'Enter' && target) { event.preventDefault(); apply(); }
  };

  const options = [...groups].map(([pathId, items]) => {
    const groupPath = pathOf(pathId);
    return h('li', { key: pathId, role: 'presentation' },
      h('div', { className: 'pl-path', id: 'pl-path-' + pathId, title: groupPath.name }, groupPath.name),
      h('ul', { role: 'group', 'aria-labelledby': 'pl-path-' + pathId, className: 'pl-points' }, items.map(item => {
        const at = groupPath.waypoints[item.index], where = position(groupPath, item.index);
        const own = item.label !== groupPath.name + ' · ' + where ? item.label : '';
        const shared = item.meta.endsWith(' paths') ? 'linked across ' + item.meta : '';
        return h('li', { key: item.value, role: 'presentation' }, h('button', { type: 'button', role: 'option', className: 'pl-option',
          'data-link-target': item.value, 'aria-selected': target === item, tabIndex: item.value === active ? 0 : -1,
          onClick: () => choose(item.value), onFocus: () => setCursor(item.value), onKeyDown: listKeys },
          h('span', { className: 'pl-check', 'aria-hidden': true }, target === item && h(UI.Icon, { name: 'check', size: 14 })),
          h('span', { className: 'pl-text' },
            h('span', { className: 'pl-name', title: own || undefined }, own || where),
            h('span', { className: 'pl-meta' }, own && h('span', null, where), h('span', { className: 'num' }, location(at)), shared && h('span', null, shared))),
          h(Move, { from: point, to: at })));
      })));
  });

  const memberText = (member) => {
    const memberPath = pathOf(member.pathId);
    return position(memberPath, member.index) + ' · ' + (member.pathId === path.id ? 'this path' : memberPath.name);
  };
  let review;
  if (notice) review = h('span', { className: 'pl-review-lead' }, notice);
  else if (!targetPoint) review = h('span', { className: 'pl-review-idle' }, choices.length ? 'Choose a point to see what moves.' : '');
  else {
    const where = position(targetPath, target.index) + ' · ' + targetPath.name;
    // Only a named shared position is worth naming again; an unnamed one is just its point.
    const joining = target.label !== targetPath.name + ' · ' + position(targetPath, target.index);
    const destination = where + (joining ? ' (' + target.label + ')' : '');
    review = h(React.Fragment, null,
      h('span', { className: 'pl-review-lead' }, h('span', null, members.length ? pointsOf(moving) + ' move' : position(path, index) + ' moves'), h(Move, { from: point, to: targetPoint }), h('span', null, 'to'), h('span', { className: 'num' }, location(targetPoint))),
      h('span', { className: 'pl-review-destination', title: destination }, destination),
      h('span', { className: 'pl-review-detail' }, 'The destination stays where it is. Heading, speed and tangents stay local.'));
  }

  return h('dialog', { ref, className: 'pj-sheet point-links', 'aria-labelledby': 'point-links-title', 'aria-describedby': 'point-links-source',
    onCancel: event => { event.preventDefault(); onClose(); }, onKeyDown: event => event.stopPropagation() },
    h('div', { className: 'pl-source' },
      h('h2', { id: 'point-links-title' }, 'Link ' + (point ? position(path, index) : 'point')),
      h('p', { id: 'point-links-source' }, path ? h(React.Fragment, null, h('span', { className: 'pl-source-path', title: path.name }, path.name), point && h('span', { className: 'num' }, location(point))) : 'This path no longer exists.')),
    point && members.length > 0 && h('section', { className: 'pl-members', 'aria-labelledby': 'pl-members-title' },
      h('div', { className: 'pl-members-head' },
        h('h3', { id: 'pl-members-title', title: named || undefined }, 'Linked with ' + pointsOf(members.length) + (named ? ' · ' + named : '')),
        h('button', { type: 'button', className: 'qbtn quiet', 'data-link-unlink': true, onClick: unlink }, 'Unlink this point')),
      h('ul', null, members.map(member => h('li', { key: member.pathId + ':' + member.index }, memberText(member))))),
    point && h('div', { className: 'pj-search' }, h(UI.Icon, { name: 'search', size: 15 }),
      h('input', { ref: search, id: 'link-point-search', type: 'text', value: query, placeholder: 'Find a point in another path', 'aria-label': 'Find a point to link to',
        'aria-controls': 'pl-list', spellCheck: false, autoComplete: 'off', onKeyDown: searchKeys, onChange: event => { setQuery(event.target.value); setCursor(null); } })),
    point && h('ul', { ref: list, id: 'pl-list', className: 'pj-list pl-list', role: 'listbox', 'aria-label': 'Points to link to' },
      filtered.length ? options : h('li', { className: 'pj-empty' }, query ? 'No points match “' + query.trim() + '”.' : 'No other paths have points yet. Add a path to link to it.')),
    !point && path && h('p', { className: 'pj-empty' }, 'This point no longer exists.'),
    h('div', { className: 'pl-review', role: 'status' }, review),
    h('div', { className: 'pj-foot' },
      h('span', { className: 'pl-keys', 'aria-hidden': true }, h('kbd', null, '↑↓'), ' choose', h('kbd', null, '↵'), ' link', h('kbd', null, 'Esc'), ' close'),
      h('span', { className: 'pj-foot-actions' },
        h('button', { type: 'button', className: 'qbtn quiet', onClick: onClose }, 'Cancel'),
        h('button', { ref: commit, type: 'button', className: 'qbtn primary', disabled: !point || !targetPoint, onClick: apply }, members.length ? 'Link ' + pointsOf(moving) : 'Link point'))));
}
