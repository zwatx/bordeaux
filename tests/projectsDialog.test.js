import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProjectsDialog, sameProject, locationHint, recoveryKind, recoveryRows, recoveryUsage } from '../src/renderer/components/ProjectsDialog';
import { createDemoProject } from '../src/shared/project/defaults';
import { listRecentProjects } from '../src/electron/recentProjectFiles';
import { loadProjectSelection } from '../src/electron/projectOpening';
import { autosaveProjectFolder, projectWorkspacePath } from '../src/electron/projectFiles';
import * as lifecycleExports from '../src/renderer/lib/projectLifecycle';

const workspace = (folder) => ({ folderPath: folder, projectPath: folder + '/.bordeaux-workspace.json' });

describe('Projects current row identity', () => {
  const current = workspace('/team/Week 3 autos');

  it('matches the same workspace, including a trailing separator', () => {
    expect(sameProject(workspace('/team/Week 3 autos'), current)).toBe(true);
    expect(sameProject({ folderPath: '/team/Week 3 autos/', projectPath: '/team/Week 3 autos/.bordeaux-workspace.json' }, current)).toBe(true);
  });

  it('keeps distinct legacy files in the current folder as their own projects', () => {
    expect(sameProject({ folderPath: '/team/Week 3 autos', projectPath: '/team/Week 3 autos/Other.bordeaux' }, current)).toBe(false);
    expect(sameProject({ folderPath: '/team/Week 3 autos', projectPath: '/team/Week 3 autos/Second.bordeaux' }, current)).toBe(false);
    // A migrated or .bordeaux.json legacy file has no save target of its own; beside a workspace it is still different.
    expect(sameProject({ folderPath: '/team/Week 3 autos', projectPath: null }, current)).toBe(false);
  });

  it('matches the open legacy file itself but never collapses ambiguous null targets', () => {
    const legacy = { folderPath: '/team/Old', projectPath: '/team/Old/Autos.bordeaux' };
    expect(sameProject({ ...legacy }, legacy)).toBe(true);
    expect(sameProject({ folderPath: '/team/Old', projectPath: '/team/Old/Other.bordeaux' }, legacy)).toBe(false);
    expect(sameProject({ folderPath: '/team/Empty', projectPath: null }, { folderPath: '/team/Empty', projectPath: null })).toBe(false);
    expect(sameProject({ folderPath: '/team/Empty', projectPath: '', legacyFile: '' }, { folderPath: '/team/Empty', projectPath: null })).toBe(false);
  });

  it('keeps explicit source identity independent of null or shared save targets', () => {
    const a = { folderPath: '/team/Old', projectPath: null, legacyFile: '/team/Old/A.bordeaux.json' };
    const b = { ...a, legacyFile: '/team/Old/B.bordeaux.json' };
    expect(sameProject(a, a)).toBe(true); expect(sameProject(b, a)).toBe(false);
    expect(sameProject({ ...a, projectPath: '/team/Old/.bordeaux-workspace.json' }, a)).toBe(true);
    expect(sameProject({ ...b, projectPath: '/team/Old/.bordeaux-workspace.json' }, a)).toBe(false);
    expect(locationHint(a)).toBe(a.legacyFile); expect(locationHint(b)).toBe(b.legacyFile);
    expect(locationHint({ ...a, projectPath: '/team/Old/.bordeaux-workspace.json' })).toBe(a.legacyFile);
  });

  it('distinguishes real sibling JSON legacy sources and matches workspace aliases after proven migration', async () => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'bordeaux-project-row-identity-'));
    try {
      const a = path.join(folder, 'A.bordeaux.json'), b = path.join(folder, 'B.bordeaux.json'), ordinary = path.join(folder, 'C.bordeaux');
      for (const [filename, name] of [[a, 'A'], [b, 'B'], [ordinary, 'C']]) { const project = createDemoProject(); project.name = name; await fs.writeFile(filename, JSON.stringify(project)); }
      const before = await Promise.all([a, b, ordinary].map(filename => fs.readFile(filename, 'utf8')));
      const listed = await listRecentProjects([a, b, ordinary]);
      expect(listed[0].id).not.toBe(listed[1].id);
      expect(listed[0].location).toEqual({ folderPath: folder, projectPath: null, legacyFile: a });
      expect(listed[1].location).toEqual({ folderPath: folder, projectPath: null, legacyFile: b });
      expect(listed[2].location).toEqual({ folderPath: folder, projectPath: ordinary, legacyFile: ordinary });
      const selected = await loadProjectSelection(a);
      const current = { folderPath: selected.folderPath, projectPath: selected.projectPath, legacyFile: selected.legacyFile };
      expect(sameProject(listed[0].location, current)).toBe(true); expect(sameProject(listed[1].location, current)).toBe(false);
      expect(listed.map(row => locationHint(row.location))).toEqual([a, b, ordinary]);
      expect(await Promise.all([a, b, ordinary].map(filename => fs.readFile(filename, 'utf8')))).toEqual(before);
      await autosaveProjectFolder(folder, selected.project, selected.projectPath, { legacyFile: selected.legacyFile });
      const aliases = await listRecentProjects([folder, projectWorkspacePath(folder), a, b]);
      const migrated = await loadProjectSelection(a), migratedLocation = { folderPath: migrated.folderPath, projectPath: migrated.projectPath };
      expect(migrated.legacyFile).toBeNull();
      for (const row of aliases.slice(0, 3)) {
        expect(row.location).toEqual({ folderPath: folder, projectPath: projectWorkspacePath(folder) });
        expect(sameProject(row.location, migratedLocation)).toBe(true);
      }
      expect(sameProject(aliases[3].location, migratedLocation)).toBe(false);
      expect(aliases[3].location.legacyFile).toBe(b);
    } finally { await fs.rm(folder, { recursive: true, force: true }); }
  });

  it('never marks a recent current for an Untitled project', () => {
    expect(sameProject({ folderPath: null, projectPath: null }, { folderPath: null, projectPath: null })).toBe(false);
    expect(sameProject(workspace('/team/Week 3 autos'), { folderPath: null, projectPath: null })).toBe(false);
  });
});

