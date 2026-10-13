from pathlib import Path
from zipfile import ZipFile
from lxml import etree
import posixpath
import json, copy, hashlib

root=Path(__file__).resolve().parent
def read(name): return json.loads((root/name).read_text())
sdk=read('sdk-results.json'); semantics=read('semantic-results.json')
rows=[]
for record in sdk['results']:
    k,m=record['kind'],record['mode']
    data=read(f'{k}.{m}.sdk.json'); a=copy.deepcopy(data['expected']);b=copy.deepcopy(data['after'])
    id_changes=[]
    for si,(sa,sb) in enumerate(zip(a['slides'],b['slides'])):
        for ei,(ea,eb) in enumerate(zip(sa['elements'],sb['elements'])):
            x,y=ea.pop('id'),eb.pop('id')
            if x!=y:id_changes.append({'slideIndex':si,'elementIndex':ei,'before':x,'after':y})
    raw=read(f'{k}.{m}.verification.json')
    with ZipFile(root/f'{k}.original.pptx') as za,ZipFile(root/f'{k}.{m}.pptx') as zb:
        an={n for n in za.namelist() if not n.endswith('/')};bn={n for n in zb.namelist() if not n.endswith('/')}
        changed=[n for n in sorted(an&bn) if za.read(n)!=zb.read(n)]
        dirs=sorted(set(zb.namelist())-set(za.namelist())-bn)
        features={prefix:all(za.read(n)==zb.read(n) for n in an if n.startswith(prefix)) for prefix in ['ppt/notesSlides/','ppt/notesMasters/','ppt/charts/','ppt/embeddings/','ppt/slideMasters/','ppt/slideLayouts/','ppt/theme/']}
        part_hashes={n:{'original':hashlib.sha256(za.read(n)).hexdigest(),'candidate':hashlib.sha256(zb.read(n)).hexdigest(),'preserved':za.read(n)==zb.read(n)} for n in sorted(an) if any(n.startswith(p) for p in features)}
        embedding_entries=[]
        for n in zb.namelist():
            if not n.startswith('ppt/embeddings/'):continue
            referenced_by=[]
            for rel in bn:
                if not rel.endswith('.rels'):continue
                base=posixpath.dirname(posixpath.dirname(rel))
                for item in etree.fromstring(zb.read(rel)):
                    if item.get('TargetMode')=='External':continue
                    target=item.get('Target'); resolved=target.lstrip('/') if target.startswith('/') else posixpath.normpath(posixpath.join(base,target))
                    if resolved==n:referenced_by.append({'relationshipPart':rel,'id':item.get('Id'),'type':item.get('Type')})
            embedding_entries.append({'part':n,'isDirectory':n.endswith('/'),'uncompressedBytes':zb.getinfo(n).file_size,'compressedBytes':zb.getinfo(n).compress_size,'wasInOriginal':n in za.namelist(),'referencedBy':referenced_by,'classification':'zip_directory_only' if n.endswith('/') else 'used_embedding' if referenced_by else 'unused_embedding'})
    failed=[c['name'] for c in raw['checks'] if not c['passed']]
    meaningful=[c for c in failed if c!='zip_embeddings_part_count']
    ok=a==b and an==bn and changed==([] if m=='noop' else ['ppt/slides/slide1.xml']) and all(features.values()) and not meaningful and semantics['samples'][k][m]['status']=='passed'
    original_bytes=(root/f'{k}.original.pptx').stat().st_size;candidate_bytes=(root/f'{k}.{m}.pptx').stat().st_size
    rows.append({'kind':k,'mode':m,'status':('limited' if failed else 'passed') if ok else 'failed','contentStatus':'passed' if ok else 'failed','containerClassification':'limited_size_inflation','originalBytes':original_bytes,'candidateBytes':candidate_bytes,'sizeGrowthPercent':round((candidate_bytes/original_bytes-1)*100,2),'rawSdkSemanticMatch':record['sdkSemanticMatch'],'sdkContentMatchExcludingProcessLocalElementId':a==b,'idChanges':id_changes,'rawIndependentStatus':raw['status'],'rawFailedChecks':failed,'semanticChecks':len(semantics['samples'][k][m]['checks']),'filePartsIdenticalSet':an==bn,'changedFileParts':changed,'featurePartBytesPreserved':features,'originalPartSha256':part_hashes,'embeddingEntriesAndRelationships':embedding_entries,'addedDirectories':dirs,'embeddingCountDiagnostic':'JSZip adds directory ppt/embeddings/; reused verifier counts it as an embedding. No added/removed/modified embedding files.' if failed==['zip_embeddings_part_count'] else None})
browser={name:{'status':r['status'],'sha256':r['candidate_inventory']['sha256'],'checks':len(r['checks']),'candidate':r['candidate']} for name in ['webkit','chromium'] for r in [read(f'browser/output/{name}/independent-verification.json')]}
metafile=read('build/backend-metafile.json')
inputs=list(metafile['inputs'])
output={'scope':'GenOffice Apache core + thin SVG adapter for simple fixture; not full upstream application or complex chart editing UI','upstreamSha':sdk['upstreamSha'],'originalsUnchanged':sdk['originalsUnchanged'],'engineCandidates':rows,'browserCandidates':browser,'noWatermark':{'status':'confirmed_for_tested_core_and_thin_adapter','runtimeNoLicenseKey':True,'sourceLicenseChecksModified':False,'eeInputs':[p for p in inputs if p.startswith('ee/') or '/ee/' in p],'visualEvidence':'Main task reports WebKit and Chromium actual preview/editor showing Chinese text and PNG with no watermark; form edit/save succeeded. This agent did not open GUI.'},'decision':'eligible_simple_pptx_backup' if all(r['contentStatus']=='passed' for r in rows) and all(r['status']=='passed' for r in browser.values()) else 'blocked','limitations':['SVG adapter implements simple text/picture/rect only; complex chart UI editing is untested.','Core package/RenderTree is not the full upstream React/Konva editor.','One-paragraph text endpoint only; starts from original each time, not a persistent edit session.','Exact fonts/embedded font subset behavior, EMF/WMF, real complex corpus, IME and product File/CAS integration remain untested.','LO external validation belongs to packages/office-validation/evidence/genoffice-external.']}
(root/'findings.json').write_text(json.dumps(output,ensure_ascii=False,indent=2))
print(json.dumps({'decision':output['decision'],'engineCandidates':[{'kind':r['kind'],'mode':r['mode'],'status':r['status']} for r in rows],'browserCandidates':browser},ensure_ascii=False))
