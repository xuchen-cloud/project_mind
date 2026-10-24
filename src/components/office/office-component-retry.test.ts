import {expect,it,vi} from 'vitest';
it('retries a failed component import while sharing pending and successful imports',async()=>{
 vi.doMock('./DocxEditor',()=>{throw new Error('temporary renderer resource failure');});
 const {loadDocxEditor}=await import('./office-component-loader');
 const failed=loadDocxEditor();
 expect(loadDocxEditor()===failed).toBe(true);
 await expect(failed).rejects.toThrow();
 vi.doMock('./DocxEditor',()=>({DocxEditor:()=>null}));
 const retried=loadDocxEditor();
 expect(retried===failed).toBe(false);
 expect(loadDocxEditor()===retried).toBe(true);
 expect(typeof (await retried).DocxEditor).toBe('function');
 expect(loadDocxEditor()===retried).toBe(true);
});
