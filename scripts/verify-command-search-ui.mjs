import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { build } from 'vite';
import electron from 'electron';

const root = process.cwd();
const output = process.env.BORDEAUX_COMMAND_SEARCH_UI_OUTPUT ? path.resolve(process.env.BORDEAUX_COMMAND_SEARCH_UI_OUTPUT) : await fs.mkdtemp(path.join(os.tmpdir(), 'bordeaux-command-search-'));
await fs.mkdir(output, { recursive: true });
const html = path.join(output, 'index.html');
await fs.writeFile(html, `<!doctype html><html><meta charset="utf-8"><div id="root"></div><script type="module" src="${path.join(root, 'scripts/command-search-ui-harness.jsx')}"></script></html>`);
await build({ configFile: false, root: output, base: './', publicDir: false, logLevel: 'error', define: { 'process.env.NODE_ENV': JSON.stringify('production') }, build: { outDir: path.join(output, 'dist'), emptyOutDir: true, rollupOptions: { input: html } } });
const runner = path.join(output, 'runner.cjs');
await fs.writeFile(runner, `
const {app,BrowserWindow}=require('electron'),fs=require('node:fs/promises'),path=require('node:path');
const output=${JSON.stringify(output)};
app.setPath('userData',path.join(output,'profile'));
app.commandLine.appendSwitch('force-device-scale-factor','1');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-features','CalculateNativeWinOcclusion');
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1440,height:900,useContentSize:true,show:true,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false}});
 await win.loadFile(${JSON.stringify(path.join(output,'dist/index.html'))}); win.focus();
 let processing=false;
 const poll=setInterval(async()=>{
  if(processing)return; processing=true;
  try{
   const req=await win.webContents.executeJavaScript('window.__searchRequest');
   if(req){
    if(req.resize)win.setContentSize(...req.resize);
    if(req.pointer)for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,...req.pointer,button:'left',clickCount:1});
    if(req.key){const keyCode=req.key.replace(/^Arrow/,''); const modifiers=req.modifiers||[]; win.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers}); if(req.key==='Enter')win.webContents.sendInputEvent({type:'char',keyCode:'\\r',modifiers}); win.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});}
    if(req.text)await win.webContents.insertText(req.text);
    await new Promise(resolve=>setTimeout(resolve,70));
    if(req.capture){await win.webContents.executeJavaScript('document.fonts.ready');await fs.writeFile(path.join(output,req.capture+'.png'),(await win.webContents.capturePage()).toPNG());}
    await win.webContents.executeJavaScript('window.__finishSearchRequest()');
   }
   const result=await win.webContents.executeJavaScript('window.__searchResults');
   if(result){clearInterval(poll);await fs.writeFile(path.join(output,'results.json'),JSON.stringify(result,null,2));if(!result.passed)await fs.writeFile(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG());console.log(JSON.stringify(result));app.exit(result.passed?0:1);}
  }catch(error){clearInterval(poll);console.error(error);await fs.writeFile(path.join(output,'failure.txt'),String(error.stack));app.exit(1);}finally{processing=false;}
 },25);
});
`);
const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }; delete env.ELECTRON_RUN_AS_NODE;
console.log('Command search UI evidence: ' + output);
const child = spawn(electron, [...(process.env.BORDEAUX_UI_DISABLE_GPU === '1' ? ['--disable-gpu'] : []), runner], { cwd: root, env, stdio: 'inherit' });
const timer = setTimeout(() => child.kill(), 120000);
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }); clearTimeout(timer);
process.exitCode = code === 0 ? 0 : 1;
