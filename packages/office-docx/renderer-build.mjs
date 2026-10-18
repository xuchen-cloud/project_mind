import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import ts from 'typescript';
/** Deterministic integration transforms. The pinned upstream files stay unchanged. */
export function rendererAdapter(root){
  const replace=(source,from,to)=>{if(!source.includes(from))throw Error(`Upstream integration point changed: ${from.slice(0,90)}`);return source.replace(from,to);};
  return {name:'project-mind-docx-web-host',setup(build){
    build.onLoad({filter:/pdf\.worker\.min\.mjs$/},async({path,suffix})=>suffix==='?url'?{contents:`export default URL.createObjectURL(new Blob([${JSON.stringify(await readFile(path,'utf8'))}],{type:'text/javascript'}));`,loader:'js'}:undefined);
    build.onLoad({filter:/apps\/docs\/src\/renderer\/components\/PrintDialog\.tsx$/},async({path})=>({contents:replace(await readFile(path,'utf8'),'className="modal-backdrop"','className="modal-backdrop pm-output-dialog"'),loader:'tsx',resolveDir:resolve(path,'..')}));
    build.onLoad({filter:/apps\/docs\/src\/renderer\/components\/ProtectDialog\.tsx$/},async({path})=>{
      let source=await readFile(path,'utf8');
      // User explicitly excludes whole-file encryption. Remove this feature's
      // fields/state/diff only; settings.xml write/edit protection stays intact.
      const ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),rows=[];
      function visit(node){if(ts.isJsxElement(node)&&node.openingElement.attributes.properties.some(a=>ts.isJsxAttribute(a)&&a.name.getText(ast)==='className'&&a.initializer&&ts.isStringLiteral(a.initializer)&&a.initializer.text==='fld-row')&&node.getText(ast).includes("t('appProtectOpenPwd')"))rows.push(node);ts.forEachChild(node,visit);}visit(ast);
      if(rows.length!==1)throw Error('Open-password form integration point changed');
      source=source.slice(0,rows[0].getStart(ast))+source.slice(rows[0].end);
      source=replace(source,'  encrypted,\n','');
      source=replace(source,"  const [openPwd, setOpenPwd] = useState(encrypted ? KEEP : '')\n",'');
      source=replace(source,"  const [openPwd2, setOpenPwd2] = useState(encrypted ? KEEP : '')\n",'');
      source=replace(source,'openPwd !== openPwd2 || modifyPwd !== modifyPwd2','modifyPwd !== modifyPwd2');
      source=replace(source,"      if (openPwd !== (encrypted ? KEEP : '')) {\n        result.openPassword = openPwd === '' ? null : openPwd\n      }\n",'');
      source=replace(source,'(encrypted || hadModifyPwd) &&','hadModifyPwd &&');
      source=replace(source,"{t('appProtectDesc')}","{[t('appProtectModifyPwd'), t('appProtectSectionTitle'), t('appProtectPrivacy')].join(' · ')}");
      source=replace(source,'              value={modifyPwd}','              autoFocus\n              value={modifyPwd}');
      return{contents:source,loader:'tsx',resolveDir:resolve(path,'..')};
    });
    build.onLoad({filter:/apps\/docs\/src\/renderer\/components\/PaginationPreview\.tsx$/},async({path})=>{
      let source=await readFile(path,'utf8');
      source=replace(source,'      <div className="pv-toolbar">',`      <div className="pv-toolbar">
        <button className="pv-close" onClick={() => void window.__projectMindDocxHost.output('images')}>导出图片</button>`);
      return{contents:source,loader:'tsx',resolveDir:resolve(path,'..')};
    });
    build.onLoad({filter:/apps\/docs\/src\/renderer\/system-fonts\.ts$/},async({path})=>{
      let source=await readFile(path,'utf8');const ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true);
      const query=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='queryFamilies');
      if(!query?.body)throw Error('System font integration point changed');
      source=source.slice(0,query.body.getStart(ast))+`{ return window.__projectMindDocxHost.getSystemFonts(); }`+source.slice(query.body.end);
      source=replace(source,'    return families\n  })','    return families\n  }).catch(error => { pending = null; throw error })');
      return{contents:source,loader:'ts',resolveDir:resolve(path,'..')};
    });
    build.onLoad({filter:/apps\/docs\/src\/renderer\/file-actions\.ts$/},async({path})=>{
      let source=await readFile(path,'utf8');
      source=replace(source,"    const pvPages = [...document.querySelectorAll('.pv-page')] as HTMLElement[]",`    const pvPages = [...document.querySelectorAll('.pv-page')] as HTMLElement[]
    if (!pvPages.length) return deferExportToPreview(ctx, outPath)`);
      // Keep original PDF -> pdf.js -> 192dpi PNG logic, collect in a local ZIP.
      source=replace(source,'  const target = await window.desktop.pickExportImagesTarget()',"  const target = window.__projectMindDocxHost.startImages(doc.fileName)");
      source=replace(source,"      ctx.setStatus(t('appExportImagesDone', { count, dir: target.dir }))",`      if (!(await window.__projectMindDocxHost.finishImages())) { ctx.setStatus('已取消图片导出'); return false }
      ctx.setStatus(t('appExportImagesDone', { count, dir: doc.fileName.replace(/\\.docx$/i, '') + '.zip' }))`);
      const ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true),images=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='exportImages');
      if(!images?.body)throw Error('Image export integration point changed');
      source=source.slice(0,images.body.end-1)+'} finally { window.__projectMindDocxHost.cancelImages() }'+source.slice(images.body.end-1);
      source=source.slice(0,images.body.getStart(ast)+1)+'try {'+source.slice(images.body.getStart(ast)+1);
      return{contents:source,loader:'ts',resolveDir:resolve(path,'..')};
    });
    build.onLoad({filter:/apps\/docs\/src\/renderer\/html-export\.ts$/},async({path})=>{
      let source=await readFile(path,'utf8');
      // This class marks the real paragraph following a page break, not just
      // chrome. Upstream's skip set otherwise drops its entire text on export.
      source=replace(source,'  const restore: Array<() => void> = []',`  const restore: Array<() => void> = []
  for (const element of root.querySelectorAll('[data-idx].page-break-lead')) {
    element.classList.remove('page-break-lead');
    restore.push(() => element.classList.add('page-break-lead'));
  }`);
      return{contents:source,loader:'ts',resolveDir:resolve(path,'..')};
    });
    build.onLoad({filter:/apps\/docs\/src\/renderer\/components\/Ribbon\.tsx$/},async({path})=>{
      let source=await readFile(path,'utf8');
      source=replace(source,'        {!IS_MAC && (',`
        <button className="ribbon-tab pm-output-command" disabled={!hasDoc} onClick={() => void window.__projectMindDocxHost.output('pdf')}>导出 PDF</button>
        <button className="ribbon-tab pm-output-command" disabled={!hasDoc} onClick={() => void window.__projectMindDocxHost.output('images')}>导出图片</button>
        <button className="ribbon-tab pm-output-command" disabled={!hasDoc} onClick={() => void window.__projectMindDocxHost.output('html')}>导出 HTML</button>
        <button className="ribbon-tab pm-output-command" disabled={!hasDoc} onClick={() => void window.__projectMindDocxHost.output('print')}>打印…</button>
        <div className="pm-ribbon-edit-tabs" style={{display:'contents'}}>
        {!IS_MAC && (`);
      source=replace(source,'        {trailingActions}\n      </div>','        {trailingActions}\n        </div>\n      </div>');
      return{contents:source,loader:'tsx',resolveDir:resolve(path,'..')};
    });
    build.onResolve({filter:/^project-mind:secure-extensions$/},()=>({path:resolve(root,'secure-extensions.ts')}));
    build.onLoad({filter:/apps\/docs\/src\/renderer\/editor\/extensions\.ts$/},async({path})=>{let source=await readFile(path,'utf8');source=replace(source,'export const editorExtensions = [','const originalEditorExtensions = [');source=replace(source,'export const textboxSubExtensions = [','const originalTextboxSubExtensions = [');return{contents:"import {secureExtensions} from 'project-mind:secure-extensions';\n"+source+'\nexport const textboxSubExtensions = secureExtensions(originalTextboxSubExtensions);\nexport const editorExtensions = secureExtensions(originalEditorExtensions);',loader:'ts',resolveDir:resolve(path,'..')};});
    build.onLoad({filter:/apps\/docs\/src\/renderer\/(components\/ribbon-tabs|editor\/image-drop)\.tsx?$/},async({path})=>{
      let source=await readFile(path,'utf8');
      if(path.endsWith('ribbon-tabs.tsx'))source=replace(source,"title={t('ribbonProtectDocTip')}","title={t('ribbonProtectDoc')}");
      const ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true);const patches=[];
      for(const node of ast.statements)if(ts.isFunctionDeclaration(node)&&['insertImageViaDialog','insertImageFromDataUrl','insertImageFilesAt'].includes(node.name?.text)&&node.body){patches.push({at:node.body.end-1,text:'} finally { window.__projectMindDocxHost?.endOperation(); }'});patches.push({at:node.body.getStart(ast)+1,text:'window.__projectMindDocxHost?.beginOperation(); try {'});}
      for(const patch of patches.sort((a,b)=>b.at-a.at))source=source.slice(0,patch.at)+patch.text+source.slice(patch.at);
      return{contents:source,loader:path.endsWith('tsx')?'tsx':'ts',resolveDir:resolve(path,'..')};
    });
    build.onLoad({filter:/apps\/docs\/src\/renderer\/App\.tsx$/},async ({path})=>{
      let source=await readFile(path,'utf8');
      source=replace(source,'export function App() {',`export function App() {\n  const [embeddedReadOnly, setEmbeddedReadOnly] = useState(window.__projectMindDocxHost.locked);\n  useEffect(() => window.__projectMindDocxHost.subscribeReadOnly(setEmbeddedReadOnly), []);\n  const [embeddedDirty, setEmbeddedDirty] = useState(window.__projectMindDocxHost.dirty);\n  useEffect(() => window.__projectMindDocxHost.subscribeDirty(setEmbeddedDirty), []);`);
      source=replace(source,'        if (!imageFile && imageOnlyHtml) {\n          void (async () => {',`        if (!imageFile && imageOnlyHtml) {
          window.__projectMindDocxHost.beginOperation();
          void (async () => { let operationError; try {`);
      source=replace(source,'          })()\n          return true\n        }\n        // text/plain-only Markdown',`          } catch(error) { operationError = error; throw error } finally { window.__projectMindDocxHost.endOperation(operationError) } })()
          return true
        }
        // text/plain-only Markdown`);
      source=replace(source,'          const reader = new FileReader()\n          reader.onload = () => {',`          window.__projectMindDocxHost.beginOperation();
          const reader = new FileReader()
          reader.onload = async () => { let operationError; try {`);
      source=replace(source,"              void insertImageFromDataUrl(ed, reader.result, 'Image (pasted)')","              await insertImageFromDataUrl(ed, reader.result, 'Image (pasted)')");
      source=replace(source,'          }\n          reader.readAsDataURL(imageFile)',`          } catch(error) { operationError = error; window.__projectMindDocxHost.reportError(error) } finally { window.__projectMindDocxHost.endOperation(operationError) } }
          reader.onerror = () => { const error = reader.error ?? Error('图片读取失败'); window.__projectMindDocxHost.reportError(error); window.__projectMindDocxHost.endOperation(error) }
          reader.onabort = () => { const error = Error('图片读取已中止'); window.__projectMindDocxHost.reportError(error); window.__projectMindDocxHost.endOperation(error) }
          reader.readAsDataURL(imageFile)`);
      source=replace(source,'const isProtected =\n    writeLocked ||','const isProtected =\n    embeddedReadOnly || writeLocked ||');
      source=replace(source,"attributes: { class: 'doc-page', spellcheck:","attributes: { role: 'textbox', 'aria-label': 'Word 文档内容', 'aria-multiline': 'true', class: 'doc-page', spellcheck:");
      source=replace(source,"useState(() => aiPanelInitiallyOpen('aidocs.showAi'))","useState(false)");
      source=replace(source,"useAutoSavePref('aidocs.autoSave', window.desktop)","useState(false)");
      source=replace(source,'void writeRecoveryCopyImpl(fileCtxRef.current)','void window.__projectMindDocxHost.flush()');
      source=replace(source,'  const hasUnsavedChanges = isDocDirty(fileCtxRef.current)',`  useEffect(() => { window.__projectMindDocxHost?.render(fileCtxRef.current, docLoading) })\n  const hasUnsavedChanges = embeddedDirty`);
      source=replace(source,'dirty: !!doc && (anyDirtyRef.current || dirtyRef.current),','dirty: !!doc && window.__projectMindDocxHost.dirty,');
      source=replace(source,'(saveAs: boolean, auto = false) => saveImpl(fileCtxRef.current, saveAs, auto)','(saveAs: boolean, auto = false) => window.__projectMindDocxHost.requestSave()');
      return {contents:source,loader:'tsx',resolveDir:resolve(path,'..')};
    });
    build.onLoad({filter:/apps\/docs\/src\/renderer\/parse-off-thread\.ts$/},async ({path})=>({contents:(await readFile(path,'utf8')).replace("new URL('./parse-worker.ts', import.meta.url)","URL.createObjectURL(new Blob([__PROJECT_MIND_DOCX_WORKER__], {type: 'text/javascript'}))"),loader:'ts'}));
    build.onLoad({filter:/apps\/docs\/src\/renderer\/ai\/AiPanel\.tsx$/},()=>({contents:'export const AI_REVISION_AUTHOR="Project Mind"; export function AiPanel(){return null}',loader:'tsx'}));
  }};
}
