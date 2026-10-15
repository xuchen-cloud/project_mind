"""Fetch only pinned public core files; verify every Git blob before using it."""
from pathlib import Path
import json, subprocess, hashlib, concurrent.futures

root=Path(__file__).resolve().parent
lock=json.loads((root/'source-lock.json').read_text())
sha='d32d1711f1bf985430757b8c6b3fbddd3831d946'
assert lock['commit']==sha and lock['tree_sha']==sha
prefixes=tuple('packages/'+x+'/' for x in ['pptx-engine','pptx-render','zip-gate','agent-core'])
def fetch(x):
    path=x['path']
    assert path.startswith(prefixes) or path in ['LICENSE','NOTICE','LICENSE-UNICODE.txt','tsconfig.base.json']
    p=root/'upstream'/path;p.parent.mkdir(parents=True,exist_ok=True)
    def valid():
        if not p.exists():return False
        b=p.read_bytes()
        return len(b)==x['bytes'] and hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()==x['git_blob_sha1']
    if not valid():
        subprocess.run(['curl','-fLsS','--retry','2','--max-time','120',f'https://raw.githubusercontent.com/genspark-ai/genoffice/{sha}/{path}','-o',str(p)],check=True)
    assert valid(),f'Git blob integrity mismatch: {path}'
    return path
with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
    files=list(pool.map(fetch,lock['files']))
print(json.dumps({'commit':sha,'verifiedFiles':len(files),'destination':str(root/'upstream'),'eeFiles':0}))
