import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
const hooks = vi.hoisted(() => ({ values: [], cursor: 0, effects: [], cleanups: [] }));
vi.mock('react', async (original) => {
  const actual = await original();
  return {
    ...actual,
    createElement: vi.fn(actual.createElement),
    useState(initial) {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = typeof initial === 'function' ? initial() : initial;
      return [hooks.values[index], (value) => { hooks.values[index] = typeof value === 'function' ? value(hooks.values[index]) : value; }];
    },
    useRef(initial) {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = { current: initial };
      return hooks.values[index];
    },
    useEffect(effect, dependencies = []) {
      const index = hooks.cursor++;
      const previous = hooks.values[index];
      if (!previous || dependencies.some((value, item) => value !== previous[item])) hooks.effects.push(effect);
      hooks.values[index] = dependencies;
    },
  };
});
import * as React from 'react';
import { useRobotPushController } from '../src/renderer/components/useRobotPushController';
import { RobotPushDialog } from '../src/renderer/components/RobotPushDialog';
const project = { paths: [{ id: 'selected', name: 'Selected' }], routines: [], editor: { activePathId: 'selected' } };
function renderController() {
  hooks.cursor = 0;
  const value = useRobotPushController({ getProject: () => project, projectKey: 'project', catalogKey: 'catalog', bookmarkKey: 'robot' });
  for (const effect of hooks.effects.splice(0)) { const cleanup = effect(); if (cleanup) hooks.cleanups.push(cleanup); }
  return value;
}
function api(capabilities = { pathPush: false, routinePush: false }) {
  const value = Object.fromEntries(['getRobotPairing', 'probeRobot', 'confirmRobotPairing', 'prepareRobotPush', 'inspectRobotLibrary', 'inspectPairedRobot', 'prepareRobotRetention'].map((name) => [name, vi.fn(async () => null)]));
  value.robotDeliveryCapabilities = capabilities;
  vi.stubGlobal('window', { bordeauxAPI: value });
  return value;
}
beforeEach(() => {
  vi.useFakeTimers(); React.createElement.mockClear(); hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.cleanups = [];
  vi.stubGlobal('document', { activeElement: null }); vi.stubGlobal('requestAnimationFrame', (callback) => callback());
});
afterEach(() => { for (const cleanup of hooks.cleanups) cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('unavailable LabVIEW delivery', () => {
  it.each([
    [{ kind: 'paths', pathIds: ['selected'] }, 'selected', 'path'],
    [{ kind: 'routine', routineId: 'auto' }, null, 'routine'],
    [{ kind: 'paths', pathIds: ['selected', 'other'] }, null, 'path'],
  ])('stops %j before pairing, probing, inspection, or preparation', async (scope, pathId, kind) => {
    const bridge = api(); const initial = renderController();
    await initial.requestPush(scope);
    const current = renderController();
    expect(current.open).toBe(true); expect(current.phase).toBe('unavailable');
    expect(current.unavailable).toMatchObject({ pathId, kind });
    expect(current.error).toBe('');
    for (const value of Object.values(bridge)) if (vi.isMockFunction(value)) expect(value).not.toHaveBeenCalled();
  });
  it('fails closed when no capabilities are provided and blocks connection actions', async () => {
    const bridge = api(undefined); delete bridge.robotDeliveryCapabilities;
    const current = renderController(); current.openConnection(); await current.probeRobot(); await current.confirmPairing(); await current.refreshStatus();
    expect(renderController().phase).toBe('unavailable');
    for (const value of Object.values(bridge)) if (vi.isMockFunction(value)) expect(value).not.toHaveBeenCalled();
  });
  it('exports exactly the requested path ID after closing the unavailable dialog', () => {
    const close = vi.fn(); const onExportBdx = vi.fn();
    const markup = renderToStaticMarkup(React.createElement(RobotPushDialog, {
      controller: { phase: 'unavailable', open: false, close, unavailable: { pathId: 'selected', reason: 'Receiver needed' } }, onExportBdx,
    }));
    expect(markup).toContain('Export path as BDX');
    // React renders the public wrapper and its children; capture the real host button's
    // handler because server markup cannot dispatch DOM events.
    const exportButtons = React.createElement.mock.results.map(({ value }) => value)
      .filter((element) => element?.type === 'button' && element.props.children === 'Export path as BDX');
    expect(exportButtons).toHaveLength(1);
    expect(close).not.toHaveBeenCalled(); expect(onExportBdx).not.toHaveBeenCalled();
    exportButtons[0].props.onClick();
    expect(close).toHaveBeenCalledOnce(); expect(onExportBdx).toHaveBeenCalledExactlyOnceWith('selected');
    expect(close.mock.invocationCallOrder[0]).toBeLessThan(onExportBdx.mock.invocationCallOrder[0]);
  });
  it('shows the local export action without pairing, retry, or history instructions', () => {
    const controller = { phase: 'unavailable', open: false, close: vi.fn(), unavailable: { reason: 'A LabVIEW BDX receiver is needed.', pathId: 'selected' } };
    const markup = renderToStaticMarkup(React.createElement(RobotPushDialog, { controller, onExportBdx: vi.fn() }));
    expect(markup).toContain('Export path as BDX'); expect(markup).toContain('A LabVIEW BDX receiver is needed.');
    expect(markup).not.toMatch(/Robot host|Trust and pair|Revision history|Review current edits|Connect over USB/);
  });
});
