import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StepInspector } from '../src/renderer/components/RoutineInspector';
import { CommandBranches } from '../src/renderer/components/CommandBranches';
import { CommandParameterEditor } from '../src/renderer/components/ContextInspector';
import { AUTO } from '../src/renderer/lib/routineModel';

// Review F4: a saved output schema snapshot agrees with the catalog structurally. Object key order alone is never a
// type change; real changes (value type, enum order) still warn and only an explicit repair resets authored values.
const I64 = { kind: 'integerString', valueType: 'I64' };
const I64_REORDERED = { valueType: 'I64', kind: 'integerString' };
const ZONE = { kind: 'enum', valueType: 'enum', enumValues: ['Left', 'Center', 'Right'] };

it('uses a browser-valid exact-integer pattern without accepting decimal or exponent text', () => {
  const html = renderToStaticMarkup(React.createElement(CommandParameterEditor, {
    id: 'exact', label: 'Exact count', value: '9007199254740993', schema: I64, onChange: () => {},
  }));
  // HTML input patterns compile with Unicode sets (v), where a literal hyphen in a class must be escaped.
  const pattern = html.match(/pattern="([^"]+)"/)[1];
  const browserPattern = new RegExp('^(?:' + pattern + ')$', 'v');
  for (const value of ['0', '+1', '-1', '9007199254740993']) expect(browserPattern.test(value)).toBe(true);
  for (const value of ['', '1.5', '1e3', ' 1', '١']) expect(browserPattern.test(value)).toBe(false);
});

function catalog(outputs) {
  return { authoritative: true, generatedSchemaVersion: '1.3', conditions: [], commands: [{ id: 'inspect', label: 'Inspect game piece', member: 'inspect', parameters: [], outputs }] };
}
function repeatWithStop(schema, extra = {}) {
  const producer = { id: 'count', type: 'function', cat: 'command', title: 'Inspect game piece', invocation: { commandId: 'inspect', arguments: {} } };
  const node = { id: 'loop', type: 'repeat', times: 4, nodes: [producer],
    until: { source: 'output', nodeId: 'count', output: 'count', schema, operator: 'gte', value: '9007199254740993', ...extra } };
  return { node, routine: { id: 'r', name: 'R', nodes: [node] } };
}
function renderRepeat(schema, outputs) {
  const { node, routine } = repeatWithStop(schema);
  const cat = catalog(outputs);
  const html = renderToStaticMarkup(React.createElement(StepInspector, { node, routine, paths: [], acq: { outcomes: {}, passes: {} }, run: { segs: [] },
    issues: AUTO.analyze(routine, [], cat), robotProject: { catalog: cat } }));
  return { html, issues: AUTO.analyze(routine, [], cat) };
}

describe('repeat stop schema agreement', () => {
  it('treats a key-reordered I64 snapshot as the same type and keeps the exact threshold and operator', () => {
    const { html, issues } = renderRepeat(I64_REORDERED, [{ name: 'count', label: 'Pieces counted', schema: I64 }]);
    // No type-changed fact and no repair action, in any wording.
    expect(html).not.toMatch(/type changed|now reports|new type|reset the value/i);
    expect(html).toContain('value="9007199254740993"');
    expect(html).toContain('At least');
    expect(issues.map((issue) => issue.code)).not.toContain('stop-schema-changed');
  });

  it('still flags a real value-type change and offers only an explicit repair', () => {
    const { html, issues } = renderRepeat(I64, [{ name: 'count', label: 'Pieces counted', schema: { kind: 'integerString', valueType: 'U64' } }]);
    // One explanation names both types; the repair states what it resets.
    expect(html).toContain('Saved as I64; the command now reports U64.');
    expect(html).toContain('Use U64 and reset the value');
    expect(html.match(/type changed|now reports/g)).toHaveLength(2); // group label + message, not a second problem line
    // Rendering never rewrites the authored value; only the repair button would.
    expect(html).toContain('value="9007199254740993"');
    expect(issues.map((issue) => issue.code)).toContain('stop-schema-changed');
  });

  it('keeps the saved stop recoverable when the catalog no longer lists the command', () => {
    const { html } = renderRepeat(I64, []);
    expect(html).toContain('value="9007199254740993"');
    expect(html).not.toContain('and reset the value');
  });
});

describe('command output branch schema agreement', () => {
  const branch = (schema) => ({ id: 'cmd', type: 'function', cat: 'command', title: 'Inspect game piece', invocation: { commandId: 'inspect', arguments: {} },
    outputBranch: { output: 'zone', schema, routes: [
      { id: 'l', label: 'Left', operator: 'eq', value: 'Left', nodes: [{ id: 'p', type: 'path', ref: 'x' }] },
      { id: 'o', label: 'Otherwise', operator: 'otherwise', nodes: [] },
    ] } });
  const render = (saved, current) => renderToStaticMarkup(React.createElement(CommandBranches, {
    node: branch(saved), command: catalog([{ name: 'zone', label: 'Scoring zone', schema: current }]).commands[0], set: () => {}, acq: { outcomes: {} } }));

  it('does not report a key-reordered enum snapshot as changed', () => {
    const html = render({ enumValues: ['Left', 'Center', 'Right'], valueType: 'enum', kind: 'enum' }, ZONE);
    expect(html).not.toMatch(/type changed|Rebuild routes/i);
  });

  it('reports a meaningful enum order change with an explicit rebuild and keeps the routes', () => {
    const html = render(ZONE, { ...ZONE, enumValues: ['Right', 'Center', 'Left'] });
    expect(html).toContain('This output’s type changed');
    expect(html).toContain('Rebuild routes');
    expect(html).toContain('Route 1');
  });
});
