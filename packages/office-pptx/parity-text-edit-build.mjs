/** Explicit adapters around pinned upstream extraction/commit; vendor bytes stay untouched. */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
export function installTextEditTransforms(build,root){
 const modulePath=join(root,'parity-text-edit.ts');
 build.onLoad({filter:/slides[\/]src[\/]renderer[\/]TextEditOverlay\.tsx$/},args=>{
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
  return {contents:"import {registerTextEdit, consumeTextEditCheckpoint, keepTextEditOnBlur} from '"+modulePath+"';\n"+source,loader:'tsx'};
 });
 build.onLoad({filter:/slides[\/]src[\/]renderer[\/]App\.tsx$/},args=>({contents:"import {markTextEditCheckpoint} from '"+modulePath+"';\n"+readFileSync(args.path,'utf8')
  .replace('async (paragraphs: EditParagraph[]) => {\n      if (!editing) return','async (paragraphs: EditParagraph[], keepEditing = false) => {\n      if (!editing) return')
  .replace('if (editing.discardIfEmpty && paragraphsBlank(paragraphs))','if (!keepEditing && editing.discardIfEmpty && paragraphsBlank(paragraphs))')
  .replace('      if (updated) {\n        setSlides((s)', '      if (updated) {\n        if (keepEditing) markTextEditCheckpoint(updated, editing.sourceId)\n        setSlides((s)')
  .replace('      setEditing(null)\n      setSelectedIds([editing.sourceId])', '      if (keepEditing) return\n      setEditing(null)\n      setSelectedIds([editing.sourceId])')
  .replace('onCommit={commitEdit}', 'onCommit={commitEdit} onCheckpoint={paragraphs => commitEdit(paragraphs, true)} onAbandon={() => setEditing(null)}'),loader:'tsx'}));
}
