import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const hooks = vi.hoisted(() => ({ values: [], cursor: 0, effects: [], cleanups: [] }));
vi.mock('react', async (original) => ({
  ...await original(),
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
}));
import { MAX_PUSH_PATHS, linkedOutside, useRobotFilePushController } from '../src/renderer/components/useRobotFilePushController';
import { useRobotPushController } from '../src/renderer/components/useRobotPushController';
import { DEFAULT_ROBOT_PATH_DIRECTORY } from '../src/shared/robotFileDelivery';
const connection = { endpoint: { host: 'robot.local', port: 22, directory: DEFAULT_ROBOT_PATH_DIRECTORY }, hostKeyFingerprint: 'SHA256:test' };
const preview = { operationId: 'one', connection, files: [{ pathId: 'A', name: 'A', fileName: 'A.bdx', size: 64, sha256: 'abc' }] };
let bridge, project, props;
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function render(hook = useRobotFilePushController) {
  hooks.cursor = 0;
  const controller = hook(props);
  for (const effect of hooks.effects.splice(0)) { const cleanup = effect(); if (cleanup) hooks.cleanups.push(cleanup); }
  return controller;
}
beforeEach(() => {
  hooks.values = []; hooks.effects = []; hooks.cleanups = [];
  project = { paths: [{ id: 'A', name: 'Original' }], routines: [] };
  props = { getProject: () => project, projectKey: 'project', catalogKey: 'catalog' };
  bridge = { getRobotFileConnection: vi.fn(async () => connection), saveRobotFileSettings: vi.fn(async endpoint => ({ endpoint })), prepareRobotFiles: vi.fn(async () => preview),
    confirmRobotFiles: vi.fn(async () => ({ state: 'transferred', files: preview.files, directory: connection.endpoint.directory })),
    cancelRobotFiles: vi.fn(async () => ({ canceled: true })), probeRobotFiles: vi.fn(async () => connection), trustRobotFiles: vi.fn(async () => connection) };
  vi.stubGlobal('window', { bordeauxAPI: bridge }); vi.stubGlobal('document', { activeElement: null });
  vi.stubGlobal('requestAnimationFrame', (callback) => callback());
});
afterEach(() => { for (const cleanup of hooks.cleanups) cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const ready = async () => { render(); await Promise.resolve(); return render(); };
const prepare = async () => { const c = await ready(); await c.requestPush({ kind: 'paths', pathIds: ['A'] }); return render(); };
describe('SFTP file push controller', () => {
  it('monitors only after explicit connection or upload, clears stale green, and recovers without losing the receipt', async () => {
    vi.useFakeTimers();
    bridge.checkRobotFileConnection = vi.fn(async () => connection);
    await ready();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(bridge.checkRobotFileConnection).not.toHaveBeenCalled();
    expect(render().reachability).toBe('unknown');
    await render().requestPush({ kind: 'paths', pathIds: ['A'] });
    await render().confirmPush();
    const receipt = render().result;
    expect(render().reachability).toBe('online');
    bridge.checkRobotFileConnection.mockResolvedValueOnce(null);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(render()).toMatchObject({ reachability: 'offline', phase: 'transferred', result: receipt, connection });
    expect(render().connectionLabel).toContain('disconnected');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(render().reachability).toBe('online');
    expect(bridge.confirmRobotFiles).toHaveBeenCalledTimes(1);
    await render().chooseAnotherRobot(); render();
    const checks = bridge.checkRobotFileConnection.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(bridge.checkRobotFileConnection).toHaveBeenCalledTimes(checks);
  });
  it('ignores a late liveness reply after editing the destination', async () => {
    vi.useFakeTimers();
    const pending = deferred();
    bridge.checkRobotFileConnection = vi.fn(() => pending.promise);
    await prepare(); await render().confirmPush(); render();
    await vi.advanceTimersByTimeAsync(5_000);
    await render().chooseAnotherRobot(); render();
    pending.resolve(connection); await Promise.resolve();
    expect(render()).toMatchObject({ reachability: 'unknown', connection: null, editing: true });
  });
  it('does not let an older liveness failure overwrite a newer successful upload', async () => {
    vi.useFakeTimers();
    const pending = deferred();
    bridge.checkRobotFileConnection = vi.fn(() => pending.promise);
    await prepare(); await render().confirmPush(); render();
    await vi.advanceTimersByTimeAsync(5_000);
    await render().requestPush({ kind: 'paths', pathIds: ['A'] });
    await render().confirmPush();
    pending.resolve(null); await Promise.resolve();
    expect(render()).toMatchObject({ reachability: 'online', phase: 'transferred' });
    expect(bridge.confirmRobotFiles).toHaveBeenCalledTimes(2);
  });
  it('saves edited settings without probing, trusting, preparing or transmitting', async () => {
    await ready(); await render().chooseAnotherRobot();
    render().setHost('other.local'); render().setPort('2222'); render().setDirectory('/home/lvuser/practice');
    await render().saveSettings();
    expect(bridge.saveRobotFileSettings).toHaveBeenCalledExactlyOnceWith({ host: 'other.local', port: 2222, directory: '/home/lvuser/practice' });
    expect(render()).toMatchObject({ editing: false, connection: null, settings: { endpoint: { host: 'other.local', port: 2222 } } });
    for (const name of ['probeRobotFiles', 'trustRobotFiles', 'prepareRobotFiles', 'confirmRobotFiles']) expect(bridge[name]).not.toHaveBeenCalled();
  });
  it('restores unverified settings and waits for explicit connection before push', async () => {
    bridge.getRobotFileConnection.mockResolvedValueOnce({ endpoint: connection.endpoint });
    await ready(); await render().requestPush({ kind: 'paths', pathIds: ['A'] });
    expect(render()).toMatchObject({ phase: 'idle', connection: null, host: connection.endpoint.host });
    expect(bridge.probeRobotFiles).not.toHaveBeenCalled(); expect(bridge.prepareRobotFiles).not.toHaveBeenCalled();
  });
  it('keeps edit fields and error after local save fails', async () => {
    await ready(); await render().chooseAnotherRobot(); render().setHost('other.local');
    bridge.saveRobotFileSettings.mockRejectedValueOnce(new Error('disk full'));
    await render().saveSettings();
    expect(render()).toMatchObject({ phase: 'idle', editing: true, host: 'other.local', error: 'disk full' });
  });
  it('reuses the saved robot for repeated pushes and failed-upload retries', async () => {
    const c = await prepare();
    await c.confirmPush();
    await render().requestPush({ kind: 'paths', pathIds: ['A'] });
    expect(render().phase).toBe('review');
    bridge.confirmRobotFiles.mockRejectedValueOnce(new Error("Error invoking remote method 'robotFiles:confirm': RobotTransportError: Required robot directory /natinst is unavailable."));
    await render().confirmPush();
    expect(render().error).toBe('Required robot directory /natinst is unavailable.');
    await render().retry();
    expect(render().phase).toBe('review');
    expect(bridge.probeRobotFiles).not.toHaveBeenCalled();
    expect(bridge.trustRobotFiles).not.toHaveBeenCalled();
  });
  it('remembers the trusted SSH identity when editing the destination', async () => {
    await prepare();
    await render().chooseAnotherRobot();
    render().setDirectory('/home/lvuser/practice');
    const changed = { ...connection, endpoint: { ...connection.endpoint, directory: '/home/lvuser/practice' } };
    bridge.probeRobotFiles.mockResolvedValueOnce(changed);
    bridge.trustRobotFiles.mockResolvedValueOnce(changed);
    await render().probeRobot();
    expect(bridge.trustRobotFiles).toHaveBeenCalledExactlyOnceWith(connection.hostKeyFingerprint);
    expect(render().connection).toEqual(changed);
    expect(render().phase).toBe('review');
  });
  it('requires identity review if the saved robot presents a different SSH key', async () => {
    await prepare(); await render().chooseAnotherRobot();
    bridge.probeRobotFiles.mockResolvedValueOnce({ ...connection, hostKeyFingerprint: 'SHA256:different' });
    await render().probeRobot();
    expect(render().phase).toBe('identity');
    expect(bridge.trustRobotFiles).not.toHaveBeenCalled();
  });
  it('loads the saved endpoint without probing or transmitting', async () => {
    const c = await ready(); expect(c.connection).toEqual(connection); expect(c.directory).toBe(DEFAULT_ROBOT_PATH_DIRECTORY);
    expect(bridge.probeRobotFiles).not.toHaveBeenCalled(); expect(bridge.prepareRobotFiles).not.toHaveBeenCalled();
    expect(c.itemStatus('path', 'A')).toMatchObject({ label: 'Local' });
  });
  it('captures selected path IDs and project values before asynchronous preparation', async () => {
    const pending = deferred(); bridge.prepareRobotFiles.mockReturnValue(pending.promise);
    const c = await ready(); const selection = ['A']; const work = c.requestPush({ kind: 'paths', pathIds: selection });
    project.paths[0].name = 'Edited'; selection.push('B');
    await Promise.resolve(); pending.resolve(preview); await work;
    expect(bridge.prepareRobotFiles).toHaveBeenCalledWith({ paths: [{ id: 'A', name: 'Original' }], routines: [] }, ['A']);
    expect(render().phase).toBe('review'); expect(bridge.confirmRobotFiles).not.toHaveBeenCalled();
  });
  it('keeps confirmation locked until the upload promise settles', async () => {
    const pending = deferred(); bridge.confirmRobotFiles.mockReturnValue(pending.promise);
    const c = await prepare(); const work = c.confirmPush(); await c.confirmPush();
    await c.requestPush({ kind: 'paths', pathIds: ['B'] });
    expect(bridge.confirmRobotFiles).toHaveBeenCalledTimes(1); expect(bridge.prepareRobotFiles).toHaveBeenCalledTimes(1);
    pending.resolve({ state: 'transferred', files: preview.files }); await work;
    expect(render().phase).toBe('transferred');
  });
  it('invalidates reviewed files after catalog changes', async () => {
    await prepare(); props = { ...props, catalogKey: 'changed' }; render();
    expect(render().preview).toBeNull(); expect(bridge.cancelRobotFiles).toHaveBeenCalledWith('one');
  });
  it('leaves the connection alone when the project changes with no push captured', async () => {
    await ready(); props = { ...props, catalogKey: 'changed' }; render();
    expect(render()).toMatchObject({ phase: 'idle', error: '', connection });
    expect(bridge.cancelRobotFiles).not.toHaveBeenCalled();
  });
  it.each(['projectKey', 'catalogKey', 'bookmarkKey'])('retires a completed push before a %s change without a stale alert', async key => {
    await prepare(); await render().confirmPush();
    const result = render().result;
    expect(render()).toMatchObject({ phase: 'transferred', canRetry: false, preview: null });
    props = { ...props, [key]: 'changed' }; render();
    expect(render()).toMatchObject({ phase: 'transferred', error: '', connection, result });
    expect(bridge.cancelRobotFiles).not.toHaveBeenCalled();
    await render().retry();
    expect(bridge.prepareRobotFiles).toHaveBeenCalledTimes(1);
  });
  it('still applies a slow settings load after a project change with no push captured', async () => {
    const pending = deferred(); bridge.getRobotFileConnection.mockReturnValue(pending.promise);
    render(); props = { ...props, bookmarkKey: 'opened' }; render();
    pending.resolve(connection); await Promise.resolve(); await Promise.resolve();
    expect(render()).toMatchObject({ phase: 'idle', error: '', connection, host: 'robot.local' });
  });
  it('still invalidates a requested push when the project changes', async () => {
    bridge.getRobotFileConnection.mockResolvedValueOnce({ endpoint: connection.endpoint });
    await ready(); await render().requestPush({ kind: 'paths', pathIds: ['A'] });
    props = { ...props, projectKey: 'other' }; render();
    expect(render()).toMatchObject({ canRetry: false, error: 'The project changed. Choose Push again to review the current paths.' });
  });
  it('surfaces failed preparation and supports a fresh retry', async () => {
    bridge.prepareRobotFiles.mockRejectedValueOnce(new Error('Path cannot be exported'));
    await prepare(); const c = render(); expect(c.phase).toBe('failed'); expect(c.error).toBe('Path cannot be exported');
    await c.retry(); expect(render().phase).toBe('review');
  });
  it('keeps upload busy after a cancellation request until RPC settles', async () => {
    const pending = deferred(); bridge.confirmRobotFiles.mockReturnValue(pending.promise);
    const c = await prepare(); const work = c.confirmPush(); await c.cancel();
    expect(render().busy).toBe(true); await c.requestPush({ kind: 'paths', pathIds: ['B'] });
    expect(bridge.prepareRobotFiles).toHaveBeenCalledTimes(1);
    pending.reject(new Error('Upload canceled')); await work;
    expect(render().phase).toBe('failed'); expect(render().error).toBe('Upload canceled');
  });
  it.each(['routine', 'project'])('does not prepare unsupported %s delivery', async (kind) => {
    const c = await ready(); await c.requestPush({ kind });
    expect(render().phase).toBe('unsupported'); expect(bridge.prepareRobotFiles).not.toHaveBeenCalled();
  });
  it('continues pending selection when the saved connection arrives late', async () => {
    const pending = deferred(); bridge.getRobotFileConnection.mockReturnValue(pending.promise);
    const c = render(); await c.requestPush({ kind: 'paths', pathIds: ['A'] });
    pending.resolve(connection); await Promise.resolve(); await Promise.resolve();
    expect(bridge.prepareRobotFiles).toHaveBeenCalledOnce(); expect(render().phase).toBe('review');
  });
});

describe('linked paths outside a push', () => {
  // A and B share a point; C is endpoint-linked to B and still being drawn; D stands alone.
  const linkedProject = () => ({ paths: [
    { id: 'A', name: 'Amp score', waypoints: [{ positionLink: 'g1' }, {}] },
    { id: 'B', name: 'Source 2', waypoints: [{}, { positionLink: 'g1' }] },
    { id: 'C', name: 'Trench', waypoints: [{}] },
    { id: 'D', name: 'Solo', waypoints: [{}, {}] },
  ], pathLinks: [{ fromPathId: 'C', toPathId: 'B' }, { fromPathId: 'gone', toPathId: 'A' }], routines: [] });
  const B = { id: 'B', name: 'Source 2', pushable: true }, C = { id: 'C', name: 'Trench', pushable: false };
  // Mirrors main's refusal of a path the captured project no longer has.
  const prepared = (count = { value: 0 }) => async (source, ids) => {
    if (ids.some((id) => !source.paths.some((path) => path.id === id))) throw new Error('A selected path is missing or ambiguous.');
    return { operationId: 'op' + (++count.value), connection, files: ids.map((id) => ({ pathId: id, name: id, fileName: id + '.bdx', size: 1, sha256: 'x' })) };
  };
  const review = async (pathIds = ['A']) => { const c = await ready(); await c.requestPush({ kind: 'paths', pathIds }); return render(); };
  beforeEach(() => { project = linkedProject(); bridge.prepareRobotFiles.mockImplementation(prepared()); });

  it('lists the transitive endpoint and shared closure outside the selection in project order', () => {
    expect(linkedOutside(project, ['A'])).toEqual([B, C]);
    expect(linkedOutside(project, ['C', 'A'])).toEqual([B]);
    expect(linkedOutside(project, ['D'])).toEqual([]);
    expect(linkedOutside({ paths: [{ id: 'X' }, { id: 'Y', name: 'Y' }], pathLinks: [{ fromPathId: 'Y', toPathId: 'X' }] }, ['Y'])).toEqual([{ id: 'X', name: undefined, pushable: false }]);
    expect(MAX_PUSH_PATHS).toBe(64);
  });
  it('publishes the note with its review and keeps it renderer-only', async () => {
    const c = await review();
    expect(c).toMatchObject({ phase: 'review', preview: { operationId: 'op1', linked: [B, C] } });
    expect(bridge.prepareRobotFiles).toHaveBeenCalledExactlyOnceWith(expect.anything(), ['A']);
    await c.confirmPush();
    expect(bridge.confirmRobotFiles).toHaveBeenCalledExactlyOnceWith('op1');
  });
  it('publishes the note after delayed settings and after trusting another robot', async () => {
    const pending = deferred(); bridge.getRobotFileConnection.mockReturnValue(pending.promise);
    await render().requestPush({ kind: 'paths', pathIds: ['A'] });
    pending.resolve(connection); await new Promise((settle) => setTimeout(settle, 0));
    expect(render()).toMatchObject({ phase: 'review', preview: { linked: [B, C] } });
    await render().chooseAnotherRobot();
    expect(render().preview).toBeNull();
    await render().probeRobot();
    expect(render()).toMatchObject({ phase: 'review', preview: { operationId: 'op2', linked: [B, C] } });
  });
  it('includes linked pushable paths from the captured project, even after the source changed, then reviews again', async () => {
    const selection = ['A'];
    const c = await ready(); await c.requestPush({ kind: 'paths', pathIds: selection });
    const captured = bridge.prepareRobotFiles.mock.calls[0][0];
    render().close();
    project = { ...project, paths: project.paths.filter((path) => path.id !== 'B').map((path) => ({ ...path, name: 'Edited' })) };
    render().openConnection();
    await render().includeLinked('op1');
    expect(bridge.cancelRobotFiles).toHaveBeenCalledExactlyOnceWith('op1');
    expect(bridge.prepareRobotFiles).toHaveBeenLastCalledWith(captured, ['A', 'B']);
    expect(bridge.prepareRobotFiles.mock.calls[1][0]).toBe(captured);
    expect(render()).toMatchObject({ phase: 'review', preview: { operationId: 'op2', linked: [C] } });
    expect(selection).toEqual(['A']);
    expect(bridge.confirmRobotFiles).not.toHaveBeenCalled();
    await render().confirmPush();
    expect(bridge.confirmRobotFiles).toHaveBeenCalledExactlyOnceWith('op2');
  });
  it('ignores a duplicate, stale or cancelled Include', async () => {
    const c = await review();
    await c.includeLinked('stale');
    expect(render()).toMatchObject({ phase: 'review', preview: { operationId: 'op1' } });
    const first = c.includeLinked('op1'); const second = c.includeLinked('op1'); await Promise.all([first, second]);
    expect(bridge.prepareRobotFiles).toHaveBeenCalledTimes(2); expect(bridge.cancelRobotFiles).toHaveBeenCalledTimes(1);
    await render().cancel();
    expect(render().phase).toBe('cancelled');
    await c.includeLinked('op2');
    expect(bridge.prepareRobotFiles).toHaveBeenCalledTimes(2);
  });
  it.each(['resolve', 'reject'])('drops an Include whose discard settles (%s) after invalidation', async (outcome) => {
    const c = await review();
    const pending = deferred(); bridge.cancelRobotFiles.mockReturnValueOnce(pending.promise);
    const work = c.includeLinked('op1');
    expect(render().phase).toBe('preparing');
    props = { ...props, projectKey: 'other' }; render();
    if (outcome === 'resolve') pending.resolve({ canceled: true }); else pending.reject(new Error('late discard'));
    await work;
    expect(bridge.prepareRobotFiles).toHaveBeenCalledTimes(1);
    expect(render()).toMatchObject({ phase: 'idle', preview: null, canRetry: false, error: 'The project changed. Choose Push again to review the current paths.' });
  });
  it.each(['resolve', 'reject'])('drops a public push whose discard settles (%s) after invalidation', async (outcome) => {
    const c = await review();
    const pending = deferred(); bridge.cancelRobotFiles.mockReturnValueOnce(pending.promise);
    const work = c.requestPush({ kind: 'paths', pathIds: ['D'] });
    props = { ...props, bookmarkKey: 'other' }; render();
    if (outcome === 'resolve') pending.resolve({ canceled: true }); else pending.reject(new Error('late discard'));
    await work;
    expect(bridge.prepareRobotFiles).toHaveBeenCalledTimes(1);
    expect(render()).toMatchObject({ phase: 'idle', error: 'The project changed. Choose Push again to review the current paths.' });
  });
  it('refuses more than 64 paths before discarding the valid review, and allows exactly 64', async () => {
    const many = (count) => ({ paths: Array.from({ length: count }, (_, index) => ({ id: 'P' + index, name: 'P' + index,
      waypoints: index >= count - 2 ? [{}, { positionLink: 'end' }] : [{}, {}] })), routines: [] });
    project = many(65);
    let c = await review(project.paths.slice(0, 64).map((path) => path.id));
    await c.includeLinked('op1');
    expect(render()).toMatchObject({ phase: 'review', preview: { operationId: 'op1' }, error: 'Push sends at most 64 paths at once. Including these would make 65.' });
    expect(bridge.cancelRobotFiles).not.toHaveBeenCalled(); expect(bridge.prepareRobotFiles).toHaveBeenCalledTimes(1);
    hooks.values = []; hooks.effects = [];
    project = many(64);
    c = await review(project.paths.slice(0, 63).map((path) => path.id));
    await c.includeLinked(c.preview.operationId);
    expect(bridge.prepareRobotFiles.mock.lastCall[1]).toHaveLength(64);
    expect(render().phase).toBe('review');
  });
  it('keeps the widened IDs for a fresh Retry after main refuses, and never drops a deleted path', async () => {
    const c = await review();
    bridge.prepareRobotFiles.mockRejectedValueOnce(new Error('Two paths would write the same robot file name.'));
    await c.includeLinked('op1');
    expect(render()).toMatchObject({ phase: 'failed', preview: null, canRetry: true, error: 'Two paths would write the same robot file name.' });
    const captured = bridge.prepareRobotFiles.mock.calls[0][0];
    project = { ...project, paths: project.paths.filter((path) => path.id !== 'B') };
    await render().retry();
    expect(bridge.prepareRobotFiles.mock.lastCall[0]).not.toBe(captured);
    expect(bridge.prepareRobotFiles.mock.lastCall[1]).toEqual(['A', 'B']);
    expect(render()).toMatchObject({ phase: 'failed', error: 'A selected path is missing or ambiguous.' });
    project = linkedProject();
    await render().retry();
    expect(render()).toMatchObject({ phase: 'review', preview: { linked: [C] } });
    expect(bridge.prepareRobotFiles.mock.lastCall[1]).toEqual(['A', 'B']);
  });
});

describe('shipping robot delivery selection', () => {
  it('routes desktop file-transfer capabilities through the supported controller', async () => {
    bridge.robotDeliveryCapabilities = { fileTransfer: true, pathPush: true, routinePush: false };
    render(useRobotPushController); await Promise.resolve();
    const controller = render(useRobotPushController);
    expect(controller.fileTransfer).toBe(true);
    await controller.requestPush({ kind: 'paths', pathIds: ['A'] });
    expect(bridge.prepareRobotFiles).toHaveBeenCalledOnce();
    expect(render(useRobotPushController).phase).toBe('review');
  });
  it('offers a local fallback without calling legacy transport APIs', () => {
    bridge.robotDeliveryCapabilities = { fileTransfer: false, pathPush: true };
    bridge.getRobotPairing = vi.fn(); bridge.prepareRobotPush = vi.fn();
    const controller = render(useRobotPushController);
    controller.requestPush({ kind: 'paths', pathIds: ['A'] });
    const unavailable = render(useRobotPushController);
    expect(unavailable.open).toBe(true);
    expect(unavailable.deliveryAvailable).toBe(false);
    expect(unavailable.unavailable.pathId).toBe('A');
    expect(unavailable.unavailable.reason).toContain('Export the path locally');
    expect(bridge.getRobotPairing).not.toHaveBeenCalled();
    expect(bridge.prepareRobotPush).not.toHaveBeenCalled();
    expect(bridge.prepareRobotFiles).not.toHaveBeenCalled();
  });
});
