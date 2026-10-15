"""Controlled embedded-font originals and independent pypdf content assertions."""
import collections,hashlib,json,struct,sys
from pathlib import Path
from PIL import Image
from pypdf import PdfReader
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
ROOT=Path(__file__).resolve().parent
FONT=Path('/System/Library/Fonts/Supplemental/Arial Unicode.ttf')
TARGETS={'simple':('SIMPLE ORIGINAL TEXT','SIMPLE REPLACED TEXT'),'complex':('中文目标：山川日月保持原样。','中文目标：星辰日月保持原样。')}
def sha(b):return hashlib.sha256(b).hexdigest()
def norm(t):return ''.join(t.split())
def inspect(p):
 p=Path(p);r=PdfReader(p);pages=[]
 for page in r.pages:
  links=[];widgets=[];fonts=[]
  for ref in page.get('/Annots',[]):
   a=ref.get_object();entry={'subtype':str(a.get('/Subtype')),'rect':[float(x) for x in a.get('/Rect',[])]}
   if a.get('/Subtype')=='/Widget':
    entry.update(name=str(a.get('/T')),value=str(a.get('/V')),state=str(a.get('/AS')));widgets.append(entry)
   else:
    if a.get('/A'):entry['uri']=str(a['/A'].get('/URI'))
    if a.get('/Contents'):entry['contents']=str(a['/Contents'])
    links.append(entry)
  for ref in page['/Resources'].get('/Font',{}).values():
   f=ref.get_object();descriptor=f.get('/FontDescriptor')
   if not descriptor and f.get('/DescendantFonts'):descriptor=f['/DescendantFonts'][0].get_object().get('/FontDescriptor')
   embedded=[]
   if descriptor:
    d=descriptor.get_object()
    for key in ['/FontFile','/FontFile2','/FontFile3']:
     if key in d:
      data=d[key].get_object().get_data();embedded.append({'key':key,'bytes':len(data),'sha256':sha(data)})
   fonts.append({'base_font':str(f.get('/BaseFont')),'subtype':str(f.get('/Subtype')),'embedded':embedded})
  pages.append({'size':[float(page.mediabox.width),float(page.mediabox.height)],'text':page.extract_text(),'images':[{'size':[im.image.width,im.image.height],'sha256':sha(im.image.convert('RGBA').tobytes())} for im in page.images],'links':links,'widgets':widgets,'fonts':fonts})
 fields={n:{'type':str(f.get('/FT')),'value':str(f.get('/V'))} for n,f in (r.get_fields() or {}).items()}
 return {'path':str(p),'sha256':sha(p.read_bytes()),'bytes':p.stat().st_size,'page_count':len(pages),'pages':pages,'fields':fields,'outline_count':len(r.outline)}
