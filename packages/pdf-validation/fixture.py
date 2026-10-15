"""Create and independently verify controlled PDF forms; no GUI or Office process."""
import hashlib,io,json,sys
from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from PIL import Image
from pypdf import PdfReader
from pypdf.generic import ContentStream
ROOT=Path(__file__).resolve().parent
def sha(data):return hashlib.sha256(data).hexdigest()
def inspect(path):
    p=Path(path);reader=PdfReader(p)
    fields={name:{'type':str(f.get('/FT')),'value':str(f.get('/V'))} for name,f in (reader.get_fields() or {}).items()}
    pages=[]
    for page in reader.pages:
        annotations=[]
        for ref in page.get('/Annots',[]):
            a=ref.get_object()
            if a.get('/Subtype')!='/Widget':
                entry={'subtype':str(a.get('/Subtype')),'rect':[float(x) for x in a.get('/Rect',[])]}
                if a.get('/A'):entry['uri']=str(a['/A'].get('/URI'))
                if a.get('/Contents'):entry['contents']=str(a['/Contents'])
                annotations.append(entry)
        pages.append({'size':[float(page.mediabox.width),float(page.mediabox.height)],'text':page.extract_text(),'content_sha256':sha(page.get_contents().get_data()),'nonwidget_annotations':annotations,'images':[{'size':[image.image.width,image.image.height],'pixels_sha256':sha(image.image.convert('RGBA').tobytes())} for image in page.images]})
    widgets=[]
    for page in reader.pages:
        for ref in page.get('/Annots',[]):
            a=ref.get_object()
            if a.get('/Subtype')=='/Widget':
                normal=a.get('/AP',{}).get('/N');normal=normal.get_object() if normal else None
                texts=[]
                if normal is not None and hasattr(normal,'get_data'):
                    for operands,operator in ContentStream(normal,reader).operations:
                        if operator==b'Tj':
                            value=operands[0]
                            texts.append(value.decode('ascii') if isinstance(value,bytes) else str(value))
                widgets.append({'name':str(a.get('/T') or a.get('/Parent',{}).get_object().get('/T')),'appearance_present':bool(a.get('/AP')),'appearance_state':str(a.get('/AS')),'appearance_text':texts,'appearance_states':sorted(str(k) for k in normal) if normal is not None and not hasattr(normal,'get_data') else []})
    return {'path':str(p),'bytes':p.stat().st_size,'sha256':sha(p.read_bytes()),'pages':pages,'page_count':len(pages),'fields':fields,'widgets':widgets,'outline_count':len(reader.outline)}
def generate():
    if any((ROOT/(name+'.original.pdf')).exists() for name in ['simple','complex']):raise RuntimeError('Refusing to overwrite original fixtures')
    image=Image.new('RGB',(80,40),'#24516c');image.save(ROOT/'fixture-image.png')
    pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
    sources={}
    for name in ['simple','complex']:
        target=ROOT/(name+'.original.pdf');c=canvas.Canvas(str(target),pagesize=(612,792),invariant=1)
        c.setTitle('Controlled PDF form fixture');c.setFont('Helvetica',12)
        c.drawString(50,720,'ORIGINAL BODY MUST REMAIN')
        c.drawString(50,690,'Unedited paragraph and page sequence: PAGE-1')
        c.acroForm.textfield(name='customer',x=50,y=620,width=200,height=24,value='Alice',fontName='Helvetica')
        c.acroForm.checkbox(name='approved',x=300,y=620,checked=False)
        if name=='complex':
            c.setFont('STSong-Light',12);c.drawString(50,570,'未编辑中文段落：山川日月保持原样。')
            c.drawImage(str(ROOT/'fixture-image.png'),50,500,width=80,height=40)
            c.linkURL('https://example.com/pdf-validation',(50,460,240,480),relative=0)
            c.bookmarkPage('page1');c.addOutlineEntry('Fixture page one','page1')
        c.showPage();c.setFont('Helvetica',12);c.drawString(50,720,'PAGE-2 UNEDITED CONTENT')
        if name=='complex':c.setFont('STSong-Light',12);c.drawString(50,680,'第二页中文原文。')
        c.save();sources[name]=inspect(target)
    (ROOT/'fixtures.json').write_text(json.dumps(sources,ensure_ascii=False,indent=2))
    print(json.dumps({name:source['sha256'] for name,source in sources.items()}))
def compare(source,candidate):
    before=inspect(source);after=inspect(candidate)
    checks=[]
    for key in ['page_count','outline_count']:
        checks.append({'assertion':key,'passed':before[key]==after[key],'expected':before[key],'actual':after[key]})
    for key in ['size','text','content_sha256','nonwidget_annotations','images']:
        a=[p[key] for p in before['pages']];b=[p[key] for p in after['pages']]
        checks.append({'assertion':'unchanged_'+key,'passed':a==b,'expected':a,'actual':b})
    checks.append({'assertion':'customer_value','passed':after['fields'].get('customer',{}).get('value')=='Bob','expected':'Bob','actual':after['fields'].get('customer')})
    checks.append({'assertion':'approved_value','passed':after['fields'].get('approved',{}).get('value')=='/Yes','expected':'/Yes','actual':after['fields'].get('approved')})
    checks.append({'assertion':'widgets_have_appearances','passed':len(after['widgets'])==2 and all(w['appearance_present'] for w in after['widgets']),'actual':after['widgets']})
    customer=next((w for w in after['widgets'] if w['name']=='customer'),{})
    approved=next((w for w in after['widgets'] if w['name']=='approved'),{})
    checks.append({'assertion':'customer_appearance_contains_Bob','passed':'Bob' in customer.get('appearance_text',[]),'actual':customer.get('appearance_text')})
    checks.append({'assertion':'approved_appearance_selects_Yes','passed':approved.get('appearance_state')=='/Yes' and '/Yes' in approved.get('appearance_states',[]),'actual':approved})
    return {'status':'passed' if all(c['passed'] for c in checks) else 'failed','source':before,'candidate':after,'checks':checks,'not_verified':['GUI edit','visual field appearance/fonts','Tauri WebView','CAS/business save']}
if __name__=='__main__':
    if sys.argv[1]=='generate':generate()
    elif sys.argv[1]=='compare':
        result=compare(sys.argv[2],sys.argv[3]);Path(sys.argv[4]).write_text(json.dumps(result,ensure_ascii=False,indent=2));print(json.dumps({'status':result['status'],'failures':[c['assertion'] for c in result['checks'] if not c['passed']]}))
    elif sys.argv[1]=='inspect':print(json.dumps(inspect(sys.argv[2]),ensure_ascii=False,indent=2))
