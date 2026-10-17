import fs from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { beforeAll, expect, it, vi } from 'vitest';

let handlerSource: string;
beforeAll(async () => {
  const text = await fs.readFile('src/electron/main.ts', 'utf8');
  const ast = ts.createSourceFile('main.ts', text, ts.ScriptTarget.Latest, true);
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
