from pathlib import Path
import json,hashlib
ROOT=Path(__file__).resolve().parent
x=json.loads((ROOT/'engine-results.json').read_text());v=json.loads((ROOT/'results.json').read_text());b=json.loads((ROOT/'browser-results.json').read_text())
status=lambda rows:'passed' if rows and all(q['status']=='passed' for q in rows) else 'failed'
out={'protocol_id':x['protocol_id'],'upstream_commit':x['upstream_commit'],'engine_branches':len(x['runs']),'engine_independent_checks_per_branch':sorted(set(len(q.get('checks',[])) for q in v['results'])),'engine_status':status(v['results']),'browser_branches':len(b['results']),'browser_independent_checks_per_branch':sorted(set(len(q.get('checks',[])) for q in b['results'])),'browser_status':status(b['results']),'browser_owner':'main agent','all_noop_byte_identical':all(q.get('byte_identical') for q in x['runs'] if q['mode']=='noop'),'browser_bundle_sha256':hashlib.sha256((ROOT/'build/prototype.browser.js').read_bytes()).hexdigest(),'fixture_manifest_sha256':x['fixture_manifest_sha256'],'losses_observed':['edited: modified timestamp and revision update','edited: ZIP directory entries added','edited paragraph: redundant xml:space=preserve added'],'not_verified':['full PaginationPreview runtime','native Word external reopen','rich features own editing','business host integration']}
external=json.loads((ROOT/'external-reference.json').read_text())
out['LO_external_reopen']=external
(ROOT/'summary.json').write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(out,ensure_ascii=False,indent=2))
