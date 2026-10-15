import { describe, expect, it } from 'vitest';
import { OfficeEditSession } from './office-edit-session';
const baseline = { object: {workspaceId:'workspace',scope:{kind:'project' as const,projectId:7},kind:'file' as const,id:'42'},versionNumber:2,expectedContentHash:'sha256:old' };
const model = {format:'docx',text:'原文'};
it('Office edits save against their fixed File baseline and reopen from the committed version', async () => {
  const calls: unknown[] = [];
  const session = new OfficeEditSession(baseline, model, async input => {
    calls.push(input);
    return {model:{format:'docx',text:'修改'},commit:{receipt:{documentId:42,versionNumber:3,contentHash:'sha256:new',noChange:false},versionPath:null}};
  });
  session.replaceEdits([{text:'修改'}]);
  await session.save();
  expect(calls).toEqual([expect.objectContaining({...baseline,edits:[{text:'修改'}]})]);
  expect(session.snapshot).toEqual(expect.objectContaining({model:{format:'docx',text:'修改'},edits:[],baseline:{...baseline,versionNumber:3,expectedContentHash:'sha256:new'}}));
  session.replaceEdits([{text:'第二次'}]);
  await session.save();
  expect(calls[1]).toEqual(expect.objectContaining({versionNumber:3,expectedContentHash:'sha256:new',edits:[{text:'第二次'}]}));
});
it('failed Office save retains edits and retries with the same request identity', async () => {
  const calls: {requestId:string}[] = [];
  const session = new OfficeEditSession(baseline, model, async input => {
    calls.push(input);
    throw new Error('旧版本冲突');
  });
  session.replaceEdits([{text:'必须保留'}]);
  await expect(session.save()).rejects.toThrow('旧版本冲突');
  await expect(session.save()).rejects.toThrow('旧版本冲突');
  expect(session.snapshot.edits).toEqual([{text:'必须保留'}]);
  expect(session.snapshot.baseline).toEqual(baseline);
  expect(calls[0].requestId).toBe(calls[1].requestId);
});
it('closing an unchanged Office file does not create a version', async () => {
  let writes = 0;
  const session = new OfficeEditSession(baseline,model,async () => {writes++;throw new Error('unexpected');});
  await session.save();
  expect(writes).toBe(0);
});
