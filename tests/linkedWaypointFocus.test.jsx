import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Direct component callbacks, following the repository's Node hook-test pattern.
// Only PathPanel runs: children are inspected as React elements, never rendered.
const hooks = vi.hoisted(() => ({ slots: [], cursor: 0, effects: [] }));
vi.mock('react', async (original) => ({
  ...await original(),
  useRef(initial) {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = { current: initial };
    return hooks.slots[index];
  },
  useEffect(effect, dependencies) {
    const index = hooks.cursor++, previous = hooks.slots[index];
    if (!previous || !dependencies || dependencies.length !== previous.dependencies.length
      || dependencies.some((value, item) => !Object.is(value, previous.dependencies[item]))) {
      hooks.effects.push(() => {
        previous?.cleanup?.();
        hooks.slots[index] = { dependencies, cleanup: effect() };
      });
    }
  },
}));

import { PathPanel } from '../src/renderer/components/PathPanel';
import { PathLinks } from '../src/renderer/lib/pathLinks';
import { createDemoProject } from '../src/shared/project/defaults';

function findElement(element, predicate) {
  if (!element || typeof element !== 'object') return null;
  if (Array.isArray(element)) {
    for (const child of element) { const found = findElement(child, predicate); if (found) return found; }
    return null;
  }
  return predicate(element) ? element : findElement(element.props?.children, predicate);
}

let fixture;
beforeEach(() => { hooks.slots = []; hooks.effects = []; hooks.cursor = 0; });
afterEach(() => { fixture?.unmount(); fixture = null; vi.unstubAllGlobals(); });

