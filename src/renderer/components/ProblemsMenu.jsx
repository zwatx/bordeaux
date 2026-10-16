import * as React from 'react';
import { plainProblem } from './planProblems';
import { UI } from './ui';

const h = React.createElement;
const TAB_TARGETS = 'button,input,select,textarea,a[href],[tabindex],summary';

/** One transient inspection menu; selection and draft preflight belong to PathWorkspace. */
export function ProblemsMenu({ problems, waypointCount, heading }) {
  const trigger = React.useRef(null), menu = React.useRef(null), live = React.useRef(null);
  const latest = React.useRef(problems);
  const [instance, setInstance] = React.useState(null);
  const id = React.useId();
  const focusBack = () => {
    const target = trigger.current?.isConnected ? trigger.current : heading.current;
    target?.focus();
  };
  const close = (restore = false, next = null) => {
    const token = live.current;
    if (!token) return;
    const owned = menu.current?.contains(document.activeElement);
    token.active = false; live.current = null;
    menu.current?.hidePopover(); setInstance(null);
    if (owned) { if (next) next.focus(); else if (restore) focusBack(); }
  };
  React.useLayoutEffect(() => {
    latest.current = problems;
    if (live.current && live.current.issues !== problems.issues) close(true);
  });
  React.useLayoutEffect(() => () => {
    // Never restore into an old path/workspace being removed.
    if (live.current) live.current.active = false;
    live.current = null;
  }, []);
  const open = () => {
    if (live.current) { close(true); return; }
    const captured = problems.issues;
    if (!captured.length || !problems.onInspect() || latest.current.issues !== captured) return;
    const token = { issues: captured, active: true };
    live.current = token; setInstance(token);
  };
  const activate = index => {
    if (!instance?.active || live.current !== instance || latest.current.issues !== instance.issues) return;
    if (latest.current.onSelect(index) === true && instance.active) close(true);
  };
  React.useLayoutEffect(() => {
    if (!instance) return undefined;
    const element = menu.current;
    const dismissed = event => { if (event.newState === 'closed' && live.current === instance) close(false); };
    element.addEventListener('toggle', dismissed);
    element.showPopover({ source: trigger.current });
    const position = () => {
      const anchor = trigger.current.getBoundingClientRect(), bounds = element.getBoundingClientRect();
      const above = anchor.top - 8, below = window.innerHeight - anchor.bottom - 8;
      const top = above >= bounds.height || above > below ? anchor.top - bounds.height - 4 : anchor.bottom + 4;
      element.style.top = Math.max(8, Math.min(top, window.innerHeight - bounds.height - 8)) + 'px';
      element.style.left = Math.max(8, Math.min(anchor.left, window.innerWidth - bounds.width - 8)) + 'px';
    };
    position(); window.addEventListener('resize', position);
    const rows = element.querySelectorAll('[role="menuitemradio"]');
    const selected = problems.selected;
    const row = rows[selected == null ? 0 : selected] || rows[0];
    row?.focus(); row?.scrollIntoView({ block: 'nearest' });
    return () => {
      element.removeEventListener('toggle', dismissed);
      window.removeEventListener('resize', position);
    };
  }, [instance]);

  const press = action => event => {
    event.stopPropagation();
    if (event.button !== 0) { event.preventDefault(); return; }
    // Preflight owns the still-focused draft, before the browser moves focus to this button.
    event.preventDefault(); action();
  };
  const click = action => event => {
    event.preventDefault(); event.stopPropagation();
    if (event.detail === 0) action();
  };
  const composing = event => event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229;
  const triggerKey = event => {
    if (composing(event) || ['Enter', ' ', 'ArrowDown', 'Delete', 'Backspace'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      if (!composing(event) && !event.repeat && ['Enter', ' ', 'ArrowDown'].includes(event.key)) open();
    }
  };
  const menuKey = event => {
    event.stopPropagation();
    if (composing(event) || event.repeat || ['Delete', 'Backspace'].includes(event.key)) { event.preventDefault(); return; }
    if (event.key === 'Escape') { event.preventDefault(); close(true); return; }
    if (event.key === 'Tab') {
      event.preventDefault();
      const targets = [...document.querySelectorAll(TAB_TARGETS)].filter(element => element.tabIndex >= 0
        && !element.disabled && !element.closest('[hidden],[inert]') && element.getClientRects().length && !menu.current.contains(element));
      const index = targets.indexOf(trigger.current);
      close(true, targets[index + (event.shiftKey ? -1 : 1)]);
      return;
    }
    const rows = [...menu.current.querySelectorAll('[role="menuitemradio"]')];
    const index = rows.indexOf(document.activeElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      rows[event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]?.focus();
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault(); if (index >= 0) activate(index);
    }
  };
  const entries = instance?.issues.map(issue => plainProblem(issue, waypointCount)) || [];
  const locations = new Map();
  entries.forEach(plain => { const key = plain.text + '\n' + plain.where; locations.set(key, (locations.get(key) || 0) + 1); });
  return h(React.Fragment, null,
    problems.issues.length > 0 && h('div', { className: 'pp-problems' },
      h('button', { ref: trigger, type: 'button', className: 'problems-trigger', 'data-problems-control': true,
        popovertarget: id, 'aria-haspopup': 'menu', 'aria-controls': id, 'aria-expanded': Boolean(instance?.active),
        onPointerDown: press(open), onClick: click(open), onKeyDown: triggerKey },
        'Problems ', h('span', null, problems.issues.length), h(UI.Icon, { name: 'chevron', size: 12 }))),
    instance && h('div', { ref: menu, id, className: 'problems-menu', popover: 'auto', role: 'menu', 'aria-label': 'Path problems',
      onKeyDown: menuKey, onPointerDown: event => event.stopPropagation(), onPointerMove: event => event.stopPropagation(), onClick: event => event.stopPropagation() },
      problems.stale && h('div', { className: 'problems-updating' }, 'Updating…'),
      entries.map((plain, index) => {
        const issue = instance.issues[index];
        const fraction = Number.isFinite(issue.f0) && Number.isFinite(issue.f1)
          ? (issue.f0 * 100).toFixed(1) + '–' + (issue.f1 * 100).toFixed(1) + '% of path' : '';
        const where = !plain.where ? fraction : locations.get(plain.text + '\n' + plain.where) > 1 && fraction ? plain.where + ' · ' + fraction : plain.where;
        return h('button', { key: index, type: 'button', role: 'menuitemradio', tabIndex: -1,
          'aria-checked': problems.selected === index, 'aria-label': (index + 1) + '. ' + plain.text + (where ? ', ' + where : ''),
          'data-severity': issue.severity || 'error', onPointerDown: press(() => activate(index)), onClick: click(() => activate(index)) },
          h('span', { className: 'problems-ordinal', 'aria-hidden': true }, index + 1),
          h('span', { className: 'problems-copy' }, h('span', null, plain.text), where && h('span', { className: 'problems-location' }, where)),
          problems.selected === index && h(UI.Icon, { name: 'check', size: 12 }));
      })));
}
