import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import { Node as PmNode } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import {getSchema,editorExtensions} from './prototype'
import {openDocx,savePmDoc,saveDocx,parseDocx,readSections,blocksToPmDoc,pmDocOptions} from './prototype'
const protocol_id='genoffice-docx-controlled-roundtrip-v1'
const sha=(b:Uint8Array|string)=>createHash('sha256').update(b).digest('hex')
const j=(path:string,obj:unknown)=>writeFile(path,JSON.stringify(obj,null,2))
const text=(n:any):string=>n.type==='text'?n.text??'':(n.content??[]).map(text).join('')
const fixtures=JSON.parse(await readFile('fixtures/fixtures.json','utf8'))
const runs:any[]=[]
await mkdir('models',{recursive:true})
for(const name of ['simple','complex']) {
 const bytes=await readFile(`fixtures/${name}.original.docx`)
 const baseline_hash=sha(bytes);if(baseline_hash!==fixtures.cases[name].sha256)throw new Error('fixture hash mismatch '+name)
 for(const [path,mode] of [['engine','noop'],['public-pm','noop'],['public-pm','edited'],['tiptap-schema','noop'],['tiptap-schema','edited']]) {
  const model_path=path==='tiptap-schema'?'parseDocx → blocksToPmDoc → upstream editorExtensions/getSchema → ProseMirror EditorState transaction/getJSON → pmDocToSavePlan → saveDocx':path==='engine'?'parseDocx → original SaveBlock[] → saveDocx':'parseDocx → blocksToPmDoc(readSections, pmDocOptions) → pmDocToSavePlan → saveDocx'
  const row:any={protocol_id,model_path,baseline_hash,case:name,mode,path,status:'started'}
  try {
   const session=await openDocx(bytes)
   await j(`models/${name}.${path}.${mode}.parsed.json`,session.parsed)
   await j(`models/${name}.${path}.${mode}.pm.before.json`,session.pmDoc)
   if(path==='tiptap-schema') {
    const schema=getSchema(editorExtensions);const doc=PmNode.fromJSON(schema,session.pmDoc);doc.check()
    let state=EditorState.create({schema,doc})
    if(mode==='edited') {
     const tr=state.tr
     for(const target of [fixtures.edit_targets.paragraph,fixtures.edit_targets.table_cell]) {
      const positions:number[]=[];tr.doc.descendants((node,pos)=>{if(node.isText&&node.text?.includes(target.before))positions.push(pos+node.text.indexOf(target.before))})
      if(positions.length!==1)throw new Error('schema transaction target not unique '+target.before)
      tr.insertText(target.after,positions[0],positions[0]+target.before.length)
     }
     state=state.apply(tr);state.doc.check()
    }
    session.pmDoc=state.doc.toJSON();row.schema={node_types:Object.keys(schema.nodes),mark_types:Object.keys(schema.marks),valid:true,edit_method:mode==='edited'?'EditorState.tr.insertText':'Node.fromJSON/schema check → toJSON'}
   }
   if(mode==='edited'&&path!=='tiptap-schema') {
    const para=session.pmDoc.content!.filter((n:any)=>['docParagraph','docHeading','docListItem'].includes(n.type)&&text(n)===fixtures.edit_targets.paragraph.before)
    if(para.length!==1)throw new Error('paragraph target count '+para.length)
    const replace=(node:any,before:string,after:string):number=>{let hits=0;if(node.type==='text'&&node.text.includes(before)){node.text=node.text.replace(before,after);hits++}for(const c of node.content??[])hits+=replace(c,before,after);return hits}
    if(replace(para[0],fixtures.edit_targets.paragraph.before,fixtures.edit_targets.paragraph.after)!==1)throw new Error('paragraph edit not uniquely applied')
    const table=session.pmDoc.content!.filter((n:any)=>n.type==='docTable')[fixtures.edit_targets.table_cell.table]
    const cell=table?.content?.[fixtures.edit_targets.table_cell.row]?.content?.[fixtures.edit_targets.table_cell.column]
    if(!cell||text(cell)!==fixtures.edit_targets.table_cell.before)throw new Error('real PM table cell model mismatch: '+JSON.stringify(table))
    if(replace(cell,fixtures.edit_targets.table_cell.before,fixtures.edit_targets.table_cell.after)!==1)throw new Error('table edit not uniquely applied')
   }
   await j(`models/${name}.${path}.${mode}.pm.after.json`,session.pmDoc)
   const result=path==='engine'?{bytes:await saveDocx(session.parsed,session.parsed.blocks.filter(b=>!b.hidden).map(b=>({kind:'original' as const,docxIndex:b.docxIndex!}))),plan:null}:await savePmDoc(session)
   await j(`models/${name}.${path}.${mode}.plan.json`,result.plan)
   row.output=`${name}.${path}.${mode}.docx`;await writeFile(row.output,result.bytes)
   const reopened=await parseDocx(result.bytes)
   await j(`models/${name}.${path}.${mode}.reopened.json`,reopened)
   const reopenedPm=blocksToPmDoc(reopened.blocks,readSections(reopened),pmDocOptions(reopened))
   await j(`models/${name}.${path}.${mode}.reopened.pm.json`,reopenedPm)
   const expectedP=mode==='edited'?fixtures.edit_targets.paragraph.after:fixtures.edit_targets.paragraph.before
   const expectedC=mode==='edited'?fixtures.edit_targets.table_cell.after:fixtures.edit_targets.table_cell.before
   const p=(reopenedPm.content??[]).filter((n:any)=>text(n)===expectedP)
   const t=(reopenedPm.content??[]).find((n:any)=>n.type==='docTable')
   if(p.length!==1||text(t?.content?.[1]?.content?.[1]??{})!==expectedC)throw new Error('reopened engine edit assertions failed')
   row.reopened_assertions={paragraph:true,table_cell:true,block_types:reopened.blocks.map(b=>b.type),section_count:readSections(reopened).length}
   row.plan_summary=result.plan?{changedCount:result.plan.changedCount,deletedCount:result.plan.deletedCount,saveBlockKinds:result.plan.saveBlocks.map(b=>b.kind)}:null
   row.output_sha256=sha(result.bytes);row.byte_identical=baseline_hash===row.output_sha256;row.status='completed'
  }catch(e:any){row.status='failed';row.error={message:e.message,stack:e.stack};console.error(name,path,mode,e.message)}
  runs.push(row);await j('engine-results.json',{protocol_id,upstream_commit:'d32d1711f1bf985430757b8c6b3fbddd3831d946',node:process.version,fixture_manifest_sha256:sha(await readFile('fixtures/fixtures.json')),runs})
 }
}
console.log(JSON.stringify(runs.map(r=>({case:r.case,path:r.path,mode:r.mode,status:r.status,byte_identical:r.byte_identical,error:r.error?.message})),null,2))

if(runs.some(r=>r.status!=='completed'))process.exitCode=1
