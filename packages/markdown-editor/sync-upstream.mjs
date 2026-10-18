import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
const root = path.dirname(fileURLToPath(import.meta.url));
const lock = JSON.parse(await readFile(path.join(root,'source-lock.json'),'utf8'));
const check = process.argv.includes('--check');
const source = process.argv.find((arg,index)=>index>1 && !arg.startsWith('--'));
for (const entry of lock.files) {
  const file = path.join(root,'upstream',entry.path);
  const bytes=await readFile(source?path.join(source,entry.path):file);
  if (createHash('sha256').update(bytes).digest('hex')!==entry.sha256) throw Error(`Upstream mismatch: ${entry.path}`);
  if (source && !check) { await mkdir(path.dirname(file),{recursive:true}); await writeFile(file,bytes); }
  if (entry.path.startsWith('packages/agent-core/src/')) {
    const output=path.join(root,'src/agent-core',path.basename(entry.path));
    if(check){if(await readFile(output,'utf8')!==bytes.toString())throw Error('Agent core drift');}
    else{await mkdir(path.dirname(output),{recursive:true});await writeFile(output,bytes);}
    continue;
  }
  if(entry.path==='packages/ui/src/find-text.ts'){
    const output=path.join(root,'src/adapters/find-text.ts');
    if(check){if(await readFile(output,'utf8')!==bytes.toString())throw Error('Find helper drift');}
    else await writeFile(output,bytes);
    continue;
  }
  if(entry.path==='apps/markdown/src/shared/export-image-mime.ts'){
    const output=path.join(root,'src/genoffice/shared/export-image-mime.ts');
    if(check){if(await readFile(output,'utf8')!==bytes.toString())throw Error('Image MIME helper drift');}
    else{await mkdir(path.dirname(output),{recursive:true});await writeFile(output,bytes);}
    continue;
  }
  if (entry.referenceOnly || !entry.path.startsWith('apps/markdown/src/renderer/')) continue;
  let content=bytes.toString();
  const relative=entry.path.slice('apps/markdown/src/renderer/'.length);
  const output=path.join(root,'src/genoffice',relative);
  const adapterPath=path.relative(path.dirname(output),path.join(root,'src/adapters/ui')).replaceAll(path.sep,'/');
  const imagePath=path.relative(path.dirname(output),path.join(root,'src/adapters/localImage')).replaceAll(path.sep,'/');
  content=content.replaceAll("'@genoffice/ui'", `'${adapterPath}'`).replaceAll("'./localImage'", `'${imagePath}'`);
  if(relative==='export/exportImage.ts')content=content.replace("import type { NewImage } from '@genoffice/docx-engine'", "import type { ExportImage as NewImage } from '../../export/upstream-docx.mjs'").replace("import type { ImageData } from '../../shared/ipc'", 'type ImageData = { base64: string; mime: string }').replace("'../../shared/export-image-mime'", "'../shared/export-image-mime'");
  if(relative==='export/printHtml.ts')content=content.replaceAll("ul[data-type='taskList']", "ul:has(> li[data-checked])");
  if(relative==='components/SlashMenu.tsx'){
    content="import { ScrollMenu } from '../../adapters/ui'\n"+content.replace('useImperativeHandle, useState', 'useImperativeHandle, useRef, useState');
    content=content.replace('  const count =', "  const menuElement=useRef<HTMLDivElement>(null)\n  useEffect(()=>{menuElement.current?.querySelector('.slash-item.active')?.scrollIntoView({block:'nearest'})},[index])\n  const count =");
    content=content.replace('      className="slash-menu"', '      ref={menuElement}\n      className="slash-menu"').replace('      {state.items.length', '      <ScrollMenu>{state.items.length').replace('      )}\n    </div>', '      )}</ScrollMenu>\n    </div>');
  }
  if(relative==='editor/ops.ts')content=content.replace('nodes.at(-1)!','nodes[nodes.length-1]!').replace('// a caret inside a list item inserts after that item, not after the whole list\n    liftFromList(exec)', '// Insert after the containing top-level block; inserting must never unlist existing content.');
  if(relative==='editor/wavedrom.ts')content='/// <reference path="../types/wavedrom.d.ts" />\n'+content;
  if(relative==='editor/redact.ts')content=content.replaceAll("'@genoffice/agent-core/","'../../agent-core/");
  if(relative==='components/icons.tsx')content=content.replace(/export \{[\s\S]*?\} from '\.\.\/\.\.\/\.\.\/\.\.\/docs\/src\/renderer\/components\/icons'\n/, '');
  if(relative==='source/plain-find.ts')content=content.replace('    replaceOne(index, replacement) {','    replaceOne(index, replacement) {\n      if(view.state.readOnly)return').replace('    replaceAll(replacement) {','    replaceAll(replacement) {\n      if(view.state.readOnly)return');
  if (relative==='editor/diagrams.ts') content=content.replace("import type { NewImage } from '@genoffice/docx-engine'", "type NewImage = { base64: string; mime: string; widthPx: number; heightPx: number; align: string }");
  if (relative==='editor/CodeBlockView.tsx') {
    content="import { renderSafeDiagram as renderDiagram } from '../../adapters/diagramPreviewSafety'\n"+content.replace('DIAGRAM_LANGUAGES, diagramLanguage, renderDiagram', 'DIAGRAM_LANGUAGES, diagramLanguage');
    content=content.replace(".catch(() => {})", ".catch((error) => { if (mountedRef.current) setCopyError(String(error)) })");
    content=content.replace("const [copied, setCopied] = useState(false)", "const [copied, setCopied] = useState(false)\n  const [copyError, setCopyError] = useState('')");
    content=content.replace('<pre>', '{copyError && <span role="alert">{copyError}</span>}\n      <pre>');
  }
  if(relative==='editor/blockKeymap.ts')content=content.replace('  addKeyboardShortcuts() {','  addKeyboardShortcuts() {').replace('return {\n', 'const editable = (run: () => boolean) => () => this.editor.isEditable && run()\n    return {\n').replaceAll("() => uiOp(this.editor, { op: 'duplicateBlocks', target: 'selection' })","editable(() => uiOp(this.editor, { op: 'duplicateBlocks', target: 'selection' }))").replace("() => uiOp(this.editor, { op: 'deleteBlocks', target: 'selection' })","editable(() => uiOp(this.editor, { op: 'deleteBlocks', target: 'selection' }))").replace('() => moveSelectedBlocks(this.editor, -1)','editable(() => moveSelectedBlocks(this.editor, -1))').replace('() => moveSelectedBlocks(this.editor, 1)','editable(() => moveSelectedBlocks(this.editor, 1))').replace("'Mod-k': () => {","'Mod-k': () => {\n        if(!this.editor.isEditable)return false");
  if (relative==='editor/mathEdit.ts') {
    content=content.replace('el: HTMLElement; dispose: () => void', 'el: HTMLElement; dispose: () => void; editor: Editor');
    content=content.replace('  activePop = { el: pop, dispose: close }', '  activePop = { el: pop, dispose: close, editor }');
    content=content.replace('export function openMathEditor', 'export function closeMathEditor(editor: Editor): void { if(activePop?.editor===editor)closeActive() }\n\nexport function openMathEditor');
    content=content.replace('  closeActive()\n', '  if (!editor.isEditable) return\n  closeActive()\n');
    content=content.replace('if (transaction.docChanged) close()', 'if (!editor.isEditable || transaction.docChanged) close()');
    content=content.replace("del.addEventListener('click', () => {", "del.addEventListener('click', () => {\n      if (!editor.isEditable || editor.isDestroyed) return close()");
    content=content.replace('    const latex = input.value.trim()\n    if (pos', '    if (!editor.isEditable || editor.isDestroyed) return close()\n    const latex = input.value.trim()\n    if (pos');
    content=content.replace("  editor.on('transaction', onTransaction)", "  editor.on('transaction', onTransaction)\n  editor.on('destroy', closeActive)");
    content=content.replace("    editor.off('transaction', onTransaction)", "    editor.off('transaction', onTransaction)\n    editor.off('destroy', closeActive)");
  }
  if(relative==='editor/blockDragHandle.ts')content=content.replace('Math.max(0, (blockRect.left - containerRect.left) / scale - 52)','((blockRect.left - containerRect.left) / scale - 52)');
  if(relative==='editor/blockDragHandle.ts')content=content.replace('const onDragStart = (event: DragEvent) => {','const onDragStart = (event: DragEvent) => {\n        if(!view.editable){event.preventDefault();return}').replace('const onPlusClick = () => {','const onPlusClick = () => {\n        if(!view.editable)return').replace('const menuAction = (run: () => void) => () => {','const menuAction = (run: () => void) => () => {\n        if(!view.editable)return').replace('const onGripClick = () => {','const onGripClick = () => {\n        if(!view.editable)return').replace('update(_view, prevState) {','update(_view, prevState) {\n          if(!view.editable){hideHandle();hideMenu();return}');
  if (relative==='editor/blockDragHandle.ts') content=content.replace("menu.className = 'md-block-menu'", "menu.className = 'md-block-menu context-menu__panel'").replace('`md-block-menu-item${item.danger', '`md-block-menu-item context-menu__item${item.danger');
  if (check) { if(await readFile(output,'utf8')!==content) throw Error(`Generated adapter drift: ${relative}`); }
  else { await mkdir(path.dirname(output),{recursive:true}); await writeFile(output,content); }
}
console.log(`Verified ${lock.files.length} fixed-source files${check?' and generated adapters':''}.`);
