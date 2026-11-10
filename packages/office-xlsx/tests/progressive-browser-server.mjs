/** Opt-in localhost acceptance host. Saves use the original bytes + cumulative gateway journal. */
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {readFile, mkdtemp, readdir, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve, extname, sep} from 'node:path'
import {pathToFileURL} from 'node:url'
import JSZip from 'jszip'
import {createViewSession, inspectView, edit, recalculate} from '../dist/engine.mjs'

export const rendererDist = process.env.XLSX_ACCEPTANCE_DIST ? pathToFileURL(resolve(process.env.XLSX_ACCEPTANCE_DIST)+sep) : new URL('../dist/',import.meta.url)

export const ROWS = 20000
export const WITNESS = 'XLSX303'
export async function fixture() {
  const zip = await JSZip.loadAsync(await readFile(new URL('fixtures/complex.original.xlsx', import.meta.url)))
  const put = (xml, address, contents) => {
    const row = Number(address.match(/\d+$/)[0])
    return xml.replace(new RegExp(`(<row\\b[^>]*r="${row}"[^>]*>)([\\s\\S]*?)(</row>)`), (_, start, cells, end) =>
      start + cells.replace(new RegExp(`<c\\b[^>]*r="${address}"[^>]*>[\\s\\S]*?</c>`), '') + `<c r="${address}">${contents}</c>` + end)
  }
  let xml = await zip.file('xl/worksheets/sheet1.xml').async('string')
  xml = xml.replace(/<dimension\b[^>]*\/>/, `<dimension ref="A1:H${ROWS}"/>`)
    .replace('</sheetData>', Array.from({length: ROWS - 10}, (_, i) => `<row r="${i+11}"><c r="A${i+11}"><v>${i+11===10000?7:i+11===12000?10:i+11}</v></c></row>`).join('') + '</sheetData>')
  xml = put(xml, 'D3', '<v>20</v>')
  xml = put(xml, 'A3', `<is><t>${WITNESS}</t></is>`).replace('<c r="A3">', '<c r="A3" t="inlineStr">')
  xml = put(xml, 'F3', `<f>B3+D3+A${ROWS}+'说明'!Z1</f><v>20037</v>`)
  xml = put(xml, 'C7', '<f>B3+1</f><v>11</v>')
  zip.file('xl/worksheets/sheet1.xml', xml)
  zip.file('xl/worksheets/sheet2.xml', put(await zip.file('xl/worksheets/sheet2.xml').async('string'), 'Z1', '<v>7</v>')
    .replace(/<dimension\b[^>]*\/>/, '<dimension ref="A1:Z10"/>'))
  zip.file('xl/worksheets/never-opened.xml', '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="999999"><c r="A999999" t="inlineStr"><is><t>unvisited OOXML witness</t></is></c></row></sheetData></worksheet>')
  return new Uint8Array(await zip.generateAsync({type:'uint8array', compression:'DEFLATE'}))
}

export async function startHarness() {
  const original = process.env.XLSX_ACCEPTANCE_FIXTURE ? new Uint8Array(await readFile(process.env.XLSX_ACCEPTANCE_FIXTURE)) : await fixture(), root = await mkdtemp(join(tmpdir(), 'xlsx-browser-progressive-'))
  let bytes = original, baseline = original, session, opens = 0, initialOpenMs
  let owners = []
  let barrier
  const reads = [], saves = [], failures = [], calculations = []
  const resources = new Set(JSON.parse(await readFile(new URL('renderer-resources.json',rendererDist))).files)
  const mime = {'.html':'text/html; charset=utf-8','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.ttf':'font/ttf','.woff':'font/woff','.woff2':'font/woff2','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml'}
  async function open() {
    await session?.close()
    const started = performance.now()
    baseline = bytes
    session = await createViewSession(bytes, {tempRoot: root})
    opens++
    if (opens===1) {initialOpenMs=performance.now()-started; owners=await readdir(root); assert.equal(owners.length,1)}
    return session.model
  }
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://localhost').pathname
      const json = value => {response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value))}
      const body = async () => {let text = ''; for await (const chunk of request) text += chunk; return JSON.parse(text)}
      if (path === '/favicon.ico') {response.statusCode=204; return response.end()}
      if (resources.has(path.slice(1))) {
        response.setHeader('Content-Type',mime[extname(path)]??'application/octet-stream')
        return response.end(await readFile(new URL(path.slice(1),rendererDist)))
      }
      if (path === '/model') return json(session?.model ?? await open())
      if (path === '/inspect-view') return json(await inspectView(bytes))
      if (path === '/read' && request.method === 'POST') {
        const input = await body(), started = performance.now()
        const result = await session.read(input)
        reads.push({request: input, ms: performance.now()-started, rangeReady: result?.rangeReady, metadataReady: result?.metadataReady, indexingComplete: result?.indexingComplete,indexedThroughRow:result?.indexedThroughRow,area:result?.area})
        if(barrier&&!barrier.used&&input.kind==='range'&&input.sheetId===barrier.sheetId&&input.range.startRow<=barrier.row&&input.range.endRow>=barrier.row) {
          barrier.used=true; barrier.reached(); await barrier.released
        }
        return json(result)
      }
      if (path === '/calculate' && request.method === 'POST') {
        const input=await body(), result=await recalculate(bytes,input)
        calculations.push({request:input,result})
        return json(result)
      }
      if (path === '/save' && request.method === 'POST') {
        const {edits, editRevision} = await body()
        bytes = await edit(baseline, edits)
        const view = await inspectView(bytes)
        saves.push({editRevision, edits, cells: view.ranges[view.activeSheetId].cells})
        return json({editRevision})
      }
      if (path === '/reopen' && request.method === 'POST') return json(await open())
      if (path === '/bytes') return response.end(bytes)
      if (path === '/original') return response.end(original)
      if (path === '/browser.mjs' || path === '/browser.css') {
        response.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : 'text/javascript')
        return response.end(await readFile(new URL(path.slice(1),rendererDist)))
      }
      if (path === '/host.mjs') {
        response.setHeader('Content-Type', 'text/javascript')
        return response.end(await readFile(new URL('progressive-browser-host.mjs', import.meta.url)))
      }
      if (path === '/') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8')
        return response.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/browser.css"><style>html,body,#editor{height:100%;margin:0}#editor{width:100vw}iframe{border:0;width:100%;height:100%}</style><div id="editor"></div><script type="module" src="/host.mjs"></script>')
      }
      response.statusCode = 404; response.end('Not found')
    } catch (error) {failures.push(String(error)); response.statusCode = 500; response.end(String(error))}
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {url: `http://127.0.0.1:${server.address().port}`, original, reads, saves, failures, calculations,
    holdNextRange(sheetId,row) {
      let reached,release
      const pending=new Promise(resolve=>{reached=resolve}),released=new Promise(resolve=>{release=resolve})
      barrier={sheetId,row,reached,released,used:false}
      return {pending,release}
    },
    async ownership() {return {opens, initialOpenMs, owners: await readdir(root), originalOwners: owners}},
    async close() {await new Promise(resolve => server.close(resolve)); await session?.close(); assert.deepEqual(await readdir(root), []); await rm(root, {recursive:true, force:true})},
  }
}
