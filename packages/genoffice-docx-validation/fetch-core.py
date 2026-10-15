"""Recover locked public sources; verify byte size and Git blob without changing locks."""
from pathlib import Path, PurePosixPath
import argparse, concurrent.futures, hashlib, json, subprocess
ROOT=Path(__file__).resolve().parent
SHA='d32d1711f1bf985430757b8c6b3fbddd3831d946'
parser=argparse.ArgumentParser()
parser.add_argument('--group',choices=['all','core','extra'],default='all')
parser.add_argument('--verify-only',action='store_true',help='Check existing sources without network access')
args=parser.parse_args()
locks=['source-provenance.json','extra-source-provenance.json'] if args.group=='all' else ['source-provenance.json' if args.group=='core' else 'extra-source-provenance.json']
rows=[]
for name in locks:
 lock=json.loads((ROOT/name).read_text())
 assert lock['commit']==SHA
 if 'tree_sha' in lock:assert lock['tree_sha']==SHA
 rows.extend(lock['files'])
assert len({r['path'] for r in rows})==len(rows)
def fetch(row):
 path=PurePosixPath(row['path'])
 assert not path.is_absolute() and '..' not in path.parts and 'ee' not in path.parts
 dest=ROOT/'upstream'/str(path)
 def valid():
  if not dest.is_file():return False
  data=dest.read_bytes()
  return len(data)==row['bytes'] and hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()==row['git_blob_sha1']
 if not valid():
  if args.verify_only:raise RuntimeError('Missing or mismatched locked source: '+str(path))
  dest.parent.mkdir(parents=True,exist_ok=True)
  subprocess.run(['curl','-fLsS','--retry','2','--max-time','60',f'https://raw.githubusercontent.com/genspark-ai/genoffice/{SHA}/{path}','-o',str(dest)],check=True)
 assert valid(),'Git blob mismatch: '+str(path)
 return str(path)
with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:verified=list(pool.map(fetch,rows))
print(json.dumps({'commit':SHA,'verifiedFiles':len(verified),'group':args.group,'verify_only':args.verify_only,'destination':str(ROOT/'upstream')}))
