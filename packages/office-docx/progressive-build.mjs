/** Deterministic patches against source-lock.json. Never write into upstream/. */
export function adaptProgressiveParser(source) {
  const replace = (before, after) => {
    if (!source.includes(before)) throw Error('Pinned DOCX progressive seam changed: ' + before.slice(0, 100));
    source = source.replace(before, after);
  };
  replace('export interface ParseOptions {', 'export interface ParseOptions {\n  viewBlocks?: number\n');
  replace('  const zip = await loadDocxZip(bytes)', '  const zip = await loadDocxZip(bytes, {validateUtf: options.viewBlocks !== undefined})');
  // Media belonging to an unloaded table/textbox must not be decoded at open.
  replace('  const mediaByRid = await tableBlipMedia(scan.elements, documentXml, zip, rels, docPath)', '  const mediaByRid = options.viewBlocks === undefined ? await tableBlipMedia(scan.elements, documentXml, zip, rels, docPath) : new Map<string, string>()');
  replace('  const externalTxbxByRid = await externalTxbxParts(documentXml, zip, rels, docPath)', '  const externalTxbxByRid = options.viewBlocks === undefined ? await externalTxbxParts(documentXml, zip, rels, docPath) : new Map<string, string>()');
  replace('  let sdtGroupSeq = 0\n  for (const el of scan.elements) {', `  let sdtGroupSeq = 0
  let viewCursor = 0
  let viewComplete = false
  const normalizeViewZOrders = createViewZOrderNormalizer(documentXml)
  async function buildThrough(limit: number) {
  const start = viewCursor
  // Keep complex field groups together: their visible result may be in a
  // later paragraph. A field group is one indivisible parsing dependency.
  let fields: boolean[] = []
  let stop = Math.min(scan.elements.length, viewCursor + Math.max(1, limit))
  for (let n = start; n < stop || (markInsideFieldCode(fields) && n < scan.elements.length); n++) {
    const el = scan.elements[n]
    const xml = documentXml.slice(el.start, el.end)
    fields = fieldStackAfter(xml, fields)
    if (n + 1 >= stop && markInsideFieldCode(fields)) stop = n + 2
  }
  const batch = scan.elements.slice(start, Math.min(stop, scan.elements.length))
  if (options.viewBlocks !== undefined) {
  for (const [rid, data] of await tableBlipMedia(batch, documentXml, zip, rels, docPath)) mediaByRid.set(rid, data)
  for (const el of batch) {
    const xml = documentXml.slice(el.start, el.end)
    for (const [rid, data] of await externalTxbxParts(xml, zip, rels, docPath)) externalTxbxByRid.set(rid, data)
  }
  }
  for (const el of batch) {
    viewCursor++`);
  replace('  foldFieldCodeParagraphs(blocks, buildCtx)', `  }
  await buildThrough(options.viewBlocks ?? Number.MAX_SAFE_INTEGER)
  function finishBlockPasses() {
  foldFieldCodeParagraphs(blocks, buildCtx)`);
  replace('  normalizeImageZOrders(blocks)', '  if (options.viewBlocks === undefined) normalizeImageZOrders(blocks)\n  else normalizeViewZOrders(blocks)');
  replace('  applyProtectedLeadingBreaks(blocks)\n', '  applyProtectedLeadingBreaks(blocks)\n  }\n  finishBlockPasses()\n');
  replace('  for (const block of blocks) {\n    if (block.docxIndex === null || !block.originalXml) continue\n    for (const run of findInkRuns', '  async function collectInks(from: number) {\n  for (const block of blocks.slice(from)) {\n    if (block.docxIndex === null || !block.originalXml) continue\n    for (const run of findInkRuns');
  replace('  return {\n    blocks,\n    zoteroDocumentData,', '  }\n  await collectInks(0)\n  const parsed = {\n    blocks,\n    zoteroDocumentData,');
  replace('  }\n}\n\ninterface BuildContext', `  }
  viewComplete = viewCursor >= scan.elements.length
  if (options.viewBlocks !== undefined) registerViewReader(parsed, {
    get complete() { return viewComplete },
    get sectionBlocks() {
      const result: Array<{type: 'passthrough'; docxIndex: number; originalXml: string}> = []
      let index = elements.length
      for (const el of scan.elements.slice(viewCursor)) {
        const xml = documentXml.slice(el.start, el.end)
        const parts = el.name === 'w:sdt' ? splitSdtParts(xml) : null
        for (const fragment of parts ? parts.map(part => xml.slice(part.start, part.end)) : [xml]) {
          if (fragment.includes('<w:sectPr')) result.push({type: 'passthrough', docxIndex: index, originalXml: fragment})
          index++
        }
      }
      return result
    },
    async read(count: number) {
      const from = blocks.length
      await buildThrough(count)
      finishBlockPasses()
      if (layoutSettings.balanceDbcsSpacing)
        applyBalancedDbcsSpacing(blockRunGroups(blocks.slice(from)), docDefaults?.eastAsiaFont)
      await collectInks(from)
      parsed.extras.lazyMediaHashes = [...(lazyHashesByZip.get(zip) ?? [])]
      if (unconvertedChunksByZip.get(zip)) parsed.extras.altChunksNeedConverter = unconvertedChunksByZip.get(zip)
      viewComplete = viewCursor >= scan.elements.length
      return from
    },
  })
  return parsed
}

interface BuildContext`);
  return "import {registerViewReader, createViewZOrderNormalizer} from 'project-mind:progressive-state';\n" + source;
}

