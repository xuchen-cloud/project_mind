import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { openPptx, savePptx, replaceAllInDeck, updateConnectorsForMoved, getSlideNotes } from '@genoffice/pptx-engine'
import { buildRenderSlide } from '@genoffice/pptx-render'

const root = dirname(fileURLToPath(import.meta.url))
const source = process.env.GENOFFICE_ORIGINALS_DIR ?? root
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const manifest = JSON.parse(await readFile(`${root}/manifest.json`, 'utf8'))
await mkdir(`${root}/browser/public`, {recursive:true})
const results: any[] = []
const text = (el: any) => (el.text?.paragraphs ?? []).map((p: any) => p.runs.map((r: any) => r.text).join('')).join('\n')
const snapshot = (opened: any) => ({
  size: opened.deck.size,
  slides: opened.deck.slides.map((slide: any) => ({path: slide.path,
    notes: getSlideNotes(opened.archive, slide.path),
    elements: slide.elements.map((el: any) => ({id: el.id, type: el.type, text: text(el), transform: el.transform, mediaRef: el.mediaRef,
      ...(el.type === 'chart' ? {chart: el.chart} : {})})),
  })),
})
const mime: Record<string,string> = {png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',svg:'image/svg+xml',emf:'image/x-emf',wmf:'image/x-wmf'}
for (const kind of ['simple', 'complex']) {
  const original = await readFile(`${root}/${kind}.original.pptx`)
  if (hash(original) !== manifest.samples[kind].sha256) throw new Error(`${kind}: copy hash mismatch`)
  if (hash(await readFile(`${source}/${kind}.original.pptx`)) !== hash(original)) throw new Error(`${kind}: source hash mismatch`)
  for (const mode of ['noop', 'edited']) {
    const start = performance.now()
    try {
      const opened = await openPptx(original)
      const before = snapshot(opened)
      let replacement: unknown = null
      if (mode === 'edited') {
        replacement = replaceAllInDeck(opened.deck, manifest.old_text, manifest.new_text, {slideIndex: 0})
        if ((replacement as any).count !== 1) throw new Error('expected exactly one Chinese replacement')
        const slide = opened.deck.slides[0]!
        const pic = slide.elements.find(el => el.type === 'picture')
        if (!pic || pic.type !== 'picture') throw new Error('picture target missing')
        // Same public model mutation used by core pptx-ops setTransform; no XML editing in this harness.
        pic.transform = {...pic.transform, offset: {...pic.transform.offset, x: pic.transform.offset.x + manifest.picture_delta_emu}}
        pic.dirtyTransform = true
        updateConnectorsForMoved(slide, [pic.id])
      }
      const saved = await savePptx(opened)
      const candidate = `${root}/${kind}.${mode}.pptx`
      await writeFile(candidate, saved)
      const reopened = await openPptx(saved)
      const media: Record<string,string> = {}
      for (const [part,bytes] of reopened.archive.entries) {
        if (part.startsWith('ppt/media/')) {
          const ext = part.split('.').pop()!.toLowerCase()
          media[part] = `data:${mime[ext] ?? 'application/octet-stream'};base64,${Buffer.from(bytes).toString('base64')}`
        }
      }
      const renderSlides = reopened.deck.slides.map((s,i) => buildRenderSlide(s,reopened.deck.size,{fitWidthPx:960,slideNo:i+1,media:ref=>media[ref]}))
      const after = snapshot(reopened)
      const expected = JSON.parse(JSON.stringify(before))
      if (mode === 'edited') {
        expected.slides[0].elements.find((el: any) => el.text.includes(manifest.old_text)).text = expected.slides[0].elements.find((el: any) => el.text.includes(manifest.old_text)).text.replace(manifest.old_text, manifest.new_text)
        expected.slides[0].elements.find((el: any) => el.type === 'picture').transform.offset.x += manifest.picture_delta_emu
      }
      const semanticMatch = JSON.stringify(expected) === JSON.stringify(after)
      await writeFile(`${root}/${kind}.${mode}.sdk.json`, JSON.stringify({before,expected,after,semanticMatch},null,2))
      const textElements = reopened.deck.slides.flatMap((slide,slideIndex) => slide.elements.flatMap(el => {
        if ((el.type !== 'text' && el.type !== 'shape') || !el.text) return []
        return [{slideIndex,elementId:el.id,paragraphs:el.text.paragraphs,originalRichText:el.text,text:text(el)}]
      }))
      await writeFile(`${root}/browser/public/${kind}.${mode}.json`, JSON.stringify({kind,mode,deck:reopened.deck,media,renderSlides,textElements}))
      results.push({kind,mode,status:semanticMatch?'passed':'failed',candidate,sha256:hash(saved),bytes:saved.length,elapsedMs:performance.now()-start,replacement,slides:reopened.deck.slides.length,renderNodeCounts:renderSlides.map(s=>s.nodes.length),sdkSemanticMatch:semanticMatch})
    } catch (error) {
      results.push({kind,mode,status:'failed',error:String(error),stack:(error as Error).stack})
    }
  }
}
const originalHashes = await Promise.all(['simple','complex'].map(async kind => ({kind,source:hash(await readFile(`${source}/${kind}.original.pptx`)),copy:hash(await readFile(`${root}/${kind}.original.pptx`)),expected:manifest.samples[kind].sha256})))
const output = {upstreamSha:'d32d1711f1bf985430757b8c6b3fbddd3831d946',node:process.version,results,originalHashes,originalsUnchanged:originalHashes.every(x=>x.source===x.expected&&x.copy===x.expected)}
await writeFile(`${root}/sdk-results.json`,JSON.stringify(output,null,2))
console.log(JSON.stringify(output,null,2))
