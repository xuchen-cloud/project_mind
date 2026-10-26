import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import ts from 'typescript';
import {replaceStatusZoom,markEditorChrome} from '../editor-chrome/build-adapter.mjs';

// Select JSX nodes from the pinned AST; exact counts fail on upstream changes.
function chromeAst(source,path){
 const ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const all=[];function visit(node){all.push(node);ts.forEachChild(node,visit)}visit(ast);
 const element=node=>ts.isJsxElement(node)||ts.isJsxSelfClosingElement(node);
 const opening=node=>ts.isJsxElement(node)?node.openingElement:node;
 const hasClass=(node,name)=>element(node)&&opening(node).attributes.properties.some(a=>ts.isJsxAttribute(a)&&a.name.getText(ast)==='className'&&a.initializer&&(ts.isStringLiteral(a.initializer)?a.initializer.text.split(/\s+/).includes(name):a.initializer.getText(ast).includes(name)));
 const one=(predicate,label)=>{const nodes=all.filter(predicate);if(nodes.length!==1)throw Error(label+' integration point changed: '+nodes.length);return nodes[0]};
 const conditional=node=>{while(ts.isParenthesizedExpression(node.parent)||ts.isBinaryExpression(node.parent))node=node.parent;return ts.isJsxExpression(node.parent)?node.parent:node};
 return{ast,all,element,opening,hasClass,one,conditional};
}
function removeRanges(source,nodes){for(const node of nodes.sort((a,b)=>b.getStart()-a.getStart()))source=source.slice(0,node.getStart())+source.slice(node.end);return source;}
function embeddedAppChrome(source,path){
 const a=chromeAst(source,path),tag=(node,name)=>a.element(node)&&a.opening(node).tagName.getText(a.ast)===name;
 const dock=a.conditional(a.one(n=>a.hasClass(n,'ai-dock'),'AI dock'));
 const ask=a.conditional(a.one(n=>tag(n,'AiAskPopover'),'AI ask'));
 const save=a.one(n=>a.hasClass(n,'qa-btn')&&n.getText(a.ast).includes("t('appSaveShortcutTip')"),'QAT save');
 const autosave=a.one(n=>a.hasClass(n,'autosave-toggle'),'QAT autosave');
 const sep=a.one(n=>a.hasClass(n,'qa-sep'),'QAT separator');
 return removeRanges(source,[dock,ask,save,autosave,sep]);
}
function embeddedRibbonChrome(source,path){
 const a=chromeAst(source,path),group=a.one(n=>a.hasClass(n,'ribbon-group')&&n.getText(a.ast).includes('Genspark AI'),'Home AI group');
 const siblings=group.parent.children,following=siblings.slice(siblings.indexOf(group)+1).find(a.element);
 if(!following||!a.hasClass(following,'ribbon-sep'))throw Error('Home AI following separator integration point changed');
 return removeRanges(source,[group,following]);
}
function embeddedStatus(source,path){
 const a=chromeAst(source,path),footer=a.one(n=>a.hasClass(n,'status-bar'),'Status bar');
 const left=a.one(n=>a.hasClass(n,'status-left'),'Status info'),right=a.one(n=>a.hasClass(n,'status-right'),'Status zoom');
 const page=a.one(n=>a.hasClass(n,'status-page'),'Status page'),views=a.conditional(a.one(n=>a.hasClass(n,'status-views'),'Status views'));
 const without=(node,child)=>source.slice(node.getStart(),child.getStart())+source.slice(child.end,node.end);
 const result='<footer className="status-bar">{doc && ('+page.getText(a.ast)+')}<div className="pm-status-info" role="group" aria-label="文档状态" tabIndex={0}><span className="pm-preview-state">只读预览</span>'+without(left,page)+views.getText(a.ast)+'</div>'+without(right,views)+'</footer>';
 return source.slice(0,footer.getStart())+result+source.slice(footer.end);
}

