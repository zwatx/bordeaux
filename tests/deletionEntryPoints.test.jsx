import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {describe,it,expect,vi} from 'vitest';
import {deletionInput} from '../src/renderer/components/DeletionNotice';
import {AUTO} from '../src/renderer/lib/routineModel';
import {referencingRoutines} from '../src/renderer/components/EditorLibrary';
const event=(patch={})=>({button:0,detail:1,type:'pointerdown',preventDefault:vi.fn(),stopPropagation:vi.fn(),currentTarget:{getBoundingClientRect:()=>({left:1,bottom:2})},...patch});
const source=ts.createSourceFile('EditorLibrary.jsx',readFileSync(new URL('../src/renderer/components/EditorLibrary.jsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JSX);
const component=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='EditorLibrary').getText(source);
function harness(){
 let cursor=0,props,tree;const cells=[];const doc={activeElement:{name:'invalid owner'}};
 const useState=initial=>{const c=cells[cursor++]||={value:initial};return[c.value,n=>{c.value=typeof n==='function'?n(c.value):n;}];};
 const useRef=value=>cells[cursor++]||={current:value};
 const h=(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity).filter(c=>c!==false&&c!=null)});
 const renderFn=new Function('React','useState','useRef','useEffect','h','Icon','AUTO','referencingRoutines','deletionInput','LibraryMenu','PathProperties','document','requestAnimationFrame',component+';return EditorLibrary;')({useId:()=> 'library-test'},useState,useRef,()=>{},h,'Icon',AUTO,referencingRoutines,deletionInput,'LibraryMenu','PathProperties',doc,()=>{});
 props={mode:'paths',prefs:{query:'',collapsed:{},scroll:0},update:vi.fn(),project:{paths:[{id:'a',name:'A',waypoints:[{},{}]},{id:'b',name:'B',waypoints:[{},{}]}],pathFolders:[]},routines:[],activePathId:'a',onPath:vi.fn(),onRoutine:vi.fn(),actions:{preflight:vi.fn(()=>true),deletePath:vi.fn(()=>true)},times:{},controller:{itemStatus:()=>({detail:'Local'}),fileTransfer:true},selection:{selected:['a'],set:vi.fn(),clear:vi.fn()},deletionNotice:'reserved footer'};
 const find=(n,predicate)=>{if(!n||typeof n!=='object')return null;if(predicate(n))return n;for(const c of n.children){const r=find(c,predicate);if(r)return r;}return null;};
 const render=()=>{cursor=0;tree=renderFn(props);};render();return{props,doc,render,find:predicate=>find(tree,predicate),more:()=>find(tree,n=>n.props['aria-label']==='Actions for A'),menu:()=>find(tree,n=>n.type==='LibraryMenu')};
}
describe('actual library deletion entry points',()=>{
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
