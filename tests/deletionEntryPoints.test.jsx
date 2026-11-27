import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {describe,it,expect,vi} from 'vitest';
import {deletionInput,shiftDeletionInput} from '../src/renderer/components/DeletionNotice';
import {AUTO} from '../src/renderer/lib/routineModel';
import {referencingRoutines} from '../src/renderer/components/EditorLibrary';
import {routineSummary} from '../src/renderer/lib/routineSummary';
import {moveFolder,movePaths} from '../src/renderer/lib/libraryOrder';
const event=(patch={})=>({button:0,detail:1,type:'pointerdown',preventDefault:vi.fn(),stopPropagation:vi.fn(),currentTarget:{getBoundingClientRect:()=>({left:1,bottom:2})},...patch});
const source=ts.createSourceFile('EditorLibrary.jsx',readFileSync(new URL('../src/renderer/components/EditorLibrary.jsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JSX);
const component=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='EditorLibrary').getText(source);
function harness(){
 let cursor=0,props,tree;const cells=[];const doc={activeElement:{name:'invalid owner'}};
 const useState=initial=>{const c=cells[cursor++]||={value:initial};return[c.value,n=>{c.value=typeof n==='function'?n(c.value):n;}];};
 const useRef=value=>cells[cursor++]||={current:value};
 const h=(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity).filter(c=>c!==false&&c!=null)});
 const drag={drag:null,begin:vi.fn()};
 const renderFn=new Function('React','useState','useRef','useEffect','h','Icon','AUTO','referencingRoutines','deletionInput','useLibraryDrag','movePaths','moveFolder','LibraryMenu','document','requestAnimationFrame','routineSummary',component+';return EditorLibrary;')({useId:()=> 'library-test',useMemo:fn=>fn(),Fragment:'Fragment'},useState,useRef,()=>{},h,'Icon',AUTO,referencingRoutines,deletionInput,()=>drag,movePaths,moveFolder,'LibraryMenu',doc,()=>{},routineSummary);
 props={mode:'paths',prefs:{query:'',collapsed:{},scroll:0},update:vi.fn(),project:{paths:[{id:'a',name:'A',waypoints:[{},{}]},{id:'b',name:'B',waypoints:[{},{}]},{id:'c',name:'C',waypoints:[{},{}]}],pathFolders:[]},routines:[],activePathId:'a',onPath:vi.fn(),onRoutine:vi.fn(),actions:{preflight:vi.fn(()=>true),deletePath:vi.fn(()=>true),deletePaths:vi.fn(()=>true)},times:{},controller:{itemStatus:()=>({detail:'Local'}),fileTransfer:true},selection:{selected:['a'],set:vi.fn(),clear:vi.fn()},deletionNotice:'reserved footer'};
 const find=(n,predicate)=>{if(!n||typeof n!=='object')return null;if(predicate(n))return n;for(const c of n.children){const r=find(c,predicate);if(r)return r;}return null;};
 const render=()=>{cursor=0;tree=renderFn(props);};render();return{props,doc,render,drag,find:predicate=>find(tree,predicate),pick:id=>find(tree,n=>n.props['data-library-item']===id),more:()=>find(tree,n=>n.props['aria-label']==='Actions for A'),menu:()=>find(tree,n=>n.type==='LibraryMenu')};
}
describe('actual library deletion entry points',()=>{
 it('Shift-click selects the listed range from the last choice and never deletes',()=>{
  const ui=harness();
  expect(ui.find(n=>n.props.className?.startsWith('library-row')).props.onPointerDownCapture).toBeUndefined();
  ui.pick('c').props.onClick(event({type:'click',shiftKey:true}));
  expect(ui.props.selection.set).toHaveBeenLastCalledWith(['a','b','c']);
  ui.pick('b').props.onClick(event({type:'click',ctrlKey:true}));
  ui.props.selection.selected=['a','b'];ui.render();
  ui.pick('c').props.onClick(event({type:'click',shiftKey:true}));
  expect(ui.props.selection.set).toHaveBeenLastCalledWith(['b','c']);
  ui.props.selection.selected=['a'];ui.render();
  ui.pick('c').props.onClick(event({type:'click',shiftKey:true,ctrlKey:true}));
  expect(ui.props.selection.set).toHaveBeenLastCalledWith(['a','b','c']);
  expect(ui.props.actions.deletePath).not.toHaveBeenCalled();expect(ui.props.actions.deletePaths).not.toHaveBeenCalled();expect(ui.props.onPath).not.toHaveBeenCalled();
 });
 it('shows routine rows by name and preview time with their actions and no step count',()=>{
  const ui=harness();Object.assign(ui.props,{mode:'routines',routines:[{id:'r',name:'Auto',nodes:[{id:'w',type:'builtin',builtinId:'bordeaux.wait',arguments:{durationS:1}},{id:'x',type:'builtin',builtinId:'bordeaux.wait',arguments:{durationS:0.5}}]}],activeRoutineId:'r'});ui.render();
  const row=ui.find(n=>n.props.className?.startsWith('library-row'));
  expect(ui.pick('r').children.map(c=>c.props?.className)).toEqual(['library-mark','library-name','library-meta']);
  expect(ui.find(n=>n.props.className==='library-meta').children).toEqual(['1.50 s']);
  expect(JSON.stringify(row)).not.toMatch(/\d+ steps?/);
  expect(ui.find(n=>n.props['aria-label']==='Actions for Auto')).toBeTruthy();
 });
 it('Shift+Arrow extends the range from the keyboard',()=>{
  const ui=harness(),rows=['a','b','c'].map(id=>({dataset:{libraryItem:id},focus:vi.fn()}));
  ui.find(n=>n.props.className==='editor-library').props.ref.current={querySelectorAll:()=>rows};
  ui.pick('a').props.onKeyDown(event({key:'ArrowDown',shiftKey:true,currentTarget:rows[0]}));
  expect(rows[1].focus).toHaveBeenCalled();expect(ui.props.selection.set).toHaveBeenLastCalledWith(['a','b']);
  ui.pick('b').props.onKeyDown(event({key:'ArrowDown',shiftKey:true,currentTarget:rows[1]}));
  expect(ui.props.selection.set).toHaveBeenLastCalledWith(['a','b','c']);expect(ui.props.onPath).not.toHaveBeenCalled();
 });
 it('deletes a whole selection as one action from a selected row, and only the row otherwise',()=>{
  const ui=harness();ui.props.selection.selected=['a','c'];ui.render();
  ui.pick('c').props.onKeyDown(event({key:'Delete'}));
  expect(ui.props.actions.deletePaths).toHaveBeenCalledExactlyOnceWith(['a','c']);
  ui.pick('b').props.onKeyDown(event({key:'Delete'}));
  expect(ui.props.actions.deletePath).toHaveBeenCalledExactlyOnceWith('b');
 });
 it('blocks a selection that includes a path a routine uses, deleting nothing',()=>{
  const ui=harness();ui.props.selection.selected=['a','b'];ui.props.routines=[{id:'r',name:'Routine',nodes:[{id:'s',type:'path',ref:'b'}]}];ui.render();
  ui.pick('a').props.onKeyDown(event({key:'Delete'}));ui.render();
  expect(ui.props.actions.deletePaths).not.toHaveBeenCalled();expect(ui.props.actions.deletePath).not.toHaveBeenCalled();
  const notice=ui.find(n=>n.props.className==='library-blocked');
  expect(notice.children[0].children).toEqual(['Cannot delete 2 paths']);
 });
 it('names the selection in the menu and starts a drag of the whole selection from a selected row',()=>{
  const ui=harness();ui.props.selection.selected=['a','c'];ui.render();
  ui.more().props.onPointerDown(event());ui.render();
  const labels=[];const walk=n=>{if(!n||typeof n!=='object')return;if(n.props?.role==='menuitem')labels.push(n.children.filter(c=>typeof c==='string').join(''));n.children?.forEach(walk);};walk(ui.menu());
  expect(labels).toEqual(['Push 2 paths…','Export BDX…','Rename','Duplicate','New path from its end','Delete 2 paths']);
  expect(labels).not.toContain('Link points…');
  const row=ui.find(n=>n.props.className?.startsWith('library-row'));
  row.props.onPointerDown(event({button:0}));
  expect(ui.drag.begin).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({kind:'path',ids:['a','c'],label:'2 paths'}));
 });
 it('preflights at menu opening before pointer focus and never retries blocked physical clicks',()=>{
  const ui=harness(),owner=ui.doc.activeElement;ui.props.actions.preflight.mockImplementation(()=>{expect(ui.doc.activeElement).toBe(owner);return false;});
  const press=event();ui.more().props.onPointerDown(press);ui.render();expect(press.preventDefault).toHaveBeenCalled();expect(ui.menu()).toBeNull();
  ui.more().props.onClick(event());expect(ui.props.actions.preflight).toHaveBeenCalledOnce();
  ui.more().props.onClick(event({detail:0}));expect(ui.props.actions.preflight).toHaveBeenCalledTimes(2);expect(ui.doc.activeElement).toBe(owner);
 });
 it('supplies the real opening trigger to the actual native LibraryMenu effect',()=>{
  const component=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='LibraryMenu').getText(source);
  const effects=[],trigger={},element={showPopover:vi.fn(),addEventListener:vi.fn(),removeEventListener:vi.fn(),style:{},getBoundingClientRect:()=>({width:224,height:100}),querySelector:()=>({focus:vi.fn()})};
  const Menu=new Function('useRef','useEffect','h','window',component+';return LibraryMenu;')(()=>({current:element}),fn=>effects.push(fn),(type,props)=>({type,props}),{innerWidth:1100,innerHeight:720});
  const rendered=Menu({id:'native-menu',menu:{trigger,name:'A',top:100,left:10},close:vi.fn()});effects[0]();
  expect(rendered.props.id).toBe('native-menu');expect(element.showPopover).toHaveBeenCalledExactlyOnceWith({source:trigger});
 });
 it('keeps native target association and original IDs through menu deletion',()=>{
  const ui=harness();ui.more().props.onPointerDown(event());ui.render();expect(ui.more().props.popovertarget).toBe(ui.menu().props.id);
  const remove=ui.find(n=>n.props.role==='menuitem'&&n.children[0]==='Delete');remove.props.onPointerDown(event());remove.props.onClick(event());ui.render();
  expect(ui.props.actions.deletePath).toHaveBeenCalledExactlyOnceWith('a');expect(ui.menu()).toBeNull();
 });
 it('blocks repeated and native-wrapper composing Delete without consuming another row',()=>{
  const ui=harness(),row=ui.find(n=>n.props['data-library-item']==='a');
  for(const patch of [{repeat:true},{nativeEvent:{isComposing:true}},{keyCode:229}])row.props.onKeyDown(event({key:'Delete',...patch}));
  expect(ui.props.actions.deletePath).not.toHaveBeenCalled();row.props.onKeyDown(event({key:'Delete'}));expect(ui.props.actions.deletePath).toHaveBeenCalledOnce();
 });
 it('keeps the menu and invalid focus when deletion preflight later refuses',()=>{
  const ui=harness();ui.more().props.onClick(event({detail:0}));ui.render();ui.props.actions.preflight.mockReturnValue(false);
  const owner=ui.doc.activeElement;ui.find(n=>n.props.role==='menuitem'&&n.children[0]==='Delete').props.onPointerDown(event());ui.render();
  expect(ui.menu()).not.toBeNull();expect(ui.props.actions.deletePath).not.toHaveBeenCalled();expect(ui.doc.activeElement).toBe(owner);
 });
});
