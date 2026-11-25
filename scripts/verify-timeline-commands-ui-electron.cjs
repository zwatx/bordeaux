// The path timeline's Commands lane in the built App: chips at both ends stay inside the lane with their diamond on
// the command's time, crowds stack into rows and a "+N" menu, long names shorten with the full name in the title,
// groups show as one chip and loops/repeats draw their extent. Both supported sizes, inspector open and closed,
// pointer selection and drag, keyboard selection and the "+N" menu with focus return, and item menus by right-click
// and Shift+F10 on waypoints, command chips and the bare lane. Local fixtures only.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = process.env.BORDEAUX_TIMELINE_COMMANDS_UI_OUTPUT;
app.setPath('userData', path.join(output, 'user-data'));
let win, saved;
const errors = [], results = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`, true);
async function wait(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(75); } throw Error('Timed out: ' + label); }
async function focusWindow() {
  app.focus({ steal: true }); win.focus(); win.webContents.focus();
  await wait(() => evaluate(() => document.hasFocus()), 'renderer keyboard focus');
}
async function drain() { await evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function center(selector) {
  return evaluate((selector) => {
    const item = document.querySelector(selector);
    if (!item) throw Error('Missing ' + selector);
    const r = item.getBoundingClientRect(), x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
    if (!item.contains(document.elementFromPoint(x, y))) throw Error('Obscured ' + selector);
    return { x, y };
  }, selector);
}
async function click(selector) {
  await focusWindow();
  const point = await center(selector);
  for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...point });
  await delay(200);
}
async function key(keyCode, modifiers = []) {
  await focusWindow();
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  // Native activation of a focused button needs the character event too.
  if (keyCode === 'Enter' || keyCode === 'Space') win.webContents.sendInputEvent({ type: 'char', keyCode: keyCode === 'Enter' ? String.fromCharCode(13) : ' ', modifiers });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await delay(90);
}
async function rightClick(point) {
  await focusWindow();
  for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'right', clickCount: 1, ...point });
  await delay(200);
}
// The open item menu: its name, items, focus and bounds against the window.
const menuState = () => evaluate(() => {
  const menu = document.querySelector('.ctxmenu[role="menu"]');
  if (!menu) return null;
  const r = menu.getBoundingClientRect();
  return { label: menu.getAttribute('aria-label'), items: [...menu.querySelectorAll('[role^="menuitem"]')].map((el) => el.textContent),
    checked: [...menu.querySelectorAll('[role="menuitemcheckbox"]')].map((el) => el.getAttribute('aria-checked')),
    focused: menu.contains(document.activeElement) ? document.activeElement.textContent : null,
    inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight };
});
async function snapshot(name) { await drain(); await fs.writeFile(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); }

const catalog = { runtime: 'labview', projectName: 'Timeline fixture', sourceFileCount: 1, scannedAt: '', warnings: [],
  commands: ['Shooter Immediate', 'Intake', 'Feed note', 'Arm stow', 'Lights on', 'Align to target', 'Climb extend', 'Spin up flywheel']
    .map((label, index) => ({ id: 'cmd' + index, label, member: 'Command' + index + '.vi', ownerType: 'LabVIEW', kind: 'factory', confidence: 'confirmed', source: { file: 'Command' + index + '.vi', line: 1 }, parameters: [], outputs: [], labviewConnector: {} })) };
ipcMain.handle('branches:restore', () => ({ project: saved }));
ipcMain.handle('branches:catalog', () => ({ catalog, bookmarkId: 'fixture' }));
ipcMain.handle('branches:save', (_event, project) => { saved = project; return { saved: true }; });
ipcMain.handle('branches:robot-call', (_event, name) => { throw Error('Robot call in a local harness: ' + name); });

const invoke = (id, extra = {}) => ({ commandId: id, arguments: {}, ...extra });
const marker = (id, f, cmd, extra = {}) => ({ id, f, name: 'event' + id.replace(/\D/g, ''), cmd, invocation: invoke(cmd), group: 'sequential', ...extra });
const scenes = {
  // The reported case: one command at the start and one at the very end.
  ends: [marker('m1', 0, 'cmd0'), marker('m2', 1, 'cmd0')],
  mixed: [
    marker('m1', 0, 'cmd0'),
    { ...marker('m2', 0.12, 'cmd1'), invocation: undefined, cmd: 'none', commandGroup: { mode: 'parallel', commands: [invoke('cmd1'), invoke('cmd2', { loop: { until: { kind: 'time', seconds: 0.6 } } }), invoke('cmd3')] } },
    ...[0.36, 0.36, 0.36, 0.362, 0.364, 0.366].map((f, i) => marker('m' + (10 + i), f, 'cmd' + (1 + i))),
    { ...marker('m3', 0.5, 'cmd4'), name: 'Retract the intake and wait for the indexer to settle before shooting' },
    { ...marker('m4', 0.62, 'cmd7'), invocation: invoke('cmd7', { loop: { until: { kind: 'distance', meters: 0.9 } } }) },
    { ...marker('m5', 0.25, 'cmd4'), schedule: { repeatEveryS: 0.2, endTimeS: 1.0 } },
    { ...marker('m6', 0.8, 'cmd5'), invocation: invoke('cmd5', { loop: { until: { kind: 'pathEnd' } } }) },
    { ...marker('m7', 0.9, 'cmd6'), invocation: undefined, cmd: 'none', commandGroup: { mode: 'sequential', commands: [invoke('cmd6'), invoke('cmd3')] } },
    marker('m8', 1, 'cmd0'),
  ],
};

// Geometry of every chip against the lane and the time axis.
const laneState = () => evaluate(() => {
  const pt = document.querySelector('.pt').getBoundingClientRect(), ruler = document.querySelector('.pt-ruler').getBoundingClientRect();
  const lane = document.querySelector('.pt-lane').getBoundingClientRect();
  const total = Number(document.querySelector('.pt-clock-total').textContent);
  const chips = [...document.querySelectorAll('.pt-chip')].map((el) => {
    const r = el.getBoundingClientRect(), diamond = el.querySelector('.pt-diamond')?.getBoundingClientRect();
    const name = el.querySelector('.pt-chip-name');
    const time = Number((el.getAttribute('aria-label').match(/, (\d+\.\d\d) s(?:,|$)/) || [])[1]);
    return { label: el.getAttribute('aria-label'), title: el.title, stack: el.classList.contains('stack'), left: el.classList.contains('left'), group: el.classList.contains('group'),
      x0: r.left, x1: r.right, y0: r.top, y1: r.bottom, diamond: diamond ? diamond.left + diamond.width / 2 : null, time,
      timeX: ruler.left + (time / total) * ruler.width, pxPerS: ruler.width / total, truncated: name ? name.scrollWidth > name.clientWidth + 0.5 : false,
      members: el.classList.contains('stack') ? Number(el.textContent.replace('+', '')) : 1 };
  });
  return { chips, pt: { left: pt.left, right: pt.right }, lane: { top: lane.top, bottom: lane.bottom, left: lane.left, right: lane.right, height: lane.height },
    extents: [...document.querySelectorAll('.pt-extent')].map((el) => { const r = el.getBoundingClientRect(); return { cls: el.className, x0: r.left, x1: r.right }; }) };
});
function checkLane(state, count, label) {
  const { chips } = state;
  assert.equal(chips.reduce((n, chip) => n + chip.members, 0), count, label + ': every command is a chip or in a +N chip');
  for (const chip of chips) {
    assert.ok(chip.x0 >= state.pt.left + 60 && chip.x1 <= state.pt.right - 3, label + ': chip inside the timeline: ' + chip.label);
    assert.ok(chip.y0 >= state.lane.top - 0.5 && chip.y1 <= state.lane.bottom + 0.5, label + ': chip inside the lane rows: ' + chip.label);
    if (!chip.stack) assert.ok(Math.abs(chip.diamond - chip.timeX) <= 1.5 + chip.pxPerS * 0.005, label + ': diamond on its time: ' + chip.label + ' ' + chip.diamond + ' vs ' + chip.timeX);
    for (const other of chips) if (other !== chip) {
      const overlap = Math.min(chip.x1, other.x1) - Math.max(chip.x0, other.x0) > 0.5 && Math.min(chip.y1, other.y1) - Math.max(chip.y0, other.y0) > 0.5;
      assert.ok(!overlap, label + ': chips do not overlap: ' + chip.label + ' / ' + other.label);
    }
  }
}

app.whenReady().then(async () => {
  try {
    const corpus = JSON.parse(await fs.readFile('benchmarks/planner-corpus/v3/corpus.bordeaux.json', 'utf8'));
    const base = structuredClone(corpus.paths.find((p) => p.id === 'corpus-neutral-slalom'));
    win = new BrowserWindow({ show: true, width: 1440, height: 900, useContentSize: true, webPreferences: { preload: path.join(__dirname, 'verify-command-branches-ui-preload.cjs'), sandbox: false, contextIsolation: true, backgroundThrottling: false } });
    win.webContents.on('console-message', (details) => { if (details.level === 'error' && !details.message.startsWith("Loading the font 'data:")) errors.push(details.message); });
    const load = async (scene, unitSystem = 'metric', [width, height] = [1440, 900]) => {
      const doc = { ...base, name: 'Timeline ' + scene, markers: structuredClone(scenes[scene]) };
      saved = { ...corpus, paths: [doc], pathLinks: [], routines: [], editor: { activePathId: doc.id, robotProjectBookmarkId: 'fixture', unitSystem } };
      win.setContentSize(width, height);
      await win.loadFile(path.resolve('dist-renderer/index.html'));
      await wait(() => evaluate((count) => document.querySelectorAll('.pt-chip').length > 0 && !document.querySelector('.fieldcol[data-planning-ready="false"]')
        && Number(document.querySelector('.pt-clock-total')?.textContent) > 0 && [...document.querySelectorAll('.pt-chip')].some((el) => /Shooter Immediate/.test(el.getAttribute('aria-label'))), scenes[scene].length), 'timeline with commands');
      await delay(300);
      return scenes[scene].length;
    };
    const inspector = async (open) => {
      const isOpen = await evaluate(() => !document.querySelector('.rail-r')?.classList.contains('collapsed'));
      if (isOpen === open) return;
      if (open) { await click('.pt-chip:not(.stack)'); await click('aside.pp .pp-more'); } else await click('[aria-label="Hide inspector"]');
      await wait(async () => (await evaluate(() => !document.querySelector('.rail-r')?.classList.contains('collapsed'))) === open, 'inspector ' + (open ? 'open' : 'closed'));
      await delay(250);
    };

    for (const size of [[1440, 900], [1100, 720]]) {
      for (const scene of ['ends', 'mixed']) {
        const count = await load(scene, 'metric', size);
        for (const open of [false, true]) {
          await inspector(open);
          const state = await laneState();
          const label = scene + ' ' + size[0] + (open ? ' inspector' : '');
          checkLane(state, count, label);
          const end = state.chips.filter((chip) => !chip.stack).sort((a, b) => b.time - a.time)[0];
          assert.equal(end.left, true, label + ': the last chip faces left');
          if (scene === 'ends') assert.ok(state.chips.every((chip) => !chip.truncated), label + ': both names are complete');
          if (scene === 'mixed') {
            // A group is one chip, or (in the narrowest timeline) one entry of a +N chip.
            assert.ok(state.chips.some((chip) => chip.group && /parallel group of 3/.test(chip.label)) || state.chips.some((chip) => chip.stack && chip.title.split('\n').includes('Intake + 2')), label + ': parallel group chip');
            assert.ok(state.chips.some((chip) => chip.stack), label + ': crowd gathered into a +N chip');
            const long = state.chips.find((chip) => /Retract the intake/.test(chip.title));
            assert.ok(long && long.title.split('\n').includes('Retract the intake and wait for the indexer to settle before shooting'), label + ': long name kept in full in a title');
            assert.ok(state.extents.length >= (open && size[0] === 1100 ? 1 : 3), label + ': loop and repeat extents');
          }
          results.push({ label, chips: state.chips.length, rows: Math.round(state.lane.height / 23), extents: state.extents.length });
          await snapshot(scene + '-' + size[0] + (open ? '-inspector' : ''));
        }
      }
    }

    // Interactions at 1440: pointer selection, the +N menu by pointer and keyboard, keyboard selection, drag.
    const count = await load('mixed');
    await click('.pt-chip.group');
    assert.equal(await evaluate(() => document.querySelector('.pt-chip.group').getAttribute('aria-pressed')), 'true', 'pointer selects the group chip');
    await snapshot('mixed-1440-group-selected');
    await click('.pt-chip.stack');
    await wait(() => evaluate(() => document.activeElement?.matches('.pt-stack-item')), '+N menu focuses an item');
    const items = await evaluate(() => [...document.querySelectorAll('.pt-stack-item .pt-stack-name')].map((el) => el.textContent));
    assert.ok(items.length >= 2, '+N menu lists its commands');
    await snapshot('mixed-1440-stack-menu');
    await key('Escape');
    await wait(() => evaluate(() => document.activeElement?.matches('.pt-chip.stack') && !document.querySelector('.pt-stack-menu')), 'Escape returns focus to the +N chip');
    await key('Down');
    await wait(() => evaluate(() => document.activeElement?.matches('.pt-stack-item')), 'ArrowDown opens the +N menu');
    await key('Down'); await key('Enter');
    await wait(() => evaluate(() => document.activeElement?.matches('.pt-chip.stack') && document.querySelector('.pt-chip.stack.selected')), 'choosing selects the member and returns focus');
    // Keyboard: Tab from the +N chip moves on in time order and Enter selects a named chip.
    await key('Tab');
    const focused = await evaluate(() => document.activeElement?.matches('.pt-chip:not(.stack)') ? document.activeElement.getAttribute('aria-label') : null);
    assert.ok(focused, 'Tab reaches the next chip');
    await key('Enter');
    assert.equal(await evaluate(() => document.activeElement.getAttribute('aria-pressed')), 'true', 'Enter selects the focused chip');
    // Drag the end chip leftwards: it moves earlier and still faces into the lane.
    const endSel = await evaluate(() => {
      const chips = [...document.querySelectorAll('.pt-chip.left[data-selection]')];
      return chips.length ? '.pt-chip[data-selection="' + chips[chips.length - 1].dataset.selection + '"]' : null;
    });
    const named = (await laneState()).chips.filter((chip) => !chip.stack);
    const before = named.find((chip) => chip.time === Math.max(...named.map((c) => c.time)));
    const start = await center(endSel);
    await focusWindow();
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...start });
    for (let step = 1; step <= 8; step++) { win.webContents.sendInputEvent({ type: 'mouseMove', button: 'left', modifiers: ['leftButtonDown'], x: start.x - step * 15, y: start.y }); await delay(30); }
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: start.x - 120, y: start.y });
    await delay(400);
    const after = await laneState();
    checkLane(after, count, 'after drag');
    const moved = after.chips.find((chip) => chip.label.startsWith(before.label.split(',')[0]) && !chip.stack && chip.time < before.time - 0.05);
    assert.ok(moved, 'dragging moved the end command earlier');
    await snapshot('mixed-1440-after-drag');
    await key('z', ['control']);
    await delay(300);

    // Item menus at both sizes: right-click and Shift+F10 open the same short menu, select the item, leave the
    // playhead and the item where they were, stay in the window, and return focus on Escape. One Undo per action.
    for (const size of [[1440, 900], [1100, 720]]) {
      const w = size[0];
      await load('ends', 'metric', size);
      await inspector(false);
      await evaluate(() => { window.__ctx = []; addEventListener('contextmenu', (event) => window.__ctx.push(event.defaultPrevented)); });
      const clock = () => evaluate(() => document.querySelector('.pt-clock-now').textContent);
      const now = await clock();
      const wp = '.pt-wp[data-selection="wp:1"]';
      const wpPoint = await center(wp);
      await rightClick(wpPoint);
      await wait(() => menuState(), w + ': right-click opens the waypoint menu');
      let menu = await menuState();
      assert.deepEqual(menu.items, ['Open in inspector', 'Stop here', 'Duplicate waypoint', 'Delete waypoint'], w + ': waypoint menu items');
      assert.match(menu.label, / actions$/);
      assert.deepEqual(menu.checked, ['false'], w + ': Stop here shows its state');
      assert.equal(menu.focused, 'Open in inspector', w + ': the first item takes focus');
      assert.ok(menu.inside, w + ': waypoint menu inside the window');
      assert.equal(await evaluate((wp) => document.querySelector(wp).getAttribute('aria-pressed'), wp), 'true', w + ': right-click selects the waypoint');
      assert.equal(await clock(), now, w + ': right-click leaves the playhead');
      assert.equal(await evaluate(() => window.__ctx.at(-1)), true, w + ': the native menu gives way to the item menu');
      await snapshot('menu-waypoint-' + w);
      await key('Escape');
      await wait(() => evaluate((wp) => !document.querySelector('.ctxmenu') && document.activeElement?.matches(wp), wp), w + ': Escape returns focus to the waypoint');

      // Shift+F10 on the focused waypoint opens the same menu below it; Stop here is one Undo step.
      await key('F10', ['shift']);
      await wait(() => menuState(), w + ': Shift+F10 opens the waypoint menu');
      assert.deepEqual((await menuState()).items, menu.items, w + ': keyboard and pointer menus match');
      await key('Down'); await key('Enter');
      await wait(() => evaluate((wp) => !document.querySelector('.ctxmenu') && document.querySelector(wp)?.classList.contains('stop') && document.activeElement?.matches(wp), wp), w + ': Stop here stops the waypoint and returns focus');
      await key('F10', ['shift']);
      await wait(() => menuState(), w + ': menu reopens');
      assert.deepEqual((await menuState()).checked, ['true'], w + ': Stop here is checked');
      await key('Escape');
      await key('z', ['control']);
      await wait(() => evaluate((wp) => !document.querySelector(wp)?.classList.contains('stop'), wp), w + ': one Undo clears the stop');

      // A command chip: right-click selects it without dragging; Delete command is one Undo step.
      const chip = '.pt-chip[data-selection="em:0"]';
      const chipBefore = await evaluate((chip) => document.querySelector(chip).getAttribute('aria-label'), chip);
      await rightClick(await center(chip));
      await wait(() => menuState(), w + ': right-click opens the command menu');
      menu = await menuState();
      assert.deepEqual(menu.items, ['Open in inspector', 'Delete command'], w + ': command menu items');
      assert.ok(menu.inside, w + ': command menu inside the window');
      assert.equal(await evaluate((chip) => document.querySelector(chip).getAttribute('aria-pressed'), chip), 'true', w + ': right-click selects the command');
      assert.equal(await evaluate((chip) => document.querySelector(chip).getAttribute('aria-label'), chip), chipBefore, w + ': right-click does not move the command');
      assert.equal(await clock(), now, w + ': right-click on a chip leaves the playhead');
      await snapshot('menu-command-' + w);
      await click('.ctxmenu [role="menuitem"].danger');
      await wait(() => evaluate(() => document.querySelectorAll('.pt-chip').length === 1 && !document.querySelector('.ctxmenu')), w + ': Delete command removes the chip');
      await key('z', ['control']);
      await wait(() => evaluate(() => document.querySelectorAll('.pt-chip').length === 2), w + ': one Undo restores the command');

      // The end chip near the right edge keeps its menu in the window.
      await rightClick(await center('.pt-chip[data-selection="em:1"]'));
      await wait(() => menuState(), w + ': end chip menu');
      assert.ok((await menuState()).inside, w + ': end chip menu inside the window');
      // Open in inspector opens the inspector on the chosen command, and the menu then leaves it out.
      await click('.ctxmenu [role="menuitem"]:first-child');
      await wait(() => evaluate(() => !document.querySelector('.rail-r').classList.contains('collapsed')), w + ': Open in inspector opens the inspector');
      await delay(250);
      await rightClick(await center('.pt-chip[data-selection="em:1"]'));
      await wait(() => menuState(), w + ': command menu with the inspector open');
      assert.deepEqual((await menuState()).items, ['Delete command'], w + ': no Open in inspector while it is open');
      await key('Escape');

      // The bare lane offers its own add at the pressed time; elsewhere the native menu is left alone.
      const lanePoint = await evaluate(() => {
        const r = document.querySelector('.pt-lane').getBoundingClientRect();
        for (let x = r.left + r.width * 0.45; x < r.right; x += 6) if (document.elementFromPoint(x, r.top + r.height / 2)?.classList.contains('pt-lane')) return { x: Math.round(x), y: Math.round(r.top + r.height / 2) };
        throw Error('No bare lane');
      });
      await evaluate(() => document.querySelector('.pt-lane').focus());
      // Shift+F10 on the focused lane offers the add at the playhead. Electron's sendInputEvent cannot produce the
      // ContextMenu key, so that key is a dispatched event: it checks the handler, not native key delivery.
      await key('F10', ['shift']);
      await wait(() => menuState(), w + ': Shift+F10 on the lane');
      assert.deepEqual((await menuState()).items, ['Add command at the playhead'], w + ': keyboard lane menu');
      await key('Escape');
      await evaluate(() => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true })));
      await wait(() => menuState(), w + ': ContextMenu key on the lane');
      assert.deepEqual((await menuState()).items, ['Add command at the playhead'], w + ': ContextMenu key lane menu');
      await key('Escape');
      await rightClick(lanePoint);
      await wait(() => menuState(), w + ': right-click on the lane');
      assert.deepEqual((await menuState()).items, ['Add command here'], w + ': lane menu');
      await snapshot('menu-lane-' + w);
      await key('Escape');
      await wait(() => evaluate(() => !document.querySelector('.ctxmenu') && document.activeElement?.matches('.pt-lane')), w + ': Escape returns focus to the lane');
      await rightClick(await center('.pt-ruler'));
      assert.equal(await menuState(), null, w + ': no item menu on the ruler');
      assert.equal(await evaluate(() => window.__ctx.at(-1)), false, w + ': the ruler keeps the native default');
      results.push({ label: 'item menus ' + w, passed: true });
    }

    // Imperial units in a distance loop's description.
    await load('mixed', 'imperial');
    const distance = await evaluate(() => [...document.querySelectorAll('.pt-chip')].map((el) => el.getAttribute('aria-label')).find((text) => /loops for [\d.]+ ft/.test(text)));
    assert.ok(distance, 'distance loop described in feet');
    await snapshot('mixed-1440-imperial');

    assert.deepEqual(errors, [], 'No renderer errors');
    await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ passed: true, results }, null, 2));
    console.log('Timeline commands UI passed', JSON.stringify(results));
    app.exit(0);
  } catch (error) {
    console.error(error);
    try { await snapshot('failure'); } catch {}
    await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ passed: false, error: String(error?.stack || error), results }, null, 2)).catch(() => {});
    app.exit(1);
  }
});
