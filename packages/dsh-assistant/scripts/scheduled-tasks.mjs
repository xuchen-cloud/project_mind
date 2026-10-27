import path from 'node:path';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection';
import { exact, requestIdentity, validateTaskInput, validateStore } from './scheduled-tasks-schema.mjs';
import { occurrences } from './scheduled-tasks-time.mjs';

const _vp = String.fromCharCode(92,92,63,92);
const normalizeDirectory = v => typeof v === 'string' && v.startsWith(_vp) ? v.slice(_vp.length) : v;

export async function installScheduledTasks(ctx, context, home) {
 const registry=typeof context.forSession==='function'?context:undefined;
 context=registry?registry.workspace:context;
 if(context.kind!=='workspace')return;
 const file=path.join(home,'scheduled-tasks.json');
 let tasks=[],requests={};
 try {const saved=validateStore(JSON.parse(await readFile(file,'utf8')));tasks=saved.tasks;requests=saved.requests??{};}
 catch(error){if(error.code!=='ENOENT')throw error;}
 let chain=Promise.resolve(),timer,closed=false;
 const serial=fn=>{const run=chain.then(fn);chain=run.catch(()=>{});return run;};
 const save=async()=>{await mkdir(home,{recursive:true});const temporary=`${file}.${randomUUID()}.tmp`;await writeFile(temporary,JSON.stringify({version:1,tasks,requests})+'\n',{mode:0o600});await rename(temporary,file);};
 const view=task=>{const {pending,...value}=task;return structuredClone(value);};
 const owner=async id=>{
  if(typeof id!=='string'||!id||id.length>128||!(/^[\w-]+$/.test(id)))throw new Error('Invalid scheduled Session');
  if(ctx.workspaceRegistry.archivedSessionIds.includes(id))throw new Error('Scheduled Session belongs to another context or was removed');
  if(registry){
   const owner=await registry.forSession(id);
   if(owner.kind!=='workspace'||owner.id!==context.id)throw new Error('Scheduled Session belongs to another context or was removed');
  }else if(!(await ctx.sessionController.list({cwd:context.directory})).items.some(row=>row.sessionId===id&&normalizeDirectory(row.cwd)===normalizeDirectory(context.directory)))throw new Error('Scheduled Session belongs to another context or was removed');
 };
 const input=async task=>{
  validateTaskInput(task);await owner(task.sessionId);
  return {title:task.title.trim(),prompt:task.prompt,sessionId:task.sessionId,rule:structuredClone(task.rule),enabled:task.enabled};
 };
 const arm=()=>{
  clearTimeout(timer);if(closed)return;
  const times=tasks.filter(t=>t.enabled&&t.nextRunAt).map(t=>Date.parse(t.nextRunAt));
  if(!times.length)return;
  timer=setTimeout(()=>{void serial(()=>ctx.agents.withoutInitiator(drive)).catch(error=>ctx.logger.error(`Scheduled tasks: ${String(error)}`));},Math.max(1,Math.min(2147483647,Math.min(...times)-Date.now())));
 };
 async function drive(){
  for(const task of tasks){
   if(closed)break;if(!task.enabled||!task.nextRunAt||Date.parse(task.nextRunAt)>Date.now())continue;
   const occurrence=occurrences(task.rule,task.timeZone,Date.now());
   const at=task.pending?.at??occurrence.latest;
   if(!at){task.nextRunAt=occurrence.next;continue;}
   try{
    await owner(task.sessionId);
    const resolved=await ctx.sessionController.resolveAgent(task.sessionId);if('error'in resolved)throw resolved.error;
    await owner(task.sessionId);
    if(closed)break;
    if(!task.pending){task.pending={at,message:createUserMessage({content:[{type:'text',text:`定时任务：${task.title}\n计划时间：${at}\n\n${task.prompt}`}],source:{kind:'schedule'}})};await save();}
    const inspection=await ctx.sessionController.inspect(task.sessionId);
    if(!inspection.events.some(event=>event.type==='user/message'&&event.data.id===task.pending.message.id))resolved.agent.followup(task.pending.message);
    if(!await ctx.sessions.flush(resolved.agent.session))throw new Error('Session persistence did not acknowledge scheduled message');
    task.lastRunAt=at;task.lastError=null;delete task.pending;
   }catch(error){task.lastError=String(error.message??error);}
   task.nextRunAt=occurrences(task.rule,task.timeZone,Date.now()).next;
   await save();
  }
  arm();
 }
 const manage=async request=>{
  if(request?.operation==='list')return tasks.map(view);
  if(request?.operation==='delete'){
   const index=tasks.findIndex(t=>t.id===request.id);if(index<0)throw new Error('Scheduled task not found');tasks.splice(index,1);return null;
  }
  if(request?.operation==='run'){
   const task=tasks.find(t=>t.id===request.id);if(!task)throw new Error('Scheduled task not found');
   // The message identity survives a lost response or a crash between Session
   // persistence and receipt persistence. The same manual request only queues once.
   const messageId='schedule-run-'+createHash('sha256').update(JSON.stringify([context.id,task.id,request.requestId])).digest('hex');
   await ctx.agents.withoutInitiator(async()=>{
    await owner(task.sessionId);
    const resolved=await ctx.sessionController.resolveAgent(task.sessionId);if('error'in resolved)throw resolved.error;
    await owner(task.sessionId);if(closed)throw new Error('Scheduled tasks are stopping');
    const inspection=await ctx.sessionController.inspect(task.sessionId);
    if(!inspection.events.some(event=>event.type==='user/message'&&event.data.id===messageId)){
     const message=createUserMessage({content:[{type:'text',text:`定时任务：${task.title}\n立即执行时间：${new Date().toISOString()}\n时区：${task.timeZone}\n\n${task.prompt}`}],source:{kind:'schedule'}});
     resolved.agent.followup(Object.freeze({...message,id:messageId}));
    }
    if(!await ctx.sessions.flush(resolved.agent.session))throw new Error('Session persistence did not acknowledge scheduled message');
   });
   task.lastRunAt=new Date().toISOString();task.lastError=null;
   return view(task);
  }
  if(!['create','update'].includes(request?.operation))throw new Error('Invalid scheduled task operation');
  const value=await input(request.task);const zone=Intl.DateTimeFormat().resolvedOptions().timeZone;
  const old=request.operation==='update'?tasks.find(t=>t.id===request.id):null;
  if(request.operation==='update'&&!old)throw new Error('Scheduled task not found');
  if(old&&old.sessionId!==value.sessionId)throw new Error('Scheduled task Session binding cannot change');
  const occurrence=occurrences(value.rule,zone,Date.now());
  const task={...value,id:old?.id??randomUUID(),timeZone:zone,nextRunAt:value.enabled?occurrence.next:null,lastRunAt:old?.lastRunAt??null,lastError:null};
  // An edit of content must not redeliver an occurrence already completed.
  if(task.nextRunAt&&task.lastRunAt&&task.nextRunAt<=task.lastRunAt)task.nextRunAt=occurrence.next;
  if(old)tasks[tasks.indexOf(old)]=task;else tasks.push(task);
  return view(task);
 };
 const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
 const dispatch=async body=>{
  const fields={list:['operation'],create:['operation','task','requestId'],update:['operation','id','task','requestId'],delete:['operation','id','requestId'],run:['operation','id','requestId']};
  exact(body,fields[body?.operation]??[]);
  if(body?.operation==='list')return manage(body);
  const {requestId,...payload}=body??{};
  if((requestId!==undefined||body.operation==='run')&&!requestIdentity(requestId))throw new Error('Invalid schedule request identity');
  const hash=createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex');
  if(requestId&&Object.hasOwn(requests,requestId)){
   const receipt=requests[requestId];if(receipt.hash!==hash)throw new Error('Schedule request identity was reused with different content');return receipt.value;
  }
  const previous=structuredClone(tasks);
  try{
   const value=await manage(body);
   if(requestId)Object.defineProperty(requests,requestId,{value:{hash,value},enumerable:true,configurable:true,writable:true});
   await save();arm();return value;
  }catch(error){tasks=previous;if(requestId)delete requests[requestId];throw error;}
 };
 ctx.connection.fetch.register({path:'/api/mind/schedules',methods:['POST'],requestBody:'buffered',async fetch(request){
  if(request.headers.get('content-type')?.split(';',1)[0]?.trim().toLowerCase()!=='application/json')return new Response('invalid content type',{status:415});
  let frame;try{frame=clientRequestSchema.parse(await request.json());}catch{return new Response('invalid request',{status:400});}
  if(frame.method!=='mind/schedules')return new Response('invalid method',{status:400});
  let result;try{result={ok:true,value:await serial(()=>dispatch(frame.payload?.args?.request))};}catch(error){result={ok:false,error:{code:'gateway/internal',message:String(error.message??error),details:{}}};}
  return Response.json({type:'server-response',rpcId:frame.rpcId,result});
 }});
 ctx.effect(()=>()=>{closed=true;clearTimeout(timer);return chain;});
 await serial(()=>ctx.agents.withoutInitiator(drive));
}
