"""Create a fresh archive from this exclusive scratch directory; never edits source fixtures."""
from pathlib import Path
import sys,json,shutil,hashlib
ROOT=Path(__file__).resolve().parent
DEST=Path(sys.argv[1]).resolve()
assert not DEST.exists(),'Refuse to overwrite an existing archive'
files={'.gitignore','LICENSE','NOTICE'}
files.update(p.name for p in ROOT.iterdir() if p.is_file() and p.suffix in ['.md','.json','.py','.ts','.mjs','.txt','.docx'])
for name in ['fixtures','evidence','browser']:
 files.update(str(p.relative_to(ROOT)) for p in (ROOT/name).rglob('*') if p.is_file() and '__pycache__' not in p.parts and p.suffix!='.pyc')
DEST.mkdir(parents=True)
rows=[]
for rel in sorted(files):
 if rel=='archive-manifest.json':continue
 p=ROOT/rel;q=DEST/rel;q.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(p,q)
 rows.append({'path':rel,'bytes':q.stat().st_size,'sha256':hashlib.sha256(q.read_bytes()).hexdigest()})
(DEST/'archive-manifest.json').write_text(json.dumps({'upstream_commit':'d32d1711f1bf985430757b8c6b3fbddd3831d946','protocol_id':'genoffice-docx-controlled-roundtrip-v1','scratch_path':str(ROOT),'files':rows},indent=2))
print('archived',len(rows),'files to',DEST)
