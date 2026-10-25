/** #212 opt-in native acceptance shell. No editor, bridge, provider or save mocks. */
import React from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClientProvider} from '@tanstack/react-query';
import {ProjectFileContent} from '../../src/components/document/ProjectFileContent';
import {createProjectMindQueryClient} from '../../src/lib/queryClient';
import {projectMindApi} from '../../src/services/projectMindApi';
import {projectFileApi} from '../../src/services/projectFileApi';
import {recordDocumentApi} from '../../src/services/recordDocumentApi';
import {officeFileApi} from '../../src/services/officeFileApi';
import {fileDocumentApi} from '../../src/services/fileDocumentApi';
import {desktopApi} from '../../src/services/desktopApi';
import {openProjectContent} from '../../src/services/projectContentApi';
import {setDshWorkspaceRoot,useDshFileReferences} from '../../src/lib/dsh-host-events';
import {createTauriTransport} from '../../packages/dsh-ui/adapters/transport.mjs';
import {selectXlsxRange,assertXlsxSaved} from './xlsx-driver';
import {selectPptxElement,assertPptxSaved} from './pptx-driver';
import '../../src/styles/app.css';
const config=(window as any).__OFFICE_PERFORMANCE__;
let phase='start';
const commands:Array<{name:string;ok:boolean;result?:unknown}>=[];
const original=desktopApi.command.bind(desktopApi);
desktopApi.command=(async(name:string,payload?:Record<string,unknown>)=>{
 try{const result=await original(name,payload);if(/^office_selection_|^file_office_save$/.test(name))commands.push({name,ok:!(result as any)?.error,result});return result}
 catch(error){commands.push({name,ok:false});throw error}
}) as typeof desktopApi.command;
async function until<T>(read:()=>T|Promise<T>,label:string,timeout=60000):Promise<NonNullable<T>>{
 phase=label;
 const deadline=Date.now()+timeout;while(Date.now()<deadline){const value=await read();if(value)return value as NonNullable<T>;await new Promise(r=>setTimeout(r,40))}throw Error(`Timed out: ${label}`);
}
function click(label:string){const button=document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);if(!button||button.disabled)throw Error(`Unavailable toolbar: ${label}`);button.click()}
function wordDocument():Document|undefined{
 for(const frame of document.querySelectorAll('iframe')){const doc=frame.contentDocument;if(doc?.querySelector('.tiptap.doc-page'))return doc}return undefined;
}
async function run(){
 document.getElementById('native-controls')?.remove();
 const element=document.getElementById('root')!;element.style.cssText='height:100vh;display:flex;flex-direction:column';
 await projectMindApi.workspaceOpen({rootPath:config.workspaceRoot});
 const project=(await projectMindApi.projectsList()).find(p=>p.name==='Performance');if(!project)throw Error('Isolated Performance project missing');
 const binding=await recordDocumentApi.bindingGet(config.workspaceRoot);
 const profile=await projectMindApi.aiProfileUpsert({name:'Office selection deterministic fixture',providerFamily:'openai_compatible',baseUrl:config.providerUrl,apiKey:'local-integration-key',defaultModel:'local-test-model',supportsText:true,supportsImage:false,supportsFile:false,enabled:true});
 await projectMindApi.aiBindingUpsert({capability:'default',useDefault:false,profileId:profile.id,model:'local-test-model'});
 await projectMindApi.aiNetworkSettingsUpsert({mode:'direct'});
 setDshWorkspaceRoot(config.workspaceRoot);
 const file=await projectFileApi.register(binding,project.id,`selection.${config.format}`);
 await openProjectContent({workspaceRoot:config.workspaceRoot,projectId:project.id,object:{kind:'file',id:Number(file.object.id),title:file.name},expectedBinding:binding});
 const root=createRoot(element),queryClient=createProjectMindQueryClient();
 const renderFile=(key:string)=>root.render(<QueryClientProvider client={queryClient}><ProjectFileContent key={key} workspaceRoot={config.workspaceRoot} projectId={project.id} fileId={Number(file.object.id)} fileName={file.name} visible focused /></QueryClientProvider>);
 renderFile('initial');
 await until(()=>{const button=document.querySelector<HTMLButtonElement>('button[aria-label="编辑"]');return button&&!button.disabled},'native File preview');click('编辑');
 await until(()=>{const button=document.querySelector<HTMLButtonElement>('button[aria-label="引用选区"]');return button&&!button.disabled},'selection toolbar registration');
 if(config.format==='docx'){
 const doc=await until(wordDocument,'real Word editor');
 const paragraph=Array.from(doc.querySelectorAll<HTMLElement>('.tiptap.doc-page p')).find(p=>(p.textContent?.trim().length??0)>=4);if(!paragraph)throw Error('No selectable fixture paragraph');
 const walk=doc.createTreeWalker(paragraph,NodeFilter.SHOW_TEXT);let node:Node|null=null;
 while(node=walk.nextNode())if((node.textContent?.trim().length??0)>=4)break;
 if(!node)throw Error('No selectable text run');
 paragraph.closest<HTMLElement>('.ProseMirror')!.focus();const range=doc.createRange();range.setStart(node,0);range.setEnd(node,4);const selection=doc.getSelection()!;selection.removeAllRanges();selection.addRange(range);doc.dispatchEvent(new Event('selectionchange'));
 await new Promise(r=>setTimeout(r,80));
 }else if(config.format==='xlsx'){
  await until(()=>document.querySelector<HTMLIFrameElement>('iframe')?.contentDocument?.querySelector('input[type="text"]'),'real Excel name box');
  await selectXlsxRange(document);
 }else{
  await until(()=>document.querySelector<HTMLIFrameElement>('iframe')?.contentDocument?.querySelector('.stage-rel'),'real PPT stage');
  await selectPptxElement(document);
 }
 click('引用选区');
 const quoted=await until(()=>useDshFileReferences.getState().pending.find(p=>p.projectId===project.id&&p.selection),'native bound quote');
 if(!quoted.sessionId||!quoted.selection)throw Error('Quote missing actual session/selection identity');
 const transport=createTauriTransport(project.id);
 async function rpc(method:string,request:unknown,direct=false){const rpcId=crypto.randomUUID();const response=await transport.fetch(`/api/${method}`,{method:'POST',body:JSON.stringify({type:'client-request',rpcId,method,payload:{args:direct?request:{request}}})});const result=await response.json();if(!response.ok||!result.result?.ok)throw Error(JSON.stringify(result));return result.result.value}
 try{
  await rpc('session/rename',{sessionId:quoted.sessionId,title:'Office selection native acceptance'});
  const permission=await rpc('commands/execute',{agentId:quoted.sessionId,line:'/permission workspace-write',submittedAttachments:[]},true);
  if(permission?.result?.kind!=='success')throw Error('Could not explicitly enable writes for the isolated acceptance Session');
  const prepared=await rpc('mind/office-selection/prepare',{sessionId:quoted.sessionId,selectionId:quoted.selection.selectionId});
  await rpc('session/prompt',{sessionId:quoted.sessionId,requestId:crypto.randomUUID(),mode:'queue',content:[{type:'text',text:`[office-selection-native] Rewrite this selected text.\n${prepared.projection}`}]});
  const provider=await until(async()=>{const state=await(await fetch(config.controlUrl+'/provider')).json();if(state.error)throw Error(state.error);return state.result&&state},'real model tool result');
  if(provider.result.saved!==false||provider.result.status!=='editor_draft'||provider.result.tracked!==(config.format==='docx'))throw Error(`Not an actual editor draft: ${JSON.stringify(provider.result)}`);
  for(const name of ['office_selection_register','office_selection_bind','office_selection_claim','office_selection_reply'])if(!commands.some(c=>c.name===name&&c.ok))throw Error(`Native ${name} not observed`);
  if(config.format==='docx')await until(()=>wordDocument()?.body.textContent?.includes(config.marker),'live Word inserted revision');
  const save=document.querySelector<HTMLButtonElement>('button[aria-label="保存"]');if(save&&!save.disabled)save.click();
  const saved=await until(async()=>{const failed=commands.find(c=>c.name==='file_office_save'&&!c.ok);if(failed)throw Error(`Native File save failed: ${JSON.stringify(failed.result)}`);const versions=await fileDocumentApi.versionsList(binding,{object:file.object,limit:1});return versions.currentVersionNumber>file.versionNumber&&versions.currentContentHash&&versions},'native File new version');
  const reopened=await officeFileApi.inspect(binding,{object:file.object,versionNumber:saved.currentVersionNumber,expectedContentHash:saved.currentContentHash!});
  if(config.format==='docx'){
   if(reopened.model.format!=='docx')throw Error('Native saved format changed');
   // The inspect node list intentionally excludes paragraphs containing
   // revisions. Remount the full editor from the saved File instead; the runner
   // independently checks persisted w:ins/w:del and their author in the ZIP.
   renderFile('reopened');
   await until(()=>{const button=document.querySelector<HTMLButtonElement>('button[aria-label="编辑"]');return button&&!button.disabled},'reopened native File preview');click('编辑');
   await until(()=>wordDocument()?.querySelector('.tiptap.doc-page')?.textContent?.includes(config.marker),'reopened Word revision');
  }else if(config.format==='xlsx')assertXlsxSaved(reopened.model);
  else assertPptxSaved(reopened.model,config.marker);
  return {status:'passed',scope:'native ProjectFileContent shell, real toolbar/DSH/claims/File save; deterministic provider, not full app chat UI',selectionId:quoted.selection.selectionId,sessionId:quoted.sessionId,versionBefore:file.versionNumber,versionAfter:saved.currentVersionNumber,contentHash:saved.currentContentHash,commands,provider};
 }finally{await transport.close()}
}
void run().then(result=>fetch(config.reportUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(result)}),error=>fetch(config.reportUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({status:'error',phase,error:String(error?.message??error),stack:error?.stack,commands,body:document.body.innerText,frames:Array.from(document.querySelectorAll('iframe'),f=>({title:f.title,body:f.contentDocument?.body?.innerText,html:f.contentDocument?.body?.innerHTML.slice(0,500)}))})}));
