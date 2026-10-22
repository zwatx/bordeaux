// Root-owned native checks. Fixtures are seeded through mocked local restore; tested actions use trusted input.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const OUTPUTS = [
  { name: 'ready', label: 'Ready', schema: { kind: 'boolean', valueType: 'Boolean' } },
  { name: 'result', label: 'Result', schema: { kind: 'enum', valueType: 'enum', enumValues: ['Success', 'Retry', 'Failed'] } },
  { name: 'distance', label: 'Measured distance to scoring target', schema: { kind: 'number', valueType: 'DBL' } },
];
const clone = value => structuredClone(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const commandNode = routines => routines.find(r => r.id === 'route-test').nodes.find(n => n.id === 'inspect-step');
function fixture(corpus, catalog, integer = false) {
  const first = clone(corpus.paths.find(p => p.id === 'corpus-neutral-stop'));
  const wait = id => ({ id, type: 'builtin', builtinId: 'bordeaux.wait', arguments: { durationS: .11 } });
  const producer = { id: 'repeat-command', type: 'function', cat: 'command', title: catalog.commands[0].label, invocation: { commandId: 'inspect', arguments: { ticket: '9007199254740993', note: 'Nested producer' } } };
  const repeat = { id: 'fixture-repeat', type: 'repeat', times: 2,
    until: { source: 'output', nodeId: producer.id, output: 'ready', schema: clone(OUTPUTS[0].schema), operator: 'eq', value: true },
    nodes: [{ id: 'fixture-decision', type: 'decision', cond: '', thenLabel: 'Yes', elseLabel: 'No',
      then: [{ id: 'fixture-exit', type: 'end', scope: 'repeat' }], else: [wait('nested-wait')] }, producer] };
  // repeat + decision + Exit + nested wait + producer + path + 122 waits = 128 authored steps.
  const nodes = [repeat, { id: 'nested-path', type: 'path', ref: first.id }, ...Array.from({ length: 122 }, (_, i) => wait('fixture-wait-' + i))];
  const schema = integer ? { kind: 'integerString', valueType: 'I64' } : clone(OUTPUTS[2].schema);
  const routes = [
    { id: 'route-populated', label: 'At least threshold', operator: 'gte', value: integer ? '9007199254740993' : 12.5, nodes },
    { id: 'route-empty', label: 'Exact zero', operator: 'eq', value: integer ? '0' : 0, nodes: [] },
    { id: 'route-empty-two', label: 'Below zero', operator: 'lt', value: integer ? '-1' : -1, nodes: [] },
    { id: 'route-otherwise', label: 'Otherwise', operator: 'otherwise', nodes: [] },
  ];
  return { ...clone(corpus), schemaVersion: '1.1', paths: [first], pathFolders: [], pathLinks: [],
    routines: [{ id: 'route-test', name: 'Command output branching', nodes: [{ id: 'inspect-step', type: 'function', cat: 'command', title: catalog.commands[0].label,
      invocation: { commandId: 'inspect', arguments: { ticket: '9007199254740993', note: 'Authored argument: keep exactly' } },
      ends: { timeoutS: 2, onTimeout: 'endRoutine' }, outputBranch: { output: 'distance', schema, routes } }, wait('outer-tail')] },
      { id: 'routine-neighbor', name: 'Keep neighboring routine', nodes: [wait('neighbor-wait')] }],
    activeRoutineId: 'route-test', editor: { activePathId: first.id, robotProjectBookmarkId: 'fixture', unitSystem: 'metric' } };
}
exports.runConsequences = async h => {
  const { evaluate, wait, click, key, drain, source, isolate, reset, save, reload, snapshot } = h;
  const output = process.env.BORDEAUX_BRANCH_UI_OUTPUT, rows = [];
  let captureSequence = 0;
  const start = async (name, width) => fs.appendFile(path.join(output, 'consequence-steps.jsonl'), JSON.stringify({ name, width, phase: 'start', at: new Date().toISOString() }) + '\n');
  const record = async row => { await fs.appendFile(path.join(output, 'consequence-steps.jsonl'), JSON.stringify({ name: row.name, width: row.width, phase: 'complete', at: new Date().toISOString() }) + '\n'); rows.push(row); await fs.writeFile(path.join(output, 'consequence-results.json'), JSON.stringify(rows, null, 2)); };
  const corpus = JSON.parse(await fs.readFile('benchmarks/planner-corpus/v2/corpus.bordeaux.json', 'utf8'));
  const catalog = clone(h.catalog);
  catalog.commands[0].outputs = clone(OUTPUTS);
  catalog.commands[0].parameters = [
    { name: 'ticket', label: 'Exact ticket', role: 'argument', schema: { kind: 'integerString', valueType: 'I64' } },
    { name: 'note', label: 'Note', role: 'argument', schema: { kind: 'string', valueType: 'String' } },
  ];
  catalog.commands.push({ ...clone(catalog.commands[0]), id: 'alternate', label: 'Alternate scoring command', member: 'Alternate.vi' });
  const populated = fixture(corpus, catalog);
  const expectSource = async expected => wait(async () => equal(await source(), expected), 'exact complete routines source');
  const chooseOutput = async (value, mode = 'pointer') => {
    await click('#command-branch-output');
    const selector = '#command-branch-output-listbox [role="option"][data-value=' + JSON.stringify(value) + ']';
    const optionMeta = await evaluate(selector => document.querySelector(selector)?.querySelector('small')?.textContent, selector);
    const selected = commandNode(await source()).outputBranch?.output;
    if (value === '') assert.equal(optionMeta, 'Removes 128 branch steps');
    else if (value !== selected) assert.ok(optionMeta?.includes('removes 128 steps'), 'Replacement option states complete nested consequence in advance');
    else if (optionMeta?.startsWith('Type changed')) assert.equal(optionMeta, 'Type changed · removes 128 steps');
    if (mode === 'pointer') await click(selector);
    else {
      const index = await evaluate(value => [...document.querySelectorAll('#command-branch-output-listbox [role="option"]')].findIndex(el => el.dataset.value === value), value);
      assert.ok(index >= 0); await key('Home'); for (let i = 0; i < index; i++) await key('Down'); await key('Enter');
    }
    await drain();
  };
  const openCommand = () => click('.choice-browser[aria-label="Command"] .choice-change');
  const chooseCommand = async (label, mode = 'pointer', query) => {
    await openCommand();
    assert.equal(await evaluate(() => document.querySelector('#routine-command-note')?.textContent), 'Another command removes 128 branch steps.');
    if (query) await replace('#routine-command', query);
    if (mode === 'pointer') await click('#routine-command-results [role="option"]', label);
    else {
      const index = await evaluate(label => [...document.querySelectorAll('#routine-command-results [role="option"]')].findIndex(el => el.querySelector('strong')?.textContent === label), label);
      assert.ok(index >= 0); for (let i = 0; i <= index; i++) await key('Down'); await key('Enter');
    }
    await drain();
  };
  const replace = async (selector, text) => {
    await click(selector); await key('Home'); await key('End', ['shift']); await key('Backspace');
    if (text) { await h.focusEditor(); await h.win.webContents.insertText(text); }
    await drain();
  };
  const noAction = async before => {
    await drain(); assert.deepEqual(await source(), before); await isolate();
    assert.equal(await evaluate(() => document.querySelector('.toolbar [aria-label="Undo"]').disabled), true, 'Refusal records no history');
    assert.equal(await evaluate(() => Boolean(document.querySelector('.deletion-notice'))), false, 'Refusal announces no success');
  };
  async function notice(kind, width) {
    const measured = await evaluate(() => {
      const copy = document.querySelector('.deletion-copy'), undo = document.querySelector('.deletion-notice button');
      const live = document.querySelector('.deletion-footer [role="status"]');
      return { text: copy?.textContent, title: copy?.title, scrollWidth: copy?.scrollWidth, clientWidth: copy?.clientWidth,
        undoName: undo?.getAttribute('aria-label'), undoDisabled: undo?.getAttribute('aria-disabled'),
        live: live?.textContent, polite: live?.getAttribute('aria-live'), atomic: live?.getAttribute('aria-atomic') };
    });
    const messages = { output: ['Output changed · 128 steps'], continue: ['Branches removed · 128 steps'], rebuild: ['Routes rebuilt · 128 steps'],
      route: ['Route removed · 128 steps'], command: ['Command changed · 128 steps removed', 'Command changed · 128 steps'] };
    assert.ok(messages[kind].includes(measured.text), 'Exact visible advance consequence: ' + measured.text);
    assert.ok(measured.title?.includes('128') && measured.live?.includes('128')); assert.ok(measured.undoName?.startsWith('Undo: '));
    assert.notEqual(measured.undoDisabled, 'true'); assert.equal(measured.polite, 'polite'); assert.equal(measured.atomic, 'true');
    await fs.appendFile(path.join(output, 'footer-measurements.jsonl'), JSON.stringify({ width, kind, ...measured }) + '\n');
    assert.ok(measured.scrollWidth <= measured.clientWidth, '128-count ' + kind + ' footer must fit without clipping');
    measured.capture = 'consequence-' + width + '-' + String(++captureSequence).padStart(2, '0') + '-' + kind + '-notice';
    await snapshot(measured.capture); return measured;
  }
  for (const [width, height] of [[1440, 900], [1100, 720]]) {
    const resetPopulated = (nextCatalog = catalog, project = populated) => reset(project, nextCatalog, width, height);
    async function cycle(name, kind, action, inspect, nextCatalog = catalog) {
      await start(name, width); await resetPopulated(nextCatalog); const before = await source(), original = commandNode(before);
      assert.equal(original.invocation.arguments.ticket, '9007199254740993'); assert.equal(original.ends.timeoutS, 2);
      assert.equal(original.outputBranch.routes[0].nodes[0].nodes[0].then[0].scope, 'repeat');
      await action(); await wait(async () => !equal(await source(), before), name + ' source applied once');
      const after = await source(); inspect(commandNode(after), original);
      if (['output', 'continue', 'rebuild'].includes(kind)) assert.equal(await evaluate(() => document.activeElement.id), 'command-branch-output');
      if (kind === 'command' && commandNode(after).invocation) assert.equal(await evaluate(() => document.activeElement.matches('.choice-browser[aria-label="Command"] .choice-change')), true, 'Applied command returns focus to Change');
      const expected = clone(before); expected[0].nodes[0] = clone(commandNode(after)); assert.deepEqual(after, expected, 'Only intended command subtree changes; outer/nontarget routines retained');
      const copy = await notice(kind, width); await isolate();
      const savedAfter = await save(); assert.deepEqual(savedAfter.routines, after, 'Save preserves complete changed routines');
      // First pointer press on footer Undo: no compensating retry, no synthetic .click().
      await click('.deletion-notice button'); await expectSource(before);
      await key('Z', ['meta', 'shift']); await expectSource(after);
      await key('Z', ['meta']); await expectSource(before);
      const savedBefore = await save(); assert.deepEqual(savedBefore.routines, before, 'Save preserves every restored argument/end/route/nested ID');
      await reload(savedAfter); await expectSource(after);
      await reload(savedBefore); await expectSource(before); await isolate();
      await record({ width, height, name, passed: true, before, after, copy, savedAfter: savedAfter.routines, savedBefore: savedBefore.routines });
    }
    await cycle('populated output replacement', 'output', () => chooseOutput('ready'), (node, old) => {
      assert.equal(node.outputBranch.output, 'ready'); assert.equal(node.outputBranch.routes.length, 2); assert.ok(node.outputBranch.routes.every(r => !r.nodes.length));
      assert.deepEqual(node.invocation, old.invocation); assert.deepEqual(node.ends, old.ends);
    });
    await cycle('populated Continue', 'continue', () => chooseOutput(''), (node, old) => { assert.equal(node.outputBranch, undefined); assert.deepEqual(node.invocation, old.invocation); assert.deepEqual(node.ends, old.ends); });
    const changed = clone(catalog); changed.commands[0].outputs[2].schema = { kind: 'integer', valueType: 'I32' };
    const rebuildCheck = (node, old) => { assert.equal(node.outputBranch.schema.valueType, 'I32'); assert.ok(node.outputBranch.routes.every(r => !r.nodes.length)); assert.notEqual(node.outputBranch.routes[0].id, old.outputBranch.routes[0].id); assert.deepEqual(node.invocation, old.invocation); assert.deepEqual(node.ends, old.ends); };
    await cycle('populated explicit Rebuild routes', 'rebuild', async () => { assert.equal(await evaluate(() => document.querySelector('.command-branches .cmd-project-error button').textContent), 'Rebuild routes · removes 128 steps'); await click('.command-branches .cmd-project-error button'); await drain(); assert.equal(await evaluate(() => document.activeElement.id), 'command-branch-output'); }, rebuildCheck, changed);
    await cycle('populated current-output picker rebuild', 'rebuild', () => chooseOutput('distance'), rebuildCheck, changed);
    const removeCheck = (node, old) => { assert.deepEqual(node.outputBranch.routes, old.outputBranch.routes.slice(1)); assert.deepEqual(node.invocation, old.invocation); assert.deepEqual(node.ends, old.ends); };
    await cycle('populated route pointer press', 'route', async () => {
      await click('[data-route-remove="route-populated"]'); await drain();
      assert.equal(await evaluate(() => document.activeElement.getAttribute('data-route-remove')), 'route-empty');
    }, removeCheck);
    await cycle('populated route keyboard Enter', 'route', async () => {
      await click('#command-branch-output'); await key('Escape'); await key('Tab');
      assert.equal(await evaluate(() => document.activeElement.getAttribute('data-route-remove')), 'route-populated', 'Native Tab reaches first enabled Remove');
      await key('Enter'); await drain(); assert.equal(await evaluate(() => document.activeElement.getAttribute('data-route-remove')), 'route-empty');
    }, removeCheck);
    await cycle('populated command replacement', 'command', () => chooseCommand('Alternate scoring command'), (node, old) => { assert.equal(node.invocation.commandId, 'alternate'); assert.equal(node.invocation.arguments.ticket, '0'); assert.equal(node.invocation.arguments.note, ''); assert.equal(node.outputBranch, undefined); assert.deepEqual(node.ends, old.ends); });
    await cycle('populated command clear', 'command', async () => { await chooseCommand('Choose a command'); assert.equal(await evaluate(() => document.activeElement.id), 'routine-command'); }, (node, old) => { assert.equal(node.invocation, null); assert.equal(node.outputBranch, undefined); assert.equal(node.title, 'Robot command'); assert.deepEqual(node.ends, old.ends); });

    await start('128-count header/output option/command note fit', width); await resetPopulated(); const fit = {};
    await evaluate(() => document.querySelector('.command-branch-head').scrollIntoView({ block: 'center' }));
    fit.header = await evaluate(() => {
      const root = document.querySelector('.command-branch-head'), summary = root.querySelector('span'), rect = el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
      const s = rect(summary), buttons = [...root.querySelectorAll('button')].map(el => ({ ...rect(el), name: el.getAttribute('aria-label') }));
      return { text: summary.textContent, scrollWidth: summary.scrollWidth, clientWidth: summary.clientWidth, removeName: root.querySelector('[data-route-remove]')?.getAttribute('aria-label'), removeTitle: root.querySelector('[data-route-remove]')?.title, summary: s, buttons, noOverlap: buttons.every(b => Math.min(s.right, b.right) <= Math.max(s.left, b.left) || Math.min(s.bottom, b.bottom) <= Math.max(s.top, b.top)), visible: buttons.every(b => b.left >= 0 && b.right <= innerWidth && b.top >= 0 && b.bottom <= innerHeight) };
    });
    assert.ok(fit.header.text.includes('128 steps')); assert.equal(fit.header.removeName, 'Remove route 1 and its 128 steps'); assert.equal(fit.header.removeTitle, 'Remove comparison and its 128 steps'); assert.ok(fit.header.scrollWidth <= fit.header.clientWidth, 'Complete route summary count remains readable'); assert.ok(fit.header.noOverlap && fit.header.visible); await snapshot('consequence-' + width + '-route-header-128');
    await click('#command-branch-output');
    fit.option = await evaluate(() => {
      const el = document.querySelector('#command-branch-output-listbox [data-value="result"] small'), r = el.getBoundingClientRect(), range = document.createRange();
      range.setStart(el.firstChild, 0); range.setEnd(el.firstChild, el.textContent.indexOf('removes') + 'removes'.length);
      return { text: el.textContent, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, essentialWidth: range.getBoundingClientRect().width, width: r.width };
    });
    assert.equal(fit.option.text, 'Named outcomes · removes 128 steps'); assert.ok(fit.option.scrollWidth <= fit.option.clientWidth || fit.option.essentialWidth <= fit.option.width);
    await snapshot('consequence-' + width + '-output-meta-128'); await key('Escape'); await openCommand();
    fit.note = await evaluate(() => { const el = document.querySelector('#routine-command-note'), r = el.getBoundingClientRect(), parent = el.closest('.ctxinsp-body').getBoundingClientRect(); return { text: el.textContent, describedBy: document.querySelector('#routine-command').getAttribute('aria-describedby'), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, left: r.left, right: r.right, parentLeft: parent.left, parentRight: parent.right }; });
    assert.equal(fit.note.text, 'Another command removes 128 branch steps.'); assert.equal(fit.note.describedBy, 'routine-command-note'); assert.ok(fit.note.scrollWidth <= fit.note.clientWidth && fit.note.left >= fit.note.parentLeft && fit.note.right <= fit.note.parentRight);
    await snapshot('consequence-' + width + '-command-note-128'); await isolate(); await record({ width, height, name: '128-count header/output option/command note fit', passed: true, fit });

    await start('invalid route draft refuses pointer press and retains focus', width); await resetPopulated(); const untouched = await source();
    await replace('#route-value-route-populated', ''); await key('Enter');
    assert.equal(await evaluate(() => document.querySelector('#route-value-route-populated').getAttribute('aria-invalid')), 'true');
    await click('[data-route-remove="route-populated"]'); await drain();
    assert.equal(await evaluate(() => document.activeElement.id), 'route-value-route-populated'); await noAction(untouched);
    await record({ width, height, name: 'invalid route draft refuses pointer press and retains focus', passed: true });
    for (const mode of ['pointer', 'keyboard']) {
      await start('invalid draft output refusal after rAF ' + mode, width); await resetPopulated(); const before = await source(); await replace('#route-value-route-populated', ''); await key('Enter');
      await chooseOutput('ready', mode); await drain();
      assert.equal(await evaluate(() => document.activeElement.id), 'route-value-route-populated'); assert.equal(await evaluate(() => document.querySelector('#command-branch-output').getAttribute('aria-expanded')), 'false'); await noAction(before);
      await record({ width, height, name: 'invalid draft output refusal after rAF ' + mode, passed: true });
      await start('invalid draft command refusal after rAF ' + mode, width); await resetPopulated(); const commandBefore = await source(); await replace('#route-value-route-populated', ''); await key('Enter');
      await chooseCommand('Alternate scoring command', mode, 'Alternate'); await drain();
      assert.equal(await evaluate(() => document.activeElement.id), 'route-value-route-populated'); assert.ok(await evaluate(() => document.querySelector('#routine-command-choices'))); assert.equal(await evaluate(() => document.querySelector('#routine-command').value), 'Alternate', 'Refused chooser keeps the typed query'); await noAction(commandBefore);
      await record({ width, height, name: 'invalid draft command refusal after rAF ' + mode, passed: true });
    }
    const missing = clone(catalog); missing.commands[0].outputs = [clone(OUTPUTS[0])];
    await start('missing output recovery', width); await resetPopulated(missing); const missingBefore = await source();
    assert.ok(await evaluate(() => document.body.textContent.includes('The saved output is missing')));
    await chooseOutput('distance'); assert.deepEqual(await source(), missingBefore, 'Reselect missing saved output is unchanged'); await noAction(missingBefore);
    await chooseOutput(''); await wait(async () => !commandNode(await source()).outputBranch, 'Continue recovers missing output'); await notice('continue', width);
    await click('.deletion-notice button'); await expectSource(missingBefore);
    // Routine history clears step selection. Reopen the restored command before editing its routes again.
    await click('[data-id="inspect-step"] .rt-step-body');
    await chooseOutput('ready'); await notice('output', width); await click('.deletion-notice button'); await expectSource(missingBefore); await isolate();
    await record({ width, height, name: 'missing output preserved/reselection no-op/Continue recovery/Undo', passed: true });
    const fractional = clone(catalog); fractional.commands[0].outputs[2].min = .5; fractional.commands[0].outputs[2].max = 100.5;
    await start('retained I64 with current DBL fractional bounds', width); await resetPopulated(fractional, fixture(corpus, catalog, true)); const integerBefore = await source();
    assert.ok(await evaluate(() => document.body.textContent.includes('This output’s type changed')));
    await replace('#route-value-route-populated', '9007199254740995'); await key('Enter');
    const integerExpected = clone(integerBefore); commandNode(integerExpected).outputBranch.routes[0].value = '9007199254740995'; await expectSource(integerExpected);
    const exact = await save(); assert.deepEqual(exact.routines, integerExpected); await reload(exact); await expectSource(integerExpected); await isolate();
    await record({ width, height, name: 'saved I64 edits with current DBL fractional bounds/save/reload', passed: true, before: integerBefore, after: integerExpected });
    await start('legacy repeat producer', width); await resetPopulated(); const legacyBefore = await source(); await click('[data-id="fixture-repeat"] .rt-step-body');
    await click('#routine-repeat-producer'); await key('Home'); await key('Enter'); await drain();
    assert.equal(await evaluate(() => document.activeElement.id), 'routine-repeat-producer'); assert.equal(await evaluate(() => document.querySelector('#routine-repeat-producer').getAttribute('aria-expanded')), 'false'); assert.deepEqual(await source(), legacyBefore); await isolate();
    await record({ width, height, name: 'legacy repeat producer unchanged selection closes/refocuses', passed: true });
  }
  return rows;
};