function setup({ linked = false, status = 'applied' } = {}) {
  const frames = new Map(), focusListeners = new Set(), controls = [];
  let frameSequence = 0, modal = null, tree, attachedBody, nextProject;
  const documentFixture = {
    body: { name: 'document body' }, activeElement: null,
    addEventListener: vi.fn((type, listener, capture) => {
      expect([type, capture]).toEqual(['focusin', true]); focusListeners.add(listener);
    }),
    removeEventListener: vi.fn((type, listener, capture) => {
      expect([type, capture]).toEqual(['focusin', true]); focusListeners.delete(listener);
    }),
    querySelector: vi.fn((selector) => {
      expect(selector).toBe('dialog[open],[role="dialog"][aria-modal="true"]'); return modal;
    }),
  };
  vi.stubGlobal('document', documentFixture);
  const requestFrame = vi.fn((callback) => { const id = ++frameSequence; frames.set(id, callback); return id; });
  const cancelFrame = vi.fn((id) => frames.delete(id));
  vi.stubGlobal('requestAnimationFrame', requestFrame);
  vi.stubGlobal('cancelAnimationFrame', cancelFrame);
  const dispatchFocusClaim = (target) => {
    documentFixture.activeElement = target;
    for (const listener of [...focusListeners]) listener({ target });
  };
  const control = (name) => {
    const node = {
      name, isConnected: true, disabled: false, closest: vi.fn(() => null), checkVisibility: vi.fn(() => true),
      focus: vi.fn(() => dispatchFocusClaim(node)),
    };
    controls.push(node);
    return node;
  };
  const makeBody = (name) => {
    const body = { name, isConnected: true, trigger: null, unlink: null, targets: new Map() };
    body.querySelector = vi.fn((selector) => body.targets.get(selector) || null);
    return body;
  };

  const base = createDemoProject();
  let project = { ...base, pathLinks: [], paths: [
    { ...structuredClone(base.paths[0]), id: 'a', name: 'Amp' },
    { ...structuredClone(base.paths[0]), id: 'b', name: 'Source' },
  ] };
  const linkProject = (before, index, target) => PathLinks.nameNewSharedPoint(
    PathLinks.linkPosition(before, 'a', index, target.pathId, target.index, 'focus-test-group'), 'a', index);
  if (linked) project = linkProject(project, 1, { pathId: 'b', index: 0 });
  let props = {
    doc: project.paths[0], project, sel: { kind: 'wp', idx: 1 }, documentKey: 'loaded-document-1',
    derived: {}, tl: { empty: true, wpFrac: [] }, robot: {}, drive: 'swerve',
    robotProject: { status: 'unlinked', catalog: null }, playbackStore: { getSnapshot: () => ({ time: 0 }) },
    actions: { setWaypointPositionLink: vi.fn((index, target) => {
      // Scheduling and claim ownership must precede the action/commit, not follow it.
      expect(frames.size).toBe(1); expect(focusListeners.size).toBe(1);
      if (status === 'applied') nextProject = target ? linkProject(props.project, index, target)
        : PathLinks.unlinkPosition(props.project, props.doc.id, index);
      return status;
    }) },
  };

  const render = (patch = {}, body = attachedBody) => {
    props = { ...props, ...patch };
    hooks.cursor = 0;
    tree = PathPanel(props);
    const bodyElement = findElement(tree, (element) => element.props?.className === 'pp-body');
    expect(bodyElement).not.toBeNull();
    // Explicit attachment to the component's returned ref, not a ReactDOM renderer.
    // Tests choose when that node changes; no claim about React reconciliation is made.
    attachedBody = body;
    bodyElement.ref.current = body;
    body.targets.clear();
    const hasTrigger = Boolean(findElement(tree, (element) => element.props?.id === 'band-waypoint-link'));
    const hasUnlink = Boolean(findElement(tree, (element) => element.props?.['data-link-unlink']));
    if (hasTrigger && !body.trigger?.isConnected) body.trigger = control(body.name + ' Link to…');
    if (hasUnlink && !body.unlink?.isConnected) body.unlink = control(body.name + ' Unlink');
    if (!hasTrigger && body.trigger) body.trigger.isConnected = false;
    if (!hasUnlink && body.unlink) body.unlink.isConnected = false;
    if (hasTrigger) body.targets.set('#band-waypoint-link', body.trigger);
    if (hasUnlink) body.targets.set('[data-link-unlink]', body.unlink);
    for (const effect of hooks.effects.splice(0)) effect();
    return bodyElement;
  };
  const originalBody = makeBody('original body');
  render({}, originalBody);
  documentFixture.activeElement = linked ? originalBody.unlink : originalBody.trigger;

  const invoke = (direction = linked ? 'unlink' : 'link') => {
    if (direction === 'unlink') {
      const button = findElement(tree, (element) => element.props?.['data-link-unlink']);
      expect(button).not.toBeNull();
      expect(button.props.onClick()).toBe(status);
      expect(props.actions.setWaypointPositionLink).toHaveBeenLastCalledWith(1, null);
      return;
    }
    const chooser = findElement(tree, (element) => element.props?.id === 'band-waypoint-link');
    expect(chooser).not.toBeNull();
    const choice = chooser.props.items[0];
    expect(chooser.props.onChoose(choice.value)).toBe(status);
    expect(props.actions.setWaypointPositionLink).toHaveBeenLastCalledWith(1, { pathId: choice.pathId, index: choice.index });
  };
  const commit = () => render({ project: nextProject, doc: nextProject.paths.find((path) => path.id === props.doc.id) });
  const runFrame = (id = [...frames.keys()][0]) => {
    expect(frames.has(id)).toBe(true);
    const callback = frames.get(id); frames.delete(id); callback(0);
  };
  const expectClean = (scheduled = 1) => {
    expect(frames.size).toBe(0); expect(focusListeners.size).toBe(0);
    expect(requestFrame).toHaveBeenCalledTimes(scheduled);
    expect(cancelFrame).toHaveBeenCalledTimes(scheduled);
    expect(documentFixture.addEventListener).toHaveBeenCalledTimes(scheduled);
    expect(documentFixture.removeEventListener).toHaveBeenCalledTimes(scheduled);
    for (const [, listener, capture] of documentFixture.addEventListener.mock.calls)
      expect(documentFixture.removeEventListener).toHaveBeenCalledWith('focusin', listener, capture);
  };
  const expectNoFocus = (active) => {
    expect(documentFixture.activeElement).toBe(active);
    for (const node of controls) expect(node.focus).not.toHaveBeenCalled();
  };
  const unmount = () => {
    for (const slot of hooks.slots) if (slot?.cleanup) { slot.cleanup(); slot.cleanup = undefined; }
  };
  fixture = {
    originalBody, document: documentFixture, frames, focusListeners, cancelFrame, requestFrame, controls,
    render, invoke, commit, runFrame, expectClean, expectNoFocus, unmount, makeBody, dispatchFocusClaim,
    setModal: (value) => { modal = value; },
    get props() { return props; },
  };
  return fixture;
}

