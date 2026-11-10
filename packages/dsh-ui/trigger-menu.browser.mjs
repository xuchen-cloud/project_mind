/** G10: real trigger menu + host cascade in an isolated Chrome profile.
 * Uses the installed Playwright CLI; writes fixtures/screenshots only to output/.
 * PLAYWRIGHT_CLI points to playwright-cli.js when it is not installed locally.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createServer } from 'vite';
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = path.join(root, 'output/playwright/assistant-menu');
await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'index.html'), '<div id="root"></div><script type="module" src="./fixture.tsx"></script>');
await writeFile(path.join(output, 'fixture.tsx'), `
import React from 'react';
import {createRoot} from 'react-dom/client';
import '/src/styles/app.css';
import '/packages/dsh-ui/styles/scoped.css';
import '/packages/dsh-ui/adapters/host.css';
import {MenuView} from '/packages/dsh-ui/upstream/client/ui-input-trigger/src/client/MenuView.tsx';
const dark = new URLSearchParams(location.search).get('theme') === 'dark';
document.documentElement.dataset.theme = dark ? 'dark' : 'light';
let state = {open:true,hit:null,generation:1,highlight:{source:'files',index:0},groups:[{source:'files',status:'ready',items:Array.from({length:30},(_,i)=>({name:'File '+i,label:'候选文件 '+i,description:'说明文字 '+i}))}]};
const listeners=new Set();
const menu={getSnapshot:()=>state,subscribe:f=>{listeners.add(f);return()=>listeners.delete(f)}};
const headers={getSnapshot:()=>crumbs,subscribe:()=>()=>{}};
const crumbs=new Map([['files',[{value:'root',label:'项目文件',current:true}]]]);
window.triggerFixture={count(n){state={...state,groups:[{...state.groups[0],items:state.groups[0].items.slice(0,n)}],highlight:null};listeners.forEach(f=>f());}, pick:null};
createRoot(document.getElementById('root')).render(<main className="dsh-ui-host" data-ds-dark-theme={dark?'':undefined} style={{height:'100vh',background:'repeating-linear-gradient(45deg,#dd4080 0 8px,#2060c0 8px 16px)'}}><div data-composer-card style={{position:'absolute',left:100,bottom:40,width:620}}><textarea aria-label="会话输入" autoFocus defaultValue="@"/><MenuView menu={menu} headers={headers} onPick={(source,index)=>window.triggerFixture.pick={source,index}} onHover={()=>{}} onCrumb={()=>{}} onDismiss={()=>{}} t={key=>key}/></div></main>);
`);
const cli = process.env.PLAYWRIGHT_CLI;
if (!cli) throw new Error('Set PLAYWRIGHT_CLI to the installed playwright-cli.js');
const run = promisify(execFile);
const session = `assistant-menu-${process.pid}`;
const command = async (...args) => {
  const { stdout } = await run(process.execPath, [cli, '-s=' + session, ...args], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
};
const evaluate = async code => {
  const value = await command('eval', code);
  const match = value.match(/### Result\n([\s\S]*?)(?:\n### |$)/);
  if (!match) throw new Error(value);
  return JSON.parse(match[1]);
};
const server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), cacheDir: path.join(output,'.vite'), optimizeDeps:{entries:[path.join(output,'index.html')]}, server:{host:'127.0.0.1',port:0,open:false,hmr:false,watch:null} });
const evidence = [];
try {
  await server.listen();
  const url = `http://127.0.0.1:${server.httpServer.address().port}/output/playwright/assistant-menu/index.html`;
  await command('open', url, '--browser', 'chrome');
  await command('resize','900','700');
  await command('snapshot');
  for (const theme of ['light','dark','forced']) {
    await command('set-forced-colors', theme === 'forced' ? 'active' : 'none');
    await command('goto',url+'?theme='+(theme==='dark'?'dark':'light'));
    await command('snapshot');
    await command('run-code',"async page => { await page.locator('[data-trigger-menu] [role=listbox]').waitFor(); }");
    const metrics = await evaluate(`() => {const menu=document.querySelector('[data-trigger-menu]');const view=menu.querySelector('[role=listbox]');const frame=view.parentElement;const material=menu.firstElementChild;return {background:getComputedStyle(material).backgroundColor,backdrop:getComputedStyle(material).backdropFilter,outline:getComputedStyle(menu).outlineStyle,top:Number(getComputedStyle(frame,'::before').opacity),bottom:Number(getComputedStyle(frame,'::after').opacity),max:view.scrollHeight-view.clientHeight,focus:document.activeElement?.tagName};}`);
    assert.ok(!metrics.background.includes('rgba'),theme+' must have an opaque material');
    assert.equal(metrics.backdrop,'none');
    assert.equal(metrics.top,0); assert.equal(metrics.bottom,1); assert.ok(metrics.max>64);
    if(theme==='forced') assert.equal(metrics.outline,'solid');
    await command('screenshot','--filename',path.join(output,theme+'.png'));
    for(const position of ['middle','near-bottom','bottom','reverse','top']) {
      const measured=await evaluate(`async () => {const view=document.querySelector('[role=listbox]');const max=view.scrollHeight-view.clientHeight;view.scrollTop=${({middle:'max/2','near-bottom':'max-16',bottom:'max',reverse:'max-32',top:'0'})[position]};view.dispatchEvent(new Event('scroll'));await new Promise(requestAnimationFrame);const frame=view.parentElement;return {top:Number(getComputedStyle(frame,'::before').opacity),bottom:Number(getComputedStyle(frame,'::after').opacity)};}`);
      if(position==='middle'){assert.equal(measured.top,1);assert.equal(measured.bottom,1);}
      if(position==='near-bottom') assert.ok(measured.bottom>0&&measured.bottom<1);
      if(position==='bottom') assert.equal(measured.bottom,0);
      if(position==='reverse') assert.ok(measured.bottom>0&&measured.bottom<1);
      evidence.push({theme,position,...measured});
    }
    // Size-only and content-only changes must remeasure without a scroll event.
    await evaluate(`async () => {document.querySelector('[role=listbox]').style.maxHeight='180px';await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;}`);
    const resized=await evaluate(`() => {const view=document.querySelector('[role=listbox]');return {height:view.clientHeight,bottom:Number(getComputedStyle(view.parentElement,'::after').opacity)};}`);
    assert.equal(resized.height,180);assert.equal(resized.bottom,1);
    await evaluate(`async () => {window.triggerFixture.count(2);await new Promise(r=>setTimeout(r,100));return true;}`);
    const short=await evaluate(`() => {const view=document.querySelector('[role=listbox]');return {max:view.scrollHeight-view.clientHeight,top:Number(getComputedStyle(view.parentElement,'::before').opacity),bottom:Number(getComputedStyle(view.parentElement,'::after').opacity)};}`);
    assert.equal(short.max,0);assert.equal(short.top,0);assert.equal(short.bottom,0);
    await command('run-code',"async page => { await page.getByRole('option').first().dispatchEvent('mousedown'); }");
    const picked=await evaluate('() => ({picked:window.triggerFixture.pick,focus:document.activeElement.tagName})');
    assert.deepEqual(picked.picked,{source:'files',index:0});assert.equal(picked.focus,'TEXTAREA');
    evidence.push({theme,metrics,resized,short,picked});
  }
  await writeFile(path.join(output,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify({passed:true,themes:3,scenarios:evidence.length,output}));
} finally { await command('close').catch(()=>{}); await server.close(); }
