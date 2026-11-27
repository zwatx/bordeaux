import fs from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { beforeAll, expect, it, vi } from 'vitest';

let handlerSource: string, robotFileSource: string;
beforeAll(async () => {
  const text = await fs.readFile('src/electron/main.ts', 'utf8');
  const ast = ts.createSourceFile('main.ts', text, ts.ScriptTarget.Latest, true);
  const robotFile = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'withRobotFile');
  if (!robotFile) throw new Error('Missing production withRobotFile');
  robotFileSource = ts.transpileModule(robotFile.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const registration = ast.statements.find(node => ts.isExpressionStatement(node)
    && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(ast) === 'handle'
    && node.expression.arguments[0]?.getText(ast) === '"robotFiles:prepare"');
  if (!registration) throw new Error('Missing production robotFiles:prepare handler');
  handlerSource = ts.transpileModule(registration.getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
});

function handler() {
  let prepare!: (event: unknown, project: unknown, ids: unknown) => Promise<unknown>;
  const current = vi.fn(() => null);
  vm.runInNewContext(handlerSource, {
    handle: (_channel: string, callback: typeof prepare) => { prepare = callback; },
    MAX_BDX_BATCH: 64, robotFileDelivery: { current },
  });
  return { prepare, current };
}

it.each([0, 65, 66])('reports the actual batch limit for %i paths before connection or planning', async count => {
  const { prepare, current } = handler();
  await expect(prepare(null, { paths: [] }, Array.from({ length: count }, (_, i) => `path-${i}`)))
    .rejects.toThrow('Select between 1 and 64 paths to push');
  expect(current).not.toHaveBeenCalled();
});

it.each([null, ['A', 'A'], ['A', 2]])('rejects malformed or duplicate selection %j before connection or planning', async ids => {
  const { prepare, current } = handler();
  await expect(prepare(null, { paths: [] }, ids)).rejects.toThrow('Select distinct paths to push');
  expect(current).not.toHaveBeenCalled();
});

it('admits 64 distinct IDs to the existing connection gate without preparing or uploading', async () => {
  const { prepare, current } = handler();
  await expect(prepare(null, { paths: [] }, Array.from({ length: 64 }, (_, i) => `path-${i}`)))
    .rejects.toThrow('Connect a robot before preparing this transfer');
  expect(current).toHaveBeenCalledOnce();
});

it('adds the selected robot\'s .robot file only when the review asks for it', async () => {
  const { projectRobots } = await import('../src/core/project/robots');
  const { robotFileContents, robotPushFileConflict, robotPushFileName } = await import('../src/core/project/robotFile');
  const { createDemoProject } = await import('../src/core/project/defaults');
  const context: Record<string, unknown> = { projectRobots, robotFileContents, robotPushFileConflict, robotPushFileName, Buffer };
  vm.runInNewContext(robotFileSource + '\nthis.withRobotFile = withRobotFile;', context);
  const withRobotFile = context.withRobotFile as (files: unknown[], project: unknown, options: unknown) => Array<{ pathId: string; fileName: string; contents: Buffer }>;
  const project = createDemoProject(), paths = [{ pathId: 'p', name: 'P', fileName: 'P.bdx', contents: Buffer.from('x') }];
  for (const options of [undefined, null, {}, { robotFile: false }, { robotFile: 'yes' }]) expect(withRobotFile(paths, project, options)).toBe(paths);
  const files = withRobotFile(paths, project, { robotFile: true });
  expect(files.map((file) => [file.pathId, file.fileName])).toEqual([['p', 'P.bdx'], ['robot:robot', 'Robot.robot']]);
  expect(files[1].contents.toString()).toBe(robotFileContents('Robot', project.robot));
});

it('refuses a .robot file another robot of the project would also push under that name', async () => {
  const { addRobot, projectRobots, renameRobot, setRobotConnection } = await import('../src/core/project/robots');
  const { robotFileContents, robotPushFileConflict, robotPushFileName } = await import('../src/core/project/robotFile');
  const { createDemoProject } = await import('../src/core/project/defaults');
  const { prepareProjectFile } = await import('../src/core/project/fileFormat');
  const context: Record<string, unknown> = { projectRobots, robotFileContents, robotPushFileConflict, robotPushFileName, Buffer };
  vm.runInNewContext(robotFileSource + '\nthis.withRobotFile = withRobotFile;', context);
  const withRobotFile = context.withRobotFile as (files: unknown[], project: unknown, options: unknown) => unknown[];
  let project = setRobotConnection(prepareProjectFile(createDemoProject()), { target: 'roborio', host: '10.0.0.2', port: 22, directory: '/home/lvuser/bordeaux' });
  project = addRobot(renameRobot(project, 'robot', 'Comp bot'), 'Comp-bot');
  const paths = [{ pathId: 'p', name: 'P', fileName: 'P.bdx', contents: Buffer.from('x') }];
  expect(() => withRobotFile(paths, project, { robotFile: true })).toThrow(/“Comp-bot” and “Comp bot” would both use Comp-bot\.robot/);
  expect(withRobotFile(paths, project, { robotFile: false })).toBe(paths);
});
