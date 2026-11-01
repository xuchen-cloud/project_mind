import {expect, it} from 'vitest';
import {FileEditSession} from './file-edit-session';
import type {FileWorkingOpen, FileWorkingSaved} from '../services/fileWorkingApi';

const opened: FileWorkingOpen = {object:{workspaceId:'w',scope:{kind:'project',projectId:1},kind:'file',id:'1'},sessionId:'session',revision:0,contentHash:'original',archivedVersionNumber:1,pendingArchive:false,lastActivityAtMs:null,archiveDueAtMs:null,name:'book.xlsx',base64:'',format:'xlsx',model:null};
const saved = (revision: number): FileWorkingSaved => ({...opened,revision,contentHash:`saved-${revision}`,pendingArchive:true,noChange:false});

it('keeps the live model and cumulative edits while acknowledging only the saved snapshot', async () => {
  let finish!: (result: FileWorkingSaved) => void;
  const calls: unknown[] = [];
  const model = {text:'original'};
  const session = new FileEditSession(opened,model, input => {calls.push(input);return new Promise(resolve => {finish=resolve;});});
  session.replaceEdits(['first'], {editRevision:3});
  const first = session.save();
  session.replaceEdits(['second'], {editRevision:4});
  finish(saved(1)); await first;
  expect(session.snapshot).toMatchObject({model,edits:['second'],dirty:true,savedEditRevision:3,editRevision:4});
  expect(session.snapshot.model).toBe(model);
  const second=session.save();finish(saved(2));await second;
  expect(calls).toMatchObject([{expectedRevision:0,expectedContentHash:'original',edits:['first']},{expectedRevision:1,expectedContentHash:'saved-1',edits:['second']}]);
  expect(session.snapshot).toMatchObject({edits:['second'],dirty:false,savedEditRevision:4});
});

it('persists undo back to the initial content even when the cumulative journal is empty', async () => {
  const calls: unknown[]=[];
  const session=new FileEditSession(opened,{},async input=>{calls.push(input);return saved(calls.length);});
  await session.save();expect(calls).toHaveLength(0);
  session.replaceEdits(['change']);await session.save();
  session.replaceEdits([]);expect(session.snapshot.dirty).toBe(true);await session.save();
  expect(calls).toMatchObject([{edits:['change']},{edits:[]}]);
  expect(session.snapshot.dirty).toBe(false);
});

it('replays the exact failed attempt before saving newer input', async () => {
  const calls: {requestId:string;edits:string[]}[]=[];
  const session=new FileEditSession<{},string>(opened,{},async input=>{calls.push(input);if(calls.length===1)throw Error('connection lost');return saved(calls.length-1);});
  session.replaceEdits(['first']);await expect(session.save()).rejects.toThrow('connection lost');
  session.replaceEdits(['newer']);await session.save();
  expect(calls[1]).toEqual(calls[0]);expect(session.snapshot.dirty).toBe(true);
  await session.save();expect(calls[2].edits).toEqual(['newer']);
  expect(calls[2].requestId).not.toBe(calls[0].requestId);
});
