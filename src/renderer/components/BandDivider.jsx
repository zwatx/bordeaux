import * as React from 'react';
import { PointerDrag } from '../hooks/usePointerDrag';

const h = React.createElement;

/**
 * The horizontal separator above a band (the Paths timeline, the Routines flow). `height` is the band's height below
 * it: drag, or with focus ArrowUp/ArrowDown (Shift for larger steps) and Home/End. Enter or double-click calls
 * `onChange(null)` so the owner returns to its default height.
 */
export function BandDivider({ height, min, max, onChange, label, className = '' }) {
  const pointerDrag = PointerDrag.useController();
  const clamp = (value) => Math.round(Math.max(min, Math.min(max, value)));
  return h('div', { className: 'band-divider' + (className ? ' ' + className : ''), role: 'separator', tabIndex: 0, 'aria-orientation': 'horizontal', 'aria-label': label,
    'aria-valuemin': Math.round(min), 'aria-valuemax': Math.round(max), 'aria-valuenow': Math.round(height), title: 'Drag to resize · double-click to reset',
    onPointerDown: (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const y0 = event.clientY, start = height;
      pointerDrag.start(event, { cursor: 'ns-resize', move: (next) => onChange(clamp(start - (next.clientY - y0))) });
    },
    onDoubleClick: () => onChange(null),
    onKeyDown: (event) => {
      const step = event.shiftKey ? 64 : 16;
      const next = { ArrowUp: height + step, ArrowDown: height - step, Home: min, End: max }[event.key];
      if (next != null) { event.preventDefault(); event.stopPropagation(); onChange(clamp(next)); }
      else if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); onChange(null); }
    } });
}
