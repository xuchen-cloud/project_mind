"""Independent check of the real browser output: text edit only, no image move.

Run the copied file from the exclusive scratch, next to reused verifiers.
"""
from pathlib import Path
from zipfile import ZipFile
import json, sys, hashlib
import verify_pptx as verifier

root=Path(__file__).resolve().parent
candidate=Path(sys.argv[1]) if len(sys.argv)>1 else root/'simple.browser-edited.pptx'
destination=Path(sys.argv[2]) if len(sys.argv)>2 else candidate.with_suffix('.verification.json')
verifier.M['picture_delta_emu']=0
result=verifier.verify('simple',candidate,'edited')
# Reuse the existing verifier's inventory/replace_text functions without executing
# its top-level loop over the earlier four engine candidates.
source=(root/'verify_semantics.py').read_text()
definitions=source.split('start=time.perf_counter(); results={}')[0]
namespace={'__file__':str(root/'verify_semantics.py')}
exec(compile(definitions,str(root/'verify_semantics.py'),'exec'),namespace)
original=root/'simple.original.pptx'
a=namespace['inventory'](original); b=namespace['inventory'](candidate)
expected=namespace['replace_text'](a)
checks=result['checks']
for key in a:
    checks.append({'name':f'browser_semantics_{key}','passed':expected[key]==b[key],'expected':expected[key],'actual':b[key]})
with ZipFile(original) as za, ZipFile(candidate) as zb:
    an={n for n in za.namelist() if not n.endswith('/')}; bn={n for n in zb.namelist() if not n.endswith('/')}
    changed=[n for n in sorted(an&bn) if za.read(n)!=zb.read(n)]
    checks.extend([
        {'name':'actual_file_part_set','passed':an==bn,'expected':sorted(an),'actual':sorted(bn)},
        {'name':'only_target_slide_xml_changed','passed':changed==['ppt/slides/slide1.xml'],'expected':['ppt/slides/slide1.xml'],'actual':changed},
    ])
    result['added_directory_entries']=sorted(set(zb.namelist())-set(za.namelist())-bn)
source_original=Path(verifier.M['samples']['simple']['source_original_path'])
source_hash=hashlib.sha256(source_original.read_bytes()).hexdigest()
checks.append({'name':'external_original_checksum_unchanged','passed':source_hash==verifier.M['samples']['simple']['sha256'],'expected':verifier.M['samples']['simple']['sha256'],'actual':source_hash})
result.update(mode='browser-text-only',status='passed' if all(c['passed'] for c in checks) else 'failed',semantic_verifier_reuse='inventory/replace_text definitions only',image_delta_emu=0)
destination.write_text(json.dumps(result,ensure_ascii=False,indent=2))
print(json.dumps({'candidate':str(candidate),'sha256':result['candidate_inventory']['sha256'],'status':result['status'],'checks':len(checks),'failed':[c['name'] for c in checks if not c['passed']],'result':str(destination)},ensure_ascii=False))
sys.exit(0 if result['status']=='passed' else 1)
