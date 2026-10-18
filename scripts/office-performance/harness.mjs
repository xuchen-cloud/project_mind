const host=document.querySelector('#editor');let controller,options,active,mode='preview';let formulaExpectations=[],cancelHints;
const errors=[];const timed=async fn=>{const t=performance.now(),value=await fn();return {value,ms:performance.now()-t}};
async function json(url,init){const response=await fetch(url,init);if(!response.ok)throw Error(await response.text());return response.json()}
function mountPptx(html,model,rendererUrl){
 const frame=document.createElement('iframe');frame.title='PPTX performance renderer';let resolve,reject,connected=false,port;
 const ready=new Promise((r,j)=>{resolve=r;reject=j});
 const post=value=>(port??frame.contentWindow).postMessage({source:'project-mind-pptx-host',epoch:1,...value},...(port?[]:['*']));
 function receive(event){if(event.source!==frame.contentWindow||event.data?.source!=='project-mind-pptx')return;const m=event.data;
  if(m.type==='ready'&&!connected){connected=true;const channel=new MessageChannel();port=channel.port1;port.onmessage=e=>receive({source:frame.contentWindow,data:e.data});port.start();frame.contentWindow.postMessage({source:'project-mind-pptx-host',type:'connect'},'*',[channel.port2]);post({type:'init',model,edits:[],readOnly:mode==='preview',presentationMode:mode})}
  if(m.type==='initialized')resolve();if(m.type==='error'&&m.message){errors.push(m.message);reject(Error(m.message))}
 }
 window.addEventListener('message',receive);if(rendererUrl)frame.src=rendererUrl;else frame.srcdoc=html;host.replaceChildren(frame);
 return {ready,update(next){post({type:'readonly',readOnly:next.presentationMode==='preview',presentationMode:next.presentationMode})},destroy(){window.removeEventListener('message',receive);port?.close();frame.remove()}};
}
const contracts=await json('/harness-config');
window.officePerf={errors,model:()=>options.model,formulas:()=>formulaExpectations,
 async open(sample){
  this.close();errors.length=0;active=sample;mode='preview';performance.clearResourceTimings();const start=performance.now();
  const contract=contracts[sample.format];
  const apiImport=timed(()=>contract.apiEntry?import(contract.apiEntry):Promise.resolve({}));
  const resourceImport=timed(()=>contract.resourceModule?import(contract.resourceModule):Promise.resolve(null));
  let preloadStartedAtMs=null;
  const hintSetup=Promise.all([apiImport,resourceImport]).then(([,resource])=>{if(resource.value){cancelHints=resource.value.preload();preloadStartedAtMs=performance.now()-start}});
  const [inspected,imported,css,resource]=await Promise.all([
   timed(()=>json(`/inspect?id=${encodeURIComponent(sample.id)}`)),
   apiImport,
   timed(()=>sample.format==='pptx'?Promise.resolve():new Promise((resolve,reject)=>{const link=document.createElement('link');link.rel='stylesheet';link.href=`/packages/office-${sample.format}/dist/${sample.format==='docx'?'editor-shell':'browser'}.css`;link.dataset.perfCss='';link.onload=resolve;link.onerror=()=>reject(Error('Renderer CSS failed'));document.head.append(link)})),
   resourceImport,hintSetup,
  ]);
  formulaExpectations=inspected.value.formulaExpectations??[];
  options={model:inspected.value.value,edits:[],readOnly:false,presentationMode:mode,onChange(edits){options.edits=edits},onError(message){errors.push(message)},onRecalculate:async request=>(await json(`/recalculate?id=${encodeURIComponent(sample.id)}`,{method:'POST',body:JSON.stringify(request)})).value};
  const mountStart=performance.now();
  host.className=sample.format==='docx'?'office-docx':'';
  controller=sample.format==='docx'?imported.value.mountFullEditor(host,options,contract.rendererUrl??undefined):sample.format==='xlsx'?imported.value.mount(host,options,contract.rendererUrl??undefined):mountPptx(imported.value.parityHtml,options.model,contract.rendererUrl);
  await controller.ready;
  return {start,apiEntry:contract.apiEntry,externalRenderer:contract.externalRenderer,resourceModuleMs:resource.ms,preloadStartedAtMs,inspectRoundTripMs:inspected.ms,...inspected.value.timings,rendererImportMs:imported.ms,cssMs:css.ms,mountToReadyMs:performance.now()-mountStart,readyMs:performance.now()-start};
 },
 async setMode(next){mode=next;options={...options,presentationMode:mode};controller.update(options)},
 close(){cancelHints?.();cancelHints=undefined;if(controller){(controller.destroy??controller.dispose).call(controller);controller=undefined}host.replaceChildren();document.querySelectorAll('[data-perf-css]').forEach(e=>e.remove())},
 resources(){return performance.getEntriesByType('resource').map(e=>e.toJSON())},
};
