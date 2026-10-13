from pathlib import Path
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE
from lxml import etree
from zipfile import ZipFile
from io import BytesIO
from openpyxl import load_workbook
import json, hashlib, posixpath, sys, time
ROOT=Path(__file__).resolve().parent
M=json.loads((ROOT/'manifest.json').read_text())
NS={'p':'http://schemas.openxmlformats.org/presentationml/2006/main','a':'http://schemas.openxmlformats.org/drawingml/2006/main','r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
REL='http://schemas.openxmlformats.org/package/2006/relationships'
def digest(b): return hashlib.sha256(b).hexdigest()
def refs(z,part):
    relpath=posixpath.join(posixpath.dirname(part),'_rels',posixpath.basename(part)+'.rels')
    if relpath not in z.namelist(): return []
    root=etree.fromstring(z.read(relpath))
    return [{'type':x.get('Type').split('/')[-1],'target':posixpath.normpath(posixpath.join(posixpath.dirname(part),x.get('Target'))),'external':x.get('TargetMode')=='External'} for x in root]
def inspect(path):
    prs=Presentation(path)
    out={'sha256':digest(path.read_bytes()),'bytes':path.stat().st_size,'size':[prs.slide_width,prs.slide_height],'slides':[],'zip':{}}
    for s in prs.slides:
        data={'texts':[],'pictures':[],'tables':[],'charts':[],'notes':None,'layout_name':s.slide_layout.name,'layout_xml_sha256':digest(etree.tostring(s.slide_layout._element,method='c14n')),'master_xml_sha256':digest(etree.tostring(s.slide_layout.slide_master._element,method='c14n'))}
        for shape in s.shapes:
            if shape.has_text_frame and shape.text: data['texts'].append(shape.text)
            if shape.shape_type==MSO_SHAPE_TYPE.PICTURE:
                data['pictures'].append({'sha256':digest(shape.image.blob),'left':shape.left,'top':shape.top,'width':shape.width,'height':shape.height,'crop':[shape.crop_left,shape.crop_right,shape.crop_top,shape.crop_bottom]})
            if shape.has_table: data['tables'].append([[c.text for c in row.cells] for row in shape.table.rows])
            if shape.has_chart:
                chart=shape.chart
                try: chart_type=str(chart.chart_type); chart_error=None
                except Exception as e: chart_type=None; chart_error=f'{type(e).__name__}: {e}'
                xml=etree.fromstring(etree.tostring(chart._chartSpace))
                cns={'c':'http://schemas.openxmlformats.org/drawingml/2006/chart'}
                data['charts'].append({'type':chart_type,'python_chart_type_error':chart_error,'xml_plot_types':[etree.QName(x).localname for x in xml.xpath('//c:plotArea/*',namespaces=cns) if etree.QName(x).localname.endswith('Chart')],'grouping':xml.xpath('//c:grouping/@val',namespaces=cns),'bar_direction':xml.xpath('//c:barDir/@val',namespaces=cns),'series':[{'name':se.name,'values':list(se.values)} for se in chart.series],'category_cache':xml.xpath('//c:ser/c:cat//c:pt/c:v/text()',namespaces=cns),'formula_refs':xml.xpath('//c:ser//c:f/text()',namespaces=cns)})
        if s.has_notes_slide: data['notes']=s.notes_slide.notes_text_frame.text
        out['slides'].append(data)
    with ZipFile(path) as z:
        if z.testzip() is not None: raise AssertionError('ZIP CRC failure')
        names=z.namelist()
        for feature,prefix in [('notes','ppt/notesSlides/notesSlide'),('masters','ppt/slideMasters/slideMaster'),('layouts','ppt/slideLayouts/slideLayout'),('charts','ppt/charts/chart'),('embeddings','ppt/embeddings/'),('notes_masters','ppt/notesMasters/notesMaster')]:
            parts=[n for n in names if n.startswith(prefix) and (n.endswith('.xml') if feature!='embeddings' else True) and '/_rels/' not in n]
            out['zip'][feature]={n:digest(z.read(n)) for n in parts}
        pres=etree.fromstring(z.read('ppt/presentation.xml'))
        out['zip']['slide_order_ids']=pres.xpath('//p:sldId/@id',namespaces=NS)
        slide_parts=[n for n in names if n.startswith('ppt/slides/slide') and n.endswith('.xml') and '/_rels/' not in n]
        out['zip']['slide_relationships']={n:refs(z,n) for n in slide_parts}
        out['zip']['layout_relationships']={n:refs(z,n) for n in out['zip']['layouts']}
        out['zip']['embedded_workbooks']={}
        for n in out['zip']['embeddings']:
            if n.endswith('.xlsx'):
                wb=load_workbook(BytesIO(z.read(n)),data_only=False)
                out['zip']['embedded_workbooks'][n]={s.title:[list(row) for row in s.iter_rows(values_only=True)] for s in wb.worksheets}
        out['zip']['dangling_relationships']=[]
        for n in names:
            if n.endswith('.rels'):
                r=etree.fromstring(z.read(n)); base=posixpath.dirname(posixpath.dirname(n))
                for x in r:
                    target=x.get('Target')
                    if x.get('TargetMode')=='External': continue
                    resolved=target.lstrip('/') if target.startswith('/') else posixpath.normpath(posixpath.join(base,target))
                    if resolved not in names: out['zip']['dangling_relationships'].append({'part':n,'target':resolved})
    return out

def verify(kind,candidate,mode='edited'):
    start=time.perf_counter(); original=ROOT/Path(M['samples'][kind]['path']); a=inspect(original); b=inspect(candidate)
    checks=[]
    def check(name,expected,actual): checks.append({'name':name,'passed':expected==actual,'expected':expected,'actual':actual})
    check('original_checksum_unchanged',M['samples'][kind]['sha256'],a['sha256'])
    check('slide_count',3,len(b['slides'])); check('slide_dimensions',a['size'],b['size'])
    check('relationship_integrity',[],b['zip']['dangling_relationships'])
    for i in range(3):
        x=a['slides'][i]; y=b['slides'][i] if i<len(b['slides']) else {}
        texts=[t.replace(M['old_text'],M['new_text']) if i==0 and mode=='edited' else t for t in x['texts']]
        check(f'slide_{i+1}_texts_and_order',texts,y.get('texts'))
        check(f'slide_{i+1}_tables',x['tables'],y.get('tables'))
        check(f'slide_{i+1}_charts',x['charts'],y.get('charts'))
        check(f'slide_{i+1}_notes',x['notes'],y.get('notes'))
        pics=[dict(p) for p in x['pictures']]
        if i==0 and mode=='edited':
            for p in pics: p['left']+=M['picture_delta_emu']
        check(f'slide_{i+1}_images_bytes_and_position',pics,y.get('pictures'))
        check(f'slide_{i+1}_layout_name',x['layout_name'],y.get('layout_name'))
        check(f'slide_{i+1}_layout_xml',x['layout_xml_sha256'],y.get('layout_xml_sha256'))
        check(f'slide_{i+1}_master_xml',x['master_xml_sha256'],y.get('master_xml_sha256'))
        rels=list(a['zip']['slide_relationships'].values())[i]
        brels=list(b['zip']['slide_relationships'].values())[i] if i<len(b['zip']['slide_relationships']) else []
        check(f'slide_{i+1}_relationship_types',sorted(r['type'] for r in rels),sorted(r['type'] for r in brels))
        check(f'slide_{i+1}_layout_relationship_target',[r['target'] for r in rels if r['type']=='slideLayout'],[r['target'] for r in brels if r['type']=='slideLayout'])
    for feat in ['notes','masters','layouts','charts','embeddings','notes_masters']:
        check(f'zip_{feat}_part_count',len(a['zip'][feat]),len(b['zip'][feat]))
    check('layout_master_relationships',a['zip']['layout_relationships'],b['zip']['layout_relationships'])
    check('embedded_chart_workbook_content',list(a['zip']['embedded_workbooks'].values()),list(b['zip']['embedded_workbooks'].values()))
    result={'kind':kind,'mode':mode,'original':original.name,'candidate':candidate.name,'status':'passed' if all(c['passed'] for c in checks) else 'failed','elapsed_ms':round((time.perf_counter()-start)*1000,2),'checks':checks,'original_inventory':a,'candidate_inventory':b}
    return result

if __name__=='__main__':
    if len(sys.argv)==1:
        inventories={k:inspect(ROOT/Path(v['path'])) for k,v in M['samples'].items()}
        (ROOT/'original-inventory.json').write_text(json.dumps(inventories,ensure_ascii=False,indent=2))
        print(json.dumps({k:{'slides':len(v['slides']),'features':{f:len(parts) for f,parts in v['zip'].items() if isinstance(parts,dict)}} for k,v in inventories.items()},ensure_ascii=False))
    else:
        kind=sys.argv[1]; path=Path(sys.argv[2]); mode=sys.argv[3] if len(sys.argv)>3 else 'edited'
        try: result=verify(kind,path,mode)
        except Exception as e: result={'kind':kind,'candidate':str(path),'mode':mode,'status':'failed','error':str(e)}
        dest=ROOT/f'{kind}.{mode}.verification.json'; dest.write_text(json.dumps(result,ensure_ascii=False,indent=2))
        print(json.dumps({'status':result['status'],'failed_checks':[c['name'] for c in result.get('checks',[]) if not c['passed']],'result':str(dest),'error':result.get('error')},ensure_ascii=False))
        sys.exit(0 if result['status']=='passed' else 1)
