/** Run the opt-in Tauri measurement build against an isolated Workspace. */
import {createServer} from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {mkdir,writeFile,copyFile,readFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const options=Object.fromEntries(process.argv.slice(2).map(arg=>{const i=arg.indexOf('=');if(i<1)throw Error('Use --name=value');return[arg.slice(2,i),arg.slice(i+1)]}));
const out=resolve(options.out??'output/office-performance/native');await mkdir(out,{recursive:true});
if(!options.binary)throw Error('Pass --binary=/absolute/path/to/measurement-build');
const config={workspaceRoot:resolve(options.workspace??resolve(out,'workspace')),format:options.format??'docx',sample:options.sample??'complex',run:Number(options.run??1),width:Number(options.width??980),setup:options.setup==='1',visible:options.visible==='1'};
config.acceptance=options.acceptance==='1';config.cycles=Number(options.cycles??0);config.page=options.page;
config.races=options.races==='1';
if(options.controls!==undefined)config.controls=options.controls==='1';
const label=config.setup?'setup':`${config.format}-${config.sample}-${config.run}`;
const inventory=()=>execFileSync('ps',['-axo','pid=,ppid=,rss=,%cpu=,comm='],{encoding:'utf8'}).trim().split('\n').map(line=>{const m=line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.+)$/);return m?{pid:+m[1],ppid:+m[2],rssKiB:+m[3],cpu:+m[4],command:m[5]}:null}).filter(Boolean);
const existing=new Set(inventory().map(p=>p.pid)),memory=[];
let child,done=false,stopTimer,reportCount=0;
const sampleMemory=(checkpoint)=>{if(!child)return;const processes=inventory();memory.push({atMs:performance.now()-start,checkpoint,processes:processes.filter(p=>p.pid===child.pid||p.ppid===child.pid||(!existing.has(p.pid)&&p.command.includes('WebKit'))).map(p=>({...p,attribution:p.pid===child.pid?'native-host':p.ppid===child.pid?'direct-child':'new-WebKit-candidate; not guaranteed attribution'}))})};
const stop=()=>{child?.kill('SIGTERM');setTimeout(()=>{if(child?.exitCode===null)child.kill('SIGKILL')},1500)};
const server=createServer(async(req,res)=>{
 res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','content-type');
 if(req.method==='OPTIONS'){res.end();return}
 let text='';for await(const part of req){text+=part;if(text.length>16*1024*1024){res.writeHead(413);res.end();return}}
 try{
  const result=JSON.parse(text);if(result.kind==='checkpoint'){sampleMemory(result);res.end('checkpoint');return}
  // A development HMR reload is a new attempt. Preserve every report instead
  // of replacing a completed result with the reloaded page's later outcome.
  const attempt=++reportCount;
  await writeFile(resolve(out,`${label}${attempt===1?'':`-attempt-${attempt}`}.json`),JSON.stringify({runner:{binary:options.binary,config,attempt,wallMs:performance.now()-start},...result},null,2)+'\n');
  res.end('saved');done=true;sampleMemory('final-report');clearTimeout(stopTimer);stopTimer=setTimeout(stop,Math.max(150,Number(options.hold??0)*1000));
 }catch(error){res.writeHead(400);res.end(String(error))}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));config.reportUrl=`http://127.0.0.1:${server.address().port}/result`;
const start=performance.now();
child=spawn(resolve(options.binary),[],{cwd:root,env:{...process.env,PROJECT_MIND_APP_DATA_DIR:resolve(options.data??resolve(out,'app-data')),PROJECT_MIND_OFFICE_PERFORMANCE:JSON.stringify(config)},stdio:['ignore','pipe','pipe']});
let logs='';child.stdout.on('data',chunk=>logs+=chunk);child.stderr.on('data',chunk=>logs+=chunk);
const memoryTimer=setInterval(()=>sampleMemory('interval'),1000);
const timer=setTimeout(()=>{logs+='\nHarness timed out without a valid result';stop()},Number(options.timeout??180000));
await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve)});clearTimeout(timer);clearTimeout(stopTimer);clearInterval(memoryTimer);server.close();
await writeFile(resolve(out,`${label}-memory.json`),JSON.stringify({note:'RSS is process resident size, not retained heap. New WebKit candidates can include unrelated processes. No OS caches cleared.',samples:memory},null,2));
await writeFile(resolve(out,`${label}.log`),logs);
await writeFile(resolve(out,'native-last.log'),logs);
if(!done)throw Error('Tauri measurement failed: '+logs.slice(-3000));
console.log(`Saved ${config.format}/${config.sample} run ${config.run} to ${out}`);
