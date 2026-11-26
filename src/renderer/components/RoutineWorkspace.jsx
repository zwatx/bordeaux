import * as React from 'react';
import { UI } from './ui';
import { PowerAnalysis } from './PowerAnalysis';
import { BandDivider } from './BandDivider';

const h = React.createElement;

/** The preview boundary, said once. Per-step choices and untimed time live in the inspector and transport. */
export const PREVIEW_HELP = 'Preview only; commands and conditions do not run. Push routine uploads a file; robot code validates it before execution.';

// The flow keeps about five rows at the native minimum (1100x720, inspector open) and the field keeps a usable map.
const FLOW_MIN = 140, FLOW_DEFAULT_MIN = 200, FIELD_MIN = 160;
const FIELD_HEIGHT_KEY = 'bordeaux.routines.fieldHeight';
/** The field height the user chose, kept for this window across reloads; null means the default split. */
function storedFieldHeight() {
  try { const value = Number(localStorage.getItem(FIELD_HEIGHT_KEY)); return value > 0 ? value : null; } catch (_) { return null; }
}
function storeFieldHeight(value) {
  try { if (value == null) localStorage.removeItem(FIELD_HEIGHT_KEY); else localStorage.setItem(FIELD_HEIGHT_KEY, String(value)); }
  catch (_) { /* Keep the split for this session when storage is unavailable. */ }
}
/**
 * The split of `room` px (between the header and the transport): the chosen field height, or about 62% of the room
 * while the flow keeps its default minimum, clamped so neither part collapses. `flow` is what the divider reports.
 */
function routineSplit(room, chosen) {
  const max = Math.max(FIELD_MIN, room - FLOW_MIN);
  const wanted = chosen ?? Math.min(room * 0.62, room - FLOW_DEFAULT_MIN);
  const field = Math.round(Math.max(FIELD_MIN, Math.min(max, wanted)));
  return { field, flow: room - field, flowMin: Math.min(FLOW_MIN, room - FIELD_MIN), flowMax: room - FIELD_MIN };
}

/**
 * The Routines place: the field preview over the run-order flow, split by a draggable divider, with status and the
 * transport across the bottom. An empty routine shows the empty field and its first-step slot, without a transport.
 */
export function RoutineWorkspace({ routine, flow, field, transport, status, run, robot }) {
  const [help, setHelp] = React.useState(false);
  const trigger = React.useRef(null), popover = React.useRef(null);
  // An empty routine has nothing to play, so it has no transport.
  const empty = !routine.nodes.length;
  // The split is a window preference like the Paths field focus, not project data, so it lives in localStorage. The
  // field keeps its height and the flow takes what changes (a planning status, a taller transport), so rows hold still.
  const [chosenField, setChosenField] = React.useState(storedFieldHeight);
  const [room, setRoom] = React.useState(0);
  const sectionRef = React.useRef(null), headRef = React.useRef(null), transportRef = React.useRef(null);
  React.useLayoutEffect(() => {
    const measure = () => setRoom(sectionRef.current.clientHeight - headRef.current.offsetHeight - (transportRef.current?.offsetHeight || 0));
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    for (const element of [sectionRef.current, headRef.current, transportRef.current]) if (element) observer?.observe(element);
    return () => observer?.disconnect();
  }, [empty]);
  const split = room > 0 ? routineSplit(room, chosenField) : null;
  const resizeFlow = (flowHeight) => {
    const next = flowHeight == null ? null : room - flowHeight;
    setChosenField(next); storeFieldHeight(next);
  };
  React.useEffect(() => {
    // A native auto popover: the trigger toggles it with pointer, Enter or Space; Escape and outside presses dismiss
    // it. It holds no controls, so focus stays on the trigger; it overlays the field instead of pushing it down.
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

  // The rails' footer strips (library feedback, step inspector) take the transport's height on this page, so their
  // top rules continue the transport's top rule as one line. The transport grows with its rows; without it they keep
  // the shared --side-foot height.
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
  return h('section', { ref: sectionRef, className: 'routine-workspace', 'aria-label': 'Routine workspace: ' + routine.name },
    h('header', { ref: headRef, className: 'routine-workspace-head' },
      h('div', { className: 'routine-workspace-actions' },
        robot && h(PowerAnalysis, { robot, run }),
        h('button', { ref: trigger, type: 'button', className: 'routine-workspace-about', popovertarget: 'routine-preview-notes',
          'aria-expanded': help, 'aria-controls': 'routine-preview-notes', 'aria-label': 'About preview', title: 'About preview',
          // Tabbing on closes it, so it never covers the control that takes focus next.
          onBlur: (event) => { if (event.relatedTarget && help) popover.current.hidePopover(); } },
          h(UI.Icon, { name: 'info', size: 14 })),
        h('div', { ref: popover, id: 'routine-preview-notes', className: 'routine-preview-help', popover: 'auto', role: 'note', 'aria-label': 'About the local preview' },
          h('p', null, PREVIEW_HELP)))),
    h('div', { className: 'routine-workspace-body', style: split ? { '--field-height': split.field + 'px' } : undefined },
      h('div', { className: 'fieldcol routine-workspace-field', 'aria-label': 'Routine field preview' }, field),
      split && h(BandDivider, { className: 'routine-split', height: split.flow, min: split.flowMin, max: split.flowMax, onChange: resizeFlow, label: 'Resize flow' }),
      h('div', { className: 'routine-workspace-flow', 'aria-label': 'Routine flow' }, flow)),
    status,
    !empty && h('div', { ref: transportRef, className: 'routine-workspace-transport' }, transport));
}
