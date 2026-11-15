import { describe, expect, it } from 'vitest';
import { isPlaybackSpace, trackFocusModality } from '../src/renderer/lib/shortcuts';

const doc = (...visible) => ({ querySelectorAll: () => visible.map(value => ({ getClientRects: () => value ? [{}] : [] })) });
const event = (patch = {}) => ({ key: ' ', target: { closest: () => null }, ...patch });
describe('workspace Space admission', () => {
  it.each(['plan', 'auto'])('admits ordinary focused buttons, rows, and canvas in %s', page => {
    expect(isPlaybackSpace(event(), page, doc())).toBe(true);
  });
  it('keeps typing, value controls, open popovers, IME, and modified Space local', () => {
    expect(isPlaybackSpace(event({ target: { isContentEditable: true } }), 'plan', doc())).toBe(false);
    expect(isPlaybackSpace(event({ target: { closest: () => ({}) } }), 'plan', doc())).toBe(false);
    expect(isPlaybackSpace(event(), 'plan', doc(false, true))).toBe(false);
    expect(isPlaybackSpace(event(), 'plan', doc(false))).toBe(true);
    for (const key of ['isComposing', 'defaultPrevented', 'shiftKey', 'metaKey', 'ctrlKey', 'altKey']) expect(isPlaybackSpace(event({ [key]: true }), 'plan', doc())).toBe(false);
    expect(isPlaybackSpace(event({ keyCode: 229 }), 'plan', doc())).toBe(false);
    expect(isPlaybackSpace(event(), 'robot', doc())).toBe(false);
  });
  it.each(['details>summary', '.choice-change[aria-expanded][aria-controls]', '[data-role="issue"]', '[data-problems-control]', '[data-native-chrome]'])('preserves explicit control ownership for %s', selector => {
    const target = { closest: selectors => selectors.split(',').includes(selector) ? {} : null };
    expect(isPlaybackSpace(event({ target }), 'plan', doc())).toBe(false);
  });
  it('keeps playback while a hover tooltip is open, but not while another popover is', () => {
    const seen = [];
    const query = { querySelectorAll: selector => { seen.push(selector); return []; } };
    expect(isPlaybackSpace(event(), 'plan', query)).toBe(true);
    const popovers = seen[0].split(',').filter(part => part.includes('[popover]'));
    expect(popovers).toEqual(['[popover]:popover-open:not([role="tooltip"])']);
  });
  it('does not give mutation buttons native Space merely because they share chooser styling', () => {
    const target = { closest: selectors => selectors.split(',').includes('.choice-change') ? {} : null };
    expect(isPlaybackSpace(event({ target }), 'plan', doc())).toBe(true);
    expect(isPlaybackSpace(event({ target }), 'auto', doc())).toBe(true);
  });
  it('plays after a mouse click on a control, but keeps Space for the control when reached from the keyboard', () => {
    const listeners = {}, fakeDoc = { addEventListener: (type, fn) => { listeners[type] = fn; }, removeEventListener: () => {} };
    const control = { closest: selectors => selectors.includes('.seg') && !selectors.includes('textarea') ? {} : null };
    let clock = 1000;
    const untrack = trackFocusModality(fakeDoc, () => clock);
    try {
      listeners.pointerdown(); listeners.focusin({ target: control });
      expect(isPlaybackSpace(event({ target: control }), 'plan', doc())).toBe(true);
      // Using a key on the control (including a Space it handled while its popup was open) hands Space back to it.
      listeners.keydown({ key: 'ArrowDown', target: control });
      expect(isPlaybackSpace(event({ target: control }), 'plan', doc())).toBe(false);
      // Focus that arrives from the keyboard keeps Space for the control.
      listeners.focusin({ target: control });
      expect(isPlaybackSpace(event({ target: control }), 'plan', doc())).toBe(false);
      // A focus restore right after a click counts as the click; script focus long after it does not.
      listeners.pointerup(); clock += 20; listeners.focusin({ target: control });
      expect(isPlaybackSpace(event({ target: control }), 'plan', doc())).toBe(true);
      clock += 5000; listeners.focusin({ target: control });
      expect(isPlaybackSpace(event({ target: control }), 'plan', doc())).toBe(false);
    } finally { untrack(); }
  });
  it('always keeps Space for text entry, even after a mouse click', () => {
    const field = { closest: selectors => selectors.includes('textarea') ? {} : null };
    expect(isPlaybackSpace(event({ target: field }), 'plan', doc())).toBe(false);
  });
  it('does not let an inline result list withhold playback', () => {
    const seen = [];
    isPlaybackSpace(event(), 'plan', { querySelectorAll: selector => { seen.push(selector); return []; } });
    expect(seen[0].split(',')).toContain('[role="listbox"]:not(.choice-results)');
  });
});
