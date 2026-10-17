import fs from 'node:fs';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { ProjectChip } from '../src/renderer/components/ProjectChip';
import { createPersistenceQueue } from '../src/renderer/lib/projectLifecycle';
import { withRobotLink } from '../src/renderer/lib/projectRobotLink';
import { createDemoProject } from '../src/shared/project/defaults';

const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function callbacks() {
  const source = fs.readFileSync('src/renderer/app/App.jsx', 'utf8');
  const ast = ts.createSourceFile('App.jsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
  const sandbox = { useCallback: fn => fn, withRobotLink, persistenceQueue: createPersistenceQueue(),
    robotRestoreGeneration: { current: 0 }, sessionContext: { current: { windowEpoch: 'w', documentSessionId: 'a', targetGeneration: 1 } },
    projectRef: { current: createDemoProject() }, robotProjectState: { status: 'missing', suggestion: { id: 'proposal', name: 'Robot.lvproj' } },
    window: { bordeauxAPI: { linkRobotProject: vi.fn(), openRecentRobotProject: vi.fn(), useSuggestedRobotCode: vi.fn(), refreshRobotProject: vi.fn(), buildRobotCatalog: vi.fn() } },
    setExportError() {}, operationErrorMessage: error => error.message,
  };
  sandbox.setRobotProjectState = value => { sandbox.robotProjectState = typeof value === 'function' ? value(sandbox.robotProjectState) : value; };
  sandbox.setProject = value => { sandbox.projectRef.current = typeof value === 'function' ? value(sandbox.projectRef.current) : value; };
  for (const name of ['applyRobotProjectConnection', 'linkRobotProject', 'openRecentRobotProject', 'useSuggestedRobotCode', 'refreshRobotProject', 'buildRobotCatalog']) {
    let declaration;
    const visit = node => { if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) declaration = node; ts.forEachChild(node, visit); }; visit(ast);
    if (!declaration?.initializer) throw new Error(`Missing actual App callback ${name}`);
    const code = ts.transpileModule(`globalThis.${name} = ${declaration.initializer.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInNewContext(code, sandbox);
  }
  return sandbox;
}

it.each(['linkRobotProject', 'openRecentRobotProject', 'useSuggestedRobotCode'])('serializes %s editor adoption between an older source write and a later copy capture', async action => {
  const s = callbacks(), older = gate(), selected = gate(), began = gate();
  const saving = s.persistenceQueue.enqueue(() => older.promise);
  s.window.bordeauxAPI[action].mockImplementation(() => { began.resolve(); return selected.promise; });
  const linking = s[action](action === 'openRecentRobotProject' ? 'recent' : undefined);
  const copying = s.persistenceQueue.enqueue(() => structuredClone(s.projectRef.current));
  expect(s.window.bordeauxAPI[action]).not.toHaveBeenCalled();
  older.resolve(); await saving; await began.promise;
  selected.resolve({ catalog: { projectName: 'Robot', commands: [] }, bookmarkId: 'a'.repeat(20), editorLink: { labviewProjectPath: '../Robot.lvproj' } });
  await linking;
  expect((await copying).editor.labviewProjectPath).toBe('../Robot.lvproj');
  expect(s.robotProjectState.status).toBe('ready');
});

it('does not start a queued selection after its document was replaced', async () => {
  const s = callbacks(), older = gate(); s.persistenceQueue.enqueue(() => older.promise);
  const linking = s.linkRobotProject(); s.robotRestoreGeneration.current += 1;
  older.resolve(); await linking;
  expect(s.window.bordeauxAPI.linkRobotProject).not.toHaveBeenCalled();
});

it('preserves Missing and its suggestion after native picker cancellation', async () => {
  const s = callbacks(), prior = s.robotProjectState;
  s.window.bordeauxAPI.linkRobotProject.mockResolvedValue(null);
  await s.linkRobotProject(); expect(s.robotProjectState).toEqual(prior);
});

// Review N6: catalog work outlives the closed menu, so the chip announces it.
it.each([['build', 'Building command catalog…'], ['inspect', 'Inspecting command inputs…']])('announces robot code %s progress from the chip', (operation, text) => {
  const markup = renderToStaticMarkup(React.createElement(ProjectChip, { name: 'Week 3 autos', folderPath: '/team/Week 3 autos', status: 'saved', actions: {},
    robotCode: { status: 'ready', operation, catalog: { projectName: 'Robot', commands: [] } } }));
  expect(markup).toContain('<span class="sr-only" role="status">Robot code: ' + text + '</span>');
});

// Final visual review r1: a refresh stays linked like Build, and a successful Build adds no notice.
it('keeps a refreshing link and its catalog, and finishes Build quietly', async () => {
  const s = callbacks(), refreshed = gate(), catalog = { projectName: 'Robot', commands: [] };
  s.robotProjectState = { status: 'ready', operation: null, catalog, error: '', notice: '', bookmarkId: 'a'.repeat(20), recentProjects: [] };
  s.window.bordeauxAPI.refreshRobotProject.mockReturnValue(refreshed.promise);
  const refreshing = s.refreshRobotProject();
  expect(s.robotProjectState).toMatchObject({ status: 'ready', operation: 'refresh', catalog });
  refreshed.resolve({ catalog: { projectName: 'Robot', commands: [] }, bookmarkId: 'a'.repeat(20) }); await refreshing;
  expect(s.robotProjectState).toMatchObject({ status: 'ready', operation: null });
  s.window.bordeauxAPI.buildRobotCatalog.mockResolvedValue({ catalog: { projectName: 'Robot', commands: [], authoritative: true }, bookmarkId: 'a'.repeat(20) });
  await s.buildRobotCatalog();
  expect(s.robotProjectState).toMatchObject({ status: 'ready', operation: null, notice: '' });
});
