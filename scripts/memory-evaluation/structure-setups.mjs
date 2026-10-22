import {readFileSync,writeFileSync} from 'node:fs';
const path=new URL('./scenarios.json',import.meta.url);
const data=JSON.parse(readFileSync(path));
const drift=['所有状态汇报用三行摘要','开发及测试环境允许模拟支付','采购报价需要三家比价','每两周一次复盘','项目保留最近十二个月的指标汇总'];
const rollback=['所有文档都省略推导','销售试点扩大到全国','培训先练习再演示','技术讨论不保留反例','新客户直接全量部署'];
const selectors=[['推导','笔记'],['试点','华东'],['培训','演示'],['反例'],['试用','客户']];
const temporal=[['五万','5万'],['旧版本','10次'],['百分之五','5%'],['三十','30'],['周末']];
for(const s of data){
 const userTurns=s.history.filter(m=>m.role==='user');const first=userTurns[0].content,second=userTurns[1].content,index=Number(s.id.split('-').at(-1))-1;
 const steps=[]; let shared=[];
 if(s.family==='isolation'){
  const [a,b]=first.split('；');steps.push({type:'native',action:'seedForeign',content:a});
  steps.push({type:'dsh',text:`请使用记忆工具实际保存当前项目乙的项目约定：${b} 不要保存到工作区，不要采用其他项目约定。`});
 }else steps.push({type:'dsh',text:`请使用记忆工具实际保存以下用户提供的长期事实或偏好，独立事实分别保存，场景条件写入condition，不要只口头答应：${first}`});
 if(['report','technical','synonym'].includes(s.family)){steps.push({type:'dsh',text:`以下是本次任务的短期情况，暂时不用新增记忆：${second}`});shared=[{role:'user',content:second}];}
 else if(['forget','independent_source'].includes(s.family))steps.push({type:'dsh',text:`请实际执行这项用户要求：${second}`},{type:'native',action:'probeSuppression'});
 else if(s.family==='failed_write'){
  steps[0].injectNativeFailure=true;
  steps.push({type:'dsh',text:'请核对刚才真实的保存结果。如果原生服务拒绝了保存，请如实告诉我，不要再次尝试保存。'});
 }
 else if(s.family==='source_removed')steps.push({type:'native',action:'attachAndDeleteSource'},{type:'dsh',text:'来源文档现在已被实际删除。只查询已保存的结论，不修改或重新记忆。'});
 else if(s.family==='rollback'){
  if(index===0)steps[0].text+='另一个独立偏好是配色使用蓝色，请单独保存。';
  steps.push({type:'native',action:'organizeAndRollback',selectors:selectors[index],content:rollback[index]},{type:'dsh',text:'刚才原生整理操作已执行并撤回。请只查询当前记忆版本及其他独立条目，不要修改。'});
 }
 else if(s.family==='confirmed_drift')steps.push({type:'native',action:'organize',content:drift[index]},{type:'dsh',text:'请只查询当前原生记忆的内容和确认状态，不要修改，不要把机器生成版本说成用户确认。'});
 else if(s.family==='current')steps.push({type:'native',action:'expireOld',selectors:temporal[index]},{type:'dsh',text:'只查询现在生效的规则，不要把过期版本作为当前约定，不要修改。'});
 else if(s.family==='history')steps.push({type:'dsh',text:`请保留并区分历史和当前两个阶段的记忆，保持阶段条件，不要合并：${second}`});
 else steps.push({type:'dsh',text:'仅查询当前项目已保存的约定，不要修改。'});
 s.history=userTurns;s.setup={requiresNativeExecution:true,steps};s.sharedMessages=shared;
}
writeFileSync(path,JSON.stringify(data,null,2)+'\n');
