import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/renderer/styles/app.css';
import '../src/renderer/styles/inspector-refresh.css';
import { ProjectChip } from '../src/renderer/components/ProjectChip';
import { CommandParameterEditor } from '../src/renderer/components/ContextInspector';
import { UI } from '../src/renderer/components/ui';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const results = [], root = createRoot(document.getElementById('root'));
let props, calls;
const assert = (value, message) => { if (!value) throw new Error(message); };
window.__labviewNativeEvents = []; window.__labviewBlurs = []; window.__labviewErrors = [];
window.addEventListener('blur', () => { if (window.__labviewFocusArmed) window.__labviewBlurs.push(performance.now()); });
window.addEventListener('error', event => window.__labviewErrors.push(String(event.error?.stack || event.message)));
window.addEventListener('unhandledrejection', event => window.__labviewErrors.push(String(event.reason?.stack || event.reason)));
for (const type of ['pointerdown', 'pointerup', 'keydown', 'keyup', 'input']) window.addEventListener(type, event => window.__labviewNativeEvents.push({ type, trusted: event.isTrusted, key: event.key, focused: document.hasFocus() }), true);
async function native(request) { await new Promise(resolve => { window.__pushUiRequest = request; window.__finishPushUiRequest = () => { window.__pushUiRequest = null; resolve(); }; }); }
const button = label => [...document.querySelectorAll('button')].find(item => item.textContent === label || item.getAttribute('aria-label') === label || item.querySelector('span')?.textContent === label);
async function pointer(label) {
  const element = typeof label === 'string' ? button(label) : label; assert(element && !element.disabled, 'Enabled target ' + label);
  element.scrollIntoView({ block: 'nearest' }); const box = element.getBoundingClientRect();
  const point = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  assert(element.contains(document.elementFromPoint(point.x, point.y)), 'Visible hit target');
  await act(async () => native({ pointer: point }));
}
async function key(key) { await act(async () => native({ key })); }
async function ready(predicate, label) { for (let i = 0; i < 100; i++) { if (predicate()) return; await act(async () => new Promise(resolve => setTimeout(resolve, 20))); } throw new Error('Timed out: ' + label); }
const catalog = { projectName: 'Competition robot 2468 — autonomous command project', commands: [{ id: 'shoot', label: 'Shoot game piece' }], conditions: [{ id: 'loaded', label: 'Loaded' }], authoritative: false, warnings: ['Fixture discovery warning: one reference could not be resolved.'], labviewDiscovery: { projectFile: 'Robot/Competition robot and command library.lvproj', viCount: 43, targets: [{ name: 'roboRIO' }], items: Array.from({ length: 43 }, (_, i) => ({ name: 'Command ' + i + '.vi', file: 'Commands/Autonomous/Command ' + i + '.vi', target: 'roboRIO', projectPath: 'Commands/' + i, status: 'present' })), inspection: { commandCount: 1, reason: 'Using saved command inputs in this platform fixture.', unsupported: [] } } };
function Harness() {
  const [command, setCommand] = React.useState('shoot'), [speed, setSpeed] = React.useState(2400);
  return <div style={{height:'100vh',display:'flex',flexDirection:'column',background:'var(--bg-1)'}}>
    <header className="toolbar"><ProjectChip name="Component fixture project" folderPath="/fixture/Component project" status="saved"
      robotCode={{...props,name:props.catalog?.projectName,commands:props.catalog?.commands.length}}
      actions={{projects:()=>calls.push('projects'),create:()=>calls.push('new'),save:()=>calls.push('save'),saveCopy:()=>calls.push('copy'),linkCode:()=>calls.push('link'),refreshCode:()=>calls.push('refresh'),rescanCode:()=>calls.push('rescan'),recentCode:id=>calls.push(id),buildCode:()=>calls.push('build')}} /></header>
    <div style={{display:'flex',flex:1,minHeight:0}}><main style={{flex:1,padding:32,color:'var(--txt-3)'}}><h2>Robot code component verification</h2><p>Actual ProjectChip, lazy Sources and command controls; explicit callback and platform fixtures. This is not the full App.</p></main>
      <aside className="ctxinsp inspector-refresh"><div className="ctxinsp-hd"><span className="ctxinsp-t">Intake command</span></div><div className="ctxinsp-body">
        <UI.ChoiceBrowser id="fixture-command" label="Command" value={command} items={[{value:'shoot',label:'Shoot game piece',meta:'Target speed'}]} onChoose={value=>{setCommand(value);return {status:'applied',current:()=>true};}} />
        <CommandParameterEditor id="fixture-speed" label="Target speed" schema={{kind:'number',valueType:'DBL'}} parameter={{name:'speed',role:'argument'}} value={speed} onChange={setSpeed}/>
      </div></aside>
    </div></div>;
}
async function render() { await act(async () => root.render(<Harness/>)); }
async function mount(platform='win32', linked=true) {
  await act(async()=>root.render(null)); window.bordeauxAPI={platform}; calls=[];
  props={catalog:linked?structuredClone(catalog):null,bookmarkId:'current',operation:null,status:linked?'ready':'unlinked',error:'',recentProjects:[{id:'other',projectName:'Practice robot with a very long descriptive project name',folderName:'C:/Robots/Practice Robot',lastLinkedAt:'2026-10-15T12:00:00.000Z'}]}; await render();
}
async function menu() { if (!document.querySelector('#project-menu')) await pointer(document.querySelector('.project-chip')); }
async function test(name, fn) { try { await fn(); results.push({name,ok:true}); } catch(error) { results.push({name,ok:false,error:error.message}); } }
await test('Unlinked chip exposes the explicit Link action', async()=>{
  await mount('win32',false); await menu(); assert(document.querySelector('.project-menu-code').textContent.includes('Not linked'),'Unlinked fact');
  await pointer('Link robot code…'); assert(calls[0]==='link','Link callback'); assert(!document.querySelector('.labview-project-panel'),'No retired panel'); await menu(); await native({capture:'unlinked'});
});
await test('Windows platform fixture retains Change and Refresh with keyboard focus return', async()=>{
  await mount(); props.catalog.labviewDiscovery.inspection.status='available'; props.catalog.labviewDiscovery.inspection.reason="Live inspection only; no saved-source cache: NI did not provide the inspection instance's saved-state metadata; NI did not provide VI saved-state metadata"; await render(); await menu();
  assert(!document.querySelector('#project-menu').textContent.includes('Live inspection only'),'Successful live inspection stays quiet');
  await pointer('Refresh commands'); assert(calls[0]==='refresh','Refresh callback'); assert(document.activeElement.matches('.project-chip'),'Refresh returns chip focus');
  await key('ArrowDown'); await ready(()=>!!document.querySelector('#project-menu'),'chip keyboard open'); await key('End'); await key('Home'); await key('Escape'); assert(document.activeElement.matches('.project-chip'),'Escape returns chip');
  await menu(); await pointer('Change robot code…'); assert(calls[1]==='link','Change callback'); await menu(); assert(document.querySelector('.project-menu-code').textContent.includes(catalog.projectName),'Cancel fixture retains code'); await native({capture:'windows-ready'});
  await pointer('Rescan command inputs'); assert(calls[2]==='rescan','Explicit NI rescan callback');
  await menu(); await pointer('View sources…'); await ready(()=>!!document.querySelector('dialog.robot-code-sources[open]'),'live inspection Sources'); assert(document.querySelector('.robot-code-sources').textContent.includes('Live inspection only'),'Sources retains the diagnostic'); await native({capture:'live-sources'}); await key('Escape');
});
await test('Loading and build progress disable their actual competing actions', async()=>{
  await mount(); props.status='loading'; props.operation='scan'; await render(); await menu(); assert(button('Link robot code…').disabled,'Loading Link disabled'); assert(document.querySelector('.project-menu-code [aria-busy="true"]'),'Busy code status'); await native({capture:'syncing'});
  props.status='ready'; props.operation='build'; await render(); assert(button('Refresh commands').disabled&&button('Build catalog for conditions').disabled,'Build actions disabled'); assert(document.querySelector('#project-menu').textContent.includes('Building command catalog…'),'Build progress');
  props.operation='refresh'; await render(); assert(button('Change robot code…').disabled&&button('Refresh commands').disabled&&button('View sources…'),'Refresh keeps linked rows, disabled'); assert(document.querySelector('.project-menu-code').textContent.includes('Loading…'),'Refresh progress');
});
await test('Failure keeps the fact and a usable Refresh retry', async()=>{
  await mount(); props.status='stale'; props.error='LabVIEW is not running. Open the robot project in LabVIEW, then refresh commands.'; await render(); await menu(); assert(document.querySelector('#project-menu [role="alert"]'),'Visible code error'); assert(!button('Refresh commands').disabled,'Refresh retry enabled'); await native({capture:'sync-error'}); await pointer('Refresh commands'); assert(calls[0]==='refresh','Retry callback');
});
await test('Recent code includes visible accessible folder metadata', async()=>{
  await mount(); await menu(); await pointer('Recent robot code'); const recent=button(props.recentProjects[0].projectName);
  assert(recent.textContent.includes(props.recentProjects[0].folderName),'Visible folder'); assert(recent.getAttribute('aria-label').includes(props.recentProjects[0].folderName),'Accessible folder'); await native({capture:'recent-projects'});
  await pointer(recent); assert(calls[0]==='other','Recent ID callback');
});
await test('Lazy Sources supports pagination, native search, Escape clearing then close and chip focus', async()=>{
  await mount(); await menu(); await pointer('View sources…'); await ready(()=>!!document.querySelector('dialog.robot-code-sources[open]'),'lazy Sources modal');
  assert(document.activeElement===document.querySelector('.robot-code-sources input'),'Sources opens on search');
  assert(document.querySelectorAll('.labview-source-row').length===40,'Initial pagination'); assert(document.querySelector('.labview-source-warnings'),'Warnings'); await native({capture:'project-sources'});
  await pointer('Show more sources (3 remaining)'); assert(document.querySelectorAll('.labview-source-row').length===43,'Remaining sources');
  await pointer(document.querySelector('.robot-code-sources input')); await act(async()=>native({text:'unmatched'}));
  assert(document.querySelector('.labview-source-list').textContent.includes('No sources match'),'Native search empty'); await key('Escape'); assert(document.querySelector('.robot-code-sources input').value==='','Escape clears query'); assert(document.querySelector('dialog[open]'),'First Escape retains modal');
  await key('Tab'); assert(document.activeElement.classList.contains('labview-source-list'),'Tab reaches source list'); await pointer(document.querySelector('.robot-code-sources input')); await key('Escape');
  assert(!document.querySelector('.robot-code-sources')&&document.activeElement.matches('.project-chip'),'Second Escape closes and returns focus');
});
await test('Mac platform fixture retains saved inputs, Refresh and existing command controls', async()=>{
  await mount('darwin'); await menu(); assert(!document.querySelector('#project-menu').textContent.includes('Using saved command inputs'),'Successful saved inputs stay quiet'); await pointer('Refresh commands'); assert(calls[0]==='refresh','Mac fixture Refresh callback');
  await pointer(document.querySelector('.choice-change')); assert(document.querySelector('#fixture-command'),'Actual command browser opens'); await key('Escape'); await pointer(document.querySelector('#fixture-speed')); assert(document.activeElement.id==='fixture-speed','Actual parameter editor reachable'); await native({capture:'mac-ready'});
});
await act(async()=>root.render(<pre id="verification-report">{JSON.stringify(results,null,2)}</pre>));
