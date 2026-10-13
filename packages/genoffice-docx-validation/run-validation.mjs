import {spawnSync} from 'node:child_process';
process.chdir(import.meta.dirname);
for(const [bin,args] of [[process.execPath,['build.mjs']],[process.execPath,['build/validate.mjs']],[process.env.DOCX_VALIDATION_PYTHON||'python3',['verify.py']],[process.env.DOCX_VALIDATION_PYTHON||'python3',['summarize.py']]]) {
 const r=spawnSync(bin,args,{stdio:'inherit'});if(r.error)throw r.error;if(r.status!==0)process.exit(r.status??1);
}
