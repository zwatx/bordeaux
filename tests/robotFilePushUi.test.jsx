import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
const hooks = vi.hoisted(() => ({ values: [], cursor: 0, open: false }));
// Hooks become plain calls, so PushControl and its menu can be called directly and their handlers invoked.
// `hooks.open` is the menu's initial open state.
vi.mock('react', async (original) => ({
  ...await original(),
  useRef(initial) { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = { current: initial }; return hooks.values[index]; },
  useState(initial) { hooks.cursor++; return [typeof initial === 'boolean' ? hooks.open : initial, () => undefined]; },
  useEffect() { hooks.cursor++; },
}));
import * as React from 'react';
import { PushControl, robotStatus } from '../src/renderer/components/PushControl';
import { RobotFilePushDialog } from '../src/renderer/components/RobotFilePushDialog';

const path = (id, waypoints = 3) => ({ id, name: 'Path ' + id, waypoints: Array.from({ length: waypoints }, () => ({})) });
const controller = (patch = {}) => ({ fileTransfer: true, busy: false, desktopAvailable: true, phase: 'idle', settings: null, requestPush: vi.fn(), openConnection: vi.fn(), ...patch });
const endpoint = { host: '10.24.68.2', directory: '/home/lvuser/natinst/bin/Paths' };
// Expands function components (the menu) so their rendered elements can be searched.
const find = (node, test) => {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) { for (const child of node) { const hit = find(child, test); if (hit) return hit; } return null; }
  if (test(node)) return node;
  if (typeof node.type === 'function') return find(node.type(node.props), test);
  return find(node.props?.children, test);
};
const named = (className) => (node) => node.props?.className === className;
function control(props, { open = true } = {}) {
  hooks.cursor = 0; hooks.open = open;
  const tree = PushControl({ place: 'paths', selection: { selected: ['A'] }, activeRoutine: null, ...props });
  return { tree, all: find(tree, named('push-all')), push: find(tree, named('push-button')), trigger: find(tree, named('push-menu-trigger')),
    menu: find(tree, (node) => node.props?.role === 'menu'), connection: find(tree, named('push-menu-connection')),
    live: find(tree, (node) => node.props?.role === 'status') };
}
const text = (node) => !node ? '' : typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(text).join('')
  : typeof node.type === 'function' ? text(node.type(node.props)) : text(node.props?.children);
beforeEach(() => { hooks.values = []; hooks.open = false; vi.stubGlobal('window', { bordeauxAPI: {} }); });

