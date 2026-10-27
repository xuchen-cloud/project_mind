/** Adapt pinned authoring without changing vendor bytes or its editing path. */
export function adaptSummaryReader(source) {
 const replace=(before,after)=>{
  if(!source.includes(before))throw Error('Pinned Word summary seam changed: '+before);
  source=source.replace(before,after);
 };
 replace('async function docsModules() {\n  await ensureDom()',
  'async function docsModules(needsDom = true) {\n  if (needsDom) await ensureDom()');
 replace('export async function openDocument(bytes: Uint8Array): Promise<OpenDocument> {',
  'export async function openDocument(bytes: Uint8Array, initial?: {summary: true; parsed: Parsed}): Promise<OpenDocument> {');
 replace('  const mods = await docsModules()\n  const parsed = await parseDocx(bytes)',
  '  const mods = await docsModules(!initial?.summary)\n  const parsed = initial?.parsed ?? await parseDocx(bytes)');
 replace("    element: document.createElement('div'),\n    extensions: mods.extensions.editorExtensions,",
  "    element: initial?.summary ? null : document.createElement('div'),\n    ...(initial?.summary ? {content: mods.convert.blocksToPmDoc(parsed.blocks, readSections(parsed))} : {}),\n    extensions: mods.extensions.editorExtensions,");
 replace('  editor.commands.setContent(', '  if (!initial?.summary) editor.commands.setContent(');
 return source;
}
