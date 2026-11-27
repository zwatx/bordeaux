import * as React from 'react';
import { UI } from './ui';
import { PowerAnalysis } from './PowerAnalysis';

const h = React.createElement;

/** The preview boundary, said once. Per-step choices and untimed time live in the inspector and transport. */
export const PREVIEW_HELP = 'Preview only; commands and conditions do not run. Push routine uploads a file; robot code validates it before execution.';

export function RoutineWorkspace({ routine, flow, field, transport, status, run, robot }) {
  const [view, setView] = React.useState('flow');
  const [help, setHelp] = React.useState(false);
  const trigger = React.useRef(null), popover = React.useRef(null);
  React.useEffect(() => setView('flow'), [routine.id]);
  React.useEffect(() => {
    // A native auto popover: the trigger toggles it with pointer, Enter or Space; Escape and outside presses dismiss
    // it. It holds no controls, so focus stays on the trigger; it overlays the flow instead of pushing it down.
    const element = popover.current;
    const place = () => {
      const anchor = trigger.current.getBoundingClientRect();
      element.style.top = Math.round(anchor.bottom + 6) + 'px';
      element.style.right = Math.max(8, Math.round(window.innerWidth - anchor.right)) + 'px';
    };
    const before = (event) => { if (event.newState === 'open') place(); };
    const toggled = (event) => setHelp(event.newState === 'open');
    element.addEventListener('beforetoggle', before);
    element.addEventListener('toggle', toggled);
    window.addEventListener('resize', place);
    return () => {
      element.removeEventListener('beforetoggle', before);
      element.removeEventListener('toggle', toggled);
      window.removeEventListener('resize', place);
    };
  }, []);

  // An empty routine has nothing to show on the field or to play, so it offers only the flow and its first step.
  const empty = !routine.nodes.length, shown = empty ? 'flow' : view;
  // The rails' footer strips (library feedback, step inspector) take the transport's height on this page, so their
  // top rules continue the transport's top rule as one line. The transport grows with its rows; without it they keep
  // the shared --side-foot height.
  const transportRef = React.useRef(null);
  React.useLayoutEffect(() => {
    const element = transportRef.current, stage = element?.closest('.stage-auto');
    if (!element || !stage) return undefined;
    const measure = () => {
      const height = element.offsetHeight;
      if (height) { stage.style.setProperty('--side-foot', height + 'px'); stage.setAttribute('data-transport-foot', ''); }
      else { stage.style.removeProperty('--side-foot'); stage.removeAttribute('data-transport-foot'); }
    };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    return () => { observer?.disconnect(); stage.style.removeProperty('--side-foot'); stage.removeAttribute('data-transport-foot'); };
  }, [empty]);
  return h('section', { className: 'routine-workspace', 'aria-label': 'Routine workspace: ' + routine.name },
    h('header', { className: 'routine-workspace-head' },
      h('div', { className: 'routine-workspace-actions' },
        robot && h(PowerAnalysis, { robot, run, routine }),
        h('button', { ref: trigger, type: 'button', className: 'routine-workspace-about', popovertarget: 'routine-preview-notes',
          'aria-expanded': help, 'aria-controls': 'routine-preview-notes', 'aria-label': 'About preview', title: 'About preview',
          // Tabbing on closes it, so it never covers the control that takes focus next.
          onBlur: (event) => { if (event.relatedTarget && help) popover.current.hidePopover(); } },
          h(UI.Icon, { name: 'info', size: 14 })),
        h('div', { ref: popover, id: 'routine-preview-notes', className: 'routine-preview-help', popover: 'auto', role: 'note', 'aria-label': 'About the local preview' },
          h('p', null, PREVIEW_HELP)),
        // Two views of one routine: the shared segmented control, not a second row of place tabs.
        !empty && h('div', { className: 'seg routine-workspace-views', role: 'group', 'aria-label': 'Routine view', style: { '--seg-count': 2 } },
          [['flow', 'Flow'], ['field', 'Field preview']].map(([id, label]) => h('button', { key: id, type: 'button', className: 'seg-i' + (view === id ? ' on' : ''), 'aria-pressed': view === id, onClick: () => setView(id) }, label))))),
    h('div', { className: 'routine-workspace-body' },
      h('div', { className: 'routine-workspace-flow', hidden: shown !== 'flow', 'aria-label': 'Routine flow' }, flow),
      h('div', { className: 'fieldcol routine-workspace-field', hidden: shown !== 'field', 'aria-label': 'Routine field preview' }, field)),
    status,
    !empty && h('div', { ref: transportRef, className: 'routine-workspace-transport' }, transport));
}
