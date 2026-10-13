"""Re-run in a copy of the archive; never install in the repository root."""
from pathlib import Path
import os, json, subprocess, shutil, sys, hashlib
ROOT=Path(__file__).resolve().parent
OUT=Path(sys.argv[1] if len(sys.argv)>1 else '/tmp/project-mind-genoffice-xlsx-rerun').resolve()
if OUT==ROOT or OUT.exists(): raise SystemExit('Choose a new, empty scratch directory')
OUT.mkdir(parents=True)
for name in ['fetch-core.py','tree.json','package.json','package-lock.json','build.mjs','integration-api.ts','fixture-save.ts','probe.ts','sheet-session.ts','view-model.mjs','compare.py','verify.py','verify-candidate.py','fixtures.json','simple.original.xlsx','complex.original.xlsx']:
    shutil.copyfile(ROOT/name,OUT/name)
if (ROOT/'browser').exists():
    shutil.copytree(ROOT/'browser',OUT/'browser',ignore=shutil.ignore_patterns('output','node_modules','*.log'))
(OUT/'temp').mkdir()
env={**os.environ,'CARGO_TARGET_DIR':str(OUT/'target'),'TMPDIR':str(OUT/'temp'),
     'GENOFFICE_XLSX_BINARY':str(OUT/'target/debug/xlsx-sidecar')}
steps=[('source',[sys.executable,'fetch-core.py']),('npm',['npm','ci','--ignore-scripts']),
       ('rust',['cargo','build','--locked','--manifest-path',str(OUT/'upstream/apps/sheets/native/xlsx-engine/Cargo.toml')]),
       ('bundle',['node','build.mjs']),('gateway',['node','probe.bundle.mjs']),
       ('verify',[os.environ.get('GENOFFICE_XLSX_PYTHON',sys.executable),'verify.py'])]
results=[]
for name,command in steps:
    with (OUT/f'{name}.log').open('w') as log:
        try:
            p=subprocess.run(command,cwd=OUT,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=1200)
            result={'step':name,'command':command,'exitCode':p.returncode}
        except subprocess.TimeoutExpired:
            result={'step':name,'command':command,'error':'timeout after 1200 seconds'}
    results.append(result)
    (OUT/'execution.json').write_text(json.dumps(results,indent=2)+'\n')
    print(json.dumps(result),flush=True)
    if result.get('exitCode')!=0:
        raise SystemExit(f'{name} failed; inspect {OUT/name}.log; no fallback authoring used')
print(f'Results: {OUT}/results.json',flush=True)