describe('recovery management rows', () => {
  const at = (minutes) => new Date(Date.UTC(2026, 9, 12, 14, 0) - minutes * 60_000).toISOString();
  const entry = (id, extra = {}) => ({ id, recordId: id, name: 'Copy ' + id, available: true, origin: { kind: 'untitled', id: 'u' }, updatedAt: at(1), receipt: { recordId: id, revision: 1, digest: 'a'.repeat(64) }, ...extra });
  const listing = { limited: false, entries: [
    entry('saved', { resolved: { at: at(5), sourceDigest: 'b'.repeat(64) }, discardable: true, updatedAt: at(9) }),
    entry('open-old', { discardable: true, updatedAt: at(30) }),
    entry('mine', { discardable: false, updatedAt: at(2) }),
    entry('retired', { discardable: false, updatedAt: at(3) }),
    entry('legacy', { updatedAt: at(4) }),
    { id: 'entry-bad', recordId: null, name: 'Recovery copy', available: false, code: 'invalid-record', fact: 'Recovery record could not be read' },
    entry('open-new', { discardable: true, updatedAt: at(1) }),
  ] };

  it('names a copy “Open now” only when it is exactly the session’s current record', () => {
    expect(recoveryKind(listing.entries[2], 'mine')).toBe('current');
    // Not discardable but not this window’s: a retained branch main still holds is “In use”, never “Open now”.
    expect(recoveryKind(listing.entries[3], 'mine')).toBe('busy');
    expect(recoveryKind(listing.entries[2], null)).toBe('busy');
    expect(recoveryKind(listing.entries[2], 'someone-else')).toBe('busy');
  });

  it('never infers “in use” or discardable from a missing flag (an older main’s rows restore only)', () => {
    const [row] = recoveryRows({ entries: [listing.entries[4]] }, { manage: true, currentRecordId: 'mine' });
    expect(row.kind).toBe('open');
    expect(row.discardable).toBe(false);
  });

  it('Manage groups unsaved, this window’s, in use, saved, unreadable; newest first within each', () => {
    const rows = recoveryRows(listing, { manage: true, currentRecordId: 'mine' });
    expect(rows.map((row) => row.entry.id)).toEqual(['open-new', 'legacy', 'open-old', 'mine', 'retired', 'saved', 'entry-bad']);
    expect(rows.filter((row) => row.discardable).map((row) => row.entry.id)).toEqual(['open-new', 'open-old', 'saved']);
  });

  it('the default list keeps its newest-first order and never names a current copy', () => {
    const rows = recoveryRows({ entries: listing.entries.filter((item) => !item.resolved) });
    expect(rows.map((row) => row.entry.id)).toEqual(['open-new', 'mine', 'retired', 'legacy', 'open-old', 'entry-bad']);
    expect(rows.some((row) => row.kind === 'current')).toBe(false);
  });

  it('counts records, or megabytes when bytes bind, and says full only when main does', () => {
    expect(recoveryUsage({ recordCount: 32, recordLimit: 32, bytes: 10 * 1024 * 1024, byteLimit: 256 * 1024 * 1024, full: true })).toBe('32 of 32 · full');
    expect(recoveryUsage({ recordCount: 12, recordLimit: 32, bytes: 256 * 1024 * 1024, byteLimit: 256 * 1024 * 1024, full: true })).toBe('256 of 256 MB · full');
    expect(recoveryUsage({ recordCount: 3, recordLimit: 32, bytes: 1, byteLimit: 256 * 1024 * 1024, full: false })).toBe('3 of 32');
    expect(recoveryUsage(undefined)).toBe('');
  });

  const sheet = (recoveries) => renderToStaticMarkup(React.createElement(ProjectsDialog, { request: { mode: 'list', recoveries },
    current: { name: 'Week 3 autos', folderPath: null, projectPath: null, recoveryRecordId: null },
    actions: { listRecent: () => new Promise(() => undefined), creationDefaults: () => new Promise(() => undefined), listRecoveries: () => new Promise(() => undefined) }, pending: null, onClose() {} }));

  it('offers the first discard step only on discardable copies, and full storage only from main’s capacity', () => {
    const markup = sheet({ limited: false, entries: listing.entries.filter((item) => !item.resolved), capacity: { recordCount: 32, recordLimit: 32, bytes: 0, byteLimit: 1, full: true } });
    expect(markup.match(/data-recovery="discard-step"/g)).toHaveLength(2);
    expect(markup).toContain('Discard recovery copy of “Copy open-new” from');
    expect(markup).toContain('>Recovery storage full<');
    expect(markup).toContain('data-action="manage-recoveries">Manage…<');
    expect(markup).toContain('data-kind="busy"');
    expect(markup).toContain('>In use<');
    expect(markup).not.toContain('Open now');
    const roomy = sheet({ limited: false, entries: [listing.entries[1]], capacity: { recordCount: 1, recordLimit: 32, bytes: 0, byteLimit: 1, full: false } });
    expect(roomy).not.toContain('Recovery storage full');
    expect(roomy).not.toContain('Manage…');
  });
});

