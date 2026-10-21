import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {describe,it,expect,vi} from 'vitest';
import {createUndoHistory,PROJECT_SCOPE,ROUTINE_SCOPE,pathScope,captureProjectChange,deleteFolder,applyProjectEntry,withLibraryFields} from '../src/renderer/lib/undoHistory';
import {routineState,withRoutineState,blankRoutine} from '../src/renderer/lib/editorProject';
import {blankPath} from '../src/shared/project/defaults';
import {promoteRoutineProjectSchema} from '../src/shared/project/routineSchema';
import {AUTO} from '../src/renderer/lib/routineModel';
import {referencingRoutines} from '../src/renderer/components/EditorLibrary';
import {commandArguments} from '../src/renderer/components/ContextInspector';
import {robotValueSchemasEqual} from '../src/shared/robotValueSchema';
const source=ts.createSourceFile('App.jsx',readFileSync(new URL('../src/renderer/app/App.jsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JSX);
const names=['retireDeletion','recordUndo','commitRoutineState','setRoutine','preflightDeletion','announceDeletion','undoDeletion','showPathAfterProjectChange','applyUndoEntry','commitProjectChange','delPath','deletePathFolder','deleteRoutine','stepHistory','setActiveRoutine','stepCount','branchNotice','branchIntent','deleteFeature'];
const declarations=new Map();let step,branchCapture;
function visit(node){if(ts.isVariableDeclaration(node)&&names.includes(node.name.getText(source)))declarations.set(node.name.getText(source),node.getText(source));if(ts.isVariableDeclaration(node)&&node.name.getText(source)==='acq'){const body=node.initializer.arguments[0].body.expression;step=body.properties.find(p=>p.name?.getText(source)==='del').initializer.getText(source);branchCapture=body.properties.find(p=>p.name?.getText(source)==='branch').initializer.getText(source);}ts.forEachChild(node,visit);}visit(source);
const code=names.map(name=>'const '+declarations.get(name)+';').join('\n')+'\nconst deleteStep='+step+';\nconst captureBranch=()=>'+branchCapture+'; return {'+names.join(',')+',deleteStep,captureBranch};';
const path=id=>({id,name:id,waypoints:[{x:0,y:0},{x:1,y:1}]});
const wait=id=>({id,type:'builtin',builtinId:'bordeaux.wait',arguments:{durationS:1}});
function harness(){
 const initial={schemaVersion:'1.0',name:'Test',robot:{},paths:[path('a'),path('b')],pathLinks:[],pathFolders:[{id:'f',name:'Folder'}],routines:[{id:'r',name:'First',nodes:[wait('one'),wait('two')]},{id:'s',name:'Second',nodes:[]}],activeRoutineId:'r'};
 const state={notice:null,valid:true,modal:false,scheduled:[],flush:()=>{},finish:()=>{},active:0};
 const ctx={useCallback:fn=>fn,clone:structuredClone,blankPath,blankRoutine,history:createUndoHistory(),PROJECT_SCOPE,ROUTINE_SCOPE,pathScope,captureProjectChange,deleteFolder,applyProjectEntry,withLibraryFields,routineState,withRoutineState,promoteRoutineProjectSchema,AUTO,referencingRoutines,
 projectRef:{current:initial},documentEpoch:{current:1},deletionEpoch:1,deletionAction:{current:null},deletionSequence:{current:0},projectTransitionRef:{current:null},deletionContext:{current:{page:'auto',projectKey:1}},routine:initial.routines[0],robotProjectState:{catalog:null},activeIdx:0,
 document:{activeElement:null,querySelector:()=>state.modal?{}:null,querySelectorAll:()=>[]},force:vi.fn(),setDeletionNotice:n=>{state.notice=n;},setProject:p=>{ctx.projectRef.current=typeof p==='function'?p(ctx.projectRef.current):p;},setRoutineSel:vi.fn(),setSel:vi.fn(),setActiveIdx:n=>{state.active=typeof n==='function'?n(state.active):n;},playbackStore:{reset:vi.fn()},resetForRoutine:vi.fn(),alert:vi.fn(),
 flushProjectDraft:()=>{state.flush();return state.valid;},flushSync:fn=>fn(),finishEdit:()=>state.finish(),cancelEdit:()=>false,scopeKey:PROJECT_SCOPE,commit:vi.fn(),select:vi.fn(),
 requestAnimationFrame:fn=>state.scheduled.push(fn),applyUndoEntryRef:{current:null},writeDoc:()=>{},editablePath:p=>p,
 branchGeneration:{current:0},catalogRef:{current:null},commandArguments,robotValueSchemasEqual,page:'auto',commitFocusedDraft:()=>{},setPage:vi.fn()};
 Object.defineProperty(ctx,'docRef',{get:()=>({current:ctx.projectRef.current.paths[state.active]})});
 Object.defineProperty(ctx,'routines',{get:()=>routineState(ctx.projectRef.current).routines});
 const owner=new Function('ctx','with(ctx){'+code+'}')(ctx);ctx.applyUndoEntryRef.current=owner.applyUndoEntry;
 return{ctx,state,...owner};
}
describe('actual App local deletion owners',()=>{
 it('feature deletion refuses invalid drafts before changing the path or selection',()=>{
  const h=harness(),remove=vi.fn();h.state.valid=false;
  expect(h.deleteFeature(remove)).toBe(false);expect(h.ctx.commit).not.toHaveBeenCalled();expect(h.ctx.select).not.toHaveBeenCalled();
  h.state.valid=true;expect(h.deleteFeature(remove)).toBe(true);expect(h.ctx.commit).toHaveBeenCalledExactlyOnceWith(remove);expect(h.ctx.select).toHaveBeenCalledExactlyOnceWith(null,-1);
 });
 it('moves notice-owned focus to persistent chrome before workspace replacement, without crossing a modal or unrelated owner',()=>{
  const h=harness(),noticeOwner={closest:selector=>selector==='.deletion-notice'?{}:null};
  const place={focus:vi.fn(()=>{h.ctx.document.activeElement=place;})},field={focus:vi.fn()};
  h.ctx.document.querySelector=selector=>selector.includes('dialog')?(h.state.modal?{}:null):selector.includes('.toolbar .place')?place:field;
  h.ctx.document.activeElement=noticeOwner;h.retireDeletion(true);
  expect(h.ctx.document.activeElement).toBe(place);expect(place.focus).toHaveBeenCalledOnce();expect(field.focus).not.toHaveBeenCalled();
  h.ctx.document.activeElement=noticeOwner;h.state.modal=true;h.retireDeletion(true);expect(place.focus).toHaveBeenCalledOnce();
  h.state.modal=false;h.ctx.document.activeElement={closest:()=>null};h.retireDeletion(true);expect(place.focus).toHaveBeenCalledOnce();
 });
 it('records the exact deletion entry and restores only that path after unrelated later edits',()=>{
  const h=harness();expect(h.delPath('b')).toBe(true);const notice=h.state.notice;
  expect(h.ctx.history.peekUndo([PROJECT_SCOPE])).toBe(notice.entry);
  h.recordUndo({scope:pathScope('a'),touches:[pathScope('a')],kind:'path',path:path('a')});h.ctx.projectRef.current.paths[0]={...path('a'),name:'Later name'};
  expect(notice.active).toBe(true);expect(h.undoDeletion(notice)).toBe(true);
  expect(h.ctx.projectRef.current.paths.map(p=>p.name)).toEqual(['Later name','b']);expect(notice.active).toBe(false);
  expect(h.ctx.history.canRedo([PROJECT_SCOPE])).toBe(true);
 });
 it('retires synchronously across newer entry and Undo in the same turn',()=>{
  const h=harness();h.delPath('b');const old=h.state.notice;
  h.recordUndo({scope:PROJECT_SCOPE,touches:[],kind:'folder',restore:{folder:{id:'other'},index:0,memberIds:[]}});
  expect(old.active).toBe(false);h.ctx.history.undo([PROJECT_SCOPE],e=>e);
  expect(h.ctx.history.peekUndo([PROJECT_SCOPE])).toBe(old.entry);expect(h.undoDeletion(old)).toBe(false);
 });
 it('blocks an older routine notice after a later path deletion, but permits unrelated path geometry',()=>{
  const h=harness();h.deleteRoutine('s');const old=h.state.notice;
  h.recordUndo({scope:pathScope('a'),touches:[pathScope('a')],kind:'path',path:path('a')});expect(old.active).toBe(true);
  h.delPath('b');expect(old.active).toBe(false);expect(h.undoDeletion(old)).toBe(false);
 });
 it('preserves a moved folder member on Undo and records no missing-target changes',()=>{
  const h=harness();h.ctx.projectRef.current.paths[1].folderId='f';h.deletePathFolder('f');const notice=h.state.notice;
  h.ctx.projectRef.current.pathFolders.push({id:'new',name:'New'});h.ctx.projectRef.current.paths[1].folderId='new';
  expect(h.undoDeletion(notice)).toBe(true);expect(h.ctx.projectRef.current.paths[1].folderId).toBe('new');
  const count=h.ctx.history.size.past;expect(h.deletePathFolder('missing')).toBe(false);expect(h.ctx.history.size.past).toBe(count);
 });
 it('keeps invalid drafts, modal/transition/project boundaries and postflush target removal inert',()=>{
  const h=harness();h.state.valid=false;expect(h.delPath('b')).toBe(false);expect(h.ctx.history.size.past).toBe(0);
  h.state.valid=true;h.state.modal=true;expect(h.deleteRoutine('s')).toBe(false);h.state.modal=false;
  h.ctx.projectTransitionRef.current={};expect(h.deletePathFolder('f')).toBe(false);h.ctx.projectTransitionRef.current=null;
  h.state.flush=()=>{h.ctx.projectRef.current.paths=h.ctx.projectRef.current.paths.filter(p=>p.id!=='b');};expect(h.delPath('b')).toBe(false);
  h.ctx.documentEpoch.current++;expect(h.deleteRoutine('s')).toBe(false);expect(h.ctx.history.size.past).toBe(0);
 });
 it('rechecks notice eligibility after a valid draft records a conflicting edit',()=>{
  const h=harness();h.deleteRoutine('s');const old=h.state.notice;
  h.state.finish=()=>h.recordUndo({scope:ROUTINE_SCOPE,touches:[ROUTINE_SCOPE],kind:'routines',state:structuredClone(routineState(h.ctx.projectRef.current))});
  expect(h.undoDeletion(old)).toBe(false);expect(old.active).toBe(false);expect(h.ctx.projectRef.current.routines).toHaveLength(1);
 });
 it('retains the referenced-path guard',()=>{
  const h=harness();h.ctx.projectRef.current.routines[0].nodes=[{id:'ref',type:'path',ref:'b'}];expect(h.delPath('b')).toBe(false);expect(h.ctx.alert).toHaveBeenCalledOnce();
  expect(h.ctx.history.size.past).toBe(0);
 });
 it('deletes the last path with an undoable empty replacement',()=>{
  const h=harness();h.ctx.projectRef.current.paths=[path('a')];
  expect(h.delPath('a')).toBe(true);const replacement=structuredClone(h.ctx.projectRef.current.paths);
  expect(replacement).toHaveLength(1);expect(replacement[0].id).not.toBe('a');expect(replacement[0].waypoints).toEqual([]);
  h.stepHistory('undo')();expect(h.ctx.projectRef.current.paths).toEqual([path('a')]);
  h.stepHistory('redo')();expect(h.ctx.projectRef.current.paths).toEqual(replacement);
 });
 it('deletes the last routine with an undoable empty replacement',()=>{
  const h=harness();h.ctx.scopeKey=ROUTINE_SCOPE;h.ctx.projectRef.current.routines=[h.ctx.projectRef.current.routines[0]];const original=structuredClone(h.ctx.projectRef.current.routines);
  expect(h.deleteRoutine('r')).toBe(true);const replacement=structuredClone(h.ctx.projectRef.current.routines);
  expect(replacement).toHaveLength(1);expect(replacement[0].id).not.toBe('r');expect(replacement[0].nodes).toEqual([]);
  h.stepHistory('undo')();expect(h.ctx.projectRef.current.routines).toEqual(original);
  h.stepHistory('redo')();expect(h.ctx.projectRef.current.routines).toEqual(replacement);
 });
 it('computes routine updates once outside replayable setters and preserves queued unrelated project fields',()=>{
  const h=harness(),update=vi.fn(state=>({...state,routines:state.routines.map(r=>r.id==='s'?{...r,name:'Renamed'}:r)}));
  h.ctx.setProject=setter=>{const pending={...h.ctx.projectRef.current,paths:[{...path('a'),name:'Pending path name'},path('b')]};
   const first=setter(pending),replayed=setter(pending);expect(replayed).toEqual(first);h.ctx.projectRef.current=replayed;};
  const entry=h.commitRoutineState(update);expect(update).toHaveBeenCalledOnce();expect(h.ctx.history.size.past).toBe(1);
  expect(entry.state.routines[1].name).toBe('Second');expect(h.ctx.projectRef.current.paths[0].name).toBe('Pending path name');
 });
 it('keeps generated fallback descendants read-only and a modal opened by preflight blocks deletion',()=>{
  const h=harness();h.ctx.routine.nodes=[{id:'gen',type:'generatedTrajectory',generatorId:'drive',arguments:{},fallback:{type:'branch',nodes:[wait('fw')]}}];
  expect(h.deleteStep('fw')).toBe(false);expect(h.ctx.history.size.past).toBe(0);
  h.state.flush=()=>{h.state.modal=true;};expect(h.delPath('b')).toBe(false);expect(h.ctx.history.size.past).toBe(0);
 });
 it('does not steal a newer control focus when the scheduled neighbor focus runs',()=>{
  const h=harness();expect(h.deleteStep('one')).toBe(true);h.ctx.document.querySelectorAll=vi.fn(()=>[]);h.ctx.document.activeElement={name:'new control'};
  h.state.scheduled[0]();expect(h.ctx.document.querySelectorAll).not.toHaveBeenCalled();
 });
 it('deletes full nested steps once, restores authored subtree, rejects stale owner and guarded deferred focus',()=>{
  const h=harness();const nested={id:'loop',type:'repeat',count:2,nodes:[wait('inside'),{id:'inner',type:'repeat',count:2,nodes:[wait('deep')]}]};
  h.ctx.routine.nodes=[nested,wait('last')];const before=structuredClone(h.ctx.routine);
  expect(h.deleteStep('loop')).toBe(true);expect(h.state.notice.message).toContain('3 nested steps');const notice=h.state.notice;
  expect(h.ctx.projectRef.current.routines[0].nodes).toHaveLength(1);expect(h.deleteStep('last')).toBe(false);
  h.ctx.documentEpoch.current++;expect(()=>h.state.scheduled[0]()).not.toThrow();h.ctx.documentEpoch.current--;
  expect(h.undoDeletion(notice)).toBe(true);expect(h.ctx.projectRef.current.routines[0]).toEqual(before);
 });
});
const I32={kind:'integer',valueType:'I32'},BOTH=[ROUTINE_SCOPE,PROJECT_SCOPE];
const scanCatalog=()=>({commands:[
 {id:'scan',label:'Scan',member:'scan',parameters:[{name:'count',role:'argument',schema:{kind:'integerString',valueType:'I64'},defaultValue:'9007199254740993'},{name:'gain',role:'argument',schema:{kind:'number',valueType:'SGL'}}],
  outputs:[{name:'score',label:'Score',schema:I32,max:100},{name:'ready',label:'Ready',schema:{kind:'boolean',valueType:'Boolean'}}]},
 {id:'aim',label:'Aim',member:'aim',parameters:[{name:'turns',role:'argument',schema:I32}],outputs:[]}]});
// Route a1 holds four nested steps (repeat, decision, Exit, wait); a2 holds one.
const commandNode=()=>({id:'cmd',type:'function',cat:'command',title:'Scan',invocation:{commandId:'scan',arguments:{count:'12345678901234567890',gain:.5}},ends:{timeoutS:2,onTimeout:'endRoutine'},
 outputBranch:{output:'score',schema:{...I32},routes:[
  {id:'a1',label:'High',operator:'gte',value:50,nodes:[{id:'loop',type:'repeat',times:2,nodes:[{id:'dec',type:'decision',cond:'c',thenLabel:'Yes',elseLabel:'No',then:[{id:'exit',type:'end',scope:'repeat'}],else:[wait('deep')]}]}]},
  {id:'a2',label:'Mid',operator:'gte',value:10,nodes:[wait('mid')]},
  {id:'a3',label:'Otherwise',operator:'otherwise',nodes:[]}]}});
function branchHarness(node=commandNode()){
 const h=harness(),catalog=scanCatalog();h.ctx.projectRef.current.routines[0].nodes=[node,wait('after')];h.ctx.catalogRef.current=catalog;
 h.ctx.scopeKey=ROUTINE_SCOPE+'\n'+PROJECT_SCOPE;
 // A render captures acq.branch from the live state, as App's memo does.
 const render=()=>{const s=routineState(h.ctx.projectRef.current);h.ctx.routine=s.routines.find(r=>r.id===s.activeRoutineId);h.ctx.deletionEpoch=h.ctx.documentEpoch.current;h.ctx.robotProjectState={catalog:h.ctx.catalogRef.current};return h.captureBranch();};
 const live=()=>AUTO.findNode(routineState(h.ctx.projectRef.current).routines.find(r=>r.id==='r'),'cmd');
 return{...h,render,live,size:()=>h.ctx.history.size.past};
}
describe('actual App command branch owner',()=>{
 it('replaces a populated command with one entry, one notice and exact Undo/Redo of arguments, ends and nested routes',()=>{
  const h=branchHarness(),before=structuredClone(h.ctx.projectRef.current.routines[0]);
  const result=h.render()('cmd',{kind:'command',commandId:'aim'});
  expect(result).toMatchObject({status:'applied',removed:5});expect(h.size()).toBe(1);
  const notice=h.state.notice;expect(notice.entry).toBe(h.ctx.history.peekUndo(BOTH));expect(notice.scopes).toEqual(BOTH);
  expect(notice.message).toBe('Command changed · 5 steps');expect(notice.detail).toBe('Changed command to “Aim”. Removed 5 branch steps.');
  expect(h.live()).toMatchObject({title:'Aim',invocation:{commandId:'aim',arguments:{turns:0}},ends:{timeoutS:2,onTimeout:'endRoutine'}});expect(h.live().outputBranch).toBeUndefined();
  const after=structuredClone(h.ctx.projectRef.current.routines[0]);
  expect(h.undoDeletion(notice)).toBe(true);expect(h.ctx.projectRef.current.routines[0]).toEqual(before);
  h.stepHistory('redo')();expect(h.ctx.projectRef.current.routines[0]).toEqual(after);
  h.stepHistory('undo')();expect(h.ctx.projectRef.current.routines[0]).toEqual(before);
 });
 it('uses the exact integer-string defaults and shows no notice when nothing was removed',()=>{
  const h=branchHarness({...commandNode(),invocation:{commandId:'aim',arguments:{turns:3}},outputBranch:undefined});
  expect(h.render()('cmd',{kind:'command',commandId:'scan'})).toMatchObject({status:'applied',removed:0});
  expect(h.live().invocation).toEqual({commandId:'scan',arguments:{count:'9007199254740993',gain:0}});expect(h.state.notice).toBeNull();expect(h.size()).toBe(1);
 });
 it('keeps missing saved commands and outputs recoverable and refuses only an unavailable requested choice',()=>{
  let h=branchHarness({...commandNode(),invocation:{commandId:'gone',arguments:{}}});
  expect(h.render()('cmd',{kind:'command',commandId:'nope'}).status).toBe('refused');expect(h.size()).toBe(0);
  expect(h.render()('cmd',{kind:'command',commandId:''}).status).toBe('applied');
  expect(h.live()).toMatchObject({title:'Robot command',invocation:null});expect(h.state.notice.detail).toBe('Cleared the command. Removed 5 branch steps.');
  const missing=()=>({...commandNode(),outputBranch:{...commandNode().outputBranch,output:'gone'}});
  h=branchHarness(missing());const b=h.render();
  expect(b('cmd',{kind:'output',output:'gone'}).status).toBe('unchanged');expect(b('cmd',{kind:'rebuild'}).status).toBe('unchanged');expect(b('cmd',{kind:'output',output:'nope'}).status).toBe('refused');
  expect(h.size()).toBe(0);expect(b('cmd',{kind:'output',output:''}).status).toBe('applied');expect(h.live().outputBranch).toBeUndefined();
  h=branchHarness(missing());expect(h.render()('cmd',{kind:'output',output:'ready'}).status).toBe('applied');expect(h.live().outputBranch.routes.map(r=>r.value)).toEqual([true,false]);
 });
 it('applies output, Continue, rebuild and route removal once each with their consequence copy',()=>{
  let h=branchHarness();expect(h.render()('cmd',{kind:'output',output:'ready'})).toMatchObject({status:'applied',removed:5});
  expect([h.state.notice.message,h.state.notice.detail]).toEqual(['Output changed · 5 steps','Branching on “Ready”. Removed 5 steps from the previous routes.']);
  expect(h.live().outputBranch.routes.some(r=>['a1','a2','a3'].includes(r.id))).toBe(false);
  h=branchHarness();h.render()('cmd',{kind:'output',output:''});expect([h.state.notice.message,h.state.notice.detail]).toEqual(['Branches removed · 5 steps','Removed the output branches and 5 steps.']);
  h=branchHarness();expect(h.render()('cmd',{kind:'rebuild'}).status).toBe('unchanged');expect(h.size()).toBe(0);
  const changed=scanCatalog();changed.commands[0].outputs[0].schema={kind:'integerString',valueType:'I64'};h.ctx.catalogRef.current=changed;
  const generation=h.ctx.branchGeneration.current;expect(h.render()('cmd',{kind:'rebuild'})).toMatchObject({status:'applied',removed:5});
  expect(h.ctx.branchGeneration.current).toBe(generation+1);expect(h.live().outputBranch.schema.valueType).toBe('I64');
  expect([h.state.notice.message,h.state.notice.detail]).toEqual(['Routes rebuilt · 5 steps','Rebuilt routes for “Score”. Removed 5 branch steps.']);
  h=branchHarness();expect(h.render()('cmd',{kind:'removeRoute',routeId:'a1'})).toMatchObject({status:'applied',removed:4});
  expect([h.state.notice.message,h.state.notice.detail]).toEqual(['Route removed · 4 steps','Removed route 1 (≥ 50) and 4 steps.']);
  expect(h.live().outputBranch.routes.map(r=>r.id)).toEqual(['a2','a3']);
  for(const routeId of ['a2','a3','missing'])expect(h.render()('cmd',{kind:'removeRoute',routeId}).status).toBe('refused');expect(h.size()).toBe(1);
 });
 it('records an empty route replacement as ordinary Undo without a notice',()=>{
  const node=commandNode();node.outputBranch.routes.splice(1,0,{id:'e',label:'Empty',operator:'lt',value:1,nodes:[]});
  const h=branchHarness(node);expect(h.render()('cmd',{kind:'removeRoute',routeId:'e'})).toMatchObject({status:'applied',removed:0});
  expect(h.state.notice).toBeNull();expect(h.size()).toBe(1);h.stepHistory('undo')();expect(h.live().outputBranch.routes.map(r=>r.id)).toEqual(['a1','e','a2','a3']);
 });
 it('records nothing for unchanged choices, before any history entry',()=>{
  const node=commandNode();node.outputBranch.routes.splice(2,0,...Array.from({length:253},(_,i)=>({id:'n'+i,label:'N'+i,operator:'lt',value:i,nodes:[]})));
  const h=branchHarness(node),b=h.render();
  for(const intent of [{kind:'patchRoute',routeId:'a1',patch:{label:'High'}},{kind:'patchRoute',routeId:'a1',patch:{label:'  '}},{kind:'routeEarlier',routeId:'a1'},{kind:'addComparison'},
   {kind:'output',output:'score'},{kind:'command',commandId:'scan'},{kind:'rebuild'}])expect(b('cmd',intent).status).toBe('unchanged');
  expect(h.size()).toBe(0);expect(h.state.notice).toBeNull();
 });
 it('refuses stale owners after same-ID replacement, routine switches, catalog sync and Undo/Redo, recording nothing',()=>{
  let h=branchHarness(),old=h.render();h.ctx.documentEpoch.current++;h.ctx.projectRef.current=structuredClone(h.ctx.projectRef.current);
  for(const intent of [{kind:'patchRoute',routeId:'a1',patch:{label:'Old'}},{kind:'addComparison'},{kind:'removeRoute',routeId:'a1'}])expect(old('cmd',intent).status).toBe('refused');
  h=branchHarness();old=h.render();h.setActiveRoutine('s');h.render();h.setActiveRoutine('r');
  expect(old('cmd',{kind:'patchRoute',routeId:'a1',patch:{label:'Old'}}).status).toBe('refused');expect(old('cmd',{kind:'addComparison'}).status).toBe('refused');
  old=h.render();h.commitRoutineState(s=>({...s,activeRoutineId:'s'}));h.commitRoutineState(s=>({...s,activeRoutineId:'r'}));const switched=h.size();
  expect(old('cmd',{kind:'addComparison'}).status).toBe('refused');expect(h.size()).toBe(switched);
  h=branchHarness();old=h.render();h.ctx.catalogRef.current=structuredClone(h.ctx.catalogRef.current);
  expect(old('cmd',{kind:'patchRoute',routeId:'a1',patch:{label:'Old'}}).status).toBe('refused');expect(h.render()('cmd',{kind:'patchRoute',routeId:'a1',patch:{label:'New'}}).status).toBe('applied');
  h=branchHarness();old=h.render();h.render()('cmd',{kind:'patchRoute',routeId:'a2',patch:{label:'Forward'}});
  expect(old('cmd',{kind:'patchRoute',routeId:'a1',patch:{label:'Still owner'}}).status).toBe('applied');
  h.stepHistory('undo')();expect(h.live().outputBranch.routes[0].id).toBe('a1');
  for(const intent of [{kind:'patchRoute',routeId:'a1',patch:{label:'Old'}},{kind:'addComparison'},{kind:'removeRoute',routeId:'a2'}])expect(old('cmd',intent).status).toBe('refused');
  h.stepHistory('redo')();expect(old('cmd',{kind:'patchRoute',routeId:'a1',patch:{label:'Old'}}).status).toBe('refused');expect(h.size()).toBe(2);
 });
 it('does not revive a field callback after its output is replaced and chosen again',()=>{
  const h=branchHarness(),old=h.render();h.render()('cmd',{kind:'output',output:'ready'});h.render()('cmd',{kind:'output',output:'score'});
  const routes=h.live().outputBranch.routes.map(r=>r.id),entries=h.size();
  expect(old('cmd',{kind:'addComparison'}).status).toBe('refused');expect(old('cmd',{kind:'patchRoute',routeId:'a1',patch:{label:'Old'}}).status).toBe('refused');
  expect(h.live().outputBranch.routes.map(r=>r.id)).toEqual(routes);expect(h.size()).toBe(entries);
  const forward=h.render();h.commitRoutineState(s=>s);expect(forward('cmd',{kind:'addComparison'}).status).toBe('applied');
 });
 it('applies sequential field commits from one owner and keeps nested steps inserted after capture',()=>{
  const h=branchHarness(),b=h.render();h.state.flush=vi.fn();
  expect(b('cmd',{kind:'patchRoute',routeId:'a1',patch:{label:'One'}}).status).toBe('applied');
  expect(b('cmd',{kind:'patchRoute',routeId:'a2',patch:{value:12}}).status).toBe('applied');
  h.setRoutine(r=>AUTO.appendBranch(r,'cmd','a2',wait('inserted')));
  for(const intent of [{kind:'patchRoute',routeId:'a2',patch:{operator:'lt'}},{kind:'routeEarlier',routeId:'a2'},{kind:'addComparison'}])expect(b('cmd',intent).status).toBe('applied');
  const routes=h.live().outputBranch.routes;expect(h.state.flush).not.toHaveBeenCalled();expect(h.state.notice).toBeNull();expect(h.size()).toBe(6);
  expect(routes.map(r=>r.label)).toEqual(['Mid','One','Match','Otherwise']);expect(routes[0]).toMatchObject({operator:'lt',value:12});
  expect(routes[0].nodes.map(n=>n.id)).toEqual(['mid','inserted']);expect(routes[1].nodes[0].id).toBe('loop');
  expect(b('cmd',{kind:'patchRoute',routeId:'a1',patch:{value:101}}).status).toBe('refused');expect(b('cmd',{kind:'patchRoute',routeId:'a1',patch:{value:1.5}}).status).toBe('refused');
 });
 it('lands a valid draft first, then counts and records the replacement from live state',()=>{
  const h=branchHarness();h.render()('cmd',{kind:'patchRoute',routeId:'a1',patch:{label:'Earlier field'}});
  const c=h.render();h.state.flush=()=>{expect(c('cmd',{kind:'patchRoute',routeId:'a2',patch:{label:'Drafted'}}).status).toBe('applied');h.state.flush=()=>{};};
  expect(c('cmd',{kind:'removeRoute',routeId:'a1'})).toMatchObject({status:'applied',removed:4});expect(h.size()).toBe(3);
  expect(h.state.notice.entry).toBe(h.ctx.history.peekUndo(BOTH));expect(h.live().outputBranch.routes.map(r=>r.label)).toEqual(['Drafted','Otherwise']);
  h.stepHistory('undo')();expect(h.live().outputBranch.routes.map(r=>r.label)).toEqual(['Earlier field','Drafted','Otherwise']);
 });
 it('refuses a replacement for an invalid draft, a post-flush owner change, a removed route and read-only or non-command steps',()=>{
  let h=branchHarness();h.state.valid=false;expect(h.render()('cmd',{kind:'removeRoute',routeId:'a1'}).status).toBe('refused');expect(h.size()).toBe(0);
  expect(h.render()('cmd',{kind:'patchRoute',routeId:'a1',patch:{label:'Field'}}).status).toBe('applied');
  h=branchHarness();h.state.flush=()=>{h.ctx.catalogRef.current=structuredClone(h.ctx.catalogRef.current);};expect(h.render()('cmd',{kind:'removeRoute',routeId:'a1'}).status).toBe('refused');
  h=branchHarness();h.state.flush=()=>{h.ctx.branchGeneration.current++;};expect(h.render()('cmd',{kind:'output',output:''}).status).toBe('refused');
  h=branchHarness();h.state.flush=()=>{h.state.flush=()=>{};h.setRoutine(r=>AUTO.update(r,'cmd',{outputBranch:{...commandNode().outputBranch,routes:commandNode().outputBranch.routes.slice(1)}}));};
  expect(h.render()('cmd',{kind:'removeRoute',routeId:'a1'}).status).toBe('refused');expect(h.size()).toBe(1);expect(h.state.notice).toBeNull();
  h=branchHarness();h.ctx.projectRef.current.routines[0].nodes.push({id:'gen',type:'generatedTrajectory',generatorId:'drive',arguments:{},fallback:{type:'branch',nodes:[{...commandNode(),id:'fallback-cmd'}]}});
  const b=h.render();expect(b('fallback-cmd',{kind:'removeRoute',routeId:'a1'}).status).toBe('refused');expect(b('after',{kind:'output',output:''}).status).toBe('refused');expect(h.size()).toBe(0);
 });
 it('keeps the notice ordered with later library edits and restores only routines',()=>{
  let h=branchHarness();h.render()('cmd',{kind:'removeRoute',routeId:'a1'});let notice=h.state.notice;
  h.recordUndo({scope:pathScope('a'),touches:[pathScope('a')],kind:'path',path:path('a')});h.ctx.projectRef.current.paths[0]={...path('a'),name:'Later name'};
  expect(h.undoDeletion(notice)).toBe(true);expect(h.ctx.projectRef.current.paths[0].name).toBe('Later name');expect(h.live().outputBranch.routes.map(r=>r.id)).toEqual(['a1','a2','a3']);
  h=branchHarness();h.render()('cmd',{kind:'removeRoute',routeId:'a1'});notice=h.state.notice;h.delPath('b');expect(notice.active).toBe(false);expect(h.undoDeletion(notice)).toBe(false);
 });
 it('scopes deferred focus to the result owner',()=>{
  const h=branchHarness(),result=h.render()('cmd',{kind:'removeRoute',routeId:'a1'});expect(result.current()).toBe(true);
  h.render()('cmd',{kind:'patchRoute',routeId:'a2',patch:{label:'Later'}});expect(result.current()).toBe(false);
  const other=h.render()('cmd',{kind:'patchRoute',routeId:'a2',patch:{label:'Again'}});h.ctx.deletionContext.current.page='plan';expect(other.current()).toBe(false);
 });
 it('keeps a same-value choice as an owner-checked no-op whose deferred focus ends with any later owner change',()=>{
  let h=branchHarness();h.state.flush=vi.fn();
  const kept=h.render()('cmd',{kind:'keep'});
  expect(kept).toMatchObject({status:'unchanged',removed:0});expect(kept.current()).toBe(true);
  expect(h.state.flush).not.toHaveBeenCalled();expect(h.size()).toBe(0);expect(h.state.notice).toBeNull();
  for(const intent of [{kind:'command',commandId:'scan'},{kind:'output',output:'score'},{kind:'rebuild'},{kind:'patchRoute',routeId:'a1',patch:{label:'High'}}])expect(h.render()('cmd',intent).current()).toBe(true);
  expect(h.size()).toBe(0);
  // A forward replacement keeps node.id, so only the result's owner tells the old dismissal from the new owner.
  const applied=h.render()('cmd',{kind:'output',output:'ready'});expect(kept.current()).toBe(false);expect(applied.current()).toBe(true);
  const forward=h.render()('cmd',{kind:'keep'});h.stepHistory('undo')();expect(applied.current()).toBe(false);expect(forward.current()).toBe(false);
  const restored=h.render()('cmd',{kind:'keep'});h.stepHistory('redo')();expect(restored.current()).toBe(false);
  const switched=h.render()('cmd',{kind:'keep'});h.setActiveRoutine('s');h.render();h.setActiveRoutine('r');expect(switched.current()).toBe(false);
  const synced=h.render()('cmd',{kind:'keep'});h.ctx.projectTransitionRef.current={};expect(synced.current()).toBe(false);h.ctx.projectTransitionRef.current=null;
  // A stale owner's same-value choice is refused, as its other intents are, and carries no owner to focus for.
  const old=h.render();h.ctx.catalogRef.current=structuredClone(h.ctx.catalogRef.current);
  expect(old('cmd',{kind:'keep'})).toEqual({status:'refused',removed:0});
  h=branchHarness();h.ctx.projectRef.current.routines[0].nodes.push({id:'gen',type:'generatedTrajectory',generatorId:'drive',arguments:{},fallback:{type:'branch',nodes:[{...commandNode(),id:'fallback-cmd'}]}});
  expect(h.render()('fallback-cmd',{kind:'keep'})).toEqual({status:'refused',removed:0});
 });
 it('restores routine history synchronously so consecutive steps before render invert exactly and keep queued project changes',()=>{
  const h=branchHarness(),queue=[];let state=h.ctx.projectRef.current;
  h.ctx.setProject=update=>queue.push(update);
  const render=()=>{state=queue.splice(0).reduce((value,update)=>typeof update==='function'?update(value):update,state);h.ctx.projectRef.current=state;};
  const rename=name=>h.commitRoutineState(s=>({...s,routines:s.routines.map(r=>r.id==='s'?{...r,name}:r)}));
  const names=()=>routineState(h.ctx.projectRef.current).routines[1].name;
  rename('One');rename('Two');render();h.ctx.setProject(p=>({...p,paths:p.paths.map(x=>x.id==='a'?{...x,name:'Queued'}:x)}));
  const generation=h.ctx.branchGeneration.current;
  h.stepHistory('undo')();expect(names()).toBe('One');h.stepHistory('undo')();expect(names()).toBe('Second');
  h.stepHistory('redo')();expect(names()).toBe('One');h.stepHistory('redo')();expect(names()).toBe('Two');expect(h.ctx.branchGeneration.current).toBe(generation+4);
  render();expect(state.paths[0].name).toBe('Queued');expect(routineState(state).routines[1].name).toBe('Two');
 });
});
