"""Fetch official fixed-SHA source and prepare an isolated byte-API harness."""
import hashlib,json,os,shutil,subprocess,urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parent
SCRATCH=Path(os.environ.get('GENOFFICE_PDF_SCRATCH','/tmp/project-mind-genoffice-pdf-validation-20261013'))
SHA='d32d1711f1bf985430757b8c6b3fbddd3831d946'
FILES=[f'apps/pdf/src/main/{n}.ts' for n in ['text-edit','font-cmap','font-locate','font-subset','wasm-path']]+[f'apps/pdf/src/shared/{n}.ts' for n in ['ipc','radicals','x-layers']]+[f'packages/font-metrics/src/{n}.ts' for n in ['index','advance','font-locate','metrics','sfnt']]+['apps/pdf/package.json','packages/font-metrics/package.json']
SCRATCH.mkdir(parents=True,exist_ok=True)
lock={'repository':'https://github.com/genspark-ai/genoffice','commit':SHA,'files':[]}
package={'name':'isolated-genoffice-pdf-validation','private':True,'type':'module','dependencies':{'@embedpdf/pdfium':'2.15.1','harfbuzzjs':'0.10.3','pdf-lib':'1.17.1','esbuild':'0.25.12'}}
(SCRATCH/'package.json').write_text(json.dumps(package,indent=2))
dependency_lock=ROOT/'dependency.lock.json'
if dependency_lock.is_file():
 shutil.copyfile(dependency_lock,SCRATCH/'package-lock.json')
for name in FILES:
 url=f'https://raw.githubusercontent.com/genspark-ai/genoffice/{SHA}/{name}'
 transport='raw-github';error=None
 try:
  with urllib.request.urlopen(url,timeout=25) as response:data=response.read()
 except Exception as e:
  error=f'{type(e).__name__}: {e}'
  node=os.environ.get('GENOFFICE_PDF_NODE','/Users/xuchen/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node')
  try:
   completed=subprocess.run([node,'--input-type=module','-e','const r=await fetch(process.argv[1]);if(!r.ok)throw new Error(String(r.status));process.stdout.write(Buffer.from(await r.arrayBuffer()));',url],check=True,capture_output=True,timeout=60)
   data=completed.stdout;transport='raw-github-node-fetch'
  except Exception as second:
   error+=f'; Node fetch: {type(second).__name__}: {second}'
   checkout=os.environ.get('GENOFFICE_PDF_READONLY_GIT','/tmp/project-mind-genoffice-pptx-validation-20261013/upstream-git')
   completed=subprocess.run(['git','show',f'{SHA}:{name}'],cwd=checkout,check=True,capture_output=True,timeout=60)
   data=completed.stdout;transport='fixed-git-object-from-readonly-checkout'
 p=SCRATCH/'upstream'/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(data)
 lock['files'].append({'path':name,'url':url,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'transport':transport,'raw_fetch_error':error})
 print('fetched',name,len(data),flush=True)
(ROOT/'source-fetch.lock.json').write_text(json.dumps(lock,indent=2))
