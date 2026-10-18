// Scheduling diagnosis only: actual React 19 production + jsdom, no native/performance claim.
import {JSDOM} from 'jsdom';
import {writeFile} from 'node:fs/promises';
process.env.NODE_ENV='production';
const dom=new JSDOM('<!doctype html><div id="root"></div>');
globalThis.window=dom.window;globalThis.document=dom.window.document;
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
const React=await import('react'),{createRoot}=await import('react-dom/client');
const {createElement:h,useState,useEffect,useLayoutEffect,lazy,Suspense}=React;
const runs=[];
for(const explicit of [false,true]){
 const marks=[],mark=name=>marks.push({name,time:performance.now()});let finish;
 const done=new Promise(resolve=>{finish=resolve});
 function Format(){useLayoutEffect(()=>{mark('format-mounted');finish()},[]);return h('p',null,'real content');}
 const importFormat=()=>Promise.resolve().then(()=>{mark('format-module-ready');return {default:Format}});
 let formatPending,formatModule;
 const preload=()=>formatPending??=importFormat().then(module=>(formatModule=module,module));
 const LazyFormat=lazy(preload);
 function Host(){
  const [model,setModel]=useState(false);
  useLayoutEffect(()=>{mark('host-mounted');},[]);
  useEffect(()=>{if(explicit)void preload();const timer=setTimeout(()=>{mark('model-ready');setModel(true)},10);return()=>clearTimeout(timer)},[]);
  return model?(explicit?h(formatModule.default):h(Suspense,{fallback:h('p',null,'Loading format')},h(LazyFormat))):h('p',null,'Reading');
 }
 const importHost=()=>Promise.resolve().then(()=>{mark('host-module-ready');return {default:Host}});
 const LazyHost=lazy(importHost);
 function Explicit(){
  const [module,setModule]=useState(null);
  useEffect(()=>{let active=true;const request=importHost();void preload();const timer=setTimeout(()=>{void request.then(module=>{if(active){mark('version-ready');setModule(module)}})},10);return()=>{active=false;clearTimeout(timer)}},[]);
  return module?h(module.default):h('p',null,'Resolving');
 }
 const root=createRoot(document.getElementById('root'));mark('start');
 root.render(explicit?h(Explicit):h(Suspense,{fallback:h('p',null,'Loading host')},h(LazyHost)));
 const timeout=setTimeout(()=>finish(new Error('Scheduling probe did not finish')),3000);
 const error=await done;clearTimeout(timeout);root.unmount();if(error)throw error;
 const at=name=>marks.find(mark=>mark.name===name).time;
 runs.push({path:explicit?'explicit-preload-and-direct-component':'legacy-two-lazy-boundaries',marks,hostReadyToMounted:at('host-mounted')-at('host-module-ready'),formatReadyToMounted:at('format-mounted')-at('format-module-ready')});
}
const result={qualification:'production-react-jsdom-scheduling-diagnosis-not-native-perf',react:React.version,note:'Synthetic async modules and simulated 10ms native operations isolate commit scheduling. They do not establish timing of actual native File/inspect or module evaluation.',runs};
await writeFile(new URL('./output/suspense-commit-probe.json',import.meta.url),JSON.stringify(result,null,2));
console.log(JSON.stringify(runs.map(({path,hostReadyToMounted,formatReadyToMounted})=>({path,hostReadyToMounted,formatReadyToMounted}))));
dom.window.close();
