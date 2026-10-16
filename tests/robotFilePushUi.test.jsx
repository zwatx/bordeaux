import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
const hooks = vi.hoisted(() => ({ values: [], cursor: 0 }));
// Hooks become plain calls, so PushControl can be called directly and its buttons' handlers invoked.
vi.mock('react', async (original) => ({
  ...await original(),
  useRef(initial) { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = { current: initial }; return hooks.values[index]; },
  useEffect() { hooks.cursor++; },
}));
import * as React from 'react';
import { PushControl } from '../src/renderer/components/PushControl';
import { RobotFilePushDialog } from '../src/renderer/components/RobotFilePushDialog';

const path = (id, waypoints = 3) => ({ id, name: 'Path ' + id, waypoints: Array.from({ length: waypoints }, () => ({})) });
const controller = (patch = {}) => ({ fileTransfer: true, busy: false, desktopAvailable: true, phase: 'idle', settings: null, requestPush: vi.fn(), openConnection: vi.fn(), ...patch });
const find = (node, test) => {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) { for (const child of node) { const hit = find(child, test); if (hit) return hit; } return null; }
  if (test(node)) return node;
  return find(node.props?.children, test);
};
function control(props) {
  hooks.cursor = 0;
  const tree = PushControl({ place: 'paths', selection: { selected: ['A'] }, activeRoutine: null, ...props });
  return { all: find(tree, (node) => node.props?.className === 'push-all'), push: find(tree, (node) => node.props?.className === 'push-button') };
}
beforeEach(() => { hooks.values = []; vi.stubGlobal('window', { bordeauxAPI: {} }); });

describe('Push all', () => {
  it('requests every authored path, including ones the library hides, while Push keeps its exact selection', () => {
    const c = controller();
    const { all, push } = control({ paths: [path('A'), path('B'), path('C')], controller: c });
    expect(all.props).toMatchObject({ 'aria-label': 'Push all 3 paths', disabled: false, children: 'Push all 3' });
    expect(all.props.title).toMatch(/hidden by search or a collapsed folder/);
    all.props.onClick();
    expect(c.requestPush).toHaveBeenLastCalledWith({ kind: 'paths', pathIds: ['A', 'B', 'C'] });
    push.props.onClick();
    expect(c.requestPush).toHaveBeenLastCalledWith({ kind: 'paths', pathIds: ['A'] });
    expect(push.props).toMatchObject({ 'aria-label': 'Push path', 'data-shortcut': expect.any(String) });
  });
  it('is unavailable, with the reason, for no paths or any path still being drawn', () => {
    expect(control({ paths: [], selection: { selected: [] }, controller: controller() }).all.props).toMatchObject({ disabled: true, title: 'No paths to push', children: 'Push all 0' });
    expect(control({ paths: [path('A'), path('B', 1)], controller: controller() }).all.props).toMatchObject({ disabled: true, title: '1 path needs at least two waypoints' });
    expect(control({ paths: [path('A', 0), path('B', 1)], controller: controller() }).all.props).toMatchObject({ disabled: true, title: '2 paths need at least two waypoints' });
    expect(control({ paths: [path('A')], controller: controller({ desktopAvailable: false }) }).all.props.disabled).toBe(true);
  });
  it('stays focusable but inert while a push runs', () => {
    const c = controller({ busy: true, phase: 'preparing' });
    const { all } = control({ paths: [path('A'), path('B')], controller: c });
    expect(all.props).toMatchObject({ disabled: false, 'aria-disabled': true, onClick: undefined });
  });
  it('appears only for path file transfer', () => {
    expect(control({ paths: [path('A')], controller: controller({ fileTransfer: false, desktopAvailable: true }) }).all).toBeNull();
    expect(control({ place: 'routines', paths: [path('A')], controller: controller() }).all).toBeNull();
  });
  it('shows saving progress inside the destination button, which stays mounted for focus return', () => {
    hooks.cursor = 0;
    const html = renderToStaticMarkup(PushControl({ place: 'paths', paths: [path('A')], selection: { selected: ['A'] }, controller: controller({ phase: 'saving', busy: true }) }));
    expect(html).toMatch(/<button[^>]*class="push-destination"[^>]*aria-label="Saving…"[^>]*><span class="push-status-full">Saving…<\/span><span class="push-status-compact" aria-hidden="true">Saving<\/span><\/button>/);
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
    expect(html).toContain('Save works without the robot. Connect checks its SSH host key.');
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
    expect(html).toContain('<p class="rfp-alert" role="alert">Robot settings could not be saved.</p>');
    expect(html).not.toContain('Saved ·');
  });
});