describe('Push split button', () => {
  it('keeps Push and Push all as separate actions: Push sends the exact selection, Push all every authored path', () => {
    const c = controller({ settings: { endpoint } });
    const { all, push } = control({ paths: [path('A'), path('B'), path('C')], controller: c });
    expect(all.props).toMatchObject({ role: 'menuitem', 'aria-label': 'Push all 3 paths', 'aria-disabled': undefined });
    expect(text(all)).toContain('Includes hidden paths');
    all.props.onClick();
    expect(c.requestPush).toHaveBeenLastCalledWith({ kind: 'paths', pathIds: ['A', 'B', 'C'] });
    push.props.onClick();
    expect(c.requestPush).toHaveBeenLastCalledWith({ kind: 'paths', pathIds: ['A'] });
    expect(c.requestPush).toHaveBeenCalledTimes(2);
    expect(push.props).toMatchObject({ 'aria-label': 'Push path', 'data-shortcut': expect.any(String), 'aria-keyshortcuts': expect.stringMatching(/\+Shift\+P$/) });
  });
  it('names Push all\'s reason, visibly, when it is unavailable, and keeps it focusable but inert', () => {
    const reason = (paths, patch) => { const { all } = control({ paths, controller: controller(patch) }); return { inert: all.props['aria-disabled'], onClick: all.props.onClick, text: text(all) }; };
    expect(reason([], {})).toEqual({ inert: true, onClick: undefined, text: 'Push all 0 pathsNo paths to push' });
    expect(reason([path('A'), path('B', 1)], {}).text).toContain('1 path needs at least two waypoints');
    expect(reason([path('A', 0), path('B', 1)], {}).text).toContain('2 paths need at least two waypoints');
    expect(reason([path('A')], { desktopAvailable: false })).toMatchObject({ inert: true, onClick: undefined });
    // While a push runs, Push all stays a focusable menu item that does nothing.
    expect(reason([path('A'), path('B')], { busy: true, phase: 'preparing' })).toMatchObject({ inert: true, onClick: undefined });
  });
  it('opens and closes as a menu button with the trigger as the focus origin', () => {
    const closed = control({ paths: [path('A')], controller: controller() }, { open: false });
    expect(closed.trigger.props).toMatchObject({ 'aria-haspopup': 'menu', 'aria-expanded': false, 'aria-controls': undefined });
    expect(closed.menu).toBeNull();
    const open = control({ paths: [path('A')], controller: controller() });
    expect(open.trigger.props).toMatchObject({ 'aria-expanded': true, 'aria-controls': 'push-menu' });
    expect(open.menu.props).toMatchObject({ id: 'push-menu', 'aria-label': 'Push options' });
    const items = [open.all, open.connection];
    expect(items.map((item) => [item.props.role, item.props.tabIndex])).toEqual([['menuitem', -1], ['menuitem', -1]]);
  });
  it('folds the robot state into the trigger: a dot tone, its name and tooltip, and a persistent live region', () => {
    const state = (patch) => { const { trigger, live } = control({ paths: [path('A')], controller: controller(patch) }); return [trigger.props['data-tone'], trigger.props['aria-label'], live.props.children]; };
    expect(state({})).toEqual(['unset', 'Push options · Robot not set up', 'Robot not set up']);
    expect(state({ settings: { endpoint } })).toEqual([undefined, 'Push options · 10.24.68.2 · Paths', '10.24.68.2 · Paths']);
    expect(state({ phase: 'uploading', busy: true })).toEqual(['busy', 'Push options · Uploading…', 'Uploading…']);
    expect(state({ phase: 'saving', busy: true })[2]).toBe('Saving…');
    expect(state({ phase: 'failed', error: 'Readback did not match' })).toEqual(['bad', 'Push options · Not sent · Readback did not match', 'Not sent · Readback did not match']);
    const [tone, , pushed] = state({ phase: 'transferred', reachability: 'online', result: { files: [{}, {}], directory: endpoint.directory } });
    expect([tone, pushed]).toEqual(['good', expect.stringMatching(/^Pushed 2 · \d\d:\d\d$/)]);
  });
  it('shows the destination and last result in the menu heading, and routes the connection item to setup', () => {
    const unset = control({ paths: [path('A')], controller: controller() });
    expect(text(unset.menu)).toMatch(/^Robot not set upPush opens setup first/);
    expect(text(unset.connection)).toBe('Set up robot…');
    const failed = controller({ settings: { endpoint }, phase: 'failed', error: 'Host unreachable' });
    const { menu, connection } = control({ paths: [path('A')], controller: failed });
    expect(text(menu)).toMatch(/^10\.24\.68\.2\/home\/lvuser\/natinst\/bin\/PathsNot sent · Host unreachable/);
    expect(text(connection)).toBe('Robot connection…');
    connection.props.onClick();
    expect(failed.openConnection).toHaveBeenCalledTimes(1);
    expect(failed.requestPush).not.toHaveBeenCalled();
  });
  it('keeps the menu usable when the primary half is disabled', () => {
    const { push, trigger } = control({ paths: [path('A')], selection: { selected: [] }, controller: controller({ settings: { endpoint } }) });
    expect(push.props.disabled).toBe(true);
    expect(trigger.props.disabled).toBeUndefined();
  });
  it('appears only for path file transfer', () => {
    expect(control({ paths: [path('A')], controller: controller({ fileTransfer: false, desktopAvailable: true }) }).trigger).toBeNull();
    expect(control({ place: 'routines', paths: [path('A')], controller: controller() }).trigger).toBeNull();
  });
  it('keeps a result\'s own time', () => {
    expect(robotStatus({ phase: 'transferred', result: { files: [{}], directory: '/x' } }, new Date(2026, 9, 17, 9, 5))).toMatchObject({ tone: undefined, text: 'Pushed 1 · 09:05', title: 'Verified in /x' });
  });
  it('does not show green for a past push after disconnect or before a live check', () => {
    const result = { files: [{}], directory: endpoint.directory };
    expect(robotStatus(controller({ settings: { endpoint }, phase: 'transferred', result, reachability: 'offline' }))).toMatchObject({ tone: 'unset', text: '10.24.68.2 · Disconnected' });
    expect(robotStatus(controller({ settings: { endpoint }, phase: 'transferred', result }))).toMatchObject({ tone: undefined });
    expect(robotStatus(controller({ settings: { endpoint }, reachability: 'online' }))).toMatchObject({ tone: 'good', text: '10.24.68.2 · Connected' });
  });
});