def generate():
 if any((ROOT/f'{n}.original.pdf').exists() for n in TARGETS):raise RuntimeError('Original fixtures already exist; refusing overwrite')
 pdfmetrics.registerFont(TTFont('ControlledCJK',str(FONT)))
 Image.new('RGB',(80,40),'#24516c').save(ROOT/'fixture-image.png')
 manifest={}
 for name,(old,new) in TARGETS.items():
  p=ROOT/f'{name}.original.pdf';c=canvas.Canvas(str(p),pagesize=(612,792),invariant=1)
  font='Helvetica' if name=='simple' else 'ControlledCJK';c.setFont(font,14);c.drawString(50,720,old)
  c.setFont('Helvetica',12);c.drawString(50,670,'UNEDITED PAGE-1 PARAGRAPH')
  c.drawString(50,645,'FONT REUSE ALPHABET ABCDEFGHIJKLMNOPQRSTUVWXYZ')
  if name=='complex':c.setFont(font,12);c.drawString(50,610,'未改中文段落：风雨天地仍然保留。')
  c.drawImage(str(ROOT/'fixture-image.png'),50,500,width=80,height=40)
  c.linkURL('https://example.com/pdf-validation',(50,460,240,480),relative=0)
  c.acroForm.textfield(name='customer',x=50,y=390,width=200,height=24,value='Alice',fontName='Helvetica')
  c.acroForm.checkbox(name='approved',x=300,y=390,checked=False)
  c.bookmarkPage('page1');c.addOutlineEntry('Fixture page one','page1')
  c.showPage();c.setFont('Helvetica',12);c.drawString(50,720,'PAGE-2 UNEDITED CONTENT')
  if name=='complex':c.setFont(font,12);c.drawString(50,680,'第二页中文原文完整保留。')
  c.save();before=inspect(p)
  target={'pageIndex':0,'rect':[49,716,51+pdfmetrics.stringWidth(old,font,14),737],'oldText':old,'newText':new,'fontSize':14}
  if name=='complex':
   assert any(f['embedded'] and 'ArialUnicodeMS' in f['base_font'] for f in before['pages'][0]['fonts']), 'Expected actual embedded font subset'
  manifest[name]={'target':target,'source':before}
 raw=FONT.read_bytes();os2=None
 for i in range(struct.unpack_from('>H',raw,4)[0]):
  off=12+16*i
  if raw[off:off+4]==b'OS/2':
   pos=struct.unpack_from('>I',raw,off+8)[0];os2=struct.unpack_from('>H',raw,pos+8)[0]
 (ROOT/'font.lock.json').write_text(json.dumps({'source_path':str(FONT),'bytes':len(raw),'sha256':sha(raw),'family':'ArialUnicodeMS','OS2_fsType':os2,'embedding':'reportlab actual TrueType subset /FontFile2; no font bytes changed or restriction flags patched'},indent=2))
 (ROOT/'fixtures.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2));print(json.dumps({n:v['source']['sha256'] for n,v in manifest.items()}))
def compare(name,p):
 manifest=json.loads((ROOT/'fixtures.json').read_text())[name];before=inspect(manifest['source']['path']);after=inspect(p);target=manifest['target'];checks=[]
 def check(label,ok,expected=None,actual=None):checks.append({'assertion':label,'passed':bool(ok),'expected':expected,'actual':actual})
 check('page_count',before['page_count']==after['page_count'],before['page_count'],after['page_count'])
 check('fields_unchanged',before['fields']==after['fields'],before['fields'],after['fields'])
 check('outline_count_unchanged',before['outline_count']==after['outline_count'])
 old,new=norm(target['oldText']),norm(target['newText']);all_text=norm(''.join(p['text'] for p in after['pages']))
 check('old_target_full_text_absent',old not in all_text,False,old in all_text)
 check('new_target_full_text_present',new in norm(after['pages'][0]['text']),True,new in norm(after['pages'][0]['text']))
 for i,(a,b) in enumerate(zip(before['pages'],after['pages'])):
  for key in ['size','images','links','widgets']:check(f'page_{i}_{key}_unchanged',a[key]==b[key],a[key],b[key])
  ta,tb=norm(a['text']),norm(b['text'])
  if i==0:ta=ta.replace(old,'',1);tb=tb.replace(new,'',1)
  check(f'page_{i}_unedited_full_text_order',ta==tb,ta,tb)
  check(f'page_{i}_unedited_character_inventory',collections.Counter(ta)==collections.Counter(tb),ta,tb)
  if i==1:check('page_2_full_text_unchanged',ta==tb,ta,tb)
 return {'status':'passed' if all(c['passed'] for c in checks) else 'failed','source':before,'candidate':after,'checks':checks,'limitations':['Structure/text assertions do not prove rendering fidelity.','No application GUI/File CAS tested.']}
if __name__=='__main__':
 if sys.argv[1]=='generate':generate()
 elif sys.argv[1]=='compare':
  result=compare(sys.argv[2],sys.argv[3]);Path(sys.argv[4]).write_text(json.dumps(result,ensure_ascii=False,indent=2));print(json.dumps({'status':result['status'],'failures':[c['assertion'] for c in result['checks'] if not c['passed']]}))
 elif sys.argv[1]=='inspect':print(json.dumps(inspect(sys.argv[2]),ensure_ascii=False,indent=2))
