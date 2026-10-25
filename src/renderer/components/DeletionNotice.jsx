import * as React from 'react';

const h = React.createElement;
const composing = event => event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229;

/** Delete on the modified press before focus/drag handlers can change its owner. */
export function shiftDeletionInput(action, accepts = () => true) {
  return {
    onPointerDownCapture: event => {
      if (event.button !== 0 || !event.shiftKey || !accepts(event)) return;
      event.preventDefault(); event.stopPropagation(); action(event);
    },
    onClickCapture: event => {
      if (!event.shiftKey || !accepts(event)) return;
      event.preventDefault(); event.stopPropagation();
      if (event.detail === 0) action(event);
    },
  };
}

// Own the press before native focus moves. Its physical click never repeats the action;
// an independent accessibility/programmatic click always gets a fresh owner preflight.
export function deletionInput(action) {
  return {
    onPointerDown: event => { event.preventDefault(); event.stopPropagation(); if (event.button === 0) action(event); },
    onClick: event => { event.preventDefault(); event.stopPropagation(); if (event.detail === 0) action(event); },
    onKeyDown: event => {
      if (composing(event) || ['Enter', ' ', 'Delete', 'Backspace'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        if (!composing(event) && !event.repeat && (event.key === 'Enter' || event.key === ' ')) action(event);
      }
    },
  };
}

/** One local action, with an inert old presentation retained while its button still owns focus. */
export function DeletionNotice({ notice, onUndo, onDismiss }) {
  const root = React.useRef(null), [shown, setShown] = React.useState(notice);
  const pause = React.useRef({ pointer: false, focus: false });
  const timer = React.useRef(null), latest = React.useRef(null);
  React.useLayoutEffect(() => { latest.current = { notice, onUndo, onDismiss }; });
  React.useLayoutEffect(() => {
    if (!root.current?.contains(document.activeElement)) setShown(notice);
  }, [notice]);
  const stop = () => {
    const clock = timer.current;
    if (!clock?.id) return;
    clearTimeout(clock.id); clock.id = null;
    clock.remaining = Math.max(0, clock.remaining - (performance.now() - clock.started));
  };
  const resume = () => {
    const clock = timer.current;
    if (!clock || clock.id || pause.current.pointer || pause.current.focus) return;
    clock.started = performance.now();
    clock.id = setTimeout(() => {
      clock.id = null;
      if (timer.current === clock && latest.current.notice === clock.action) latest.current.onDismiss(clock.action);
    }, clock.remaining);
  };
  React.useEffect(() => {
    pause.current = { pointer: Boolean(root.current?.matches(':hover')), focus: Boolean(root.current?.contains(document.activeElement)) };
    timer.current = shown ? { action: shown, remaining: 6000, id: null, started: 0 } : null;
    resume();
    return () => { stop(); timer.current = null; };
  }, [shown]);
  const usable = shown?.active && shown === notice;
  const restoreFocus = () => {
    if (document.querySelector('dialog:modal,[role="dialog"][aria-modal="true"]')) return;
    const target = document.querySelector('.library-pick[aria-current="true"]') || document.querySelector('.library-search') || document.querySelector('.toolbar .place[aria-current="page"]');
    target?.focus();
  };
  const activate = () => {
    const owned = root.current?.contains(document.activeElement);
    if (!root.current?.isConnected || !shown?.active || latest.current.notice !== shown) return;
    if (latest.current.onUndo(shown) && owned) restoreFocus();
  };
  return h('div', { className: 'deletion-footer' },
    h('span', { className: 'sr-only', role: 'status', 'aria-live': 'polite', 'aria-atomic': true }, notice && h('span', { key: notice.id }, notice.detail)),
    shown && h('div', { ref: root, className: 'deletion-notice',
      onPointerEnter: () => { pause.current.pointer = true; stop(); },
      onPointerLeave: () => { pause.current.pointer = false; resume(); },
      onFocusCapture: () => { pause.current.focus = true; stop(); },
      onBlurCapture: event => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        pause.current.focus = false;
        if (shown !== latest.current.notice) setShown(latest.current.notice);
        else resume();
      },
      onKeyDown: event => {
        if (event.key === 'Escape') {
          event.preventDefault(); event.stopPropagation();
          if (!composing(event) && !event.repeat) { latest.current.onDismiss(shown); restoreFocus(); setShown(latest.current.notice === shown ? null : latest.current.notice); }
        }
      } },
      h('span', { className: 'deletion-copy', title: shown.detail }, usable ? shown.message : 'Undo unavailable after newer edits'),
      h('button', { type: 'button', 'aria-disabled': !usable || undefined, 'aria-label': 'Undo: ' + shown.detail,
        ...deletionInput(activate) }, 'Undo')));
}
