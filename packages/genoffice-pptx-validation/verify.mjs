import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=dirname(fileURLToPath(import.meta.url));
const python=process.env.PYTHON??'python3';
function run(args,acceptRawFailure=false){
 const r=spawnSync(python,args,{cwd:root,stdio:'inherit'});
 if(r.error)throw r.error;
 if(r.status!==0&&!acceptRawFailure)throw new Error(`${args.join(' ')} failed (${r.status})`);
}
for(const kind of ['simple','complex'])for(const mode of ['noop','edited'])run(['verify_pptx.py',kind,`${kind}.${mode}.pptx`,mode],kind==='complex');
run(['verify_semantics.py']);
for(const browser of ['webkit','chromium'])run(['verify_browser.py',`browser/output/${browser}/simple.browser-edited.pptx`,`browser/output/${browser}/independent-verification.json`]);
run(['summarize.py']);
const f=JSON.parse(readFileSync(`${root}/findings.json`));
// Complex raw directory-inclusive count failures remain in the report; only
// their explicit relationship/hash classification may pass this scoped gate.
if(f.decision!=='eligible_simple_pptx_backup')process.exitCode=1;
