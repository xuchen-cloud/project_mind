"""Independent Poppler text/pages/images and tiny original-vs-edited PNGs; no GUI."""
import hashlib,json,subprocess,time
from pathlib import Path
from PIL import Image,ImageChops,ImageDraw
import fixture
ROOT=Path(__file__).resolve().parent
BIN=Path('/Users/xuchen/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/poppler/poppler/bin')
MANIFEST=json.loads((ROOT/'fixtures.json').read_text());RESULTS={'poppler_version':None,'runs':[],'comparisons':[],'visual_inspection':'PNG generated for main agent to view; no GUI validation claimed.'}
def run(cmd):
 t=time.perf_counter();r=subprocess.run([str(x) for x in cmd],capture_output=True,text=True,timeout=60)
 return {'command':[str(x) for x in cmd],'exit':r.returncode,'elapsed_ms':(time.perf_counter()-t)*1000,'stdout':r.stdout,'stderr':r.stderr}
RESULTS['poppler_version']=run([BIN/'pdftotext','-v'])
for name in ['simple','complex']:
 for kind in ['original','core-edited']:
  p=ROOT/f'{name}.{kind}.pdf';out=ROOT/'evidence'/'visual'/f'{name}.{kind}';out.mkdir(parents=True,exist_ok=True)
  row={'name':name,'kind':kind,'file':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'outdir':str(out)}
  row['pdfinfo']=run([BIN/'pdfinfo',p]);row['text']=run([BIN/'pdftotext','-layout','-enc','UTF-8',p,out/'text.txt']);row['images']=run([BIN/'pdfimages','-list',p]);row['render']=run([BIN/'pdftoppm','-r','72','-png',p,out/'page'])
  row['text_content']=(out/'text.txt').read_text() if (out/'text.txt').exists() else None
  row['pngs']=[str(p) for p in sorted(out.glob('page-*.png'))];row['status']='passed' if all(row[key]['exit']==0 for key in ['pdfinfo','text','images','render']) and len(row['pngs'])==2 else 'failed'
  RESULTS['runs'].append(row)
 original=next(r for r in RESULTS['runs'] if r['name']==name and r['kind']=='original');edited=RESULTS['runs'][-1]
 checks=fixture.compare(name,edited['file']);(ROOT/f'{name}.core-edited.checks.json').write_text(json.dumps(checks,ensure_ascii=False,indent=2))
 old,new=MANIFEST[name]['target']['oldText'],MANIFEST[name]['target']['newText'];before=fixture.norm(original['text_content'] or '');after=fixture.norm(edited['text_content'] or '')
 check={'name':name,'poppler_old_target_absent':fixture.norm(old) not in after,'poppler_new_target_present':fixture.norm(new) in after,'poppler_unedited_text_unchanged':before.replace(fixture.norm(old),'',1)==after.replace(fixture.norm(new),'',1),'pypdf_status':checks['status'],'pixel_checks':[]}
 for page in [1,2]:
  a=Image.open(original['pngs'][page-1]).convert('RGB');b=Image.open(edited['pngs'][page-1]).convert('RGB');diff=ImageChops.difference(a,b);box=diff.getbbox();outside=diff.copy()
  rect=None
  if page==1:
   x1,y1,x2,y2=MANIFEST[name]['target']['rect'];h=a.height;rect=(int(x1)-4,int(h-y2)-4,int(x2)+4,int(h-y1)+4);ImageDraw.Draw(outside).rectangle(rect,fill=(0,0,0))
  check['pixel_checks'].append({'page':page,'difference_bounds':box,'excluded_target_rect':rect,'outside_target_difference_bounds':outside.getbbox(),'outside_target_pixels_equal':outside.getbbox() is None})
  if page==1:
   sheet=Image.new('RGB',(a.width*2,220),'white');sheet.paste(a.crop((0,35,a.width,255)),(0,0));sheet.paste(b.crop((0,35,b.width,255)),(a.width,0));comparison=ROOT/'evidence'/'visual'/f'{name}.page1-comparison.png';sheet.save(comparison);check['comparison_png']=str(comparison)
 check['status']='passed' if all([check['poppler_old_target_absent'],check['poppler_new_target_present'],check['poppler_unedited_text_unchanged'],check['pypdf_status']=='passed',all(p['outside_target_pixels_equal'] for p in check['pixel_checks'])]) else 'limited'
 RESULTS['comparisons'].append(check)
RESULTS['status']='passed' if all(r['status']=='passed' for r in RESULTS['runs']) and all(c['status']=='passed' for c in RESULTS['comparisons']) else 'limited'
(ROOT/'external-results.json').write_text(json.dumps(RESULTS,ensure_ascii=False,indent=2));print(json.dumps({'status':RESULTS['status'],'comparisons':RESULTS['comparisons']},ensure_ascii=False))
