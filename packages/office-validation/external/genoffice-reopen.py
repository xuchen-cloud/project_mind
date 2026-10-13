"""Bounded GenOffice DOCX/XLSX candidate reopen; no SDK conversion or business commit."""
import argparse, hashlib, json, os, re, shutil, subprocess, sys
from pathlib import Path
import pypdf
p=argparse.ArgumentParser();p.add_argument('--format',choices=['docx','xlsx'],required=True);p.add_argument('--source',type=Path,required=True);p.add_argument('--baseline',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
source=a.source.resolve();out=a.output.resolve();out.mkdir(parents=True,exist_ok=True)
soffice=os.environ.get('OFFICE_VALIDATION_SOFFICE') or shutil.which('soffice');texttool=os.environ.get('OFFICE_VALIDATION_PDFTOTEXT') or shutil.which('pdftotext')
if not soffice or not texttool:raise SystemExit('Set OFFICE_VALIDATION_SOFFICE and OFFICE_VALIDATION_PDFTOTEXT')
sha=lambda b:hashlib.sha256(b).hexdigest();norm=lambda s:re.sub(r'\s+','',s)
baseline=json.loads(a.baseline.read_text());rows=[]
prior=json.loads((out/'results.json').read_text()).get('cases',[]) if (out/'results.json').exists() else []
for kind in ['simple','complex']:
 if a.format=='docx':
  jobs=[('original',source/'fixtures'/f'{kind}.original.docx'),('public-pm-noop',source/f'{kind}.public-pm.noop.docx'),('public-pm-edited',source/f'{kind}.public-pm.edited.docx')]
  jobs += [(engine,source/'browser/output'/engine/f'{kind}.browser-edited.docx') for engine in ['chromium','webkit']]
 else:
  jobs=[(branch,source/f'{kind}.{branch}.xlsx') for branch in ['original','noop','edited-default','edited-ironcalc','edited-ironcalc-cache-sheet-touch']]
  jobs += [(engine,source/'browser/output'/engine/f'{kind}.browser-edited.xlsx') for engine in ['chromium','webkit']]
 for branch,file in jobs:
  data=file.read_bytes();digest=sha(data);case=out/f'{kind}-{branch}';case.mkdir(exist_ok=True);pdf=case/(file.stem+'.pdf');row={'kind':kind,'branch':branch,'source':str(file),'source_sha256':digest,'source_bytes':len(data),'status':'failed'}
  cached=next((c for c in prior if c.get('source')==str(file) and c.get('source_sha256')==digest and c.get('status')=='reopened' and Path(c.get('pdf','')).exists() and sha(Path(c['pdf']).read_bytes())==c.get('pdf_sha256')),None)
  if cached:
   rows.append(cached);continue
  old=next((c for c in baseline['cases'] if c.get('format')==a.format and c.get('branch')=='original' and c.get('source_sha256_before')==digest and c.get('status')=='reopened'),None)
  if old and Path(old['pdf']).exists() and sha(Path(old['pdf']).read_bytes())==old['pdf_sha256']:
   shutil.copyfile(old['pdf'],pdf);row['conversion']={'method':'reuse-exact-source-and-pdf-hash','returncode':0,'source_evidence':str(a.baseline),'original_id':old.get('id'),'pdf_sha256':old['pdf_sha256']}
  else:
   inputs=case/'input';inputs.mkdir(exist_ok=True);local=inputs/file.name;local.write_bytes(data);profile=case/'profile'
   cmd=[soffice,'-env:UserInstallation='+profile.as_uri(),'--headless','--nologo','--nodefault','--nofirststartwizard','--norestore','--convert-to','pdf','--outdir',str(case),str(local)]
   try:
    r=subprocess.run(cmd,capture_output=True,text=True,timeout=60);row['conversion']={'method':'actual-headless-conversion','command':cmd,'returncode':r.returncode,'stdout':r.stdout,'stderr':r.stderr}
   except subprocess.TimeoutExpired:row['conversion']={'method':'actual-headless-conversion','error':'timeout after 60 seconds'}
  row['source_unchanged']=sha(file.read_bytes())==digest
  if pdf.exists():
   reader=pypdf.PdfReader(pdf);textfile=case/'text.txt';r=subprocess.run([texttool,'-enc','UTF-8',str(pdf),str(textfile)],capture_output=True,text=True,timeout=30)
   row.update(pdf=str(pdf),pdf_sha256=sha(pdf.read_bytes()),pages=len(reader.pages),page_sizes=[[float(x.mediabox.width),float(x.mediabox.height)] for x in reader.pages],text=textfile.read_text() if textfile.exists() else '',text_exit=r.returncode)
   if row['source_unchanged'] and row['conversion'].get('returncode')==0 and len(reader.pages)>0 and r.returncode==0:row['status']='reopened'
  rows.append(row);print(json.dumps({k:row.get(k) for k in ['kind','branch','status','pages']},ensure_ascii=False),flush=True)
  (out/'results.json').write_text(json.dumps({'format':a.format,'cases':rows},ensure_ascii=False,indent=2))
comparisons=[]
for row in rows:
 if row['branch']=='original':continue
 original=next(x for x in rows if x['kind']==row['kind'] and x['branch']=='original');expected=original.get('text','')
 if a.format=='docx' and row['branch']!='public-pm-noop':expected=expected.replace('待修改中文段落：春风拂面。','已修改中文段落：秋风拂面。').replace('待改单元','已改单元')
 comparisons.append({'kind':row['kind'],'branch':row['branch'],'same_page_count':row.get('pages')==original.get('pages'),'same_page_sizes':row.get('page_sizes')==original.get('page_sizes'),'expected_text_equal_ignoring_whitespace':norm(expected)==norm(row.get('text','')) if a.format=='docx' or row['branch']=='noop' else None})
report={'issue':'#118/F03','format':a.format,'runtime':{'python':sys.version.split()[0],'pypdf':pypdf.__version__,'soffice':soffice,'pdftotext':texttool},'cases':rows,'comparisons':comparisons,'limits':['External PDF reopen is not pixel fidelity or Microsoft Office acceptance.','Prior exact-hash original evidence has Chinese rendering limitations; extractable text does not prove appearance.','XLSX external calculation may repair stale caches; inspect XLSX caches independently.','No Tauri, Windows, File CAS or DSH business submission verified.']}
(out/'results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
if any(x['status']!='reopened' for x in rows):raise SystemExit(1)
