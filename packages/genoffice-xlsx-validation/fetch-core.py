from pathlib import Path
import json, subprocess, hashlib, concurrent.futures
root=Path(__file__).resolve().parent
tree=json.loads((root/'tree.json').read_text())
sha='d32d1711f1bf985430757b8c6b3fbddd3831d946'
assert tree['sha']==sha and not tree.get('truncated')
prefixes=tuple('packages/'+x+'/' for x in ['xlsx-gateway','zip-gate'])
extra=['LICENSE','NOTICE','package.json','package-lock.json','tsconfig.base.json','apps/sheets/package.json','apps/sheets/README.md','apps/sheets/docs/architecture.md','apps/sheets/docs/compatibility.md','apps/sheets/docs/interface.md','apps/sheets/src/main/xlsx-sidecar-client.ts','apps/sheets/src/renderer/create-univer.ts','apps/sheets/src/renderer/save-actions.ts','apps/sheets/src/renderer/edit-journal.ts','apps/sheets/src/shared/desktop-api.ts','apps/sheets/src/renderer/App.tsx','apps/sheets/src/main/sheets-main.ts','apps/sheets/src/renderer/univer-state.ts','apps/sheets/src/renderer/univer-sync.ts','apps/sheets/src/renderer/formula-values.ts','apps/sheets/src/renderer/control.ts','apps/sheets/src/renderer/formula-cached-fallback.ts','apps/sheets/src/renderer/formula-closure.ts']
rows=[x for x in tree['tree'] if x['type']=='blob' and (x['path'].startswith(prefixes) or x['path'] in extra or x['path'].startswith('apps/sheets/native/xlsx-engine/')) ]
def fetch(x):
    p=root/'upstream'/x['path']; p.parent.mkdir(parents=True,exist_ok=True)
    def valid():
        if not p.exists(): return False
        b=p.read_bytes(); return hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()==x['sha']
    if not valid(): subprocess.run(['curl','-fLsS','--retry','2','--max-time','120',f'https://raw.githubusercontent.com/genspark-ai/genoffice/{sha}/{x["path"]}','-o',str(p)],check=True)
    assert valid(),x['path']
    return {'path':x['path'],'git_blob_sha1':x['sha'],'bytes':x['size']}
out=[]
with concurrent.futures.ThreadPoolExecutor(max_workers=12) as ex:
    for row in ex.map(fetch,rows):
        out.append(row)
        if len(out)%50==0: print(f'verified {len(out)}/{len(rows)}',flush=True)
(root/'source-provenance.json').write_text(json.dumps({'commit':sha,'tree_sha':tree['sha'],'files':out},indent=2))
print(f'verified {len(out)} files',flush=True)
