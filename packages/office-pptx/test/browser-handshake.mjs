/** Drop the one-shot ready; recover through onLoad and reconnect retained iframe effects. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const pw=await import(pathToFileURL(resolve(process.env.OFFICE_PLAYWRIGHT_MODULE)).href),url=process.env.OFFICE_ACCEPTANCE_URL;
const out=resolve(import.meta.dirname,'../output/playwright');await mkdir(out,{recursive:true});const results=[];
for(const name of process.env.OFFICE_BROWSERS?.split(',')??['chromium','webkit']){
 const browser=await pw[name].launch({headless:true,...(name==='chromium'?{channel:'chrome'}:{})});
 try{
  const page=await browser.newPage({viewport:{width:980,height:700}});page.setDefaultTimeout(8000);
  const errors=[];page.on('pageerror',error=>errors.push(String(error)));
  await page.addInitScript(()=>{
   if(window!==parent){window.handshakeQueries=0;window.addEventListener('message',event=>{if(event.data?.type==='ready-request')window.handshakeQueries++});return;}
   window.handshake={dropped:0,readies:0,connections:0,closed:0,messages:[]};
   window.addEventListener('message',event=>{
    if(event.data?.source!=='project-mind-pptx'||event.data.type!=='ready')return;
    window.handshake.readies++;
    if(!window.handshake.dropped){window.handshake.dropped++;event.stopImmediatePropagation();}
   },true);
   const Native=window.MessageChannel;
   window.MessageChannel=function(){
    const channel=new Native(),send=channel.port1.postMessage.bind(channel.port1),close=channel.port1.close.bind(channel.port1);
    window.handshake.connections++;
    channel.port1.postMessage=message=>{window.handshake.messages.push({type:message.type,epoch:message.epoch});send(message)};
    channel.port1.close=()=>{window.handshake.closed++;close()};return channel;
   };
  });
  await page.request.get(url+'/reset');await page.goto(url+'/?presentation=preview');await page.locator('iframe').waitFor();
  const frame=page.frames().find(frame=>frame.parentFrame());
  await frame.waitForSelector('.stage-rel');
  assert.equal(await frame.locator('.ribbon').isVisible(),false);
  const first=await page.evaluate(()=>window.handshake);
  assert.equal(first.dropped,1);assert.ok(first.readies>=2,'one-shot ready must be replaced by a query response');
  assert.ok(await frame.evaluate(()=>window.handshakeQueries)>=1);
  assert.equal(first.messages.filter(message=>message.type==='init').length,1);
  const app=await frame.locator('.app').elementHandle();
  await page.evaluate(()=>{const frame=document.querySelector('iframe');for(let i=0;i<2;i++)frame.contentWindow.postMessage({source:'project-mind-pptx-host',type:'ready-request'},'*')});
  await page.waitForFunction(count=>window.handshake.readies>=count+2,first.readies);
  assert.equal(await page.evaluate(()=>window.handshake.messages.filter(message=>message.type==='init').length),1,'duplicate ready acknowledgments must not init again');
  await page.evaluate(()=>window.officePptxHarness.setPresentationMode('edit'));
  await frame.getByRole('button',{name:'切换',exact:true}).click();await frame.getByRole('button',{name:'淡入',exact:true}).click();
  await page.waitForFunction(()=>window.officePptxHarness.echoCount()>0);await page.evaluate(()=>window.officePptxHarness.save());
  assert.equal(await frame.getByRole('button',{name:'撤销',exact:true}).isEnabled(),true);
  const before=await page.evaluate(()=>({model:window.officePptxHarness.model(),edits:window.officePptxHarness.edits(),connections:window.handshake.connections}));
  await page.evaluate(()=>window.officePptxHarness.setSuspended(true));await page.waitForFunction(()=>window.handshake.closed>0);
  await page.evaluate(()=>window.officePptxHarness.setSuspended(false));
  await page.waitForFunction(count=>window.handshake.connections>count,before.connections);
  await frame.waitForFunction(()=>document.body.dataset.readOnly==='false');await page.evaluate(()=>window.officePptxHarness.flush());
  assert.equal(await app.evaluate(element=>element.isConnected),true,'effect reconnect retains the upstream App after native save');
  assert.equal(await frame.getByRole('button',{name:'撤销',exact:true}).isEnabled(),true,'effect reconnect retains Undo');
  assert.deepEqual(await page.evaluate(()=>({model:window.officePptxHarness.model(),edits:window.officePptxHarness.edits()})),{model:before.model,edits:before.edits});
  assert.deepEqual(errors,[]);results.push({browser:name,lostOneShotReady:true,onLoadRecovery:true,duplicateReadyIdempotent:true,strictMode:true,effectReconnect:true,retainedAppUndo:true,errors});console.log(name+': lost-ready/onLoad and retained iframe effect reconnect passed');
 }finally{await browser.close()}
}
await writeFile(resolve(out,'handshake-results.json'),JSON.stringify(results,null,2)+'\n');
