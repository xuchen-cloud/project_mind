import { test } from 'node:test';
import assert from 'node:assert/strict';
import { occurrences } from '../scripts/scheduled-tasks-time.mjs';
test('every two days follows local calendar and skips missing DST time', () => {
 const rule={kind:'days',interval:2,startDate:'2026-03-06',time:'02:30'};
 assert.deepEqual(occurrences(rule,'America/New_York','2026-03-07T00:00:00Z'),{latest:'2026-03-06T07:30:00.000Z',next:'2026-03-10T06:30:00.000Z'});
});
test('every two weeks anchors ISO weekdays to the start week',()=>{
 assert.deepEqual(occurrences({kind:'weeks',interval:2,startDate:'2026-10-21',time:'09:00',weekdays:[1,5]},'Asia/Shanghai','2026-10-30T12:00:00Z'),{latest:'2026-10-23T01:00:00.000Z',next:'2026-11-02T01:00:00.000Z'});
});
test('monthly day 31 skips shorter months',()=>{
 assert.deepEqual(occurrences({kind:'monthly',startDate:'2026-01-01',time:'09:00',dayOfMonth:31},'UTC','2026-02-20T00:00:00Z'),{latest:'2026-01-31T09:00:00.000Z',next:'2026-03-31T09:00:00.000Z'});
});
test('DST overlap happens once at the first instant',()=>{
 assert.deepEqual(occurrences({kind:'days',interval:1,startDate:'2026-10-31',time:'01:30'},'America/New_York','2026-11-01T06:00:00Z'),{latest:'2026-11-01T05:30:00.000Z',next:'2026-11-02T06:30:00.000Z'});
});
test('weekdays skip weekends and hourly recurrence uses elapsed duration',()=>{
 assert.deepEqual(occurrences({kind:'weekdays',startDate:'2026-10-23',time:'09:00'},'UTC','2026-10-24T12:00:00Z'),{latest:'2026-10-23T09:00:00.000Z',next:'2026-10-26T09:00:00.000Z'});
 assert.deepEqual(occurrences({kind:'hours',interval:24,startDate:'2026-03-07',time:'09:00'},'America/New_York','2026-03-08T14:30:00Z'),{latest:'2026-03-08T14:00:00.000Z',next:'2026-03-09T14:00:00.000Z'});
});
test('hourly start in a DST gap skips the nonexistent occurrence',()=>{
 assert.deepEqual(occurrences({kind:'hours',interval:1,startDate:'2026-03-08',time:'02:30'},'America/New_York','2026-03-08T07:00:00Z'),{latest:null,next:'2026-03-08T07:30:00.000Z'});
});

import { validateTaskInput, validateStore, requestIdentity } from '../scripts/scheduled-tasks-schema.mjs';
test('schedule boundaries reject unknown rule and task fields and corrupt stored state',()=>{
 const input={title:'Fixture',prompt:'Do work',sessionId:'session-fixture',enabled:true,rule:{kind:'days',interval:1,startDate:'2026-10-24',time:'09:00'}};
 assert.throws(()=>validateTaskInput({...input,timeZone:'UTC'}));
 assert.throws(()=>validateTaskInput({...input,rule:{...input.rule,weekdays:[1]}}));
 const task={...input,id:'task-fixture',timeZone:'UTC',nextRunAt:'2026-10-25T09:00:00.000Z',lastRunAt:null,lastError:null};
 assert.doesNotThrow(()=>validateStore({version:1,tasks:[task]}));
 assert.throws(()=>validateStore({version:1,tasks:[{...task,nextRunAt:'tomorrow'}]}));
 assert.throws(()=>validateStore({version:1,tasks:[{...task,timeZone:'invalid/timezone'}]}));
 assert.throws(()=>validateStore({version:1,tasks:[{...task,pending:{at:task.nextRunAt,message:{id:'fixture',role:'assistant',source:{kind:'schedule'},content:[]}}}]}));
 assert.equal(requestIdentity('req:2026-10-24'),true);
 assert.equal(requestIdentity('中'.repeat(43)),false);
});