/** Deterministic integration transforms. The pinned upstream files stay unchanged. */
export function rendererAdapter(root){
  const replace=(source,from,to)=>{if(!source.includes(from))throw Error(`Upstream integration point changed: ${from.slice(0,90)}`);return source.replace(from,to);};
  return {name:'project-mind-docx-web-host',setup(build){
    build.onLoad({filter:/office-docx[\\/]renderer\.tsx$/},async({path})=>({contents:await readFile(path,'utf8')+"\nimport '../editor-chrome/status-bar.css';\nimport '../editor-chrome/editor-chrome.css';\n",loader:'tsx',resolveDir:resolve(path,'..')}));
    build.onLoad({filter:/office-docx[\\/]scroll-edges\.ts$/},async({path})=>({contents:(await readFile(path,'utf8')).replaceAll('Math.min(16,width*.35)',"Math.min(Number.parseFloat(style.getPropertyValue('--editor-chrome-fade-size')),width*.35)").replaceAll('Math.min(24,height*.35)',"Math.min(Number.parseFloat(style.getPropertyValue('--editor-chrome-fade-block-size')),height*.35)"),loader:'ts',resolveDir:resolve(path,'..')}));
    build.onLoad({filter:/pdf\.worker\.min\.mjs$/},async({path,suffix})=>suffix==='?url'?{contents:`export default URL.createObjectURL(new Blob([${JSON.stringify(await readFile(path,'utf8'))}],{type:'text/javascript'}));`,loader:'js'}:undefined);
    build.onLoad({filter:/apps[\\/]docs[\\/]src[\\/]renderer[\\/]components[\\/]PrintDialog\.tsx$/},async({path})=>({contents:replace(await readFile(path,'utf8'),'className="modal-backdrop"','className="modal-backdrop pm-output-dialog"'),loader:'tsx',resolveDir:resolve(path,'..')}));
    build.onLoad({filter:/apps[\\/]docs[\\/]src[\\/]renderer[\\/]components[\\/]ZoomDialog\.tsx$/},async({path})=>({contents:replace(await readFile(path,'utf8'),'className="modal-backdrop"','className="modal-backdrop pm-view-dialog"'),loader:'tsx',resolveDir:resolve(path,'..')}));
    build.onLoad({filter:/apps[\\/]docs[\\/]src[\\/]renderer[\\/]components[\\/]ProtectDialog\.tsx$/},async({path})=>{
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
    build.onLoad({filter:/apps[\\/]docs[\\/]src[\\/]renderer[\\/]components[\\/]PaginationPreview\.tsx$/},async({path})=>{
      let source=await readFile(path,'utf8');
      source=replace(source,'      <div className="pv-toolbar">',`      <div className="pv-toolbar">
        <button className="pv-close" onClick={() => void window.__projectMindDocxHost.output('images')}>导出图片</button>`);
      return{contents:source,loader:'tsx',resolveDir:resolve(path,'..')};
    });
    build.onLoad({filter:/apps[\\/]docs[\\/]src[\\/]renderer[\\/]system-fonts\.ts$/},async({path})=>{
      let source=await readFile(path,'utf8');const ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true);
      const query=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='queryFamilies');
      if(!query?.body)throw Error('System font integration point changed');
      source=source.slice(0,query.body.getStart(ast))+`{ return window.__projectMindDocxHost.getSystemFonts(); }`+source.slice(query.body.end);
      source=replace(source,'    return families\n  })','    return families\n  }).catch(error => { pending = null; throw error })');
      return{contents:source,loader:'ts',resolveDir:resolve(path,'..')};
    });
    build.onLoad({filter:/apps[\\/]docs[\\/]src[\\/]renderer[\\/]file-actions\.ts$/},async({path})=>{
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
    build.onLoad({filter:/apps[\\/]docs[\\/]src[\\/]renderer[\\/]html-export\.ts$/},async({path})=>{
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
    build.onLoad({filter:/apps[\\/]docs[\\/]src[\\/]renderer[\\/]components[\\/]Ribbon\.tsx$/},async({path})=>{
      let source=await readFile(path,'utf8');
      source=markEditorChrome(ts,embeddedRibbonChrome(source,path),path);
      // The enclosing File host owns its menu; keep original editor tabs and QAT undo/redo.
      const start=source.indexOf('        {!IS_MAC && (',source.indexOf('className={`ribbon-tabs'));
      const end=source.indexOf('        {quickActions}',start);
      if(start<0||end<0)throw Error('Ribbon file menu integration point changed');
      source=source.slice(0,start)+'        <div className="pm-ribbon-edit-tabs" style={{display:"contents"}}>\n'+source.slice(end);
      source=replace(source,'      <div\n        className={`ribbon-tabs',`      <div className="pm-ribbon-header">
      <div
        className={\`ribbon-tabs`);
      source=replace(source,'        {trailingActions}\n      </div>','        {trailingActions}\n        </div>\n      </div>\n      </div>');
      return{contents:source,loader:'tsx',resolveDir:resolve(path,'..')};
    });
    build.onResolve({filter:/^project-mind:secure-extensions$/},()=>({path:resolve(root,'secure-extensions.ts')}));
    build.onLoad({filter:/apps[\\/]docs[\\/]src[\\/]renderer[\\/]editor[\\/]extensions\.ts$/},async({path})=>{let source=await readFile(path,'utf8');source=replace(source,'export const editorExtensions = [','const originalEditorExtensions = [');source=replace(source,'export const textboxSubExtensions = [','const originalTextboxSubExtensions = [');return{contents:"import {secureExtensions} from 'project-mind:secure-extensions';\n"+source+'\nexport const textboxSubExtensions = secureExtensions(originalTextboxSubExtensions);\nexport const editorExtensions = secureExtensions(originalEditorExtensions);',loader:'ts',resolveDir:resolve(path,'..')};});
    build.onLoad({filter:/apps[\\/]docs[\\/]src[\\/]renderer[\\/](components[\\/]ribbon-tabs|editor[\\/]image-drop)\.tsx?$/},async({path})=>{
      let source=await readFile(path,'utf8');
      if(path.endsWith('ribbon-tabs.tsx'))source=replace(source,"title={t('ribbonProtectDocTip')}","title={t('ribbonProtectDoc')}");
      const ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true);const patches=[];
      for(const node of ast.statements)if(ts.isFunctionDeclaration(node)&&['insertImageViaDialog','insertImageFromDataUrl','insertImageFilesAt'].includes(node.name?.text)&&node.body){patches.push({at:node.body.end-1,text:'} finally { window.__projectMindDocxHost?.endOperation(); }'});patches.push({at:node.body.getStart(ast)+1,text:'window.__projectMindDocxHost?.beginOperation(); try {'});}
      for(const patch of patches.sort((a,b)=>b.at-a.at))source=source.slice(0,patch.at)+patch.text+source.slice(patch.at);
      return{contents:source,loader:path.endsWith('tsx')?'tsx':'ts',resolveDir:resolve(path,'..')};
    });
    build.onLoad({filter:/apps[\\/]docs[\\/]src[\\/]renderer[\\/]App\.tsx$/},async ({path})=>{
      let source=await readFile(path,'utf8');
      source="import {usePreviewView} from "+JSON.stringify(resolve(root,'../editor-chrome/preview-view.ts'))+";\n"+source;
      source=embeddedStatus(embeddedAppChrome(source,path),path);
      source=replaceStatusZoom(ts,source,path,'<StatusZoom value={Math.round(zoom)} min={DOCS_ZOOM_MIN} max={DOCS_ZOOM_MAX} step={10} disabled={!doc} onChange={setZoom} onStep={direction=>setZoom(z=>stepDocsZoom(z,direction))} onValueClick={()=>setShowZoomDialog(true)}/>',resolve(root,'../editor-chrome/StatusZoom.tsx'));
      source=markEditorChrome(ts,source,path);
      // Chrome changes resize only the viewing area; retain the user's current
      // ratio and fit choice on this update. Real subsequent resizes still refit.
      source=replace(source,'    let lastWidth = -1',"    let lastWidth = -1\n    let lastPresentation = window.__projectMindDocxHost.presentationMode");
      source=replace(source,'      const raw = rawFitWidth()\n      if (raw == null) return',"      const mode = window.__projectMindDocxHost.presentationMode\n      if (mode !== lastPresentation) { lastPresentation = mode; lastWidth = el.clientWidth; return }\n      const raw = rawFitWidth()\n      if (raw == null) return");
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
      source=replace(source,'  const hasUnsavedChanges = isDocDirty(fileCtxRef.current)',`  usePreviewView({zoom,setZoom,scrollers:()=>[scrollContainerRef.current]})
  useEffect(() => { window.__projectMindDocxHost?.render(fileCtxRef.current, docLoading) })\n  const hasUnsavedChanges = embeddedDirty`);
      source=replace(source,'dirty: !!doc && (anyDirtyRef.current || dirtyRef.current),','dirty: !!doc && window.__projectMindDocxHost.dirty,');
      source=replace(source,'(saveAs: boolean, auto = false) => saveImpl(fileCtxRef.current, saveAs, auto)','(saveAs: boolean, auto = false) => window.__projectMindDocxHost.requestSave()');
      return {contents:source,loader:'tsx',resolveDir:resolve(path,'..')};
    });
    build.onLoad({filter:/apps[\\/]docs[\\/]src[\\/]renderer[\\/]parse-off-thread\.ts$/},async ({path})=>({contents:(await readFile(path,'utf8')).replace("new URL('./parse-worker.ts', import.meta.url)","URL.createObjectURL(new Blob([__PROJECT_MIND_DOCX_WORKER__], {type: 'text/javascript'}))"),loader:'ts'}));
    build.onLoad({filter:/apps[\\/]docs[\\/]src[\\/]renderer[\\/]ai[\\/]AiPanel\.tsx$/},()=>({contents:'export const AI_REVISION_AUTHOR="Project Mind"; export function AiPanel(){return null}',loader:'tsx'}));
  }};
}
