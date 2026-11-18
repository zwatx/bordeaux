import * as React from "react";
import { UI } from "./ui";

const h = React.createElement;

/** Problems lead: an error is never summarized under a success. Otherwise the caller's order stands. */
export function orderNotices(notices) {
  return [...notices.filter((notice) => notice.error), ...notices.filter((notice) => !notice.error)];
}

/** Ordinary success that expires on its own (an export). Its action is how it retires, not a choice to offer. */
export function isConfirmation(notice) {
  return !notice.error && notice.autoDismissMs > 0 && typeof notice.action?.onClick === 'function';
}

export function FieldStatus({ notices }) {
  if (!notices.length) return null;
  // Only confirmations: a quiet line that leaves by itself. Anything else gets the full status, with the confirmation
  // listed in its details. Distinct components, so switching remounts and the full status's focus return still runs.
  return notices.every(isConfirmation)
    ? h(FieldConfirmation, { key: 'confirmation', notice: notices[0] })
    : h(VisibleFieldStatus, { key: 'status', notices: orderNotices(notices) });
}

function FieldConfirmation({ notice }) {
  const root = React.useRef(null);
  const latest = React.useRef(notice);
  const [hovered, setHovered] = React.useState(false);
  React.useLayoutEffect(() => { latest.current = notice; });
  React.useEffect(() => {
    // Hover pauses expiry so the detail tooltip can be read; nothing here takes focus, so focus never blocks it.
    if (hovered) return;
    const timer = setTimeout(() => {
      const current = latest.current;
      // An old export must never dismiss its replacement.
      if (current.id === notice.id && current.dismissKey === notice.dismissKey && !root.current?.matches(':hover')) current.action.onClick();
    }, notice.autoDismissMs);
    return () => clearTimeout(timer);
  }, [notice.id, notice.dismissKey, notice.autoDismissMs, hovered]);
  return h('div', { ref: root, className: 'field-status field-confirmation', title: notice.detail || undefined,
    onPointerEnter: () => setHovered(true), onPointerLeave: () => setHovered(false) },
    h(UI.Icon, { name: 'check', size: 14 }),
    h('span', { key: notice.id, className: 'field-status-label', role: 'status' }, notice.label,
      notice.detail && h('span', { className: 'sr-only' }, '. ' + notice.detail)));
}

function VisibleFieldStatus({ notices }) {
  const root = React.useRef(null);
  const latest = React.useRef(notices);
  // Where keyboard focus came from, so an action that retires its own notice does not drop focus to the page.
  const origin = React.useRef(null);
  const [interaction, setInteraction] = React.useState({ pointer: false, focus: false, expanded: false });
  const transient = notices.find(isConfirmation);
  React.useLayoutEffect(() => { latest.current = notices; });
  React.useEffect(() => {
    if (!transient || interaction.pointer || interaction.focus || interaction.expanded) return;
    const timer = setTimeout(() => {
      // An old export must never dismiss its replacement or steal keyboard focus.
      const current = latest.current.find((notice) => notice.id === transient.id && notice.dismissKey === transient.dismissKey);
      if (current && !root.current?.matches(':hover') && !root.current?.contains(document.activeElement) && !root.current?.querySelector('details[open]')) current.action.onClick();
    }, transient.autoDismissMs);
    return () => clearTimeout(timer);
  }, [transient?.id, transient?.dismissKey, transient?.autoDismissMs, interaction]);
  // Focus stays with the status while it has notices left, else returns to where it came from.
  // The origin can go with the notice (a fixed problem's marker): then the field takes focus, else the current place.
  // A retry can make it briefly inert while the path replans, so this waits a little, and only while nothing else has focus.
  React.useEffect(() => () => {
    if (!origin.current) return;
    const { element, field } = origin.current, until = performance.now() + 3000;
    const restore = () => {
      if (document.activeElement && document.activeElement !== document.body) return;
      const back = [element, field, document.querySelector('.toolbar .place[aria-current="page"]')].find((item) => item?.isConnected);
      if (back && !back.closest('[inert]')) back.focus();
      else if (back && performance.now() < until) requestAnimationFrame(restore);
    };
    requestAnimationFrame(restore);
  }, []);
  const run = (action) => () => {
    const owned = root.current?.contains(document.activeElement);
    action.onClick();
    if (owned) requestAnimationFrame(() => {
      if (root.current?.isConnected && (!document.activeElement || document.activeElement === document.body)) root.current.querySelector('summary')?.focus();
    });
  };
  // The label and its severity come from the leading notice, and so does the outside action when it has one. A notice
  // without one (automatic work) lends the place to the next action, which then names its own notice.
  // A confirmation's action only retires it, so it is never offered as a button.
  const primary = notices[0];
  const actionable = (notice) => notice.action && !isConfirmation(notice);
  const owner = actionable(primary) ? primary : notices.find(actionable);
  const action = owner?.action;
  return h('div', { ref: root, className: 'field-status ' + (primary.error ? 'error' : ''),
    onPointerEnter: () => setInteraction((current) => ({ ...current, pointer: true })),
    onPointerLeave: () => setInteraction((current) => ({ ...current, pointer: false })),
    onFocusCapture: (event) => {
      // Field markers come and go with problems; the field itself is the stable place to come back to.
      if (!event.currentTarget.contains(event.relatedTarget)) origin.current = { element: event.relatedTarget?.closest?.('.fieldsvg[tabindex="0"]') || event.relatedTarget,
        field: event.currentTarget.closest('.fieldcol')?.querySelector('.fieldsvg[tabindex="0"]') };
      setInteraction((current) => ({ ...current, focus: true }));
    },
    onBlurCapture: (event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setInteraction((current) => ({ ...current, focus: false }));
    } },
    h('details', { onToggle: (event) => {
      const expanded = event.currentTarget.open;
      setInteraction((current) => ({ ...current, expanded }));
    } },
      h('summary', null,
        h(UI.Icon, { name: 'info', size: 14 }),
        // Keyed by notice, so a replacement is a new live region and is announced (an error as an alert).
        h('span', { key: primary.id, className: 'field-status-label', role: primary.error ? 'alert' : 'status' }, primary.label),
        h('span', { className: 'field-status-disclosure' }, 'Details', notices.length > 1 ? ' (' + notices.length + ')' : ''),
        h(UI.Icon, { name: 'chevron', size: 12 })),
      h('div', { className: 'field-status-details' }, notices.map((notice) =>
        h('div', { key: notice.id, className: 'field-status-item' + (notice.error ? ' error' : '') },
          h('strong', null, notice.label),
          h('p', null, notice.detail),
          // The action beside the summary is not listed a second time.
          notice !== owner && actionable(notice) && h('button', { type: 'button', onClick: run(notice.action) }, notice.action.label))))),
    action && h('button', { key: owner.id, type: 'button', className: 'field-status-action', onClick: run(action),
      'aria-label': owner === primary ? undefined : action.label + ': ' + owner.label }, action.label));
}
