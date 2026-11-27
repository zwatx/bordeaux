import * as React from 'react';
import '../styles/path-flip.css';

const h = React.createElement;

// The field draws +x right (toward the blue alliance wall) and +y up, so a left/right mirror
// changes alliance ends and a top/bottom mirror keeps the end but swaps the side.
export const FLIP_DIRECTIONS = [
  { v: 'horizontal', label: 'Flip horizontal', axis: 'Left ↔ right', detail: 'Mirrors across the center line to the other alliance’s end.' },
  { v: 'vertical', label: 'Flip vertical', axis: 'Top ↔ bottom', detail: 'Mirrors to the other side of the field at the same alliance end.' },
  { v: 'rotate', label: 'Rotate 180°', axis: 'Half turn', detail: 'Turns around the field center to the other alliance’s end.' },
];

// A schematic field with a lopsided path: the original stays faint behind the result so each
// choice shows which way it moves. Screen y runs down; the field's top/bottom read the same.
const W = 64, H = 36, SHAPE = [[11, 27], [17, 9], [37, 7], [50, 16]];
const moved = (direction) => ([x, y]) => [direction === 'vertical' ? x : W - x, direction === 'horizontal' ? y : H - y];
const curve = ([a, b, c, d]) => 'M' + a + 'C' + b + ' ' + c + ' ' + d;
function Glyph({ direction }) {
  const after = SHAPE.map(moved(direction));
  const axis = direction === 'horizontal' ? h('path', { d: 'M' + W / 2 + ' 3V' + (H - 3), className: 'pf-axis' })
    : direction === 'vertical' ? h('path', { d: 'M3 ' + H / 2 + 'H' + (W - 3), className: 'pf-axis' })
      : h('circle', { cx: W / 2, cy: H / 2, r: 1.6, className: 'pf-center' });
  return h('svg', { className: 'pf-glyph', width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, 'aria-hidden': true, focusable: false },
    h('rect', { x: 0.5, y: 0.5, width: W - 1, height: H - 1, rx: 3, className: 'pf-field' }),
    axis,
    h('path', { d: curve(SHAPE), className: 'pf-before' }),
    h('circle', { cx: SHAPE[0][0], cy: SHAPE[0][1], r: 2.2, className: 'pf-before-dot' }),
    h('path', { d: curve(after), className: 'pf-after' }),
    h('circle', { cx: after[0][0], cy: after[0][1], r: 2.6, className: 'pf-after-dot' }));
}

/** What Confirm sends: a trimmed copy name, or null to change the path in place. */
export function flipRequest({ direction, target, copyName }) {
  if (target !== 'copy') return { direction, copyName: null };
  const name = String(copyName ?? '').trim();
  return name ? { direction, copyName: name } : null;
}

/**
 * Flips one path. Nothing changes until the primary action: `onConfirm({ direction, copyName })`
 * resolves to an error string to keep the dialog open, or undefined when the parent closes it.
 * A path that shares points with other paths can only be copied, so those paths stay put.
 */
