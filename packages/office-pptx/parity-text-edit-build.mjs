/** Explicit adapters around pinned upstream extraction/commit; vendor bytes stay untouched. */
import {readFileSync} from 'node:fs';
import {buildImportPath} from './build-import-path.mjs';
import ts from 'typescript';
import {replaceStatusZoom,markEditorChrome} from '../editor-chrome/build-adapter.mjs';
export function installTextEditTransforms(build,root){
 const modulePath=JSON.stringify(buildImportPath(root,'parity-text-edit.ts'));
 build.onLoad({filter:/slides[\\/]src[\\/]renderer[\\/]TextEditOverlay\.tsx$/},args=>{
  let source=readFileSync(args.path,'utf8');
  source=source.replace('onCommit: (paragraphs: EditParagraph[]) => void','onCheckpoint?: (paragraphs: EditParagraph[]) => Promise<void>\n  onAbandon?: () => void\n  onCommit: (paragraphs: EditParagraph[]) => void')
   .replace('  onCommit,\n','  onCommit, onCheckpoint, onAbandon,\n')
   .replace('    div.dataset.norm = String(norm)', '    if (consumeTextEditCheckpoint(node, div)) return\n    div.dataset.norm = String(norm)')
   .replaceAll('extractParagraphs(div, norm)', 'extractParagraphs(div, Number(div.dataset.norm) || norm)')
   .replace('  // Targeted layout release', [
    '  const checkpointRef = useRef(async () => {})',
    '  checkpointRef.current = async () => {',
    '    const div = ref.current',
    '    if (!div || !onCheckpoint) return',
    '    const paras = extractParagraphs(div, Number(div.dataset.norm) || norm)',
    '    const signature = JSON.stringify(paras)',
    '    if (signature === initialRef.current) return',
    '    await onCheckpoint(paras)',
    '    initialRef.current = signature',
    '  }',
    '  const abandonRef = useRef(onAbandon); abandonRef.current = onAbandon',
    '  useEffect(() => {',
    '    if (!onCheckpoint || !ref.current) return',
    '    return registerTextEdit({root: ref.current, checkpoint: () => checkpointRef.current(), abandon: () => abandonRef.current?.()})',
    '  }, [!!onCheckpoint])',
    '  // Targeted layout release',
   ].join('\n'))
   .replace('        onBlur={(e) => {','        onBlur={(e) => {\n          if (keepTextEditOnBlur(e.relatedTarget)) return');
  return {contents:"import {registerTextEdit, consumeTextEditCheckpoint, keepTextEditOnBlur} from "+modulePath+";\n"+source,loader:'tsx'};
 });
 build.onLoad({filter:/slides[\\/]src[\\/]renderer[\\/]App\.tsx$/},args=>({contents:markEditorChrome(ts,replaceStatusZoom(ts,"import {usePreviewView} from "+JSON.stringify(buildImportPath(root,'../editor-chrome/preview-view.ts'))+";\nimport {usePptxSelection} from "+JSON.stringify(buildImportPath(root,'parity-selection.ts'))+";\nimport {usePptxOutput} from "+JSON.stringify(buildImportPath(root,'parity-output.ts'))+";\nimport {usePptxPreview} from "+JSON.stringify(buildImportPath(root,'parity-presentation.ts'))+";\nimport {markTextEditCheckpoint} from "+modulePath+";\n"+readFileSync(args.path,'utf8')
  .replace('for (const s of slides) {', 'for (const [index, s] of slides.entries()) {\n      if (projectMindPreview && index !== current && !visibleThumbs.has(index) && !visibleSorterItems.has(index)) continue')
  .replace('imageLoaderRef.current.load(urls)\n  }, [slides])', 'imageLoaderRef.current.load(urls)\n  }, [slides, current, visibleThumbs, visibleSorterItems, projectMindPreview])')
  .replace('  ctxRef.current = {', '  usePreviewView({zoom,setZoom,page:current,setPage:setCurrent,scrollers:()=>[stageWrapRef.current,thumbsListRef.current]})\n  usePptxSelection({current, selectedIds, editing, editingCell, enteredGroupId})\n  ctxRef.current = {')
  .replace('const exportImages = useCallback(() => fileActions.exportImages(ctxRef.current), [])', 'const exportImages = useCallback((hostOutput = false) => fileActions.exportImages(ctxRef.current, hostOutput), [])')
  .replace('const exportPdf = useCallback(() => void fileActions.exportPdf(ctxRef.current), [])', 'const exportPdf = useCallback((hostOutput = false) => fileActions.exportPdf(ctxRef.current, undefined, hostOutput), [])')
  .replace('const [printDlgOpen, setPrintDlgOpen] = useState(false)', "const [printDlgOpen, setPrintDlgOpen] = useState(false)\n  usePptxOutput({pdf: () => exportPdf(true), images: () => exportImages(true), print: () => setPrintDlgOpen(true)})")
  .replace('const [current, setCurrent] = useState(0)', 'const [current, setCurrent] = useState(0)\n  const projectMindPreview = usePptxPreview(setCurrent, slides.length)')
  .replaceAll('selectedIds={selectedIds}', 'selectedIds={projectMindPreview ? [] : selectedIds}')
  .replace('enteredGroupId={enteredGroupId}', 'enteredGroupId={projectMindPreview ? null : enteredGroupId}')
  .replace('editPoints={editPointsTarget}', 'editPoints={projectMindPreview ? null : editPointsTarget}')
  .replace('drawMode={drawKind ?', 'drawMode={!projectMindPreview && drawKind ?')
  .replaceAll('{...thumbDragProps(i)}', '{...(projectMindPreview ? {} : thumbDragProps(i))}')
  .replaceAll('{...thumbDragProps(i, true)}', '{...(projectMindPreview ? {} : thumbDragProps(i, true))}')
  .replace('async (paragraphs: EditParagraph[]) => {\n      if (!editing) return','async (paragraphs: EditParagraph[], keepEditing = false) => {\n      if (!editing) return')
  .replace('if (editing.discardIfEmpty && paragraphsBlank(paragraphs))','if (!keepEditing && editing.discardIfEmpty && paragraphsBlank(paragraphs))')
  .replace('      if (updated) {\n        setSlides((s)', '      if (updated) {\n        if (keepEditing) markTextEditCheckpoint(updated, editing.sourceId)\n        setSlides((s)')
  .replace('      setEditing(null)\n      setSelectedIds([editing.sourceId])', '      if (keepEditing) return\n      setEditing(null)\n      setSelectedIds([editing.sourceId])')
  .replace('onCommit={commitEdit}', 'onCommit={commitEdit} onCheckpoint={paragraphs => commitEdit(paragraphs, true)} onAbandon={() => setEditing(null)}'),args.path,'<StatusZoom value={live} min={ZOOM_MIN*100} max={ZOOM_MAX*100} step={5} onChange={value=>{setLive(value);onPreview(value/100)}} onStep={step}/>',buildImportPath(root,'../editor-chrome/StatusZoom.tsx')),args.path),loader:'tsx'}));
}
