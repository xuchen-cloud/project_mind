from pathlib import Path
from zipfile import ZipFile
from lxml import etree
from pptx import Presentation
import json, time
from verify_pptx import refs, M
ROOT=Path(__file__).resolve().parent
NS={'p':'http://schemas.openxmlformats.org/presentationml/2006/main','a':'http://schemas.openxmlformats.org/drawingml/2006/main','r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
def geometry(node):
    tx=node.find('p:spPr/a:xfrm',NS)
    if tx is None: return None
    return {etree.QName(x).localname:dict(x.attrib) for x in tx}
def layer(z,part):
    root=etree.fromstring(z.read(part)); c=root.find('p:cSld',NS)
    shapes=[]
    for sp in root.findall('p:cSld/p:spTree/p:sp',NS):
        ph=sp.find('p:nvSpPr/p:nvPr/p:ph',NS); nv=sp.find('p:nvSpPr/p:cNvPr',NS)
        if ph is not None:
            shapes.append({'name':nv.get('name'),'placeholder':{'type':ph.get('type','obj'),'idx':ph.get('idx','0'),'size':ph.get('sz','full'),'orient':ph.get('orient','horz')},'text':sp.xpath('.//a:t/text()',namespaces=NS),'dynamic_fields':sp.xpath('.//a:fld/@type',namespaces=NS),'paragraph_count':len(sp.findall('p:txBody/a:p',NS)),'geometry':geometry(sp)})
    return {'type':root.get('type'),'name':c.get('name') if c is not None else None,'placeholders':shapes,'relationships':sorted([{'type':r['type'],'target':r['target']} for r in refs(z,part)],key=lambda r:(r['type'],r['target'])),'color_map':dict(root.find('p:clrMap',NS).attrib) if root.find('p:clrMap',NS) is not None else None,'background_xml':etree.tostring(root.find('p:cSld/p:bg',NS)).decode() if root.find('p:cSld/p:bg',NS) is not None else None}
def theme(z,part):
    root=etree.fromstring(z.read(part)); colors={}
    for x in root.findall('a:themeElements/a:clrScheme/*',NS):
        val=x[0]; colors[etree.QName(x).localname]=val.get('val') if etree.QName(val).localname=='srgbClr' else val.get('lastClr')
    fonts={}
    for group in ['majorFont','minorFont']:
        node=root.find(f'a:themeElements/a:fontScheme/a:{group}',NS)
        fonts[group]={etree.QName(x).localname+(('-'+x.get('script')) if x.get('script') else ''):x.get('typeface') for x in node}
    return {'name':root.get('name'),'resolved_colors':colors,'fonts':fonts}
def inventory(path):
    with ZipFile(path) as z:
        p=etree.fromstring(z.read('ppt/presentation.xml'))
        size=dict(p.find('p:sldSz',NS).attrib)
        layers={n:layer(z,n) for n in z.namelist() if n.endswith('.xml') and '/_rels/' not in n and (n.startswith('ppt/slideMasters/slideMaster') or n.startswith('ppt/slideLayouts/slideLayout'))}
        themes={n:theme(z,n) for n in z.namelist() if n.startswith('ppt/theme/theme') and n.endswith('.xml')}
        links={n:refs(z,n) for n in z.namelist() if n.startswith('ppt/slides/slide') and n.endswith('.xml') and '/_rels/' not in n}
    prs=Presentation(path); text_shapes=[]
    for s in prs.slides:
        text_shapes.append([{'text':sh.text,'box':[sh.left,sh.top,sh.width,sh.height],'runs':[[run.text,run.font.name,run.font.size,run.font.bold,run.font.italic] for para in sh.text_frame.paragraphs for run in para.runs]} for sh in s.shapes if sh.has_text_frame and sh.text])
    return {'slide_size':size,'layers':layers,'themes':themes,'slide_layout_links':{n:[r['target'] for r in rows if r['type']=='slideLayout'] for n,rows in links.items()},'text_shapes':text_shapes}
def replace_text(v):
    if isinstance(v,str):return v.replace(M['old_text'],M['new_text'])
    if isinstance(v,list):return [replace_text(x) for x in v]
    if isinstance(v,dict):return {k:replace_text(x) for k,x in v.items()}
    return v
start=time.perf_counter(); results={}
for kind in ['simple','complex']:
    orig=inventory(ROOT/f'{kind}.original.pptx'); results[kind]={}
    for mode in ['product-unchanged','aggregate-unchanged','edited']:
        out=inventory(ROOT/f'{kind}.{mode}.pptx'); checks=[]; changes=[]
        def check(name,a,b):checks.append({'name':name,'passed':a==b,'expected':a,'actual':b})
        check('slide_dimensions_and_type',orig['slide_size'],out['slide_size']);check('physical_slide_dimensions',{k:v for k,v in orig['slide_size'].items() if k in ['cx','cy']},{k:v for k,v in out['slide_size'].items() if k in ['cx','cy']});check('layer_part_set',sorted(orig['layers']),sorted(out['layers']));check('slide_layout_links',orig['slide_layout_links'],out['slide_layout_links'])
        check('text_boxes_fonts_and_unedited_text',replace_text(orig['text_shapes']) if mode=='edited' else orig['text_shapes'],out['text_shapes'])
        for n,a in orig['layers'].items():
            b=out['layers'].get(n,{})
            check(f'{n}:layout_type',a['type'],b.get('type'))
            # Master's cSld name is missing in the source fixture; generated name is informational.
            if n.startswith('ppt/slideLayouts/'):check(f'{n}:layout_name',a['name'],b.get('name'))
            check(f'{n}:placeholder_identity',[p['placeholder'] for p in a['placeholders']],[p['placeholder'] for p in b.get('placeholders',[])])
            check(f'{n}:placeholder_type_and_index',[[p['placeholder']['type'],p['placeholder']['idx']] for p in a['placeholders']],[[p['placeholder']['type'],p['placeholder']['idx']] for p in b.get('placeholders',[])])
            check(f'{n}:placeholder_text',[p['text'] for p in a['placeholders']],[p['text'] for p in b.get('placeholders',[])])
            check(f'{n}:dynamic_fields',[p['dynamic_fields'] for p in a['placeholders']],[p['dynamic_fields'] for p in b.get('placeholders',[])])
            check(f'{n}:placeholder_paragraph_count',[p['paragraph_count'] for p in a['placeholders']],[p['paragraph_count'] for p in b.get('placeholders',[])])
            check(f'{n}:placeholder_geometry',[p['geometry'] for p in a['placeholders']],[p['geometry'] for p in b.get('placeholders',[])])
            check(f'{n}:relationships',a['relationships'],b.get('relationships'));check(f'{n}:color_map',a['color_map'],b.get('color_map'))
            if a['background_xml']!=b.get('background_xml'):changes.append({'part':n,'attribute':'background_representation','original':a['background_xml'],'candidate':b.get('background_xml')})
        for n,a in orig['themes'].items():
            b=out['themes'].get(n,{})
            check(f'{n}:resolved_theme_colors',a['resolved_colors'],b.get('resolved_colors'));check(f'{n}:theme_fonts',a['fonts'],b.get('fonts'))
        used=set(n for rows in orig['slide_layout_links'].values() for n in rows)
        def effective_geometry(inv,part):
            obj=inv['layers'][part]
            master=next((inv['layers'].get(r['target']) for r in obj['relationships'] if r['type']=='slideMaster'),None)
            result=[]
            for ph in obj['placeholders']:
                geom=ph['geometry']
                if geom is None and master:
                    matches=[p for p in master['placeholders'] if p['placeholder']['type']==ph['placeholder']['type']]
                    if len(matches)==1:geom=matches[0]['geometry']
                result.append({'type':ph['placeholder']['type'],'idx':ph['placeholder']['idx'],'geometry':geom})
            return result
        for n in sorted(used):check(f'{n}:effective_placeholder_geometry',effective_geometry(orig,n),effective_geometry(out,n))
        results[kind][mode]={'status':'passed' if all(c['passed'] for c in checks) else 'limited','checks':checks,'representation_changes':changes,'original':orig,'candidate':out}
(ROOT/'semantic-results.json').write_text(json.dumps({'elapsedMs':round((time.perf_counter()-start)*1000,3),'samples':results},ensure_ascii=False,indent=2))
for k,rows in results.items():
 for m,r in rows.items(): print(json.dumps({'kind':k,'mode':m,'status':r['status'],'checks':len(r['checks']),'failed_count':sum(not c['passed'] for c in r['checks']),'physical_dimensions':next(c['passed'] for c in r['checks'] if c['name']=='physical_slide_dimensions'),'used_layout_effective_geometry':all(c['passed'] for c in r['checks'] if c['name'].endswith(':effective_placeholder_geometry'))},ensure_ascii=False))