export function adaptProgressiveFileActions(source, root) {
  const replace = (before, after) => {
    if (!source.includes(before)) throw Error('Pinned DOCX progressive file action seam changed: ' + before.slice(0, 100));
    source = source.replace(before, after);
  };
  source = `import {openProgressive} from ${JSON.stringify(root + '/progressive.ts')};\nimport {mountProgressiveContent, materializeProgressive} from ${JSON.stringify(root + '/progressive-renderer.ts')};\n` + source;
  replace('  editor.view.dispatch(tr)\n  carryDocSeen(editor, before)', "  editor.view.dispatch(tr)\n  if (editor.state.doc === before) throw Error('Word 拒绝追加正文，无法保证完整保存')\n  carryDocSeen(editor, before)");
  replace(`    const parsed = await parseDocxOffThread(
      bytes.byteLength === 0 ? await blankDocxBytes() : bytes,
      { owned: true },
    )`, `    const progressive = result.path === 'project-mind.docx' ? await openProgressive(bytes, {initialBlocks: window.__projectMindDocxHost.needsCompleteInitialContent ? Number.MAX_SAFE_INTEGER : undefined}) : null
    const parsed = progressive?.parsed ?? await parseDocxOffThread(
      bytes.byteLength === 0 ? await blankDocxBytes() : bytes,
      { owned: true },
    )`);
  replace(`    setContentPhased(
      phasedHostFor(ctx),
      blocksToPmDoc(parsed.blocks, readSections(parsed), pmDocOptions(parsed)),
    )`, `    if (progressive) { cancelPhasedContent(); mountProgressiveContent(phasedHostFor(ctx), progressive, ctx) }
    else setContentPhased(
      phasedHostFor(ctx),
      blocksToPmDoc(parsed.blocks, readSections(parsed), pmDocOptions(parsed)),
    )`);
  replace('    ctx.setSection(readSectionSettings(parsed))\n    ctx.setSections(readSections(parsed))', '    ctx.setSection(progressive?.sections.at(-1)?.settings ?? readSectionSettings(parsed))\n    ctx.setSections(progressive?.sections ?? readSections(parsed))');
  replace('export async function buildDocBytes(ctx: FileActionContext): Promise<Uint8Array | null> {', 'export async function buildDocBytes(ctx: FileActionContext): Promise<Uint8Array | null> {\n  await materializeProgressive()\n  ctx = window.__projectMindDocxHost.currentContext ?? ctx');
  return source;
}

