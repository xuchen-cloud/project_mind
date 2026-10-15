import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { XlsxSidecarClient } from './upstream/apps/sheets/src/main/xlsx-sidecar-client.ts'
import { SheetSession } from './sheet-session.ts'
import { workbookViewModel } from './view-model.mjs'
import { prepareFixtureSave } from './fixture-save.ts'
const root=dirname(fileURLToPath(import.meta.url))
const client=new XlsxSidecarClient(resolve(process.env.GENOFFICE_XLSX_BINARY ?? `${root}/target/debug/xlsx-sidecar`))
const fixtures=JSON.parse(await readFile(`${root}/fixtures.json`,'utf8'))
const results:any={issue:'#118/F03',commit:'d32d1711f1bf985430757b8c6b3fbddd3831d946',runtime:{node:process.version,platform:process.platform,arch:process.arch},runs:[]}
const saveJson=async(name:string,data:any)=>writeFile(`${root}/${name}`,JSON.stringify(data,null,2)+'\n')
const expected=[{sheet:'明细',row:4,column:1,value:40},{sheet:'明细',row:6,column:1,value:30},{sheet:'说明',row:2,column:1,value:40}]
try {
  for (const kind of ['simple','complex']) {
    const sourcePath=`${root}/${kind}.original.xlsx`
    const hash=createHash('sha256').update(await readFile(sourcePath)).digest('hex')
    if(hash!==fixtures.samples[kind].sha256) throw new Error(`Fixture hash mismatch: ${kind}`)
    for(const branch of ['noop','edited-default','edited-ironcalc','edited-ironcalc-cache-sheet-touch']) {
      const run:any={kind,branch,status:'running',sourceHash:hash}
      const session=new SheetSession(client,sourcePath)
      try {
        const start=performance.now()
        const imported=await session.open()
        await saveJson(`${kind}.${branch}.import.sdk.json`,imported)
        if(branch==='noop') await saveJson(`${kind}.view-model.json`,workbookViewModel(imported))
        run.importMs=performance.now()-start
        if(branch!=='noop') {
          session.setCell('明细',2,0,'香蕉（SDK编辑）')
          session.setCell('明细',2,1,15)
          session.setCell('明细',4,1,'=SUM(B3:B4)+5')
        }
        let formulaValues:any[]|undefined
        if(branch.startsWith('edited-ironcalc')) {
          const prepared=await prepareFixtureSave(session)
          run.recalc=prepared.recalc
          run.calculationChecks=expected.map(e=>({ ...e, actual:run.recalc.cells.find((c:any)=>c.sheet===e.sheet && c.row===e.row && c.column===e.column)?.number,
            passed:run.recalc.cells.some((c:any)=>c.sheet===e.sheet && c.row===e.row && c.column===e.column && c.number===e.value && !c.isError)}))
          formulaValues=prepared.formulaValues
          if(branch==='edited-ironcalc-cache-sheet-touch') {
            // Explicit diagnosis of upstream omission: a public no-value edit
            // loads this cache-only worksheet; formulaValues then writes its cache.
            const marker=prepared.marker
            run.cacheSheetMarker=marker
            session.edits.push(marker)
          }
        }
        run.edits=session.edits
        run.formulaValues=formulaValues
        const filename=`${kind}.${branch}.xlsx`
        const saveStart=performance.now()
        run.mutation=await session.save(`${root}/${filename}`,formulaValues)
        run.saveMs=performance.now()-saveStart
        run.output={file:filename,sha256:createHash('sha256').update(await readFile(`${root}/${filename}`)).digest('hex')}
        const reopened=new SheetSession(client,`${root}/${filename}`)
        try {
          const sdk=await reopened.open()
          await saveJson(`${kind}.${branch}.reopen.sdk.json`,sdk)
          run.sdkChecks=[
            {sheet:'明细',row:2,column:0,field:'value',expected:branch==='noop'?'苹果':'香蕉（SDK编辑）'},
            {sheet:'明细',row:2,column:1,field:'value',expected:branch==='noop'?10:15},
            {sheet:'明细',row:4,column:1,field:'formula',expected:branch==='noop'?'SUM(B3:B4)':'SUM(B3:B4)+5'},
          ].map(e=>{const sh=sdk.metadata.sheets.find((s:any)=>s.name===e.sheet);const c=sdk.ranges[sh.id].cells.find((c:any)=>c.row===e.row&&c.column===e.column);const actual=c?.[e.field];const rawPassed=actual===e.expected;const semanticPassed=e.field==='formula'?String(actual).replace(/^=/,'')===e.expected:rawPassed;return {...e,actual,rawPassed,semanticPassed,passed:semanticPassed,normalization:e.field==='formula'?'optional leading = only':null}})
          run.sdkFormulaCaches=expected.map(e=>{const sh=sdk.metadata.sheets.find((s:any)=>s.name===e.sheet);const c=sdk.ranges[sh.id].cells.find((c:any)=>c.row===e.row&&c.column===e.column);const value=branch==='noop'?(e.sheet==='明细'&&e.row===6?20:30):e.value;return {...e,value,actual:c?.value,formula:c?.formula,passed:c?.value===value}})
        } finally {await reopened.close()}
        run.status=run.sdkChecks.every((c:any)=>c.passed) && run.sdkFormulaCaches.every((c:any)=>c.passed) && (run.calculationChecks??[]).every((c:any)=>c.passed)?'passed':'failed'
      } catch(e:any) {run.status='failed';run.error={name:e.name,message:e.message,stack:e.stack}}
      finally {await session.close().catch((e:any)=>{run.closeError=String(e)})}
      results.runs.push(run)
      await saveJson('sdk-results.json',results)
      console.log(JSON.stringify({kind,branch,status:run.status,mutation:run.mutation,error:run.error}))
    }
  }
} finally {client.stop()}
