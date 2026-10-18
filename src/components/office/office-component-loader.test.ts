import {beforeEach, expect, it, vi} from 'vitest';
const imports = vi.hoisted(() => ({host:vi.fn(),docx:vi.fn(),xlsx:vi.fn(),pptx:vi.fn()}));
beforeEach(() => {
 vi.resetModules();vi.clearAllMocks();
 vi.doMock('./OfficeFileContent', () => {imports.host();return {OfficeFileContent:()=>null};});
 vi.doMock('./DocxEditor', () => {imports.docx();return {DocxEditor:()=>null};});
 vi.doMock('./XlsxEditor', () => {imports.xlsx();return {XlsxEditor:()=>null};});
 vi.doMock('./PptxEditor', () => {imports.pptx();return {PptxEditor:()=>null};});
});
it('importing the loader or selecting a non-Office File does not load editors',async()=>{
 const loader=await import('./office-component-loader');
 for(const name of [undefined,'readme.md','legacy.doc','picture.png'])loader.preloadOfficeComponents(name);
 await Promise.resolve();
 for(const spy of Object.values(imports))expect(spy).not.toHaveBeenCalled();
});
for(const format of ['docx','xlsx','pptx'] as const)it(`loads only the selected ${format} component and shares its completed code promise`,async()=>{
 const loader=await import('./office-component-loader');
 loader.preloadOfficeComponents(`selected.${format}`);
 const selected={docx:loader.loadDocxEditor,xlsx:loader.loadXlsxEditor,pptx:loader.loadPptxEditor}[format];
 const host=loader.loadOfficeHost(),component=selected();
 expect(loader.loadOfficeHost()).toBe(host);expect(selected()).toBe(component);
 await Promise.all([host,component]);
 expect(imports.host).toHaveBeenCalledOnce();expect(imports[format]).toHaveBeenCalledOnce();
 for(const other of ['docx','xlsx','pptx'] as const)if(other!==format)expect(imports[other]).not.toHaveBeenCalled();
});
