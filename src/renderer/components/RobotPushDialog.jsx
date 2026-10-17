import * as React from 'react';
import { RobotFilePushDialog } from './RobotFilePushDialog';
export { useRobotPushController } from './useRobotPushController';

const h = React.createElement;
const action = (label, onClick, props = {}) => h('button', { type: 'button', onClick, ...props }, label);

function UnavailableRobotPushDialog({ controller: c, onExportBdx }) {
  const dialog = React.useRef(null);
  React.useEffect(() => {
    const element = dialog.current;
    if (c.open && !element.open) element.showModal();
    else if (!c.open && element.open) element.close();
  }, [c.open]);
  return h('dialog', {
    ref: dialog, className: 'robot-push-dialog robot-manager', 'aria-labelledby': 'robot-push-title',
    onCancel: (event) => { event.preventDefault(); c.close(); },
  }, h('header', null, h('h2', { id: 'robot-push-title' }, 'Robot delivery unavailable'),
    action('×', c.close, { className: 'robot-push-close', 'aria-label': 'Close robot delivery' })),
    h('section', { className: 'robot-push-section' }, h('p', null, c.unavailable?.reason || 'Robot file transfer is unavailable in this editor.'),
      h('div', { className: 'robot-push-actions' }, action('Close', c.close),
        c.unavailable?.pathId && onExportBdx && action('Export path as BDX', () => { c.close(); onExportBdx(c.unavailable.pathId); }, { className: 'primary' }))));
}

export function RobotPushDialog(props) {
  return h(props.controller.fileTransfer ? RobotFilePushDialog : UnavailableRobotPushDialog, props);
}
