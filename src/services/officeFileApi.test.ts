import { beforeEach, expect, it, vi } from 'vitest';
import { officeFileApi } from './officeFileApi';
import { desktopApi } from './desktopApi';
import type { RecalculateRequest, RecalculateResult } from '../../packages/office-xlsx/types';

vi.mock('./desktopApi', () => ({ desktopApi: { command: vi.fn() } }));
beforeEach(() => vi.clearAllMocks());
const binding = { workspaceId:'w1', generation:'open-1' };
const baseline = { object:{ workspaceId:'w1', scope:{kind:'project' as const,projectId:7},kind:'file' as const,id:'42' }, versionNumber:3, expectedContentHash:`sha256:${'a'.repeat(64)}` };
const recalculation: RecalculateRequest = {
  edits:[{ sheetId:'sheet-1',row:0,column:0,input:'=SUM(A2:A3)' }],
  reads:[{ sheetId:'sheet-1',range:{startRow:0,endRow:0,startColumn:0,endColumn:0} }],
};
const data = {...baseline,recalculation};
const result: RecalculateResult = { cells:[{sheetId:'sheet-1',row:0,column:0,formatted:'30',number:30,isFormula:true}] };

it('recalculates exact baseline bytes through the bound native read command', async () => {
  vi.mocked(desktopApi.command).mockResolvedValue({apiVersion:1,requestId:'recalc-1',ok:true,data:result});
  await expect(officeFileApi.recalculate(binding,data,'recalc-1')).resolves.toBe(result);
  expect(desktopApi.command).toHaveBeenCalledExactlyOnceWith('file_office_recalculate',{input:{binding,requestId:'recalc-1',data}});
});

it('preserves asynchronous permission and revision errors without returning stale calculation', async () => {
  for (const code of ['WORKSPACE_CHANGED','SCOPE_DENIED','REVISION_CONFLICT','FILE_CHANGED_UNREGISTERED']) {
    vi.mocked(desktopApi.command).mockResolvedValueOnce({apiVersion:1,requestId:'recalc-1',ok:false,error:{code,message:code,retryable:false}});
    await expect(officeFileApi.recalculate(binding,data,'recalc-1')).rejects.toMatchObject({code});
  }
});

it('rejects a mismatched response identity', async () => {
  vi.mocked(desktopApi.command).mockResolvedValueOnce({apiVersion:1,requestId:'stale',ok:true,data:result});
  await expect(officeFileApi.recalculate(binding,data,'recalc-1')).rejects.toMatchObject({code:'RUNTIME_INCOMPATIBLE'});
});