export function PathFlipDialog({ pathName, defaultCopyName = '', canReplace = true, onCancel, onConfirm }) {
  const ref = React.useRef(null), nameRef = React.useRef(null), cancelRef = React.useRef(null), live = React.useRef(true);
  const [direction, setDirection] = React.useState('horizontal');
  const [target, setTarget] = React.useState('copy');
  const [copyName, setCopyName] = React.useState(defaultCopyName);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const replace = target === 'replace' && canReplace;
  const chosen = FLIP_DIRECTIONS.find(item => item.v === direction);

  React.useEffect(() => {
    live.current = true;
    ref.current.showModal();
    ref.current.querySelector('input[name="pf-direction"]:checked')?.focus();
    return () => { live.current = false; };
  }, []);
  // The dialog must close while it is still in the document for the browser to return focus;
  // layout cleanup runs before React removes it. Fall back to the opener if focus was lost.
  React.useLayoutEffect(() => {
    const opener = document.activeElement !== document.body ? document.activeElement : null;
    const dialog = ref.current;
    return () => {
      if (dialog.open) dialog.close();
      const active = document.activeElement;
      if ((!active || active === document.body || dialog.contains(active)) && opener?.isConnected) opener.focus();
    };
  }, []);

  // Cancel stays live while busy: the parent abandons the pending work and closes the dialog.
  const cancel = () => onCancel();
  const confirm = async () => {
    if (busy) return;
    const request = flipRequest({ direction, target: replace ? 'replace' : 'copy', copyName });
    if (!request) { setError('Name the new path.'); nameRef.current?.focus(); return; }
    // The form locks while the parent works; keep keyboard focus on the one action still live.
    cancelRef.current?.focus();
    setBusy(true); setError('');
    let problem;
    try { problem = await onConfirm(request); }
    catch (failure) { problem = failure?.message || 'The path was not changed.'; }
    if (!live.current) return;
    setBusy(false);
    if (typeof problem === 'string' && problem) {
      setError(problem);
      requestAnimationFrame(() => (request.copyName ? nameRef.current : ref.current?.querySelector('.pf-commit'))?.focus());
    }
  };

  const action = replace ? (direction === 'rotate' ? 'Rotate path' : 'Flip path') : 'Create copy';
  return h('dialog', { ref, className: 'pj-sheet path-flip', 'aria-labelledby': 'path-flip-title', 'aria-describedby': 'path-flip-path', 'aria-busy': busy || undefined,
    onCancel: event => { event.preventDefault(); cancel(); }, onKeyDown: event => event.stopPropagation() },
    h('form', { className: 'pf-form', noValidate: true, onSubmit: event => { event.preventDefault(); confirm(); } },
      h('header', { className: 'pf-head' },
        h('h2', { id: 'path-flip-title' }, 'Flip path'),
        h('p', { id: 'path-flip-path', className: 'pf-path', title: pathName }, pathName)),
      h('fieldset', { className: 'pf-group', disabled: busy },
        h('legend', null, 'Direction'),
        h('div', { className: 'pf-directions' }, FLIP_DIRECTIONS.map(item => h('label', { key: item.v, className: 'pf-direction' },
          h('input', { type: 'radio', name: 'pf-direction', value: item.v, checked: direction === item.v, className: 'sr-only',
            'aria-describedby': direction === item.v ? 'path-flip-detail' : undefined, onChange: () => { setDirection(item.v); setError(''); } }),
          h(Glyph, { direction: item.v }),
          h('span', { className: 'pf-direction-label' }, item.label),
          h('span', { className: 'pf-direction-axis' }, item.axis)))),
        h('p', { id: 'path-flip-detail', className: 'pf-detail' }, chosen.detail)),
      h('fieldset', { className: 'pf-group pf-targets', disabled: busy },
        h('legend', null, 'Result'),
        h('label', { className: 'pf-target' },
          h('input', { type: 'radio', name: 'pf-target', value: 'copy', checked: !replace, onChange: () => { setTarget('copy'); setError(''); } }),
          h('span', { className: 'pf-target-text' }, h('span', { className: 'pf-target-label' }, 'Save as a new path'),
            h('span', { className: 'pf-target-note' }, 'This path stays as it is.'))),
        h('div', { className: 'pf-name' },
          h('input', { ref: nameRef, type: 'text', className: 'textinput', value: copyName, disabled: replace, 'aria-label': 'New path name',
            'aria-invalid': error && !replace && !copyName.trim() ? true : undefined, spellCheck: false, autoComplete: 'off', maxLength: 5000,
            onFocus: event => event.target.select(), onChange: event => { setCopyName(event.target.value); setError(''); } })),
        h('label', { className: 'pf-target', 'data-unavailable': canReplace ? undefined : true },
          h('input', { type: 'radio', name: 'pf-target', value: 'replace', checked: replace, disabled: !canReplace, 'aria-describedby': 'path-flip-replace-note',
            onChange: () => { setTarget('replace'); setError(''); } }),
          h('span', { className: 'pf-target-text' }, h('span', { className: 'pf-target-label' }, 'Change this path'),
            h('span', { id: 'path-flip-replace-note', className: 'pf-target-note' }, canReplace ? 'Undo restores it.' : 'It shares points with other paths. Save a copy so they stay where they are.')))),
      h('div', { className: 'pf-error', role: 'alert' }, error),
      h('div', { className: 'pj-foot' },
        h('span', { className: 'pj-foot-actions' },
          h('button', { ref: cancelRef, type: 'button', className: 'qbtn quiet', onClick: cancel }, 'Cancel'),
          h('button', { type: 'submit', className: 'qbtn primary pf-commit', disabled: busy }, busy ? 'Working…' : action)))));
}
