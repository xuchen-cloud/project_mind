/** Thin host API composing unchanged upstream public engine + GUI converters.
 * It retains the live parsed document (including originalBytes); it is not a
 * JSON-only replacement for the source archive. Browser interaction is untested.
 */
import { parseDocx, saveDocx, readSections } from './upstream/packages/docx-engine/src/index'
import { blocksToPmDoc, pmDocOptions, pmDocToSavePlan, type PmNode } from './upstream/apps/docs/src/renderer/editor/convert'
export { parseDocx, saveDocx, readSections, blocksToPmDoc, pmDocOptions, pmDocToSavePlan }
export async function openDocx(bytes: Uint8Array) {
 const parsed=await parseDocx(bytes)
 return {parsed, pmDoc:blocksToPmDoc(parsed.blocks,readSections(parsed),pmDocOptions(parsed))}
}
export async function savePmDoc(session: Awaited<ReturnType<typeof openDocx>>, pmDoc: PmNode=session.pmDoc) {
 const plan=pmDocToSavePlan(pmDoc,session.parsed.blocks)
 // The controlled fixtures have no charts. A full host must implement the
 // upstream file-actions.ts chart-part writes before allowing chart edits.
 if(plan.chartPatches.length) throw new Error('Chart edits require upstream file-actions buildDocBytes part patching')
 const bytes=await saveDocx(session.parsed,plan.saveBlocks)
 return {bytes,plan}
}
// Actual upstream Tiptap node/mark/extensions; host can use new Editor({...}).
export { editorExtensions } from './upstream/apps/docs/src/renderer/editor/extensions'
export { Editor, getSchema } from '@tiptap/core'
