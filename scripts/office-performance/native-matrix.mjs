/** Serial native measurements. Never run alongside a build or another measurement. */
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import os from 'node:os';
const options=Object.fromEntries(process.argv.slice(2).map(arg=>{const i=arg.indexOf('=');return[arg.slice(2,i),arg.slice(i+1)]}));
if(!['release','development','embedded-debug'].includes(options.mode))throw Error('Explicit --mode=release|development|embedded-debug is required');
if(!options.binary||!options.out||!options.workspace)throw Error('--binary, --out and --workspace are required');
const out=resolve(options.out);await mkdir(out,{recursive:true});
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const metadata={mode:options.mode,startedAt:new Date().toISOString(),node:process.version,machine:{model:os.cpus()[0]?.model,memoryBytes:os.totalmem(),os:os.release()},binary:resolve(options.binary),binarySha256:digest(await readFile(options.binary)),qualification:'serial native ProjectFileContent, visible incognito WebView; OS caches retained; excludes full application startup',samples:[]};
for(const format of (options.formats??'docx,xlsx,pptx,md').split(','))for(const sample of (options.samples??'simple,complex,large').split(',')){
 const n=Number(options.repetitions??(sample==='complex'?5:3));
 for(let run=1;run<=n;run++){
  const command=['scripts/office-performance/native-run.mjs',...Object.entries({binary:options.binary,out,workspace:options.workspace,format,sample,run,visible:'1',width:options.width??'980'}).map(([key,value])=>`--${key}=${value}`)];
  await new Promise((resolve,reject)=>{const child=spawn(process.execPath,command,{stdio:'inherit'});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(`Native runner exited ${code}`)))});
  const file=`${format}-${sample}-${run}.json`,bytes=await readFile(resolve(out,file)),report=JSON.parse(bytes);
  metadata.samples.push({file,sha256:digest(bytes),status:report.status,measurements:report.measurements.map(({name,duration,status,error})=>({name,duration,status,error}))});
  await writeFile(resolve(out,'matrix.json'),JSON.stringify(metadata,null,2)+'\n');
  console.log(JSON.stringify({format,sample,run,status:report.status,timings:report.measurements.map(m=>[m.name,Math.round(m.duration??0)])}));
  if(report.status==='error')throw Error(`Invalid readiness measurement: ${file}`);
 }
}
metadata.finishedAt=new Date().toISOString();await writeFile(resolve(out,'matrix.json'),JSON.stringify(metadata,null,2)+'\n');
