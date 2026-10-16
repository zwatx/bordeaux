import * as React from 'react';
import { createPortal } from 'react-dom';
import { LabviewProjectSources } from './LabviewProjectSources';

const h = React.createElement;
export default function RobotCodeSourcesDialog({ catalog, onClose }) {
  const dialog = React.useRef(null);
  // Opens on search, its purpose, rather than the first focusable scroller.
  React.useLayoutEffect(() => { dialog.current.showModal(); dialog.current.querySelector('input')?.focus(); }, []);
  const close = () => { dialog.current.close(); onClose(); };
  return createPortal(h('dialog', { ref: dialog, className: 'pj-sheet robot-code-sources', 'aria-labelledby': 'robot-code-sources-title',
    onCancel: event => { event.preventDefault(); close(); }, onKeyDown: event => event.stopPropagation() },
    h('div', { className: 'pj-progress', id: 'robot-code-sources-title' }, catalog.projectName),
    h('div', { className: 'pj-list' }, h(LabviewProjectSources, { catalog, initiallyExpanded: true })),
    h('div', { className: 'pj-foot' }, h('button', { type: 'button', className: 'qbtn', onClick: close }, 'Close'))), document.body);
}
