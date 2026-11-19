import * as React from 'react';
import { UI } from './ui';

const h = React.createElement;

// Glyphs the shared icon set lacks, drawn in its 24px line style.
const EXTRA_GLYPHS = {
  repeat: 'M17 2l3 3-3 3 M4 11V9a4 4 0 0 1 4-4h12 M7 22l-3-3 3-3 M20 13v2a4 4 0 0 1-4 4H4',
  exit: 'M10 7V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-2 M15 12H3 M6 9l-3 3 3 3',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  join: 'M7 3v4a5 5 0 0 0 5 5 M17 3v4a5 5 0 0 1-5 5v9 M8.5 17.5L12 21l3.5-3.5',
  loop: 'M19 21v-7a6 6 0 0 0-6-6H5 M9 4L5 8l4 4',
  // Two lanes that start together, and one lane of steps in order.
  parallel: 'M4 6h3 M4 12h3 M4 18h3 M7 3v18 M11 6h9 M11 18h9 M17 3l3 3-3 3 M17 15l3 3-3 3',
  sequential: 'M5 5h8 M5 12h8 M5 19h8 M18 4v15 M15 16l3 3 3-3',
};
export function Glyph({ name, size = 15 }) {
  if (!EXTRA_GLYPHS[name]) return h(UI.Icon, { name, size });
  return h('svg', { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true, focusable: false, fill: 'none', stroke: 'currentColor', strokeWidth: name === 'more' ? 2.8 : 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' }, h('path', { d: EXTRA_GLYPHS[name] }));
}