describe('PathPanel owned Linked focus (actual callbacks, controlled frame and body refs)', () => {
  it.each(['link', 'unlink'])('%s focuses the replacement control once after the next render and releases ownership', (direction) => {
    const f = setup({ linked: direction === 'unlink' });
    const original = f.document.activeElement;
    f.invoke(direction);
    expect(f.props.actions.setWaypointPositionLink).toHaveBeenCalledTimes(1);
    expect(f.frames.size).toBe(1); expect(f.focusListeners.size).toBe(1);
    f.expectNoFocus(original);
    f.commit();
    f.document.activeElement = f.document.body;
    const target = direction === 'link' ? f.originalBody.unlink : f.originalBody.trigger;
    f.runFrame();
    expect(f.document.activeElement).toBe(target);
    expect(target.focus).toHaveBeenCalledTimes(1);
    for (const node of f.controls.filter((node) => node !== target)) expect(node.focus).not.toHaveBeenCalled();
    expect(f.originalBody.querySelector).toHaveBeenCalledExactlyOnceWith(direction === 'link' ? '[data-link-unlink]' : '#band-waypoint-link');
    f.expectClean();
    f.unmount(); f.expectClean(); // A completed job is not cancelled/removed again by unmount.
  });

  it('declines an intervening focusin claim even when active focus returns to the original control', () => {
    const f = setup(), origin = f.document.activeElement;
    f.invoke(); f.commit();
    f.dispatchFocusClaim(f.originalBody.unlink);
    f.document.activeElement = origin;
    f.runFrame(); f.expectNoFocus(origin); f.expectClean();
  });

  it('declines active focus elsewhere even without a captured focusin event', () => {
    const f = setup(), elsewhere = { name: 'other control' };
    f.invoke(); f.commit(); f.document.activeElement = elsewhere;
    f.runFrame(); f.expectNoFocus(elsewhere); f.expectClean();
  });

  it('declines a replaced body even if the old body is still connected and all live fields match', () => {
    const f = setup(), origin = f.document.activeElement;
    f.invoke(); f.commit();
    f.render({}, f.makeBody('replacement body'));
    expect(f.originalBody.isConnected).toBe(true);
    f.runFrame(); f.expectNoFocus(origin); f.expectClean();
  });

  it('does not recover ownership after selection away/back ABA replaces the keyed body', () => {
    const f = setup(), origin = f.document.activeElement;
    const before = f.render();
    f.invoke(); f.commit();
    const away = f.render({ sel: { kind: 'wp', idx: 0 } }, f.makeBody('away body'));
    const back = f.render({ sel: { kind: 'wp', idx: 1 } }, f.makeBody('back body'));
    expect(away.key).not.toBe(before.key); expect(back.key).toBe(before.key);
    f.runFrame(); f.expectNoFocus(origin); f.expectClean();
  });

  it('declines a disconnected owner', () => {
    const f = setup(), origin = f.document.activeElement;
    f.invoke(); f.commit(); f.originalBody.isConnected = false;
    f.runFrame(); f.expectNoFocus(origin); f.expectClean();
  });

  it('declines a new loaded document even when its path id, selection and body ref are reused', () => {
    const f = setup(), origin = f.document.activeElement;
    f.invoke(); f.commit();
    const previous = f.props;
    f.render({ documentKey: 'loaded-document-2' });
    expect(f.props.doc.id).toBe(previous.doc.id); expect(f.props.sel).toBe(previous.sel);
    f.runFrame(); f.expectNoFocus(origin); f.expectClean();
  });

  it.each(['selection index', 'selection kind', 'path', 'link state'])('declines when the live %s no longer matches the scheduled result', (change) => {
    const f = setup(), origin = f.document.activeElement;
    f.invoke(); f.commit();
    if (change === 'selection index') {
      // Keep the new selection linked too, so the index check has its own effect.
      const project = PathLinks.linkPosition(f.props.project, 'a', 0, 'b', 0, 'focus-test-group');
      f.render({ project, doc: project.paths[0], sel: { kind: 'wp', idx: 0 } });
    } else if (change === 'selection kind') {
      f.render({ sel: { kind: 'seg', idx: 1 } });
    } else if (change === 'path') {
      const project = { ...f.props.project, paths: f.props.project.paths.map((path) => path.id === 'a' ? { ...path, id: 'replacement-a' } : path) };
      f.render({ project, doc: project.paths[0] });
    } else {
      const project = PathLinks.unlinkPosition(f.props.project, 'a', 1);
      f.render({ project, doc: project.paths[0] });
    }
    f.runFrame(); f.expectNoFocus(origin); f.expectClean();
  });

  it('declines while a modal is open', () => {
    const f = setup(), origin = f.document.activeElement;
    f.invoke(); f.commit(); f.setModal({ name: 'modal dialog' });
    f.runFrame(); f.expectNoFocus(origin); f.expectClean();
  });

  it.each([
    ['link', 'unchanged'], ['link', 'refused'], ['unlink', 'unchanged'], ['unlink', 'refused'],
  ])('cancels a %s immediately on an %s action and leaves focus untouched', (direction, status) => {
    const f = setup({ linked: direction === 'unlink', status }), origin = f.document.activeElement;
    f.invoke(direction);
    expect(f.props.actions.setWaypointPositionLink).toHaveBeenCalledTimes(1);
    f.expectNoFocus(origin); f.expectClean();
    f.render(); f.expectNoFocus(origin); f.expectClean();
  });

  it('a later schedule cancels the old frame and claim listener, leaving only the new owner', () => {
    const f = setup();
    const firstTrigger = f.originalBody.trigger;
    f.invoke();
    const firstFrame = [...f.frames.keys()][0];
    f.commit();
    f.document.activeElement = f.originalBody.unlink;
    f.invoke('unlink');
    expect(f.props.actions.setWaypointPositionLink).toHaveBeenCalledTimes(2);
    expect(f.cancelFrame).toHaveBeenCalledExactlyOnceWith(firstFrame);
    expect(f.frames.has(firstFrame)).toBe(false);
    expect(f.frames.size).toBe(1); expect(f.focusListeners.size).toBe(1);
    expect(f.document.removeEventListener).toHaveBeenCalledTimes(1);
    f.commit(); f.document.activeElement = f.document.body;
    expect(f.originalBody.trigger).not.toBe(firstTrigger);
    expect(firstTrigger.isConnected).toBe(false);
    f.runFrame();
    expect(f.document.activeElement).toBe(f.originalBody.trigger);
    expect(f.originalBody.trigger.focus).toHaveBeenCalledTimes(1);
    expect(f.originalBody.unlink.focus).not.toHaveBeenCalled();
    expect(firstTrigger.focus).not.toHaveBeenCalled();
    f.expectClean(2);
  });

  it('panel unmount cleanup cancels a pending frame and listener without moving focus', () => {
    const f = setup(), origin = f.document.activeElement;
    f.invoke(); f.commit();
    f.unmount(); f.expectNoFocus(origin); f.expectClean();
  });

  it.each(['disabled', 'inert', 'hidden', 'disconnected'])('uses focusIfAvailable to refuse a %s replacement target', (state) => {
    const f = setup(), origin = f.document.activeElement;
    f.invoke(); f.commit();
    const target = f.originalBody.unlink;
    if (state === 'disabled') target.disabled = true;
    if (state === 'inert') target.closest.mockReturnValue({ inert: true });
    if (state === 'hidden') target.checkVisibility.mockReturnValue(false);
    if (state === 'disconnected') target.isConnected = false;
    f.runFrame(); f.expectNoFocus(origin); f.expectClean();
  });
});
