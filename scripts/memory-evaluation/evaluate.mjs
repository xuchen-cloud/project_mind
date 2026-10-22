#!/usr/bin/env node
import {readFile,writeFile,mkdir,appendFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
export const ARMS = ['none','snapshot','layered'];
export const BOUNDARIES = {isolation:'isolated',forget:'suppressionPreserved',failedWrite:'writeReceiptTruthful',sourceRemoved:'retainedConclusionAvailable',rollback:'restoredAndUnrelatedPreserved',organization:'newVersionInferred',time:'validityRespected'};
export function checkFeatures(scenario,answer) {
  return {required:scenario.checks.required.map(pattern=>({pattern,pass:new RegExp(pattern,'u').test(answer)})),forbidden:scenario.checks.forbidden.map(pattern=>({pattern,pass:!new RegExp(pattern,'u').test(answer)}))};
}
export async function complete({endpoint,key,model,messages,fetchImpl=fetch}) {
  const start=performance.now();
  const response=await fetchImpl(endpoint,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${key}`},body:JSON.stringify({model,messages,temperature:0,stream:true,stream_options:{include_usage:true}}),signal:AbortSignal.timeout(120000)});
  if(!response.ok) throw new Error(`Provider HTTP ${response.status}`); // Never print provider response/error bodies: may contain credentials.
  let text='',ttftMs=null,usage=null,buffer='',done=false;
  const decoder=new TextDecoder();
  const consume=block=>{
    const data=block.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
    if(!data)return;
    if(data==='[DONE]'){done=true;return;}
    let event;try{event=JSON.parse(data);}catch{throw new Error('Provider returned invalid SSE JSON');}
    if(event.error)throw new Error('Provider stream returned an error');
    if(event.usage)usage=event.usage;
    const delta=event.choices?.[0]?.delta?.content;
    if(typeof delta==='string'&&delta.length){ttftMs??=performance.now()-start;text+=delta;}
  };
  for await(const chunk of response.body){buffer=(buffer+decoder.decode(chunk,{stream:true})).replace(/\r\n/g,'\n');let at;while((at=buffer.indexOf('\n\n'))>=0){consume(buffer.slice(0,at));buffer=buffer.slice(at+2);}}
  buffer+=decoder.decode();if(buffer.trim())consume(buffer);
  if(!done||ttftMs===null||!Number.isFinite(usage?.prompt_tokens))throw new Error('Incomplete stream or missing actual prompt usage/first content');
  return {answer:text,ttftMs,elapsedMs:performance.now()-start,inputTokens:usage.prompt_tokens,outputTokens:usage.completion_tokens??null,cachedInputTokens:usage.prompt_tokens_details?.cached_tokens??usage.prompt_cache_hit_tokens??null};
}
export function validateFixtures(fixtures,scenarios,{allowFixture=false}={}) {
  if(!['native','local-provider-fixture'].includes(fixtures.provenance?.kind))throw new Error('Native fixture provenance required');
  if(fixtures.provenance.kind!=='native'&&!allowFixture)throw new Error('Local fixture cannot be used for semantic evaluation');
  if(!fixtures.provenance.revision||!fixtures.provenance.command)throw new Error('Provenance revision and reproduction command required');
  for(const s of scenarios){const c=fixtures.cases?.[s.id];if(!c)throw new Error(`Missing native case ${s.id}`);
    for(const arm of ['snapshot','layered'])if(typeof c[arm]?.context!=='string')throw new Error(`Missing context ${s.id}/${arm}`);
    if(typeof c.sharedInstructions?.memoryPrelude!=='string'||typeof c.sharedInstructions?.behavior!=='string'||!['project','workspace'].includes(c.sharedInstructions?.scope?.kind))throw new Error(`Missing captured production instructions/scope ${s.id}`);
    if(c.sharedMessages&&!c.sharedMessages.every(m=>['user','assistant','system'].includes(m.role)&&typeof m.content==='string'))throw new Error(`Invalid shared messages ${s.id}`);
  }
}
export function messagesForArm(scenario,fixture,arm) {
  const shared=fixture.sharedInstructions;
  const messages=[{role:'system',content:shared.behavior},{role:'system',content:`Trusted current scope: ${JSON.stringify(shared.scope)}`}];
  messages.push(...(fixture.sharedMessages??[]));
  if(arm!=='none')messages.push({role:'system',content:`${shared.memoryPrelude}\n${fixture[arm].context}`});
  messages.push({role:'user',content:scenario.request});
  return messages;
}
export async function run({scenarios,fixtures,endpoint,key,model,repetitions=1,concurrency=1,cachedRows=[],allowFixture=false,onRow=()=>{}}) {
  validateFixtures(fixtures,scenarios,{allowFixture});
  if(!Number.isInteger(concurrency)||concurrency<1||concurrency>3)throw new Error('Concurrency must be 1..3');
  const rows=[],jobs=[];
  for(let repeat=0;repeat<repetitions;repeat++)for(let i=0;i<scenarios.length;i++)jobs.push({repeat,i});
  let next=0;
  const worker=async()=>{while(next<jobs.length){const {repeat,i}=jobs[next++];
    const scenario=scenarios[i],fixture=fixtures.cases[scenario.id];
    // Rotate arm order to reduce provider warm-cache/time bias; same model and prompt each arm.
    for(let a=0;a<3;a++){
      const arm=ARMS[(a+i+repeat)%3],memory=arm==='none'?'':fixture[arm].context;
      const messages=messagesForArm(scenario,fixture,arm);
      const cached=cachedRows.find(r=>r.id===scenario.id&&r.arm===arm&&r.repeat===repeat);
      if(cached){rows.push(cached);continue;}
      const result=await complete({endpoint,key,model,messages});
      let returnedMemoryFactCount=0;if(arm!=='none'){try{returnedMemoryFactCount=JSON.parse(memory).facts.length;}catch{returnedMemoryFactCount=null;}}
      const row={id:scenario.id,dimension:scenario.dimension,arm,repeat,returnedMemoryFactCount,memoryChars:memory.length,memoryUtf8Bytes:Buffer.byteLength(memory),...result,features:checkFeatures(scenario,result.answer),nativeEvidence:arm==='none'?null:fixture[arm].evidence??null};
      rows.push(row);await onRow(row);
    }
  }};
  await Promise.all(Array.from({length:concurrency},worker));
  // Prompt usage differences include memory message framing. They are measured marginal input, not tokenizer estimates.
  for(const row of rows){const base=rows.find(x=>x.id===row.id&&x.repeat===row.repeat&&x.arm==='none');row.marginalMemoryInputTokens=row.inputTokens-base.inputTokens;}
  return {schemaVersion:1,createdAt:new Date().toISOString(),model,provenance:fixtures.provenance,semanticEligible:fixtures.provenance.kind==='native',scenarios:scenarios.map(s=>({id:s.id,dimension:s.dimension,request:s.request,rubric:s.rubric,activeFactCount:fixtures.cases[s.id].activeFactCount??null})),rows};
}
const mean=xs=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;
export function summarize(report,ratings=[]) {
  const expected=report.rows.length;
  const pairs=new Set(report.rows.map(r=>JSON.stringify([r.id,r.repeat])));
  const completeArms=expected>0&&expected===pairs.size*3&&[...pairs].every(pair=>{const [id,repeat]=JSON.parse(pair);return ARMS.every(arm=>report.rows.filter(r=>r.id===id&&r.repeat===repeat&&r.arm===arm&&Number.isFinite(r.inputTokens)&&r.inputTokens>=0&&Number.isFinite(r.ttftMs)&&r.ttftMs>=0&&Number.isFinite(r.marginalMemoryInputTokens)&&r.marginalMemoryInputTokens>=0).length===1);});
  const completeRatings=ratings.length===expected&&report.rows.every(row=>ratings.filter(r=>r.id===row.id&&r.arm===row.arm&&r.repeat===row.repeat&&r.answer===row.answer&&typeof r.reviewer==='string'&&r.reviewer.trim()&&Number.isInteger(r.task)&&r.task>=0&&r.task<=4&&Number.isInteger(r.preference)&&r.preference>=0&&r.preference<=2&&typeof r.boundaryPass==='boolean').length===1);
  const arms=Object.fromEntries(ARMS.map(arm=>{const rs=report.rows.filter(r=>r.arm===arm),scores=ratings.filter(r=>r.arm===arm);return [arm,{count:rs.length,meanInputTokens:mean(rs.map(r=>r.inputTokens)),meanMemoryInputTokens:mean(rs.map(r=>r.marginalMemoryInputTokens)),meanSerializedMemoryBytes:mean(rs.map(r=>r.memoryUtf8Bytes??0)),meanReturnedMemoryFacts:mean(rs.map(r=>r.returnedMemoryFactCount??0)),meanTtftMs:mean(rs.map(r=>r.ttftMs)),task:completeRatings?mean(scores.map(r=>r.task)):null,preference:completeRatings?mean(scores.map(r=>r.preference)):null}];}));
  const byDimension=Object.fromEntries([...new Set(report.rows.map(r=>r.dimension))].map(dimension=>[dimension,Object.fromEntries(ARMS.map(arm=>{const rs=report.rows.filter(r=>r.dimension===dimension&&r.arm===arm);const scores=ratings.filter(r=>rs.some(x=>x.id===r.id&&x.repeat===r.repeat&&x.arm===r.arm));return [arm,{count:rs.length,featureScreenPassRate:mean(rs.map(r=>[...r.features.required,...r.features.forbidden].every(x=>x.pass)?1:0)),task:completeRatings?mean(scores.map(r=>r.task)):null,preference:completeRatings?mean(scores.map(r=>r.preference)):null,boundaryPassRate:completeRatings?mean(scores.map(r=>r.boundaryPass?1:0)):null}];}))]));
  const nativeBoundaries=report.rows.filter(r=>r.arm!=='none'&&BOUNDARIES[r.dimension]).every(r=>r.nativeEvidence?.[BOUNDARIES[r.dimension]]===true&&(r.dimension!=='rollback'||Number.isFinite(r.nativeEvidence.rollbackMs)&&r.nativeEvidence.rollbackMs<=2000));
  const featurePass=report.rows.filter(r=>r.arm!=='none').every(r=>[...r.features.required,...r.features.forbidden].every(x=>x.pass));
  const a=arms.snapshot,b=arms.layered,reduction=a.meanMemoryInputTokens>0?1-b.meanMemoryInputTokens/a.meanMemoryInputTokens:null;
  const qualityPass=completeRatings&&b.task>=a.task&&b.preference>=a.preference;
  const lifecycleMeasured=report.provenance.realConversationExecution===true&&Number.isFinite(report.provenance.backgroundOrganizationUsage?.inputTokens)&&Number.isFinite(report.provenance.backgroundOrganizationUsage?.outputTokens);
  const humanReviewed=completeRatings&&ratings.every(r=>r.reviewerKind==='human');
  const gate=report.semanticEligible&&completeArms&&lifecycleMeasured&&new Set(report.rows.map(r=>r.id)).size>=50&&new Set(report.rows.map(r=>r.id)).size<=100&&completeRatings&&nativeBoundaries&&featurePass&&ratings.filter(r=>r.arm!=='none').every(r=>r.boundaryPass)&&qualityPass&&reduction!==null&&reduction>=0.35&&b.meanTtftMs<=a.meanTtftMs;
  return {gate:gate?'candidate-pass-requires-integration-review':'not-passed',defaultStrategy:'snapshot',arms,byDimension,memoryInputReduction:reduction,completeRatings,humanReviewed,completeArms,nativeBoundaries,featurePass,qualityPass,lifecycleMeasured,backgroundOrganizationUsage:report.provenance.backgroundOrganizationUsage??'not-measured',limitations:['Regex features only screen answers; complete attributed rubric scoring and native boundary evidence remain mandatory.','Prompt-token differences measure marginal memory input including message framing.','TTFT is first visible content, not first reasoning/transport event.','A candidate pass never changes runtime defaults.']};
}
async function main(){
  const args=process.argv.slice(2),opt=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
  const out=resolve(opt('--out')??'memory-evaluation-report.json');
  if(opt('--summarize')){const report=JSON.parse(await readFile(opt('--summarize'),'utf8'));const ratings=opt('--ratings')?JSON.parse(await readFile(opt('--ratings'),'utf8')):[];await writeFile(out,JSON.stringify(summarize(report,ratings),null,2)+'\n');return;}
  if(!opt('--fixtures'))throw new Error('--fixtures is required; no synthetic default contexts');
  const endpoint=process.env.MEMORY_EVAL_ENDPOINT,key=process.env.MEMORY_EVAL_API_KEY,model=process.env.MEMORY_EVAL_MODEL;
  if(!endpoint||!key||!model)throw new Error('Set MEMORY_EVAL_ENDPOINT, MEMORY_EVAL_API_KEY, MEMORY_EVAL_MODEL');
  const url=new URL(endpoint);if(url.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('Remote Provider must use HTTPS');
  const scenarios=JSON.parse(await readFile(new URL('./scenarios.json',import.meta.url),'utf8'));
  const fixtures=JSON.parse(await readFile(opt('--fixtures'),'utf8'));
  const repetitions=Number(opt('--repetitions')??1);if(!Number.isInteger(repetitions)||repetitions<1||repetitions>10)throw new Error('Repetitions must be 1..10');
  await mkdir(dirname(out),{recursive:true});
  await writeFile(out+'.partial.jsonl','');
  const report=await run({scenarios,fixtures,endpoint,key,model,repetitions,onRow:async row=>{await appendFile(out+'.partial.jsonl',JSON.stringify(row)+'\n');}});
  await writeFile(out,JSON.stringify(report,null,2)+'\n');
  await writeFile(out+'.ratings.json',JSON.stringify(report.rows.map(r=>({id:r.id,arm:r.arm,repeat:r.repeat,answer:r.answer,reviewer:'',task:null,preference:null,boundaryPass:null,notes:''})),null,2)+'\n');
  await writeFile(out+'.summary.json',JSON.stringify(summarize(report),null,2)+'\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
