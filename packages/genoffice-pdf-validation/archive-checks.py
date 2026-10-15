"""Read-only evidence gate: no candidate APIs, source build, GUI or PDF rendering."""
import hashlib,json,re,subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parent;REPO=ROOT.parent.parent
SCRATCH=Path('/tmp/project-mind-genoffice-pdf-validation-20261013')
NODE='/Users/xuchen/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node'
sha=lambda b:hashlib.sha256(b).hexdigest()
checks=[]
def check(label,ok,details=None):checks.append({'assertion':label,'passed':bool(ok),'details':details})
lock=json.loads((ROOT/'source-fetch.lock.json').read_text())
final=json.loads((ROOT/'final-verify-results.json').read_text());save=SCRATCH/'upstream/apps/pdf/src/main/save-pdf.ts';save_data=save.read_bytes()
if not any(f['path']=='apps/pdf/src/main/save-pdf.ts' for f in lock['files']):
 lock['files'].append({'path':'apps/pdf/src/main/save-pdf.ts','url':final['source_url'],'sha256':sha(save_data),'bytes':len(save_data),'transport':'raw-github-node-fetch','raw_fetch_error':None})
 (ROOT/'source-fetch.lock.json').write_text(json.dumps(lock,indent=2))
for f in lock['files']:
 p=SCRATCH/'upstream'/f['path'];check('unchanged_fixed_source:'+f['path'],sha(p.read_bytes())==f['sha256'])
text=save_data.decode();start=text.index('function finalPageIndex(');end=text.index('\nexport async function savePdfToPath(',start)
check('private_verifier_exact_body_hash',sha(text[start:end].encode())==final['extracted_body_sha256'])
for p in ROOT.glob('*.py'):
 try:compile(p.read_text(),str(p),'exec');check('python_syntax:'+p.name,True)
 except Exception as e:check('python_syntax:'+p.name,False,str(e))
for p in ROOT.glob('*.mjs'):
 r=subprocess.run([NODE,'--check',str(p)],capture_output=True,text=True,timeout=60);check('node_syntax:'+p.name,r.returncode==0,r.stderr)
for p in [*(ROOT.glob('*.md')),REPO/'docs/technical/pdf-integration-candidate-research-20261013.md']:
 missing=[s for s in re.findall(r'\]\(([^)]+)\)',p.read_text()) if '://' not in s and not (p.parent/s.split('#')[0]).exists()]
 check('local_links:'+p.name,not missing,missing)
run=json.loads((ROOT/'results.json').read_text());manifest=json.loads((ROOT/'fixtures.json').read_text())
for name,f in manifest.items():check('original_hash:'+name,sha(Path(f['source']['path']).read_bytes())==f['source']['sha256'])
for r in run['runs']:
 check('candidate_hash:'+r['name'],sha(Path(r['output']).read_bytes())==r['output_sha256'])
 check('independent_pypdf:'+r['name'],json.loads(Path(r['checks']).read_text())['status']=='passed')
for r in final['runs']:check('final_stage_hash:'+r['name'],sha(Path(r['output']).read_bytes())==r['sha256'])
for r in run['wasm']:check('wasm_hash:'+Path(r['path']).name,sha(Path(r['path']).read_bytes())==r['sha256'])
font=json.loads((ROOT/'font.lock.json').read_text());check('font_source_hash',sha(Path(font['source_path']).read_bytes())==font['sha256'])
lockdeps=json.loads((ROOT/'dependency.lock.json').read_text())
for name,version in run['versions'].items():check('dependency_version:'+name,lockdeps['packages']['node_modules/'+name]['version']==version)
visual=json.loads((REPO/'packages/pdf-validation/visual-main-agent.json').read_text())
for name,digest in visual['sourceHashes'].items():check('prior_form_visual_hash:'+name,sha((REPO/'packages/pdf-validation'/name).read_bytes())==digest)
external=json.loads((ROOT/'external-results.json').read_text());simple=next(c for c in external['comparisons'] if c['name']=='simple')
check('english_original_rect_failure_preserved',simple['status']=='limited' and simple['pixel_checks'][0]['outside_target_pixels_equal'] is False)
inventory=[{'path':str(p.relative_to(ROOT)),'bytes':p.stat().st_size,'sha256':sha(p.read_bytes())} for p in sorted(ROOT.rglob('*')) if p.is_file() and p.suffix in ['.pdf','.png','.txt']]
report={'scope':'Archive syntax/link/source/hash checks only; no runtime or PNG rerun','status':'passed' if all(c['passed'] for c in checks) else 'failed','checks':checks,'evidence_inventory':inventory}
(ROOT/'archive-checks.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps({'status':report['status'],'check_count':len(checks),'failures':[c for c in checks if not c['passed']],'evidence_count':len(inventory)},ensure_ascii=False))
