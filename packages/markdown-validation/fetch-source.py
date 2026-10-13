from pathlib import Path
import json,hashlib,subprocess,concurrent.futures
root=Path(__file__).resolve().parent
lock=json.loads((root/'source-lock.json').read_text())
assert lock['commit']=='d32d1711f1bf985430757b8c6b3fbddd3831d946'
def fetch(row):
 p=root/'upstream'/row['path'];p.parent.mkdir(parents=True,exist_ok=True)
 def valid():
  if not p.exists():return False
  b=p.read_bytes();return hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()==row['sha']
 if not valid():subprocess.run(['curl','-fLsS','--retry','2','--max-time','120',f'https://raw.githubusercontent.com/genspark-ai/genoffice/{lock["commit"]}/{row["path"]}','-o',str(p)],check=True)
 assert valid(),row['path']
 return row['path']
with concurrent.futures.ThreadPoolExecutor(max_workers=12) as ex:out=list(ex.map(fetch,lock['files']))
print(json.dumps({'commit':lock['commit'],'verifiedFiles':len(out)}))
