"""Independent python-docx + ZIP/XML semantic and strictchange validation; no GUI/LO."""
import json, sys, hashlib, zipfile, copy
from pathlib import Path
from lxml import etree as E
from docx import Document
sys.path.insert(0,str(Path(__file__).resolve().parent/'fixtures'))
from fixture import inspect, NS, OLD, NEW, CELL_NEW
ROOT=Path(__file__).resolve().parent
SHA=lambda b:hashlib.sha256(b).hexdigest()
PROTOCOL='genoffice-docx-controlled-roundtrip-v1'
def package(p):
 with zipfile.ZipFile(p) as z:return {n:z.read(n) for n in z.namelist() if not n.endswith('/')}
def directory_names(p):
 with zipfile.ZipFile(p) as z:return {n for n in z.namelist() if n.endswith('/')}
def canonical(b):return E.tostring(E.fromstring(b),method='c14n')
def xml_semantics(node,edited=False):
 attrs=dict(node.attrib)
 if node.tag=='{'+NS['w']+'}t' and (node.text or '')==(node.text or '').strip():attrs.pop('{http://www.w3.org/XML/1998/namespace}space',None)
 text=node.text or ''
 if edited and node.tag=='{'+NS['w']+'}t':text=text.replace(OLD,NEW).replace('待改单元',CELL_NEW)
 if node.tag!='{'+NS['w']+'}t' and not text.strip():text=''
 return [node.tag,sorted(attrs.items()),text,[xml_semantics(c,edited) for c in node]]

def extended(p):
 d=inspect(p); z=package(p); doc=Document(p)
 d['core_metadata']={k:getattr(doc.core_properties,k) for k in ['author','category','comments','content_status','identifier','keywords','language','last_modified_by','subject','title','version']}
 d['core_volatile']={k:str(getattr(doc.core_properties,k)) for k in ['created','modified','revision']}
 d['application_metadata']={E.QName(x).localname:x.text or '' for x in E.fromstring(z['docProps/app.xml'])}
 xml=E.fromstring(z['word/document.xml']); body=xml.find('w:body',NS)
 placements=[]
 for i,b in enumerate(body):
  for drawing in b.xpath('.//w:drawing',namespaces=NS):
   placements.append({'body_index':i,'paragraph_text':''.join(b.xpath('.//w:t/text()',namespaces=NS)),
    'geometry_xml':E.tostring(drawing,method='c14n').decode()})
 d['image_placements']=placements
 d['hyperlink_text_targets']=[]
 rels=E.fromstring(z['word/_rels/document.xml.rels']); rm={r.get('Id'):r.get('Target') for r in rels}
 for h in xml.xpath('.//w:hyperlink',namespaces=NS):d['hyperlink_text_targets'].append({'text':''.join(h.xpath('.//w:t/text()',namespaces=NS)),'target':rm[h.get('{'+NS['r']+'}id')]})
 return d

def verify(name,mode,model_path,candidate):
 source=ROOT/'fixtures'/f'{name}.original.docx'; a,b=extended(source),extended(candidate); expected=copy.deepcopy(a)
 if mode=='edited':
  expected['paragraphs']=[x.replace(OLD,NEW) for x in a['paragraphs']]
  expected['tables'][0][1][1]=CELL_NEW
 checks=[]
 for k in ['paragraphs','tables','headings','image_extents','image_placements','sections','headers_footers','headers_footers_reference_counts','headers_footers_per_section','explicit_bold_text','page_break_count','hyperlinks','hyperlink_text_targets','core_metadata','application_metadata']:
  checks.append({'name':k,'passed':expected[k]==b[k],'expected':expected[k],'actual':b[k]})
 for k in ['bytes_sha256','pixels_sha256','size']:
  left=[x[k] for x in expected['media']];right=[x[k] for x in b['media']]
  checks.append({'name':'media_'+k,'passed':left==right,'expected':left,'actual':right})
 za,zb=package(source),package(candidate)
 strict=[]
 for n in sorted(za.keys()|zb.keys()):
  if za.get(n)!=zb.get(n):
   strict.append({'part':n,'change':'added' if n not in za else 'removed' if n not in zb else 'modified',
    'before_sha256':SHA(za[n]) if n in za else None,'after_sha256':SHA(zb[n]) if n in zb else None,
    'xml_semantically_equal':canonical(za[n])==canonical(zb[n]) if n.endswith(('.xml','.rels')) and n in za and n in zb else None})
 doc_left=xml_semantics(E.fromstring(za['word/document.xml']),mode=='edited');doc_right=xml_semantics(E.fromstring(zb['word/document.xml']))
 checks.append({'name':'full_document_xml_semantics_with_only_controlled_text_replacements','passed':doc_left==doc_right,'expected':'identical elements, attributes, order and text except the two targets; non-whitespace text ignores redundant xml:space=preserve','actual':'matched' if doc_left==doc_right else 'mismatch'})
 allowed={'word/document.xml','docProps/core.xml'} if mode=='edited' else set()
 checks.append({'name':'only_expected_package_parts_changed','passed':all(x['part'] in allowed for x in strict),'expected':sorted(allowed),'actual':[x['part'] for x in strict]})
 # Keep raw changes visible; timestamps/revision are recorded, never confused with author/Company.
 result={'protocol_id':PROTOCOL,'model_path':model_path,'baseline_hash':a['sha256'],'fixture_manifest_sha256':SHA((ROOT/'fixtures/fixtures.json').read_bytes()),'case':name,'mode':mode,
  'status':'passed' if all(x['passed'] for x in checks) else 'failed','checks':checks,'strictchanges':strict,
  'zip_directory_changes':{'added':sorted(directory_names(candidate)-directory_names(source)),'removed':sorted(directory_names(source)-directory_names(candidate))},
  'core_volatile':{'before':a['core_volatile'],'after':b['core_volatile']},'output_sha256':b['sha256'],'source':a,'candidate':b}
 return result
if __name__=='__main__':
 rows=[]
 for r in json.loads((ROOT/'engine-results.json').read_text())['runs']:
  if r['status']=='completed':
   out=verify(r['case'],r['mode'],r['model_path'],ROOT/r['output']);(ROOT/(r['output']+'.verification.json')).write_text(json.dumps(out,ensure_ascii=False,indent=2));rows.append(out)
  else:rows.append(r)
 summary={'protocol_id':PROTOCOL,'results':rows,'not_verified':['browser rendering and Tiptap interactions','LibreOffice/Word external reopen','fixtures beyond simple/complex','business CAS and persistence integration']}
 (ROOT/'results.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2))
 print(json.dumps([{'case':r['case'],'mode':r['mode'],'model_path':r['model_path'],'status':r['status'],'failures':[c['name'] for c in r.get('checks',[]) if not c['passed']]} for r in rows],ensure_ascii=False,indent=2))

 if any(r['status']!='passed' for r in rows):sys.exit(1)
