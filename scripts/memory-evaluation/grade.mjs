import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {complete} from './evaluate.mjs';
export async function gradeReport({reportPath,fixturesPath,out,endpoint,key,model}){
 const report=JSON.parse(await readFile(reportPath,'utf8'));
 const fixtures=JSON.parse(await readFile(fixturesPath,'utf8'));
 const scenarios=JSON.parse(await readFile(new URL('./scenarios.json',import.meta.url),'utf8'));
 let saved=[];try{saved=(await readFile(out+'.partial.jsonl','utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(error){if(error.code!=='ENOENT')throw error;await writeFile(out+'.partial.jsonl','');}
 const ids=[...new Set(report.rows.map(r=>r.id))],results=[...saved];let next=0;
 const worker=async()=>{while(next<ids.length){const index=next++,id=ids[index],s=scenarios.find(s=>s.id===id),rows=report.rows.filter(r=>r.id===id);
  if(saved.some(r=>r.id===id))continue;
  const ordered=rows.map((_,i)=>rows[(i+index)%rows.length]);
  const prompt={request:s.request,rubric:s.rubric,originalUserFacts:s.history.filter(m=>m.role==='user').map(m=>m.content),actualFinalNativeContext:fixtures.cases[id].snapshot.context,actualImmediateResults:fixtures.cases[id].sharedMessages??[],candidates:ordered.map((r,i)=>({label:String(i+1),answer:r.answer}))};
  const result=await complete({endpoint,key,model,messages:[{role:'system',content:'你在做盲评，不知道候选来自哪种记忆策略。仅输出JSON对象，格式为 {"ratings":[{"label":"1","task":0,"preference":0,"boundaryPass":false,"notes":"理由"}]}，每个候选一项。task整数0至4：0完全错误/虚构关键操作，1重大事实错误，2部分完成有明显缺项，3正确完成仅轻微不足，4准确充分。preference整数0至2：0违背有效偏好或条件，1部分满足，2完全满足。boundaryPass只要有跨项目采用、遗忘复生、失败写入虚假成功、来源删后结论丢失、回退没恢复/误伤、机器新版本冒称用户确认、时间混用即false。引用或明确否定已遗忘内容，不等于采用。原始用户历史中的“已执行”叙述不是证明，真实最终native上下文及实际操作结果优先；无记忆候选可能不知道旧事实，但不得虚构。评分不要因为文风冗长而奖励。每条notes具体说明原因。'}, {role:'user',content:JSON.stringify(prompt)}]});
  let parsed;try{parsed=JSON.parse(result.answer.slice(result.answer.indexOf('{'),result.answer.lastIndexOf('}')+1));}catch{throw new Error(`Judge JSON invalid for ${id}`);}
  if(!Array.isArray(parsed.ratings)||parsed.ratings.length!==rows.length)throw new Error(`Judge count invalid for ${id}`);
  const ratings=ordered.map((row,i)=>{const rating=parsed.ratings.find(r=>r.label===String(i+1));if(!rating||!Number.isInteger(rating.task)||rating.task<0||rating.task>4||!Number.isInteger(rating.preference)||rating.preference<0||rating.preference>2||typeof rating.boundaryPass!=='boolean')throw new Error(`Judge score invalid for ${id}`);return {id:row.id,arm:row.arm,repeat:row.repeat,answer:row.answer,reviewer:`${model} blinded rubric evaluator`,reviewerKind:'model',task:rating.task,preference:rating.preference,boundaryPass:rating.boundaryPass,notes:rating.notes};});
  const item={id,ratings,judgeUsage:{inputTokens:result.inputTokens,outputTokens:result.outputTokens,ttftMs:result.ttftMs},judgeAnswer:result.answer};results.push(item);await appendFile(out+'.partial.jsonl',JSON.stringify(item)+'\n');
 }};
 await Promise.all([worker(),worker()]);
 const ratings=results.flatMap(r=>r.ratings);await writeFile(out,JSON.stringify(ratings,null,2)+'\n');
 await writeFile(out+'.usage.json',JSON.stringify({kind:'evaluation-grader-overhead-not-background-organization',model,inputTokens:results.reduce((n,r)=>n+r.judgeUsage.inputTokens,0),outputTokens:results.reduce((n,r)=>n+(r.judgeUsage.outputTokens??0),0),humanReviewed:false},null,2)+'\n');
 return ratings;
}