// Save copy: the actual sheet callbacks with deferred owners, defaults, picker replies and results. Rendering here is
// static markup only; focus is observed through the refs the callbacks use.
async function sheetCallback(name, dependencies) {
  const file = 'src/renderer/components/ProjectsDialog.jsx', source = await fs.readFile(file, 'utf8'), ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
  let expression;
  const visit = (node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === name && ts.isArrowFunction(node.initializer)) expression = node.initializer;
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name && node.initializer) expression = ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(ast); if (!expression) throw new Error('Missing actual callback ' + name);
  return vm.runInNewContext(ts.transpileModule('(' + expression.getText(ast) + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { ...lifecycleExports, ...dependencies });
}
// The actual name field's change handler, as the form renders it (the object literal with id 'pj-new-name').
async function nameChange(dependencies) {
  const file = 'src/renderer/components/ProjectsDialog.jsx', source = await fs.readFile(file, 'utf8'), ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
  const prop = (node, name) => node.properties.find((item) => ts.isPropertyAssignment(item) && item.name.getText(ast) === name);
  let expression;
  const visit = (node) => {
    if (ts.isObjectLiteralExpression(node) && prop(node, 'id')?.initializer.getText(ast) === "'pj-new-name'") expression = prop(node, 'onChange')?.initializer;
    ts.forEachChild(node, visit);
  };
  visit(ast); if (!expression) throw new Error('Missing actual name field handler');
  return vm.runInNewContext(ts.transpileModule('(' + expression.getText(ast) + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { ...lifecycleExports, ...dependencies });
}
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const settle = () => new Promise((resolve) => setImmediate(resolve));
const replies = () => { const calls = [], fn = vi.fn(() => { const reply = deferred(); calls.push(reply); return reply.promise; }); fn.calls = calls; return fn; };

async function copyForm({ current = { name: 'Week 3 autos', folderPath: '/team/Week 3 autos', projectPath: null }, bridge = 'copy' } = {}) {
  const state = { mode: 'list', copy: null, block: null, draft: { name: 'New project', parent: '/home/Bordeaux', parentStatus: 'ready', sameRobot: true, error: '', errorField: 'name' } };
  const frames = [], set = (key) => (next) => { state[key] = typeof next === 'function' ? next(state[key]) : next; };
  const refs = { alive: { current: true }, entry: { current: null }, submitting: { current: null }, modeRef: { current: 'list' }, refreshLater: { current: false }, enteredNew: { current: false },
    interaction: { current: 0 }, confirmRef: { current: null },
    nameInput: { current: { focus: vi.fn(), select: vi.fn() } }, locationButton: { current: { focus: vi.fn() } }, retryButton: { current: { focus: vi.fn() } }, search: { current: { focus: vi.fn() } } };
  const fx = { onClose: vi.fn(), setRowError: vi.fn(), setSaid: vi.fn(), setQuery: vi.fn(), setConfirm: vi.fn(), setRecoveries: vi.fn(), listRecoveries: vi.fn() };
  // A bridge without the copy form (an older main, the browser) has only the picker's Save and Save copy.
  const actions = bridge === 'legacy' ? { chooseParent: replies(), save: replies(), saveCopy: replies() }
    : { ownsCopy: vi.fn(() => true), copyOwner: replies(), copyDefaults: replies(), copy: replies(), copyInside: replies(), chooseParent: replies() };
  const deps = { ...refs, ...fx, actions, current, pending: null, firstUse: false, setCopy: set('copy'), setDraft: set('draft'), setBlock: set('block'),
    setMode: (mode) => { state.mode = mode; }, requestAnimationFrame: (run) => frames.push(run), document: { activeElement: null } };
  // The actual setConfirmation: each mode change takes a new interaction number.
  for (const name of ['BAD_NAME', 'nameError', 'setConfirmation', 'switchMode', 'entryOwns', 'copyStart', 'attempt', 'enterCopy']) deps[name] = await sheetCallback(name, deps);
  // One render: the callbacks that read this render's form.
  const render = async (overrides = {}) => {
    const view = { ...deps, copy: state.copy, draft: state.draft, form: state.copy || state.draft, setForm: state.copy ? deps.setCopy : deps.setDraft, ...overrides };
    // This render's own submission check, where the source has one.
    view.copyHeld = await sheetCallback('copyHeld', view).catch(() => undefined);
    return { create: await sheetCallback('create', view), back: await sheetCallback('back', view), chooseParent: await sheetCallback('chooseParent', view), name: await nameChange(view) };
  };
  const owner = { epoch: 7, context: { windowEpoch: 'w', documentSessionId: 'd', targetGeneration: 4 } };
  const ready = async (carried) => {
    deps.enterCopy(carried); actions.copyOwner.calls.at(-1).resolve(owner); await settle();
    actions.copyDefaults.calls.at(-1).resolve({ name: 'Week 3 autos copy', parentDirectory: '/team' }); await settle();
  };
  return { state, refs, fx, actions, deps, render, owner, ready, frame: () => frames.splice(0).forEach((run) => run()) };
}

describe('Save copy form ownership', () => {
  it('enters with the local name, then applies only its own entry’s defaults (copy → new → copy)', async () => {
    const f = await copyForm();
    f.deps.enterCopy();
    expect(f.state.mode).toBe('new');
    expect(f.state.copy).toMatchObject({ name: 'Week 3 autos copy', parent: null, parentStatus: 'pending', error: '' });
    f.actions.copyOwner.calls[0].resolve(f.owner); await settle();
    expect(f.actions.copyDefaults).toHaveBeenCalledWith({ context: f.owner.context, nameHint: 'Week 3 autos' });
    f.deps.switchMode('new');
    expect(f.state.copy).toBeNull(); expect(f.refs.entry.current).toBeNull();
    f.deps.enterCopy();
    f.actions.copyDefaults.calls[0].resolve({ name: 'Week 3 autos copy 2', parentDirectory: '/old' }); await settle();
    expect(f.state.copy).toMatchObject({ name: 'Week 3 autos copy', parent: null, parentStatus: 'pending' });
    f.actions.copyOwner.calls[1].resolve(f.owner); await settle();
    f.actions.copyDefaults.calls[1].resolve({ name: 'Week 3 autos copy 3', parentDirectory: '/team' }); await settle();
    expect(f.state.copy).toMatchObject({ name: 'Week 3 autos copy 3', parent: '/team', parentStatus: 'ready' });
    expect(f.refs.nameInput.current.focus).not.toHaveBeenCalled();
  });

  it('keeps an edited name and a chosen parent; a defaults failure never clears the chosen parent', async () => {
    const f = await copyForm();
    f.deps.enterCopy(); f.actions.copyOwner.calls[0].resolve(f.owner); await settle();
    // The name field's own edit marks it touched.
    f.refs.entry.current.touched.name = true; f.state.copy = { ...f.state.copy, name: 'Mine' };
    const choosing = (await f.render()).chooseParent();
    f.actions.chooseParent.calls[0].resolve({ parentDirectory: '/chosen' }); await choosing;
    expect(f.state.copy).toMatchObject({ name: 'Mine', parent: '/chosen', parentStatus: 'ready' });
    f.actions.copyDefaults.calls[0].reject(new Error('Project context is no longer current')); await settle();
    expect(f.state.copy).toMatchObject({ name: 'Mine', parent: '/chosen', parentStatus: 'ready' });
  });

  it('applies defaults to untouched fields only', async () => {
    const f = await copyForm();
    f.deps.enterCopy(); f.actions.copyOwner.calls[0].resolve(f.owner); await settle();
    const choosing = (await f.render()).chooseParent();
    f.actions.chooseParent.calls[0].resolve({ parentDirectory: '/chosen' }); await choosing;
    f.actions.copyDefaults.calls[0].resolve({ name: 'Week 3 autos copy 2', parentDirectory: '/team' }); await settle();
    expect(f.state.copy).toMatchObject({ name: 'Week 3 autos copy 2', parent: '/chosen' });
  });

  it('freezes the submitted fields against late defaults', async () => {
    const f = await copyForm();
    f.deps.enterCopy(); f.actions.copyOwner.calls[0].resolve(f.owner); await settle();
    const choosing = (await f.render()).chooseParent();
    f.actions.chooseParent.calls[0].resolve({ parentDirectory: '/chosen' }); await choosing;
    (await f.render()).create();
    expect(f.actions.copy).toHaveBeenCalledTimes(1);
    f.actions.copyDefaults.calls[0].resolve({ name: 'Week 3 autos copy 2', parentDirectory: '/team' }); await settle();
    expect(f.state.copy).toMatchObject({ name: 'Week 3 autos copy', parent: '/chosen' });
  });

  it.each([['a mode change', (f) => f.deps.switchMode('new')], ['the sheet closing', (f) => { f.refs.alive.current = false; }]])('ignores a picker reply, cancel or error after %s', async (_, retire) => {
    for (const outcome of ['reply', 'cancel', 'error']) {
      const f = await copyForm(); f.deps.enterCopy();
      const choosing = (await f.render()).chooseParent();
      retire(f);
      const before = { copy: f.state.copy, draft: f.state.draft }, reply = f.actions.chooseParent.calls[0];
      if (outcome === 'reply') reply.resolve({ parentDirectory: '/late' }); else if (outcome === 'cancel') reply.resolve(null); else reply.reject(new Error('EACCES: permission denied'));
      await choosing; f.frame();
      expect(f.state.copy).toBe(before.copy); expect(f.state.draft).toBe(before.draft);
      expect(f.refs.nameInput.current.focus).not.toHaveBeenCalled(); expect(f.refs.locationButton.current.focus).not.toHaveBeenCalled();
    }
  });

  it('says the project changed when its owner can’t be read, and nothing once the sheet closed', async () => {
    const f = await copyForm(); f.deps.enterCopy(); const entered = f.state.copy;
    f.refs.alive.current = false; f.actions.copyOwner.calls[0].reject(new Error('The project changed')); await settle();
    expect(f.state.copy).toBe(entered);
    const g = await copyForm(); g.deps.enterCopy(); g.actions.copyOwner.calls[0].reject(new Error('The project changed')); await settle();
    expect(g.state.copy).toMatchObject({ error: 'The project changed', errorField: 'name', parentStatus: 'error', parent: null });
    expect(g.actions.copyDefaults).not.toHaveBeenCalled();
  });

  it.each([['before its owner is read', false], ['once main moved on', true]])('refuses a submission %s, without sending it', async (_, read) => {
    const f = await copyForm(); f.deps.enterCopy();
    if (read) { f.actions.copyOwner.calls[0].resolve(f.owner); await settle(); f.actions.ownsCopy.mockReturnValue(false); }
    f.state.copy = { ...f.state.copy, parent: '/team' };
    (await f.render()).create();
    expect(f.actions.copy).not.toHaveBeenCalled();
    expect(f.state.copy).toMatchObject({ error: 'The project changed', errorField: 'name' });
  });

  it('sends one copy for two synchronous presses, with its values and its own live predicate', async () => {
    const f = await copyForm(); await f.ready();
    const { create } = await f.render(); create(); create();
    expect(f.actions.copy).toHaveBeenCalledTimes(1);
    const [sent, owner, current] = f.actions.copy.mock.calls[0];
    expect(sent).toEqual({ name: 'Week 3 autos copy', parentDirectory: '/team' }); expect(owner).toBe(f.owner);
    expect(current()).toBe(true);
    f.deps.switchMode('new');
    expect(current()).toBe(false);
  });

  it('closes once on its own success', async () => {
    const f = await copyForm(); await f.ready();
    (await f.render()).create(); f.actions.copy.calls[0].resolve({ copied: true }); await settle(); f.frame();
    expect(f.fx.onClose).toHaveBeenCalledTimes(1); expect(f.fx.onClose).toHaveBeenCalledWith();
  });

  it.each([['a failure', { copyFailed: 'Folder is read-only' }], ['a success', { copied: true }]])('drops %s whose entry was retired: no close, fact or focus', async (_, result) => {
    const f = await copyForm(); await f.ready();
    (await f.render()).create();
    f.deps.switchMode('new');
    const draft = f.state.draft;
    f.actions.copy.calls[0].resolve(result); await settle(); f.frame();
    expect(f.fx.onClose).not.toHaveBeenCalled(); expect(f.state.copy).toBeNull(); expect(f.state.draft).toBe(draft);
    expect(f.refs.nameInput.current.focus).not.toHaveBeenCalled(); expect(f.refs.locationButton.current.focus).not.toHaveBeenCalled();
  });

  it('keeps only the latest press’s queued focus', async () => {
    const f = await copyForm(); await f.ready();
    (await f.render()).create();
    f.actions.copy.calls[0].resolve({ copyFailed: 'That project folder already exists. Choose another name.' }); await settle();
    expect(f.state.copy).toMatchObject({ error: 'That project folder already exists', errorField: 'name' });
    (await f.render()).create();
    expect(f.actions.copy).toHaveBeenCalledTimes(2);
    f.frame();
    expect(f.refs.nameInput.current.focus).not.toHaveBeenCalled();
  });

  it.each([
    ['That project folder already exists. Choose another name.', 'name', 'That project folder already exists'],
    ['Location changed. Choose it again.', 'location', 'Location changed'],
    ["Error invoking remote method 'project:saveWithCheckpoint': Error: EACCES: permission denied, mkdir '/team/x'", 'location', 'No access to this location'],
    ['Folder isn’t responding · Choose another name', 'name', 'Folder isn’t responding · Choose another name'],
    ['The project is busy · Try again', 'name', 'The project is busy · Try again'],
  ])('says %j at its own field and focuses it', async (fact, field, shown) => {
    const f = await copyForm(); await f.ready();
    (await f.render()).create(); f.actions.copy.calls[0].resolve({ copyFailed: fact }); await settle(); f.frame();
    expect(f.state.copy).toMatchObject({ error: shown, errorField: field });
    expect((field === 'location' ? f.refs.locationButton : f.refs.nameInput).current.focus).toHaveBeenCalledTimes(1);
    expect(f.fx.onClose).not.toHaveBeenCalled();
  });
});

describe('Save copy carried by a blocked switch', () => {
  // The switch's own run: `before` inside its transition; a stop result ends it before anything opens.
  const switchRun = (open) => vi.fn(async (options) => {
    if (options.before) { const stop = await options.before({ token: { id: 's' } }); if (stop) return stop; }
    return open();
  });
  const blocked = (run) => ({ blocked: 'failed', subject: 'Week 3 autos', message: 'Folder is read-only', run, rowId: null });

  it('keeps a failure in the form, and Escape shows the same block again', async () => {
    const run = switchRun(async () => ({ opened: true })), block = blocked(run), f = await copyForm();
    f.state.block = block;
    await f.ready(block);
    expect(f.state.block).toBeNull(); expect(f.state.copy).toMatchObject({ carried: block });
    (await f.render()).create(); await settle();
    expect(run).toHaveBeenCalledTimes(1);
    expect(f.actions.copyInside).toHaveBeenCalledWith({ name: 'Week 3 autos copy', parentDirectory: '/team' }, f.owner, { token: { id: 's' } }, expect.any(Function));
    f.actions.copyInside.calls[0].resolve({ copyFailed: 'Folder is read-only' }); await settle();
    expect(f.state.mode).toBe('new'); expect(f.state.copy).toMatchObject({ error: 'Folder is read-only', carried: block });
    (await f.render()).back();
    expect(f.state.mode).toBe('list'); expect(f.state.block).toBe(block); expect(f.state.copy).toBeNull();
  });

  it('opens the blocked target after the copy and closes once', async () => {
    const open = vi.fn(async () => ({ opened: true })), f = await copyForm();
    await f.ready(blocked(switchRun(open)));
    (await f.render()).create(); await settle();
    f.actions.copyInside.calls[0].resolve({ copied: true }); await settle();
    expect(open).toHaveBeenCalledTimes(1); expect(f.fx.onClose).toHaveBeenCalledTimes(1);
  });

  it.each([['the sheet closing', (f) => { f.refs.alive.current = false; }], ['a mode change', (f) => f.deps.switchMode('new')]])('never opens after %s before the copy result', async (_, retire) => {
    const open = vi.fn(async () => ({ opened: true })), f = await copyForm();
    await f.ready(blocked(switchRun(open)));
    (await f.render()).create(); await settle();
    retire(f);
    f.actions.copyInside.calls[0].resolve({ copied: true }); await settle();
    expect(open).not.toHaveBeenCalled(); expect(f.fx.onClose).not.toHaveBeenCalled();
  });

  it('shows the list block when Open is blocked after the copy; Retry repeats only the switch', async () => {
    const result = { blocked: 'failed', subject: 'Week 3 autos copy', message: 'Folder is read-only' };
    const run = switchRun(async () => result), f = await copyForm();
    await f.ready(blocked(run));
    (await f.render()).create(); await settle();
    f.actions.copyInside.calls[0].resolve({ copied: true }); await settle();
    expect(f.state.mode).toBe('list'); expect(f.state.block).toMatchObject({ ...result, run, rowId: null });
    await f.deps.attempt(f.state.block.run, f.state.block.rowId, { retry: true });
    expect(run).toHaveBeenCalledTimes(2); expect(run.mock.calls[1][0]).not.toHaveProperty('before');
    expect(f.actions.copyInside).toHaveBeenCalledTimes(1);
  });
});

describe('Save copy corrections (R3)', () => {
  const switchRun = (open) => vi.fn(async (options) => {
    if (options.before) { const stop = await options.before({ token: { id: 's' } }); if (stop) return stop; }
    return open();
  });
  const blocked = (run, rowId = null, kind = 'failed') => ({ blocked: kind, subject: 'Week 3 autos', message: 'Folder is read-only', run, rowId });

  // R3 finding 1: once the carried copy is saved, a thrown target is the switch's failure, never the copy form's.
  it.each([[null], ['recent-other'], ['new']])('shows the list block with Retry when the target throws after a carried copy (row %j)', async (rowId) => {
    const open = vi.fn(async () => { throw new Error('That folder is not a project.'); }), run = switchRun(open), block = blocked(run, rowId), f = await copyForm();
    await f.ready(block);
    (await f.render()).create(); await settle();
    f.actions.copyInside.calls[0].resolve({ copied: true }); await settle(); f.frame();
    expect(open).toHaveBeenCalledTimes(1);
    expect(f.state.mode).toBe('list'); expect(f.state.copy).toBeNull(); expect(f.refs.entry.current).toBeNull();
    expect(f.state.block).toEqual({ blocked: 'error', message: 'That folder is not a project', run, rowId });
    expect(f.fx.setRowError.mock.calls.filter(([value]) => value)).toEqual([]);
    expect(f.refs.retryButton.current.focus).toHaveBeenCalledTimes(1);
    expect(f.refs.nameInput.current.focus).not.toHaveBeenCalled(); expect(f.refs.locationButton.current.focus).not.toHaveBeenCalled();
    expect(f.fx.onClose).not.toHaveBeenCalled();
    await f.deps.attempt(f.state.block.run, f.state.block.rowId, { retry: true });
    expect(run).toHaveBeenCalledTimes(2); expect(run.mock.calls[1][0]).not.toHaveProperty('before'); expect(run.mock.calls[1][0].owner).toBe(rowId || 'sheet');
    expect(f.actions.copyInside).toHaveBeenCalledTimes(1);
  });

  it('keeps an ordinary New failure at its own field', async () => {
    const f = await copyForm(); f.deps.switchMode('new');
    await f.deps.attempt(async () => { throw new Error('That project folder already exists. Choose another name.'); }, 'new'); f.frame();
    expect(f.state.draft).toMatchObject({ error: 'That project folder already exists', errorField: 'name' });
    expect(f.state.block).toBeNull(); expect(f.refs.nameInput.current.focus).toHaveBeenCalledTimes(1);
  });

  // R3 finding 2: a picker belongs to the entry it began in; after any mode change it never acts, even back in New (ABA).
  it.each([
    ['New → copy → New', (f) => { f.deps.enterCopy(); f.deps.switchMode('new'); }],
    ['New → list', (f) => f.deps.switchMode('list')],
    ['New → list → New', (f) => { f.deps.switchMode('list'); f.deps.switchMode('new'); }],
  ])('ignores a New picker reply, cancel or error after %s', async (_, change) => {
    for (const outcome of ['reply', 'cancel', 'error']) {
      const f = await copyForm(); f.deps.switchMode('new');
      const choosing = (await f.render()).chooseParent();
      change(f);
      const before = { copy: f.state.copy, draft: f.state.draft }, reply = f.actions.chooseParent.calls[0];
      if (outcome === 'reply') reply.resolve({ parentDirectory: '/late' }); else if (outcome === 'cancel') reply.resolve(null); else reply.reject(new Error('EACCES: permission denied'));
      await choosing; f.frame();
      expect(f.state.draft).toBe(before.draft); expect(f.state.copy).toBe(before.copy);
      expect(f.refs.nameInput.current.focus).not.toHaveBeenCalled(); expect(f.refs.locationButton.current.focus).not.toHaveBeenCalled();
    }
  });

  it('applies a New picker reply within its own entry', async () => {
    const f = await copyForm(); f.deps.switchMode('new');
    const choosing = (await f.render()).chooseParent();
    f.actions.chooseParent.calls[0].resolve({ parentDirectory: '/chosen' }); await choosing;
    expect(f.state.draft).toMatchObject({ parent: '/chosen', parentStatus: 'ready' }); expect(f.refs.nameInput.current.focus).toHaveBeenCalledTimes(1);
  });

  // R3 finding 3: a submitted copy's fields stay as sent until it settles; nothing opens a picker or leaves meanwhile.
  it('freezes the form from the press until its copy settles, then edits again', async () => {
    const f = await copyForm(); await f.ready();
    const pressed = await f.render(), shown = f.state.copy;
    pressed.create();
    // The same render, before App's pending state arrives.
    pressed.create(); pressed.back(); void pressed.chooseParent();
    expect(f.actions.copy).toHaveBeenCalledTimes(1); expect(f.actions.chooseParent).not.toHaveBeenCalled();
    expect(f.state.mode).toBe('new'); expect(f.state.copy).toBe(shown); expect(f.fx.onClose).not.toHaveBeenCalled();
    const saving = await f.render({ pending: { owner: 'copy', phase: 'saving', label: 'Saving…' } });
    void saving.chooseParent(); saving.back();
    expect(f.actions.chooseParent).not.toHaveBeenCalled(); expect(f.state.copy).toBe(shown);
    expect(f.actions.copy.mock.calls[0][0]).toEqual({ name: 'Week 3 autos copy', parentDirectory: '/team' });
    f.actions.copy.calls[0].resolve({ copyFailed: 'Folder is read-only' }); await settle();
    const again = await f.render(), choosing = again.chooseParent();
    expect(f.actions.chooseParent).toHaveBeenCalledTimes(1);
    f.actions.chooseParent.calls[0].resolve({ parentDirectory: '/chosen' }); await choosing;
    expect(f.state.copy).toMatchObject({ parent: '/chosen', error: '' });
  });

  it('opens no picker while a carried copy’s switch is opening', async () => {
    const f = await copyForm(); await f.ready(blocked(switchRun(async () => ({ opened: true }))));
    void (await f.render({ pending: { owner: 'sheet', phase: 'opening' } })).chooseParent();
    expect(f.actions.chooseParent).not.toHaveBeenCalled();
  });

  // R3 finding 4: without the copy form, a block's Save… and Save copy… stay the picker inside the blocked switch.
  it.each([['Save copy… on a failed block', 'failed', 'saveCopy', 'save'], ['Save… on an Untitled block', 'untitled', 'save', 'saveCopy']])('%s keeps the native picker without the copy form', async (_, kind, picker, other) => {
    const open = vi.fn(async () => ({ opened: true })), run = switchRun(open), block = blocked(run, 'recent-other', kind), f = await copyForm({ bridge: 'legacy' });
    f.state.block = block;
    f.deps.enterCopy(block); await settle();
    expect(f.state.copy).toBeNull(); expect(f.state.mode).toBe('list'); expect(f.refs.entry.current).toBeNull(); expect(f.state.block).toBeNull();
    expect(f.refs.search.current.focus).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toMatchObject({ owner: 'recent-other', retry: false }); expect(run.mock.calls[0][0].before).toEqual(expect.any(Function));
    expect(f.actions[picker]).toHaveBeenCalledTimes(1); expect(f.actions[other]).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    f.actions[picker].calls[0].resolve({ saved: true }); await settle();
    expect(open).toHaveBeenCalledTimes(1); expect(f.fx.onClose).toHaveBeenCalledTimes(1);
  });
});

describe('Save copy corrections (R4)', () => {
  const switchRun = (open) => vi.fn(async (options) => {
    if (options.before) { const stop = await options.before({ token: { id: 's' } }); if (stop) return stop; }
    return open();
  });

  // A: the list block a thrown target left (as after a carried copy) stays that block when its own Retry throws again:
  // the new fact, “still”, Retry focused, never a row's error or the hidden New form's. A later Retry that opens closes.
  it.each([[null], ['recent-other'], ['new']])('keeps the list block when its Retry throws again (row %j), until a Retry opens', async (rowId) => {
    const f = await copyForm(), run = vi.fn(async () => { throw new Error('Folder isn’t responding.'); }), draft = f.state.draft;
    f.state.block = { blocked: 'error', message: 'That folder is not a project', run, rowId };
    await f.deps.attempt(f.state.block.run, f.state.block.rowId, { retry: true }); f.frame();
    expect(f.state.block).toEqual({ blocked: 'error', message: 'Folder isn’t responding', run, rowId, repeat: 2 });
    expect(f.state.mode).toBe('list'); expect(f.state.copy).toBeNull(); expect(f.state.draft).toBe(draft);
    expect(f.fx.setRowError.mock.calls.filter(([value]) => value)).toEqual([]);
    expect(f.refs.retryButton.current.focus).toHaveBeenCalledTimes(1);
    expect(f.refs.nameInput.current.focus).not.toHaveBeenCalled(); expect(f.refs.locationButton.current.focus).not.toHaveBeenCalled();
    expect(f.fx.onClose).not.toHaveBeenCalled();
    run.mockImplementationOnce(async () => ({ opened: true }));
    await f.deps.attempt(f.state.block.run, f.state.block.rowId, { retry: true });
    expect(f.state.block).toBeNull(); expect(f.fx.onClose).toHaveBeenCalledTimes(1); expect(f.state.draft).toBe(draft);
    expect(run).toHaveBeenCalledTimes(2);
    for (const [options] of run.mock.calls) { expect(options).not.toHaveProperty('before'); expect(options).toMatchObject({ retry: true, owner: rowId || 'sheet' }); }
  });

  // B: the actual name field holds a submitted copy's name as sent, from the press (before App's pending state renders)
  // through Saving… and a carried switch's Opening…, until it settles; then it edits again.
  it.each([['a direct copy', null, { owner: 'copy', phase: 'saving', label: 'Saving…' }], ['a carried copy, while its switch opens', 'carried', { owner: 'sheet', phase: 'opening' }]])('keeps the name as sent for %s, through the actual name field', async (_, carried, pending) => {
    const opening = deferred(), f = await copyForm();
    await f.ready(carried && { blocked: 'failed', subject: 'Week 3 autos', message: 'Folder is read-only', run: switchRun(() => opening.promise), rowId: null });
    const pressed = await f.render(), shown = f.state.copy, entered = f.refs.entry.current;
    pressed.create();
    const touched = entered.touched, marks = { ...touched };
    // An event captured by the same render, before pending arrives.
    pressed.name({ target: { value: 'Typed after the press' } });
    expect(f.state.copy).toBe(shown); expect(entered.touched).toBe(touched); expect(touched).toEqual(marks);
    if (carried) { await settle(); f.actions.copyInside.calls[0].resolve({ copied: true }); await settle(); }
    const held = await f.render({ pending });
    held.name({ target: { value: 'Typed while pending' } }); void held.chooseParent();
    expect(f.state.copy).toBe(shown); expect(f.actions.chooseParent).not.toHaveBeenCalled();
    const sent = (carried ? f.actions.copyInside : f.actions.copy).mock.calls;
    expect(sent).toHaveLength(1); expect(sent[0][0]).toEqual({ name: 'Week 3 autos copy', parentDirectory: '/team' });
    if (carried) { opening.reject(new Error('That folder is not a project.')); await settle(); f.frame(); return; }
    f.actions.copy.calls[0].resolve({ copyFailed: 'That project folder already exists. Choose another name.' }); await settle();
    (await f.render()).name({ target: { value: 'Week 3 autos copy 2' } });
    expect(f.state.copy).toMatchObject({ name: 'Week 3 autos copy 2', error: '' });
  });

  it('never holds a newer entry with an older, unfinished submission', async () => {
    const f = await copyForm(); await f.ready();
    (await f.render()).create();
    expect(f.refs.submitting.current.done).toBe(false);
    f.deps.switchMode('new');
    (await f.render()).name({ target: { value: 'Robot paths' } });
    expect(f.state.draft).toMatchObject({ name: 'Robot paths' });
    f.deps.enterCopy(); const next = f.refs.entry.current;
    (await f.render()).name({ target: { value: 'Second copy' } });
    expect(f.state.copy).toMatchObject({ name: 'Second copy' }); expect(next.touched.name).toBe(true);
    void (await f.render()).chooseParent();
    expect(f.actions.chooseParent).toHaveBeenCalledTimes(1);
  });
});

describe('Save copy form', () => {
  const form = (current, request = { mode: 'copy' }, pending = null) => renderToStaticMarkup(React.createElement(ProjectsDialog, { request, current, pending, onClose() {},
    actions: { listRecent: () => new Promise(() => undefined), creationDefaults: () => new Promise(() => undefined), copyOwner: () => new Promise(() => undefined), ownsCopy: () => true, copy() {}, copyInside() {} } }));
  const folder = { name: 'Week 3 autos', folderPath: '/team/Week 3 autos', projectPath: '/team/Week 3 autos/.bordeaux-workspace.json' };

  it('is New’s form for a copy: the copy’s name, Save copy, no robot checkbox, and what stays behind', () => {
    const markup = form(folder);
    expect(markup).toContain('aria-label="Save copy"');
    expect(markup).toContain('value="Week 3 autos copy"');
    expect(markup).toMatch(/class="qbtn primary" disabled=""[^>]*>Save copy<\/button>/);
    expect(markup).toContain('data-action="cancel">Cancel<');
    expect(markup).toContain('Keeps “Week 3 autos” as last saved and opens the copy');
    expect(markup).toContain('id="pj-location-value">…<');
    expect(markup).not.toContain('type="checkbox"'); expect(markup).not.toContain('Create'); expect(markup).not.toContain('<h2');
  });

  it('is Save for an Untitled project and Save copy for recovered edits, each with a spacer instead of the note', () => {
    const untitled = form({ name: 'Untitled', folderPath: null, projectPath: null, untitled: true });
    expect(untitled).toContain('aria-label="Save project"'); expect(untitled).toContain('value="Untitled"');
    expect(untitled).toMatch(/class="qbtn primary"[^>]*>Save<\/button>/);
    expect(untitled).toContain('class="pj-new-spacer"'); expect(untitled).not.toContain('Keeps'); expect(untitled).not.toContain('type="checkbox"');
    const recovered = form({ name: 'Week 3 autos', folderPath: null, projectPath: null });
    expect(recovered).toContain('aria-label="Save copy"'); expect(recovered).toContain('value="Week 3 autos copy"');
    expect(recovered).toContain('class="pj-new-spacer"'); expect(recovered).not.toContain('Keeps'); expect(recovered).not.toContain('type="checkbox"');
  });

  it('shortens a long name in the middle, keeping the full sentence in the title and the accessible text', () => {
    const long = 'Practice field autos for the regional qualifier', markup = form({ ...folder, name: long, folderPath: '/team/' + long });
    const full = 'Keeps “' + long + '” as last saved and opens the copy';
    expect(markup).toContain('title="' + full + '"'); expect(markup).toContain('class="sr-only">' + full + '<');
    const shown = markup.match(/class="pj-hint"[^>]*>Keeps “([^”]*)”/)?.[1] || '';
    const [head, tail] = shown.split('…');
    expect(shown.length).toBeLessThanOrEqual(28); expect(tail).toBeTruthy();
    expect(long.startsWith(head) && long.endsWith(tail)).toBe(true);
  });

  // R3 finding 3: the pending copy's name and Location can't change. (React writes the boolean as HTML's `readonly`.)
  it('freezes the name and Location while its copy is pending, and only then', () => {
    const tag = (markup, pattern) => markup.match(pattern)?.[0] || '', name = /<input[^>]*id="pj-new-name"[^>]*>/, place = /<button[^>]*class="pj-location"[^>]*>/;
    const saving = form(folder, { mode: 'copy' }, { owner: 'copy', phase: 'saving', label: 'Saving…' });
    expect(tag(saving, name)).toContain('readonly=""'); expect(tag(saving, place)).toContain('disabled=""');
    const idle = form(folder);
    expect(tag(idle, name)).not.toContain('readonly'); expect(tag(idle, place)).not.toContain('disabled');
  });

  it('leaves New unchanged', () => {
    const markup = form(folder, { mode: 'new' });
    expect(markup).toContain('aria-label="New project"'); expect(markup).toContain('>Create<'); expect(markup).toContain('type="checkbox"'); expect(markup).not.toContain('Keeps');
  });
});
