import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {describe,it,expect,vi,afterEach} from 'vitest';
import {deletionInput} from '../src/renderer/components/DeletionNotice';
const source=ts.createSourceFile('DeletionNotice.jsx',readFileSync(new URL('../src/renderer/components/DeletionNotice.jsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JSX);
const component=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='DeletionNotice').getText(source).replace(/^export /,'');
const composing=e=>e.isComposing||e.nativeEvent?.isComposing||e.keyCode===229;
const event=(patch={})=>({button:0,detail:1,preventDefault:vi.fn(),stopPropagation:vi.fn(),...patch});
const notice=name=>({active:true,message:name+' deleted',detail:'Deleted '+name+'.'});
function harness(){
 const cells=[],effects=[];let cursor=0,dirty=false,tree,props={notice:null,onUndo:vi.fn(()=>true),onDismiss:vi.fn()};
 const doc={activeElement:null,querySelector:()=>fallback};
 const fallback={focus:vi.fn(()=>{doc.activeElement=fallback;})};let modal=false;
 doc.querySelector=selector=>selector.includes('dialog')?(modal?{}:null):fallback;
 const button={isConnected:true},node={isConnected:true,contains:n=>n===button,matches:()=>hover};let hover=false;
 const h=(type,props,...children)=>({type,props:props||{},children:children.flat().filter(v=>v!==false&&v!=null)});
 const React={useRef:v=>cells[cursor++]||=( {current:v}),useState:v=>{const c=cells[cursor++]||={value:v};return[c.value,n=>{const value=typeof n==='function'?n(c.value):n;if(value!==c.value){c.value=value;dirty=true;}}];},useLayoutEffect:effect,useEffect:effect};
 function effect(fn,deps){const c=cells[cursor++]||={};if(!deps||!c.deps||deps.some((v,i)=>v!==c.deps[i])){c.deps=deps;effects.push(()=>{c.cleanup?.();c.cleanup=fn();});}}
 const renderFn=new Function('React','h','deletionInput','composing','document',component+';return DeletionNotice;')(React,h,deletionInput,composing,doc);
 const walk=(tree,predicate)=>{if(!tree||typeof tree!=='object')return null;if(predicate(tree))return tree;for(const child of tree.children){const found=walk(child,predicate);if(found)return found;}return null;};
 function render(patch={}){props={...props,...patch};let tries=0;do{if(++tries>10)throw Error('render loop');dirty=false;cursor=0;tree=renderFn(props);const root=walk(tree,n=>n.props.className==='deletion-notice');node.isConnected=Boolean(root);if(root)root.props.ref.current=node;else cells[0].current=null;while(effects.length)effects.shift()();}while(dirty);return tree;}
 render();return{render,props:()=>props,node,button,doc,fallback,root:()=>walk(tree,n=>n.props.className==='deletion-notice'),action:()=>walk(tree,n=>n.type==='button'),status:()=>walk(tree,n=>n.props.role==='status'),focus(){doc.activeElement=button;this.root().props.onFocusCapture();},blur(){doc.activeElement=fallback;this.root().props.onBlurCapture({currentTarget:node,relatedTarget:fallback});render();},enter(){hover=true;this.root().props.onPointerEnter();},leave(){hover=false;this.root().props.onPointerLeave();},modal(value){modal=value;},unmount(){node.isConnected=false;cells.forEach(c=>c.cleanup?.());cells[0].current=null;}};
}
afterEach(()=>vi.useRealTimers());
describe('deletion press ownership',()=>{
 it('owns physical activation once and keeps a later detail-zero action independent',()=>{
  const action=vi.fn(),handlers=deletionInput(action);const press=event();handlers.onPointerDown(press);handlers.onClick(event());
  expect(action).toHaveBeenCalledOnce();expect(press.preventDefault).toHaveBeenCalledOnce();handlers.onClick(event({detail:0}));expect(action).toHaveBeenCalledTimes(2);
 });
 it('blocks repeat, React-wrapper composition, IME229 and deletion keys',()=>{
  const action=vi.fn(),handlers=deletionInput(action);
  for(const patch of [{key:' ',repeat:true},{key:'Enter',nativeEvent:{isComposing:true}},{key:'Enter',keyCode:229},{key:'Delete'},{key:'Backspace'}]){const e=event(patch);handlers.onKeyDown(e);expect(e.preventDefault).toHaveBeenCalledOnce();expect(e.stopPropagation).toHaveBeenCalledOnce();}
  expect(action).not.toHaveBeenCalled();handlers.onKeyDown(event({key:' '}));expect(action).toHaveBeenCalledOnce();
 });
});
describe('actual DeletionNotice leaf handlers and timer lifecycle (controlled DOM)',()=>{
 it('keeps focused retired A inert across B replacement, then shows B after blur',()=>{
  const ui=harness(),a=notice('A'),b=notice('B');ui.render({notice:a});ui.focus();const old=ui.action().props.onClick;a.active=false;ui.render({notice:b});
  expect(ui.action().props['aria-disabled']).toBe(true);expect(ui.action().props['aria-label']).toContain('A');
  old(event({detail:0}));ui.action().props.onClick(event({detail:0}));expect(ui.props().onUndo).not.toHaveBeenCalled();
  ui.blur();expect(ui.action().props['aria-label']).toContain('B');expect(ui.action().props['aria-disabled']).toBeUndefined();
  ui.action().props.onClick(event({detail:0}));expect(ui.props().onUndo).toHaveBeenCalledExactlyOnceWith(b);expect(ui.fallback.focus).not.toHaveBeenCalled();
 });
 it('Escape on retired focused A reveals B even when dismissing A is refused',()=>{
  const ui=harness(),a=notice('A'),b=notice('B');ui.render({notice:a});ui.focus();a.active=false;
  const dismiss=vi.fn(action=>{if(action===b)ui.render({notice:null});});ui.render({notice:b,onDismiss:dismiss});
  ui.root().props.onKeyDown(event({key:'Escape'}));ui.render();
  expect(dismiss).toHaveBeenCalledExactlyOnceWith(a);expect(ui.action().props['aria-label']).toContain('B');
  ui.action().props.onClick(event({detail:0}));expect(ui.props().onUndo).toHaveBeenCalledExactlyOnceWith(b);
 });
 it('uses remaining lifetime, pauses for either pointer or focus, and cleans up',()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']});const ui=harness(),a=notice('A');ui.render({notice:a});
  vi.advanceTimersByTime(2000);ui.enter();ui.focus();vi.advanceTimersByTime(10000);ui.leave();vi.advanceTimersByTime(10000);expect(ui.props().onDismiss).not.toHaveBeenCalled();
  ui.blur();vi.advanceTimersByTime(3999);expect(ui.props().onDismiss).not.toHaveBeenCalled();vi.advanceTimersByTime(1);expect(ui.props().onDismiss).toHaveBeenCalledExactlyOnceWith(a);
  ui.render({notice:notice('B')});expect(vi.getTimerCount()).toBe(1);ui.unmount();expect(vi.getTimerCount()).toBe(0);
 });
 it('does not carry a replaced timer or move focus on a refusal, modal, or retained unmount callback',()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']});const ui=harness();ui.render({notice:notice('A')});vi.advanceTimersByTime(5000);const b=notice('B');ui.render({notice:b});vi.advanceTimersByTime(1000);expect(ui.props().onDismiss).not.toHaveBeenCalled();
  ui.focus();ui.render({onUndo:vi.fn(()=>false)});ui.action().props.onClick(event({detail:0}));expect(ui.fallback.focus).not.toHaveBeenCalled();
  ui.render({onUndo:vi.fn(()=>true)});ui.modal(true);ui.action().props.onClick(event({detail:0}));expect(ui.fallback.focus).not.toHaveBeenCalled();
  const old=ui.action().props.onClick;ui.unmount();old(event({detail:0}));expect(ui.props().onUndo).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
 });
 it('contains Escape and announces only the current deletion detail',()=>{
  const ui=harness(),a=notice('A');ui.render({notice:a});expect(ui.status().children[0].children).toEqual(['Deleted A.']);ui.focus();
  const e=event({key:'Escape'});ui.root().props.onKeyDown(e);ui.render();expect(e.stopPropagation).toHaveBeenCalledOnce();expect(ui.props().onDismiss).toHaveBeenCalledExactlyOnceWith(a);expect(ui.fallback.focus).toHaveBeenCalledOnce();expect(ui.action()).toBeNull();
 });
});
