const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = process.env.BORDEAUX_INTERFACE_UI_OUTPUT;
app.setPath('userData', path.join(output, 'user-data'));
let win;
const errors = [], checks = [];
const delay = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const evaluate = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`, true);
async function wait(fn, label) { for (let i = 0; i < 100; i++) { if (await fn()) return; await delay(50); } throw Error('Timed out: ' + label); }
async function click(selector, text) {
  const p = await evaluate((selector, text) => {
    const el = [...document.querySelectorAll(selector)].find((el) => !text || el.textContent.trim() === text);
    if (!el || el.disabled) throw Error('Missing control ' + selector);
    el.scrollIntoView({ block: 'nearest' });
    const r = el.getBoundingClientRect(), x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
    if (!el.contains(document.elementFromPoint(x, y))) throw Error('Obscured ' + selector);
    return { x, y };
  }, selector, text);
  win.webContents.sendInputEvent({ type: 'mouseDown', ...p, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', ...p, button: 'left', clickCount: 1 }); await delay();
}
async function key(keyCode, modifiers = []) { win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); if (keyCode === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await delay(); }
async function replace(text) { await key('Home'); await key('End', ['shift']); await win.webContents.insertText(text); await delay(); }
async function snap(name) { await fs.writeFile(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
const check = (name) => { checks.push(name); console.log('PASS ' + name); };
async function openSearchChoice() {
  await click('#search-choice');
  await wait(() => evaluate(() => document.activeElement.id === 'search-choice-search'), 'search choice autofocus');
}
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ show: true, width: 1440, height: 900, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
    win.webContents.on('console-message', (d) => { if (d.level === 'error' && !d.message.startsWith("Loading the font 'data:")) errors.push(d.message); });
    await win.loadFile(path.join(output, 'dist/index.html')); await delay(250);
    if (process.platform === 'darwin') app.focus({ steal: true });
    win.focus(); win.webContents.focus();
    // Losing native focus blurs the field and withholds focus events, which changes draft commits.
    await evaluate(() => { window.trustedBlurs = 0; window.addEventListener('blur', (event) => { if (event.isTrusted) window.trustedBlurs++; }); });
    await openSearchChoice(); await win.webContents.insertText('Option 10'); await key('Down');
    assert.equal(await evaluate(() => document.activeElement.id), 'search-choice-search');
    assert.equal(await evaluate(() => document.querySelector('.cmd-picker-option.active').dataset.value), '100');
    await win.webContents.insertText('1'); await key('Down'); await key('Enter');
    assert.equal(await evaluate(() => document.querySelector('#search-choice-value').textContent), 'Option 101');
    assert.equal(await evaluate(() => document.activeElement.id), 'search-choice');
    check('Search retains caret across arrow navigation and accepts the filtered result');
    await openSearchChoice(); await key('Tab');
    assert.equal(await evaluate(() => document.activeElement.id), 'search-choice-custom');
    await win.webContents.insertText('custom-result'); await key('Tab');
    assert.equal(await evaluate(() => document.activeElement.textContent), 'Use');
    await key('Enter'); assert.equal(await evaluate(() => document.querySelector('#search-choice-value').textContent), 'custom-result');
    await openSearchChoice(); await key('Tab', ['shift']);
    assert.equal(await evaluate(() => Boolean(document.querySelector('.dropdown-panel'))), false);
    check('Custom values and picker exit work with Tab and Shift+Tab');
    await click('#short-choice'); await key('End'); await key('Space');
    assert.equal(await evaluate(() => document.querySelector('#short-choice-value').textContent), 'Gamma');
    await click('#short-choice'); await key('Home'); await key('Enter');
    assert.equal(await evaluate(() => document.querySelector('#short-choice-value').textContent), 'Alpha');
    await click('#short-choice'); await key('B'); await key('Enter');
    assert.equal(await evaluate(() => document.querySelector('#short-choice-value').textContent), 'Beta');
    assert.equal(await evaluate(() => document.querySelector('#unknown-choice-value').textContent), 'retired-value');
    check('Short choices support Home/End, Space and typeahead; unavailable values remain readable');
    await click('.numlbl');
    assert.equal(await evaluate(() => document.activeElement.className), 'numinput');
    await replace('invalid'); await key('Enter');
    assert.equal(await evaluate(() => document.activeElement.getAttribute('aria-invalid')), 'true');
    await key('Escape'); await key('Enter');
    assert.equal(await evaluate(() => document.querySelector('#canonical-width').textContent), '0.8128');
    await click('#parameter'); await replace(''); await key('Enter');
    assert.equal(await evaluate(() => document.activeElement.id), 'parameter');
    assert.equal(await evaluate(() => document.activeElement.getAttribute('aria-invalid')), 'true');
    await key('Escape'); assert.equal(await evaluate(() => document.querySelector('#parameter').value), '2');
    check('Invalid Enter retains numeric focus; Escape restores the exact saved value');
    await click('#routine-command-param-amount'); await replace(''); await key('Enter');
    assert.equal(await evaluate(() => document.querySelector('#routine-command-param-amount').getAttribute('aria-invalid')), 'true');
    await click('#select-b');
    assert.equal(await evaluate(() => document.querySelector('#routine-command-param-amount').value), '2');
    assert.equal(await evaluate(() => document.querySelector('#routine-command-param-amount').getAttribute('aria-invalid')), 'false');
    check('Invalid command drafts do not leak to a different routine command');
    const scrubLabel = await evaluate(() => {
      const label = [...document.querySelectorAll('.numlbl')].find((item) => item.textContent === 'Scrub speed');
      label.scrollIntoView({ block: 'center' });
      const r = label.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), input: '#' + CSS.escape(label.htmlFor) };
    });
    // Looked up by label each time: remounting the field assigns a new input id.
    const scrubInput = () => evaluate(() => document.getElementById([...document.querySelectorAll('.numlbl')].find((item) => item.textContent === 'Scrub speed').htmlFor).value);
    const scrubOutputs = () => evaluate(() => ({ value: document.querySelector('#scrub-speed').textContent, commits: document.querySelector('#scrub-commits').textContent }));
    win.webContents.sendInputEvent({ type: 'mouseMove', x: scrubLabel.x, y: scrubLabel.y });
    win.webContents.sendInputEvent({ type: 'mouseDown', x: scrubLabel.x, y: scrubLabel.y, button: 'left', clickCount: 1 });
    for (const dx of [20, 40, 60, 80]) { win.webContents.sendInputEvent({ type: 'mouseMove', x: scrubLabel.x + dx, y: scrubLabel.y, button: 'left' }); await delay(30); }
    const liveScrub = await scrubInput();
    assert.notEqual(liveScrub, '1.00', 'The field previews the scrubbed value during the gesture');
    assert.deepEqual(await scrubOutputs(), { value: '1', commits: '0' }, 'Scrubbing does not commit until release');
    win.webContents.sendInputEvent({ type: 'mouseUp', x: scrubLabel.x + 80, y: scrubLabel.y, button: 'left', clickCount: 1 }); await delay();
    const released = await scrubOutputs();
    assert.equal(released.commits, '1', 'One scrub gesture is one change');
    assert.equal(Number(released.value).toFixed(2), liveScrub);
    win.webContents.sendInputEvent({ type: 'mouseDown', x: scrubLabel.x, y: scrubLabel.y, button: 'left', clickCount: 1 });
    for (const dx of [20, 40, 60]) { win.webContents.sendInputEvent({ type: 'mouseMove', x: scrubLabel.x + dx, y: scrubLabel.y, button: 'left' }); await delay(30); }
    await key('Escape');
    win.webContents.sendInputEvent({ type: 'mouseUp', x: scrubLabel.x + 60, y: scrubLabel.y, button: 'left', clickCount: 1 }); await delay();
    assert.deepEqual(await scrubOutputs(), released, 'Escape cancels a scrub without a change');
    assert.equal(await scrubInput(), liveScrub, 'Cancelling restores the committed value');
    check('A label scrub previews live, commits once on release, and Escape cancels it');
    // The same gestures with the field already focused, so its text draft is live during the scrub.
    await evaluate(() => { window.addEventListener('pointerdown', (event) => { window.lastPointerId = event.pointerId; }, true); });
    const scrubFocused = () => evaluate(() => document.activeElement?.id === [...document.querySelectorAll('.numlbl')].find((item) => item.textContent === 'Scrub speed').htmlFor);
    // Native focus is a precondition of every focused step: losing it blurs the field, committing its draft,
    // and withholds focus events. Each step starts focused and counts window blurs from there.
    const nativeFocus = async () => assert.deepEqual(await evaluate(() => ({ focused: document.hasFocus(), blurs: window.trustedBlurs })),
      { focused: true, blurs: 0 }, 'The harness window kept native focus (another window took it; rerun in the foreground)');
    const focusScrubInput = async () => {
      if (!await evaluate(() => document.hasFocus())) {
        if (process.platform === 'darwin') app.focus({ steal: true });
        win.focus(); win.webContents.focus();
        await wait(() => evaluate(() => document.hasFocus()), 'renderer native focus before a focused scrub');
      }
      await evaluate(() => { window.trustedBlurs = 0; });
      await nativeFocus();
      const selector = await evaluate(() => '#' + CSS.escape([...document.querySelectorAll('.numlbl')].find((item) => item.textContent === 'Scrub speed').htmlFor));
      await click(selector);
      assert.equal(await scrubFocused(), true, 'The scrub input has focus before the gesture');
    };
    const shownSpeed = async () => Number(await scrubInput()).toFixed(2);
    const scrubGesture = async (offsets, during) => {
      win.webContents.sendInputEvent({ type: 'mouseDown', x: scrubLabel.x, y: scrubLabel.y, button: 'left', clickCount: 1 });
      for (const dx of offsets) { win.webContents.sendInputEvent({ type: 'mouseMove', x: scrubLabel.x + dx, y: scrubLabel.y, button: 'left' }); await delay(30); }
      const live = await scrubInput();
      if (during) await during();
      win.webContents.sendInputEvent({ type: 'mouseUp', x: scrubLabel.x + offsets.at(-1), y: scrubLabel.y, button: 'left', clickCount: 1 }); await delay();
      return live;
    };
    const commitsSince = async (before) => Number((await scrubOutputs()).commits) - Number(before.commits);

    await focusScrubInput();
    let before = await scrubOutputs();
    const focusedLive = await scrubGesture([20, 40, 60]);
    const afterFocused = await scrubOutputs();
    assert.equal(await commitsSince(before), 1, 'A focused scrub is one change');
    assert.equal(Number(afterFocused.value).toFixed(2), focusedLive, 'Release stores the previewed value');
    assert.equal(await shownSpeed(), focusedLive, 'The focused field shows the committed scrub, not its earlier draft');
    await key('Tab');
    assert.deepEqual(await scrubOutputs(), afterFocused, 'Tab after the scrub does not commit the earlier draft');
    assert.equal(await shownSpeed(), focusedLive);
    check('Focused scrub then Tab: one change, and the field keeps the scrubbed value');

    // A cancelled scrub leaves the focused field showing its rounded stored value without a draft.
    // The next scrub must start from the exact stored value and add exactly one change.
    await focusScrubInput(); await replace('2.345'); await key('Enter');
    assert.equal((await scrubOutputs()).value, '2.345', 'Enter commits the exact typed value');
    await focusScrubInput();
    before = await scrubOutputs();
    await scrubGesture([20, 40], () => key('Escape'));
    assert.deepEqual(await scrubOutputs(), before, 'Escape cancels the scrub without a change');
    assert.equal(await scrubFocused(), true, 'The field keeps focus after the cancelled scrub');
    assert.equal(await shownSpeed(), Number(before.value).toFixed(2), 'The focused field shows the rounded stored value');
    await scrubGesture([20, 40]);
    assert.equal(await commitsSince(before), 1, 'The next focused scrub is one change; the rounded display is not committed');
    const sensitivity = 0.01 * 8;
    assert.equal(Number((await scrubOutputs()).value), Math.round((Number(before.value) + 40 * sensitivity) / 0.01) * 0.01, 'The scrub starts from the stored value, not its rounded display');
    await click('#save-drafts');
    assert.equal(await commitsSince(before), 1, 'Save after the scrub adds nothing');
    check('A scrub after a cancelled focused scrub starts from the stored value: one change, and Save adds nothing');

    await focusScrubInput();
    before = await scrubOutputs();
    const savedLive = await scrubGesture([-20, -40]);
    const afterSaved = await scrubOutputs();
    assert.equal(await commitsSince(before), 1);
    assert.equal(Number(afterSaved.value).toFixed(2), savedLive);
    await click('#save-drafts');
    assert.equal(await scrubFocused(), false, 'Save flushes the focused draft');
    assert.deepEqual(await scrubOutputs(), afterSaved, 'Save after the scrub does not commit the earlier draft');
    assert.equal(await shownSpeed(), savedLive);
    check('Focused scrub then Save: one change, and Save adds nothing');

    await focusScrubInput(); await replace('2');
    await nativeFocus();
    before = await scrubOutputs();
    await scrubGesture([20, 40]);
    assert.equal(await commitsSince(before), 2, 'A typed draft commits before the scrub that replaces it');
    assert.equal(Number((await scrubOutputs()).value).toFixed(2), '5.20', 'The scrub starts from the committed draft');
    assert.equal(await shownSpeed(), '5.20');
    await click('#save-drafts');
    assert.equal(await commitsSince(before), 2);
    check('A typed draft commits once, then the scrub continues from it');

    await focusScrubInput();
    before = await scrubOutputs();
    const tabbedLive = await scrubGesture([20, 40], () => key('Tab'));
    const afterTabbed = await scrubOutputs();
    assert.equal(await commitsSince(before), 1, 'Tab during the scrub neither commits the preview nor adds a change');
    assert.equal(Number(afterTabbed.value).toFixed(2), tabbedLive);
    assert.equal(await shownSpeed(), tabbedLive);
    await click('#save-drafts');
    assert.deepEqual(await scrubOutputs(), afterTabbed);
    check('Tab during a scrub leaves exactly the released change');

    // Enter while the pointer is still captured must not commit the preview early.
    const enterDuringScrub = (afterEnter) => async () => {
      const pending = await scrubOutputs(), preview = await scrubInput();
      await key('Enter');
      assert.deepEqual(await scrubOutputs(), pending, 'Enter during a captured scrub commits nothing');
      assert.equal(await scrubInput(), preview, 'Enter keeps the pending scrub preview');
      assert.equal(await scrubFocused(), true, 'Enter during a scrub does not end the field edit');
      if (afterEnter) await afterEnter();
    };
    await focusScrubInput();
    before = await scrubOutputs();
    const enteredLive = await scrubGesture([20, 40, 60], enterDuringScrub());
    const afterEntered = await scrubOutputs();
    assert.equal(await commitsSince(before), 1, 'Enter then release is exactly one change');
    assert.equal(Number(afterEntered.value).toFixed(2), enteredLive, 'Release stores the previewed value');
    assert.notEqual(afterEntered.value, before.value);
    assert.equal(await shownSpeed(), enteredLive);
    await key('Enter');
    assert.deepEqual(await scrubOutputs(), afterEntered, 'Enter after release adds nothing');
    await click('#save-drafts');
    assert.deepEqual(await scrubOutputs(), afterEntered, 'Save after Enter and release adds nothing');
    await focusScrubInput();
    before = await scrubOutputs();
    await scrubGesture([20, 40], enterDuringScrub(() => key('Escape')));
    assert.deepEqual(await scrubOutputs(), before, 'Enter then Escape discards the scrub');
    assert.equal(await shownSpeed(), Number(before.value).toFixed(2), 'Enter then Escape restores the stored value');
    await click('#save-drafts');
    assert.deepEqual(await scrubOutputs(), before, 'Save after Enter then Escape adds nothing');
    check('Enter during a captured scrub defers to release (one change) or Escape (no change)');

    const cancellations = [
      ['Tab then Escape', async () => { await key('Tab'); await key('Escape'); }],
      ['window blur', () => evaluate(() => { window.dispatchEvent(new Event('blur')); })],
      ['pointer cancellation', () => evaluate(() => { window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: window.lastPointerId })); })],
      ['Escape', () => key('Escape')],
    ];
    for (const [name, cancel] of cancellations) {
      await focusScrubInput();
      before = await scrubOutputs();
      await scrubGesture([20, 40], cancel);
      assert.deepEqual(await scrubOutputs(), before, name + ' discards a focused scrub');
      assert.equal(await shownSpeed(), Number(before.value).toFixed(2), name + ' restores the stored value');
      await click('#save-drafts');
      assert.deepEqual(await scrubOutputs(), before, 'Save after ' + name + ' adds nothing');
    }
    await focusScrubInput();
    before = await scrubOutputs();
    await scrubGesture([20, 40], () => evaluate(() => { document.querySelector('#toggle-scrub').click(); }));
    assert.equal(await evaluate(() => [...document.querySelectorAll('.numlbl')].some((item) => item.textContent === 'Scrub speed')), false);
    assert.deepEqual(await scrubOutputs(), before, 'Unmounting the field discards its scrub');
    await click('#toggle-scrub');
    assert.equal(await shownSpeed(), Number(before.value).toFixed(2));
    check('Escape, Tab+Escape, window blur, pointer cancellation, and unmount discard a focused scrub');
    const draftState = () => evaluate(() => ({ value: document.querySelector('#draft-name').value, names: JSON.parse(document.querySelector('#draft-names').textContent), commits: Number(document.querySelector('#name-commits').textContent), focused: document.activeElement.id === 'draft-name' }));
    await click('#draft-name'); await replace('Intake roller');
    assert.deepEqual(await draftState(), { value: 'Intake roller', names: { a: 'Intake', b: 'Shooter' }, commits: 0, focused: true }, 'Typing stays a local draft');
    await key('Escape');
    assert.deepEqual(await draftState(), { value: 'Intake', names: { a: 'Intake', b: 'Shooter' }, commits: 0, focused: true }, 'Escape restores the saved name and keeps focus');
    await replace('Intake roller'); await key('Enter');
    assert.deepEqual(await draftState(), { value: 'Intake roller', names: { a: 'Intake roller', b: 'Shooter' }, commits: 1, focused: true }, 'Enter commits one change');
    await replace('Intake 2'); await click('#owner-b');
    assert.deepEqual(await draftState(), { value: 'Shooter', names: { a: 'Intake 2', b: 'Shooter' }, commits: 2, focused: false }, 'Leaving the field commits the draft to its owner');
    await click('#draft-name'); await replace('Shooter 2'); await click('#owner-a-field');
    assert.deepEqual(await draftState(), { value: 'Intake 2', names: { a: 'Intake 2', b: 'Shooter 2' }, commits: 3, focused: false }, 'A focus-preserving selection commits before switching owners');
    await click('#draft-name'); await replace('Leaked'); await click('#owner-b-raw');
    assert.deepEqual((await draftState()).value, 'Shooter 2', 'An uncommitted draft never appears on another owner');
    await click('#select-a');
    assert.deepEqual(await draftState(), { value: 'Shooter 2', names: { a: 'Intake 2', b: 'Shooter 2' }, commits: 3, focused: false }, 'A dropped draft is not committed later');
    check('Text drafts commit once on Enter or blur, Escape restores, and drafts never move between owners');
    // Opt-in first-match choosers (command placement): mount-only open, typed first match, inert bare/held/no-match Enter.
    const firstMatch = () => evaluate(() => ({ active: document.activeElement.id || document.activeElement.className, open: Boolean(document.querySelector('.dropdown-panel')),
      expanded: document.querySelector('#first-match-choice').getAttribute('aria-expanded'), option: document.querySelector('.dropdown-panel .cmd-picker-option.active strong')?.textContent ?? null,
      picks: document.querySelector('#first-match-picks').textContent, value: document.querySelector('#first-match-value').textContent,
      caret: document.activeElement.selectionStart ?? null, length: document.activeElement.value?.length ?? null }));
    await click('#first-match-request'); await delay(150);
    assert.equal((await firstMatch()).expanded, 'false', 'A later defaultOpen prop never opens a mounted chooser');
    await click('#first-match-remount');
    await wait(async () => (await firstMatch()).active === 'first-match-choice-search', 'mount-open chooser focuses its search');
    assert.deepEqual(await firstMatch(), { ...(await firstMatch()), open: true, option: null, picks: '0' }, 'Mount-open activates nothing');
    await key('Enter'); assert.deepEqual([(await firstMatch()).open, (await firstMatch()).picks], [true, '0'], 'Bare empty-query Enter picks nothing');
    await win.webContents.insertText('in'); await delay();
    assert.equal((await firstMatch()).option, 'Start intake', 'Typing activates the first match');
    await key('Down'); assert.equal((await firstMatch()).option, 'Stop intake');
    await key('Home'); let fm = await firstMatch(); assert.deepEqual([fm.option, fm.caret, fm.active], ['Stop intake', 0, 'first-match-choice-search'], 'Home moves the caret only');
    await key('End'); fm = await firstMatch(); assert.deepEqual([fm.option, fm.caret], ['Stop intake', fm.length], 'End moves the caret only');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: ['isAutoRepeat'] }); win.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers: ['isAutoRepeat'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' }); await delay();
    assert.deepEqual([(await firstMatch()).open, (await firstMatch()).picks], [true, '0'], 'A repeated Enter never picks');
    await replace('zzz'); await key('Enter'); assert.deepEqual([(await firstMatch()).open, (await firstMatch()).picks], [true, '0'], 'No-match Enter is inert');
    await replace(''); await win.webContents.insertText(' '); await key('Enter'); assert.equal((await firstMatch()).picks, '0', 'A blank query activates nothing');
    await key('Escape'); fm = await firstMatch(); assert.deepEqual([fm.open, fm.active], [false, 'first-match-choice'], 'First Escape closes to the trigger');
    await key('Enter'); await wait(async () => (await firstMatch()).active === 'first-match-choice-search', 'reopen');
    await win.webContents.insertText('sho'); await key('Enter'); fm = await firstMatch();
    assert.deepEqual([fm.value, fm.picks, fm.active], ['Shoot note', '1', 'first-match-choice'], 'Typed first match + Enter picks once and returns focus');
    await click('#first-match-short'); await key('Down');
    assert.equal(await evaluate(() => document.activeElement.getAttribute('role')), 'option', 'Short chooser focuses its native option button');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: ['isAutoRepeat'] }); win.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers: ['isAutoRepeat'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' }); await delay();
    assert.deepEqual([(await firstMatch()).open, (await firstMatch()).picks], [true, '1'], 'A repeated Enter on a native option button never picks');
    await key('Enter'); assert.equal((await firstMatch()).picks, '2', 'A fresh Enter on the option picks');
    check('Opt-in chooser opens only at mount; typed first match picks; bare, blank, held and no-match Enter never pick; Home/End keep the caret');
    await openSearchChoice(); await win.webContents.insertText('Option 10'); await key('Down');
    await snap('controls-1440'); win.setContentSize(1100, 720); await delay(); await snap('controls-1100');
    const bounds = await evaluate(() => { const r = document.querySelector('.dropdown-panel').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: innerHeight }; });
    assert.ok(bounds.top >= 0 && bounds.bottom <= bounds.height);
    await key('Escape');
    assert.notEqual(await evaluate(() => getComputedStyle(document.querySelector('.robot-push-spinner')).animationName), 'none');
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    assert.equal(await evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
    assert.equal(await evaluate(() => getComputedStyle(document.querySelector('.robot-push-spinner')).animationName), 'none');
    await snap('reduced-motion-1100');
    check('Dropdown stays within the smaller viewport; reduced motion keeps static status');
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ checks, errors }, null, 2));
  } catch (e) {
    console.error(e, errors);
    if (win) { console.error('Native focus at failure:', await evaluate(() => ({ focused: document.hasFocus(), trustedBlurs: window.trustedBlurs, active: document.activeElement?.id || document.activeElement?.tagName })).catch(() => null)); await snap('failure'); }
    process.exitCode = 1;
  }
  finally { win?.destroy(); app.exit(process.exitCode || 0); }
});
