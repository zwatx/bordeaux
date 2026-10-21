import * as React from "react";
import { UI } from "./ui";

const h = React.createElement;

export function FieldStatus({ notices }) {
  return notices.length ? h(VisibleFieldStatus, { notices }) : null;
}

function VisibleFieldStatus({ notices }) {
  const root = React.useRef(null);
  const latest = React.useRef(notices);
  const [interaction, setInteraction] = React.useState({ pointer: false, focus: false, expanded: false });
  const transient = notices.find((notice) => notice.autoDismissMs > 0 && notice.action);
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
  const primary = notices[0];
  const action = notices.find((notice) => notice.action)?.action;
  return h('div', { ref: root, className: 'field-status ' + (primary.error ? 'error' : ''),
    onPointerEnter: () => setInteraction((current) => ({ ...current, pointer: true })),
    onPointerLeave: () => setInteraction((current) => ({ ...current, pointer: false })),
    onFocusCapture: () => setInteraction((current) => ({ ...current, focus: true })),
    onBlurCapture: (event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setInteraction((current) => ({ ...current, focus: false }));
    } },
    h('details', { onToggle: (event) => {
      const expanded = event.currentTarget.open;
      setInteraction((current) => ({ ...current, expanded }));
    } },
      h('summary', null,
        h(UI.Icon, { name: 'info', size: 14 }),
        h('span', { className: 'field-status-label', role: primary.error ? 'alert' : 'status' }, primary.label),
        h('span', { className: 'field-status-disclosure' }, 'Details', notices.length > 1 ? ' (' + notices.length + ')' : ''),
        h(UI.Icon, { name: 'chevron', size: 12 })),
      h('div', { className: 'field-status-details' }, notices.map((notice) =>
        h('div', { key: notice.id, className: 'field-status-item' },
          h('strong', null, notice.label),
          h('p', null, notice.detail),
          notice.action && h('button', { type: 'button', onClick: notice.action.onClick }, notice.action.label))))),
    action && h('button', { type: 'button', className: 'field-status-action', onClick: action.onClick }, action.label));
}
