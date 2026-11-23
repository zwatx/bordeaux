// Renders the SystemCore dashboard tile: the editor with a real project, the app icon in front.
// Run through render-systemcore-tile.mjs.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const [url, corpusFile, iconFile, outFile] = process.argv.slice(2);
app.setPath('userData', fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'bordeaux-tile-')));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ width: 1600, height: 900, useContentSize: true, show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    const evaluate = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`, true);
    const wait = async (fn, label) => { for (let i = 0; i < 300; i++) { if (await evaluate(fn).catch(() => false)) return; await delay(100); } throw new Error('Timed out: ' + label); };
    const ready = () => wait(() => Boolean(document.querySelector('.library-pick')) && !document.querySelector('.fieldcol[data-planning-ready="false"]'), 'editor');

    await win.loadURL(url); await ready();
    // Opens on a path whose curve stays visible around the icon.
    const project = JSON.parse(fs.readFileSync(corpusFile, 'utf8'));
    project.name = 'Team 2468 autos';
    project.editor = { ...project.editor, activePathId: 'corpus-blue-away-bump' };
    await evaluate((value) => window.bordeauxAPI.saveProject(value), project);
    await win.loadURL(url); await ready();
    // Planning runs a provisional pass, then a final one; capture once the duration has held for three seconds.
    for (let held = 0, last = '', tries = 0; held < 6; tries++) {
      if (tries > 240) throw new Error('Timed out: planned duration');
      await delay(500);
      const total = await evaluate(() => document.querySelector('.pt-clock[data-stale]') ? '' : document.querySelector('.pt-clock-total')?.textContent || '');
      held = Number(total) > 0 && total === last ? held + 1 : 0; last = total;
    }
    const editor = (await win.webContents.capturePage()).toDataURL();

    const icon = fs.readFileSync(iconFile).toString('base64');
    const tile = new BrowserWindow({ width: 960, height: 540, useContentSize: true, show: false, frame: false });
    await tile.loadURL('data:text/html,' + encodeURIComponent(`<body style="margin:0;width:960px;height:540px;overflow:hidden;background:#0b0b0b">
      <div style="position:absolute;inset:0;background:url(${editor}) center/cover;filter:brightness(.62)"></div>
      <img src="data:image/png;base64,${icon}" style="position:absolute;left:50%;top:50%;width:250px;height:250px;transform:translate(-50%,-50%);filter:drop-shadow(0 14px 32px rgba(0,0,0,.7))">
    </body>`));
    await delay(800);
    fs.writeFileSync(outFile, (await tile.webContents.capturePage()).resize({ width: 960, height: 540, quality: 'best' }).toPNG());
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
