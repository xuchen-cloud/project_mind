// A process-backed systemd command fixture. It only acts on PIDs written by its
// own fake scope launcher; no system manager or real user unit is contacted.
import { appendFileSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
const args=process.argv.slice(2);
const directory=process.env.G1_SYSTEMD_FIXTURE;
const calls=path.join(directory,'calls.jsonl');
const unitArg=args.find(arg=>arg.startsWith('--unit='));
const command=unitArg ? 'systemd-run' : 'systemctl';
appendFileSync(calls,JSON.stringify({command,args})+'\n');
const record=unit=>path.join(directory,unit+'.json');
if(command==='systemd-run') {
  const unit=unitArg.slice('--unit='.length)+'.scope';
  const requestPath=process.env.DSH_SUBPROCESS_RUNNER;
  const request=JSON.parse(readFileSync(requestPath,'utf8'));unlinkSync(requestPath);
  const target=args.slice(args.lastIndexOf('--')+1);
  // Model a scope member that has escaped its launcher's POSIX session.
  const child=spawn(target[0],target.slice(1),{cwd:request.cwd,env:request.env,stdio:'inherit',detached:true});
  writeFileSync(record(unit),JSON.stringify({launcher:process.pid,member:child.pid,active:true}));
  child.on('exit',(code,signal)=>process.exit(code ?? (signal ? 137 : 1)));
  process.on('SIGTERM',()=>{});
} else if(args.includes('--property=Version')) {
  process.exitCode=process.env.G1_SYSTEMD_UNAVAILABLE==='1' ? 1 : 0;
  if(!process.exitCode)console.log('fixture-systemd');
} else {
  const unit=args.find(arg=>arg.endsWith('.scope'));
  const file=record(unit);
  const state=existsSync(file) ? JSON.parse(readFileSync(file,'utf8')) : {active:false};
  if(args.includes('kill')) {
    const signal=args.find(arg=>arg.startsWith('--signal=')).slice('--signal='.length);
    if(!args.includes('--kill-whom=all'))throw new Error('scope kill must cover every member');
    if(state.active){for(const pid of [state.member,state.launcher]){try{process.kill(pid,signal);}catch(error){if(error.code!=='ESRCH')throw error;}}}
    if(signal==='SIGKILL'){state.active=false;writeFileSync(file,JSON.stringify(state));}
  } else if(args.includes('show')) {
    console.log(`LoadState=loaded\nActiveState=${state.active?'active':'inactive'}\nTasksCurrent=${state.active?'2':'0'}`);
  } else if(args.includes('stop')) { state.active=false;writeFileSync(file,JSON.stringify(state)); }
  else throw new Error('unexpected systemd fixture invocation '+args.join(' '));
}