const dialogController = (patch) => ({
  open: true, phase: 'idle', busy: false, host: '10.24.68.2', port: '22', directory: '/home/lvuser/natinst/bin/Paths', error: '', canRetry: false,
  settings: null, editing: false, connection: null, probe: null, preview: null, result: null, ...patch });
const dialog = (patch) => renderToStaticMarkup(React.createElement(RobotFilePushDialog, { controller: dialogController(patch) }));
const actions = (html) => [...html.matchAll(/<button type="button" class="(qbtn[^"]*)"[^>]*>([^<]*)<\/button>/g)].map(([, cls, text]) => text + (cls.includes('primary') ? '*' : ''));
const saved = { endpoint: { host: '10.24.68.2', port: 22, directory: '/home/lvuser/natinst/bin/Paths' } };

describe('Robot connection: offline Save', () => {
  it('makes Save the primary action when no push is waiting, and says it works without the robot', () => {
    const html = dialog({});
    expect(actions(html)).toEqual(['Connect', 'Save*']);
    expect(html).toContain('Save offline. Connect to verify the robot.');
    expect(html).not.toContain('role="alert"');
  });
  it('keeps Connect primary when a push is waiting on this connection', () => {
    expect(actions(dialog({ canRetry: true }))).toEqual(['Save', 'Connect*']);
  });
  it('keeps the pending button focusable but inert while saving', () => {
    const html = dialog({ phase: 'saving', busy: true });
    expect(html).toMatch(/<button type="button" class="qbtn primary" aria-disabled="true">Saving…<\/button>/);
  });
  it('shows a stored, untrusted endpoint as saved and not verified, with Done', () => {
    const html = dialog({ settings: saved });
    expect(html).toContain('Saved · not verified');
    expect(actions(html)).toEqual(['Edit', 'Connect', 'Done*']);
  });
  it('shows a pinned endpoint as Verified and a waiting push as Connect only', () => {
    expect(dialog({ settings: { ...saved, hostKeyFingerprint: 'SHA256:x' }, connection: { ...saved, hostKeyFingerprint: 'SHA256:x' } })).toMatch(/>Verified</);
    expect(actions(dialog({ settings: saved, canRetry: true }))).toEqual(['Edit', 'Connect*']);
  });
  it('keeps a failed save editing, with the store message', () => {
    const html = dialog({ settings: saved, editing: true, error: 'Robot settings could not be saved.' });
    expect(html).toContain('<p class="rfp-alert" role="alert">Robot settings could not be saved</p>');
    expect(html).not.toContain('Saved ·');
  });
});

describe('Robot upload result: created folder', () => {
  const files = [{ pathId: 'A', name: 'A', fileName: 'A.bdx', size: 1 }];
  const done = (result) => dialog({ phase: 'transferred', settings: saved, result: { state: 'transferred', files, directory: '/home/lvuser/natinst/bin/Paths', ...result } });
  it('states an acknowledged creation of the exact folder', () => {
    expect(done({ directoryCreated: true })).toContain('Folder created. Verified in /home/lvuser/natinst/bin/Paths. Nothing started.');
  });
  it.each([false, undefined, 'true'])('says nothing about creation when directoryCreated is %s', (directoryCreated) => {
    const html = done({ directoryCreated });
    expect(html).toContain('Verified in /home/lvuser/natinst/bin/Paths. Nothing started.');
    expect(html).not.toContain('Created');
  });
  it('keeps the failure concise and preserves readback and creation facts in Details', () => {
    const error = 'Could not verify upload: readback did not match. 1 of 2 files verified on the robot (A.bdx). Created robot folder /home/lvuser/natinst/bin/Paths.';
    const html = dialog({ phase: 'failed', settings: saved, error, canRetry: true, preview: { operationId: 'one', connection: saved, files } });
    expect(html).toContain('role="alert">Could not verify upload: readback did not match</p>');
    expect(html).toContain('<summary>Details</summary><p>' + error + '</p>');
    expect(html).not.toMatch(/uploaded|No routine was activated/);
  });
});

