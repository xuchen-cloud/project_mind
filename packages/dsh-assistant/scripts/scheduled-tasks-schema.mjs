import { validateRule } from './scheduled-tasks-time.mjs';
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export function exact(value,keys) {if(!object(value)||Object.keys(value).some(key=>!keys.includes(key)))throw new Error('Invalid scheduled task fields');}
const id=value=>typeof value==='string'&&/^[\w-]{1,128}$/.test(value);
export const requestIdentity=value=>typeof value==='string'&&Buffer.byteLength(value,'utf8')>=1&&Buffer.byteLength(value,'utf8')<=128;
const instant=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
export function validateTaskInput(task) {
 exact(task,['title','prompt','sessionId','rule','enabled']);
 if(typeof task.title!=='string'||!task.title.trim()||task.title.length>200||typeof task.prompt!=='string'||!task.prompt.trim()||task.prompt.length>32000||typeof task.enabled!=='boolean'||!id(task.sessionId))throw new Error('Invalid scheduled task');
 validateRule(task.rule);return task;
}
export function validateStoredTask(task) {
 exact(task,['title','prompt','sessionId','rule','enabled','id','timeZone','nextRunAt','lastRunAt','lastError','pending']);
 const {title,prompt,sessionId,rule,enabled}=task;validateTaskInput({title,prompt,sessionId,rule,enabled});
 if(!id(task.id)||typeof task.timeZone!=='string'||!(/^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)*$/.test(task.timeZone))||[task.nextRunAt,task.lastRunAt].some(at=>at!==null&&!instant(at))||task.lastError!==null&&typeof task.lastError!=='string'||!task.enabled&&task.nextRunAt!==null)throw new Error('Invalid scheduled task state');
 new Intl.DateTimeFormat('en',{timeZone:task.timeZone});
 if(task.pending!==undefined){
  exact(task.pending,['at','message']);const message=task.pending.message;
  exact(message,['id','role','source','content']);exact(message.source,['kind']);
  if(!instant(task.pending.at)||!id(message.id)||message.role!=='user'||message.source.kind!=='schedule'||!Array.isArray(message.content)||message.content.length!==1)throw new Error('Invalid pending scheduled message');
  exact(message.content[0],['type','text']);if(message.content[0].type!=='text'||typeof message.content[0].text!=='string'||!message.content[0].text)throw new Error('Invalid pending scheduled content');
 }
 return task;
}
export function validateStore(store) {
 exact(store,['version','tasks','requests']);
 if(store.version!==1||!Array.isArray(store.tasks)||new Set(store.tasks.map(t=>t?.id)).size!==store.tasks.length)throw new Error('Invalid scheduled task store');
 store.tasks.forEach(validateStoredTask);
 if(store.requests!==undefined){
  if(!object(store.requests))throw new Error('Invalid scheduled task receipts');
  for(const [key,receipt] of Object.entries(store.requests)){
   exact(receipt,['hash','value']);if(!requestIdentity(key)||typeof receipt.hash!=='string'||!/^[a-f0-9]{64}$/.test(receipt.hash))throw new Error('Invalid scheduled request receipt');
   if(receipt.value!==null)validateStoredTask(receipt.value);
  }
 }
 return store;
}
