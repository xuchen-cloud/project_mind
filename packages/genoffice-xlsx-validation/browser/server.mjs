import http from 'node:http';import {readFile,writeFile,mkdir} from 'node:fs/promises';import {dirname,resolve} from 'node:path';import {fileURLToPath} from 'node:url';import {XlsxSidecarClient,SheetSession,workbookViewModel} from '../integration.bundle.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');const client=new XlsxSidecarClient(process.env.GENOFFICE_XLSX_BINARY??`${root}/target/debug/xlsx-sidecar`);
async function model(kind){const s=new SheetSession(client,`${root}/${kind}.original.xlsx`);try{return workbookViewModel(await s.open());}finally{await s.close();}}
http.createServer(async(req,res)=>{let session;try{
const u=new URL(req.url,'http://127.0.0.1');const kind=u.searchParams.get('kind')??'simple';if(!['simple','complex'].includes(kind))throw Error('Unknown fixture');
if(u.pathname==='/model'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(await model(kind)));return;}
if(u.pathname==='/save'&&req.method==='POST'){
 const engine=u.searchParams.get('engine');if(!['chromium','webkit'].includes(engine))throw Error('Unknown browser');const chunks=[];for await(const c of req)chunks.push(c);const inputs=JSON.parse(Buffer.concat(chunks).toString());
 if(typeof inputs.text!=='string'||!Number.isFinite(Number(inputs.number))||typeof inputs.formula!=='string'||!inputs.formula.startsWith('='))throw Error('Expected text, number and formula');
 session=new SheetSession(client,`${root}/${kind}.original.xlsx`);await session.open();session.setCell('明细',2,0,inputs.text);session.setCell('明细',2,1,Number(inputs.number));session.setCell('明细',4,1,inputs.formula);
 const recalc=await session.recalculate();if(recalc.cells.some(c=>c.isError))throw Error('Formula calculation failed');
 const formulaValues=session.metadata.sheets.map(s=>({sheetName:s.name,cells:recalc.cells.filter(c=>c.sheet===s.name&&c.isFormula).map(c=>({row:c.row,column:c.column,value:c.number??c.formatted}))}));
 // Scoped probe workaround for reproduced upstream cache-only sheet omission.
 // Loads the existing cross-sheet formula without changing its value/formula.
 const sheet=session.metadata.sheets.find(s=>s.name==='说明');const cell=session.ranges[sheet.id].cells.find(c=>c.row===2&&c.column===1);session.edits.push({sheetName:'说明',row:2,column:1,writeValue:false,cell:{value:cell.value,formula:cell.formula}});
 const dir=`${root}/browser/output/${engine}`;await mkdir(dir,{recursive:true});const path=`${dir}/${kind}.browser-edited.xlsx`;const mutation=await session.save(path,formulaValues);const reopened=new SheetSession(client,path);let data;try{data=await reopened.open();}finally{await reopened.close();}
 const result={candidate:`browser/output/${engine}/${kind}.browser-edited.xlsx`,bytes:(await readFile(path)).length,mutation,recalc,model:workbookViewModel(data),sdk:data};await writeFile(`${dir}/${kind}.events.json`,JSON.stringify({inputs,...result},null,2));res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));return;
}
const file={'/':'index.html','/main.js':'main.js'}[u.pathname];if(!file||req.method!=='GET'){res.statusCode=404;res.end();return;}res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':'text/html');res.end(await readFile(`${root}/browser/${file}`));
}catch(e){res.statusCode=500;res.end(JSON.stringify({error:e.message}));}finally{if(session)await session.close();}}).listen(1441,'127.0.0.1',()=>console.log('GenOffice XLSX thin host 127.0.0.1:1441'));
process.on('SIGINT',()=>{client.stop();process.exit(0);});