describe('Robot upload result: created folder', () => {
  const files = [{ pathId: 'A', name: 'A', fileName: 'A.bdx', size: 1 }];
  const done = (result) => dialog({ phase: 'transferred', settings: saved, result: { state: 'transferred', files, directory: '/home/lvuser/natinst/bin/Paths', ...result } });
  it('states an acknowledged creation of the exact folder', () => {
    expect(done({ directoryCreated: true })).toContain('Created robot folder /home/lvuser/natinst/bin/Paths and verified the files there. No routine was activated.');
  });
  it.each([false, undefined, 'true'])('says nothing about creation when directoryCreated is %s', (directoryCreated) => {
    const html = done({ directoryCreated });
    expect(html).toContain('Verified in /home/lvuser/natinst/bin/Paths. No routine was activated.');
    expect(html).not.toContain('Created');
  });
  it('shows a later failure verbatim, including its created fact, with no success claim', () => {
    const error = 'Could not verify upload: readback did not match. 1 of 2 files verified on the robot (A.bdx). Created robot folder /home/lvuser/natinst/bin/Paths.';
    const html = dialog({ phase: 'failed', settings: saved, error, canRetry: true, preview: { operationId: 'one', connection: saved, files } });
    expect(html).toContain('role="alert">' + error + '</p>');
    expect(html).not.toMatch(/uploaded|No routine was activated/);
  });
});

describe('Push review: linked paths outside the push', () => {
  const files = (count = 1) => Array.from({ length: count }, (_, index) => ({ pathId: 'P' + index, name: 'P' + index, fileName: 'P' + index + '.bdx', size: 1 }));
  const linked = (...names) => names.map((name) => ({ id: name, name: name.replace('*', ''), pushable: !name.endsWith('*') }));
  const reviewed = (paths, patch = {}) => ({ phase: 'review', settings: saved, preview: { operationId: 'one', connection: saved, files: files(), linked: paths }, busy: false, includeLinked: vi.fn(), confirmPush: vi.fn(), ...patch });
  const note = (html) => html.match(/<p class="rfp-note rfp-linked"[^>]*>(.*?)<\/p>/)?.[1].replace(/<!-- -->/g, '').replace(/<[^>]+>/g, '|') ?? null;
  it('names one path, several paths and long lists with the full list available, offering Include only for pushable paths', () => {
    expect(note(dialog(reviewed(linked('Amp score'))))).toBe('Linked to Amp score, which is not included. |Include 1 path|');
    expect(note(dialog(reviewed(linked('Amp score', 'Source 2*'))))).toBe('Linked to 2 paths that are not included: Amp score, Source 2 (still being drawn). |Include 1 path|');
    const html = dialog(reviewed(linked('A1', 'B2', 'C3', 'D4*', 'E5')));
    expect(note(html)).toBe('Linked to 5 paths that are not included: A1, B2, C3 and 2 more. |Include 4 paths|');
    expect(html).toContain('title="A1, B2, C3, D4 (still being drawn), E5"');
    expect(note(dialog(reviewed(linked('Amp score*', 'Source 2*'))))).toBe('Linked to 2 paths that are not included: Amp score (still being drawn), Source 2 (still being drawn).');
  });
  it('states the 64-path limit instead of offering an Include that main would refuse', () => {
    const limit = (count) => note(dialog(reviewed(linked('Amp score'), { preview: { operationId: 'one', connection: saved, files: files(count), linked: linked('Amp score') } })));
    expect(limit(64)).toBe('Linked to Amp score, which is not included. Push sends at most 64 paths at once.');
    expect(limit(63)).toBe('Linked to Amp score, which is not included. |Include 1 path|');
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