describe('Push review: linked paths outside the push', () => {
  const files = (count = 1) => Array.from({ length: count }, (_, index) => ({ pathId: 'P' + index, name: 'P' + index, fileName: 'P' + index + '.bdx', size: 1 }));
  const linked = (...names) => names.map((name) => ({ id: name, name: name.replace('*', ''), pushable: !name.endsWith('*') }));
  const reviewed = (paths, patch = {}) => ({ phase: 'review', settings: saved, preview: { operationId: 'one', connection: saved, files: files(), linked: paths }, busy: false, includeLinked: vi.fn(), confirmPush: vi.fn(), ...patch });
  const note = (html) => html.match(/<p class="rfp-note rfp-linked"[^>]*>(.*?)<\/p>/)?.[1].replace(/<!-- -->/g, '').replace(/<[^>]+>/g, '|') ?? null;
  it('names one path, several paths and long lists with the full list available, offering Include only for pushable paths', () => {
    expect(note(dialog(reviewed(linked('Amp score'))))).toBe('Linked paths not included: Amp score. |Include 1 path|');
    expect(note(dialog(reviewed(linked('Amp score', 'Source 2*'))))).toBe('Linked paths not included: Amp score, Source 2 (still being drawn). |Include 1 path|');
    const html = dialog(reviewed(linked('A1', 'B2', 'C3', 'D4*', 'E5')));
    expect(note(html)).toBe('Linked paths not included: A1, B2, C3 and 2 more. |Include 4 paths|');
    expect(html).toContain('title="A1, B2, C3, D4 (still being drawn), E5"');
    expect(note(dialog(reviewed(linked('Amp score*', 'Source 2*'))))).toBe('Linked paths not included: Amp score (still being drawn), Source 2 (still being drawn).');
  });
  it('states the 64-path limit instead of offering an Include that main would refuse', () => {
    const limit = (count) => note(dialog(reviewed(linked('Amp score'), { preview: { operationId: 'one', connection: saved, files: files(count), linked: linked('Amp score') } })));
    expect(limit(64)).toBe('Linked paths not included: Amp score. Push sends at most 64 paths at once.');
    expect(limit(63)).toBe('Linked paths not included: Amp score. |Include 1 path|');
  });
  it('shows the note only while reviewing, and nothing without linked paths', () => {
    expect(note(dialog(reviewed([])))).toBeNull();
    expect(note(dialog(reviewed(undefined)))).toBeNull();
    for (const patch of [{ phase: 'uploading', busy: true }, { phase: 'failed', error: 'Upload failed', canRetry: true }, { phase: 'preparing', busy: true }, { phase: 'transferred', result: { files: files(), directory: '/x' } }]) {
      expect(note(dialog(reviewed(linked('Amp score'), patch)))).toBeNull();
    }
  });
  it('keeps Cancel focused first, Upload unfocused, and passes the reviewed operation to Include', () => {
    hooks.cursor = 0;
    const c = dialogController(reviewed(linked('Amp score')));
    const tree = RobotFilePushDialog({ controller: c });
    const by = (label) => find(tree, (node) => node.type === 'button' && [].concat(node.props.children).includes(label));
    expect(by('Cancel').props.autoFocus).toBe(true);
    expect(find(tree, (node) => node.props?.className === 'qbtn primary' && node.props.onClick === c.confirmPush).props.autoFocus).toBeUndefined();
    const linkedNote = find(tree, (node) => Array.isArray(node.props?.linked));
    const include = find(linkedNote.type(linkedNote.props), (node) => node.type === 'button');
    expect(include.props).toMatchObject({ children: 'Include 1 path', disabled: false });
    expect(include.props.autoFocus).toBeUndefined();
    include.props.onClick();
    expect(c.includeLinked).toHaveBeenCalledExactlyOnceWith('one');
    expect(c.confirmPush).not.toHaveBeenCalled();
  });
});
