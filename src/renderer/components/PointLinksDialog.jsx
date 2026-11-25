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
 * Paths come first and open in place to their points (→ or Enter; ← or Backspace goes back), as
 * the command search opens a subsystem. A search looks through every path's points at once.
 */
export function PointLinksDialog({ project, request, onApply, onClose }) {
  const ref = React.useRef(null), search = React.useRef(null), list = React.useRef(null), commit = React.useRef(null);
  const [query, setQuery] = React.useState('');
  const [choice, setChoice] = React.useState(null);
  const [cursor, setCursor] = React.useState(null);
  const [notice, setNotice] = React.useState('');
  const [scope, setScope] = React.useState(null);
  const path = project.paths.find(item => item.id === request.pathId);
  const index = request.index, point = path?.waypoints[index];
  const pathOf = (id) => project.paths.find(item => item.id === id);
  const members = point ? PathLinks.positionMembers(project, path.id, index) : [];
  const groupName = point && (point.positionLink || members.length) ? PathLinks.waypointName(project, path, index) : '';
  const named = groupName && groupName !== position(path, index) ? groupName : '';
  // Browsing lists each path's own points under their own names, so a position shared by several paths appears in
  // each of them. The destination stays the shared position; a search lists each position once. Built once per
  // project change, not per keystroke.
  const { choices, byPath } = React.useMemo(() => {
    const all = point ? PathLinks.linkChoices(project, path.id, index, { withMembers: true }) : [];
    const lists = new Map();
    all.forEach(item => item.members.forEach(member => {
      if (member.pathId === path.id) return;
      if (!lists.has(member.pathId)) lists.set(member.pathId, []);
      const own = lists.get(member.pathId), memberPath = pathOf(member.pathId), where = position(memberPath, member.index);
      const name = PathLinks.waypointName(project, memberPath, member.index);
      if (!own.some(other => other.value === item.value)) own.push({ ...item, pathId: member.pathId, index: member.index,
        label: name === where ? memberPath.name + ' · ' + where : name, alias: item.label });
    }));
    lists.forEach(items => items.sort((a, b) => a.index - b.index));
    return { choices: all, byPath: lists };
  }, [project, path, index, point]); // eslint-disable-line react-hooks/exhaustive-deps
  // With one other path there is nothing to choose between, so its points show at once.
  const onlyPath = byPath.size === 1 ? [...byPath.keys()][0] : null;
  const openPath = scope && byPath.has(scope) ? scope : onlyPath;
  const scoped = Boolean(openPath && !onlyPath);
  const needle = query.trim().toLowerCase();
  const showingPaths = !openPath && !needle && choices.length > 0;
  const filtered = showingPaths ? [] : (openPath ? byPath.get(openPath) : choices).filter(item => !needle
    || (item.label + ' ' + (item.alias || '') + ' ' + item.meta + ' ' + (scoped ? '' : item.searchText) + ' ' + position(pathOf(item.pathId), item.index)).toLowerCase().includes(needle));
  const groups = new Map();
  filtered.forEach(item => { if (!groups.has(item.pathId)) groups.set(item.pathId, []); groups.get(item.pathId).push(item); });
  const pathKey = (id) => 'path:' + id;
  const rows = showingPaths ? [...byPath.keys()].map(pathKey) : filtered.map(item => item.value);
  // A destination hidden by the search is not what the review describes, so it is not chosen.
  const target = filtered.find(item => item.value === choice);
  const targetPath = target && pathOf(target.pathId), targetPoint = targetPath?.waypoints[target.index];
  const moving = members.length + 1;
  const active = rows.includes(cursor) ? cursor : target ? choice : rows[0];

  React.useEffect(() => { ref.current.showModal(); search.current?.focus(); }, []);
  const row = (key) => list.current?.querySelector(key.startsWith('path:')
    ? '[data-link-path="' + CSS.escape(key.slice(5)) + '"]' : '[data-link-target="' + CSS.escape(key) + '"]');
  const focusRow = (value) => { if (value == null) return; setCursor(value); row(value)?.focus(); };
  const choose = (value) => { setChoice(value); setCursor(value); setNotice(''); };
  // Opening or leaving a path starts its list over; focus follows to the first point, or back to the path it left,
  // once the list that holds it has rendered (the pressed row is gone by then).
  const pendingFocus = React.useRef(null);
  React.useLayoutEffect(() => {
    const key = pendingFocus.current, target = key === 'search' ? search.current : key != null && row(key);
    if (target) { pendingFocus.current = null; target.focus(); }
  });
  const openScope = (pathId) => {
    const first = byPath.get(pathId)?.[0]?.value ?? null;
    pendingFocus.current = first;
    setScope(pathId); setQuery(''); setChoice(null); setCursor(first); setNotice('');
  };
  const leaveScope = (toRow) => {
    const from = openPath;
    pendingFocus.current = toRow ? pathKey(from) : 'search';
    setScope(null); setQuery(''); setChoice(null); setCursor(toRow ? pathKey(from) : null);
  };
  const apply = () => { if (point && targetPoint && onApply(path.id, index, target) === 'applied') onClose(); };
  const unlink = () => {
    if (onApply(path.id, index, null) !== 'applied') return;
    setChoice(null);
    setNotice(h(React.Fragment, null, position(path, index) + ' is independent and stays at ', h('span', { className: 'num' }, location(point))));
    search.current?.focus();
  };
  const listKeys = (event) => {
    const key = event.currentTarget.dataset.linkTarget ?? pathKey(event.currentTarget.dataset.linkPath);
    const pathRow = !event.currentTarget.dataset.linkTarget, at = rows.indexOf(key);
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
    const move = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: rows.length - 1, PageDown: at + 8, PageUp: at - 8 }[event.key];
    if (move != null) {
      event.preventDefault();
      if (move < 0) { search.current.focus(); return; }
      focusRow(rows[Math.min(move, rows.length - 1)]);
    } else if (pathRow && (event.key === 'Enter' || event.key === ' ' || (event.key === 'ArrowRight' && plain))) {
      event.preventDefault(); openScope(event.currentTarget.dataset.linkPath);
    } else if (!pathRow && scoped && plain && (event.key === 'ArrowLeft' || event.key === 'Backspace')) {
      event.preventDefault(); leaveScope(true);
    } else if (!pathRow && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault(); choose(key);
      // The next Enter links; the review above the button says exactly what moves.
      requestAnimationFrame(() => commit.current?.focus());
    } else if (event.key.length === 1 && plain) search.current.focus();
  };
  const searchKeys = (event) => {
    if (event.key === 'ArrowDown' && rows.length) { event.preventDefault(); focusRow(active); }
    else if (event.key === 'Backspace' && scoped && !query) { event.preventDefault(); leaveScope(false); }
    else if (event.key === 'Enter' && target) { event.preventDefault(); apply(); }
  };

  const pathOptions = [...byPath].map(([pathId, items]) => {
    const itemPath = pathOf(pathId);
    const nearest = Math.min(...items.map(item => Math.hypot(itemPath.waypoints[item.index].x - point.x, itemPath.waypoints[item.index].y - point.y)));
    return h('li', { key: pathId },
      h('button', { type: 'button', className: 'pl-option pl-path-option', 'data-link-path': pathId, tabIndex: pathKey(pathId) === active ? 0 : -1,
        'aria-keyshortcuts': 'ArrowRight Enter', onClick: () => openScope(pathId), onFocus: () => setCursor(pathKey(pathId)), onKeyDown: listKeys },
        h('span', { className: 'pl-text' },
          h('span', { className: 'pl-name', title: itemPath.name }, itemPath.name),
          h('span', { className: 'pl-meta' }, h('span', null, pointsOf(items.length)), h('span', null, 'nearest ', h('span', { className: 'num' }, length(nearest))))),
        h('span', { className: 'choice-go', 'aria-hidden': true }, h(UI.Icon, { name: 'chevron', size: 14 }))));
  });
  const options = [...groups].map(([pathId, items]) => {
    const groupPath = pathOf(pathId);
    return h('li', { key: pathId, role: 'presentation' },
      !scoped && h('div', { className: 'pl-path', id: 'pl-path-' + pathId, title: groupPath.name }, groupPath.name),
      h('ul', { role: 'group', 'aria-labelledby': scoped ? undefined : 'pl-path-' + pathId, 'aria-label': scoped ? groupPath.name : undefined, className: 'pl-points' }, items.map(item => {
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
  else if (!targetPoint) review = h('span', { className: 'pl-review-idle' }, !choices.length ? '' : showingPaths ? 'Choose a path, then the point to link to.' : 'Choose a point to see what moves.');
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
      scoped && h('button', { type: 'button', className: 'choice-crumb pl-crumb', tabIndex: -1, title: 'Back to all paths (Backspace)', 'aria-label': 'Leave ' + pathOf(openPath).name,
        onMouseDown: event => event.preventDefault(), onClick: () => leaveScope(false) }, h('span', null, pathOf(openPath).name), h(UI.Icon, { name: 'chevron', size: 12 })),
      h('input', { ref: search, id: 'link-point-search', type: 'text', value: query, placeholder: scoped ? 'Search points in this path' : 'Search paths and points', 'aria-label': scoped ? 'Search points in ' + pathOf(openPath).name : 'Find a point to link to',
        'aria-controls': 'pl-list', spellCheck: false, autoComplete: 'off', onKeyDown: searchKeys, onChange: event => { setQuery(event.target.value); setCursor(null); } })),
    point && (showingPaths
      ? h('ul', { ref: list, id: 'pl-list', className: 'pj-list pl-list', 'aria-label': 'Paths with points to link to' }, pathOptions)
      : h('ul', { ref: list, id: 'pl-list', className: 'pj-list pl-list', role: 'listbox', 'aria-label': 'Points to link to' },
        filtered.length ? options : h('li', { className: 'pj-empty' }, query ? 'No points match “' + query.trim() + '”.' : 'No other paths have points yet. Add a path to link to it.'))),
    !point && path && h('p', { className: 'pj-empty' }, 'This point no longer exists.'),
    h('div', { className: 'pl-review', role: 'status' }, review),
    h('div', { className: 'pj-foot' },
      h('span', { className: 'pl-keys', 'aria-hidden': true }, h('kbd', null, '↑↓'), ' choose',
        showingPaths ? [h('kbd', { key: 'k' }, '→'), ' open'] : [h('kbd', { key: 'k' }, '↵'), ' link'],
        scoped ? [h('kbd', { key: 'b' }, '←'), ' paths'] : [h('kbd', { key: 'b' }, 'Esc'), ' close']),
      h('span', { className: 'pj-foot-actions' },
        h('button', { type: 'button', className: 'qbtn quiet', onClick: onClose }, 'Cancel'),
        h('button', { ref: commit, type: 'button', className: 'qbtn primary', disabled: !point || !targetPoint, onClick: apply }, members.length ? 'Link ' + pointsOf(moving) : 'Link point'))));
}