export function adaptProgressivePhases(source, root) {
  const replace = (before, after) => {
    if (!source.includes(before)) throw Error('Pinned DOCX phased seam changed: ' + before);
    source = source.replace(before, after);
  };
  source = `import {progressivePending, materializeProgressive, cancelProgressive} from ${JSON.stringify(root + '/progressive-renderer.ts')};\n` + source;
  replace('  return settled\n', '  return Promise.all([settled, materializeProgressive()]).then(() => {})\n');
  replace('  return cancelPending !== null', '  return cancelPending !== null || progressivePending()');
  replace('export function cancelPhasedContent(): void {', 'export function cancelPhasedContent(): void {\n  cancelProgressive()');
  return source;
}

export function progressiveParserPlugin(root) {
  return {name: 'project-mind-docx-progressive-parser', setup(build) {
    build.onResolve({filter: /^project-mind:progressive-state$/}, () => ({path: root + '/progressive-state.ts'}));
    build.onLoad({filter: /[\\/]docx-engine[\\/]src[\\/]patch\.ts$/}, async ({path}) => {
      const {readFile} = await import('node:fs/promises');
      const source = await readFile(path, 'utf8');
      const before = '  await cleanupDocxOwnedResources(out, docPath)';
      if (!source.includes(before)) throw Error('Pinned DOCX resource cleanup caller changed');
      return {contents: source.replace(before, '  await cleanupDocxOwnedResources(out, docPath, documentXml)'), loader: 'ts'};
    });
    build.onLoad({filter: /[\\/]docx-engine[\\/]src[\\/]resource-cleanup\.ts$/}, async ({path}) => {
      const {readFile} = await import('node:fs/promises');
      let source = await readFile(path, 'utf8');
      const before = 'export async function cleanupDocxOwnedResources(zip: JSZip, documentPath: string): Promise<void> {';
      const guard = '      referencedIds.has(id) ||';
      if (!source.includes(before) || !source.includes(guard)) throw Error('Pinned DOCX resource cleanup seam changed');
      source = source.replace(before, 'export async function cleanupDocxOwnedResources(zip: JSZip, documentPath: string, baselineDocumentXml: string): Promise<void> {\n  const baselineIds = referencedRelationshipIds(baselineDocumentXml)')
        .replace(guard, '      referencedIds.has(id) || !baselineIds.has(id) ||');
      return {contents: source, loader: 'ts'};
    });
    build.onLoad({filter: /[\\/]docx-engine[\\/]src[\\/]zip-load\.ts$/}, async ({path}) => {
      const {readFile} = await import('node:fs/promises');
      let source = await readFile(path, 'utf8');
      const before = 'export async function loadDocxZip(bytes: Uint8Array): Promise<JSZip> {';
      const gate = '  assertZipWithinLimits(zip)\n  await normalizeOoxmlParts(zip)';
      if (!source.includes(before) || !source.includes(gate)) throw Error('Pinned DOCX ZIP UTF seam changed');
      source = source.replace(before, 'export async function loadDocxZip(bytes: Uint8Array, options: {validateUtf?: boolean} = {}): Promise<JSZip> {')
        .replace(gate, '  assertZipWithinLimits(zip)\n  if (options.validateUtf) await validateViewXml(zip)\n  await normalizeOoxmlParts(zip)');
      return {contents: "import {validateViewXml} from 'project-mind:progressive-state';\n" + source, loader: 'ts'};
    });
    build.onLoad({filter: /[\\/]docx-engine[\\/]src[\\/]parse\.ts$/}, async ({path}) => {
      const {readFile} = await import('node:fs/promises');
      return {contents: adaptProgressiveParser(await readFile(path, 'utf8')), loader: 'ts'};
    });
  }};
}
