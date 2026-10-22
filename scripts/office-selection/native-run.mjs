/** Opt-in, isolated native runner. Does not build; running this file launches the supplied Tauri binary. */
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdir,realpath,readFile,writeFile,copyFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import JSZip from '../../packages/office-docx/node_modules/jszip/lib/index.js';
import {startSelectionProvider} from './provider.mjs';
const options=Object.fromEntries(process.argv.slice(2).map(arg=>{const i=arg.indexOf('=');if(i<1)throw Error('Use --name=value');return [arg.slice(2,i),arg.slice(i+1)]}));
if(!options.binary||!options.out)throw Error('Required --binary=/absolute/measurement-binary --out=/unique/empty/output-directory');
const format=options.format??'docx';
if(!['docx','xlsx','pptx'].includes(format))throw Error('Invalid format');
// Reject reuse: native fixtures and credentials must stay isolated from real work.
await mkdir(resolve(options.out),{recursive:false});
// Match production fixture setup: SQLite's NOFOLLOW requires canonical parents
// (macOS /tmp is a symlink to /private/tmp).
const out=await realpath(resolve(options.out)),binary=resolve(options.binary),workspace=resolve(out,'workspace'),data=resolve(out,'app-data');
const run=(args,env={})=>new Promise((yes,no)=>{const p=spawn(process.execPath,args,{stdio:'inherit',env:{...process.env,...env}});p.on('error',no);p.on('exit',code=>code===0?yes():no(Error(`Setup exited ${code}`)))});
await run(['scripts/office-performance/native-run.mjs',`--binary=${binary}`,`--out=${out}`,`--workspace=${workspace}`,`--data=${data}`,'--setup=1','--visible=1']);
const setup=JSON.parse(await readFile(resolve(out,'setup.json'),'utf8'));if(setup.status!=='setup'||!setup.projectRoot)throw Error('Native fixture provisioning did not complete');
const fixture=format==='xlsx'?'packages/office-xlsx/tests/fixtures/simple.original.xlsx':format==='pptx'?'packages/genoffice-pptx-validation/complex.original.pptx':'packages/office-docx/test/fixtures/complex.original.docx';
await copyFile(resolve(fixture),resolve(setup.projectRoot,`selection.${format}`));
const marker='原生选区验收改写',provider=await startSelectionProvider(marker,format);let result,child,logs='';
const server=createServer(async(req,res)=>{
 res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','content-type');
 if(req.method==='OPTIONS'){res.end();return}
 if(req.url==='/provider'){res.setHeader('content-type','application/json');res.end(JSON.stringify(provider.state));return}
 if(req.url!=='/result'||req.method!=='POST'){res.writeHead(404);res.end();return}
 try{let body='';for await(const chunk of req){body+=chunk;if(body.length>4*1024*1024)throw Error('Report too large')}
  result=JSON.parse(body);await writeFile(resolve(out,'selection-result.json'),JSON.stringify(result,null,2));res.end('saved');setTimeout(()=>child?.kill('SIGTERM'),200);
 }catch(error){res.writeHead(400);res.end(String(error))}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const controlUrl=`http://127.0.0.1:${server.address().port}`;
const config={page:'office-selection',workspaceRoot:workspace,format,visible:true,providerUrl:provider.url,marker,controlUrl,reportUrl:controlUrl+'/result'};
try{
 child=spawn(binary,[],{env:{...process.env,PROJECT_MIND_APP_DATA_DIR:data,PROJECT_MIND_OFFICE_PERFORMANCE:JSON.stringify(config)},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',c=>logs+=c);child.stderr.on('data',c=>logs+=c);
 const timeout=setTimeout(()=>child.kill('SIGTERM'),Number(options.timeout??180000));let force;
 child.once('exit',()=>clearTimeout(force));
 try{await new Promise((yes,no)=>{child.on('error',no);child.on('exit',yes);timeout.unref();force=setTimeout(()=>child.kill('SIGKILL'),Number(options.timeout??180000)+5000)})}finally{clearTimeout(timeout);clearTimeout(force)}
 await writeFile(resolve(out,'selection.log'),logs);
 if(!result||result.status!=='passed')throw Error(`Native selection not passed: ${result?.error??logs.slice(-2000)}`);
 if(format==='docx'){
 const zip=await JSZip.loadAsync(await readFile(resolve(setup.projectRoot,'selection.docx')));
 const xml=await zip.file('word/document.xml').async('string');
 if(!/<w:ins\b[^>]*w:author="Project Mind AI"/.test(xml)||!/<w:del\b[^>]*w:author="Project Mind AI"/.test(xml)||!xml.includes(marker))throw Error('Saved DOCX lacks original native tracked revisions');
 result.savedXml={insertion:true,deletion:true,author:'Project Mind AI',replacement:true};await writeFile(resolve(out,'selection-result.json'),JSON.stringify(result,null,2));
 }
 console.log(`Native selection evidence: ${resolve(out,'selection-result.json')}`);
}finally{server.close();await provider.close()}
