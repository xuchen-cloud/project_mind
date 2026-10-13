import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { openPptx, savePptx, replaceAllInDeck, elementSpid, type SlideDeck } from '@genoffice/pptx-engine'
import { buildRenderSlide } from '@genoffice/pptx-render'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const mime: Record<string,string> = {png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',svg:'image/svg+xml',emf:'image/x-emf',wmf:'image/x-wmf'}
// Engine IDs are process-local. The client receives them in the initial JSON;
// preserve their association with OOXML cNvPr ID when opening the original again.
const ids = new Map<string,string>()
function remember(kind: string, deck: SlideDeck) {
  deck.slides.forEach((s,i) => s.elements.forEach(el => {
    const nvId = elementSpid(el)
    if (nvId != null) ids.set(`${kind}:${i}:${el.id}`, String(nvId))
  }))
}

export async function load(kind: 'simple'|'complex') {
  if (kind !== 'simple' && kind !== 'complex') throw new Error('Unsupported fixture kind')
  const bytes = await readFile(`${ROOT}/${kind}.original.pptx`)
  const manifest = JSON.parse(await readFile(`${ROOT}/manifest.json`,'utf8'))
  if (sha256(bytes) !== manifest.samples[kind].sha256) throw new Error('Original fixture hash changed')
  const initial = JSON.parse(await readFile(`${ROOT}/browser/public/${kind}.noop.json`,'utf8'))
  remember(kind,initial.deck)
  const opened = await openPptx(bytes)
  return opened
}

export function render(opened: Awaited<ReturnType<typeof openPptx>>) {
  const media: Record<string,string> = {}
  for (const [part,bytes] of opened.archive.entries) {
    if (!part.startsWith('ppt/media/')) continue
    const ext = part.split('.').pop()!.toLowerCase()
    media[part] = `data:${mime[ext] ?? 'application/octet-stream'};base64,${Buffer.from(bytes).toString('base64')}`
  }
  const renderSlides = opened.deck.slides.map((slide,index) => buildRenderSlide(slide,opened.deck.size,{fitWidthPx:960,slideNo:index+1,media:ref=>media[ref]}))
  const textElements = opened.deck.slides.flatMap((slide,slideIndex) => slide.elements.flatMap(el => {
    if ((el.type !== 'text' && el.type !== 'shape') || !el.text) return []
    return [{slideIndex,elementId:el.id,nvId:elementSpid(el),paragraphs:el.text.paragraphs,originalRichText:el.text,
      text:el.text.paragraphs.map(p=>p.runs.map(r=>r.text).join('')).join('\n')}]
  }))
  return {renderSlides,deck:opened.deck,media,textElements}
}

export function edit(opened: Awaited<ReturnType<typeof openPptx>>, args: {kind:'simple'|'complex';slideIndex:number;elementId:string;text:string}) {
  const {kind,slideIndex,elementId,text} = args
  if (!Number.isInteger(slideIndex) || slideIndex < 0 || typeof elementId !== 'string' || typeof text !== 'string') throw new Error('Expected slideIndex, elementId and text')
  const slide = opened.deck.slides[slideIndex]
  if (!slide) throw new Error('Slide not found')
  const nvId = ids.get(`${kind}:${slideIndex}:${elementId}`)
  if (nvId == null) throw new Error('Element ID was not issued by this validation session')
  const el = slide.elements.find(e=>String(elementSpid(e)) === nvId)
  if (!el || (el.type !== 'text' && el.type !== 'shape') || !el.text) throw new Error('Target is not a text element')
  // This validation endpoint covers the simple fixture's existing one-paragraph
  // text boxes. Rich paragraphs are returned intact for the main UI's adapter.
  if (el.text.paragraphs.length !== 1 || el.text.paragraphs[0]!.runs.some(r=>r.field || r.text.includes('\n')) || text.includes('\n')) throw new Error('Validation edit supports an existing single paragraph without dynamic fields')
  const oldText = el.text.paragraphs[0]!.runs.map(r=>r.text).join('')
  if (!oldText) throw new Error('Validation edit requires existing nonempty text')
  if (text === oldText) return {count:0,changedSlides:[]}
  const result = replaceAllInDeck(opened.deck,oldText,text,{slideIndex,elementId:el.id,matchCase:true,firstOnly:true})
  if (result.count !== 1) throw new Error('Engine did not replace exactly one target text')
  return result
}

export async function save(opened: Awaited<ReturnType<typeof openPptx>>, kind: 'simple'|'complex') {
  if (kind !== 'simple' && kind !== 'complex') throw new Error('Unsupported fixture kind')
  const bytes = await savePptx(opened)
  const candidate = `${ROOT}/${kind}.browser-edited.pptx`
  await writeFile(candidate,bytes)
  const reopened = await openPptx(await readFile(candidate))
  remember(kind,reopened.deck)
  return {...render(reopened),hash:sha256(bytes),bytes:bytes.length,candidate}
}

export async function editAndExport(args: {kind:'simple'|'complex';slideIndex:number;elementId:string;text:string}) {
  const opened = await load(args.kind)
  const result = edit(opened,args)
  return {...await save(opened,args.kind),editResult:result}
}
