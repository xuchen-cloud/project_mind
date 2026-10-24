import { Temporal } from '@js-temporal/polyfill';

export function validateRule(rule) {
 if (!rule || !['hours','days','weekdays','weeks','monthly'].includes(rule.kind)
   || !/^\d{4}-\d{2}-\d{2}$/.test(rule.startDate) || !/^\d{2}:\d{2}$/.test(rule.time)) throw new Error('Invalid schedule rule');
 const keys=['kind','startDate','time',...(['hours','days','weeks'].includes(rule.kind)?['interval']:[]),...(rule.kind==='weeks'?['weekdays']:[]),...(rule.kind==='monthly'?['dayOfMonth']:[])];
 if(Object.keys(rule).some(key=>!keys.includes(key)))throw new Error('Invalid schedule rule fields');
 Temporal.PlainDate.from(rule.startDate); Temporal.PlainTime.from(rule.time);
 if (['hours','days','weeks'].includes(rule.kind) && (!Number.isSafeInteger(rule.interval)||rule.interval<1||rule.interval>10000)) throw new Error('Invalid schedule interval');
 if (rule.kind==='weeks' && (!Array.isArray(rule.weekdays)||!rule.weekdays.length||rule.weekdays.some(d=>!Number.isInteger(d)||d<1||d>7)||new Set(rule.weekdays).size!==rule.weekdays.length)) throw new Error('Invalid schedule weekdays');
 if(rule.kind==='monthly'&&(!Number.isInteger(rule.dayOfMonth)||rule.dayOfMonth<1||rule.dayOfMonth>31)) throw new Error('Invalid monthly day');
 return rule;
}
// Calendar recurrences preserve wall time. Reject gaps, choose the first overlap.
function instant(date,time,zone) {
 const local=date.toPlainDateTime(time);
 const value=local.toZonedDateTime(zone,{disambiguation:'earlier'});
 return value.toPlainDateTime().equals(local)?value.epochMilliseconds:null;
}
export function occurrences(rule,zone,now) {
 validateRule(rule);
 const at=typeof now==='number'?now:Date.parse(now);
 const start=Temporal.PlainDate.from(rule.startDate), time=Temporal.PlainTime.from(rule.time);
 const today=Temporal.Instant.fromEpochMilliseconds(at).toZonedDateTimeISO(zone).toPlainDate();
 let latest=null,next=null;
 const take=ms=>{if(ms===null)return;if(ms<=at)latest=latest===null?ms:Math.max(latest,ms);else next=next===null?ms:Math.min(next,ms);};
 if(rule.kind==='hours') {
  const valid=instant(start,time,zone);
  const first=valid??start.toPlainDateTime(time).toZonedDateTime(zone,{disambiguation:'earlier'}).epochMilliseconds;
  const minimum=valid===null?1:0;
  const step=rule.interval*3600000, n=Math.floor((at-first)/step);
  if(n>=minimum)take(first+n*step);take(first+Math.max(minimum,n+1)*step);
 } else if(rule.kind==='monthly') {
  const base=start.with({day:1});
  const distance=(today.year-base.year)*12+today.month-base.month;
  for(let i=Math.max(0,distance-14);i<=Math.max(0,distance)+14;i++) {
   const month=base.add({months:i});if(rule.dayOfMonth>month.daysInMonth)continue;
   const date=month.with({day:rule.dayOfMonth});if(Temporal.PlainDate.compare(date,start)>=0)take(instant(date,time,zone));
  }
 } else {
  const bases=rule.kind==='weeks'?rule.weekdays.map(day=>start.subtract({days:start.dayOfWeek-1}).add({days:day-1})): [start];
  const step=rule.kind==='days'?rule.interval:rule.kind==='weeks'?rule.interval*7:1;
  for(const base of bases){
   const distance=base.until(today,{largestUnit:'days'}).days;
   const center=Math.floor(distance/step);
   for(let i=Math.max(0,center-8);i<=Math.max(0,center)+8;i++){
    const date=base.add({days:i*step});
    if(Temporal.PlainDate.compare(date,start)<0 || rule.kind==='weekdays'&&date.dayOfWeek>5)continue;
    take(instant(date,time,zone));
   }
  }
 }
 return {latest:latest===null?null:new Date(latest).toISOString(),next:next===null?null:new Date(next).toISOString()};
}
