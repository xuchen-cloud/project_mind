import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {runInNewContext} from 'node:vm'
import {adaptSteadyScheduling} from '../scripts/initialization-adapter.mjs'
import {schedulePostPaint} from '../post-paint.ts'

// Exercise the installed pinned controller, rather than copying its scheduler.
// This isolates scheduling evidence; it does not validate browser paint/layout.
const source=await readFile(new URL('../node_modules/@univerjs/ui/lib/es/index.js',import.meta.url),'utf8')
function controllerSource(source){
const start=source.indexOf('var SingleUnitUIController = class extends Disposable {')
assert.ok(start>=0,'pinned UI controller must exist')
const end=source.indexOf('\n};',start)
const expression=source.slice(start+'var SingleUnitUIController = '.length,end+2)
return source.slice(start+'var SingleUnitUIController = '.length,end+2)
}
const constant=source.match(/const STEADY_TIMEOUT = ([^;]+);/)[0]

function fixture(adapted=false){
 const timers=new Map(),frames=new Map(),events=[];let next=0
 const window={setTimeout(callback,delay){const id=++next;timers.set(id,{callback,delay});return id},clearTimeout:id=>timers.delete(id),requestAnimationFrame(callback){const id=++next;frames.set(id,callback);return id},cancelAnimationFrame:id=>frames.delete(id)}
 const clearTimeout=id=>timers.delete(id)
 class Disposable{disposeWithMe(value){return value}dispose(){this._disposed=true;events.push('dispose')}}
 const Controller=runInNewContext(`${constant}\n(${controllerSource(adapted?adaptSteadyScheduling(source):source)})`,{Disposable,window,clearTimeout,performance:{mark(){}},schedulePostPaint:run=>schedulePostPaint(run,window),
  _defineProperty:(target,key,value)=>target[key]=value,
  LifecycleStages:{Ready:1,Rendered:2,Steady:3},isInternalEditorID:()=>false})
 const observable={subscribe(){events.push('subscribe');return {dispose(){}}}}
 const lifecycle={onStage:async stage=>events.push('await-'+stage),set stage(stage){events.push('stage-'+stage)}}
 const renderer={unitId:'book',engine:{mount:()=>events.push('mount')},activate:()=>events.push('activate')}
 const manager={getRenderAll:()=>new Map([['book',renderer]]),getRenderById:()=>renderer,created$:observable,disposed$:observable}
 const instance={focused$:observable}
 const controller=new Controller({},instance,null,lifecycle,manager)
 controller.bootstrap=callback=>{controller.runBootstrap=callback;return {dispose(){}}}
 controller._bootstrapWorkbench()
 const fire=delay=>{const item=[...timers].find(([,timer])=>timer.delay===delay);assert.ok(item,'scheduled delay '+delay);timers.delete(item[0]);item[1].callback()}
 const paint=()=>{const batch=[...frames];frames.clear();for(const[,callback]of batch)callback()}
 return {controller,timers,frames,events,fire,paint}
}

test('pinned UI mounts and emits Rendered before scheduling an unconditional 3000ms Steady transition',async()=>{
 const f=fixture();await f.controller.runBootstrap({},{});
 assert.deepEqual(f.events,['await-1']);assert.deepEqual([...f.timers.values()].map(t=>t.delay),[300])
 f.fire(300)
 assert.deepEqual(f.events,['await-1','mount','activate','subscribe','subscribe','subscribe','stage-2'])
 assert.deepEqual([...f.timers.values()].map(t=>t.delay),[3000])
 const before=[...f.events];f.fire(3000)
 assert.deepEqual(f.events,[...before,'stage-3'],'the timer performs no content/calculation/font checks')
})

test('dispose cancels the initial render timer',async()=>{
 const f=fixture();await f.controller.runBootstrap({},{});f.controller.dispose()
 assert.equal(f.timers.size,0);assert.ok(!f.events.includes('mount'))
})

test('dispose after Rendered cancels the deferred Steady initialization',async()=>{
 const f=fixture();await f.controller.runBootstrap({},{});f.fire(300);f.controller.dispose()
 assert.equal(f.timers.size,0);assert.ok(!f.events.includes('stage-3'))
})

test('adapter retains mount, Rendered and Steady initialization in order after a paint opportunity',async()=>{
 const f=fixture(true);await f.controller.runBootstrap({},{});
 assert.deepEqual(f.events,['await-1']);assert.equal(f.timers.size,0)
 f.paint();assert.deepEqual(f.events,['await-1']);f.paint();f.fire(0)
 assert.deepEqual(f.events,['await-1','mount','activate','subscribe','subscribe','subscribe','stage-2'])
 assert.equal(f.events.at(-1),'stage-2');assert.equal(f.timers.size,0)
 f.paint();assert.equal(f.events.at(-1),'stage-2');f.paint()
 assert.deepEqual([...f.timers.values()].map(t=>t.delay),[0]);f.fire(0)
 assert.equal(f.events.at(-1),'stage-3');assert.equal(f.timers.size,0)
})

for(const phase of ['first-frame','second-frame','task'])test('adapter cancels Steady initialization on dispose: '+phase,async()=>{
 const f=fixture(true);await f.controller.runBootstrap({},{})
 f.paint();f.paint();f.fire(0)
 if(phase==='second-frame'||phase==='task')f.paint()
 if(phase==='task')f.paint()
 f.controller.dispose();assert.equal(f.timers.size,0);assert.equal(f.frames.size,0)
 assert.ok(!f.events.includes('stage-3'))
})

for(const phase of ['first-frame','second-frame','task'])test('adapter cancels the real engine mount on dispose: '+phase,async()=>{
 const f=fixture(true);await f.controller.runBootstrap({},{})
 if(phase==='second-frame'||phase==='task')f.paint()
 if(phase==='task')f.paint()
 f.controller.dispose();assert.equal(f.timers.size,0);assert.equal(f.frames.size,0)
 assert.ok(!f.events.includes('mount'));assert.ok(!f.events.includes('stage-2'))
})

test('dispose while awaiting Ready cannot enqueue a later engine mount',async()=>{
 const f=fixture(true),pending=f.controller.runBootstrap({},{})
 f.controller.dispose();await pending
 assert.equal(f.timers.size,0);assert.equal(f.frames.size,0)
})
