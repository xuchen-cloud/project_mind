import {readFile,writeFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
const dir=process.argv[2];if(!dir)throw new Error('Pass the explicit native full60 output directory');
const fixturePath=join(dir,'native-full-fixtures.json');
const fixtures=JSON.parse(await readFile(fixturePath,'utf8'));
const files=(await readdir(dir)).filter(f=>f.endsWith('.complete.json'));
const cases=[];
for(const file of files){
 const result=JSON.parse(await readFile(join(dir,file),'utf8'));
 const active=result.finalState.facts.filter(f=>f.state==='active');
 let provider=[];try{provider=JSON.parse(await readFile(join(dir,result.id+'.provider.json'),'utf8'));}catch{}
 const behaviorRevisions=new Set();let sharedInstructions;
 for(const exchange of provider)for(const message of exchange.request.messages??[]){
  const text=typeof message.content==='string'?message.content:Array.isArray(message.content)?message.content.map(x=>x.text??'').join('\n'):'';
  if(text.startsWith('Current authoritative memory.')){try{const snapshot=JSON.parse(text.slice(text.indexOf('\n')+1));if(snapshot.behavior?.revision)behaviorRevisions.add(snapshot.behavior.revision);if(snapshot.behavior?.content)sharedInstructions={memoryPrelude:text.slice(0,text.indexOf('\n')),behavior:snapshot.behavior.content,behaviorRevision:snapshot.behavior.revision};}catch{}}
 }
 const contextCalls=result.bridge.filter(r=>r.request?.request?.operation==='context');
 const scope=contextCalls.at(-1)?.request.request.scope;
 if(!sharedInstructions||!scope)throw new Error(`Missing actual production prompt/scope ${result.id}`);
 sharedInstructions.scope=scope.kind==='project'?{...scope,projectName:'项目乙'}:scope;
 sharedInstructions.scopeProvenance='actual native context request; 项目乙 name from full_case native create_project fixture';
 const arms=Object.fromEntries(['snapshot','layered'].map(arm=>{const f=result.fixture[arm],memory=JSON.parse(f.context);return [arm,{returnedFactCount:memory.facts.length,suppressedCount:memory.negativeConstraints.length,serializedBytes:Buffer.byteLength(f.context),evidence:f.evidence}];}));
 const successfulMemoryWriteObserved=result.bridge.some(r=>r.request?.request?.operation==='apply'&&r.ok===true);
 cases.push({id:result.id,actualUserTurns:result.actualUserTurns,activeFactCount:active.length,successfulMemoryWriteObserved,setupPassed:result.setupPassed,nativeFailures:result.nativeActions.filter(a=>a.ok!==true),arms,behaviorRevisions:[...behaviorRevisions],sourceFingerprint:result.sourceFingerprint??null,sourceFingerprintNote:result.sourceFingerprint?'recorded on completion':'early batch: no exact source fingerprint captured; actual Provider/bridge/state transcripts retained'});
 fixtures.cases[result.id]={...result.fixture,sharedInstructions,activeFactCount:active.length};
}
const counts=cases.map(c=>c.activeFactCount);
const report={completed:cases.length,actualUserTurns:cases.reduce((n,c)=>n+c.actualUserTurns,0),activeFacts:{min:Math.min(...counts),max:Math.max(...counts),mean:counts.reduce((a,b)=>a+b,0)/counts.length,distribution:Object.fromEntries([...new Set(counts)].sort().map(n=>[n,counts.filter(c=>c===n).length]))},setupFailures:cases.filter(c=>!c.setupPassed).map(c=>c.id),nativeBoundaryFailures:cases.flatMap(c=>Object.entries(c.arms).flatMap(([arm,a])=>Object.entries(a.evidence).filter(([key,value])=>key!=='rollbackMs'&&value!==true).map(([check])=>({id:c.id,arm,check})))),limitations:['These isolated cases contain few saved facts; do not extrapolate savings to hundreds of long-term memories.','Earlier passing cases are reused across the explicitly documented behavior/protocol batches; source fingerprints are absent for the earliest batch.','Native organization fixtures are not production background-model organization.'],cases};
const backgroundPaths=process.argv.slice(3);
if(backgroundPaths.length){const attempts=[];for(const path of backgroundPaths){const r=JSON.parse(await readFile(path,'utf8'));const raw=r.backgroundOrganizationUsage;attempts.push({reportPath:path,passed:r.passed,checks:r.checks,actualGenerationCalls:r.actualGenerationCalls,actualCapacityCalls:r.actualCapacityCalls,raw,inputTokens:(raw.inputTokens??0)+(raw.cacheReadTokens??0),outputTokens:raw.outputTokens});}
 const successful=attempts.findLast(a=>a.passed===true&&Object.values(a.checks).every(Boolean));
 if(successful)fixtures.provenance.backgroundOrganizationUsage={inputTokens:successful.inputTokens,outputTokens:successful.outputTokens,raw:successful.raw,reportPath:successful.reportPath};
 fixtures.provenance.backgroundOrganizationAttempts=attempts;
 fixtures.provenance.backgroundOrganizationTotalUsage={inputTokens:attempts.reduce((n,a)=>n+a.inputTokens,0),outputTokens:attempts.reduce((n,a)=>n+a.outputTokens,0)};
}
fixtures.provenance.promptProtocol='captured-production-memory-prelude-skill-trusted-scope-v2';
fixtures.provenance.setupAuditPath=join(dir,'setup-audit.json');
fixtures.provenance.sampleActiveFacts=report.activeFacts;
fixtures.provenance.sourceBatches=cases.map(c=>({id:c.id,behaviorRevisions:c.behaviorRevisions,sourceFingerprint:c.sourceFingerprint}));
await writeFile(fixturePath,JSON.stringify(fixtures,null,2)+'\n');
await writeFile(join(dir,'setup-audit.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({completed:report.completed,actualUserTurns:report.actualUserTurns,activeFacts:report.activeFacts,setupFailures:report.setupFailures,nativeBoundaryFailures:report.nativeBoundaryFailures}));
