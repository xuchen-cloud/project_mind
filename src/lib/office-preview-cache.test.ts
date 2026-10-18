import { beforeEach, expect, it } from 'vitest';
import { officePreviewCache } from './office-preview-cache';
import type { OfficeModel } from './office-types';
const binding = {workspaceId:'w',generation:'g'};
const input = {object:{workspaceId:'w',scope:{kind:'project' as const,projectId:1},kind:'file' as const,id:'1'},versionNumber:1,expectedContentHash:'sha256:a'};
const model = {format:'docx',nodes:[{text:'固定源'}]} as OfficeModel;
beforeEach(() => officePreviewCache.clear());
it('keeps display snapshots independent of renderer mutation and separates File/version/hash', () => {
  officePreviewCache.remember(binding,input,model);
  const copy = officePreviewCache.get(binding,input)!;
  if (copy.format === 'docx') copy.nodes[0].text = '被渲染器修改';
  expect(officePreviewCache.get(binding,input)).toEqual(model);
  expect(officePreviewCache.get(binding,{...input,object:{...input.object,id:'2'}})).toBeUndefined();
  expect(officePreviewCache.get(binding,{...input,versionNumber:2})).toBeUndefined();
  expect(officePreviewCache.get(binding,{...input,expectedContentHash:'sha256:b'})).toBeUndefined();
});
it('clears snapshots on a Workspace generation change and bounds retained files', () => {
  officePreviewCache.remember(binding,input,model);
  expect(officePreviewCache.get({...binding,generation:'new'},input)).toBeUndefined();
  expect(officePreviewCache.get(binding,input)).toBeUndefined();
  for (let versionNumber=1;versionNumber<=5;versionNumber++) officePreviewCache.remember(binding,{...input,versionNumber},model);
  expect(officePreviewCache.get(binding,input)).toBeUndefined();
  expect(officePreviewCache.get(binding,{...input,versionNumber:5})).toEqual(model);
});
