import { describe, expect, it } from 'vitest';
import { isPlaybackSpace } from '../src/renderer/lib/shortcuts';

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
  it('does not give mutation buttons native Space merely because they share chooser styling', () => {
    const target = { closest: selectors => selectors.split(',').includes('.choice-change') ? {} : null };
    expect(isPlaybackSpace(event({ target }), 'plan', doc())).toBe(true);
    expect(isPlaybackSpace(event({ target }), 'auto', doc())).toBe(true);
  });
});
